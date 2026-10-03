BEGIN;
INSERT INTO treasury.payment_method(code,name,kind,requires_ref,is_active)
VALUES ('digipay','دیجی‌پی — ثبت دستی تأییدشده','gateway',true,false);
INSERT INTO platform.setting(key,value,description,kind,label,group_key,permission,is_editable)
VALUES ('payment.digipay_account_id','""'::jsonb,'حساب واسط خزانه برای ثبت دستی پرداخت تأییدشده دیجی‌پی؛ بدون حساب معتبر غیرفعال است.',
  'text','حساب تسویهٔ دیجی‌پی','sales','settings.security',true);

CREATE FUNCTION treasury.digipay_account(p_branch uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT a.id FROM treasury.account a
  JOIN ledger.account l ON l.code=a.ledger_account_code AND l.is_active AND l.is_postable
  JOIN treasury.account bank ON bank.id=a.settlement_account_id AND bank.kind='bank' AND bank.is_active
  WHERE a.id::text=platform.setting_text('payment.digipay_account_id','')
    AND a.kind='gateway' AND a.is_active
    AND (p_branch IS NULL OR a.branch_id IS NULL OR a.branch_id=p_branch)
    AND (bank.branch_id IS NULL OR a.branch_id=bank.branch_id)
    AND EXISTS (SELECT 1 FROM ledger.posting_rule r WHERE r.event_type='sale_shift'
      AND r.leg='gateway_clearing' AND r.side='debit' AND r.is_active AND r.account_code=l.code)
$$;

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
    SELECT * INTO v_origin FROM treasury.payment WHERE id=v_return.refund_payment_id FOR UPDATE;
    IF v_origin.id IS NULL OR NOT EXISTS(SELECT 1 FROM sales.exchange_ancestors(v_return.invoice_id) a WHERE a.invoice_id=v_origin.invoice_id) OR
       v_origin.method_code<>'digipay' OR v_origin.direction<>'in' OR
       v_origin.status NOT IN ('succeeded','settled','reconciled') OR
       nullif(btrim(v_return.refund_reference),'') IS NULL THEN
      RAISE EXCEPTION 'بازپرداخت دیجی‌پی باید پرداخت اصلی همان فاکتور و پیگیری برگشت تأییدشده داشته باشد';
    END IF;
    SELECT coalesce(sum(p.amount),0) INTO v_refunded FROM treasury.payment p
      JOIN sales.sale_return r ON r.id=p.return_id WHERE r.refund_payment_id=v_origin.id
      AND p.direction='out' AND p.status IN ('succeeded','settled','reconciled');
    IF NEW.amount+v_refunded>v_origin.amount THEN RAISE EXCEPTION 'بازپرداخت از مبلغ باقی‌ماندهٔ دیجی‌پی بیشتر است'; END IF;
    IF NOT EXISTS (SELECT 1 FROM treasury.account a JOIN ledger.posting_rule pr ON pr.account_code=a.ledger_account_code
       WHERE a.id=v_origin.account_id AND pr.event_type='sale_shift' AND pr.leg='gateway_clearing' AND pr.is_active) THEN
      RAISE EXCEPTION 'نگاشت دفتر حساب اصلی دیجی‌پی تغییر کرده است؛ بررسی حسابدار لازم است';
    END IF;
    NEW.account_id:=v_origin.account_id;
    NEW.ref_no:=v_return.refund_reference;
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

CREATE TRIGGER guard_digipay_manual BEFORE INSERT OR UPDATE ON treasury.payment
  FOR EACH ROW EXECUTE FUNCTION treasury.guard_digipay_manual();
COMMIT;
