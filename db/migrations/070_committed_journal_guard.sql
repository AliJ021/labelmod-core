-- سازندهٔ سند، هدر و سطرها را در یک تراکنش درج می‌کند. پس از پایان
-- همان تراکنش، افزودن سطر به سند تأییدشده هم باید مانند تغییر/حذف ممنوع باشد.
-- xid8 به‌جای xmin: ارتقای confirmed به final نباید مجوز درج سطر تازه بدهد.
BEGIN;

ALTER TABLE ledger.journal_entry ADD COLUMN creation_xact xid8;
COMMENT ON COLUMN ledger.journal_entry.creation_xact IS
  'تراکنش ساخت هدر برای تکمیل اتمی سطرها؛ داخلی و تغییرناپذیر، اسناد پیشین NULL دارند.';

CREATE OR REPLACE FUNCTION ledger.protect_final_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.creation_xact := pg_current_xact_id();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('confirmed','final') THEN
      RAISE EXCEPTION 'سند نهایی حذف نمی‌شود. از سند معکوس استفاده کنید.';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.creation_xact IS DISTINCT FROM OLD.creation_xact THEN
    RAISE EXCEPTION 'شناسه تراکنش ساخت سند تغییر نمی‌کند.';
  END IF;
  IF OLD.status IN ('confirmed','final') AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (OLD.status = 'confirmed' AND NEW.status = 'final'
            AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')) THEN
      RAISE EXCEPTION 'سند تأییدشده بازنویسی نمی‌شود. از سند معکوس استفاده کنید.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER protect_final_entry_t ON ledger.journal_entry;
CREATE TRIGGER protect_final_entry_t BEFORE INSERT OR UPDATE OR DELETE ON ledger.journal_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.protect_final_entry();

CREATE OR REPLACE FUNCTION ledger.protect_posted_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_entry record; v_old uuid; v_new uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := OLD.entry_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new := NEW.entry_id; END IF;
  -- هر دو والد هنگام جابه‌جایی سطر کنترل می‌شوند؛ ترتیب قفل ثابت است.
  FOR v_entry IN
    SELECT id, status, creation_xact FROM ledger.journal_entry
     WHERE id IN (v_old, v_new) ORDER BY id FOR UPDATE
  LOOP
    IF v_entry.status IN ('confirmed','final') AND
       (TG_OP <> 'INSERT' OR v_entry.creation_xact IS DISTINCT FROM pg_current_xact_id()) THEN
      RAISE EXCEPTION 'سطر سند تأییدشده تغییر نمی‌کند یا حذف نمی‌شود و سطر تازه نمی‌پذیرد. اصلاح فقط با سند معکوس.';
    END IF;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER protect_posted_line_t ON ledger.journal_line;
CREATE TRIGGER protect_posted_line_t BEFORE INSERT OR UPDATE OR DELETE ON ledger.journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger.protect_posted_line();

COMMIT;
