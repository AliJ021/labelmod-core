-- =====================================================================
-- ۰۸۴ — دفتر برداشت پرسنل: فقط ثبت «مبلغ + دلیل»، بی هیچ اثر مالی
-- =====================================================================
-- تصمیم مالک (۱۴۰۵/۰۷/۱۰): برداشت پرسنل **فقط یک دفتر ثبت** است. هر
-- کاربر فعال، صرف‌نظر از نقش، برداشت خودش را با مبلغ و دلیل ثبت می‌کند
-- و مدیر کل همه را می‌بیند و مبلغ یا دلیل را — حتی تا صفر — اصلاح می‌کند.
--
-- ⚠️ **هیچ اثری بر خزانه، دفتر، کشوی صندوق، انبار یا حقوق ندارد.** این
--    مهاجرت هیچ `post_entry`، هیچ `apply_movement`، هیچ `treasury.*` و
--    هیچ نگاشت `posting_rule`ی نمی‌سازد و صدا نمی‌زند. نمونهٔ قدیمی
--    «برداشت و پاداش» در `docs/FEATURE_DEVELOPMENT_RULES.md` (سند و تأیید
--    پرداخت) برای این ویژگی منسوخ است. «اصلاح» یعنی نسخهٔ تازهٔ همان ثبت،
--    نه سند معکوس — چون سندی در کار نیست.
--
-- ── شکل داده ────────────────────────────────────────────────────────
--   identity.staff_withdrawal           سرآیند: مالک، شعبه، زمان سرور
--   identity.staff_withdrawal_revision  نسخه‌ها: ۱ = ثبت مالک، ۲.. = اصلاح مدیر
--
-- **هر دو فقط درج‌شدنی‌اند.** مقدار جاری = آخرین نسخه؛ هیچ مقداری روی
-- مقدار قبلی بازنویسی نمی‌شود، پس «پیش» و «پس» هر اصلاح همیشه در خودِ
-- جدول هست، به‌علاوهٔ `platform.audit_log` با زنجیرهٔ هش.
--
-- ── چرا نگهبان‌ها Trigger‌اند، نه فقط تابع ──────────────────────────
-- نقش برنامه روی جدول‌های `identity` حق INSERT دارد (`ops/db-roles.sh`)،
-- پس تابع به‌تنهایی دروازه نیست. Triggerها از **هر** مسیری می‌گذرند:
--   • مالک و عامل از `platform.current_actor()` می‌آیند و با ستون مقایسه
--     می‌شوند — شناسهٔ ارسالی کلاینت هرگز جای مالک نمی‌نشیند.
--   • زمان از `clock_timestamp()` سرور، نه از ورودی.
--   • نسخهٔ n فقط پس از n−1، و نسخهٔ بالای ۱ فقط با `withdrawal.correct`،
--     عاملی غیر از مالک، و شعبه‌ای در دامنهٔ عامل.
--   • هر نسخه یک سطر `platform.audit` با پیش و پس می‌زند.
--
-- ── مجوز ────────────────────────────────────────────────────────────
-- دو عملیات تازه، نه بازاستفاده از یک مجوز پهن بی‌ربط:
--   withdrawal.view_all  دیدن دفتر همهٔ کاربران (در دامنهٔ شعبه)
--   withdrawal.correct   اصلاح مبلغ/دلیل با دلیل اصلاح
-- هر دو فقط برای `admin` («مدیر کل» در Seed) و برای بقیهٔ نقش‌ها صریحاً
-- `false`. ثبت و دیدن برداشت **خود** مجوزی نمی‌خواهد: دادهٔ خودِ کاربر است.
-- در نصب تازه نقش‌ها پس از مهاجرت از Seed می‌آیند؛ همان ردیف‌ها در
-- `db/seed/084_withdrawal_permissions.sql` تکرار شده‌اند (الگوی ۰۸۱).
--
-- ── دامنهٔ شعبه ─────────────────────────────────────────────────────
-- شعبهٔ هر ثبت **در لحظهٔ ثبت** از نقش‌های مالک گرفته و ثابت می‌شود:
-- یک شعبهٔ مشخص اگر همهٔ نقش‌هایش همان یک شعبه‌اند؛ وگرنه NULL
-- («سراسری»)، که فقط مدیر دارای دامنهٔ همهٔ شعب می‌بیند. محافظه‌کار است:
-- ابهام هرگز به دید گسترده‌تر تبدیل نمی‌شود.
--
-- ⚠️ هیچ جدول پرسطری دست نمی‌خورد؛ فقط دو جدول تازه و خالی، پس قفل
--    طولانی روی تولید نمی‌گیرد.
-- =====================================================================

BEGIN;

CREATE TABLE identity.staff_withdrawal (
  id         uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  owner_id   uuid NOT NULL REFERENCES identity.app_user(id),
  branch_id  uuid REFERENCES platform.branch(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX staff_withdrawal_owner_idx  ON identity.staff_withdrawal (owner_id, created_at DESC, id DESC);
CREATE INDEX staff_withdrawal_recent_idx ON identity.staff_withdrawal (created_at DESC, id DESC);

COMMENT ON TABLE identity.staff_withdrawal IS
  'دفتر برداشت پرسنل — فقط ثبت، بی اثر مالی. مالک و زمان از سرور؛ فقط درج‌شدنی.';
COMMENT ON COLUMN identity.staff_withdrawal.branch_id IS
  'شعبهٔ مالک در لحظهٔ ثبت؛ NULL یعنی سراسری (فقط مدیر همهٔ شعب می‌بیند).';

CREATE TABLE identity.staff_withdrawal_revision (
  withdrawal_id uuid NOT NULL REFERENCES identity.staff_withdrawal(id),
  version       int  NOT NULL CHECK (version >= 1),
  amount        platform.money NOT NULL CHECK (amount >= 0),
  reason        text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  -- دلیل اصلاح مدیر؛ نسخهٔ ۱ (ثبت مالک) ندارد.
  note          text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  actor_id      uuid NOT NULL REFERENCES identity.app_user(id),
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (withdrawal_id, version),
  CONSTRAINT staff_withdrawal_revision_shape CHECK (
    (version = 1 AND note IS NULL AND amount > 0) OR (version > 1 AND note IS NOT NULL))
);

COMMENT ON TABLE identity.staff_withdrawal_revision IS
  'نسخه‌های هر ثبت برداشت. ۱ = ثبت مالک (مبلغ مثبت)، ۲.. = اصلاح مدیر (صفر مجاز، دلیل اجباری). فقط درج‌شدنی.';

-- ---------------------------------------------------------------------
-- ۱. کمکی‌های دامنه — یک تعریف، در Trigger و API
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.withdrawal_home_branch(p_user uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN count(*) = 0 OR bool_or(branch_id IS NULL) THEN NULL
           WHEN count(DISTINCT branch_id) = 1 THEN (array_agg(branch_id))[1]
           ELSE NULL
         END
    FROM identity.user_role WHERE user_id = p_user
$$;
COMMENT ON FUNCTION identity.withdrawal_home_branch IS
  'شعبهٔ ثبت برداشت: تنها شعبهٔ نقش‌های کاربر، وگرنه NULL (سراسری).';

CREATE FUNCTION identity.withdrawal_in_scope(p_actor uuid, p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM identity.user_role
                  WHERE user_id = p_actor AND (branch_id IS NULL OR branch_id = p_branch))
$$;
COMMENT ON FUNCTION identity.withdrawal_in_scope IS
  'آیا این ثبت در دامنهٔ شعبهٔ عامل است؟ ثبت سراسری (NULL) فقط برای نقش همهٔ شعب.';

-- ---------------------------------------------------------------------
-- ۲. تغییرناپذیری — هر دو جدول
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_withdrawal_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'دفتر برداشت فقط قابل درج است؛ اصلاح فقط با نسخهٔ تازه از مسیر مدیر ثبت می‌شود';
END $$;

CREATE TRIGGER staff_withdrawal_no_change
  BEFORE UPDATE OR DELETE ON identity.staff_withdrawal
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_immutable();
CREATE TRIGGER staff_withdrawal_no_truncate
  BEFORE TRUNCATE ON identity.staff_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION identity.staff_withdrawal_immutable();
CREATE TRIGGER staff_withdrawal_revision_no_change
  BEFORE UPDATE OR DELETE ON identity.staff_withdrawal_revision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_immutable();
CREATE TRIGGER staff_withdrawal_revision_no_truncate
  BEFORE TRUNCATE ON identity.staff_withdrawal_revision
  FOR EACH STATEMENT EXECUTE FUNCTION identity.staff_withdrawal_immutable();

-- ---------------------------------------------------------------------
-- ۳. سرآیند: مالک = عامل، شعبه و زمان از سرور
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_withdrawal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := platform.current_actor();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'ثبت برداشت بدون کاربر عامل مجاز نیست';
  END IF;
  IF NEW.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'برداشت فقط به نام خودِ کاربر واردشده ثبت می‌شود';
  END IF;
  PERFORM 1 FROM identity.app_user WHERE id = v_actor AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'کاربر غیرفعال برداشت ثبت نمی‌کند';
  END IF;
  IF NEW.branch_id IS DISTINCT FROM identity.withdrawal_home_branch(v_actor) THEN
    RAISE EXCEPTION 'شعبهٔ ثبت برداشت از نقش‌های کاربر گرفته می‌شود، نه از ورودی';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER staff_withdrawal_guard
  BEFORE INSERT ON identity.staff_withdrawal
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_guard();

-- ---------------------------------------------------------------------
-- ۴. نسخه: ترتیب، عامل، مجوز، دامنه — و حسابرسی پیش/پس
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.staff_withdrawal_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_head  identity.staff_withdrawal%ROWTYPE;
  v_last  int;
  v_ok    identity.permission_verdict;
BEGIN
  IF v_actor IS NULL OR NEW.actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'عامل نسخهٔ برداشت باید همان کاربر واردشده باشد';
  END IF;
  SELECT * INTO v_head FROM identity.staff_withdrawal WHERE id = NEW.withdrawal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ثبت برداشت یافت نشد';
  END IF;
  SELECT max(version) INTO v_last FROM identity.staff_withdrawal_revision
   WHERE withdrawal_id = NEW.withdrawal_id;

  IF NEW.version = 1 THEN
    IF v_last IS NOT NULL THEN
      RAISE EXCEPTION 'این ثبت برداشت پیش‌تر نسخهٔ نخست دارد';
    END IF;
    IF v_actor <> v_head.owner_id THEN
      RAISE EXCEPTION 'نسخهٔ نخست برداشت را فقط خودِ مالک ثبت می‌کند';
    END IF;
  ELSE
    IF v_last IS DISTINCT FROM NEW.version - 1 THEN
      RAISE EXCEPTION 'نسخهٔ برداشت قدیمی است؛ پیش از اصلاح دوباره بخوانید (آخرین نسخه: %)', coalesce(v_last, 0);
    END IF;
    SELECT verdict INTO v_ok FROM identity.can(v_actor, 'withdrawal.correct');
    IF v_ok IS DISTINCT FROM 'allow' THEN
      RAISE EXCEPTION 'اصلاح برداشت فقط با مجوز «withdrawal.correct» ممکن است';
    END IF;
    IF v_actor = v_head.owner_id THEN
      RAISE EXCEPTION 'مدیر برداشت خودش را اصلاح نمی‌کند؛ اصلاح باید از هویتی مستقل از مالک باشد';
    END IF;
    IF NOT identity.withdrawal_in_scope(v_actor, v_head.branch_id) THEN
      RAISE EXCEPTION 'این ثبت برداشت در دامنهٔ شعبهٔ شما نیست';
    END IF;
  END IF;
  NEW.at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER staff_withdrawal_revision_guard
  BEFORE INSERT ON identity.staff_withdrawal_revision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_revision_guard();

CREATE FUNCTION identity.staff_withdrawal_revision_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_owner uuid; v_prev identity.staff_withdrawal_revision%ROWTYPE;
BEGIN
  SELECT owner_id INTO v_owner FROM identity.staff_withdrawal WHERE id = NEW.withdrawal_id;
  IF NEW.version > 1 THEN
    SELECT * INTO v_prev FROM identity.staff_withdrawal_revision
     WHERE withdrawal_id = NEW.withdrawal_id AND version = NEW.version - 1;
  END IF;
  PERFORM platform.audit(
    CASE WHEN NEW.version = 1 THEN 'withdrawal.create' ELSE 'withdrawal.correct' END,
    'staff_withdrawal', NEW.withdrawal_id::text,
    jsonb_build_object('ownerId', v_owner, 'version', NEW.version,
                       'amount', NEW.amount::text, 'reason', NEW.reason),
    NEW.actor_id, NEW.note,
    CASE WHEN NEW.version = 1 THEN NULL ELSE
      jsonb_build_object('ownerId', v_owner, 'version', v_prev.version,
                         'amount', v_prev.amount::text, 'reason', v_prev.reason) END);
  RETURN NULL;
END $$;

CREATE TRIGGER staff_withdrawal_revision_audit
  AFTER INSERT ON identity.staff_withdrawal_revision
  FOR EACH ROW EXECUTE FUNCTION identity.staff_withdrawal_revision_audit();

-- ---------------------------------------------------------------------
-- ۵. دروازه‌ها — بی هیچ پارامتر مالک
-- ---------------------------------------------------------------------
CREATE FUNCTION identity.record_withdrawal(p_amount platform.money, p_reason text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := platform.current_actor(); v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'مبلغ برداشت باید بیشتر از صفر باشد';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'دلیل برداشت را بنویسید';
  END IF;
  INSERT INTO identity.staff_withdrawal (owner_id, branch_id)
  VALUES (v_actor, identity.withdrawal_home_branch(v_actor))
  RETURNING id INTO v_id;
  INSERT INTO identity.staff_withdrawal_revision (withdrawal_id, version, amount, reason, actor_id)
  VALUES (v_id, 1, p_amount, btrim(p_reason), v_actor);
  RETURN v_id;
END $$;
COMMENT ON FUNCTION identity.record_withdrawal IS
  'ثبت برداشت به نام کاربر عامل (platform.set_actor). مالکی از ورودی نمی‌گیرد؛ اثر مالی ندارد.';

CREATE FUNCTION identity.correct_withdrawal(
  p_id uuid, p_expected_version int, p_amount platform.money, p_reason text, p_note text
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := platform.current_actor(); v_cur identity.staff_withdrawal_revision%ROWTYPE;
BEGIN
  -- قفل سرآیند: دو اصلاح هم‌زمان پشت هم صف می‌کشند و دومی «قدیمی» می‌شود.
  PERFORM 1 FROM identity.staff_withdrawal WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ثبت برداشت یافت نشد';
  END IF;
  SELECT * INTO v_cur FROM identity.staff_withdrawal_revision
   WHERE withdrawal_id = p_id ORDER BY version DESC LIMIT 1;
  IF v_cur.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'نسخهٔ برداشت قدیمی است؛ پیش از اصلاح دوباره بخوانید (آخرین نسخه: %)', v_cur.version;
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'مبلغ اصلاح‌شده نمی‌تواند منفی باشد';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'دلیل برداشت نمی‌تواند خالی باشد';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'دلیل اصلاح را بنویسید';
  END IF;
  IF p_amount = v_cur.amount AND btrim(p_reason) = v_cur.reason THEN
    RAISE EXCEPTION 'اصلاح تغییری در مبلغ یا دلیل ندارد';
  END IF;
  INSERT INTO identity.staff_withdrawal_revision (withdrawal_id, version, amount, reason, note, actor_id)
  VALUES (p_id, v_cur.version + 1, p_amount, btrim(p_reason), btrim(p_note), v_actor);
  RETURN v_cur.version + 1;
END $$;
COMMENT ON FUNCTION identity.correct_withdrawal IS
  'اصلاح برداشت با شرط نسخه. مجوز، استقلال از مالک و دامنه در Trigger نسخه سنجیده می‌شوند.';

-- ---------------------------------------------------------------------
-- ۶. نمای جاری — آخرین نسخهٔ هر ثبت
-- ---------------------------------------------------------------------
CREATE VIEW identity.staff_withdrawal_current AS
SELECT w.id, w.owner_id, w.branch_id, w.created_at,
       r.version, r.amount, r.reason, r.note AS last_note,
       CASE WHEN r.version > 1 THEN r.at END AS corrected_at,
       CASE WHEN r.version > 1 THEN r.actor_id END AS corrected_by
  FROM identity.staff_withdrawal w
  JOIN LATERAL (SELECT * FROM identity.staff_withdrawal_revision x
                 WHERE x.withdrawal_id = w.id ORDER BY x.version DESC LIMIT 1) r ON true;

-- ---------------------------------------------------------------------
-- ۷. مجوزها — نصب موجود (نصب تازه: db/seed/084_withdrawal_permissions.sql)
-- ---------------------------------------------------------------------
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,o.operation,(r.code='admin'),NULL,NULL,NULL
FROM identity.role r CROSS JOIN (VALUES ('withdrawal.view_all'),('withdrawal.correct')) AS o(operation)
ON CONFLICT (role_code,operation) DO NOTHING;

COMMIT;
