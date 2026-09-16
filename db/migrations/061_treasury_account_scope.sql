-- ۰۶۱ — حساب شعبه‌ای خزانه فقط در تراکنش همان شعبه قابل استفاده است.
--
-- لایه API همین قاعده را برای پیام قابل‌فهم زودتر می‌سنجد؛ این Trigger
-- پشتوانهٔ دیتابیس است تا درج مستقیم یا مسیر تازه نتواند حساب شعبه‌ای
-- دیگر را به سند این شعبه متصل کند. حساب‌های سراسری (`branch_id IS NULL`)
-- عمداً در همه شعب قابل استفاده می‌مانند.

BEGIN;

CREATE OR REPLACE FUNCTION treasury.assert_transaction_account_branch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
  v_account_branch uuid;
BEGIN
  FOREACH v_account_id IN ARRAY ARRAY[NEW.from_account_id, NEW.to_account_id]
  LOOP
    CONTINUE WHEN v_account_id IS NULL;

    SELECT branch_id INTO v_account_branch
      FROM treasury.account
     WHERE id = v_account_id
     FOR SHARE;

    IF v_account_branch IS NOT NULL AND v_account_branch <> NEW.branch_id THEN
      RAISE EXCEPTION
        'حساب خزانه % متعلق به شعبه تراکنش % نیست',
        v_account_id, NEW.branch_id
        USING ERRCODE = '23514', CONSTRAINT = 'transaction_account_branch';
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

CREATE TRIGGER transaction_account_branch_t
  BEFORE INSERT OR UPDATE OF branch_id, from_account_id, to_account_id
  ON treasury.transaction
  FOR EACH ROW EXECUTE FUNCTION treasury.assert_transaction_account_branch();

-- دامنه حساب استفاده‌شده تغییر نمی‌کند؛ قفل مشترک بالا با این UPDATE تعارض دارد.
CREATE OR REPLACE FUNCTION treasury.guard_used_transaction_account_branch()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND EXISTS (
    SELECT 1 FROM treasury.transaction
     WHERE from_account_id = OLD.id OR to_account_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'شعبه حساب دارای تراکنش قابل تغییر نیست'
      USING ERRCODE = '23514', CONSTRAINT = 'used_transaction_account_branch';
  END IF;
  RETURN NEW;
END $;
CREATE TRIGGER used_transaction_account_branch_t
  BEFORE UPDATE OF branch_id ON treasury.account
  FOR EACH ROW EXECUTE FUNCTION treasury.guard_used_transaction_account_branch();

COMMIT;
