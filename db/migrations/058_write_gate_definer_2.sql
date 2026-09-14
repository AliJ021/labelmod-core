-- =====================================================================
-- ۰۵۸ — دو دروازهٔ نوشتنِ جامانده هم `SECURITY DEFINER` می‌شوند
-- =====================================================================
-- مهاجرت ۰۵۰ `inventory.apply_movement()` را `SECURITY DEFINER` کرد تا
-- `ops/db-roles.sh` بتواند حق نوشتن مستقیم روی `stock_balance` و
-- `stock_movement` و `cost_layer` را از **نقش برنامه** بگیرد و دروازه
-- باز بماند. `db/test/db-roles.sh` هم همان را قفل کرد: هفت حمله رد
-- می‌شود **و** `apply_movement` کار می‌کند.
--
-- ولی آن تست فقط **یک** دروازه را می‌سنجید. اندازه‌گیری شد، نه حدس:
-- کل مجموعهٔ تست یکپارچهٔ API یک بار با **نقش محدود** اجرا شد
-- (`LMC_TEST_DB_ROLE=app`) و از ۶۵۴ ادعا، ۳۰ تا قرمز شدند و ۱۸ تا
-- Cancel. ریشه‌شان دو تابع بود که به `stock_balance` می‌نویسند و
-- `SECURITY DEFINER` **نیستند**:
--
--   inventory.revalue_to_cost()   UPDATE stock_balance + INSERT stock_movement
--   inventory.post_stock_count()  SELECT … FOR UPDATE روی stock_balance
--
-- ⚠️ `SELECT … FOR UPDATE` در پستگرس حق **UPDATE** می‌خواهد، نه فقط
--    SELECT. قفل‌گرفتنِ بی‌ضررِ یک سطر، با `REVOKE UPDATE` می‌شکند —
--    و پیام خطا («permission denied for table stock_balance») هیچ
--    اشاره‌ای به `FOR UPDATE` ندارد.
--
-- ── چرا این بی‌صدا بود ─────────────────────────────────────────────
--
-- هر ۱۲۳۳ ادعای SQL و هر ۶۵۴ ادعای API با نقش **مالک** اجرا می‌شدند.
-- مالک همهٔ حق‌ها را دارد، پس این دو تابع همیشه سبز بودند. تنها جایی
-- که با نقش برنامه حمله می‌کرد `db/test/db-roles.sh` بود و آن فقط
-- `apply_movement` را به‌عنوان «دروازه» می‌شناخت.
--
-- ── و چرا خطرش بزرگ بود ────────────────────────────────────────────
--
-- `revalue_to_cost` را `purchasing.post_receipt()` صدا می‌زند و
-- `costing.method` **پیش‌فرض** `last_purchase` است — یعنی هر رسید خرید
-- کل موجودی همان کالا را تجدید ارزیابی می‌کند. پس در لحظه‌ای که
-- `DATABASE_URL` برنامه به `labelmod_app` عوض می‌شد، **هیچ رسید خریدی
-- ثبت نمی‌شد** و هیچ انبارگردانی‌ای بسته نمی‌شد؛ آن هم روی سیستم زنده و
-- با خطایی که شبیه خرابی دیتابیس به‌نظر می‌رسد.
--
-- ── چرا فقط `ALTER FUNCTION`، نه بازنویسی بدنه ─────────────────────
--
-- رفتار این دو تابع درست است و عوض نمی‌شود؛ آنچه کم بود یک **خصیصه**
-- بود. `CREATE OR REPLACE` با بدنهٔ رونویسی‌شده یعنی دو نسخه از یک
-- منطق که باید هم‌زمان درست بمانند.
--
-- ⚠️ `search_path` پین می‌شود — همان استدلال ۰۵۰: `SECURITY DEFINER`
--    بدون پین، یک راه ارتقای دسترسی است. `public` در فهرست هست چون
--    `pgcrypto` آنجاست و `platform.uuid_v7()` به آن نیاز دارد.
--
-- ⚠️ این مهاجرت هم به‌تنهایی هیچ‌چیز را محدود نمی‌کند. تا وقتی برنامه
--    با نقش مالک وصل است، `SECURITY DEFINER` بی‌اثر است.
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_name text;
  v_sig  text;
BEGIN
  -- امضا از خودِ کاتالوگ خوانده می‌شود، نه از حافظه — همان درسی که
  -- مهاجرت ۰۵۰ با یک «function … does not exist» گرفت.
  FOREACH v_name IN ARRAY ARRAY['revalue_to_cost', 'post_stock_count'] LOOP
    SELECT 'inventory.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')'
      INTO v_sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'inventory' AND p.proname = v_name AND p.prokind = 'f';

    IF v_sig IS NULL THEN
      RAISE EXCEPTION 'inventory.% پیدا نشد — مهاجرت‌های پیشین کامل اجرا نشده‌اند.', v_name;
    END IF;

    EXECUTE format(
      'ALTER FUNCTION %s SECURITY DEFINER
         SET search_path = pg_catalog, public, inventory, platform, catalog, identity, ledger, purchasing',
      v_sig);
  END LOOP;
END $$;

COMMENT ON FUNCTION inventory.revalue_to_cost(uuid, uuid, platform.money, uuid, text, uuid, timestamptz, text) IS
  'تجدید ارزیابی موجودی به نرخ داده‌شده (تنها حرکت با تعداد صفر). SECURITY DEFINER با search_path پین‌شده — مهاجرت ۰۵۸، تا با REVOKE نقش برنامه نشکند.';

COMMENT ON FUNCTION inventory.post_stock_count(uuid, uuid) IS
  'ثبت برگه انبارگردانی: شماره‌گذاری، خواندن موجودی سیستم در لحظه ثبت، و تعدیل. SECURITY DEFINER با search_path پین‌شده — مهاجرت ۰۵۸.';

COMMIT;
