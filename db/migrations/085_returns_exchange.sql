BEGIN;

-- سیاست بدهی تصمیم مدیر است؛ مقدار خالی فقط تعویض فاکتور بدهکار را متوقف می‌کند.
INSERT INTO identity.permission_rule(role_code,operation,allowed)
SELECT code,'exchange.policy',code='admin' FROM identity.role;
UPDATE platform.setting SET value=value || '["exchange.policy"]'::jsonb
WHERE key='auth.pin_forbidden_operations' AND NOT (value ? 'exchange.policy');
INSERT INTO platform.setting(key,value,description,kind,label,group_key,permission,is_editable,options,help)
VALUES ('exchange.debt_policy','"unset"','تسویه بدهی فاکتور اصلی در تعویض','choice','سیاست بدهی در تعویض','sales','exchange.policy',true,
 '[{"value":"unset","label":"هنوز تعیین نشده"},{"value":"debt_first","label":"ابتدا کاهش بدهی؛ تسویه مانده جایگزین"},{"value":"carry_debt","label":"حفظ بدهی قبلی؛ فقط اختلاف قیمت"}]',
 'ابتدا بدهی: ارزش برگشتی اول بدهی را کم می‌کند، سپس جایگزین را تسویه می‌کند. حفظ بدهی: بدهی قبلی می‌ماند و فقط اختلاف قیمت دریافت/بازپرداخت می‌شود. بازپرداخت بیش از وجه واقعی همیشه ممنوع است.');

CREATE TABLE sales.exchange (
 id uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
 original_invoice_id uuid NOT NULL REFERENCES sales.invoice(id),
 replacement_invoice_id uuid NOT NULL UNIQUE REFERENCES sales.invoice(id),
 return_id uuid NOT NULL UNIQUE REFERENCES sales.sale_return(id),
 actor_id uuid NOT NULL REFERENCES identity.app_user(id),
 policy text NOT NULL CHECK(policy IN ('debt_first','carry_debt')),
 returned_value platform.money NOT NULL CHECK(returned_value>0),
 replacement_value platform.money NOT NULL CHECK(replacement_value>0),
 debt_applied platform.money NOT NULL CHECK(debt_applied>=0),
 transfer_amount platform.money NOT NULL CHECK(transfer_amount>=0),
 funded_transfer platform.money NOT NULL CHECK(funded_transfer BETWEEN 0 AND transfer_amount),
 collect_amount platform.money NOT NULL CHECK(collect_amount>=0),
 refund_amount platform.money NOT NULL CHECK(refund_amount>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(original_invoice_id<>replacement_invoice_id),
 CHECK(returned_value=debt_applied+transfer_amount+refund_amount),
 CHECK(replacement_value=transfer_amount+collect_amount)
);
CREATE INDEX ON sales.exchange(original_invoice_id);

-- حساب واسط از نگاشت موجود خوانده می‌شود، هرگز از شماره حساب ثابت.
-- این leg مستقل از اعتبار مشتری است و خودکار اعتبار عمومی را مصرف نمی‌کند.
INSERT INTO ledger.posting_rule(event_type,leg,side,account_code,description)
SELECT 'sale_return','exchange_clearing','credit',account_code,'انتقال ارزش برگشتی به فاکتور جایگزین'
FROM ledger.posting_rule WHERE event_type='sale_return' AND leg='customer_credit' AND is_active;
INSERT INTO ledger.posting_rule(event_type,leg,side,account_code,description)
SELECT 'sale_shift','exchange_clearing','debit',account_code,'تسویه فاکتور جایگزین با برگ تعویض'
FROM ledger.posting_rule WHERE event_type='sale_return' AND leg='customer_credit' AND is_active;

CREATE FUNCTION sales.exchange_in(p_invoice uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(transfer_amount),0) FROM sales.exchange WHERE replacement_invoice_id=p_invoice
$$;
CREATE FUNCTION sales.exchange_out(p_invoice uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(transfer_amount),0) FROM sales.exchange WHERE original_invoice_id=p_invoice
$$;
CREATE FUNCTION sales.exchange_funding(p_invoice uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE WHEN replacement_invoice_id=p_invoice THEN funded_transfer ELSE -funded_transfer END),0)
 FROM sales.exchange WHERE replacement_invoice_id=p_invoice OR original_invoice_id=p_invoice
$$;

-- زنجیره اسناد، منبع پرداخت واقعی را برای برگشت بعدی حفظ می‌کند.
CREATE FUNCTION sales.exchange_ancestors(p_invoice uuid) RETURNS TABLE(invoice_id uuid)
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE chain(id) AS (
   SELECT p_invoice UNION
   SELECT e.original_invoice_id FROM sales.exchange e JOIN chain c ON e.replacement_invoice_id=c.id
   WHERE e.funded_transfer>0
 ) SELECT id FROM chain
$$;

-- فقط محاسبه؛ همان تابع در پیش‌نمایش و زیر قفل هنگام ثبت فراخوانی می‌شود.
CREATE FUNCTION sales.exchange_allocation(p_returned numeric,p_replacement numeric,p_debt numeric,p_funds numeric,p_policy text)
RETURNS TABLE(debt_applied numeric,transfer_amount numeric,funded_transfer numeric,collect_amount numeric,refund_amount numeric)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_available numeric;
BEGIN
 IF p_returned<=0 OR p_replacement<=0 OR p_debt<0 OR p_funds<0 THEN
   RAISE EXCEPTION 'مقادیر تسویه تعویض نامعتبر است';
 END IF;
 IF p_debt>0 AND p_policy NOT IN ('debt_first','carry_debt') THEN
   RAISE EXCEPTION 'مدیر باید سیاست بدهی تعویض را در تنظیمات تعیین کند';
 END IF;
 debt_applied:=CASE WHEN p_policy='debt_first' THEN least(p_returned,p_debt) ELSE 0 END;
 v_available:=p_returned-debt_applied;
 transfer_amount:=least(v_available,p_replacement);
 collect_amount:=greatest(p_replacement-v_available,0);
 refund_amount:=greatest(v_available-p_replacement,0);
 IF refund_amount>p_funds THEN
   RAISE EXCEPTION 'اختلاف قابل بازپرداخت (%) از وجه واقعی باقی‌مانده (%) بیشتر است؛ سیاست حفظ بدهی با این بازپرداخت سازگار نیست. تصمیم مدیر لازم است.',refund_amount,p_funds;
 END IF;
 funded_transfer:=least(transfer_amount,p_funds-refund_amount);
 RETURN NEXT;
END $$;

CREATE FUNCTION sales.exchange_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'سند تعویض تغییرناپذیر است'; END $$;
CREATE TRIGGER exchange_immutable BEFORE UPDATE OR DELETE ON sales.exchange
FOR EACH ROW EXECUTE FUNCTION sales.exchange_immutable();

-- ردیف میانی فقط در همان تراکنش کامل می‌شود؛ تعویض نیمه‌کاره قابل commit نیست.
CREATE FUNCTION sales.exchange_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r sales.sale_return%ROWTYPE; i sales.invoice%ROWTYPE; o sales.invoice%ROWTYPE;
BEGIN
 SELECT * INTO r FROM sales.sale_return WHERE id=NEW.return_id;
 SELECT * INTO i FROM sales.invoice WHERE id=NEW.replacement_invoice_id;
 SELECT * INTO o FROM sales.invoice WHERE id=NEW.original_invoice_id;
 IF r.status<>'posted' OR r.invoice_id<>NEW.original_invoice_id OR r.kind<>'exchange'
 OR i.status NOT IN ('finalized','paid','partially_returned','returned')
 OR i.payable_amount<>NEW.replacement_value OR r.net_amount+r.tax_amount<>NEW.returned_value
 OR r.refund_amount<>NEW.refund_amount OR r.receivable_applied<>NEW.debt_applied
 OR r.credit_applied<>0 OR i.paid_amount<>NEW.collect_amount
 OR i.branch_id<>o.branch_id OR i.customer_id IS DISTINCT FROM o.customer_id
 OR EXISTS(SELECT 1 FROM inventory.warehouse WHERE id=i.warehouse_id AND kind IN ('defective','in_transit'))
 THEN RAISE EXCEPTION 'تعویض ناقص یا تسویه ناسازگار است'; END IF;
 PERFORM platform.audit('exchange.post','exchange',NEW.id::text,to_jsonb(NEW),NEW.actor_id);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER exchange_complete AFTER INSERT ON sales.exchange
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales.exchange_complete();

-- تغییر پشتوانه بعد از انتقال نیازمند سند اصلاحی مستقل است.
CREATE FUNCTION sales.exchange_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM sales.exchange WHERE original_invoice_id=OLD.invoice_id)
 AND (NEW.amount,NEW.status,NEW.direction,NEW.invoice_id) IS DISTINCT FROM (OLD.amount,OLD.status,OLD.direction,OLD.invoice_id)
 AND NOT (NEW.amount=OLD.amount AND NEW.direction=OLD.direction AND NEW.invoice_id=OLD.invoice_id
   AND OLD.status IN ('succeeded','settled','reconciled') AND NEW.status IN ('succeeded','settled','reconciled')) THEN
   RAISE EXCEPTION 'پشتوانه این پرداخت به تعویض منتقل شده؛ اصلاح به بررسی حسابدار نیاز دارد';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER exchange_payment_guard BEFORE UPDATE ON treasury.payment
FOR EACH ROW EXECUTE FUNCTION sales.exchange_payment_guard();

-- توابع ثبت کانونی در ادامه با leg تسویه تعویض گسترش می‌یابند.

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
    RAISE EXCEPTION 'فاکتور % در وضعیت قابل مرجوعی نیست (%)', inv.number, inv.status;
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
    'برگشت از فروش ' || v_no || ' — فاکتور ' || inv.number,
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
    jsonb_build_object('number', v_no, 'invoice', inv.number,
                       'net', v_net, 'tax', v_tax, 'cogs', v_cogs,
                       'refund', r.refund_amount, 'receivable_applied', v_recv,
                       'credit_applied', v_cust_credit),
    p_user, coalesce(r.reason_note, r.reason_code));

  RETURN v_no;
END $function$;


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
  v_transfer numeric;
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
           ), 0) - sales.exchange_in(i.id) AS due
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

  SELECT coalesce(sum(e.transfer_amount),0) INTO v_transfer FROM sales.exchange e
    JOIN sales.invoice i ON i.id=e.replacement_invoice_id WHERE i.posting_batch_id=p_batch;
  IF v_gross > 0 THEN
    v_legs := jsonb_build_array(
                jsonb_build_object('leg','exchange_clearing','amount',v_transfer),
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


CREATE OR REPLACE FUNCTION treasury.guard_snappay_manual() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_branch uuid; v_account uuid; v_return sales.sale_return%ROWTYPE; v_origin treasury.payment%ROWTYPE; v_refunded numeric;
BEGIN
  IF TG_OP='UPDATE' AND OLD.method_code='snappay' AND
     (NEW.method_code IS DISTINCT FROM OLD.method_code OR NEW.direction IS DISTINCT FROM OLD.direction
      OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.return_id IS DISTINCT FROM OLD.return_id) THEN
    RAISE EXCEPTION 'مشخصات پرداخت اسنپ‌پی تغییرناپذیر است';
  END IF;
  IF NEW.method_code <> 'snappay' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.method_code<>'snappay' THEN RAISE EXCEPTION 'تبدیل روش پرداخت به اسنپ‌پی مجاز نیست'; END IF;
  -- Later reconciliation or reversal retains its original account, even after configuration changes.
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.ref_no IS DISTINCT FROM OLD.ref_no THEN
      RAISE EXCEPTION 'حساب و پیگیری پرداخت اسنپ‌پی تغییرناپذیر است';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.direction='out' THEN
    SELECT * INTO STRICT v_return FROM sales.sale_return WHERE id=NEW.return_id;
    SELECT * INTO v_origin FROM treasury.payment WHERE id=v_return.refund_payment_id FOR UPDATE;
    IF v_origin.id IS NULL OR NOT EXISTS(SELECT 1 FROM sales.exchange_ancestors(v_return.invoice_id) a WHERE a.invoice_id=v_origin.invoice_id) OR
       v_origin.method_code<>'snappay' OR v_origin.direction<>'in' OR
       v_origin.status NOT IN ('succeeded','settled','reconciled') OR
       nullif(btrim(v_return.refund_reference),'') IS NULL THEN
      RAISE EXCEPTION 'بازپرداخت اسنپ‌پی باید پرداخت اصلی همان فاکتور و پیگیری برگشت تأییدشده داشته باشد';
    END IF;
    SELECT coalesce(sum(p.amount),0) INTO v_refunded FROM treasury.payment p
      JOIN sales.sale_return r ON r.id=p.return_id WHERE r.refund_payment_id=v_origin.id
      AND p.direction='out' AND p.status IN ('succeeded','settled','reconciled');
    IF NEW.amount+v_refunded>v_origin.amount THEN RAISE EXCEPTION 'بازپرداخت از مبلغ باقی‌ماندهٔ اسنپ‌پی بیشتر است'; END IF;
    IF NOT EXISTS (SELECT 1 FROM treasury.account a JOIN ledger.posting_rule pr ON pr.account_code=a.ledger_account_code
       WHERE a.id=v_origin.account_id AND pr.event_type='sale_shift' AND pr.leg='gateway_clearing' AND pr.is_active) THEN
      RAISE EXCEPTION 'نگاشت دفتر حساب اصلی اسنپ‌پی تغییر کرده است؛ بررسی حسابدار لازم است';
    END IF;
    NEW.account_id:=v_origin.account_id;
    NEW.ref_no:=v_return.refund_reference;
    RETURN NEW;
  END IF;
  IF nullif(btrim(NEW.ref_no),'') IS NULL THEN RAISE EXCEPTION 'اسنپ‌پی شماره پیگیری تأییدشده لازم دارد'; END IF;
  IF NOT EXISTS(SELECT 1 FROM treasury.payment_method WHERE code='snappay' AND is_active) THEN
    RAISE EXCEPTION 'ثبت پرداخت جدید اسنپ‌پی غیرفعال است';
  END IF;
  SELECT branch_id INTO v_branch FROM sales.invoice WHERE id=NEW.invoice_id;
  IF v_branch IS NULL THEN SELECT branch_id INTO v_branch FROM sales.sale_return WHERE id=NEW.return_id; END IF;
  IF v_branch IS NULL THEN RAISE EXCEPTION 'اسنپ‌پی باید به سند و شعبه متصل باشد'; END IF;
  v_account := treasury.snappay_account(v_branch);
  IF v_account IS NULL THEN RAISE EXCEPTION 'حساب معتبر اسنپ‌پی برای این شعبه تنظیم نشده است'; END IF;
  IF NEW.account_id IS NOT NULL AND NEW.account_id<>v_account THEN RAISE EXCEPTION 'حساب اسنپ‌پی نامعتبر است'; END IF;
  NEW.account_id:=v_account;
  RETURN NEW;
END $$;

COMMIT;
