-- =====================================================================
-- دروازهٔ نوشتن: هر تابعی که به جدول‌های قفل‌شده می‌نویسد، DEFINER است
-- =====================================================================
-- `ops/db-roles.sh` حق `INSERT/UPDATE/DELETE` روی سه جدول را از **نقش
-- برنامه** می‌گیرد:
--
--     inventory.stock_movement · inventory.stock_balance · inventory.cost_layer
--
-- پس هر تابعی که به آن‌ها می‌نویسد باید به‌نام **مالک** اجرا شود، وگرنه
-- در لحظه‌ای که `DATABASE_URL` برنامه به `labelmod_app` عوض شود
-- «permission denied» می‌دهد — روی سیستم زنده.
--
-- ── چرا این تست لازم شد ────────────────────────────────────────────
--
-- مهاجرت ۰۵۰ فقط `apply_movement` را DEFINER کرد و `db/test/db-roles.sh`
-- فقط همان یکی را به‌عنوان «دروازه» می‌شناخت. دو تابع دیگر جا مانده
-- بودند و **هیچ تستی قرمز نشد**، چون هر ۱۲۳۳ ادعای SQL و هر ۶۵۴ ادعای
-- API با نقش **مالک** اجرا می‌شوند و مالک همه‌چیز را می‌تواند.
-- اندازه‌گیری شد: اجرای همان مجموعه با نقش محدود، ۳۰ شکست داد.
--
-- شمردنِ تابع‌ها در یک فهرست، همان اشتباه را دوباره می‌ساخت. اینجا
-- **کلاس** بسته می‌شود: کاتالوگ خوانده می‌شود، نه یک فهرست دستی.
--
-- ⚠️ `SELECT … FOR UPDATE` هم حساب می‌شود و این ظریف‌ترین بخش است:
--    پستگرس برای قفل‌گرفتن سطر، حق **UPDATE** می‌خواهد نه SELECT. یک
--    `FOR UPDATE` بی‌ضرر دقیقاً همان‌جا می‌شکند و پیام خطا هیچ اشاره‌ای
--    به `FOR UPDATE` ندارد.
--
-- ⚠️ بند ۳ **کنترل مثبت** است: آشکارساز باید واقعاً چیزی پیدا کند.
--    یک Regex که هیچ‌وقت Match نشود هم «پاس» می‌شد.
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

-- توابعی که به جدول‌های قفل‌شده **می‌نویسند یا قفلشان می‌کنند**.
CREATE OR REPLACE VIEW pg_temp.locked_table_writers AS
SELECT n.nspname || '.' || p.proname AS fn,
       p.prosecdef,
       p.proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prokind = 'f'
   AND n.nspname IN ('platform','identity','catalog','inventory',
                     'purchasing','sales','treasury','ledger')
   AND (
        -- نوشتن مستقیم
        p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+(inventory\.)?(stock_movement|stock_balance|cost_layer)[[:space:]]'
        -- یا قفل سطر، که در پستگرس حق UPDATE می‌خواهد
     OR p.prosrc ~* '(from|join)[[:space:]]+(inventory\.)?(stock_movement|stock_balance|cost_layer)[^;]*for[[:space:]]+update'
   );

\echo '── ۱. هر نویسندهٔ جدول قفل‌شده باید SECURITY DEFINER باشد ──'
DO $$
DECLARE r record; v_bad int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp.locked_table_writers WHERE NOT prosecdef LOOP
    RAISE WARNING '  ✗ % به جدول قفل‌شده می‌نویسد ولی SECURITY DEFINER نیست', r.fn;
    v_bad := v_bad + 1;
  END LOOP;
  IF v_bad > 0 THEN
    RAISE EXCEPTION E'\n  ✗ % تابع با نقش برنامه خواهند شکست (ops/db-roles.sh)', v_bad;
  END IF;
  RAISE NOTICE '  ✓ همهٔ نویسندگان جدول‌های قفل‌شده DEFINERاند';
END $$;

\echo '── ۲. هر SECURITY DEFINER باید search_path پین‌شده داشته باشد ──'
-- بی این پین، `SECURITY DEFINER` خودش یک راه ارتقای دسترسی است.
DO $$
DECLARE r record; v_bad int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname || '.' || p.proname AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname IN ('platform','identity','catalog','inventory',
                         'purchasing','sales','treasury','ledger')
       AND NOT coalesce(
             (SELECT bool_or(c ~* '^search_path=') FROM unnest(p.proconfig) c),
             false)
  LOOP
    RAISE WARNING '  ✗ % — SECURITY DEFINER بدون search_path پین‌شده', r.fn;
    v_bad := v_bad + 1;
  END LOOP;
  IF v_bad > 0 THEN
    RAISE EXCEPTION E'\n  ✗ % تابع DEFINER بدون پین search_path', v_bad;
  END IF;
  RAISE NOTICE '  ✓ هر DEFINER، search_path پین‌شده دارد';
END $$;

\echo '── ۳. کنترل مثبت: آشکارساز واقعاً چیزی می‌بیند ──'
-- بی این بند، یک Regex که هیچ‌وقت Match نشود هم «پاس» می‌شد و بند ۱
-- برای همیشه سبزِ بی‌معنا می‌ماند.
SELECT pg_temp.assert_eq(
  'apply_movement در فهرست نویسندگان هست',
  (SELECT count(*) FROM pg_temp.locked_table_writers WHERE fn = 'inventory.apply_movement'), 1);
SELECT pg_temp.assert_eq(
  'revalue_to_cost — نوشتن مستقیم — دیده می‌شود',
  (SELECT count(*) FROM pg_temp.locked_table_writers WHERE fn = 'inventory.revalue_to_cost'), 1);
-- و این یکی فقط `FOR UPDATE` دارد، نه UPDATE. اگر شاخهٔ دوم Regex
-- بشکند، همین‌جا دیده می‌شود نه در تولید.
SELECT pg_temp.assert_eq(
  'post_stock_count — فقط FOR UPDATE — دیده می‌شود',
  (SELECT count(*) FROM pg_temp.locked_table_writers WHERE fn = 'inventory.post_stock_count'), 1);

\echo '── ۴. توابعی که فقط می‌خوانند، DEFINER نمی‌خواهند ──'
-- کنترل منفی: آشکارساز نباید هر تابعی را که نام جدول در آن آمده
-- بگیرد، وگرنه بند ۱ همه را DEFINER می‌کرد — و آن، برعکسِ امنیت است.
SELECT pg_temp.assert_eq(
  'report_valuation فقط می‌خواند و در فهرست نیست',
  (SELECT count(*) FROM pg_temp.locked_table_writers WHERE fn = 'inventory.report_valuation'), 0);
SELECT pg_temp.assert_eq(
  'web_stock_qty فقط می‌خواند و در فهرست نیست',
  (SELECT count(*) FROM pg_temp.locked_table_writers WHERE fn = 'inventory.web_stock_qty'), 0);

\echo '── ۵. هیچ تابع DEFINER، EXECUTE برای PUBLIC ندارد ──'
-- ⚠️ یافتهٔ FND-R60-04. `SECURITY DEFINER` به‌نام **مالک** اجرا می‌شود،
--    و ACL پیش‌فرض یک تابع در پستگرس `EXECUTE` برای `PUBLIC` است. پس
--    هر تابع DEFINERی که ACL نگیرد، برای هر نقشی که فقط `USAGE` روی
--    اسکیما دارد یک راه دورزدنِ کاملِ حق جدول است.
--
--    اندازه‌گیری شد: نقشی با فقط `USAGE ON SCHEMA platform` — بی هیچ
--    حقی روی هیچ جدولی — `platform.enqueue_web_push()` را صدا زد و یک
--    پیام دلخواه با `version = 999999999` در صف گذاشت. افزونه پیامِ
--    با نسخهٔ کوچک‌تر را دور می‌اندازد، پس آن یک فراخوان هر Push
--    **بعدیِ** آن کالا را تا ابد بی‌صدا می‌بست.
--
-- ⚠️ `has_function_privilege` اینجا به‌کار نمی‌آید: `PUBLIC` یک نقش
--    واقعی نیست. گرانتیِ صفر در ACL خودِ PUBLIC است.
CREATE OR REPLACE VIEW pg_temp.definer_fns AS
SELECT p.oid,
       n.nspname || '.' || p.proname AS fn,
       p.proacl,
       pg_get_userbyid(p.proowner) AS owner,
       (SELECT count(*) FROM aclexplode(p.proacl) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef
   AND p.prokind = 'f'
   AND n.nspname IN ('platform','identity','catalog','inventory',
                     'purchasing','sales','treasury','ledger');

DO $$
DECLARE r record; v_bad int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp.definer_fns LOOP
    -- ⚠️ `proacl IS NULL` یعنی **پیش‌فرض**، و پیش‌فرض همان
    --    «EXECUTE برای PUBLIC» است. سنجیدن فقط aclexplode کافی نیست:
    --    روی ACL تهی، aclexplode صفر سطر می‌دهد و تابعِ باز «پاس»
    --    می‌شد. این دقیقاً همان حالتی بود که یافته را ساخت.
    IF r.proacl IS NULL THEN
      RAISE WARNING '  ✗ % — ACL پیش‌فرض دارد، یعنی EXECUTE برای PUBLIC', r.fn;
      v_bad := v_bad + 1;
    ELSIF r.public_exec > 0 THEN
      RAISE WARNING '  ✗ % — EXECUTE صریح برای PUBLIC دارد', r.fn;
      v_bad := v_bad + 1;
    END IF;
  END LOOP;
  IF v_bad > 0 THEN
    RAISE EXCEPTION E'\n  ✗ % تابع DEFINER برای PUBLIC قابل فراخوان است (مهاجرت ۰۶۰)', v_bad;
  END IF;
  RAISE NOTICE '  ✓ هیچ تابع DEFINERی برای PUBLIC قابل فراخوان نیست';
END $$;

\echo '── ۵.۱ و مالکِ هر DEFINER همان مالک اسکیماست ──'
-- ⚠️ `SECURITY DEFINER` به‌نام **مالک تابع** اجرا می‌شود. پس مالک خودش
--    بخشی از قرارداد امنیتی است، نه یک جزئیات اداری: تابعی که به‌نام
--    یک نقش کم‌دسترس ساخته شده باشد، دروازه را می‌بندد؛ و تابعی که
--    مالکش superuser باشد، در را از آنچه لازم است بازتر می‌کند.
--
--    محمول اینجا «همهٔ DEFINERها یک مالک دارند، و آن مالکِ اسکیماست»
--    است — نه یک نام سخت‌کدشده، چون نام نقش در تولید و در CI یکی نیست.
DO $$
DECLARE r record; v_owner text; v_bad int := 0;
BEGIN
  SELECT pg_get_userbyid(n.nspowner) INTO v_owner
    FROM pg_namespace n WHERE n.nspname = 'inventory';

  FOR r IN SELECT fn, owner FROM pg_temp.definer_fns WHERE owner <> v_owner LOOP
    RAISE WARNING '  ✗ % — مالکش «%» است، نه مالک اسکیما («%»)', r.fn, r.owner, v_owner;
    v_bad := v_bad + 1;
  END LOOP;

  IF v_bad > 0 THEN
    RAISE EXCEPTION E'\n  ✗ % تابع DEFINER مالکِ نامنتظره دارد', v_bad;
  END IF;
  RAISE NOTICE '  ✓ هر DEFINER به‌نام مالک اسکیما («%») اجرا می‌شود', v_owner;
END $$;

\echo '── ۶. ضدپوچی: فهرست DEFINERها خالی نیست ──'
-- بی این بند، یک اشتباه در شرط `prosecdef` یا در فهرست اسکیماها بند ۵
-- را برای همیشه سبزِ بی‌معنا می‌کرد.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_temp.definer_fns;
  IF v_n < 6 THEN
    RAISE EXCEPTION E'\n  ✗ انتظار دست‌کم ۶ تابع DEFINER بود، % پیدا شد', v_n;
  END IF;
  RAISE NOTICE '  ✓ % تابع DEFINER سنجیده شد', v_n;
END $$;

\echo '── ۷. سه کمکیِ درونی Push، DEFINER و پین‌شده‌اند ──'
-- این‌ها نویسندهٔ سه جدول قفل‌شده نیستند، پس بند ۱ نمی‌بیندشان — ولی
-- روی `platform.outbox_message` می‌نویسند و نقش برنامه نباید بتواند
-- مستقیم صدایشان بزند. `ops/db-roles.sh` حقشان را می‌گیرد و
-- `db/test/db-roles.sh` رفتارش را می‌سنجد؛ اینجا فقط وجود و پین.
SELECT pg_temp.assert_eq(
  'platform.enqueue_web_push — DEFINER و پین‌شده',
  (SELECT count(*) FROM pg_temp.definer_fns d
     JOIN pg_proc p ON p.oid = d.oid
    WHERE d.fn = 'platform.enqueue_web_push'
      AND coalesce((SELECT bool_or(c ~* '^search_path=') FROM unnest(p.proconfig) c), false)), 1);
SELECT pg_temp.assert_eq(
  'inventory.push_web_stock — DEFINER و پین‌شده',
  (SELECT count(*) FROM pg_temp.definer_fns d
     JOIN pg_proc p ON p.oid = d.oid
    WHERE d.fn = 'inventory.push_web_stock'
      AND coalesce((SELECT bool_or(c ~* '^search_path=') FROM unnest(p.proconfig) c), false)), 1);
SELECT pg_temp.assert_eq(
  'catalog.push_web_price — DEFINER و پین‌شده',
  (SELECT count(*) FROM pg_temp.definer_fns d
     JOIN pg_proc p ON p.oid = d.oid
    WHERE d.fn = 'catalog.push_web_price'
      AND coalesce((SELECT bool_or(c ~* '^search_path=') FROM unnest(p.proconfig) c), false)), 1);

\echo '── ۸. کنترل مثبت آشکارسازِ بند ۵ ──'
-- بند ۵ فقط وقتی معنا دارد که بتواند یک تابعِ **باز** را ببیند. یک
-- تابع DEFINERِ موقت می‌سازیم، ACL پیش‌فرضش را نگه می‌داریم، و ادعا
-- می‌کنیم آشکارساز می‌گیردش. (تراکنش Rollback می‌شود، پس چیزی نمی‌ماند.)
--
-- ⚠️ شرط همان شرط بند ۵ است: `proacl IS NULL` **یا** گرانتیِ صفر. و
--    این دو حالتِ یک چیزند، نه دو ادعا: اگر `ops/db-roles.sh` روی این
--    دیتابیس اجرا شده باشد، `ALTER DEFAULT PRIVILEGES` باعث می‌شود
--    تابع تازه ACL **صریح** بگیرد — و PUBLIC همان‌جا با `=X/` داخلش
--    است. نسخهٔ اول این بند فقط `IS NULL` را می‌سنجید و روی همان
--    دیتابیس قرمز شد؛ یعنی یک آشکارسازِ درست را «شکسته» نشان می‌داد.
CREATE FUNCTION platform.wg_probe_open() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$;

DO $$
DECLARE v_seen int;
BEGIN
  SELECT count(*) INTO v_seen
    FROM pg_temp.definer_fns
   WHERE fn = 'platform.wg_probe_open'
     AND (proacl IS NULL OR public_exec > 0);
  IF v_seen <> 1 THEN
    RAISE EXCEPTION E'\n  ✗ آشکارساز بند ۵ یک تابع DEFINERِ باز را ندید — بند ۵ سبزِ بی‌معناست';
  END IF;
  RAISE NOTICE '  ✓ آشکارساز بند ۵ تابع DEFINERِ باز را می‌گیرد';
END $$;

-- و پس از REVOKE دیگر نباید بگیردش — یعنی ادعا واقعاً به ACL حساس است.
REVOKE ALL ON FUNCTION platform.wg_probe_open() FROM PUBLIC;
DO $$
DECLARE v_seen int;
BEGIN
  SELECT count(*) INTO v_seen
    FROM pg_temp.definer_fns
   WHERE fn = 'platform.wg_probe_open'
     AND (proacl IS NULL OR public_exec > 0);
  IF v_seen <> 0 THEN
    RAISE EXCEPTION E'\n  ✗ پس از REVOKE هم باز شمرده شد — ادعا به ACL حساس نیست';
  END IF;
  RAISE NOTICE '  ✓ پس از REVOKE دیگر باز شمرده نمی‌شود';
END $$;
DROP FUNCTION platform.wg_probe_open();

\echo ''
\echo '╔══════════════════════════════════════╗'
\echo '║   دروازهٔ نوشتن پاس شد              ║'
\echo '╚══════════════════════════════════════╝'

ROLLBACK;
