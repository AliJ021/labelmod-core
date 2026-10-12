BEGIN;

-- شمارهٔ نمایشی جدید بدون بازنویسی فاکتور، حسابرسی یا پیام تاریخی.
-- قفل مهاجرت با نهایی‌سازی هم‌زمان مرتب می‌شود؛ پیش از استقرار پنجرهٔ مناسب لازم است.
LOCK TABLE sales.invoice IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE sales.invoice_number (
  invoice_id uuid PRIMARY KEY REFERENCES sales.invoice(id),
  number text NOT NULL UNIQUE CHECK (number ~ '^[1-9][0-9]*$' AND length(number)<=64)
);
CREATE TABLE sales.invoice_number_counter (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_value numeric NOT NULL CHECK (last_value>=0 AND last_value=trunc(last_value))
);
-- عبور از تمام شماره‌های عددی قدیمی، حتی عددهای بزرگ‌تر از bigint.
INSERT INTO sales.invoice_number_counter(last_value)
SELECT coalesce(max(number::numeric),0) FROM sales.invoice WHERE number ~ '^[0-9]+$';
INSERT INTO sales.invoice_number(invoice_id,number)
SELECT id, ((SELECT last_value FROM sales.invoice_number_counter)+row_number() OVER (ORDER BY occurred_at,id))::text
FROM sales.invoice WHERE number IS NOT NULL;
UPDATE sales.invoice_number_counter SET last_value=coalesce((SELECT max(number::numeric) FROM sales.invoice_number),last_value);

CREATE FUNCTION sales.invoice_display_number(p_invoice uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT number FROM sales.invoice_number WHERE invoice_id=p_invoice
$$;

CREATE FUNCTION sales.invoice_number_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'شمارهٔ قطعی فاکتور تغییرپذیر نیست';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON sales.invoice_number
FOR EACH ROW EXECUTE FUNCTION sales.invoice_number_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON sales.invoice_number
FOR EACH STATEMENT EXECUTE FUNCTION sales.invoice_number_immutable();

-- فقط هنگام گذار به وضعیت قطعی؛ چاپ پیش‌نویس هیچ شماره‌ای مصرف نمی‌کند.
CREATE FUNCTION sales.assign_invoice_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_number text;
BEGIN
  IF TG_OP='UPDATE' AND OLD.number IS NOT NULL THEN
    IF NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'شمارهٔ قطعی فاکتور تغییرپذیر نیست';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.number IS NULL THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' OR NEW.status<>'finalized' OR OLD.status NOT IN ('draft','confirmed','partially_paid') THEN
    RAISE EXCEPTION 'شمارهٔ فروش فقط هنگام نهایی‌سازی تخصیص می‌یابد';
  END IF;
  UPDATE sales.invoice_number_counter SET last_value=last_value+1 RETURNING last_value::text INTO v_number;
  IF v_number IS NULL OR length(v_number)>64 THEN RAISE EXCEPTION 'ظرفیت شمارهٔ فاکتور پایان یافته است'; END IF;
  INSERT INTO sales.invoice_number(invoice_id,number) VALUES(NEW.id,v_number);
  NEW.number := v_number;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sales.assign_invoice_number() FROM PUBLIC;
CREATE TRIGGER assign_invoice_number BEFORE INSERT OR UPDATE OF number ON sales.invoice
FOR EACH ROW EXECUTE FUNCTION sales.assign_invoice_number();

-- پیش‌فرض‌های نقشِ برنامه ممکن است پیش از مهاجرت برقرار باشند.
-- همان محدودیت پس از GRANTهای عمومی در ops/db-roles.sh نیز اعمال می‌شود.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee FROM information_schema.table_privileges
    WHERE table_schema='sales' AND table_name IN ('invoice_number','invoice_number_counter')
      AND grantee NOT IN (current_user,'PUBLIC')
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sales.invoice_number, sales.invoice_number_counter FROM %I',r.grantee);
  END LOOP;
END $$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sales.invoice_number, sales.invoice_number_counter FROM PUBLIC;
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
  v_transfer numeric;
BEGIN
  SELECT * INTO inv FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;

  -- Idempotency: فراخوانی دوباره همان شماره قبلی را برمی‌گرداند
  IF inv.status IN ('finalized','paid','partially_returned','returned') THEN
    RETURN sales.invoice_display_number(inv.id);
  END IF;
  IF inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'فاکتور باطل‌شده نهایی نمی‌شود';
  END IF;

  -- دوره ثبت پیش از هر اثری تعیین می‌شود: اگر شیفت بسته یا دوره بسته
  -- باشد، باید همین‌جا شکست بخورد، نه بعد از خروج کالا از انبار.
  PERFORM sales.assert_pos_customer(p_invoice);
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
    SELECT * INTO v_customer FROM sales.customer WHERE id = inv.customer_id FOR NO KEY UPDATE;
  END IF;
  SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0)
    INTO v_paid FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
   WHERE p.invoice_id=p_invoice AND m.kind<>'credit' AND p.status IN ('succeeded','settled','reconciled');
  v_transfer := sales.exchange_in(p_invoice);
  v_due := greatest(v_net + v_tax + inv.shipping_amount - v_paid - v_transfer, 0);
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
      + coalesce(sum(greatest(i.payable_amount-i.paid_amount-sales.exchange_in(i.id),0)),0)
      INTO v_existing_due
      FROM sales.invoice i JOIN ledger.posting_batch b ON b.id=i.posting_batch_id
      WHERE i.customer_id=inv.customer_id AND i.id<>inv.id AND b.status<>'posted'
        AND i.status IN ('finalized','paid','partially_returned','returned');
    IF greatest(v_existing_due,0)+v_due > v_customer.credit_limit THEN
      RAISE EXCEPTION 'سقف اعتبار مشتری کافی نیست: مانده %، فروش %، سقف %', v_existing_due,v_due,v_customer.credit_limit;
    END IF;
  END IF;
  v_change := greatest(v_paid+v_transfer-(v_net+v_tax+inv.shipping_amount),0);
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
     WHERE invoice_id = p_invoice ORDER BY variation_id,id
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

  -- شماره در Trigger و همان تراکنش تخصیص می‌یابد.

  UPDATE sales.invoice
     SET number           = '',
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
   WHERE id = p_invoice RETURNING number INTO v_no;

  PERFORM platform.audit('invoice.finalize', 'invoice', p_invoice::text,
    jsonb_build_object('number', v_no, 'payable', v_net + v_tax + inv.shipping_amount,
                       'paid', v_paid, 'cogs', v_cogs, 'batch', v_batch),
    p_user);

  INSERT INTO platform.outbox_message (topic, payload)
  VALUES ('invoice.finalized',
          jsonb_build_object('invoice_id', p_invoice, 'number', v_no));

  RETURN v_no;
END $function$;



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
  v_exchange sales.exchange%ROWTYPE;
  v_transfer numeric := 0;
  v_funds numeric;
BEGIN
  SELECT * INTO r FROM sales.sale_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ مرجوعی یافت نشد'; END IF;
  IF r.status = 'posted' THEN RETURN r.number; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'برگ مرجوعی باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT * INTO inv FROM sales.invoice WHERE id = r.invoice_id FOR UPDATE;
  IF inv.status NOT IN ('finalized','paid','partially_returned') THEN
    RAISE EXCEPTION 'فاکتور % در وضعیت قابل مرجوعی نیست (%)', sales.invoice_display_number(inv.id), inv.status;
  END IF;

  SELECT * INTO v_exchange FROM sales.exchange WHERE return_id=p_return;
  IF r.kind='exchange' AND v_exchange.id IS NULL THEN RAISE EXCEPTION 'تعویض بدون پیوند تسویه ثبت نمی‌شود'; END IF;

  FOR v_line IN
    SELECT rl.id, rl.invoice_line_id, rl.qty, rl.restock, rl.condition,
           il.variation_id, il.unit_cost, il.unit_price, il.qty AS sold_qty,
           il.returned_qty, il.discount_amount, il.tax_amount, il.net_amount,
           il.cogs_amount AS sold_cogs
      FROM sales.sale_return_line rl
      JOIN sales.invoice_line il ON il.id = rl.invoice_line_id
     WHERE rl.return_id = p_return
     ORDER BY il.variation_id,il.id
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
  -- انتقال جاری هنوز در سقف قبلی اثر ندارد؛ انتقال‌های قدیمی از پشتوانه کم شده‌اند.
  v_funds := v_received + sales.exchange_funding(inv.id)
    + coalesce(v_exchange.funded_transfer,0) - v_refunded_before;
  IF r.refund_amount > v_funds THEN
    RAISE EXCEPTION
      'بازپرداخت (%) بیش از مبلغ دریافت‌شده بابت این فاکتور (%) است. پولی که گرفته نشده، پس داده نمی‌شود.',
      r.refund_amount, v_funds;
  END IF;

  -- بدهی باقی‌مانده مشتری بابت این فاکتور، پیش از این مرجوعی:
  --   تعهد (مبلغ فاکتور منهای کالای قبلاً برگشتی) منهای تسویه (دریافتی
  --   منهای بازپرداخت‌های قبلی)
  v_outstanding := inv.payable_amount - v_returned_before - v_received + v_refunded_before
    + sales.exchange_out(inv.id) - coalesce(v_exchange.transfer_amount,0) - sales.exchange_in(inv.id);
  IF v_outstanding < 0 THEN v_outstanding := 0; END IF;

  v_recv        := least(greatest(v_credit_total - r.refund_amount, 0), v_outstanding);
  v_cust_credit := (v_credit_total - r.refund_amount) - v_recv;

  IF v_exchange.id IS NOT NULL THEN
    IF v_exchange.returned_value<>v_credit_total OR v_exchange.refund_amount<>r.refund_amount THEN
      RAISE EXCEPTION 'ارزش مرجوعی با پیش‌نمایش تعویض عوض شده است';
    END IF;
    PERFORM 1 FROM sales.exchange_allocation(v_credit_total,v_exchange.replacement_value,
      v_outstanding,greatest(v_funds,0),v_exchange.policy) a
      WHERE a.debt_applied=v_exchange.debt_applied AND a.transfer_amount=v_exchange.transfer_amount
        AND a.funded_transfer=v_exchange.funded_transfer AND a.refund_amount=v_exchange.refund_amount;
    IF NOT FOUND THEN RAISE EXCEPTION 'تخصیص تعویض با پشتوانه مالی سازگار نیست'; END IF;
    v_recv:=v_exchange.debt_applied; v_cust_credit:=0; v_transfer:=v_exchange.transfer_amount;
  END IF;

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
    'برگشت از فروش ' || v_no || ' — فاکتور ' || sales.invoice_display_number(inv.id),
    jsonb_build_array(
      jsonb_build_object('leg','sales_return',   'amount', v_net),
      jsonb_build_object('leg','shipping_return','amount',r.shipping_amount),
      jsonb_build_object('leg','tax',            'amount', v_tax),
      jsonb_build_object('leg','refund_cash', 'amount', r.refund_amount) || CASE WHEN v_refund_account IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('account_code',v_refund_account) END,
      jsonb_build_object('leg','receivable',     'amount', v_recv,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','customer_credit','amount', v_cust_credit,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','exchange_clearing','amount',v_transfer),
      jsonb_build_object('leg','inventory',      'amount', v_cogs),
      jsonb_build_object('leg','cogs',           'amount', v_cogs)),
    'sale_return', p_return, p_user);

  PERFORM platform.audit('return.post', 'sale_return', p_return::text,
    jsonb_build_object('number', v_no, 'invoice', sales.invoice_display_number(inv.id),
                       'net', v_net, 'tax', v_tax, 'cogs', v_cogs,
                       'refund', r.refund_amount, 'receivable_applied', v_recv,
                       'credit_applied', v_cust_credit),
    p_user, coalesce(r.reason_note, r.reason_code));

  RETURN v_no;
END $function$;


CREATE OR REPLACE VIEW sales.unposted_revenue AS
SELECT i.id AS invoice_id, sales.invoice_display_number(i.id) AS number, i.branch_id, i.channel,
       i.occurred_at, i.payable_amount, i.cogs_amount,
       b.id AS batch_id, b.kind AS batch_kind, b.business_date
FROM sales.invoice i LEFT JOIN ledger.posting_batch b ON b.id=i.posting_batch_id
WHERE i.status IN ('finalized','paid','partially_returned','returned') AND (b.id IS NULL OR b.status<>'posted');
COMMIT;