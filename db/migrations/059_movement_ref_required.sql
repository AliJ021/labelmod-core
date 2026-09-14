-- =====================================================================
-- ۰۵۹ — حرکت انبار بی سند مرجع ثبت نمی‌شود
-- =====================================================================
-- معیار پذیرش ۲ (بخش ۳۵ سند) می‌گوید هر تغییر موجودی باید **حرکت و
-- سند مرجع قابل ردیابی** داشته باشد. نیمهٔ اولش از روز اول برقرار بود:
-- موجودی فقط از `inventory.apply_movement()` عوض می‌شود، و از مهاجرت
-- ۰۵۰ و ۰۵۸ نقش برنامه حتی حق نوشتن مستقیم ندارد.
--
-- نیمهٔ دومش **اجبار نشده بود**:
--
--     ref_type   text        -- nullable، بی FK، بی CHECK
--     ref_id     uuid        -- همان
--
-- یعنی این سطر از نظر دیتابیس کاملاً مجاز بود:
--
--     kind='sale' · qty=-3 · ref_id=NULL
--
-- سه قلم از انبار رفته و هیچ فاکتوری پشتش نیست. ترازنامه هم به‌هم
-- نمی‌ریزد و هیچ ثابتی قرمز نمی‌شود — فقط شش ماه بعد جوابی برای
-- «این‌ها کجا رفتند؟» وجود ندارد. (بند ۵۵ الحاقیه: توازن ≠ صحت معنایی.)
--
-- ── چرا یک قاعده با یک استثنا، نه یک فهرست ─────────────────────────
--
-- وسوسهٔ اول این بود که فهرست هفت `kind`ی بنویسیم که «باید» مرجع
-- داشته باشند. شمرده شد و معلوم شد آن فهرست نگهبان را دقیقاً جایی
-- می‌گذارد که خطر **نیست**:
--
--     تولیدشده و با مرجع : purchase_receipt · purchase_return · sale
--                          sale_return · transfer_in · transfer_out
--                          count_adjust · revaluation
--     تولیدشده بی مرجع   : opening
--     هیچ مسیری نمی‌سازد : defective · lost · correction
--
-- آن سه مقدار **مرده**اند — هیچ تابعی و هیچ مسیر APIای نمی‌سازدشان.
-- (`'defective'` در کد، `warehouse.kind` است نه `stock_movement.kind`؛
-- مرجوعی معیوب با `sale_return` ثبت می‌شود و فاکتورش را دارد.)
--
-- پس فهرست هفت‌تایی یعنی: همان سه‌تایی که امروز مسیری ندارند، فردا —
-- وقتی کسی «ضایعات» یا «کسری انبار» را بنویسد — از سوراخ رد می‌شدند.
-- قاعدهٔ «همه، جز `opening`» هم امروز چیزی نمی‌شکند و هم آن مسیر تازه
-- را مجبور می‌کند برگه‌اش را بیاورد.
--
-- ── چرا `opening` استثناست، و این راحتی نیست ────────────────────────
--
-- واردات اولیه **خودش مبدأ است**؛ سند قبلی‌ای در این سیستم ندارد.
-- و سند افتتاحیهٔ دفتر **پس از** حرکت‌ها ساخته می‌شود
-- (`apps/api/src/import/run.ts` — اول `apply_movement`، بعد
-- `post_opening_balance`)، پس شناسه‌اش در آن لحظه اصلاً وجود ندارد.
-- یک واقعیت ترتیبی است، نه یک استثنای سلیقه‌ای.
--
-- ⚠️ **قید با نگهبان می‌آید، نه با `NOT VALID`.** اگر سطر ناسازگاری
--    وجود داشته باشد، این مهاجرت با پیام صریح می‌ایستد. `NOT VALID`
--    داده‌های گذشته را بی‌صدا رد می‌کرد — یعنی همان چیزی که این قید
--    قرار بود بگیرد، در تاریخچه باقی می‌ماند و کسی خبردار نمی‌شد.
-- =====================================================================

BEGIN;

-- ۱. نگهبان: هیچ سطر موجودی نباید قید تازه را نقض کند.
DO $$
DECLARE v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM inventory.stock_movement
   WHERE kind <> 'opening'
     AND (ref_type IS NULL OR ref_id IS NULL);

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      E'% حرکت انبار بدون سند مرجع در تاریخچه هست؛ قید تازه بسته نمی‌شود.\n'
       '  برای دیدنشان:\n'
       '    SELECT id, kind, qty, occurred_at, note FROM inventory.stock_movement\n'
       '     WHERE kind <> ''opening'' AND (ref_type IS NULL OR ref_id IS NULL);\n'
       '  حرکت انبار تغییرناپذیر است، پس اصلاحش با حرکت معکوس است نه UPDATE.',
      v_bad;
  END IF;
END $$;

-- ۲. قید.
ALTER TABLE inventory.stock_movement
  ADD CONSTRAINT stock_movement_ref_required CHECK (
    kind = 'opening'
    OR (ref_type IS NOT NULL AND ref_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT stock_movement_ref_required ON inventory.stock_movement IS
  'معیار پذیرش ۲: هر حرکت انبار سند مرجع دارد. تنها استثنا «opening» است — واردات اولیه خودش مبدأ است و سند افتتاحیه پس از حرکت‌ها ساخته می‌شود.';

-- ۳. و یک Trigger که همان قاعده را با پیام **فارسی** می‌گوید.
--
-- ⚠️ این تزئین نیست. یک `CHECK` خام `SQLSTATE 23514` می‌دهد و
--    `apps/api/src/http/errors.ts` فقط `P0001` را به `rule_violation`
--    (۴۰۹) ترجمه می‌کند — یعنی این نگهبان به کاربر **۵۰۰** نشان می‌داد.
--    قاعدهٔ خودِ پروژه: «دفاعی که شبیه خرابی سرور گزارش شود، در عمل
--    خاموش است.»
--
-- ⚠️ Trigger روی **جدول** است نه داخل `apply_movement`: هم مسیر دروازه
--    را می‌گیرد و هم درج مستقیم را، با **یک** تعریف. گذاشتنش داخل آن
--    تابع یعنی بازنویسی بدنه‌اش با `CREATE OR REPLACE` — دو نسخه از یک
--    منطق، همان چیزی که مهاجرت ۰۵۸ از آن پرهیز کرد.
--
-- ⚠️ و `CHECK` **حذف نمی‌شود**: Trigger را می‌شود با
--    `ALTER TABLE … DISABLE TRIGGER` خاموش کرد، `CHECK` را نه؛ و
--    `CHECK` سطرهای موجود را هم اعتبارسنجی می‌کند. دو لایه، مثل
--    `audit_log`.
CREATE OR REPLACE FUNCTION inventory.movement_ref_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'opening'
     AND (NEW.ref_type IS NULL OR NEW.ref_id IS NULL) THEN
    RAISE EXCEPTION
      'حرکت انبار از نوع «%» باید سند مرجع داشته باشد (نوع و شناسه). کالایی که بی برگه از انبار برود، بعداً قابل ردیابی نیست.',
      NEW.kind;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS movement_ref_guard_t ON inventory.stock_movement;
CREATE TRIGGER movement_ref_guard_t
  BEFORE INSERT ON inventory.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inventory.movement_ref_guard();

COMMIT;
