-- A treasury-paid purchase charge may use a global account or an account
-- belonging to the receipt's branch, never another branch's account.
-- Keep this invariant in the database because imports and future callers can
-- write receipt charges without going through the HTTP service.

BEGIN;

CREATE OR REPLACE FUNCTION purchasing.assert_charge_not_from_cash_box()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_code text;
  v_active boolean;
  v_account_branch uuid;
  v_receipt_branch uuid;
BEGIN
  IF NEW.paid_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind, code, is_active, branch_id
    INTO v_kind, v_code, v_active, v_account_branch
    FROM treasury.account
   WHERE id = NEW.paid_account_id
   FOR SHARE;

  IF v_kind = 'cash_box' THEN
    RAISE EXCEPTION
      'هزینه جانبی از صندوق (%) مستقیماً پرداخت نمی‌شود. آن را بدهی بگذارید و با تراکنش خزانه‌ی متصل به شیفت پرداخت کنید، وگرنه شمارش صندوق مغایرت کاذب می‌دهد.',
      v_code;
  END IF;
  IF NEW.paid_from <> 'treasury' THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_receipt_branch
    FROM purchasing.receipt
   WHERE id = NEW.receipt_id
   FOR SHARE;

  IF v_kind IS NULL OR NOT coalesce(v_active, false) THEN
    RAISE EXCEPTION 'حساب خزانه پرداخت فعال نیست';
  END IF;
  IF v_account_branch IS NOT NULL
     AND v_account_branch IS DISTINCT FROM v_receipt_branch THEN
    RAISE EXCEPTION 'حساب خزانه باید متعلق به شعبه رسید باشد';
  END IF;
  RETURN NEW;
END $$;

-- Refuse to silently carry a previously injected cross-branch charge forward.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM purchasing.receipt_charge c
      JOIN purchasing.receipt r ON r.id = c.receipt_id
      LEFT JOIN treasury.account a ON a.id = c.paid_account_id
     WHERE c.paid_from = 'treasury'
       AND (a.id IS NULL OR NOT a.is_active OR a.kind = 'cash_box'
            OR (a.branch_id IS NOT NULL AND a.branch_id IS DISTINCT FROM r.branch_id))
  ) THEN
    RAISE EXCEPTION 'هزینه خرید دارای حساب خزانه نامعتبر یا خارج از شعبه است';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION purchasing.guard_used_charge_branch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    IF TG_TABLE_SCHEMA = 'treasury' THEN
      IF EXISTS (SELECT 1 FROM purchasing.receipt_charge WHERE paid_account_id = OLD.id) THEN
        RAISE EXCEPTION 'شعبه حساب دارای هزینه خرید قابل تغییر نیست'
          USING ERRCODE = '23514', CONSTRAINT = 'used_charge_account_branch';
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM purchasing.receipt_charge WHERE receipt_id = OLD.id) THEN
        RAISE EXCEPTION 'شعبه رسید دارای هزینه قابل تغییر نیست'
          USING ERRCODE = '23514', CONSTRAINT = 'used_charge_receipt_branch';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER used_charge_account_branch_t
  BEFORE UPDATE OF branch_id ON treasury.account
  FOR EACH ROW EXECUTE FUNCTION purchasing.guard_used_charge_branch();
CREATE TRIGGER used_charge_receipt_branch_t
  BEFORE UPDATE OF branch_id ON purchasing.receipt
  FOR EACH ROW EXECUTE FUNCTION purchasing.guard_used_charge_branch();

COMMIT;
