-- =====================================================================
-- تست مدیریت دستگاه و ابطال دسترسی
-- =====================================================================
-- زنجیره ADR-005 تا امروز یک گام گمشده داشت: هیچ مسیر تولیدی‌ای
-- `identity.approve_device()` را صدا نمی‌زد. توابع درست بودند و تست
-- هم داشتند، ولی محصول نمی‌توانست دستگاهی را تأیید کند — پس PIN
-- صندوق‌دار هرگز باز نمی‌شد.
--
-- سه ادعای مرکزی اینجا:
--
-- ۱. **زنجیره کامل کار می‌کند**: ثبت‌نشده → تأیید → ثبت‌نام → PIN باز
--    می‌شود؛ و هیچ‌کدام از این گام‌ها قابل پرش نیست.
--
-- ۲. **ابطال، نشست را هم می‌بندد.** دستگاهی که اعتمادش برداشته شده
--    ولی نشستش زنده مانده، بدتر از دستگاه تأییدنشده است.
--
-- ۳. **`device.manage` با PIN مجاز نیست.** وگرنه کسی که PIN را دارد
--    دستگاه خودش را «مورد اعتماد» می‌کرد و کل دفاع لایه‌ای فرو
--    می‌ریخت.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual numeric, p_expected numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_bool(
  p_label text, p_actual boolean, p_expected boolean
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual, '(تهی)');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 74);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR      uuid := '00000000-0000-7000-8000-000000000001';
  v_admin uuid; v_cash uuid; v_dev uuid; v_dev2 uuid;
  v_sess  uuid; v_n int; v_txt text;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('dadmin','مدیر دستگاه')
  RETURNING id INTO v_admin;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_admin,'admin',BR);
INSERT INTO identity.app_user (username, full_name, pin_hash)
  VALUES ('dcash','صندوق‌دار دستگاه','$argon2id$fake') RETURNING id INTO v_cash;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_cash,'cashier',BR);
PERFORM platform.set_actor(v_admin);

RAISE NOTICE E'\n═══ ۱. مجوز device.manage در داده است، نه در کد ═══';

SELECT verdict INTO v_txt FROM identity.can(v_admin, 'device.manage');
PERFORM pg_temp.assert_txt('مدیر می‌تواند دستگاه را مدیریت کند', v_txt, 'allow');
SELECT verdict INTO v_txt FROM identity.can(v_cash, 'device.manage');
PERFORM pg_temp.assert_txt('صندوق‌دار نمی‌تواند', v_txt, 'deny');
SELECT verdict INTO v_txt FROM identity.can(v_admin, 'device.manage', NULL, NULL, true);
PERFORM pg_temp.assert_txt('و با PIN حتی مدیر هم نمی‌تواند', v_txt, 'deny');
PERFORM pg_temp.assert_bool('device.manage در فهرست ممنوعه PIN است', (
  SELECT value ? 'device.manage' FROM platform.setting
   WHERE key = 'auth.pin_forbidden_operations'), true);

RAISE NOTICE E'\n═══ ۲. زنجیره: ثبت‌نشده → تأیید → ثبت‌نام ═══';

INSERT INTO identity.device (fingerprint, label, kind, branch_id)
VALUES ('fp-test-tablet-1', 'دستگاه ناشناس', 'pos', BR) RETURNING id INTO v_dev;

PERFORM pg_temp.assert_bool('دستگاه تازه تأیید نشده',
  (SELECT is_approved FROM identity.device WHERE id = v_dev), false);
PERFORM pg_temp.assert_bool('و ثبت‌نام هم نشده',
  (SELECT secret_hash IS NULL FROM identity.device WHERE id = v_dev), true);

-- ثبت‌نام پیش از تأیید ممکن نیست — قید دیتابیس، نه لایه API
PERFORM pg_temp.assert_bool('ثبت‌نام دستگاه تأییدنشده رد می‌شود',
  identity.enroll_device(v_dev, repeat('a', 64), v_admin), false);

PERFORM pg_temp.assert_bool('تأیید مدیر',
  identity.approve_device(v_dev, v_admin), true);
PERFORM pg_temp.assert_bool('حالا تأیید شده',
  (SELECT is_approved FROM identity.device WHERE id = v_dev), true);
PERFORM pg_temp.assert_eq('تأییدکننده ثبت شد',
  (SELECT CASE WHEN approved_by = v_admin THEN 1 ELSE 0 END
     FROM identity.device WHERE id = v_dev), 1);
PERFORM pg_temp.assert_eq('و در لاگ حسابرسی نشست', (
  SELECT count(*) FROM platform.audit_log
   WHERE action = 'device.approve' AND entity_id = v_dev::text), 1);

PERFORM pg_temp.assert_bool('حالا ثبت‌نام ممکن است',
  identity.enroll_device(v_dev, repeat('b', 64), v_cash), true);
PERFORM pg_temp.assert_bool('راز نشست',
  (SELECT secret_hash IS NOT NULL FROM identity.device WHERE id = v_dev), true);

RAISE NOTICE E'\n═══ ۳. تأییدِ دوباره، ثبت‌نام را پاک می‌کند ═══';

-- دستگاهی که یک بار باطل و دوباره تأیید شود، باید راز تازه بگیرد.
-- رازِ قدیمی که شاید کپی شده باشد نباید کار کند.
PERFORM identity.approve_device(v_dev, v_admin);
PERFORM pg_temp.assert_bool('راز قبلی پاک شد',
  (SELECT secret_hash IS NULL FROM identity.device WHERE id = v_dev), true);
PERFORM identity.enroll_device(v_dev, repeat('c', 64), v_cash);

RAISE NOTICE E'\n═══ ۴. ابطال، نشست زنده را هم می‌بندد ═══';

INSERT INTO identity.session
  (token_hash, user_id, device_id, subject, auth_method, expires_at)
VALUES (repeat('1', 64), v_cash, v_dev, 'staff', 'password', now() + interval '12 hours')
RETURNING id INTO v_sess;
INSERT INTO identity.session
  (token_hash, user_id, device_id, subject, auth_method, expires_at)
VALUES (repeat('2', 64), v_cash, v_dev, 'staff', 'password', now() + interval '12 hours');

PERFORM pg_temp.assert_eq('دو نشست زنده روی این دستگاه', (
  SELECT count(*) FROM identity.session
   WHERE device_id = v_dev AND revoked_at IS NULL), 2);

PERFORM pg_temp.assert_eq('ابطال، هر دو را بست',
  identity.revoke_device(v_dev, v_admin, 'lost_tablet'), 2);
PERFORM pg_temp.assert_eq('هیچ نشست زنده‌ای نماند', (
  SELECT count(*) FROM identity.session
   WHERE device_id = v_dev AND revoked_at IS NULL), 0);
PERFORM pg_temp.assert_bool('اعتماد برداشته شد',
  (SELECT is_approved FROM identity.device WHERE id = v_dev), false);
PERFORM pg_temp.assert_bool('و راز ثبت‌نام هم پاک شد',
  (SELECT secret_hash IS NULL FROM identity.device WHERE id = v_dev), true);
PERFORM pg_temp.assert_eq('دلیل ابطال روی نشست ثبت شد', (
  SELECT count(*) FROM identity.session
   WHERE device_id = v_dev AND revoke_reason = 'lost_tablet'), 2);
PERFORM pg_temp.assert_eq('و در لاگ حسابرسی', (
  SELECT count(*) FROM platform.audit_log
   WHERE action = 'device.revoke' AND entity_id = v_dev::text), 1);

RAISE NOTICE E'\n═══ ۵. ابطال دسترسی یک کاربر — «گوشی گم شد» ═══';

INSERT INTO identity.device (fingerprint, label, kind, branch_id)
VALUES ('fp-test-phone', 'گوشی', 'mobile', BR) RETURNING id INTO v_dev2;
PERFORM identity.approve_device(v_dev2, v_admin);

INSERT INTO identity.session
  (token_hash, user_id, device_id, subject, auth_method, expires_at)
VALUES (repeat('3', 64), v_cash, v_dev2, 'staff', 'password', now() + interval '12 hours');
INSERT INTO identity.session
  (token_hash, user_id, device_id, subject, auth_method, expires_at)
VALUES (repeat('4', 64), v_cash, NULL, 'staff', 'password', now() + interval '12 hours');

PERFORM pg_temp.assert_eq('دو نشست زنده برای این کاربر', (
  SELECT count(*) FROM identity.session
   WHERE user_id = v_cash AND revoked_at IS NULL), 2);

PERFORM pg_temp.assert_eq('ابطال دسترسی کاربر، هر دو را بست — حتی نشست بی‌دستگاه',
  identity.revoke_user_access(v_cash, 'lost_phone'), 2);
PERFORM pg_temp.assert_eq('هیچ نشستی نماند', (
  SELECT count(*) FROM identity.session
   WHERE user_id = v_cash AND revoked_at IS NULL), 0);

-- ⚠️ دستگاه دست‌نخورده می‌ماند: «گوشی گم شد» یعنی نشست‌ها بسته شوند،
--    نه اینکه تبلت صندوق هم اعتمادش برود.
PERFORM pg_temp.assert_bool('دستگاه دست‌نخورده ماند',
  (SELECT is_approved FROM identity.device WHERE id = v_dev2), true);

PERFORM pg_temp.assert_raises('کاربر ناموجود رد می‌شود',
  format('SELECT identity.revoke_user_access(%L)', '00000000-0000-7000-8000-0000000000ff'));

RAISE NOTICE E'\n═══ ۶. بدون کاربر عامل ═══';

PERFORM set_config('labelmod.actor_id', '', true);
PERFORM pg_temp.assert_raises('revoke_user_access بدون کاربر عامل',
  format('SELECT identity.revoke_user_access(%L)', v_cash));
PERFORM platform.set_actor(v_admin);

RAISE NOTICE E'\n═══ ۷. نمای دستگاه — و آنچه در آن نیست ═══';

PERFORM pg_temp.assert_eq('هر دو دستگاه در نما هستند', (
  SELECT count(*) FROM identity.device_overview
   WHERE id IN (v_dev, v_dev2)), 2);
PERFORM pg_temp.assert_bool('نما «ثبت‌نام‌شده» را می‌گوید', (
  SELECT enrolled FROM identity.device_overview WHERE id = v_dev), false);
PERFORM pg_temp.assert_eq('و تعداد نشست زنده را', (
  SELECT active_sessions FROM identity.device_overview WHERE id = v_dev2), 0);

-- راز دستگاه هرگز از نما بیرون نمی‌رود
PERFORM pg_temp.assert_eq('secret_hash در نما نیست', (
  SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'identity' AND table_name = 'device_overview'
     AND column_name = 'secret_hash'), 0);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تست مدیریت دستگاه پاس شد              ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
