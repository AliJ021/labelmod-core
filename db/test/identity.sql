-- =====================================================================
-- تست نشست، دستگاه، قفل ورود و مجوز
-- =====================================================================
-- پوشش: بند ۱ SECURITY.md — توکن مات، ابطال فوری همه نشست‌ها، قفل ۱۵
-- دقیقه‌ای روی «کاربر + دستگاه»، سه شرط PIN، و مجوز از
-- identity.permission_rule بدون هیچ شرط hardcode.
--
-- ادعای مرکزی: هیچ مسیری نباید بتواند نشستی را معتبر بگیرد که منقضی،
-- باطل یا قفل است — و PIN هرگز نباید عملیات حساس را باز کند.
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

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- هش توکن، همان کاری که لایه Node می‌کند
CREATE OR REPLACE FUNCTION pg_temp.tok(p_seed text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(p_seed, 'sha256'), 'hex');
$$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  v_admin uuid; v_cashier uuid; v_sup uuid;
  v_dev uuid; v_dev2 uuid;
  v_s1 uuid; v_s2 uuid; v_n int;
  v_verdict identity.permission_verdict; v_approver text; v_reason text;
  r record;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('mgr','مدیر تست')
  RETURNING id INTO v_admin;
INSERT INTO identity.app_user (username, full_name) VALUES ('cash1','صندوق‌دار تست')
  RETURNING id INTO v_cashier;
INSERT INTO identity.app_user (username, full_name) VALUES ('sup1','سرپرست تست')
  RETURNING id INTO v_sup;
PERFORM platform.set_actor(v_admin);

INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES
  (v_admin,   'admin',      BR),
  (v_cashier, 'cashier',    BR),
  (v_sup,     'supervisor', BR);

INSERT INTO identity.device (fingerprint, label, kind, branch_id)
  VALUES ('fp-pos-1', 'تبلت صندوق ۱', 'pos', BR) RETURNING id INTO v_dev;
INSERT INTO identity.device (fingerprint, label, kind, branch_id)
  VALUES ('fp-unknown', 'دستگاه ناشناس', 'other', BR) RETURNING id INTO v_dev2;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. نشست: ساخت، اعتبارسنجی، ابطال ═══';
-- ═══════════════════════════════════════════════════════════════════

v_s1 := identity.open_session(v_cashier, pg_temp.tok('t1'), 'password', v_dev,
                              '10.0.0.5'::inet, 'POS/1.0');

SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('t1'));
PERFORM pg_temp.assert_eq('نشست تازه معتبر است', v_n, 1);

PERFORM pg_temp.assert_eq('خودِ توکن هیچ‌جا ذخیره نشده',
  (SELECT count(*) FROM identity.session WHERE token_hash = 't1'), 0);

PERFORM pg_temp.assert_eq('عمر نشست پرسنل از تنظیم خوانده شد',
  (SELECT round(extract(epoch FROM (expires_at - issued_at)) / 3600)
     FROM identity.session WHERE id = v_s1), 12);

-- توکن اشتباه هیچ سطری نمی‌دهد
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('نادرست'));
PERFORM pg_temp.assert_eq('توکن نادرست نشستی نمی‌دهد', v_n, 0);

PERFORM pg_temp.assert_eq('ابطال نشست',
  identity.revoke_session(pg_temp.tok('t1'), 'logout')::int, 1);
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('t1'));
PERFORM pg_temp.assert_eq('نشست باطل‌شده دیگر معتبر نیست', v_n, 0);
PERFORM pg_temp.assert_eq('ابطال دوباره اثری ندارد',
  identity.revoke_session(pg_temp.tok('t1'), 'logout')::int, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. خروج اجباری همه نشست‌ها — الزام «گوشی مفقودی» ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM identity.open_session(v_cashier, pg_temp.tok('a'), 'password', v_dev);
PERFORM identity.open_session(v_cashier, pg_temp.tok('b'), 'password', v_dev2);
PERFORM identity.open_session(v_cashier, pg_temp.tok('c'), 'webauthn', NULL);
PERFORM identity.open_session(v_sup,     pg_temp.tok('d'), 'password', v_dev);

PERFORM pg_temp.assert_eq('همه نشست‌های صندوق‌دار باطل شدند',
  identity.revoke_all_sessions(v_cashier, 'device_lost', v_admin), 3);

SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('a'));
PERFORM pg_temp.assert_eq('نشست اول مرد', v_n, 0);
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('c'));
PERFORM pg_temp.assert_eq('نشست سوم هم مرد', v_n, 0);
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('d'));
PERFORM pg_temp.assert_eq('نشست کاربر دیگر دست‌نخورده ماند', v_n, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. نشست منقضی ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM identity.open_session(v_sup, pg_temp.tok('old'), 'password', v_dev);
UPDATE identity.session SET issued_at = now() - interval '20 hours',
                            expires_at = now() - interval '8 hours'
 WHERE token_hash = pg_temp.tok('old');
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('old'));
PERFORM pg_temp.assert_eq('نشست منقضی معتبر نیست', v_n, 0);

PERFORM pg_temp.assert_raises('نشست با انقضای پیش از صدور',
  format('INSERT INTO identity.session (token_hash,user_id,auth_method,expires_at)
          VALUES (%L,%L,''password'', now() - interval ''1 hour'')',
         pg_temp.tok('bad'), v_sup));

PERFORM pg_temp.assert_raises('هش توکن با شکل نادرست',
  format('INSERT INTO identity.session (token_hash,user_id,auth_method,expires_at)
          VALUES (''توکن-خام'',%L,''password'', now() + interval ''1 hour'')', v_sup));

PERFORM pg_temp.assert_raises('نشست برای کاربر غیرفعال',
  format('SELECT identity.open_session(%L,%L,''password'')',
         '00000000-0000-0000-0000-000000000000', pg_temp.tok('ghost')));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. قفل پس از پنج تلاش ناموفق ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('پیش از تلاش، قفل نیست',
  identity.is_locked(v_cashier, v_dev)::int, 0);

INSERT INTO identity.auth_attempt (kind, username, user_id, device_id, succeeded, failure_code)
SELECT 'password','cash1',v_cashier,v_dev,false,'bad_password' FROM generate_series(1,4);
PERFORM pg_temp.assert_eq('چهار تلاش ناموفق هنوز قفل نمی‌کند',
  identity.is_locked(v_cashier, v_dev)::int, 0);

INSERT INTO identity.auth_attempt (kind, username, user_id, device_id, succeeded, failure_code)
VALUES ('password','cash1',v_cashier,v_dev,false,'bad_password');
PERFORM pg_temp.assert_eq('پنجمین تلاش قفل می‌کند',
  identity.is_locked(v_cashier, v_dev)::int, 1);

-- قفل روی «کاربر + دستگاه» است: دستگاه دیگرِ همان کاربر باز می‌ماند،
-- وگرنه هر کسی می‌تواند با پنج تلاش غلط صندوق‌دار را از کار بیندازد.
PERFORM pg_temp.assert_eq('دستگاه دیگر همان کاربر قفل نیست',
  identity.is_locked(v_cashier, v_dev2)::int, 0);
PERFORM pg_temp.assert_eq('کاربر دیگر روی همان دستگاه قفل نیست',
  identity.is_locked(v_sup, v_dev)::int, 0);

-- ورود موفق شمارش را صفر می‌کند
INSERT INTO identity.auth_attempt (kind, username, user_id, device_id, succeeded)
VALUES ('password','cash1',v_cashier,v_dev,true);
PERFORM pg_temp.assert_eq('ورود موفق قفل را باز می‌کند',
  identity.is_locked(v_cashier, v_dev)::int, 0);

-- تلاش قدیمی‌تر از پنجره شمرده نمی‌شود
INSERT INTO identity.auth_attempt (at, kind, username, user_id, device_id, succeeded)
SELECT now() - interval '30 minutes','password','cash1',v_cashier,v_dev2,false
  FROM generate_series(1,6);
PERFORM pg_temp.assert_eq('تلاش خارج از پنجره ۱۵ دقیقه‌ای شمرده نمی‌شود',
  identity.is_locked(v_cashier, v_dev2)::int, 0);

PERFORM pg_temp.assert_raises('تغییر تلاش احراز هویت',
  format('UPDATE identity.auth_attempt SET succeeded = true WHERE user_id = %L', v_cashier));
PERFORM pg_temp.assert_raises('حذف تلاش احراز هویت',
  format('DELETE FROM identity.auth_attempt WHERE user_id = %L', v_cashier));

-- پاکسازی یک مسیر نگهداری است، نه یک در پشتی: حتی با پرچم روشن، سطر
-- داخل پنجره نگهداری پاک نمی‌شود. کسی که به اپلیکیشن نفوذ کرده نباید
-- بتواند ردّ تلاش‌های خودش را بشوید.
PERFORM set_config('labelmod.auth_purge', 'on', true);
PERFORM pg_temp.assert_raises('پاکسازی تلاش تازه، حتی با پرچم روشن',
  format('DELETE FROM identity.auth_attempt WHERE user_id = %L', v_cashier));
PERFORM set_config('labelmod.auth_purge', '', true);

SELECT count(*) INTO v_n FROM identity.auth_attempt;
INSERT INTO identity.auth_attempt (at, kind, username, user_id, device_id, succeeded)
VALUES (now() - interval '400 days','password','قدیمی',v_cashier,v_dev,false);
PERFORM pg_temp.assert_eq('پاکسازی فقط تلاش کهنه‌تر از پنجره را می‌برد',
  identity.purge_auth_attempts(v_admin), 1);
PERFORM pg_temp.assert_eq('تلاش‌های داخل پنجره دست‌نخورده ماندند',
  (SELECT count(*) FROM identity.auth_attempt), v_n);

-- و خودِ پاکسازی یک رد در لاگ حسابرسی می‌گذارد
PERFORM pg_temp.assert_eq('پاکسازی در لاگ حسابرسی ثبت شد',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'auth.purge_attempts'), 1);

-- نشست منقضی پس از دوره نگهداری پاک می‌شود
PERFORM identity.open_session(v_sup, pg_temp.tok('stale'), 'password', v_dev);
UPDATE identity.session SET issued_at = now() - interval '200 days',
                            expires_at = now() - interval '199 days'
 WHERE token_hash = pg_temp.tok('stale');
PERFORM pg_temp.assert_eq('نشست کهنه پاک شد',
  identity.purge_sessions(v_admin), 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. PIN: سه شرط، هر سه لازم ═══';
-- ═══════════════════════════════════════════════════════════════════

-- دستگاه هنوز تأیید نشده
PERFORM pg_temp.assert_eq('PIN روی دستگاه تأییدنشده مجاز نیست',
  identity.pin_allowed(v_cashier, v_dev)::int, 0);

UPDATE identity.device SET is_approved = true, approved_by = v_admin, approved_at = now()
 WHERE id = v_dev;
PERFORM pg_temp.assert_eq('PIN پس از تأیید دستگاه و ورود امروز مجاز است',
  identity.pin_allowed(v_cashier, v_dev)::int, 1);

-- کاربری که امروز روی این دستگاه ورود کامل نکرده
PERFORM pg_temp.assert_eq('PIN بدون ورود کامل امروز مجاز نیست',
  identity.pin_allowed(v_sup, v_dev)::int, 0);
PERFORM pg_temp.assert_eq('PIN بدون دستگاه مجاز نیست',
  identity.pin_allowed(v_cashier, NULL)::int, 0);

PERFORM pg_temp.assert_raises('تأیید دستگاه بدون ثبت تأییدکننده',
  format('UPDATE identity.device SET is_approved = true WHERE id = %L', v_dev2));

-- قفل صفحه و باز کردنش
v_s2 := identity.open_session(v_cashier, pg_temp.tok('lock'), 'password', v_dev);
PERFORM pg_temp.assert_eq('قفل صفحه', identity.lock_session(pg_temp.tok('lock'))::int, 1);
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('lock'));
PERFORM pg_temp.assert_eq('نشست قفل‌شده کاری نمی‌کند', v_n, 0);

PERFORM pg_temp.assert_eq('باز کردن قفل با PIN',
  identity.unlock_session(pg_temp.tok('lock'), v_cashier)::int, 1);
SELECT count(*) INTO v_n FROM identity.session_from_token(pg_temp.tok('lock'));
PERFORM pg_temp.assert_eq('نشست پس از باز شدن دوباره کار می‌کند', v_n, 1);

PERFORM pg_temp.assert_raises('باز کردن قفل نشست کاربر دیگر',
  format('SELECT identity.unlock_session(%L,%L)', pg_temp.tok('lock'), v_sup));

-- نشست روی دستگاه تأییدنشده با PIN باز نمی‌شود
PERFORM identity.open_session(v_cashier, pg_temp.tok('lock2'), 'password', v_dev2);
PERFORM identity.lock_session(pg_temp.tok('lock2'));
PERFORM pg_temp.assert_raises('باز کردن قفل روی دستگاه تأییدنشده',
  format('SELECT identity.unlock_session(%L,%L)', pg_temp.tok('lock2'), v_cashier));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. مجوز از permission_rule، نه از شرط در کد ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO r FROM identity.can(v_cashier, 'sale.create');
PERFORM pg_temp.assert_txt('صندوق‌دار می‌تواند فروش بزند', r.verdict::text, 'allow');

SELECT * INTO r FROM identity.can(v_cashier, 'refund.cash');
PERFORM pg_temp.assert_txt('صندوق‌دار بازپرداخت نقدی نمی‌تواند', r.verdict::text, 'deny');

SELECT * INTO r FROM identity.can(v_cashier, 'sale.discount', NULL, 8);
PERFORM pg_temp.assert_txt('تخفیف ۸٪ زیر سقف صندوق‌دار', r.verdict::text, 'allow');

SELECT * INTO r FROM identity.can(v_cashier, 'sale.discount_high', NULL, 20);
PERFORM pg_temp.assert_txt('تخفیف ۲۰٪ تأیید سرپرست می‌خواهد', r.verdict::text, 'needs_approval');
PERFORM pg_temp.assert_txt('تأییدکننده', r.approver, 'supervisor');

SELECT * INTO r FROM identity.can(v_cashier, 'sale.discount_high', NULL, 40);
PERFORM pg_temp.assert_txt('تخفیف ۴۰٪ از سقف سرپرست هم می‌گذرد',
  r.verdict::text, 'needs_approval');

SELECT * INTO r FROM identity.can(v_admin, 'sale.discount', NULL, 90);
PERFORM pg_temp.assert_txt('مدیر سقف تخفیف ندارد', r.verdict::text, 'allow');

SELECT * INTO r FROM identity.can(v_cashier, 'عملیات_ناموجود');
PERFORM pg_temp.assert_txt('عملیات بدون قاعده، ممنوع است', r.verdict::text, 'deny');

-- سقف داده است: بالا بردنش همان درخواست را مجاز می‌کند
UPDATE identity.permission_rule SET max_percent = 30
 WHERE role_code = 'cashier' AND operation = 'sale.discount';
SELECT * INTO r FROM identity.can(v_cashier, 'sale.discount', NULL, 25);
PERFORM pg_temp.assert_txt('پس از بالا بردن سقف در جدول', r.verdict::text, 'allow');
UPDATE identity.permission_rule SET max_percent = 10
 WHERE role_code = 'cashier' AND operation = 'sale.discount';

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. PIN هرگز عملیات حساس را باز نمی‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════

-- مدیر بدون قید هر کاری می‌تواند — ولی نه از مسیر PIN
SELECT * INTO r FROM identity.can(v_admin, 'refund.cash');
PERFORM pg_temp.assert_txt('مدیر با احراز کامل: بازپرداخت نقدی', r.verdict::text, 'allow');

SELECT * INTO r FROM identity.can(v_admin, 'refund.cash', NULL, NULL, true);
PERFORM pg_temp.assert_txt('همان مدیر از مسیر PIN: ممنوع', r.verdict::text, 'deny');

SELECT * INTO r FROM identity.can(v_admin, 'invoice.cancel', NULL, NULL, true);
PERFORM pg_temp.assert_txt('ابطال فاکتور با PIN: ممنوع', r.verdict::text, 'deny');

SELECT * INTO r FROM identity.can(v_admin, 'stock.adjust', NULL, NULL, true);
PERFORM pg_temp.assert_txt('اصلاح موجودی با PIN: ممنوع', r.verdict::text, 'deny');

SELECT * INTO r FROM identity.can(v_cashier, 'sale.create', NULL, NULL, true);
PERFORM pg_temp.assert_txt('فروش عادی با PIN: مجاز', r.verdict::text, 'allow');

-- فهرست ممنوعه داده است، نه کد
UPDATE platform.setting SET value = '[]'::jsonb
 WHERE key = 'auth.pin_forbidden_operations';
SELECT * INTO r FROM identity.can(v_admin, 'refund.cash', NULL, NULL, true);
PERFORM pg_temp.assert_txt('پس از خالی‌کردن فهرست ممنوعه', r.verdict::text, 'allow');
UPDATE platform.setting SET value =
 '["refund.cash","invoice.cancel","price.change","stock.adjust","period.close","period.reopen","user.manage","journal.manual","return.late"]'::jsonb
 WHERE key = 'auth.pin_forbidden_operations';

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('نشست بدون هش ۶۴ کاراکتری هگز',
  (SELECT count(*) FROM identity.session WHERE token_hash !~ '^[0-9a-f]{64}$'), 0);

PERFORM pg_temp.assert_eq('نشست با انقضای پیش از صدور',
  (SELECT count(*) FROM identity.session WHERE expires_at <= issued_at), 0);

PERFORM pg_temp.assert_eq('دستگاه تأییدشده بدون تأییدکننده',
  (SELECT count(*) FROM identity.device
    WHERE is_approved AND (approved_by IS NULL OR approved_at IS NULL)), 0);

-- هر نشست موجود باید ردّ باز شدنش را در لاگ داشته باشد. نشستی که
-- بی‌صدا ساخته شود، یعنی مسیری platform.audit را دور زده.
PERFORM pg_temp.assert_eq('نشست بدون ردّ باز شدن در لاگ حسابرسی',
  (SELECT count(*) FROM identity.session s
    WHERE NOT EXISTS (
      SELECT 1 FROM platform.audit_log a
       WHERE a.action = 'session.open' AND a.entity_id = s.id::text)), 0);

PERFORM pg_temp.assert_eq('ابطال و باز کردن قفل هم ثبت شده‌اند',
  ((SELECT count(*) FROM platform.audit_log
     WHERE action IN ('session.revoke','session.revoke_all','session.unlock')) > 0)::int, 1);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تمام تست‌های نشست و مجوز پاس شدند     ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
