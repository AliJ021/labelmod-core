BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE sales.invoice_review (
  invoice_id uuid PRIMARY KEY REFERENCES sales.invoice(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
  actor_id uuid NOT NULL REFERENCES identity.app_user(id),
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION sales.check_draft_hold() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN target := OLD.id;
  ELSIF TG_OP = 'DELETE' THEN target := OLD.invoice_id;
  ELSE target := NEW.invoice_id;
  END IF;
  IF target IS NOT NULL AND EXISTS (
    SELECT 1 FROM sales.invoice i JOIN sales.invoice_review r ON r.invoice_id=i.id
    WHERE i.id=target AND i.status='draft'
  ) THEN RAISE EXCEPTION 'برای تغییر پیش‌نویس معلق ابتدا ادامهٔ پیش‌نویس را بزنید'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER draft_hold BEFORE UPDATE ON sales.invoice
FOR EACH ROW WHEN (OLD.status='draft') EXECUTE FUNCTION sales.check_draft_hold();
CREATE TRIGGER draft_hold BEFORE INSERT OR UPDATE OR DELETE ON sales.invoice_line
FOR EACH ROW EXECUTE FUNCTION sales.check_draft_hold();
CREATE TRIGGER draft_hold BEFORE INSERT OR UPDATE OF invoice_id,method_code,amount,direction ON treasury.payment
FOR EACH ROW EXECUTE FUNCTION sales.check_draft_hold();

COMMIT;
