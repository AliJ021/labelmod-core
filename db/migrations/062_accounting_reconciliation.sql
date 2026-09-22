-- اصلاح یافته‌های مالی آزمون زنده؛ اسناد تاریخی بازنویسی نمی‌شوند.
BEGIN;
-- ایجاد و قفل سطر موجودی فقط از دروازه مالک؛ نقش برنامه حق نوشتن مستقیم ندارد.
CREATE OR REPLACE FUNCTION inventory.lock_stock(p_variation uuid,p_warehouse uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,public,inventory AS $$
BEGIN
  INSERT INTO inventory.stock_balance(variation_id,warehouse_id)
    VALUES(p_variation,p_warehouse) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM inventory.stock_balance WHERE variation_id=p_variation
    AND warehouse_id=p_warehouse FOR UPDATE;
END $$;
ALTER TABLE sales.sale_return ADD COLUMN shipping_amount platform.money NOT NULL DEFAULT 0 CHECK(shipping_amount>=0);
INSERT INTO ledger.posting_rule(event_type,leg,side,account_code,description,sort_order)
SELECT 'sale_return','shipping_return','debit',account_code,'برگشت کرایه ارسال',8
FROM ledger.posting_rule WHERE event_type='sale_shift' AND leg='shipping' AND is_active
ON CONFLICT(event_type,leg,side) DO NOTHING;


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
  v_customer sales.customer%ROWTYPE;
  v_due platform.money;
  v_existing_due platform.money;
  v_change platform.money;
  v_cash platform.money;
  v_cash_method text;
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

  -- قفل مشتری همه فروش‌های هم‌زمان او را، حتی در شیفت باز، مرتب می‌کند.
  IF inv.customer_id IS NOT NULL THEN
    SELECT * INTO v_customer FROM sales.customer WHERE id = inv.customer_id FOR UPDATE;
  END IF;
  SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0)
    INTO v_paid FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
   WHERE p.invoice_id=p_invoice AND m.kind<>'credit' AND p.status IN ('succeeded','settled','reconciled');
  v_due := greatest(v_net + v_tax + inv.shipping_amount - v_paid, 0);
  IF v_due > 0 THEN
    IF inv.customer_id IS NULL THEN RAISE EXCEPTION 'فروش نسیه بدون مشتری مجاز نیست'; END IF;
    IF v_customer.status='blocked' THEN RAISE EXCEPTION 'فروش نسیه به مشتری مسدود مجاز نیست'; END IF;
    -- Ledger and unposted exposure must share a statement snapshot: posting
    -- a batch between two separate reads would temporarily omit that debt.
    SELECT (SELECT coalesce(sum(l.debit-l.credit),0) FROM ledger.journal_line l
       WHERE l.account_code IN (SELECT account_code FROM ledger.posting_rule
         WHERE event_type='sale_shift' AND leg='receivable' AND is_active)
         AND l.party_type='customer' AND l.party_id=inv.customer_id)
      -- مرجوعی قبلاً در دفتر بستانکار شده؛ کسر دوباره‌اش از فروش ثبت‌نشده، اعتبار کاذب می‌سازد.
      + coalesce(sum(greatest(i.payable_amount-i.paid_amount,0)),0)
      INTO v_existing_due
      FROM sales.invoice i JOIN ledger.posting_batch b ON b.id=i.posting_batch_id
      WHERE i.customer_id=inv.customer_id AND i.id<>inv.id AND b.status<>'posted'
        AND i.status IN ('finalized','paid','partially_returned','returned');
    IF greatest(v_existing_due,0)+v_due > v_customer.credit_limit THEN
      RAISE EXCEPTION 'سقف اعتبار مشتری کافی نیست: مانده %، فروش %، سقف %', v_existing_due,v_due,v_customer.credit_limit;
    END IF;
  END IF;
  v_change := greatest(v_paid-(v_net+v_tax+inv.shipping_amount),0);
  IF v_change > 0 THEN
    SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0), min(p.method_code)
      INTO v_cash,v_cash_method FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
     WHERE p.invoice_id=p_invoice AND m.kind='cash' AND p.status IN ('succeeded','settled','reconciled');
    IF v_change>v_cash THEN RAISE EXCEPTION 'اضافه‌پرداخت غیرنقدی باید پیش از نهایی‌سازی بررسی شود'; END IF;
    INSERT INTO treasury.payment(invoice_id,shift_id,method_code,direction,amount,status,note,occurred_at)
    VALUES(p_invoice,inv.shift_id,v_cash_method,'out',v_change,'succeeded','باقی پول فروش',inv.occurred_at);
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
  SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0) INTO v_paid
    FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
   WHERE p.invoice_id=p_invoice AND m.kind<>'credit'
     AND p.status IN ('succeeded','settled','reconciled');

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

CREATE OR REPLACE FUNCTION sales.post_batch(
  p_batch uuid, p_user uuid DEFAULT NULL
) RETURNS TABLE (sale_entry uuid, cogs_entry uuid)
LANGUAGE plpgsql AS $$
DECLARE
  b          ledger.posting_batch%ROWTYPE;
  v_gross    platform.money := 0;
  v_disc     platform.money := 0;
  v_tax      platform.money := 0;
  v_cogs     platform.money := 0;
  v_shipping platform.money := 0;
  v_payable  platform.money := 0;
  v_pay_legs  jsonb := '[]'::jsonb;
  v_recv_legs jsonb := '[]'::jsonb;
  v_legs     jsonb;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_label    text;
  v_orphan   int;
BEGIN
  SELECT * INTO b FROM ledger.posting_batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'دوره ثبت یافت نشد'; END IF;

  IF b.status = 'posted' THEN
    RETURN QUERY SELECT b.sale_entry_id, b.cogs_entry_id;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM sales.invoice
              WHERE posting_batch_id = p_batch
                AND status IN ('draft','confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'دوره ثبت با فاکتور نهایی‌نشده بسته نمی‌شود';
  END IF;

  SELECT coalesce(sum(gross_amount),0),    coalesce(sum(discount_amount),0),
         coalesce(sum(tax_amount),0),      coalesce(sum(cogs_amount),0),
         coalesce(sum(shipping_amount),0), coalesce(sum(payable_amount),0)
    INTO v_gross, v_disc, v_tax, v_cogs, v_shipping, v_payable
    FROM sales.invoice
   WHERE posting_batch_id = p_batch
     AND status IN ('finalized','paid','partially_returned','returned');

  -- امتیاز و کارت هدیه بدهی ما به مشتری‌اند؛ بدون شناسه مشتری قابل
  -- کاهش نیستند.
  SELECT count(*) INTO v_orphan
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
    JOIN sales.invoice i ON i.id = p.invoice_id
   WHERE i.posting_batch_id = p_batch AND p.direction = 'in'
     AND m.kind IN ('points','gift_card') AND i.customer_id IS NULL;
  IF v_orphan > 0 THEN
    RAISE EXCEPTION 'پرداخت با امتیاز یا کارت هدیه روی فاکتور بدون مشتری مجاز نیست (% فاکتور)', v_orphan;
  END IF;

  -- مؤلفه‌های پرداخت: مقصد از kind روش پرداخت می‌آید، نه از یک leg کلی.
  -- وضعیت بر نوع اولویت دارد: تراکنش نامشخص هرچه باشد، پول نیست.
  WITH counted AS (
    SELECT i.customer_id,
           CASE
             WHEN p.status IN ('pending','unknown') THEN 'unknown_clearing'
             WHEN m.kind = 'cash'        THEN 'cash'
             WHEN m.kind = 'card_reader' THEN 'card_clearing'
             WHEN m.kind = 'gateway'     THEN 'gateway_clearing'
             WHEN m.kind = 'transfer'    THEN 'p2p_clearing'
             WHEN m.kind = 'points'      THEN 'points_redeem'
             WHEN m.kind = 'gift_card'   THEN 'giftcard_redeem'
           END AS leg,
           CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END AS amount
      FROM treasury.payment p
      JOIN treasury.payment_method m ON m.code = p.method_code
      JOIN sales.invoice i ON i.id = p.invoice_id
     WHERE i.posting_batch_id = p_batch
       AND m.kind <> 'credit'
       AND p.status IN ('succeeded','settled','reconciled','pending','unknown')
  ), grouped AS (
    SELECT leg,
           CASE WHEN leg IN ('points_redeem','giftcard_redeem') THEN customer_id END AS party,
           sum(amount) AS amt
      FROM counted GROUP BY 1, 2
  )
  SELECT coalesce(jsonb_agg(
           CASE WHEN party IS NOT NULL
                THEN jsonb_build_object('leg', leg, 'amount', amt,
                                        'party_type','customer','party_id', party)
                ELSE jsonb_build_object('leg', leg, 'amount', amt) END), '[]'::jsonb)
    INTO v_pay_legs FROM grouped;

  -- دریافتنی به تفکیک مشتری. سطر تجمیعی بدون شخص، گردش حساب اشخاص را
  -- غیرقابل ساخت می‌کرد.
  WITH per_invoice AS (
    SELECT i.customer_id,
           i.payable_amount - coalesce((
             SELECT sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END) FROM treasury.payment p
               JOIN treasury.payment_method m ON m.code = p.method_code
              WHERE p.invoice_id = i.id
                AND m.kind <> 'credit'
                AND p.status IN ('succeeded','settled','reconciled','pending','unknown')
           ), 0) AS due
      FROM sales.invoice i
     WHERE i.posting_batch_id = p_batch
       AND i.status IN ('finalized','paid','partially_returned','returned')
  ), per_customer AS (
    SELECT customer_id, sum(due) AS amt FROM per_invoice
     GROUP BY customer_id HAVING sum(due) <> 0
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'leg','receivable', 'amount', amt,
           'party_type','customer', 'party_id', customer_id)), '[]'::jsonb),
         count(*) FILTER (WHERE customer_id IS NULL)
    INTO v_recv_legs, v_orphan
    FROM per_customer;

  IF v_orphan > 0 THEN
    RAISE EXCEPTION
      'فروش ناشناس نمی‌تواند نسیه بماند: % فاکتور بدون مشتری، مبلغ پرداخت‌نشده دارد.', v_orphan;
  END IF;

  v_label := CASE b.kind
               WHEN 'shift' THEN 'شیفت صندوق ' || to_char(b.business_date, 'YYYY-MM-DD')
               ELSE 'کانال ' || b.channel || ' — ' || to_char(b.business_date, 'YYYY-MM-DD')
             END;

  IF v_gross > 0 THEN
    v_legs := jsonb_build_array(
                jsonb_build_object('leg','discount','amount', v_disc),
                jsonb_build_object('leg','sales',   'amount', v_gross),
                jsonb_build_object('leg','shipping','amount', v_shipping),
                jsonb_build_object('leg','tax',     'amount', v_tax))
              || v_pay_legs || v_recv_legs;

    v_sale := ledger.post_entry(
      'sale_shift', b.branch_id, b.business_date,
      'فروش — ' || v_label, v_legs, 'posting_batch', p_batch, p_user);
  END IF;

  IF v_cogs > 0 THEN
    v_cogs_e := ledger.post_entry(
      'shift_cogs', b.branch_id, b.business_date,
      'بهای تمام‌شده کالای فروش‌رفته — ' || v_label,
      jsonb_build_array(
        jsonb_build_object('leg','cogs',     'amount', v_cogs),
        jsonb_build_object('leg','inventory','amount', v_cogs)),
      'posting_batch', p_batch, p_user);
  END IF;

  UPDATE ledger.posting_batch
     SET status = 'posted', sale_entry_id = v_sale, cogs_entry_id = v_cogs_e,
         posted_at = now(), posted_by = p_user
   WHERE id = p_batch;

  PERFORM platform.audit('batch.post', 'posting_batch', p_batch::text,
    jsonb_build_object('kind', b.kind, 'date', b.business_date,
                       'gross', v_gross, 'cogs', v_cogs,
                       'payment_legs', v_pay_legs, 'receivable_legs', v_recv_legs),
    p_user);

  RETURN QUERY SELECT v_sale, v_cogs_e;
END $$;

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
  v_refund_account text;
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
    -- Cumulative rounding allocates each part once, even when an earlier
    -- return was not restocked (its cost remains an expense).
    v_line_cogs := round(v_line.sold_cogs*(v_line.returned_qty+v_line.qty)/v_line.sold_qty)
                   - round(v_line.sold_cogs*v_line.returned_qty/v_line.sold_qty);

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
           net_amount  = round(v_line.net_amount*(v_line.returned_qty+v_line.qty)/v_line.sold_qty)-coalesce((
             SELECT sum(x.net_amount) FROM sales.sale_return_line x JOIN sales.sale_return y ON y.id=x.return_id
              WHERE x.invoice_line_id=v_line.invoice_line_id AND y.status='posted'),0),
           tax_amount  = round(v_line.tax_amount*(v_line.returned_qty+v_line.qty)/v_line.sold_qty)-coalesce((
             SELECT sum(x.tax_amount) FROM sales.sale_return_line x JOIN sales.sale_return y ON y.id=x.return_id
              WHERE x.invoice_line_id=v_line.invoice_line_id AND y.status='posted'),0),
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

  IF r.shipping_amount+coalesce((SELECT sum(shipping_amount) FROM sales.sale_return
       WHERE invoice_id=inv.id AND status='posted'),0)>inv.shipping_amount THEN
    RAISE EXCEPTION 'کرایه برگشتی بیش از کرایه همان فاکتور است';
  END IF;
  v_credit_total := v_net + v_tax + r.shipping_amount;

  -- پول واقعاً دریافت‌شده بابت این فاکتور. «نامشخص» پول نیست.
  SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0) INTO v_received
    FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
   WHERE p.invoice_id=inv.id AND m.kind<>'credit'
     AND p.status IN ('succeeded','settled','reconciled');

  SELECT coalesce(sum(refund_amount),0),
         coalesce(sum(net_amount + tax_amount + shipping_amount),0)
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

  IF r.refund_amount>0 THEN
    SELECT pr.account_code INTO v_refund_account FROM treasury.payment_method m
      JOIN ledger.posting_rule pr ON pr.event_type='sale_shift' AND pr.leg=CASE m.kind
        WHEN 'cash' THEN 'cash' WHEN 'card_reader' THEN 'card_clearing'
        WHEN 'gateway' THEN 'gateway_clearing' WHEN 'transfer' THEN 'p2p_clearing' END
     WHERE m.code=coalesce(r.refund_method,'cash');
    IF v_refund_account IS NULL THEN RAISE EXCEPTION 'روش بازپرداخت وجه پشتیبانی نمی‌شود'; END IF;
  END IF;
  PERFORM ledger.post_entry(
    'sale_return', r.branch_id, platform.business_date(r.occurred_at),
    'برگشت از فروش ' || v_no || ' — فاکتور ' || inv.number,
    jsonb_build_array(
      jsonb_build_object('leg','sales_return',   'amount', v_net),
      jsonb_build_object('leg','shipping_return','amount',r.shipping_amount),
      jsonb_build_object('leg','tax',            'amount', v_tax),
      jsonb_build_object('leg','refund_cash', 'amount', r.refund_amount, 'account_code',coalesce(v_refund_account,'1101')),
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
    SELECT variation_id, qty, landed_unit_cost, line_amount, charge_alloc
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt
  LOOP
    -- Revalue existing stock only. Revaluing the incoming line would replace
    -- its exact extended cost with rounded unit cost * quantity, losing rials.
    PERFORM inventory.lock_stock(v_line.variation_id,r.warehouse_id);
    IF v_last_cost THEN
      v_reval := v_reval + inventory.revalue_to_cost(
        v_line.variation_id, r.warehouse_id, v_line.landed_unit_cost,
        p_user, 'purchase_receipt', p_receipt, r.occurred_at,
        'تجدید ارزیابی به نرخ رسید ' || r.number);
    END IF;
    PERFORM inventory.apply_movement(
      v_line.variation_id, r.warehouse_id, v_line.qty,
      'purchase_receipt', 'purchase_receipt', p_receipt, p_user,
      v_line.landed_unit_cost, false, r.occurred_at, NULL, v_line.line_amount+v_line.charge_alloc);
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
           rl.unit_price, rl.landed_unit_cost, rl.line_amount, rl.charge_alloc, rl.qty AS received_qty, rl.returned_qty
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
    IF v_line.returned_qty+v_line.qty=v_line.received_qty THEN
      SELECT v_line.line_amount+v_line.charge_alloc-coalesce(sum(x.cost_amount),0)
        INTO v_line_cost FROM purchasing.purchase_return_line x JOIN purchasing.purchase_return y ON y.id=x.return_id
       WHERE x.receipt_line_id=v_line.receipt_line_id AND y.status='posted';
    ELSE
      v_line_cost := round((v_line.line_amount+v_line.charge_alloc)*v_line.qty/v_line.received_qty);
    END IF;

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
                THEN round(rc.tax_amount * (v_goods+coalesce((SELECT sum(goods_amount) FROM purchasing.purchase_return
                       WHERE receipt_id=rc.id AND status='posted'),0)) / v_receipt_goods)
                     - coalesce((SELECT sum(tax_amount) FROM purchasing.purchase_return WHERE receipt_id=rc.id AND status='posted'),0)
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
  v_payments uuid[];
BEGIN
  SELECT * INTO s FROM treasury.settlement WHERE id = p_settlement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ تسویه یافت نشد'; END IF;
  IF s.status = 'posted'    THEN RETURN s.entry_id; END IF;      -- Idempotent
  IF s.status = 'cancelled' THEN RAISE EXCEPTION 'برگ تسویه باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT * INTO src  FROM treasury.account WHERE id = s.source_account_id FOR UPDATE;
  SELECT * INTO bank FROM treasury.account WHERE id = s.bank_account_id;

  IF src.kind NOT IN ('card_terminal','gateway') THEN
    RAISE EXCEPTION 'تسویه فقط از کارت‌خوان یا درگاه انجام می‌شود (حساب %: %)', src.code, src.kind;
  END IF;
  IF bank.kind <> 'bank' THEN
    RAISE EXCEPTION 'مقصد تسویه باید حساب بانکی باشد (حساب %: %)', bank.code, bank.kind;
  END IF;

  SELECT array_agg(id) INTO v_payments FROM (SELECT id FROM treasury.payment
    WHERE account_id=s.source_account_id AND direction='in' AND status='succeeded'
      AND settlement_id IS NULL AND platform.business_date(occurred_at) BETWEEN s.period_from AND s.period_to
    ORDER BY id FOR UPDATE) locked;
  -- فقط همان پرداخت‌های قفل‌شده؛ ورود پرداخت تازه میان جمع و UPDATE وارد این سند نمی‌شود.
  -- فقط پرداخت‌های موفقِ تسویه‌نشده‌ی همان دستگاه در همان بازه
  SELECT coalesce(sum(amount),0), count(*) INTO v_gross, v_count
    FROM treasury.payment
   WHERE id = ANY(v_payments) AND account_id = s.source_account_id
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
   WHERE id = ANY(v_payments) AND account_id = s.source_account_id
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
