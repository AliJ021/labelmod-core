-- Additive provenance: historical finalizers remain unknown, never guessed.
BEGIN;
ALTER TABLE sales.invoice ADD COLUMN finalized_by uuid REFERENCES identity.app_user(id);
ALTER TABLE sales.invoice ADD COLUMN last_activity_at timestamptz;

CREATE FUNCTION sales.invoice_workspace_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.last_activity_at := clock_timestamp();
    NEW.finalized_by := NULL;
  ELSE
    IF NEW.finalized_by IS DISTINCT FROM OLD.finalized_by THEN
      RAISE EXCEPTION 'هویت نهایی‌کننده تغییرناپذیر است';
    END IF;
    IF OLD.finalized_at IS NULL AND NEW.finalized_at IS NOT NULL THEN
      NEW.finalized_by := platform.current_actor();
    END IF;
    IF OLD.status='draft' THEN NEW.last_activity_at := clock_timestamp(); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_workspace_metadata BEFORE INSERT OR UPDATE ON sales.invoice
  FOR EACH ROW EXECUTE FUNCTION sales.invoice_workspace_metadata();

CREATE FUNCTION sales.touch_draft_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice uuid;
BEGIN
  IF TG_OP='DELETE' THEN v_invoice:=OLD.invoice_id; ELSE v_invoice:=NEW.invoice_id; END IF;
  UPDATE sales.invoice SET last_activity_at=clock_timestamp() WHERE id=v_invoice AND status='draft';
  RETURN NULL;
END $$;
CREATE TRIGGER invoice_line_activity AFTER INSERT OR UPDATE OR DELETE ON sales.invoice_line
  FOR EACH ROW EXECUTE FUNCTION sales.touch_draft_activity();
CREATE TRIGGER invoice_payment_activity AFTER INSERT OR UPDATE ON treasury.payment
  FOR EACH ROW EXECUTE FUNCTION sales.touch_draft_activity();

INSERT INTO platform.setting(key,value,description,kind,label,group_key,min_value,max_value,unit,permission,is_editable)
VALUES ('sale.draft_attention_hours','24'::jsonb,'پیش‌نویس بی‌فعالیت برچسب رسیدگی می‌گیرد؛ حذف یا لغو خودکار ندارد.',
  'int','مهلت رسیدگی به پیش‌نویس','sales',1,8760,'ساعت','settings.security',true);
CREATE INDEX invoice_workspace_recent ON sales.invoice(branch_id,occurred_at DESC,id DESC);
COMMIT;
