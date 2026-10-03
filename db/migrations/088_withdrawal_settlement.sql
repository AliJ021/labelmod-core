-- تسویهٔ دفتر برداشت فقط وضعیت نسخهٔ انتخاب‌شده است؛ هیچ اثر مالی ندارد.
-- اصلاح بعدی نسخهٔ باز تازه می‌سازد؛ سابقهٔ تسویهٔ نسخهٔ قبلی می‌ماند.
BEGIN;
CREATE TABLE identity.staff_withdrawal_settlement (
  withdrawal_id uuid NOT NULL,
  version int NOT NULL,
  batch_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES identity.app_user(id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  note text NOT NULL CHECK (btrim(note) <> '' AND length(note) <= 500),
  PRIMARY KEY (withdrawal_id, version),
  FOREIGN KEY (withdrawal_id, version) REFERENCES identity.staff_withdrawal_revision(withdrawal_id, version)
);
CREATE INDEX staff_withdrawal_settlement_batch_idx ON identity.staff_withdrawal_settlement(batch_id);
CREATE TRIGGER staff_withdrawal_settlement_no_change BEFORE UPDATE OR DELETE ON identity.staff_withdrawal_settlement
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_immutable();
CREATE TRIGGER staff_withdrawal_settlement_no_truncate BEFORE TRUNCATE ON identity.staff_withdrawal_settlement
  FOR EACH STATEMENT EXECUTE FUNCTION identity.staff_withdrawal_immutable();

CREATE FUNCTION identity.staff_withdrawal_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := platform.current_actor(); v_head identity.staff_withdrawal%ROWTYPE;
  v_last int; v_ok identity.permission_verdict;
BEGIN
  IF v_actor IS NULL OR NEW.actor_id IS DISTINCT FROM v_actor OR NOT EXISTS
    (SELECT 1 FROM identity.app_user WHERE id=v_actor AND is_active) THEN
    RAISE EXCEPTION 'تسویهٔ برداشت به کاربر عامل فعال نیاز دارد';
  END IF;
  SELECT verdict INTO v_ok FROM identity.can(v_actor,'withdrawal.correct');
  IF v_ok IS DISTINCT FROM 'allow' THEN RAISE EXCEPTION 'تسویهٔ برداشت مجوز اصلاح مدیر می‌خواهد'; END IF;
  SELECT * INTO v_head FROM identity.staff_withdrawal WHERE id=NEW.withdrawal_id FOR UPDATE;
  IF NOT FOUND OR NOT identity.withdrawal_in_scope(v_actor,v_head.branch_id) THEN
    RAISE EXCEPTION 'ثبت برداشت در دامنهٔ شما یافت نشد';
  END IF;
  SELECT max(version) INTO v_last FROM identity.staff_withdrawal_revision WHERE withdrawal_id=NEW.withdrawal_id;
  IF NEW.version IS DISTINCT FROM v_last THEN RAISE EXCEPTION 'نسخهٔ برداشت قدیمی است؛ فهرست را تازه کنید'; END IF;
  NEW.at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_withdrawal_settlement_guard BEFORE INSERT ON identity.staff_withdrawal_settlement
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_settlement_guard();

CREATE FUNCTION identity.staff_withdrawal_settlement_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amount text;
BEGIN
  SELECT amount::text INTO v_amount FROM identity.staff_withdrawal_revision
    WHERE withdrawal_id=NEW.withdrawal_id AND version=NEW.version;
  PERFORM platform.audit('withdrawal.settle','staff_withdrawal',NEW.withdrawal_id::text,
    jsonb_build_object('version',NEW.version,'amount',v_amount,'batchId',NEW.batch_id,'settled',true),
    NEW.actor_id,NEW.note,jsonb_build_object('version',NEW.version,'amount',v_amount,'settled',false));
  RETURN NULL;
END $$;
CREATE TRIGGER staff_withdrawal_settlement_audit AFTER INSERT ON identity.staff_withdrawal_settlement
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_settlement_audit();

-- درج مستقیم نسخه نیز باید با تسویه روی همان سرآیند مرتب شود.
CREATE FUNCTION identity.staff_withdrawal_revision_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM identity.staff_withdrawal WHERE id=NEW.withdrawal_id FOR UPDATE;
  RETURN NEW;
END $$;
-- نام قبل از guard مرتب می‌شود؛ قفل پیش از خواندن نسخهٔ جاری گرفته می‌شود.
CREATE TRIGGER staff_withdrawal_revision_00_lock BEFORE INSERT ON identity.staff_withdrawal_revision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_revision_lock();

CREATE OR REPLACE VIEW identity.staff_withdrawal_current AS
SELECT w.id,w.owner_id,w.branch_id,w.created_at,r.version,r.amount,r.reason,r.note AS last_note,
  CASE WHEN r.version>1 THEN r.at END AS corrected_at,
  CASE WHEN r.version>1 THEN r.actor_id END AS corrected_by,
  s.at AS settled_at,s.actor_id AS settled_by,s.batch_id AS settlement_batch_id
FROM identity.staff_withdrawal w
JOIN LATERAL (SELECT * FROM identity.staff_withdrawal_revision x WHERE x.withdrawal_id=w.id ORDER BY x.version DESC LIMIT 1) r ON true
LEFT JOIN identity.staff_withdrawal_settlement s ON s.withdrawal_id=w.id AND s.version=r.version;
REVOKE EXECUTE ON FUNCTION identity.staff_withdrawal_settlement_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_withdrawal_settlement_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_withdrawal_revision_lock() FROM PUBLIC;
COMMIT;
