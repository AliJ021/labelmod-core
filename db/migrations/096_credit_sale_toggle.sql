BEGIN;

-- کلید روشن/خاموش فروش نسیه — خواستهٔ مالک (۱۴۰۵/۰۷/۲۱).
--
-- «نسیه» یعنی نهایی‌سازی فاکتور با مانده (روش پرداخت نیست، Batch 2.1). پیش‌فرض
-- **روشن** است تا رفتار نصب موجود عوض نشود؛ مجوز `sale.credit`، مشتری و سقف
-- اعتبار همچنان جداگانه سنجیده می‌شوند. خاموش‌کردنش فقط بدهی **تازه** را می‌بندد:
-- دریافت بدهی قبلی، مرجوعی، تعویض تسویه‌شده، COD با دریافت کامل و Replay فاکتور
-- قطعی از `finalize_invoice` با مانده نمی‌گذرند و اثر نمی‌گیرند.
--
-- هم‌زمانی: کلید در همان تراکنش نهایی‌سازی خوانده می‌شود. نهایی‌سازی‌ای که پیش از
-- Commit تغییر کلید آن را خوانده، پیش از تغییر مرتب می‌شود (خطی‌پذیر)؛ هر
-- نهایی‌سازی پس از Commit مقدار تازه را می‌بیند. قفل لازم نیست.
INSERT INTO platform.setting(key,value,description,requires_approval,kind,label,group_key,help,sort_order,permission,is_editable)
VALUES ('sales.credit_enabled','true'::jsonb,
  'فروش نسیه (نهایی‌سازی با مانده) مجاز است.', false,
  'bool','فروش نسیه مجاز باشد','sales',
  'خاموش: هیچ فاکتوری با مانده نهایی نمی‌شود — نه از صندوق، نه سفارش سایت، نه تعویض. دریافت بدهی‌های قبلی، مرجوعی و فاکتورهای قطعی دست نمی‌خورند. روشن: همان قواعد قبلی (مجوز فروش نسیه، مشتری و سقف اعتبار).',
  35,'settings.security',true)
ON CONFLICT (key) DO NOTHING;

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
    -- کلید «فروش نسیه» (۰۹۶): نهایی‌سازی با مانده یعنی بدهی تازه. همهٔ مسیرها
    -- (صندوق، سفارش سایت، تعویض) از همین تابع می‌گذرند، پس هیچ‌کدام دورش نمی‌زنند.
    -- فاکتور تسویه‌شده (مانده صفر)، وصول بدهی قبلی، مرجوعی و فاکتور قطعی دست نمی‌خورند.
    IF NOT platform.setting_bool('sales.credit_enabled', true) THEN
      RAISE EXCEPTION 'فروش نسیه در تنظیمات خاموش است؛ پیش از نهایی‌سازی کل مبلغ را دریافت کنید.';
    END IF;
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

COMMIT;
