-- =====================================================================
-- Label Mod Core — مهاجرت ۰۰۲: عملیات مالی و انبار
-- =====================================================================
-- تمام تغییر موجودی و تمام ثبت سند فقط از این توابع عبور می‌کند.
-- هیچ لایه‌ای — حتی اپلیکیشن — مجاز به INSERT مستقیم در stock_movement
-- یا journal_line نیست.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. دروازه واحد تغییر موجودی + میانگین موزون متحرک
-- ---------------------------------------------------------------------
-- روش: به‌جای نگهداری avg_cost، مقدار total_value نگه داشته می‌شود.
-- این کار رانش گرد کردن را حذف می‌کند: میانگین همیشه از تقسیم لحظه‌ای
-- به دست می‌آید و باقی‌مانده هنگام صفر شدن موجودی صریحاً برگردانده
-- می‌شود تا به حساب «تعدیل بهای تمام‌شده» برود، نه اینکه گم شود.

CREATE TYPE inventory.movement_result AS (
  movement_id uuid,
  unit_cost   platform.money,
  value_delta platform.money,
  residual    platform.money   -- باقی‌مانده ارزش هنگام صفر شدن موجودی
);

CREATE OR REPLACE FUNCTION inventory.apply_movement(
  p_variation      uuid,
  p_warehouse      uuid,
  p_qty            platform.qty,
  p_kind           text,
  p_ref_type       text     DEFAULT NULL,
  p_ref_id         uuid     DEFAULT NULL,
  p_user           uuid     DEFAULT NULL,
  p_unit_cost      platform.money DEFAULT NULL,   -- اجباری برای ورود، Snapshot برای مرجوعی
  p_allow_negative boolean  DEFAULT false,
  p_occurred_at    timestamptz DEFAULT NULL,
  p_note           text     DEFAULT NULL,
  p_value_delta    platform.money DEFAULT NULL    -- اثر ارزشی دقیق، برای مرجوعی نسبتی
) RETURNS inventory.movement_result
LANGUAGE plpgsql AS $$
DECLARE
  v_on_hand  platform.qty;
  v_value    platform.money;
  v_cost     platform.money;
  v_delta    platform.money;
  v_residual platform.money := 0;
  v_new_qty  platform.qty;
  v_id       uuid;
BEGIN
  IF p_qty = 0 THEN
    RAISE EXCEPTION 'حرکت با تعداد صفر مجاز نیست';
  END IF;

  -- قفل بدبینانه روی همان تنوع/انبار. محدوده کوچک و کوتاه.
  INSERT INTO inventory.stock_balance (variation_id, warehouse_id)
  VALUES (p_variation, p_warehouse)
  ON CONFLICT (variation_id, warehouse_id) DO NOTHING;

  SELECT on_hand, total_value INTO v_on_hand, v_value
    FROM inventory.stock_balance
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse
     FOR UPDATE;

  v_new_qty := v_on_hand + p_qty;

  IF p_qty > 0 THEN
    ------------------------------------------------------------------
    -- ورود کالا
    ------------------------------------------------------------------
    IF p_unit_cost IS NULL THEN
      RAISE EXCEPTION 'بهای واحد برای ورود کالا اجباری است (تنوع %)', p_variation;
    END IF;
    v_cost  := p_unit_cost;
    v_delta := coalesce(p_value_delta, p_qty * v_cost);

  ELSE
    ------------------------------------------------------------------
    -- خروج کالا
    ------------------------------------------------------------------
    IF NOT p_allow_negative AND v_new_qty < 0 THEN
      RAISE EXCEPTION
        'موجودی کافی نیست: تنوع %، انبار %، موجود %، درخواست %',
        p_variation, p_warehouse, v_on_hand, abs(p_qty);
    END IF;

    IF p_unit_cost IS NOT NULL THEN
      -- مسیر Snapshot: مرجوعی با بهای همان سطر فروش برمی‌گردد
      v_cost := p_unit_cost;
    ELSIF v_on_hand > 0 THEN
      v_cost := round(v_value / v_on_hand);
    ELSE
      v_cost := 0;
    END IF;

    v_delta := coalesce(p_value_delta, p_qty * v_cost);   -- منفی

    -- آخرین واحدها باقی‌مانده ارزش را کامل جذب می‌کنند تا ارزش موجودی
    -- دقیقاً صفر شود. اختلاف با unit_cost×qty به‌عنوان residual گزارش
    -- می‌شود، ولی مبلغ سند همیشه value_delta واقعی است — پس دفتر و
    -- انبار هیچ‌وقت از هم جدا نمی‌افتند.
    IF v_new_qty = 0 AND p_value_delta IS NULL THEN
      v_residual := (-v_value) - v_delta;
      v_delta    := -v_value;
    END IF;
  END IF;

  UPDATE inventory.stock_balance
     SET on_hand     = v_new_qty,
         total_value = v_value + v_delta,
         row_version = row_version + 1,
         updated_at  = now()
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse;

  INSERT INTO inventory.stock_movement
    (variation_id, warehouse_id, qty, unit_cost, value_delta,
     kind, ref_type, ref_id, user_id, occurred_at, note)
  VALUES
    (p_variation, p_warehouse, p_qty, v_cost, v_delta,
     p_kind, p_ref_type, p_ref_id, p_user, coalesce(p_occurred_at, now()), p_note)
  RETURNING id INTO v_id;

  RETURN (v_id, v_cost, v_delta, v_residual)::inventory.movement_result;
END $$;

-- ---------------------------------------------------------------------
-- ۲. موتور ثبت سند — قواعد از جدول خوانده می‌شوند، نه از کد
-- ---------------------------------------------------------------------
-- p_legs نمونه:
--   [{"leg":"net_sales","amount":9000000},
--    {"leg":"cash","amount":4000000},
--    {"leg":"receivable","amount":500000,"party_type":"customer","party_id":"…"}]

CREATE OR REPLACE FUNCTION ledger.post_entry(
  p_event_type  text,
  p_branch      uuid,
  p_entry_date  date,
  p_description text,
  p_legs        jsonb,
  p_ref_type    text DEFAULT NULL,
  p_ref_id      uuid DEFAULT NULL,
  p_user        uuid DEFAULT NULL,
  p_status      text DEFAULT 'confirmed'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_entry   uuid;
  v_fy      smallint;
  v_no      text;
  v_line_no smallint := 0;
  v_leg     jsonb;
  v_rule    ledger.posting_rule%ROWTYPE;
  v_amount  platform.money;
  v_dr      platform.money := 0;
  v_cr      platform.money := 0;
BEGIN
  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE p_entry_date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', p_entry_date;
  END IF;

  v_no := platform.next_document_no(p_branch, 'journal', v_fy);

  INSERT INTO ledger.journal_entry
    (number, fiscal_year, branch_id, entry_date, kind, status,
     description, ref_type, ref_id, created_by)
  VALUES
    (v_no, v_fy, p_branch, p_entry_date, p_event_type, p_status,
     p_description, p_ref_type, p_ref_id, p_user)
  RETURNING id INTO v_entry;

  FOR v_leg IN SELECT * FROM jsonb_array_elements(p_legs) LOOP
    v_amount := (v_leg->>'amount')::platform.money;
    CONTINUE WHEN v_amount IS NULL OR v_amount = 0;

    SELECT * INTO v_rule FROM ledger.posting_rule
     WHERE event_type = p_event_type
       AND leg        = v_leg->>'leg'
       AND is_active
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'قاعده ثبت برای رویداد «%» و مؤلفه «%» تعریف نشده است',
        p_event_type, v_leg->>'leg';
    END IF;

    -- مبلغ منفی یعنی سمت سند برعکس می‌شود (مثلاً مغایرت منفی صندوق)
    v_line_no := v_line_no + 1;
    INSERT INTO ledger.journal_line
      (entry_id, line_no, account_code, cost_center,
       party_type, party_id, debit, credit, description)
    VALUES
      (v_entry, v_line_no, v_rule.account_code, v_leg->>'cost_center',
       coalesce(v_leg->>'party_type', v_rule.party_type),
       (v_leg->>'party_id')::uuid,
       CASE WHEN (v_rule.side = 'debit') = (v_amount > 0) THEN abs(v_amount) ELSE 0 END,
       CASE WHEN (v_rule.side = 'debit') = (v_amount > 0) THEN 0 ELSE abs(v_amount) END,
       coalesce(v_leg->>'description', v_rule.description));
  END LOOP;

  IF v_line_no = 0 THEN
    RAISE EXCEPTION 'سند بدون سطر: رویداد % هیچ مبلغ غیرصفری نداشت', p_event_type;
  END IF;

  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO v_dr, v_cr
    FROM ledger.journal_line WHERE entry_id = v_entry;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION
      'سند % متوازن نیست: بدهکار %، بستانکار %، اختلاف %',
      v_no, v_dr, v_cr, v_dr - v_cr;
  END IF;

  RETURN v_entry;
END $$;

-- ---------------------------------------------------------------------
-- ۳. ثبت رسید خرید — تخصیص هزینه جانبی + ورود انبار + سند
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION purchasing.post_receipt(
  p_receipt uuid, p_user uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  r            purchasing.receipt%ROWTYPE;
  v_goods      platform.money := 0;
  v_charges    platform.money := 0;
  v_charge_alloc platform.money;
  v_qty_total  platform.qty := 0;
  v_line       record;
  v_alloc_sum  platform.money := 0;
  v_last_line  uuid;
  v_by_value   platform.money := 0;
  v_by_qty     platform.money := 0;
  v_paid_cash  platform.money := 0;
  v_entry      uuid;
  v_legs       jsonb;
BEGIN
  SELECT * INTO r FROM purchasing.receipt WHERE id = p_receipt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'رسید خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'رسید خرید % قبلاً ثبت شده است', r.number;
  END IF;

  SELECT coalesce(sum(qty * unit_price),0), coalesce(sum(qty),0)
    INTO v_goods, v_qty_total
    FROM purchasing.receipt_line WHERE receipt_id = p_receipt;

  IF v_qty_total = 0 THEN
    RAISE EXCEPTION 'رسید خرید بدون قلم قابل ثبت نیست';
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE allocation = 'by_value'), 0),
         coalesce(sum(amount) FILTER (WHERE allocation = 'by_qty'), 0),
         coalesce(sum(amount), 0),
         coalesce(sum(amount) FILTER (WHERE paid_from = 'cash'), 0)
    INTO v_by_value, v_by_qty, v_charges, v_paid_cash
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

  -- تخصیص هزینه جانبی. باقی‌مانده گرد کردن به آخرین سطر می‌رود
  -- تا جمع تخصیص دقیقاً برابر کل هزینه باشد.
  FOR v_line IN
    SELECT id, variation_id, qty, unit_price, qty * unit_price AS line_amount
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt ORDER BY id
  LOOP
    v_charge_alloc :=
        round(CASE WHEN v_goods > 0 THEN v_by_value * v_line.line_amount / v_goods ELSE 0 END)
      + round(v_by_qty * v_line.qty / v_qty_total);
    v_alloc_sum := v_alloc_sum + v_charge_alloc;
    v_last_line := v_line.id;

    UPDATE purchasing.receipt_line
       SET line_amount      = v_line.line_amount,
           charge_alloc     = v_charge_alloc,
           landed_unit_cost = round((v_line.line_amount + v_charge_alloc) / v_line.qty)
     WHERE id = v_line.id;
  END LOOP;

  IF v_alloc_sum <> v_charges AND v_last_line IS NOT NULL THEN
    UPDATE purchasing.receipt_line
       SET charge_alloc     = charge_alloc + (v_charges - v_alloc_sum),
           landed_unit_cost = round((line_amount + charge_alloc + (v_charges - v_alloc_sum)) / qty)
     WHERE id = v_last_line;
  END IF;

  -- ورود انبار با بهای تمام‌شده نهایی
  FOR v_line IN
    SELECT variation_id, qty, landed_unit_cost
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt
  LOOP
    PERFORM inventory.apply_movement(
      v_line.variation_id, r.warehouse_id, v_line.qty,
      'purchase_receipt', 'purchase_receipt', p_receipt, p_user,
      v_line.landed_unit_cost, false, r.occurred_at);
  END LOOP;

  UPDATE purchasing.receipt
     SET goods_amount   = v_goods,
         charges_amount = v_charges,
         total_payable  = v_goods + r.tax_amount,
         status         = 'posted',
         posted_at      = now()
   WHERE id = p_receipt;

  -- سند: موجودی کالا به بهای تمام‌شده (کالا + هزینه جانبی).
  -- بدهی تأمین‌کننده = کالا + مالیات + آن بخش از هزینه جانبی که نقدی پرداخت نشده.
  v_legs := jsonb_build_array(
    jsonb_build_object('leg','inventory','amount', v_goods + v_charges),
    jsonb_build_object('leg','input_tax','amount', r.tax_amount),
    jsonb_build_object('leg','payable',
                       'amount', v_goods + r.tax_amount + (v_charges - v_paid_cash),
                       'party_type','supplier','party_id', r.supplier_id),
    jsonb_build_object('leg','cash','amount', v_paid_cash)
  );

  v_entry := ledger.post_entry(
    'purchase_receipt', r.branch_id, r.occurred_at::date,
    'رسید خرید ' || r.number, v_legs,
    'purchase_receipt', p_receipt, p_user);

  RETURN v_entry;
END $$;

-- ---------------------------------------------------------------------
-- ۴. نهایی‌کردن فاکتور فروش
-- ---------------------------------------------------------------------
-- شماره فاکتور فقط اینجا و در همین تراکنش تخصیص می‌یابد.
-- سند حسابداری اینجا زده نمی‌شود — در سطح شیفت تجمیع می‌شود.

CREATE OR REPLACE FUNCTION sales.finalize_invoice(
  p_invoice uuid, p_user uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  inv        sales.invoice%ROWTYPE;
  v_line     record;
  v_mv       inventory.movement_result;
  v_cogs     platform.money := 0;
  v_residual platform.money := 0;
  v_gross    platform.money := 0;
  v_disc     platform.money := 0;
  v_net      platform.money := 0;
  v_tax      platform.money := 0;
  v_paid     platform.money := 0;
  v_fy       smallint;
  v_no       text;
BEGIN
  SELECT * INTO inv FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;

  -- Idempotency: فراخوانی دوباره همان شماره قبلی را برمی‌گرداند
  IF inv.status IN ('finalized','paid','partially_returned','returned') THEN
    RETURN inv.number;
  END IF;
  IF inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'فاکتور باطل‌شده نهایی نمی‌شود';
  END IF;

  SELECT coalesce(sum(qty * unit_price),0),
         coalesce(sum(discount_amount),0),
         coalesce(sum(net_amount),0),
         coalesce(sum(tax_amount),0)
    INTO v_gross, v_disc, v_net, v_tax
    FROM sales.invoice_line WHERE invoice_id = p_invoice;

  IF v_gross = 0 THEN
    RAISE EXCEPTION 'فاکتور بدون قلم نهایی نمی‌شود';
  END IF;

  -- خروج انبار + ثبت Snapshot بهای تمام‌شده روی هر سطر
  FOR v_line IN
    SELECT id, variation_id, qty FROM sales.invoice_line
     WHERE invoice_id = p_invoice ORDER BY line_no
  LOOP
    v_mv := inventory.apply_movement(
      v_line.variation_id, inv.warehouse_id, -v_line.qty,
      'sale', 'invoice', p_invoice, p_user, NULL, false, inv.occurred_at);

    -- cogs_amount = کاهش واقعی ارزش موجودی، نه unit_cost×qty.
    -- این تنها راهی است که سند COGS همیشه با انبار بخواند.
    UPDATE sales.invoice_line
       SET unit_cost   = v_mv.unit_cost,
           cogs_amount = abs(v_mv.value_delta)
     WHERE id = v_line.id;

    v_cogs     := v_cogs + abs(v_mv.value_delta);
    v_residual := v_residual + v_mv.residual;
  END LOOP;

  SELECT coalesce(sum(amount),0) INTO v_paid
    FROM treasury.payment
   WHERE invoice_id = p_invoice AND direction = 'in'
     AND status IN ('succeeded','settled','pending','unknown');

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE inv.occurred_at::date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', inv.occurred_at::date;
  END IF;

  v_no := platform.next_document_no(inv.branch_id, 'invoice', v_fy);

  UPDATE sales.invoice
     SET number          = v_no,
         gross_amount    = v_gross,
         discount_amount = v_disc,
         net_amount      = v_net,
         tax_amount      = v_tax,
         payable_amount  = v_net + v_tax + inv.shipping_amount,
         paid_amount     = v_paid,
         cogs_amount     = v_cogs,
         status          = 'finalized',
         finalized_at    = now()
   WHERE id = p_invoice;

  -- پیامک، PDF و ارسال وضعیت: بعد از Commit، توسط Worker
  INSERT INTO platform.outbox_message (topic, payload)
  VALUES ('invoice.finalized',
          jsonb_build_object('invoice_id', p_invoice, 'number', v_no));

  RETURN v_no;
END $$;

-- ---------------------------------------------------------------------
-- ۵. ثبت مرجوعی — با بهای Snapshot همان سطر فروش
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sales.post_return(
  p_return uuid, p_user uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r          sales.sale_return%ROWTYPE;
  inv        sales.invoice%ROWTYPE;
  v_line     record;
  v_net      platform.money := 0;
  v_tax      platform.money := 0;
  v_cogs     platform.money := 0;
  v_fy       smallint;
  v_no       text;
  v_remaining platform.qty;
  v_line_cogs platform.money;
BEGIN
  SELECT * INTO r FROM sales.sale_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ مرجوعی یافت نشد'; END IF;
  IF r.status = 'posted' THEN RETURN r.number; END IF;

  SELECT * INTO inv FROM sales.invoice WHERE id = r.invoice_id FOR UPDATE;
  IF inv.status NOT IN ('finalized','paid','partially_returned') THEN
    RAISE EXCEPTION 'فاکتور % در وضعیت قابل مرجوعی نیست (%)', inv.number, inv.status;
  END IF;

  FOR v_line IN
    SELECT rl.id, rl.invoice_line_id, rl.qty, rl.restock, rl.condition,
           il.variation_id, il.unit_cost, il.unit_price, il.qty AS sold_qty,
           il.returned_qty, il.discount_amount, il.tax_amount, il.net_amount,
           il.cogs_amount AS sold_cogs
      FROM sales.sale_return_line rl
      JOIN sales.invoice_line il ON il.id = rl.invoice_line_id
     WHERE rl.return_id = p_return
       FOR UPDATE OF il
  LOOP
    v_remaining := v_line.sold_qty - v_line.returned_qty;
    IF v_line.qty > v_remaining THEN
      RAISE EXCEPTION
        'تعداد مرجوعی بیش از باقی‌مانده سطر است: درخواست %، باقی‌مانده %',
        v_line.qty, v_remaining;
    END IF;

    -- بهای بازگشت نسبتی از بهای همان فروش است، نه میانگین جاری انبار.
    -- برگشت کامل، دقیقاً همان مبلغی را برمی‌گرداند که خارج شده بود.
    IF v_line.qty = v_remaining THEN
      v_line_cogs := v_line.sold_cogs
                     - coalesce((SELECT sum(prl.cogs_amount)
                                   FROM sales.sale_return_line prl
                                   JOIN sales.sale_return pr ON pr.id = prl.return_id
                                  WHERE prl.invoice_line_id = v_line.invoice_line_id
                                    AND pr.status = 'posted'), 0);
    ELSE
      v_line_cogs := round(v_line.sold_cogs * v_line.qty / v_line.sold_qty);
    END IF;

    IF v_line.restock THEN
      PERFORM inventory.apply_movement(
        p_variation   => v_line.variation_id,
        p_warehouse   => CASE WHEN v_line.condition = 'defective'
                              THEN (SELECT id FROM inventory.warehouse
                                     WHERE branch_id = r.branch_id AND kind = 'defective' LIMIT 1)
                              ELSE r.warehouse_id END,
        p_qty         => v_line.qty,
        p_kind        => 'sale_return',
        p_ref_type    => 'sale_return',
        p_ref_id      => p_return,
        p_user        => p_user,
        p_unit_cost   => round(v_line_cogs / v_line.qty),
        p_occurred_at => r.occurred_at,
        p_value_delta => v_line_cogs);
    ELSE
      -- کالا برنمی‌گردد (مثلاً امحا شد): بهایی هم برنمی‌گردد
      v_line_cogs := 0;
    END IF;

    UPDATE sales.sale_return_line
       SET unit_price  = v_line.unit_price,
           net_amount  = round(v_line.net_amount * v_line.qty / v_line.sold_qty),
           tax_amount  = round(v_line.tax_amount * v_line.qty / v_line.sold_qty),
           unit_cost   = v_line.unit_cost,
           cogs_amount = v_line_cogs
     WHERE id = v_line.id;

    UPDATE sales.invoice_line
       SET returned_qty = returned_qty + v_line.qty
     WHERE id = v_line.invoice_line_id;
  END LOOP;

  SELECT coalesce(sum(net_amount),0), coalesce(sum(tax_amount),0),
         coalesce(sum(cogs_amount),0)
    INTO v_net, v_tax, v_cogs
    FROM sales.sale_return_line WHERE return_id = p_return;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE r.occurred_at::date BETWEEN starts_on AND ends_on;
  v_no := platform.next_document_no(r.branch_id, 'sale_return', v_fy);

  UPDATE sales.sale_return
     SET number = v_no, net_amount = v_net, tax_amount = v_tax,
         cogs_amount = v_cogs, status = 'posted'
   WHERE id = p_return;

  UPDATE sales.invoice
     SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM sales.invoice_line
                             WHERE invoice_id = inv.id AND returned_qty < qty)
           THEN 'returned' ELSE 'partially_returned' END
   WHERE id = inv.id;

  -- سند مرجوعی: برگشت از فروش + معکوس بهای تمام‌شده
  PERFORM ledger.post_entry(
    'sale_return', r.branch_id, r.occurred_at::date,
    'برگشت از فروش ' || v_no || ' — فاکتور ' || inv.number,
    jsonb_build_array(
      jsonb_build_object('leg','sales_return','amount', v_net),
      jsonb_build_object('leg','tax','amount', v_tax),
      jsonb_build_object('leg','refund_cash','amount', r.refund_amount),
      jsonb_build_object('leg','customer_credit',
                         'amount', v_net + v_tax - r.refund_amount,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','inventory','amount', v_cogs),
      jsonb_build_object('leg','cogs','amount', v_cogs)),
    'sale_return', p_return, p_user);

  RETURN v_no;
END $$;

-- ---------------------------------------------------------------------
-- ۶. بستن شیفت — سند تجمیعی فروش و بهای تمام‌شده
-- ---------------------------------------------------------------------
-- به‌جای یک سند برای هر فاکتور (سالی ~۱۵٬۰۰۰ سند)، یک سند فروش و
-- یک سند COGS برای هر شیفت. ردیابی تا تک‌فاکتور از طریق ref_id حفظ می‌شود.

CREATE OR REPLACE FUNCTION sales.close_shift(
  p_shift uuid, p_counted_cash platform.money, p_user uuid DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS TABLE (sale_entry uuid, cogs_entry uuid, variance platform.money)
LANGUAGE plpgsql AS $$
DECLARE
  s          sales.cash_shift%ROWTYPE;
  v_gross    platform.money := 0;
  v_disc     platform.money := 0;
  v_tax      platform.money := 0;
  v_cogs     platform.money := 0;
  v_cash     platform.money := 0;
  v_card     platform.money := 0;
  v_transfer platform.money := 0;
  v_credit   platform.money := 0;
  v_shipping platform.money := 0;
  v_payable  platform.money := 0;
  v_expected platform.money;
  v_variance platform.money;
  v_legs     jsonb;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_date     date;
BEGIN
  SELECT * INTO s FROM sales.cash_shift WHERE id = p_shift FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'شیفت یافت نشد'; END IF;
  IF s.status <> 'open' THEN RAISE EXCEPTION 'شیفت قبلاً بسته شده است'; END IF;

  IF EXISTS (SELECT 1 FROM sales.invoice
              WHERE shift_id = p_shift
                AND status IN ('draft','confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'شیفت با فاکتور نهایی‌نشده بسته نمی‌شود';
  END IF;

  v_date := s.opened_at::date;

  SELECT coalesce(sum(gross_amount),0), coalesce(sum(discount_amount),0),
         coalesce(sum(tax_amount),0),   coalesce(sum(cogs_amount),0),
         coalesce(sum(shipping_amount),0), coalesce(sum(payable_amount),0)
    INTO v_gross, v_disc, v_tax, v_cogs, v_shipping, v_payable
    FROM sales.invoice
   WHERE shift_id = p_shift AND status IN ('finalized','paid','partially_returned','returned');

  SELECT
    coalesce(sum(p.amount) FILTER (WHERE m.kind = 'cash'), 0),
    coalesce(sum(p.amount) FILTER (WHERE m.kind = 'card_reader'), 0),
    coalesce(sum(p.amount) FILTER (WHERE m.kind IN ('transfer','gateway')), 0)
    INTO v_cash, v_card, v_transfer
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
   WHERE p.shift_id = p_shift AND p.direction = 'in'
     AND p.status IN ('succeeded','settled','pending','unknown');

  -- دریافتنی به‌صورت باقی‌مانده محاسبه می‌شود، نه از جمع پرداخت‌های نسیه.
  -- این تنها راهی است که سند در حالت فروش نیمه‌پرداخت هم متوازن می‌ماند.
  v_credit := v_payable - (v_cash + v_card + v_transfer);

  v_expected := s.opening_cash + v_cash;
  v_variance := p_counted_cash - v_expected;

  IF v_gross > 0 THEN
    v_legs := jsonb_build_array(
      jsonb_build_object('leg','cash',           'amount', v_cash),
      jsonb_build_object('leg','card_clearing',  'amount', v_card),
      jsonb_build_object('leg','transfer_clearing','amount', v_transfer),
      jsonb_build_object('leg','receivable',     'amount', v_credit),
      jsonb_build_object('leg','discount',       'amount', v_disc),
      jsonb_build_object('leg','sales',          'amount', v_gross),
      jsonb_build_object('leg','shipping',       'amount', v_shipping),
      jsonb_build_object('leg','tax',            'amount', v_tax)
    );

    v_sale := ledger.post_entry(
      'sale_shift', s.branch_id, v_date,
      'فروش شیفت ' || to_char(s.opened_at, 'YYYY-MM-DD HH24:MI'),
      v_legs, 'cash_shift', p_shift, p_user);
  END IF;

  -- مغایرت صندوق سند جداگانه دارد. مخلوط‌کردنش با سند فروش،
  -- «فروش» و «وجه دریافتی» را در گزارش‌ها به هم می‌ریزد.
  IF v_variance <> 0 THEN
    PERFORM ledger.post_entry(
      'shift_variance', s.branch_id, v_date,
      'مغایرت صندوق — شیفت ' || to_char(s.opened_at, 'YYYY-MM-DD HH24:MI'),
      jsonb_build_array(
        jsonb_build_object('leg','cash',    'amount', v_variance),
        jsonb_build_object('leg','variance','amount', v_variance)),
      'cash_shift', p_shift, p_user);
  END IF;

  IF v_cogs > 0 THEN
    v_cogs_e := ledger.post_entry(
      'shift_cogs', s.branch_id, v_date,
      'بهای تمام‌شده کالای فروش‌رفته — شیفت ' || to_char(s.opened_at, 'YYYY-MM-DD HH24:MI'),
      jsonb_build_array(
        jsonb_build_object('leg','cogs',     'amount', v_cogs),
        jsonb_build_object('leg','inventory','amount', v_cogs)),
      'cash_shift', p_shift, p_user);
  END IF;

  UPDATE sales.cash_shift
     SET closed_at = now(), counted_cash = p_counted_cash,
         expected_cash = v_expected, variance = v_variance,
         variance_note = p_note, status = 'closed'
   WHERE id = p_shift;

  RETURN QUERY SELECT v_sale, v_cogs_e, v_variance;
END $$;

-- ---------------------------------------------------------------------
-- ۷. تطبیق شبانه Projection با مرجع
-- ---------------------------------------------------------------------
-- stock_balance یک Projection است. اگر روزی با جمع حرکت‌ها نخواند،
-- یک باگ وجود دارد و باید فوراً دیده شود — نه اینکه ماه‌ها پنهان بماند.

CREATE OR REPLACE VIEW inventory.balance_check AS
SELECT b.variation_id, b.warehouse_id,
       b.on_hand      AS projected_qty,
       coalesce(m.qty, 0)   AS movement_qty,
       b.total_value  AS projected_value,
       coalesce(m.val, 0)   AS movement_value,
       b.on_hand - coalesce(m.qty, 0)     AS qty_diff,
       b.total_value - coalesce(m.val, 0) AS value_diff
  FROM inventory.stock_balance b
  LEFT JOIN (
    SELECT variation_id, warehouse_id, sum(qty) AS qty, sum(value_delta) AS val
      FROM inventory.stock_movement GROUP BY 1,2
  ) m ON m.variation_id = b.variation_id AND m.warehouse_id = b.warehouse_id;

CREATE OR REPLACE VIEW ledger.trial_balance AS
SELECT a.code, a.name, a.level, a.type,
       sum(l.debit)  AS debit,
       sum(l.credit) AS credit,
       sum(l.debit) - sum(l.credit) AS balance
  FROM ledger.journal_line l
  JOIN ledger.account a ON a.code = l.account_code
  JOIN ledger.journal_entry e ON e.id = l.entry_id
 WHERE e.status IN ('confirmed','final')
 GROUP BY a.code, a.name, a.level, a.type;

COMMIT;
