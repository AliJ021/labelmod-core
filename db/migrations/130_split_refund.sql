BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE treasury.payment ADD COLUMN refund_origin_id uuid REFERENCES treasury.payment(id);
ALTER TABLE treasury.payment ADD CHECK (refund_origin_id IS NULL OR (direction='out' AND return_id IS NOT NULL));
CREATE INDEX payment_refund_origin ON treasury.payment(refund_origin_id) WHERE refund_origin_id IS NOT NULL;

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
  kept sales.exchange_retained_line%ROWTYPE;
  moved_qty platform.qty;
  moved_cost platform.money;
  v_credit_total   platform.money;
  v_received       platform.money;
  v_refunded_before platform.money;
  v_returned_before platform.money;
  v_refund_paid    platform.money;
  v_outstanding    platform.money;
  v_recv           platform.money;
  v_cust_credit    platform.money;
  payout_legs jsonb;
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

    moved_qty := v_line.qty;
    moved_cost := v_line_cogs;
    IF v_exchange.id IS NOT NULL THEN
      SELECT * INTO kept FROM sales.exchange_retained_line WHERE return_line_id=v_line.id;
      IF FOUND THEN
        IF kept.exchange_id<>v_exchange.id OR kept.variation_id<>v_line.variation_id OR
           kept.qty>v_line.qty OR NOT v_line.restock OR v_line.condition<>'sellable' OR
           r.warehouse_id<>(SELECT warehouse_id FROM sales.invoice WHERE id=v_exchange.replacement_invoice_id) THEN
          RAISE EXCEPTION 'قلم نگه‌داشته‌شده با کالا و انبار اصلاحیه تطابق ندارد';
        END IF;
        kept.cost := round(v_line_cogs * kept.qty / v_line.qty);
        UPDATE sales.exchange_retained_line SET cost=kept.cost WHERE return_line_id=v_line.id;
        moved_qty := moved_qty - kept.qty;
        moved_cost := moved_cost - kept.cost;
      END IF;
    END IF;
    IF moved_qty > 0 AND v_line.restock THEN
      PERFORM inventory.apply_movement(
        p_variation   => v_line.variation_id,
        p_warehouse   => CASE WHEN v_line.condition = 'defective'
                              THEN (SELECT id FROM inventory.warehouse
                                     WHERE branch_id = r.branch_id AND kind = 'defective' LIMIT 1)
                              ELSE r.warehouse_id END,
        p_qty         => moved_qty,
        p_kind        => 'sale_return',
        p_ref_type    => 'sale_return',
        p_ref_id      => p_return,
        p_user        => p_user,
        p_unit_cost   => round(moved_cost / moved_qty),
        p_occurred_at => r.occurred_at,
        p_value_delta => moved_cost);
    ELSIF NOT v_line.restock THEN
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

  -- Each outgoing tender credits its own clearing account in this same journal.
  SELECT jsonb_agg(jsonb_build_object('leg','refund_cash','amount',amount,'account_code',account_code)
                   ORDER BY account_code) INTO payout_legs
    FROM (
      SELECT pr.account_code,sum(p.amount) amount FROM treasury.payment p
      JOIN treasury.payment_method m ON m.code=p.method_code
      LEFT JOIN ledger.posting_rule pr ON pr.is_active AND pr.side='debit' AND pr.event_type='sale_shift'
        AND pr.leg=CASE m.kind WHEN 'cash' THEN 'cash' WHEN 'card_reader' THEN 'card_clearing'
                          WHEN 'gateway' THEN 'gateway_clearing' WHEN 'transfer' THEN 'p2p_clearing' END
      WHERE p.return_id=p_return AND p.direction='out' AND p.status IN ('succeeded','settled','reconciled')
      GROUP BY pr.account_code
    ) tenders;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(payout_legs) x WHERE x->>'account_code' IS NULL) THEN
    RAISE EXCEPTION 'حساب دفتر برای روش بازپرداخت تنظیم نشده است';
  END IF;
  PERFORM ledger.post_entry(
    'sale_return', r.branch_id, platform.business_date(r.occurred_at),
    'برگشت از فروش ' || v_no || ' — فاکتور ' || sales.invoice_display_number(inv.id),
    jsonb_build_array(
      jsonb_build_object('leg','sales_return',   'amount', v_net),
      jsonb_build_object('leg','shipping_return','amount',r.shipping_amount),
      jsonb_build_object('leg','tax',            'amount', v_tax),
      jsonb_build_object('leg','receivable',     'amount', v_recv,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','customer_credit','amount', v_cust_credit,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','exchange_clearing','amount',v_transfer),
      jsonb_build_object('leg','inventory',      'amount', v_cogs),
      jsonb_build_object('leg','cogs',           'amount', v_cogs)) || coalesce(payout_legs,'[]'::jsonb),
    'sale_return', p_return, p_user);

  PERFORM platform.audit('return.post', 'sale_return', p_return::text,
    jsonb_build_object('number', v_no, 'invoice', sales.invoice_display_number(inv.id),
                       'net', v_net, 'tax', v_tax, 'cogs', v_cogs,
                       'refund', r.refund_amount, 'receivable_applied', v_recv,
                       'credit_applied', v_cust_credit),
    p_user, coalesce(r.reason_note, r.reason_code));

  RETURN v_no;
END $function$;

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
    SELECT * INTO v_origin FROM treasury.payment WHERE id=coalesce(NEW.refund_origin_id,v_return.refund_payment_id) FOR UPDATE;
    IF v_origin.id IS NULL OR NOT EXISTS(SELECT 1 FROM sales.exchange_ancestors(v_return.invoice_id) a WHERE a.invoice_id=v_origin.invoice_id) OR
       v_origin.method_code<>'snappay' OR v_origin.direction<>'in' OR
       v_origin.status NOT IN ('succeeded','settled','reconciled') OR
       nullif(btrim(coalesce(NEW.ref_no,v_return.refund_reference)),'') IS NULL THEN
      RAISE EXCEPTION 'بازپرداخت اسنپ‌پی باید پرداخت اصلی همان فاکتور و پیگیری برگشت تأییدشده داشته باشد';
    END IF;
    SELECT coalesce(sum(p.amount),0) INTO v_refunded FROM treasury.payment p
      JOIN sales.sale_return r ON r.id=p.return_id WHERE coalesce(p.refund_origin_id,r.refund_payment_id)=v_origin.id AND p.method_code=v_origin.method_code
      AND p.direction='out' AND p.status IN ('succeeded','settled','reconciled');
    IF NEW.amount+v_refunded>v_origin.amount THEN RAISE EXCEPTION 'بازپرداخت از مبلغ باقی‌ماندهٔ اسنپ‌پی بیشتر است'; END IF;
    IF NOT EXISTS (SELECT 1 FROM treasury.account a JOIN ledger.posting_rule pr ON pr.account_code=a.ledger_account_code
       WHERE a.id=v_origin.account_id AND pr.event_type='sale_shift' AND pr.leg='gateway_clearing' AND pr.is_active) THEN
      RAISE EXCEPTION 'نگاشت دفتر حساب اصلی اسنپ‌پی تغییر کرده است؛ بررسی حسابدار لازم است';
    END IF;
    NEW.account_id:=v_origin.account_id;
    NEW.ref_no:=coalesce(NEW.ref_no,v_return.refund_reference);
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

CREATE OR REPLACE FUNCTION treasury.guard_digipay_manual() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_branch uuid; v_account uuid; v_return sales.sale_return%ROWTYPE; v_origin treasury.payment%ROWTYPE; v_refunded numeric;
BEGIN
  IF TG_OP='UPDATE' AND OLD.method_code='digipay' AND
     (NEW.method_code IS DISTINCT FROM OLD.method_code OR NEW.direction IS DISTINCT FROM OLD.direction
      OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.return_id IS DISTINCT FROM OLD.return_id) THEN
    RAISE EXCEPTION 'مشخصات پرداخت دیجی‌پی تغییرناپذیر است';
  END IF;
  IF NEW.method_code <> 'digipay' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.method_code<>'digipay' THEN RAISE EXCEPTION 'تبدیل روش پرداخت به دیجی‌پی مجاز نیست'; END IF;
  -- Later reconciliation or reversal retains its original account, even after configuration changes.
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.ref_no IS DISTINCT FROM OLD.ref_no THEN
      RAISE EXCEPTION 'حساب و پیگیری پرداخت دیجی‌پی تغییرناپذیر است';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.direction='out' THEN
    SELECT * INTO STRICT v_return FROM sales.sale_return WHERE id=NEW.return_id;
    SELECT * INTO v_origin FROM treasury.payment WHERE id=coalesce(NEW.refund_origin_id,v_return.refund_payment_id) FOR UPDATE;
    IF v_origin.id IS NULL OR NOT EXISTS(SELECT 1 FROM sales.exchange_ancestors(v_return.invoice_id) a WHERE a.invoice_id=v_origin.invoice_id) OR
       v_origin.method_code<>'digipay' OR v_origin.direction<>'in' OR
       v_origin.status NOT IN ('succeeded','settled','reconciled') OR
       nullif(btrim(coalesce(NEW.ref_no,v_return.refund_reference)),'') IS NULL THEN
      RAISE EXCEPTION 'بازپرداخت دیجی‌پی باید پرداخت اصلی همان فاکتور و پیگیری برگشت تأییدشده داشته باشد';
    END IF;
    SELECT coalesce(sum(p.amount),0) INTO v_refunded FROM treasury.payment p
      JOIN sales.sale_return r ON r.id=p.return_id WHERE coalesce(p.refund_origin_id,r.refund_payment_id)=v_origin.id AND p.method_code=v_origin.method_code
      AND p.direction='out' AND p.status IN ('succeeded','settled','reconciled');
    IF NEW.amount+v_refunded>v_origin.amount THEN RAISE EXCEPTION 'بازپرداخت از مبلغ باقی‌ماندهٔ دیجی‌پی بیشتر است'; END IF;
    IF NOT EXISTS (SELECT 1 FROM treasury.account a JOIN ledger.posting_rule pr ON pr.account_code=a.ledger_account_code
       WHERE a.id=v_origin.account_id AND pr.event_type='sale_shift' AND pr.leg='gateway_clearing' AND pr.is_active) THEN
      RAISE EXCEPTION 'نگاشت دفتر حساب اصلی دیجی‌پی تغییر کرده است؛ بررسی حسابدار لازم است';
    END IF;
    NEW.account_id:=v_origin.account_id;
    NEW.ref_no:=coalesce(NEW.ref_no,v_return.refund_reference);
    RETURN NEW;
  END IF;
  IF nullif(btrim(NEW.ref_no),'') IS NULL THEN RAISE EXCEPTION 'دیجی‌پی شماره پیگیری تأییدشده لازم دارد'; END IF;
  IF NOT EXISTS(SELECT 1 FROM treasury.payment_method WHERE code='digipay' AND is_active) THEN
    RAISE EXCEPTION 'ثبت پرداخت جدید دیجی‌پی غیرفعال است';
  END IF;
  SELECT branch_id INTO v_branch FROM sales.invoice WHERE id=NEW.invoice_id;
  IF v_branch IS NULL THEN SELECT branch_id INTO v_branch FROM sales.sale_return WHERE id=NEW.return_id; END IF;
  IF v_branch IS NULL THEN RAISE EXCEPTION 'دیجی‌پی باید به سند و شعبه متصل باشد'; END IF;
  v_account := treasury.digipay_account(v_branch);
  IF v_account IS NULL THEN RAISE EXCEPTION 'حساب معتبر دیجی‌پی برای این شعبه تنظیم نشده است'; END IF;
  IF NEW.account_id IS NOT NULL AND NEW.account_id<>v_account THEN RAISE EXCEPTION 'حساب دیجی‌پی نامعتبر است'; END IF;
  NEW.account_id:=v_account;
  RETURN NEW;
END $$;
COMMIT;
