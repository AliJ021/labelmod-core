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
     WHERE id = v_account_id;

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

COMMIT;
