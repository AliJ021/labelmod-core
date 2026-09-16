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
   FOR KEY SHARE;

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
   FOR KEY SHARE;

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

COMMIT;
