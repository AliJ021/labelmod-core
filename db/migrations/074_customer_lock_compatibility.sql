-- قفل مشتری همچنان فروش/مصرف اعتبار هم‌زمان را سری می‌کند.
-- NO KEY UPDATE با KEY SHARE ناشی از FK فاکتور سازگار است؛
-- ارتقای دو قفل FK به FOR UPDATE باعث deadlock فروش‌های یک مشتری می‌شد.
-- شناسه مشتری تغییر نمی‌کند و کنترل مانده/سقف اعتبار حذف نشده است.
BEGIN;
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
    SELECT * INTO v_customer FROM sales.customer WHERE id = inv.customer_id FOR NO KEY UPDATE;
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

CREATE OR REPLACE FUNCTION treasury.payment_funding_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv sales.invoice%ROWTYPE;
  v_kind text;
  v_account text;
  v_available numeric;
  v_reserved numeric;
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status IN ('succeeded','settled','reconciled')
       AND NEW.status IN ('succeeded','settled','reconciled')
       AND (NEW.invoice_id,NEW.method_code,NEW.amount,NEW.direction)
           IS NOT DISTINCT FROM (OLD.invoice_id,OLD.method_code,OLD.amount,OLD.direction)
    THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO inv FROM sales.invoice WHERE id=NEW.invoice_id FOR UPDATE;
  IF inv.status <> 'draft' AND NEW.direction='in' AND NEW.status IN ('succeeded','settled','reconciled') THEN
    RAISE EXCEPTION 'دریافت جدید فقط روی پیش‌نویس مجاز است';
  END IF;
  IF NEW.direction<>'in' OR NEW.status NOT IN ('succeeded','settled','reconciled') THEN RETURN NEW; END IF;
  SELECT kind INTO v_kind FROM treasury.payment_method WHERE code=NEW.method_code;
  IF v_kind NOT IN ('points','gift_card') THEN RETURN NEW; END IF;
  IF inv.customer_id IS NULL THEN RAISE EXCEPTION 'مصرف اعتبار یا کارت هدیه بدون مشتری مجاز نیست'; END IF;
  PERFORM 1 FROM sales.customer WHERE id=inv.customer_id FOR NO KEY UPDATE;
  SELECT account_code INTO v_account FROM ledger.posting_rule
   WHERE event_type='sale_shift' AND leg=CASE v_kind WHEN 'points' THEN 'points_redeem' ELSE 'giftcard_redeem' END AND is_active;
  IF v_account IS NULL THEN RAISE EXCEPTION 'حساب پشتوانه اعتبار تعریف نشده است'; END IF;
  -- مصرفی که هنوز در سند دوره ننشسته نیز رزرو است؛ بستن دوره نباید دوباره از مانده کم کند.
  SELECT (SELECT coalesce(sum(credit-debit),0) FROM ledger.journal_line
     WHERE account_code=v_account AND party_type='customer' AND party_id=inv.customer_id),
     coalesce(sum(p.amount),0) INTO v_available,v_reserved
    FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
    JOIN sales.invoice i ON i.id=p.invoice_id LEFT JOIN ledger.posting_batch b ON b.id=i.posting_batch_id
   WHERE i.customer_id=inv.customer_id AND i.status<>'cancelled' AND (b.id IS NULL OR b.status<>'posted')
     AND p.id<>NEW.id AND p.direction='in' AND p.status IN ('succeeded','settled','reconciled') AND m.kind=v_kind;
  IF NEW.amount>v_available-v_reserved THEN
    RAISE EXCEPTION 'پشتوانه اعتبار کافی نیست: موجود %، رزرو %، درخواست %',v_available,v_reserved,NEW.amount;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
