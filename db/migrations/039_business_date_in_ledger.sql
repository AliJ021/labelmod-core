-- =====================================================================
-- ۰۳۹ — تاریخ سند هم از منطقه زمانی کسب‌وکار می‌آید، نه از سرور
-- =====================================================================
--
-- ## باگ
--
-- مهاجرت ۰۱۴ نوشت: «`::date` روی `timestamptz` از منطقه زمانی **سرور**
-- می‌آید» و دو تابع مسیر دوره ثبت را اصلاح کرد. ۰۲۳ دو تای دیگر را.
-- ولی هر مهاجرتی که **بعد از آن‌ها** نوشته شد، دوباره
-- `occurred_at::date` نوشت — و آن‌ها نسخه جاری‌اند.
--
-- نتیجه: ده تابع مالی هنوز تاریخ را از منطقه زمانی سرور می‌گرفتند،
-- در حالی که `sales.post_batch` و `resolve_posting_batch` از تهران.
-- روی سروری با UTC — همان چیزی که `docs/DEPLOYMENT.md` می‌سازد — یعنی
-- **هر سندی که بین ۰۰:۰۰ تا ۰۳:۳۰ بامداد به وقت تهران ثبت شود**:
--
--   * `entry_date` یک روز عقب می‌خورد؛ دفتر با گزارش فروش یکی
--     درنمی‌آید و هیچ خطایی هم نمی‌دهد.
--   * سال مالی هم با همان تاریخ غلط پیدا می‌شود. در ۳٫۵ ساعت اول
--     **سال مالی تازه**، سند به سال قبل می‌خورد؛ و اگر سال قبل بسته
--     باشد، عملیات با «سال مالی برای تاریخ … تعریف نشده است» رد
--     می‌شود — یعنی فروشگاه در آن ساعت‌ها اصلاً نمی‌تواند بفروشد.
--   * شیفتی که ۰۱:۰۰ بامداد باز شود، تاریخ کاری‌اش با تاریخ دوره
--     ثبتِ همان شیفت یکی نیست.
--
-- ## چرا هیچ تستی نگرفته بود
--
-- تست‌ها تاریخ را با `platform.business_date()` می‌گیرند و سند را با
-- `now()` می‌سازند. این دو فقط در همان پنجره ۳٫۵ ساعته از هم جدا
-- می‌شوند، پس مجموعه تست ۲۰٫۵ ساعت از شبانه‌روز سبز بود. یک اجرای
-- بامدادی پیدایش کرد.
--
-- ## اصلاح
--
-- هر ۲۷ مورد به `platform.business_date(...)` تبدیل شد — **تنها
-- تعریف «امروز» در سیستم**، همان که CLAUDE.md می‌گوید یکی است نه
-- چند تا.
--
-- بدنه توابع عیناً از `pg_get_functiondef()` نسخه جاری گرفته شده و
-- تنها همان عبارت‌های تاریخ عوض شده‌اند؛ هیچ منطق دیگری دست نخورده.
--
-- ⚠️ این مهاجرت **داده گذشته را اصلاح نمی‌کند.** سندی که پیش از این
--    با تاریخ غلط نشسته، سر جایش می‌ماند: سند نهایی حذف و ویرایش
--    نمی‌شود و اصلاحش فقط با سند معکوس ممکن است. چون هنوز داده
--    واقعی وارد نشده، چیزی برای اصلاح نیست — ولی اگر روزی شد، این
--    یادداشت می‌گوید کجا را نگاه کنند.
-- =====================================================================

BEGIN;

-- ── sales.finalize_invoice ──
CREATE OR REPLACE FUNCTION sales.finalize_invoice(p_invoice uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  inv        sales.invoice%ROWTYPE;
  v_line     record;
  v_mv       inventory.movement_result;
  v_cogs     platform.money := 0;
  v_gross    platform.money := 0;
  v_disc     platform.money := 0;
  v_net      platform.money := 0;
  v_tax      platform.money := 0;
  v_paid     platform.money := 0;
  v_batch    uuid;
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

  -- دوره ثبت پیش از هر اثری تعیین می‌شود: اگر شیفت بسته یا دوره بسته
  -- باشد، باید همین‌جا شکست بخورد، نه بعد از خروج کالا از انبار.
  v_batch := sales.resolve_posting_batch(p_invoice);

  SELECT coalesce(sum(qty * unit_price),0),
         coalesce(sum(discount_amount),0),
         coalesce(sum(net_amount),0),
         coalesce(sum(tax_amount),0)
    INTO v_gross, v_disc, v_net, v_tax
    FROM sales.invoice_line WHERE invoice_id = p_invoice;

  IF v_gross = 0 THEN
    RAISE EXCEPTION 'فاکتور بدون قلم نهایی نمی‌شود';
  END IF;

  FOR v_line IN
    SELECT id, variation_id, qty FROM sales.invoice_line
     WHERE invoice_id = p_invoice ORDER BY line_no
  LOOP
    v_mv := inventory.apply_movement(
      v_line.variation_id, inv.warehouse_id, -v_line.qty,
      'sale', 'invoice', p_invoice, p_user, NULL, false, inv.occurred_at);

    UPDATE sales.invoice_line
       SET unit_cost   = v_mv.unit_cost,
           cogs_amount = abs(v_mv.value_delta)
     WHERE id = v_line.id;

    v_cogs := v_cogs + abs(v_mv.value_delta);
  END LOOP;

  -- پول واقعاً دریافت‌شده. «نامشخص» و «در انتظار» پول نیستند و فاکتور
  -- را پرداخت‌شده نشان نمی‌دهند؛ در سند دوره حساب واسط مستقل می‌گیرند.
  SELECT coalesce(sum(amount),0) INTO v_paid
    FROM treasury.payment
   WHERE invoice_id = p_invoice AND direction = 'in'
     AND status IN ('succeeded','settled','reconciled');

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE platform.business_date(inv.occurred_at) BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(inv.occurred_at);
  END IF;

  v_no := platform.next_document_no(inv.branch_id, 'invoice', v_fy);

  UPDATE sales.invoice
     SET number           = v_no,
         gross_amount     = v_gross,
         discount_amount  = v_disc,
         net_amount       = v_net,
         tax_amount       = v_tax,
         payable_amount   = v_net + v_tax + inv.shipping_amount,
         paid_amount      = v_paid,
         cogs_amount      = v_cogs,
         posting_batch_id = v_batch,
         status           = 'finalized',
         finalized_at     = now()
   WHERE id = p_invoice;

  PERFORM platform.audit('invoice.finalize', 'invoice', p_invoice::text,
    jsonb_build_object('number', v_no, 'payable', v_net + v_tax + inv.shipping_amount,
                       'paid', v_paid, 'cogs', v_cogs, 'batch', v_batch),
    p_user);

  INSERT INTO platform.outbox_message (topic, payload)
  VALUES ('invoice.finalized',
          jsonb_build_object('invoice_id', p_invoice, 'number', v_no));

  RETURN v_no;
END $function$;

-- ── sales.post_return ──
CREATE OR REPLACE FUNCTION sales.post_return(p_return uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  r            sales.sale_return%ROWTYPE;
  inv          sales.invoice%ROWTYPE;
  v_line       record;
  v_net        platform.money := 0;
  v_tax        platform.money := 0;
  v_cogs       platform.money := 0;
  v_fy         smallint;
  v_no         text;
  v_remaining  platform.qty;
  v_line_cogs  platform.money;
  v_credit_total   platform.money;
  v_received       platform.money;
  v_refunded_before platform.money;
  v_returned_before platform.money;
  v_refund_paid    platform.money;
  v_outstanding    platform.money;
  v_recv           platform.money;
  v_cust_credit    platform.money;
BEGIN
  SELECT * INTO r FROM sales.sale_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ مرجوعی یافت نشد'; END IF;
  IF r.status = 'posted' THEN RETURN r.number; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'برگ مرجوعی باطل‌شده ثبت نمی‌شود'; END IF;

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

  v_credit_total := v_net + v_tax;

  -- پول واقعاً دریافت‌شده بابت این فاکتور. «نامشخص» پول نیست.
  SELECT coalesce(sum(amount),0) INTO v_received
    FROM treasury.payment
   WHERE invoice_id = inv.id AND direction = 'in'
     AND status IN ('succeeded','settled','reconciled');

  SELECT coalesce(sum(refund_amount),0),
         coalesce(sum(net_amount + tax_amount),0)
    INTO v_refunded_before, v_returned_before
    FROM sales.sale_return
   WHERE invoice_id = inv.id AND status = 'posted' AND id <> p_return;

  IF r.refund_amount > v_credit_total THEN
    RAISE EXCEPTION
      'بازپرداخت (%) بیش از ارزش کالای مرجوعی (%) است', r.refund_amount, v_credit_total;
  END IF;
  IF r.refund_amount > v_received - v_refunded_before THEN
    RAISE EXCEPTION
      'بازپرداخت (%) بیش از مبلغ دریافت‌شده بابت این فاکتور (%) است. پولی که گرفته نشده، پس داده نمی‌شود.',
      r.refund_amount, v_received - v_refunded_before;
  END IF;

  -- بدهی باقی‌مانده مشتری بابت این فاکتور، پیش از این مرجوعی:
  --   تعهد (مبلغ فاکتور منهای کالای قبلاً برگشتی) منهای تسویه (دریافتی
  --   منهای بازپرداخت‌های قبلی)
  v_outstanding := inv.payable_amount - v_returned_before - v_received + v_refunded_before;
  IF v_outstanding < 0 THEN v_outstanding := 0; END IF;

  v_recv        := least(greatest(v_credit_total - r.refund_amount, 0), v_outstanding);
  v_cust_credit := (v_credit_total - r.refund_amount) - v_recv;

  IF v_cust_credit > 0 AND inv.customer_id IS NULL THEN
    RAISE EXCEPTION
      'فروش ناشناس اعتبار مشتری نمی‌پذیرد. برای مرجوعی این فاکتور، بازپرداخت باید کامل باشد.';
  END IF;

  -- بازپرداخت باید در خزانه هم رد داشته باشد، وگرنه شمارش صندوق و دفتر
  -- از هم جدا می‌افتند.
  SELECT coalesce(sum(amount),0) INTO v_refund_paid
    FROM treasury.payment
   WHERE return_id = p_return AND direction = 'out'
     AND status IN ('succeeded','settled','reconciled');

  IF v_refund_paid = 0 AND r.refund_amount > 0 THEN
    INSERT INTO treasury.payment
      (return_id, shift_id, method_code, direction, amount, status, occurred_at)
    VALUES
      (p_return, r.shift_id, coalesce(r.refund_method, 'cash'), 'out',
       r.refund_amount, 'succeeded', r.occurred_at);
  ELSIF v_refund_paid <> r.refund_amount THEN
    RAISE EXCEPTION
      'مبلغ بازپرداخت (%) با پرداخت‌های ثبت‌شده خزانه (%) نمی‌خواند',
      r.refund_amount, v_refund_paid;
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE platform.business_date(r.occurred_at) BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(r.occurred_at);
  END IF;

  v_no := platform.next_document_no(r.branch_id, 'sale_return', v_fy);

  UPDATE sales.sale_return
     SET number = v_no, net_amount = v_net, tax_amount = v_tax,
         cogs_amount = v_cogs, receivable_applied = v_recv,
         credit_applied = v_cust_credit, status = 'posted'
   WHERE id = p_return;

  UPDATE sales.invoice
     SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM sales.invoice_line
                             WHERE invoice_id = inv.id AND returned_qty < qty)
           THEN 'returned' ELSE 'partially_returned' END
   WHERE id = inv.id;

  PERFORM ledger.post_entry(
    'sale_return', r.branch_id, platform.business_date(r.occurred_at),
    'برگشت از فروش ' || v_no || ' — فاکتور ' || inv.number,
    jsonb_build_array(
      jsonb_build_object('leg','sales_return',   'amount', v_net),
      jsonb_build_object('leg','tax',            'amount', v_tax),
      jsonb_build_object('leg','refund_cash',    'amount', r.refund_amount),
      jsonb_build_object('leg','receivable',     'amount', v_recv,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','customer_credit','amount', v_cust_credit,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','inventory',      'amount', v_cogs),
      jsonb_build_object('leg','cogs',           'amount', v_cogs)),
    'sale_return', p_return, p_user);

  PERFORM platform.audit('return.post', 'sale_return', p_return::text,
    jsonb_build_object('number', v_no, 'invoice', inv.number,
                       'net', v_net, 'tax', v_tax, 'cogs', v_cogs,
                       'refund', r.refund_amount, 'receivable_applied', v_recv,
                       'credit_applied', v_cust_credit),
    p_user, coalesce(r.reason_note, r.reason_code));

  RETURN v_no;
END $function$;

-- ── sales.close_shift ──
CREATE OR REPLACE FUNCTION sales.close_shift(p_shift uuid, p_counted_cash platform.money, p_user uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS TABLE(sale_entry uuid, cogs_entry uuid, variance platform.money)
 LANGUAGE plpgsql
AS $function$
DECLARE
  s          sales.cash_shift%ROWTYPE;
  v_batch    uuid;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_cash_in  platform.money := 0;
  v_cash_out platform.money := 0;
  v_tx_in    platform.money := 0;
  v_tx_out   platform.money := 0;
  v_expected platform.money;
  v_variance platform.money;
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

  IF EXISTS (SELECT 1 FROM treasury.transaction
              WHERE shift_id = p_shift AND status = 'draft') THEN
    RAISE EXCEPTION 'شیفت با تراکنش خزانه‌ی ثبت‌نشده بسته نمی‌شود';
  END IF;

  v_date := platform.business_date(s.opened_at);

  SELECT id INTO v_batch FROM ledger.posting_batch
   WHERE kind = 'shift' AND shift_id = p_shift;
  IF v_batch IS NULL THEN
    INSERT INTO ledger.posting_batch (branch_id, kind, shift_id, business_date)
    VALUES (s.branch_id, 'shift', p_shift, v_date)
    ON CONFLICT DO NOTHING RETURNING id INTO v_batch;
    IF v_batch IS NULL THEN
      SELECT id INTO v_batch FROM ledger.posting_batch
       WHERE kind = 'shift' AND shift_id = p_shift;
    END IF;
  END IF;

  SELECT r.sale_entry, r.cogs_entry INTO v_sale, v_cogs_e
    FROM sales.post_batch(v_batch, p_user) r;

  -- ۱) نقد فروش و بازپرداخت مرجوعی
  SELECT coalesce(sum(p.amount) FILTER (WHERE p.direction = 'in'),  0),
         coalesce(sum(p.amount) FILTER (WHERE p.direction = 'out'), 0)
    INTO v_cash_in, v_cash_out
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
   WHERE p.shift_id = p_shift AND m.kind = 'cash'
     AND p.status IN ('succeeded','settled','reconciled');

  -- ۲) هر حرکت نقد غیرفروشی که به همین شیفت نسبت داده شده
  SELECT coalesce(sum(t.amount) FILTER (WHERE ta.kind = 'cash_box'), 0),
         coalesce(sum(t.amount) FILTER (WHERE fa.kind = 'cash_box'), 0)
    INTO v_tx_in, v_tx_out
    FROM treasury.transaction t
    LEFT JOIN treasury.account ta ON ta.id = t.to_account_id
    LEFT JOIN treasury.account fa ON fa.id = t.from_account_id
   WHERE t.shift_id = p_shift AND t.status = 'posted';

  v_expected := s.opening_cash + v_cash_in + v_tx_in - v_cash_out - v_tx_out;
  v_variance := p_counted_cash - v_expected;

  IF v_variance <> 0 THEN
    PERFORM ledger.post_entry(
      'shift_variance', s.branch_id, v_date,
      'مغایرت صندوق — شیفت ' || to_char(s.opened_at, 'YYYY-MM-DD HH24:MI'),
      jsonb_build_array(
        jsonb_build_object('leg','cash',    'amount', v_variance),
        jsonb_build_object('leg','variance','amount', v_variance)),
      'cash_shift', p_shift, p_user);
  END IF;

  UPDATE sales.cash_shift
     SET closed_at = now(), counted_cash = p_counted_cash,
         expected_cash = v_expected, variance = v_variance,
         variance_note = p_note, status = 'closed'
   WHERE id = p_shift;

  PERFORM platform.audit('shift.close', 'cash_shift', p_shift::text,
    jsonb_build_object('opening', s.opening_cash,
                       'sale_cash_in', v_cash_in, 'refund_cash_out', v_cash_out,
                       'treasury_in', v_tx_in,    'treasury_out', v_tx_out,
                       'expected', v_expected, 'counted', p_counted_cash,
                       'variance', v_variance),
    p_user, p_note);

  RETURN QUERY SELECT v_sale, v_cogs_e, v_variance;
END $function$;

-- ── purchasing.post_receipt ──
CREATE OR REPLACE FUNCTION purchasing.post_receipt(p_receipt uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  r              purchasing.receipt%ROWTYPE;
  v_goods        platform.money := 0;
  v_charges      platform.money := 0;
  v_charge_alloc platform.money;
  v_qty_total    platform.qty := 0;
  v_line         record;
  v_alloc_sum    platform.money := 0;
  v_last_line    uuid;
  v_by_value     platform.money := 0;
  v_by_qty       platform.money := 0;
  v_sup_payable  platform.money := 0;   -- هزینه جانبیِ بدهی به تأمین‌کننده
  v_other_payable platform.money := 0;  -- هزینه جانبیِ بدهی به شخص ثالث
  v_treasury_legs jsonb := '[]'::jsonb;
  v_entry        uuid;
  v_legs         jsonb;
  v_reval        platform.money := 0;  -- تفاوت تجدید ارزیابی این رسید
  v_last_cost    boolean;              -- روش «آخرین قیمت خرید» روشن است؟
  v_fy           smallint;             -- سال مالی، فقط برای تخصیص شماره
  v_into_cost    platform.money := 0;  -- هزینه‌ای که به بهای کالا می‌رود
  v_expensed     platform.money := 0;  -- هزینه‌ای که مستقیم هزینه دوره است
  v_expense_legs jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO r FROM purchasing.receipt WHERE id = p_receipt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'رسید خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'رسید خرید % قبلاً ثبت شده است', r.number;
  END IF;

  -- شماره در همین لحظه تخصیص می‌یابد، نه هنگام ساخت پیش‌نویس.
  -- پیش‌نویسی که رها می‌شود نباید یک شماره را بسوزاند: در دفتر خرید،
  -- شماره غایب سؤالی است که کسی نمی‌تواند جوابش را بدهد.
  -- سطر با FOR UPDATE قفل است، پس دو ثبت هم‌زمان یک شماره نمی‌گیرند.
  IF r.number IS NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year
     WHERE platform.business_date(r.occurred_at) BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(r.occurred_at);
    END IF;

    r.number := platform.next_document_no(r.branch_id, 'purchase', v_fy);
    UPDATE purchasing.receipt SET number = r.number WHERE id = p_receipt;
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
         coalesce(sum(amount) FILTER (WHERE paid_from = 'payable' AND payee_type = 'supplier'), 0),
         coalesce(sum(amount) FILTER (WHERE paid_from = 'payable' AND payee_type = 'other'), 0)
    INTO v_by_value, v_by_qty, v_charges, v_sup_payable, v_other_payable
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

  -- هزینه‌ای که وارد بهای کالا می‌شود، و هزینه‌ای که نمی‌شود.
  --
  -- تا مهاجرت ۰۲۶ این دو یکی گرفته می‌شدند: باقی‌مانده گرد کردن با
  -- **کل** هزینه سنجیده می‌شد، پس هزینه‌ای با تخصیص «none» تمامش روی
  -- آخرین سطر می‌نشست. یعنی گزینه‌ای که می‌گفت «به بهای کالا نرو»، در
  -- عمل همه‌اش را روی یک قلم می‌گذاشت — و بهای تمام‌شده آن قلم را
  -- بی‌دلیل بالا می‌برد.
  v_into_cost := v_by_value + v_by_qty;

  SELECT coalesce(sum(amount) FILTER (WHERE allocation = 'none'), 0)
    INTO v_expensed
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

  -- هزینه دوره، به تفکیک حساب. حساب نداده = حساب پیش‌فرض قاعده ثبت.
  SELECT coalesce(jsonb_agg(jsonb_build_object('leg','expensed_charge','amount', amt)
                            || CASE WHEN acc IS NULL THEN '{}'::jsonb
                                    ELSE jsonb_build_object('account_code', acc) END),
                  '[]'::jsonb)
    INTO v_expense_legs
    FROM (SELECT expense_account_code AS acc, sum(amount) AS amt
            FROM purchasing.receipt_charge
           WHERE receipt_id = p_receipt AND allocation = 'none'
           GROUP BY expense_account_code) e;

  -- هزینه‌های پرداخت‌شده از خزانه، به تفکیک حسابِ پرداخت‌کننده
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'leg','from_account', 'amount', amt, 'account_code', acc)), '[]'::jsonb)
    INTO v_treasury_legs
    FROM (SELECT a.ledger_account_code AS acc, sum(c.amount) AS amt
            FROM purchasing.receipt_charge c
            JOIN treasury.account a ON a.id = c.paid_account_id
           WHERE c.receipt_id = p_receipt AND c.paid_from = 'treasury'
           GROUP BY a.ledger_account_code) x;

  -- تخصیص هزینه جانبی. باقی‌مانده گرد کردن به آخرین سطر می‌رود تا جمع
  -- تخصیص دقیقاً برابر کل هزینه باشد.
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

  IF v_alloc_sum <> v_into_cost AND v_last_line IS NOT NULL THEN
    UPDATE purchasing.receipt_line
       SET charge_alloc     = charge_alloc + (v_into_cost - v_alloc_sum),
           landed_unit_cost = round((line_amount + charge_alloc + (v_into_cost - v_alloc_sum)) / qty)
     WHERE id = v_last_line;
  END IF;

  -- روش قیمت‌گذاری **داده** است، نه شرطی در کد. یک بار خوانده می‌شود تا
  -- در میانه یک رسید عوض نشود.
  v_last_cost := platform.setting_text('costing.method', 'moving_weighted_average')
                 = 'last_purchase';

  FOR v_line IN
    SELECT variation_id, qty, landed_unit_cost
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt
  LOOP
    PERFORM inventory.apply_movement(
      v_line.variation_id, r.warehouse_id, v_line.qty,
      'purchase_receipt', 'purchase_receipt', p_receipt, p_user,
      v_line.landed_unit_cost, false, r.occurred_at);

    -- ترتیب عمدی است: **اول ورود، بعد تجدید ارزیابی.** برعکسش همان
    -- ارزش نهایی را می‌دهد ولی حرکت ورود دیگر با فاکتور تأمین‌کننده
    -- نمی‌خواند — و همان جایی است که انبار و دفتر از هم جدا می‌افتند.
    IF v_last_cost THEN
      v_reval := v_reval + inventory.revalue_to_cost(
        v_line.variation_id, r.warehouse_id, v_line.landed_unit_cost,
        p_user, 'purchase_receipt', p_receipt, r.occurred_at,
        'تجدید ارزیابی به نرخ رسید ' || r.number);
    END IF;
  END LOOP;

  UPDATE purchasing.receipt
     SET goods_amount        = v_goods,
         charges_amount      = v_charges,
         total_payable       = v_goods + r.tax_amount + v_sup_payable,
         third_party_payable = v_other_payable,
         status              = 'posted',
         posted_at           = now()
   WHERE id = p_receipt;

  v_legs := jsonb_build_array(
              jsonb_build_object('leg','inventory','amount', v_goods + v_into_cost),
              jsonb_build_object('leg','input_tax','amount', r.tax_amount),
              jsonb_build_object('leg','payable',
                                 'amount', v_goods + r.tax_amount + v_sup_payable,
                                 'party_type','supplier','party_id', r.supplier_id),
              jsonb_build_object('leg','other_payable','amount', v_other_payable),
              -- دو سطر با **همان مبلغ علامت‌دار**: اگر نرخ تازه پایین‌تر از
              -- میانگین قبلی باشد مبلغ منفی می‌شود و post_entry خودش هر دو
              -- را برعکس می‌کند — یعنی زیانِ تعدیل، بدهکارِ ۵۱۰۲ می‌شود.
              -- مبلغ صفر اصلاً سطر نمی‌سازد، پس در روش میانگین موزون سند
              -- خرید دقیقاً همان قبلی می‌ماند.
              jsonb_build_object('leg','revaluation',        'amount', v_reval),
              jsonb_build_object('leg','revaluation_offset', 'amount', v_reval))
            || v_expense_legs
            || v_treasury_legs;

  v_entry := ledger.post_entry(
    'purchase_receipt', r.branch_id, platform.business_date(r.occurred_at),
    'رسید خرید ' || r.number, v_legs,
    'purchase_receipt', p_receipt, p_user);

  PERFORM platform.audit('purchase.post', 'purchase_receipt', p_receipt::text,
    jsonb_build_object('number', r.number, 'goods', v_goods, 'charges', v_charges,
                       'charges_into_cost', v_into_cost, 'charges_expensed', v_expensed,
                       'tax', r.tax_amount, 'supplier_payable', v_goods + r.tax_amount + v_sup_payable,
                       'third_party_payable', v_other_payable,
                       'costing_method', CASE WHEN v_last_cost THEN 'last_purchase'
                                              ELSE 'moving_weighted_average' END,
                       'revaluation', v_reval, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $function$;

-- ── purchasing.post_purchase_return ──
CREATE OR REPLACE FUNCTION purchasing.post_purchase_return(p_return uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  r           purchasing.purchase_return%ROWTYPE;
  rc          purchasing.receipt%ROWTYPE;
  v_line      record;
  v_fy        smallint;
  v_goods     platform.money := 0;
  v_cost      platform.money := 0;
  v_tax       platform.money := 0;
  v_line_goods platform.money;
  v_line_cost  platform.money;
  v_receipt_goods platform.money;
  v_entry     uuid;
  v_n         int;
BEGIN
  SELECT * INTO r FROM purchasing.purchase_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ برگشت از خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'برگ برگشت % قبلاً ثبت شده است', coalesce(r.number, '(بی‌شماره)');
  END IF;

  SELECT * INTO rc FROM purchasing.receipt WHERE id = r.receipt_id FOR UPDATE;
  IF rc.status <> 'posted' THEN
    RAISE EXCEPTION 'رسید خرید هنوز ثبت نشده — چیزی نیامده که برگردد';
  END IF;

  SELECT count(*) INTO v_n FROM purchasing.purchase_return_line WHERE return_id = p_return;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'برگ برگشت بدون قلم قابل ثبت نیست';
  END IF;

  IF r.number IS NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year
     WHERE platform.business_date(r.occurred_at) BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(r.occurred_at);
    END IF;
    r.number := platform.next_document_no(r.branch_id, 'purchase_return', v_fy);
    UPDATE purchasing.purchase_return SET number = r.number WHERE id = p_return;
  END IF;

  -- جمع کالای خودِ رسید — پایه تسهیم مالیات.
  SELECT coalesce(sum(round(qty * unit_price)), 0) INTO v_receipt_goods
    FROM purchasing.receipt_line WHERE receipt_id = r.receipt_id;

  FOR v_line IN
    SELECT prl.id, prl.qty, rl.id AS receipt_line_id, rl.variation_id,
           rl.unit_price, rl.landed_unit_cost, rl.qty AS received_qty, rl.returned_qty
      FROM purchasing.purchase_return_line prl
      JOIN purchasing.receipt_line rl ON rl.id = prl.receipt_line_id
     WHERE prl.return_id = p_return
     ORDER BY prl.id
     FOR UPDATE OF rl
  LOOP
    IF v_line.receipt_line_id IS NULL THEN
      RAISE EXCEPTION 'سطر برگشت به هیچ سطری از رسید نمی‌چسبد';
    END IF;

    IF v_line.returned_qty + v_line.qty > v_line.received_qty THEN
      RAISE EXCEPTION
        'بیشتر از آنچه رسید شده برگشت داده می‌شود: رسیدشده %، قبلاً برگشته %، درخواست %',
        v_line.received_qty, v_line.returned_qty, v_line.qty;
    END IF;

    v_line_goods := round(v_line.qty * v_line.unit_price);
    v_line_cost  := round(v_line.qty * v_line.landed_unit_cost);

    -- ارزش خروجی **صریح** داده می‌شود، نه از میانگین جاری: کالا با
    -- بهای همان رسید برمی‌گردد.
    PERFORM inventory.apply_movement(
      p_variation   => v_line.variation_id,
      p_warehouse   => r.warehouse_id,
      p_qty         => -v_line.qty,
      p_kind        => 'purchase_return',
      p_ref_type    => 'purchase_return',
      p_ref_id      => p_return,
      p_user        => p_user,
      p_unit_cost   => v_line.landed_unit_cost,
      p_occurred_at => r.occurred_at,
      p_note        => 'برگشت از خرید ' || r.number,
      p_value_delta => -v_line_cost);

    UPDATE purchasing.receipt_line
       SET returned_qty = returned_qty + v_line.qty
     WHERE id = v_line.receipt_line_id;

    UPDATE purchasing.purchase_return_line
       SET unit_price   = v_line.unit_price,
           unit_cost    = v_line.landed_unit_cost,
           goods_amount = v_line_goods,
           cost_amount  = v_line_cost
     WHERE id = v_line.id;

    v_goods := v_goods + v_line_goods;
    v_cost  := v_cost  + v_line_cost;
  END LOOP;

  -- مالیات به نسبت بهای کالا برمی‌گردد. با نرخ صفر (پیش‌فرض سیستم)
  -- این عدد صفر است و سطری هم ساخته نمی‌شود.
  v_tax := CASE WHEN v_receipt_goods > 0
                THEN round(rc.tax_amount * v_goods / v_receipt_goods)
                ELSE 0 END;

  UPDATE purchasing.purchase_return
     SET goods_amount = v_goods,
         cost_amount  = v_cost,
         tax_amount   = v_tax,
         charge_loss  = v_cost - v_goods,
         status       = 'posted',
         posted_at    = now()
   WHERE id = p_return;

  v_entry := ledger.post_entry(
    'purchase_return', r.branch_id, platform.business_date(r.occurred_at),
    'برگشت از خرید ' || r.number,
    jsonb_build_array(
      jsonb_build_object('leg','payable',   'amount', v_goods + v_tax,
                         'party_type','supplier', 'party_id', rc.supplier_id),
      jsonb_build_object('leg','input_tax', 'amount', v_tax),
      jsonb_build_object('leg','inventory', 'amount', v_cost),
      -- هزینه حملِ کالای پس‌فرستاده: پرداختیم و برنمی‌گردد.
      -- علامت‌دار است، پس اگر روزی بهای دفتری کمتر از بهای فاکتور
      -- باشد، همین سطر برعکس می‌شود.
      jsonb_build_object('leg','charge_loss','amount', v_cost - v_goods)),
    'purchase_return', p_return, p_user);

  PERFORM platform.audit('purchase.return', 'purchase_return', p_return::text,
    jsonb_build_object('number', r.number, 'receipt', r.receipt_id,
                       'goods', v_goods, 'cost', v_cost, 'tax', v_tax,
                       'charge_loss', v_cost - v_goods, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $function$;

-- ── purchasing.send_purchase_order ──
CREATE OR REPLACE FUNCTION purchasing.send_purchase_order(p_order uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  o    purchasing.purchase_order%ROWTYPE;
  v_fy smallint;
  v_n  int;
BEGIN
  SELECT * INTO o FROM purchasing.purchase_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش خرید یافت نشد'; END IF;
  IF o.status <> 'draft' THEN
    RAISE EXCEPTION 'سفارش % قبلاً فرستاده شده است', coalesce(o.number, '(بی‌شماره)');
  END IF;

  SELECT count(*) INTO v_n FROM purchasing.purchase_order_line WHERE order_id = p_order;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'سفارش بدون قلم فرستادنی نیست';
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE platform.business_date(o.created_at) BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(o.created_at);
  END IF;

  o.number := platform.next_document_no(o.branch_id, 'purchase_order', v_fy);

  UPDATE purchasing.purchase_order
     SET number = o.number, status = 'sent', sent_at = now()
   WHERE id = p_order;

  -- ⚠️ هیچ `ledger.post_entry()` و هیچ `apply_movement()` اینجا نیست،
  --    و نباید باشد. سفارش یک تعهد است، نه یک رویداد مالی.
  PERFORM platform.audit('purchase.order_sent', 'purchase_order', p_order::text,
    jsonb_build_object('number', o.number, 'supplier', o.supplier_id, 'lines', v_n),
    p_user);

  RETURN o.number;
END $function$;

-- ── inventory.post_stock_count ──
CREATE OR REPLACE FUNCTION inventory.post_stock_count(p_count uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  c            inventory.stock_count%ROWTYPE;
  v_line       record;
  v_fy         smallint;
  v_system     platform.qty;
  v_value      platform.money;
  v_diff       platform.qty;
  v_cost       platform.money;
  v_res        inventory.movement_result;
  v_total      platform.money := 0;   -- جمع تغییر ارزش (منفی = کسری)
  v_lines      int := 0;
  v_adjusted   int := 0;
  v_entry      uuid;
BEGIN
  SELECT * INTO c FROM inventory.stock_count WHERE id = p_count FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگه انبارگردانی یافت نشد'; END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'برگه انبارگردانی % قبلاً ثبت شده است', coalesce(c.number, '(بی‌شماره)');
  END IF;

  SELECT count(*) INTO v_lines FROM inventory.stock_count_line WHERE count_id = p_count;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'برگه انبارگردانی بدون سطر قابل ثبت نیست';
  END IF;

  -- شماره در همین لحظه، روی سطر قفل‌شده.
  IF c.number IS NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year
     WHERE platform.business_date(c.started_at) BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(c.started_at);
    END IF;
    c.number := platform.next_document_no(c.branch_id, 'stock_count', v_fy);
    UPDATE inventory.stock_count SET number = c.number WHERE id = p_count;
  END IF;

  FOR v_line IN
    SELECT id, variation_id, counted_qty
      FROM inventory.stock_count_line WHERE count_id = p_count ORDER BY id
  LOOP
    -- موجودی سیستم **همین حالا** خوانده می‌شود، نه هنگام ورود سطر.
    -- قفل تا پایان تراکنش نگه داشته می‌شود، پس فروشی که هم‌زمان
    -- تلاش کند نمی‌تواند میان خواندن و تعدیل جا بیفتد.
    SELECT on_hand, total_value INTO v_system, v_value
      FROM inventory.stock_balance
     WHERE variation_id = v_line.variation_id AND warehouse_id = c.warehouse_id
       FOR UPDATE;

    IF NOT FOUND THEN
      v_system := 0;
      v_value  := 0;
    END IF;

    v_diff := v_line.counted_qty - v_system;

    IF v_diff = 0 THEN
      UPDATE inventory.stock_count_line
         SET system_qty = v_system, diff_qty = 0, unit_cost = NULL, value_delta = 0
       WHERE id = v_line.id;
      CONTINUE;
    END IF;

    -- بهای واحد برای **اضافه** اجباری است (apply_movement بدون آن
    -- خطا می‌دهد) و باید نرخ همان کالا باشد، نه یک عدد دلخواه:
    -- کالایی که در شمارش پیدا می‌شود همان کالاست، نه خریدی تازه.
    --
    --   موجودی دارد  → میانگین جاری
    --   موجودی ندارد → نرخ آخرین ورودِ همان کالا در همان انبار
    --
    -- اگر هیچ‌کدام نبود، صفر می‌ماند و در سطر دیده می‌شود؛ حدس‌زدن یک
    -- نرخ، ارزش موجودی را با عددی می‌سازد که پشتش هیچ سندی نیست.
    IF v_diff > 0 THEN
      IF v_system > 0 THEN
        v_cost := round(v_value / v_system);
      ELSE
        SELECT unit_cost INTO v_cost
          FROM inventory.stock_movement
         WHERE variation_id = v_line.variation_id
           AND warehouse_id = c.warehouse_id
           AND qty > 0
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1;
        v_cost := coalesce(v_cost, 0);
      END IF;
    ELSE
      -- کسری: نرخ را خودِ apply_movement تعیین می‌کند (میانگین یا
      -- FIFO، بسته به روش). دوباره‌نویسی‌اش اینجا یعنی دو تعریف.
      v_cost := NULL;
    END IF;

    v_res := inventory.apply_movement(
      v_line.variation_id, c.warehouse_id, v_diff,
      'count_adjust', 'stock_count', p_count, p_user,
      v_cost, false, now(),
      'انبارگردانی ' || c.number);

    v_total    := v_total + v_res.value_delta;
    v_adjusted := v_adjusted + 1;

    UPDATE inventory.stock_count_line
       SET system_qty  = v_system,
           diff_qty    = v_diff,
           unit_cost   = v_res.unit_cost,
           value_delta = v_res.value_delta
     WHERE id = v_line.id;
  END LOOP;

  UPDATE inventory.stock_count
     SET status = 'posted', posted_at = now()
   WHERE id = p_count;

  -- سند فقط وقتی ساخته می‌شود که ارزش کل عوض شده باشد. کسری و
  -- اضافه‌ای که هم را خنثی کنند، سند نمی‌خواهند — ولی حرکتشان در
  -- stock_movement هست و از آنجا پیگیری می‌شود.
  IF v_total <> 0 THEN
    v_entry := ledger.post_entry(
      'stock_shortage', c.branch_id, platform.business_date(),
      'انبارگردانی ' || c.number,
      jsonb_build_array(
        jsonb_build_object('leg', 'expense',   'amount', -v_total),
        jsonb_build_object('leg', 'inventory', 'amount', -v_total)),
      'stock_count', p_count, p_user);
  END IF;

  PERFORM platform.audit('stock.count', 'stock_count', p_count::text,
    jsonb_build_object('number', c.number, 'warehouse', c.warehouse_id,
                       'lines', v_lines, 'adjusted', v_adjusted,
                       'value_delta', v_total, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $function$;

-- ── inventory.post_transfer ──
CREATE OR REPLACE FUNCTION inventory.post_transfer(p_transfer uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  t        inventory.transfer%ROWTYPE;
  l        RECORD;
  v_out    inventory.movement_result;
  v_year   smallint;
  v_count  int := 0;
BEGIN
  SELECT * INTO t FROM inventory.transfer WHERE id = p_transfer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'برگه انتقال یافت نشد';
  END IF;
  IF t.status = 'posted' THEN
    RAISE EXCEPTION 'این برگه قبلاً ثبت شده است (شماره %)', t.number;
  END IF;
  IF t.status <> 'draft' THEN
    RAISE EXCEPTION 'برگه در وضعیت «%» ثبت نمی‌شود', t.status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory.transfer_line WHERE transfer_id = p_transfer) THEN
    RAISE EXCEPTION 'برگه انتقال بدون قلم ثبت نمی‌شود';
  END IF;

  PERFORM platform.set_actor(coalesce(p_user, platform.current_actor()));

  FOR l IN
    SELECT * FROM inventory.transfer_line WHERE transfer_id = p_transfer ORDER BY id
  LOOP
    -- خروج از مبدأ: بها را خودِ `apply_movement` تعیین می‌کند — لایه
    -- FIFO یا میانگین جاری همان انبار. موجودی منفی مجاز نیست، پس
    -- انتقال کالایی که نیست، همین‌جا رد می‌شود.
    v_out := inventory.apply_movement(
      l.variation_id, t.from_warehouse_id, -l.qty, 'transfer_out',
      'transfer', p_transfer, p_user);

    -- ورود به مقصد با **همان ارزشی** که از مبدأ خارج شد.
    --
    -- `value_delta` صریح داده می‌شود، نه `qty × unit_cost`: وقتی
    -- انبار مبدأ خالی می‌شود، `apply_movement` باقی‌ماندهٔ گرد کردن را
    -- هم صفر می‌کند و آن‌وقت این دو عدد یکی نیستند. اگر ضرب دوباره
    -- حساب می‌شد، همان چند ریال از جمع ارزش موجودی گم می‌شد.
    PERFORM inventory.apply_movement(
      l.variation_id, t.to_warehouse_id, l.qty, 'transfer_in',
      'transfer', p_transfer, p_user,
      p_unit_cost   => v_out.unit_cost,
      p_value_delta => -v_out.value_delta);

    UPDATE inventory.transfer_line
       SET unit_cost = v_out.unit_cost, value_delta = -v_out.value_delta
     WHERE id = l.id;

    v_count := v_count + 1;
  END LOOP;

  SELECT id INTO v_year FROM ledger.fiscal_year
   WHERE platform.business_date(t.occurred_at) BETWEEN starts_on AND ends_on;
  IF v_year IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(t.occurred_at);
  END IF;

  UPDATE inventory.transfer
     SET status    = 'posted',
         number    = platform.next_document_no(t.branch_id, 'transfer', v_year),
         posted_at = now(),
         posted_by = p_user
   WHERE id = p_transfer;

  PERFORM platform.audit('stock.transfer', 'transfer', p_transfer::text,
    jsonb_build_object(
      'from', t.from_warehouse_id, 'to', t.to_warehouse_id,
      'lines', v_count),
    p_user, t.note);

  RETURN v_count;
END $function$;

-- ── treasury.post_transaction ──
CREATE OR REPLACE FUNCTION treasury.post_transaction(p_tx uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  t        treasury.transaction%ROWTYPE;
  v_from   text;
  v_to     text;
  v_legs   jsonb;
  v_event  text;
  v_entry  uuid;
  v_fy     smallint;
  v_no     text;
BEGIN
  SELECT * INTO t FROM treasury.transaction WHERE id = p_tx FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'تراکنش خزانه یافت نشد'; END IF;
  IF t.status = 'posted'    THEN RETURN t.entry_id; END IF;      -- Idempotent
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'تراکنش خزانه باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT ledger_account_code INTO v_from FROM treasury.account WHERE id = t.from_account_id;
  SELECT ledger_account_code INTO v_to   FROM treasury.account WHERE id = t.to_account_id;

  IF t.purpose = 'transfer' THEN
    v_event := 'treasury_transfer';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','to_account',  'amount', t.amount, 'account_code', v_to),
      jsonb_build_object('leg','from_account','amount', t.amount, 'account_code', v_from));

  ELSIF t.purpose = 'supplier_payment' THEN
    v_event := 'supplier_payment';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','payable','amount', t.amount,
                         'party_type','supplier','party_id', t.party_id),
      jsonb_build_object('leg','from_account','amount', t.amount, 'account_code', v_from));

  ELSIF t.purpose = 'customer_receipt' THEN
    v_event := 'customer_receipt';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','to_account','amount', t.amount, 'account_code', v_to),
      jsonb_build_object('leg','receivable','amount', t.amount,
                         'party_type','customer','party_id', t.party_id));

  ELSIF t.purpose = 'expense' THEN
    v_event := 'expense_payment';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','expense','amount', t.amount,
                         'account_code', t.expense_account_code,
                         'party_type', t.party_type, 'party_id', t.party_id),
      jsonb_build_object('leg','from_account','amount', t.amount, 'account_code', v_from));

  ELSE  -- capital
    v_event := 'capital_injection';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','to_account','amount', t.amount, 'account_code', v_to),
      jsonb_build_object('leg','equity','amount', t.amount));
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE platform.business_date(t.occurred_at) BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(t.occurred_at);
  END IF;
  v_no := platform.next_document_no(t.branch_id, 'treasury', v_fy);

  v_entry := ledger.post_entry(
    v_event, t.branch_id, platform.business_date(t.occurred_at),
    'تراکنش خزانه ' || v_no || coalesce(' — ' || t.note, ''),
    v_legs, 'treasury_transaction', p_tx, p_user);

  UPDATE treasury.transaction
     SET number = v_no, status = 'posted', entry_id = v_entry
   WHERE id = p_tx;

  PERFORM platform.audit('treasury.post', 'treasury_transaction', p_tx::text,
    jsonb_build_object('number', v_no, 'purpose', t.purpose,
                       'amount', t.amount, 'entry', v_entry),
    p_user, t.note);

  RETURN v_entry;
END $function$;

-- ── treasury.post_settlement ──
CREATE OR REPLACE FUNCTION treasury.post_settlement(p_settlement uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  s        treasury.settlement%ROWTYPE;
  src      treasury.account%ROWTYPE;
  bank     treasury.account%ROWTYPE;
  v_gross  platform.money := 0;
  v_fee    platform.money := 0;
  v_net    platform.money := 0;
  v_count  int := 0;
  v_entry  uuid;
  v_fy     smallint;
  v_no     text;
BEGIN
  SELECT * INTO s FROM treasury.settlement WHERE id = p_settlement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ تسویه یافت نشد'; END IF;
  IF s.status = 'posted'    THEN RETURN s.entry_id; END IF;      -- Idempotent
  IF s.status = 'cancelled' THEN RAISE EXCEPTION 'برگ تسویه باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT * INTO src  FROM treasury.account WHERE id = s.source_account_id;
  SELECT * INTO bank FROM treasury.account WHERE id = s.bank_account_id;

  IF src.kind NOT IN ('card_terminal','gateway') THEN
    RAISE EXCEPTION 'تسویه فقط از کارت‌خوان یا درگاه انجام می‌شود (حساب %: %)', src.code, src.kind;
  END IF;
  IF bank.kind <> 'bank' THEN
    RAISE EXCEPTION 'مقصد تسویه باید حساب بانکی باشد (حساب %: %)', bank.code, bank.kind;
  END IF;

  -- فقط پرداخت‌های موفقِ تسویه‌نشده‌ی همان دستگاه در همان بازه
  SELECT coalesce(sum(amount),0), count(*) INTO v_gross, v_count
    FROM treasury.payment
   WHERE account_id = s.source_account_id
     AND direction = 'in'
     AND status = 'succeeded'
     AND settlement_id IS NULL
     AND platform.business_date(occurred_at) BETWEEN s.period_from AND s.period_to;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'هیچ پرداخت تسویه‌نشده‌ای برای % در بازه % تا % یافت نشد',
      src.code, s.period_from, s.period_to;
  END IF;

  IF s.bank_reported_amount IS NOT NULL THEN
    v_net := s.bank_reported_amount;
    v_fee := v_gross - v_net;
    IF v_fee < 0 THEN
      RAISE EXCEPTION
        'مبلغ واریزشده بانک (%) از جمع تراکنش‌ها (%) بیشتر است. مغایرت باید بررسی شود.',
        s.bank_reported_amount, v_gross;
    END IF;
  ELSE
    v_fee := round(v_gross * src.fee_percent / 100);
    v_net := v_gross - v_fee;
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE platform.business_date(s.occurred_at) BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(s.occurred_at);
  END IF;
  v_no := platform.next_document_no(s.branch_id, 'settlement', v_fy);

  v_entry := ledger.post_entry(
    'settlement', s.branch_id, platform.business_date(s.occurred_at),
    'تسویه ' || src.name || ' — ' || v_no,
    jsonb_build_array(
      jsonb_build_object('leg','bank','amount', v_net,   'account_code', bank.ledger_account_code),
      jsonb_build_object('leg','fee', 'amount', v_fee),
      jsonb_build_object('leg','clearing','amount', v_gross, 'account_code', src.ledger_account_code)),
    'treasury_settlement', p_settlement, p_user);

  UPDATE treasury.payment
     SET status = 'settled', settled_at = s.occurred_at, settlement_id = p_settlement
   WHERE account_id = s.source_account_id
     AND direction = 'in'
     AND status = 'succeeded'
     AND settlement_id IS NULL
     AND platform.business_date(occurred_at) BETWEEN s.period_from AND s.period_to;

  UPDATE treasury.settlement
     SET number = v_no, gross_amount = v_gross, fee_amount = v_fee,
         net_amount = v_net, status = 'posted', entry_id = v_entry
   WHERE id = p_settlement;

  PERFORM platform.audit('settlement.post', 'treasury_settlement', p_settlement::text,
    jsonb_build_object('number', v_no, 'source', src.code, 'bank', bank.code,
                       'gross', v_gross, 'fee', v_fee, 'net', v_net, 'payments', v_count),
    p_user, s.note);

  RETURN v_entry;
END $function$;

COMMIT;
