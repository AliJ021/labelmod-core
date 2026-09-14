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

\echo ''
\echo '╔══════════════════════════════════════╗'
\echo '║   دروازهٔ نوشتن پاس شد              ║'
\echo '╚══════════════════════════════════════╝'

ROLLBACK;
