-- =====================================================================
-- ۰۵۰ — دروازه نوشتن موجودی، `SECURITY DEFINER` می‌شود
-- =====================================================================
-- `docs/SECURITY.md` بند ۳ سه `REVOKE` را **الزام** کرده و نوشته
-- «علاوه بر Trigger — دو لایه دفاع». آن سه REVOKE در کل مخزن
-- **وجود نداشتند** و نقش `labelmod_app`/`labelmod_migrator` هرگز ساخته
-- نشده بود: `docker-compose.yml` یک کاربر می‌سازد که **مالک** دیتابیس
-- است، پس همه‌چیز را می‌تواند.
--
-- ولی مشکل از نبودِ اسکریپت عمیق‌تر بود. `CLAUDE.md` می‌گوید:
--
--   «`stock_balance` تنها جدول مالی بدون Trigger تغییرناپذیری است — و
--    نمی‌تواند داشته باشد … یعنی یک `UPDATE` دستی در psql می‌نشیند و
--    دیتابیس جلویش را نمی‌گیرد. تنها دفاع، نمای `balance_check` است.»
--
-- بخش اولش درست است: Trigger نمی‌شود، چون `apply_movement` خودش
-- می‌نویسدش. ولی نتیجه‌گیری «تنها دفاع یک نماست» **لازم نبود** —
-- راه دیگری هست که این مهاجرت بازش می‌کند.
--
-- ── چرا `SECURITY DEFINER` اینجا کار می‌کند ─────────────────────────
--
-- اگر تابعِ دروازه به‌نام **مالک** اجرا شود، می‌توان حق نوشتن روی
-- `stock_balance` و `stock_movement` و `cost_layer` را از نقش برنامه
-- **گرفت** و همان تابع باز هم بنویسد. آن‌وقت:
--
--   UPDATE inventory.stock_balance SET on_hand = 999;   → permission denied
--   INSERT INTO inventory.stock_movement …              → permission denied
--   SELECT inventory.apply_movement(…)                  → کار می‌کند
--
-- هر سه ادعا اجرا و دیده شدند. `db/test/db-roles.sh` قفلشان می‌کند.
--
-- یعنی لایه دومی که SECURITY.md وعده داده بود، برای **پرخطرترین**
-- جدول مالی هم ممکن است — نه فقط برای دو جدولی که Trigger دارند.
--
-- ── این مهاجرت به‌تنهایی هیچ‌چیز را محدود نمی‌کند ───────────────────
--
-- تا وقتی برنامه با نقشِ **مالک** وصل می‌شود، `SECURITY DEFINER` هیچ
-- تفاوتی نمی‌سازد: مالک از قبل همه حق‌ها را دارد. فعال‌شدنِ واقعیِ
-- محدودیت با `ops/db-roles.sh` و عوض‌کردن `DATABASE_URL` برنامه است —
-- یک تصمیم **استقرار**، و عمداً در این مهاجرت نیست تا سیستم زنده با
-- یک مهاجرت از کار نیفتد.
--
-- ⚠️ `search_path` پین می‌شود، وگرنه `SECURITY DEFINER` یک راه ارتقای
--    دسترسی است: کسی که بتواند `search_path` را عوض کند، می‌تواند
--    تابعی هم‌نام در اسکیمای خودش بگذارد و آن به‌نام مالک اجرا شود.
--    همه ارجاع‌های این تابع از قبل Schema-Qualified بودند، پس پین‌کردن
--    رفتارش را عوض نمی‌کند.
--
-- ⚠️ `public` در فهرست هست و باید باشد: `pgcrypto` آنجا نصب است و
--    `platform.uuid_v7()` به `gen_random_bytes()` نیاز دارد. بار اول
--    بدون آن نوشتم و تابع با
--    «function gen_random_bytes(integer) does not exist» شکست —
--    خطایی که فقط در زمان اجرا دیده می‌شود.
-- =====================================================================

BEGIN;

DO $$
DECLARE v_sig text;
BEGIN
  -- امضا از خودِ کاتالوگ خوانده می‌شود، نه از حافظه: این تابع در
  -- مهاجرت‌های بعدی پارامتر گرفته و نوشتن امضا به‌صورت دستی یک بار
  -- «function … does not exist» داد.
  SELECT 'inventory.apply_movement(' || pg_get_function_identity_arguments(p.oid) || ')'
    INTO v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'inventory' AND p.proname = 'apply_movement';

  IF v_sig IS NULL THEN
    RAISE EXCEPTION 'inventory.apply_movement پیدا نشد — مهاجرت‌های پیشین کامل اجرا نشده‌اند.';
  END IF;

  EXECUTE format(
    'ALTER FUNCTION %s SECURITY DEFINER
       SET search_path = pg_catalog, public, inventory, platform, catalog, identity, ledger',
    v_sig);
END $$;

COMMENT ON FUNCTION inventory.apply_movement IS
  'تنها دروازه تغییر موجودی. SECURITY DEFINER با search_path پین‌شده، تا حق نوشتن مستقیم روی stock_balance و stock_movement از نقش برنامه گرفتنی باشد (ops/db-roles.sh).';

COMMIT;
