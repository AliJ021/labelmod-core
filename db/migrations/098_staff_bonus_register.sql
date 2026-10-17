-- =====================================================================
-- ۰۹۸ — دفتر پاداش پرسنل: درخواست کارمند + تأیید مدیر، یا اعطای مستقیم مدیر
-- =====================================================================
-- خواستهٔ مالک (۱۴۰۵/۰۷): پاداش مثل دفتر برداشت (۰۸۴/۰۸۸) **فقط یک دفتر
-- ثبت** است. دو مسیر دارد:
--   • درخواست: کارمند واردشده برای خودش «مبلغ + دلیل» ثبت می‌کند → مدیر
--     مجاز تأیید یا رد می‌کند (رد دلیل اجباری دارد).
--   • اعطا: مدیر مجاز برای کارمند فعالِ در دامنه‌اش مستقیم «مبلغ + دلیل»
--     ثبت می‌کند؛ این ثبت از ابتدا «تأییدشده» است.
-- پاداش تأییدشده با تسویهٔ گروهی مدیر «تسویه‌شده» می‌شود.
--
-- ⚠️ **هیچ اثری بر دفتر، خزانه، کشوی صندوق، انبار، حقوق یا پرداخت ندارد.**
--    این مهاجرت هیچ `post_entry`، `apply_movement`، `treasury.*`، `outbox` و
--    هیچ `posting_rule`ی نمی‌سازد و صدا نمی‌زند. «تسویه» فقط وضعیت دفتر است،
--    نه پرداخت؛ `db/test/staff-bonus.sql` شمارش پیش/پس را می‌سنجد.
--
-- ── وضعیت‌ها (صریح؛ از سه جدول فقط‌درج‌شدنی، بی ستون قابل‌تغییر) ─────
--   request:  pending ──تأیید──▶ approved ──تسویه──▶ settled
--                     └─رد────▶ rejected (پایانی)
--   award:    approved ──تسویه──▶ settled
-- مبلغ و دلیل سرآیند پس از ثبت تغییر نمی‌کنند؛ «اصلاح» یعنی رد و درخواست
-- یا اعطای تازه، تا تأیید همیشه دقیقاً به همان عددی باشد که دیده شده.
--
-- ── جداسازی وظایف ───────────────────────────────────────────────────
-- هیچ‌کس درخواست خودش را بررسی، به خودش اعطا، یا پاداش خودش را تسویه
-- نمی‌کند. همه در Trigger (هر مسیر، حتی INSERT مستقیم با نقش برنامه).
--
-- ── مجوز (فقط admin؛ بقیهٔ نقش‌ها صریحاً false) ─────────────────────
--   bonus.view_all  دیدن دفتر پاداش همه (در دامنهٔ شعبه)
--   bonus.manage    تأیید/رد، اعطای مستقیم و تسویهٔ گروهی
-- ثبت درخواست و دیدن پاداش **خود** مجوزی نمی‌خواهد. نصب تازه همین ردیف‌ها
-- را از `db/seed/098_bonus_permissions.sql` می‌گیرد (الگوی ۰۸۴).
--
-- ── دامنهٔ شعبه ─────────────────────────────────────────────────────
-- همان تعریف برداشت: `identity.withdrawal_home_branch(ذی‌نفع)` در لحظهٔ
-- ثبت و `identity.withdrawal_in_scope(عامل, شعبه)`؛ ابهام → سراسری (NULL)،
-- که فقط مدیر همهٔ شعب می‌بیند.
--
-- ── ارتقا و بازگشت ─────────────────────────────────────────────────
-- فقط سه جدول تازه و خالی؛ هیچ جدول موجودی دست نمی‌خورد و قفل طولانی
-- نمی‌گیرد. Seed روی دیتابیس موجود اجرا نمی‌شود؛ مجوزها در بند ۷ همین
-- مهاجرت با `ON CONFLICT DO NOTHING` درج می‌شوند. بازگشت دستی فقط پیش از
-- نخستین ثبت واقعی معنا دارد (docs/STAFF-BONUS.md)؛ پس از آن، دفتر
-- حسابرسی‌شده حذف نمی‌شود و بازگشت یعنی پنهان‌کردن مسیر در نسخهٔ برنامه.
-- =====================================================================

BEGIN;

CREATE TABLE identity.staff_bonus (
  id         uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  owner_id   uuid NOT NULL REFERENCES identity.app_user(id),
  branch_id  uuid REFERENCES platform.branch(id),
  origin     text NOT NULL CHECK (origin IN ('request', 'award')),
  amount     platform.money NOT NULL CHECK (amount > 0),
  reason     text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  created_by uuid NOT NULL REFERENCES identity.app_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT staff_bonus_origin_shape CHECK (
    (origin = 'request' AND created_by = owner_id) OR (origin = 'award' AND created_by <> owner_id))
);
CREATE INDEX staff_bonus_owner_idx  ON identity.staff_bonus (owner_id, created_at DESC, id DESC);
CREATE INDEX staff_bonus_recent_idx ON identity.staff_bonus (created_at DESC, id DESC);

COMMENT ON TABLE identity.staff_bonus IS
  'دفتر پاداش پرسنل — فقط ثبت، بی اثر مالی. request = درخواست کارمند، award = اعطای مستقیم مدیر. فقط درج‌شدنی.';

CREATE TABLE identity.staff_bonus_decision (
  bonus_id uuid PRIMARY KEY REFERENCES identity.staff_bonus(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note     text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  actor_id uuid NOT NULL REFERENCES identity.app_user(id),
  at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT staff_bonus_reject_needs_note CHECK (decision = 'approved' OR note IS NOT NULL)
);
COMMENT ON TABLE identity.staff_bonus_decision IS
  'تصمیم یکتای مدیر روی درخواست پاداش؛ رد دلیل اجباری دارد. فقط درج‌شدنی.';

CREATE TABLE identity.staff_bonus_settlement (
  bonus_id uuid PRIMARY KEY REFERENCES identity.staff_bonus(id),
  batch_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES identity.app_user(id),
  at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  note     text NOT NULL CHECK (btrim(note) <> '' AND length(note) <= 500)
);
CREATE INDEX staff_bonus_settlement_batch_idx ON identity.staff_bonus_settlement (batch_id);
COMMENT ON TABLE identity.staff_bonus_settlement IS
  'تسویهٔ دفتر پاداش — فقط وضعیت، نه پرداخت. فقط درج‌شدنی.';

-- ---------------------------------------------------------------------
-- ۱. تغییرناپذیری — هر سه جدول
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_bonus_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'دفتر پاداش فقط قابل درج است؛ تغییر وضعیت فقط با تصمیم یا تسویهٔ تازه ثبت می‌شود';
END $$;

CREATE TRIGGER staff_bonus_no_change BEFORE UPDATE OR DELETE ON identity.staff_bonus
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_immutable();
CREATE TRIGGER staff_bonus_no_truncate BEFORE TRUNCATE ON identity.staff_bonus
  FOR EACH STATEMENT EXECUTE FUNCTION identity.staff_bonus_immutable();
CREATE TRIGGER staff_bonus_decision_no_change BEFORE UPDATE OR DELETE ON identity.staff_bonus_decision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_immutable();
CREATE TRIGGER staff_bonus_decision_no_truncate BEFORE TRUNCATE ON identity.staff_bonus_decision
  FOR EACH STATEMENT EXECUTE FUNCTION identity.staff_bonus_immutable();
CREATE TRIGGER staff_bonus_settlement_no_change BEFORE UPDATE OR DELETE ON identity.staff_bonus_settlement
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_immutable();
CREATE TRIGGER staff_bonus_settlement_no_truncate BEFORE TRUNCATE ON identity.staff_bonus_settlement
  FOR EACH STATEMENT EXECUTE FUNCTION identity.staff_bonus_immutable();

-- ---------------------------------------------------------------------
-- ۲. کمکی‌ها — عامل فعال و مجوز مدیریت
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.bonus_actor() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v_actor uuid := platform.current_actor();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'ثبت پاداش بدون کاربر عامل مجاز نیست';
  END IF;
  PERFORM 1 FROM identity.app_user WHERE id = v_actor AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'کاربر غیرفعال در دفتر پاداش ثبت نمی‌کند';
  END IF;
  RETURN v_actor;
END $$;

CREATE FUNCTION identity.bonus_require_manage(p_actor uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE v_ok identity.permission_verdict;
BEGIN
  SELECT verdict INTO v_ok FROM identity.can(p_actor, 'bonus.manage');
  IF v_ok IS DISTINCT FROM 'allow' THEN
    RAISE EXCEPTION 'این کار فقط با مجوز «bonus.manage» ممکن است';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- ۳. سرآیند: عامل، ذی‌نفع، شعبه و زمان از سرور
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_bonus_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := identity.bonus_actor();
BEGIN
  IF NEW.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ثبت‌کنندهٔ پاداش باید همان کاربر واردشده باشد';
  END IF;
  IF NEW.origin = 'request' THEN
    IF NEW.owner_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'درخواست پاداش فقط به نام خودِ کاربر واردشده ثبت می‌شود';
    END IF;
  ELSE
    IF NEW.owner_id = v_actor THEN
      RAISE EXCEPTION 'هیچ مدیری به خودش پاداش اعطا نمی‌کند';
    END IF;
    PERFORM identity.bonus_require_manage(v_actor);
    PERFORM 1 FROM identity.app_user u WHERE u.id = NEW.owner_id AND u.is_active
       AND EXISTS (SELECT 1 FROM identity.user_role r WHERE r.user_id = u.id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ذی‌نفع پاداش باید کارمند فعال با نقش باشد';
    END IF;
    IF NOT identity.withdrawal_in_scope(v_actor, identity.withdrawal_home_branch(NEW.owner_id)) THEN
      RAISE EXCEPTION 'این کارمند در دامنهٔ شعبهٔ شما نیست';
    END IF;
  END IF;
  IF NEW.branch_id IS DISTINCT FROM identity.withdrawal_home_branch(NEW.owner_id) THEN
    RAISE EXCEPTION 'شعبهٔ پاداش از نقش‌های ذی‌نفع گرفته می‌شود، نه از ورودی';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_bonus_guard BEFORE INSERT ON identity.staff_bonus
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_guard();

CREATE FUNCTION identity.staff_bonus_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.audit(
    CASE WHEN NEW.origin = 'request' THEN 'bonus.request' ELSE 'bonus.award' END,
    'staff_bonus', NEW.id::text,
    jsonb_build_object('ownerId', NEW.owner_id, 'origin', NEW.origin, 'amount', NEW.amount::text,
                       'reason', NEW.reason,
                       'status', CASE WHEN NEW.origin = 'request' THEN 'pending' ELSE 'approved' END),
    NEW.created_by, NULL, NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER staff_bonus_audit AFTER INSERT ON identity.staff_bonus
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_audit();

-- ---------------------------------------------------------------------
-- ۴. تصمیم: فقط درخواستِ در انتظار، مدیر مجاز در دامنه، نه درخواست خود
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_bonus_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := identity.bonus_actor(); v_head identity.staff_bonus%ROWTYPE;
BEGIN
  IF NEW.actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'عامل تصمیم پاداش باید همان کاربر واردشده باشد';
  END IF;
  PERFORM identity.bonus_require_manage(v_actor);
  -- قفل سرآیند: تصمیم و تسویهٔ هم‌زمان پشت هم صف می‌کشند.
  SELECT * INTO v_head FROM identity.staff_bonus WHERE id = NEW.bonus_id FOR UPDATE;
  IF NOT FOUND OR NOT identity.withdrawal_in_scope(v_actor, v_head.branch_id) THEN
    RAISE EXCEPTION 'پاداش در دامنهٔ شما یافت نشد';
  END IF;
  IF v_head.origin = 'award' THEN
    RAISE EXCEPTION 'پاداش اعطایی مستقیم تأییدشده است و بررسی ندارد';
  END IF;
  IF v_head.owner_id = v_actor THEN
    RAISE EXCEPTION 'درخواست پاداش خود را نمی‌توانید بررسی کنید';
  END IF;
  PERFORM 1 FROM identity.staff_bonus_decision WHERE bonus_id = NEW.bonus_id;
  IF FOUND THEN
    RAISE EXCEPTION 'این درخواست پاداش پیش‌تر بررسی شده است؛ فهرست را تازه کنید';
  END IF;
  NEW.at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_bonus_decision_guard BEFORE INSERT ON identity.staff_bonus_decision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_decision_guard();

CREATE FUNCTION identity.staff_bonus_decision_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_head identity.staff_bonus%ROWTYPE;
BEGIN
  SELECT * INTO v_head FROM identity.staff_bonus WHERE id = NEW.bonus_id;
  PERFORM platform.audit(
    CASE WHEN NEW.decision = 'approved' THEN 'bonus.approve' ELSE 'bonus.reject' END,
    'staff_bonus', NEW.bonus_id::text,
    jsonb_build_object('ownerId', v_head.owner_id, 'amount', v_head.amount::text, 'status', NEW.decision),
    NEW.actor_id, NEW.note,
    jsonb_build_object('ownerId', v_head.owner_id, 'amount', v_head.amount::text, 'status', 'pending'));
  RETURN NULL;
END $$;
CREATE TRIGGER staff_bonus_decision_audit AFTER INSERT ON identity.staff_bonus_decision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_decision_audit();

-- ---------------------------------------------------------------------
-- ۵. تسویه: فقط تأییدشده و تسویه‌نشده، در دامنه، نه پاداش خود
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_bonus_settlement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := identity.bonus_actor(); v_head identity.staff_bonus%ROWTYPE; v_dec text;
BEGIN
  IF NEW.actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'عامل تسویهٔ پاداش باید همان کاربر واردشده باشد';
  END IF;
  PERFORM identity.bonus_require_manage(v_actor);
  SELECT * INTO v_head FROM identity.staff_bonus WHERE id = NEW.bonus_id FOR UPDATE;
  IF NOT FOUND OR NOT identity.withdrawal_in_scope(v_actor, v_head.branch_id) THEN
    RAISE EXCEPTION 'پاداش در دامنهٔ شما یافت نشد';
  END IF;
  IF v_head.owner_id = v_actor THEN
    RAISE EXCEPTION 'پاداش خود را نمی‌توانید تسویه کنید';
  END IF;
  SELECT decision INTO v_dec FROM identity.staff_bonus_decision WHERE bonus_id = NEW.bonus_id;
  IF v_head.origin = 'request' AND v_dec IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'فقط پاداش تأییدشده تسویه می‌شود؛ فهرست را تازه کنید';
  END IF;
  PERFORM 1 FROM identity.staff_bonus_settlement WHERE bonus_id = NEW.bonus_id;
  IF FOUND THEN
    RAISE EXCEPTION 'این پاداش پیش‌تر تسویه شده است؛ فهرست را تازه کنید';
  END IF;
  NEW.at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_bonus_settlement_guard BEFORE INSERT ON identity.staff_bonus_settlement
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_settlement_guard();

CREATE FUNCTION identity.staff_bonus_settlement_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_head identity.staff_bonus%ROWTYPE;
BEGIN
  SELECT * INTO v_head FROM identity.staff_bonus WHERE id = NEW.bonus_id;
  PERFORM platform.audit('bonus.settle', 'staff_bonus', NEW.bonus_id::text,
    jsonb_build_object('ownerId', v_head.owner_id, 'amount', v_head.amount::text, 'status', 'settled',
                       'batchId', NEW.batch_id),
    NEW.actor_id, NEW.note,
    jsonb_build_object('ownerId', v_head.owner_id, 'amount', v_head.amount::text, 'status', 'approved'));
  RETURN NULL;
END $$;
CREATE TRIGGER staff_bonus_settlement_audit AFTER INSERT ON identity.staff_bonus_settlement
  FOR EACH ROW EXECUTE FUNCTION identity.staff_bonus_settlement_audit();

-- ---------------------------------------------------------------------
-- ۶. دروازه‌ها و نمای جاری
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.request_bonus(p_amount platform.money, p_reason text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := identity.bonus_actor(); v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'مبلغ پاداش باید بیشتر از صفر باشد';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'دلیل پاداش را بنویسید';
  END IF;
  INSERT INTO identity.staff_bonus (owner_id, branch_id, origin, amount, reason, created_by)
  VALUES (v_actor, identity.withdrawal_home_branch(v_actor), 'request', p_amount, btrim(p_reason), v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION identity.request_bonus IS
  'درخواست پاداش به نام کاربر عامل؛ مالکی از ورودی نمی‌گیرد؛ اثر مالی ندارد.';

CREATE FUNCTION identity.award_bonus(p_owner uuid, p_amount platform.money, p_reason text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := identity.bonus_actor(); v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'مبلغ پاداش باید بیشتر از صفر باشد';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'دلیل پاداش را بنویسید';
  END IF;
  INSERT INTO identity.staff_bonus (owner_id, branch_id, origin, amount, reason, created_by)
  VALUES (p_owner, identity.withdrawal_home_branch(p_owner), 'award', p_amount, btrim(p_reason), v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION identity.award_bonus IS
  'اعطای مستقیم پاداش؛ مجوز، دامنه و منع اعطا به خود در Trigger سرآیند. اثر مالی ندارد.';

CREATE FUNCTION identity.decide_bonus(p_id uuid, p_decision text, p_note text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := identity.bonus_actor();
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'تصمیم پاداش فقط تأیید یا رد است';
  END IF;
  IF p_decision = 'rejected' AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RAISE EXCEPTION 'دلیل رد پاداش را بنویسید';
  END IF;
  INSERT INTO identity.staff_bonus_decision (bonus_id, decision, note, actor_id)
  VALUES (p_id, p_decision, nullif(btrim(coalesce(p_note, '')), ''), v_actor);
  RETURN p_decision;
END $$;

CREATE VIEW identity.staff_bonus_current AS
SELECT b.id, b.owner_id, b.branch_id, b.origin, b.amount, b.reason, b.created_by, b.created_at,
       CASE WHEN s.bonus_id IS NOT NULL THEN 'settled'
            WHEN b.origin = 'award' OR d.decision = 'approved' THEN 'approved'
            WHEN d.decision = 'rejected' THEN 'rejected'
            ELSE 'pending' END AS status,
       CASE WHEN b.origin = 'award' THEN b.created_by ELSE d.actor_id END AS decided_by,
       CASE WHEN b.origin = 'award' THEN b.created_at ELSE d.at END AS decided_at,
       d.note AS decision_note,
       s.at AS settled_at, s.actor_id AS settled_by, s.batch_id AS settlement_batch_id, s.note AS settlement_note
  FROM identity.staff_bonus b
  LEFT JOIN identity.staff_bonus_decision d ON d.bonus_id = b.id
  LEFT JOIN identity.staff_bonus_settlement s ON s.bonus_id = b.id;

REVOKE EXECUTE ON FUNCTION identity.staff_bonus_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_bonus_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_bonus_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_bonus_decision_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_bonus_decision_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_bonus_settlement_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.staff_bonus_settlement_audit() FROM PUBLIC;

-- ---------------------------------------------------------------------
-- ۷. مجوزها — نصب موجود (نصب تازه: db/seed/098_bonus_permissions.sql)
-- ---------------------------------------------------------------------
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,o.operation,(r.code='admin'),NULL,NULL,NULL
FROM identity.role r CROSS JOIN (VALUES ('bonus.view_all'),('bonus.manage')) AS o(operation)
ON CONFLICT (role_code,operation) DO NOTHING;

COMMIT;
