-- =====================================================================
-- ۰۸۹ — اتصال رسید به سفارش: همان شعبه، همان تأمین‌کننده، همان کالا
-- =====================================================================
--
-- یافتهٔ امنیتی FND29: «Receipt links can corrupt purchase orders across
-- branches».
--
-- مهاجرت ۰۲۹ فقط یک مرز گذاشت: سطر رسید به سطری از **همان** سفارشِ
-- رسید می‌چسبد. ولی خودِ `receipt.order_id` بی‌هیچ سنجشی ذخیره می‌شد:
--
--   • انباردار شعبهٔ «الف» رسیدی در شعبهٔ خودش می‌ساخت و به سفارش شعبهٔ
--     «ب» وصلش می‌کرد. `order_progress` سفارش «ب» را «رسیده» نشان می‌داد
--     در حالی که کالا به انبار دیگری آمده بود — و دامنهٔ شعبهٔ API فقط
--     شعبهٔ **رسید** را می‌سنجید، نه شعبهٔ سفارش.
--   • رسیدِ تأمین‌کنندهٔ «ج» تعهد تأمین‌کنندهٔ «د» را پر می‌کرد.
--   • سطر رسیدِ کالای X به سطر سفارشِ کالای Y وصل می‌شد؛ پیشرفت Y جلو
--     می‌رفت و X هرگز رسیده حساب نمی‌شد.
--
-- ── آنچه **عمداً** بسته نمی‌شود ────────────────────────────────────
--
-- هیچ‌کدام از این‌ها تصمیم مالی تازه‌ای نمی‌خواهد و همه کار عادی‌اند:
--
--   • انبار دیگرِ **همان** شعبه — محموله می‌تواند به انبار پشتیبان برود.
--   • سفارش در وضعیت پیش‌نویس (پیشنهادی) — قاعدهٔ «فقط فرستاده» مال مسیر
--     «محمولهٔ این سفارش رسید» است و همان‌جا می‌ماند.
--   • نرخ متفاوت با نرخ توافقی — فاکتور تأمین‌کننده حرف آخر را می‌زند.
--   • بیش‌تحویل — در `order_progress` با `over_qty` دیده می‌شود.
--
-- ⚠️ سطرهای موجود بازنویسی نمی‌شوند و این مهاجرت روی دادهٔ قدیمی شکست
--    نمی‌خورد: نگهبان فقط درج و تغییر بعدی را می‌سنجد. پیدا کردن اتصال
--    نادرستِ قدیمی یک گزارش فقط‌خواندنی است، نه اصلاح خودکار سند.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- ۱. سربرگ رسید: سفارش همان شعبه و همان تأمین‌کننده
-- ---------------------------------------------------------------------
CREATE FUNCTION purchasing.assert_receipt_order_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_branch uuid; v_supplier uuid;
BEGIN
  -- سطرهای سفارش‌دار به سفارشِ فعلی رسید گره خورده‌اند. عوض‌کردن سفارش
  -- زیر پایشان، همان پیوند ناسازگاری را می‌ساخت که ۰۲۹ برای سطر می‌بست.
  IF TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id
     AND EXISTS (SELECT 1 FROM purchasing.receipt_line
                  WHERE receipt_id = NEW.id AND order_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'سفارشِ رسیدی که سطر سفارش‌دار دارد عوض نمی‌شود؛ ابتدا اتصال سطرها را بردارید.';
  END IF;

  IF NEW.order_id IS NULL THEN RETURN NEW; END IF;

  SELECT branch_id, supplier_id INTO v_branch, v_supplier
    FROM purchasing.purchase_order WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'سفارش خرید یافت نشد.';
  END IF;
  IF v_branch <> NEW.branch_id THEN
    RAISE EXCEPTION 'رسید فقط به سفارش خریدِ همان شعبه وصل می‌شود.';
  END IF;
  IF v_supplier <> NEW.supplier_id THEN
    RAISE EXCEPTION 'تأمین‌کنندهٔ رسید با تأمین‌کنندهٔ سفارش خرید یکی نیست.';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION purchasing.assert_receipt_order_scope() IS
  'FND29: رسید فقط به سفارش همان شعبه و همان تأمین‌کننده وصل می‌شود؛ انبار دیگر همان شعبه مجاز است.';

CREATE TRIGGER assert_receipt_order_scope_t
  BEFORE INSERT OR UPDATE OF order_id, branch_id, supplier_id ON purchasing.receipt
  FOR EACH ROW EXECUTE FUNCTION purchasing.assert_receipt_order_scope();

-- ---------------------------------------------------------------------
-- ۲. سطر رسید: همان سفارش (۰۲۹) **و** همان کالا
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purchasing.assert_order_line_matches()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_receipt_order uuid; v_line_order uuid; v_line_variation uuid;
BEGIN
  IF NEW.order_line_id IS NULL THEN RETURN NEW; END IF;

  SELECT order_id INTO v_receipt_order
    FROM purchasing.receipt WHERE id = NEW.receipt_id;
  SELECT order_id, variation_id INTO v_line_order, v_line_variation
    FROM purchasing.purchase_order_line WHERE id = NEW.order_line_id;

  IF v_receipt_order IS NULL THEN
    RAISE EXCEPTION 'این رسید به هیچ سفارشی وصل نیست، پس سطرش هم نمی‌تواند.';
  END IF;
  IF v_receipt_order <> v_line_order THEN
    RAISE EXCEPTION 'سطر رسید به سفارش دیگری اشاره می‌کند.';
  END IF;
  -- کالای دیگر، تعهد دیگری است: پیشرفت سطرِ کالای Y با رسیدِ کالای X
  -- جلو نمی‌رود.
  IF v_line_variation <> NEW.variation_id THEN
    RAISE EXCEPTION 'کالای سطر رسید با کالای سطر سفارش یکی نیست.';
  END IF;
  RETURN NEW;
END $$;

-- ۰۲۹ فقط روی `order_line_id` می‌سنجید؛ عوض‌کردن کالا یا رسیدِ سطر هم
-- همان پیوند را می‌شکند.
DROP TRIGGER assert_order_line_matches_t ON purchasing.receipt_line;
CREATE TRIGGER assert_order_line_matches_t
  BEFORE INSERT OR UPDATE OF order_line_id, variation_id, receipt_id ON purchasing.receipt_line
  FOR EACH ROW EXECUTE FUNCTION purchasing.assert_order_line_matches();

REVOKE EXECUTE ON FUNCTION purchasing.assert_receipt_order_scope() FROM PUBLIC;

COMMIT;
