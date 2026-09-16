-- =====================================================================
-- حساب انتخابی هزینهٔ رسید فقط باید حساب هزینهٔ فعال و قابل ثبت باشد
-- =====================================================================
-- فهرست API این حساب‌ها را فیلتر می‌کند، اما کلاینت قابل اعتماد نیست.
-- این نگهبان در مرز داده نیز همان قاعده را اجبار می‌کند تا هیچ مسیر
-- درج دیگری نتواند یک سطر دارایی، بدهی، سرمایه یا درآمد را جای هزینه
-- بنشاند و مجوز انبار را به انتقال خزانه تبدیل کند.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION purchasing.assert_receipt_charge_expense_account()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.expense_account_code IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM ledger.account a
     WHERE a.code = NEW.expense_account_code
       AND a.type = 'expense'
       AND a.is_active
       AND a.is_postable
  ) THEN
    RAISE EXCEPTION 'سرفصل هزینه % باید حساب هزینه فعال و قابل ثبت باشد',
      NEW.expense_account_code;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER receipt_charge_expense_account_guard
BEFORE INSERT OR UPDATE OF expense_account_code
ON purchasing.receipt_charge
FOR EACH ROW
EXECUTE FUNCTION purchasing.assert_receipt_charge_expense_account();

COMMIT;
