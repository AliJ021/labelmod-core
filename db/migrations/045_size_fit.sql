-- =====================================================================
-- ۰۴۵ — تناسب سایز: «کدام کالا به این شخص می‌خورد؟»
-- =====================================================================
--
-- خواسته مالک: «اگر برای خودش می‌خرد، محصولات بر اساس سایزش فیلتر
-- شده نشان داده شود.»
--
-- دو نیمه لازم بود و تا امروز فقط یکی بود:
--
--   catalog.variation_measure   اندازه واقعی هر **سایز کالا**  (بود)
--   sales.customer_measure      اندازه **بدن مشتری**           (۰۴۲)
--
-- این مهاجرت آن دو را کنار هم می‌گذارد.
--
-- ── چرا «فیلتر»، نه «AI» ────────────────────────────────────────────
--
-- CLAUDE.md صریح می‌گوید «AI پیشنهاد سایز» ساخته نشود. و درست است:
-- مدلی که سایز پیشنهاد دهد باید روی داده فروش و مرجوعی همین فروشگاه
-- آموزش ببیند، و آن داده هنوز وجود ندارد.
--
-- آنچه اینجا هست حساب فاصله است، نه یادگیری: هر اندازه بدن با اندازه
-- همان کلید روی کالا مقایسه می‌شود و فاصله‌ها جمع می‌شوند. قابل
-- توضیح، قابل بازرسی، و بدون هیچ ادعایی که نتواند اثباتش کند.
--
-- ⚠️ نتیجه‌اش **پیشنهاد** است نه حکم. کالایی که اندازه ندارد حذف
--    نمی‌شود؛ `match_score = NULL` می‌گیرد و صفحه می‌گوید «اندازه‌اش
--    ثبت نشده». حذفش یعنی فروشگاه نصف ویترینش را به مشتری نشان ندهد
--    چون انباردار هنوز اندازه‌ها را وارد نکرده.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۱. کلید اندازه کالا هم از همان فهرست می‌آید
-- ---------------------------------------------------------------------
-- `variation_measure.key` متن آزاد بود. اگر کالا `chest` بنویسد و
-- مشتری `dour_sine`، هیچ‌وقت با هم مقایسه نمی‌شوند — و هیچ خطایی هم
-- نمی‌دهند؛ فقط نتیجه همیشه خالی است.
--
-- ⚠️ مثل فصل، با Trigger نه FK: مقدارِ دست‌نخورده رد نمی‌شود تا
--    داده‌ی امروز نشکند.

CREATE OR REPLACE FUNCTION catalog.check_measure_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.key IS NOT DISTINCT FROM OLD.key THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sales.measure_key WHERE key = NEW.key AND is_active) THEN
    RAISE EXCEPTION 'اندازه «%» تعریف نشده است.', NEW.key;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS variation_measure_key_check ON catalog.variation_measure;
CREATE TRIGGER variation_measure_key_check
  BEFORE INSERT OR UPDATE OF key ON catalog.variation_measure
  FOR EACH ROW EXECUTE FUNCTION catalog.check_measure_key();


-- ---------------------------------------------------------------------
-- ۲. تحمل هر اندازه — داده، نه ثابت در کد
-- ---------------------------------------------------------------------
-- «چند سانت اختلاف هنوز خوب است؟» جوابش برای دور سینه و طول کف پا
-- یکی نیست: دو سانت روی سینه هیچ است، روی کفش یک سایز کامل.
--
-- پس تحمل به‌ازای هر کلید در همان جدول `measure_key` می‌نشیند و مالک
-- می‌تواند بدون Deploy عوضش کند.

ALTER TABLE sales.measure_key
  ADD COLUMN IF NOT EXISTS tolerance_cm numeric(6,1) NOT NULL DEFAULT 3.0
    CHECK (tolerance_cm > 0);

COMMENT ON COLUMN sales.measure_key.tolerance_cm IS
  'چند واحد اختلاف هنوز «می‌خورد». دو سانت روی سینه هیچ است، روی کفش یک سایز.';


-- ---------------------------------------------------------------------
-- ۳. امتیاز تناسب
-- ---------------------------------------------------------------------
-- برای هر تنوع، اندازه‌های **مشترک** با بدن مشتری مقایسه می‌شوند:
--
--   diff  = |اندازه کالا − اندازه بدن|
--   امتیاز هر کلید = 1 − diff / tolerance   (کف صفر)
--   امتیاز کل = میانگین امتیازها
--
-- ⚠️ فقط کلیدهای مشترک شمرده می‌شوند. اگر کالا فقط «دور سینه» دارد و
--    مشتری «قد» و «دور سینه»، مقایسه روی دور سینه انجام می‌شود — نه
--    اینکه نبودِ قد امتیاز را نصف کند. کالای کم‌اندازه نباید به‌خاطر
--    کمبود داده جریمه شود؛ `matched_keys` می‌گوید حکم بر چند پایه
--    استوار است.
--
-- ⚠️ `NULL` یعنی «هیچ اندازه مشترکی نبود» — با «نمی‌خورد» یکی نیست.

CREATE OR REPLACE FUNCTION catalog.fit_score(
  p_variation uuid, p_customer uuid
) RETURNS TABLE (score numeric, matched_keys int)
LANGUAGE sql STABLE AS $$
  SELECT round(avg(greatest(0, 1 - abs(vm.value_cm - cm.value_cm) / mk.tolerance_cm)), 3),
         count(*)::int
    FROM catalog.variation_measure vm
    JOIN sales.customer_measure   cm ON cm.key = vm.key
                                    AND cm.customer_id = p_customer
    JOIN sales.measure_key        mk ON mk.key = vm.key AND mk.is_active
   WHERE vm.variation_id = p_variation
  HAVING count(*) > 0;
$$;
COMMENT ON FUNCTION catalog.fit_score IS
  'امتیاز تناسب یک تنوع با بدن یک مشتری (۰ تا ۱). سطر خالی یعنی اندازه مشترکی نبود — با «نمی‌خورد» یکی نیست.';


-- ---------------------------------------------------------------------
-- ۴. کالاهای مناسب یک مشتری
-- ---------------------------------------------------------------------
-- ⚠️ کالای بدون اندازه **حذف نمی‌شود**. `match_score = NULL` می‌گیرد
--    و آخر فهرست می‌نشیند. حذفش یعنی فروشگاه نصف ویترینش را نشان
--    ندهد چون انباردار هنوز اندازه‌ها را وارد نکرده.
--
-- ⚠️ فقط کالای **موجود**: پیشنهاد سایزی که در قفسه نیست، مشتری را
--    سر کار می‌گذارد.

CREATE OR REPLACE FUNCTION catalog.fitting_variations(
  p_customer   uuid,
  p_warehouse  uuid DEFAULT NULL,
  p_min_score  numeric DEFAULT NULL,
  p_limit      int DEFAULT 50
) RETURNS TABLE (
  variation_id uuid,
  sku          text,
  product_name text,
  color        text,
  size         text,
  season       text,
  on_hand      platform.qty,
  match_score  numeric,
  matched_keys int
) LANGUAGE sql STABLE AS $$
  WITH avail AS (
    SELECT b.variation_id, sum(b.on_hand) AS qty
      FROM inventory.stock_balance b
     WHERE (p_warehouse IS NULL OR b.warehouse_id = p_warehouse)
     GROUP BY 1
    HAVING sum(b.on_hand) > 0
  )
  SELECT v.id, v.sku, p.name_internal, v.color, v.size, p.season,
         a.qty, f.score, f.matched_keys
    FROM avail a
    JOIN catalog.variation v ON v.id = a.variation_id AND v.status = 'active'
    JOIN catalog.product   p ON p.id = v.product_id AND p.status = 'active'
    LEFT JOIN LATERAL catalog.fit_score(v.id, p_customer) f ON true
   WHERE p_min_score IS NULL OR f.score >= p_min_score
   ORDER BY f.score DESC NULLS LAST, p.name_internal, v.size
   LIMIT p_limit;
$$;
COMMENT ON FUNCTION catalog.fitting_variations IS
  'کالاهای موجود، مرتب بر اساس تناسب با بدن مشتری. کالای بدون اندازه حذف نمی‌شود — NULL می‌گیرد و آخر می‌نشیند.';
