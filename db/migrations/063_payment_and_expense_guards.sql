-- رزرو اتمی اعتبار و جلوگیری از انتخاب حساب دارایی برای هزینه.
BEGIN;

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
  IF NEW.direction<>'in' OR NEW.status NOT IN ('succeeded','settled','reconciled') THEN RETURN NEW; END IF;
  SELECT kind INTO v_kind FROM treasury.payment_method WHERE code=NEW.method_code;
  IF v_kind NOT IN ('points','gift_card') THEN RETURN NEW; END IF;
  IF inv.customer_id IS NULL THEN RAISE EXCEPTION 'مصرف اعتبار یا کارت هدیه بدون مشتری مجاز نیست'; END IF;
  PERFORM 1 FROM sales.customer WHERE id=inv.customer_id FOR UPDATE;
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
CREATE TRIGGER payment_funding_guard BEFORE INSERT OR UPDATE OF amount,status,method_code,invoice_id,direction
  ON treasury.payment FOR EACH ROW EXECUTE FUNCTION treasury.payment_funding_guard();

CREATE OR REPLACE FUNCTION treasury.expense_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose='expense' AND NOT EXISTS (
    SELECT 1 FROM ledger.account WHERE code=NEW.expense_account_code
      AND is_postable AND is_active AND (type='expense' OR (type='liability' AND code IN (
        SELECT account_code FROM ledger.posting_rule WHERE event_type='purchase_receipt'
          AND leg='other_payable' AND is_active)))) THEN
    RAISE EXCEPTION 'برای هزینه باید حساب هزینه فعال و قابل ثبت انتخاب شود';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_account_guard BEFORE INSERT OR UPDATE OF expense_account_code,purpose,status
  ON treasury.transaction FOR EACH ROW EXECUTE FUNCTION treasury.expense_account_guard();

-- حساب بازپرداخت فقط از نگاشت روش پرداخت انتخاب می‌شود، نه از ورودی کلاینت.
UPDATE ledger.posting_rule SET allow_account_override=true WHERE event_type='sale_return' AND leg='refund_cash';

CREATE OR REPLACE FUNCTION sales.line_tax(p_variation uuid,p_net numeric) RETURNS numeric
LANGUAGE plpgsql STABLE AS $$
DECLARE v_code text; v_rate numeric;
BEGIN
  IF NOT coalesce((SELECT value::boolean FROM platform.setting WHERE key='tax.enabled'),false) THEN RETURN 0; END IF;
  SELECT p.tax_rate_code INTO v_code FROM catalog.variation v JOIN catalog.product p ON p.id=v.product_id WHERE v.id=p_variation;
  IF v_code IN ('zero','exempt') THEN RETURN 0; END IF;
  IF v_code<>'standard' THEN RAISE EXCEPTION 'نرخ مالیات کالا تعریف نشده است: %',v_code; END IF;
  SELECT value::numeric INTO v_rate FROM platform.setting WHERE key='tax.default_rate';
  IF v_rate IS NULL OR v_rate<0 OR v_rate>100 THEN RAISE EXCEPTION 'نرخ مالیات معتبر نیست'; END IF;
  RETURN round(p_net*v_rate/100);
END $$;

COMMIT;
