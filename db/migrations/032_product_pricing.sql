-- =====================================================================
-- ۰۳۲ — چرخه حیات کالا و قیمت
-- =====================================================================
-- تا امروز `catalog.product` فقط از ابزار مهاجرت CSV پر می‌شد و
-- `catalog.price` فقط یک بار، لحظه ساخت تنوع. یعنی پس از واردات اولیه:
--
--   · کالای تازه‌ای که به مغازه می‌آمد، هیچ راهی برای ثبت نداشت
--   · قیمت هیچ کالایی عوض نمی‌شد — نه حراج فصلی، نه اصلاح غلط تایپی
--
-- برای فروشگاه پوشاک، دومی یعنی سیستم از هفته دوم دیگر واقعیت را
-- نشان نمی‌دهد.
--
-- ── قاعده‌ای که کل این فایل رویش بنا شده ────────────────────────────
--
-- **قیمت قبلی هرگز UPDATE یا DELETE نمی‌شود.**
--
-- `catalog.price` از روز اول `valid_from` و `valid_to` داشت و
-- `invoice.currentPrice` هم قیمت را «در همان لحظه» می‌خواند — یعنی
-- شکلِ تاریخچه از اول درست بود و فقط مسیر نوشتنش نبود. این مهاجرت
-- همان مسیر را اضافه می‌کند و **قفلش می‌کند**:
--
--   تغییر قیمت = بستن سطر باز با `valid_to` + درج سطر تازه
--
-- چرا نه یک `UPDATE amount`: فاکتور نهایی‌شده `unit_price` را Snapshot
-- کرده، پس خودش تغییر نمی‌کند. ولی گزارش «قیمت این کالا در فروردین چه
-- بود» و بازسازی حاشیه سود تاریخی، بدون سطر قدیمی ساختنی نیست. و
-- مهم‌تر: قیمتی که بی‌ردّ عوض شود، همان چیزی است که در بازرسی نمی‌شود
-- توضیحش داد.
--
-- ── مرز زمانی، نه همپوشانی و نه شکاف ────────────────────────────────
--
-- سطر بسته `valid_to = T` می‌گیرد و سطر تازه `valid_from = T`. خوانش
-- «در لحظه T» دقیقاً یکی را برمی‌گرداند: شرط `valid_to > at` سطر قدیم
-- را در T بیرون می‌گذارد و `valid_from <= at` سطر تازه را داخل.
--
-- ⚠️ `now()` زمانِ **شروع تراکنش** است، پس دو تغییر قیمت در یک تراکنش
--    هر دو یک مهر زمانی می‌گرفتند و قید `valid_to > valid_from` را
--    می‌شکستند. `clock_timestamp()` داخل تراکنش جلو می‌رود، و برای
--    وقتی که ساعت سیستم عقب برود یا رزولوشن کم بیاورد، مرز صریحاً یک
--    میکروثانیه از `valid_from` قبلی جلوتر برده می‌شود.
-- =====================================================================

BEGIN;

-- ── ۱. وضعیت کالا ────────────────────────────────────────────────────
-- تنوع از اول `status` داشت، کالا نه. بایگانی‌کردن یک مدل قدیمی نباید
-- به معنی حذفش باشد: فاکتورهای پارسال به همان سطر ارجاع می‌دهند.
ALTER TABLE catalog.product
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived'));

COMMENT ON COLUMN catalog.product.status IS
  'archived یعنی دیگر خریده و فروخته نمی‌شود؛ حذف نیست — تاریخچه سر جایش می‌ماند.';

-- ── ۲. حداکثر یک قیمت باز برای هر (تنوع، فهرست قیمت) ─────────────────
-- بدون این، دو سطر باز یعنی `currentPrice` بسته به ترتیب مرتب‌سازی
-- یکی‌شان را برمی‌دارد و نتیجه غیرقطعی می‌شود.
--
-- ⚠️ اگر ساخت این ایندکس روی داده واقعی شکست، مهاجرت **باید** بشکند:
--    یعنی همین حالا یک تنوع دو قیمت باز دارد و باید دستی بررسی شود.
CREATE UNIQUE INDEX IF NOT EXISTS price_one_open_per_list
  ON catalog.price (variation_id, price_list)
  WHERE valid_to IS NULL;

-- ── ۳. تاریخچه قیمت تغییرناپذیر است ──────────────────────────────────
-- همان قاعده‌ای که برای حرکت انبار و لاگ حسابرسی داریم. تنها تغییر
-- مجاز روی یک سطر قیمت، بستن آن است — یک بار، از NULL به یک مقدار.
CREATE OR REPLACE FUNCTION catalog.price_history_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'سطر قیمت حذف نمی‌شود. برای تغییر قیمت، قیمت تازه ثبت کنید.';
  END IF;

  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'قیمت بسته‌شده تغییر نمی‌کند (از % تا %).',
      OLD.valid_from, OLD.valid_to;
  END IF;

  IF NEW.variation_id IS DISTINCT FROM OLD.variation_id
     OR NEW.price_list IS DISTINCT FROM OLD.price_list
     OR NEW.amount     IS DISTINCT FROM OLD.amount
     OR NEW.kind       IS DISTINCT FROM OLD.kind
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'روی سطر قیمت فقط valid_to می‌تواند ست شود، نه مبلغ یا تاریخ شروع.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS price_history_immutable ON catalog.price;
CREATE TRIGGER price_history_immutable
  BEFORE UPDATE OR DELETE ON catalog.price
  FOR EACH ROW EXECUTE FUNCTION catalog.price_history_immutable();

-- ── ۴. ساخت و ویرایش کالا ────────────────────────────────────────────
-- `code` کلید تجاری است و پس از ساخت عوض نمی‌شود: SKU تنوع‌ها از رویش
-- ساخته شده و روی برچسب چاپ‌شده نشسته.
CREATE OR REPLACE FUNCTION catalog.upsert_product(
  p_id             uuid,          -- NULL یعنی ساخت
  p_code           text,
  p_name_internal  text,
  p_name_web       text    DEFAULT NULL,
  p_brand_id       uuid    DEFAULT NULL,
  p_category_id    uuid    DEFAULT NULL,
  p_season         text    DEFAULT NULL,
  p_collection     text    DEFAULT NULL,
  p_fabric         text    DEFAULT NULL,
  p_fit            text    DEFAULT NULL,
  p_origin_country text    DEFAULT NULL,
  p_tax_rate_code  text    DEFAULT 'standard',
  p_notes          text    DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_old   catalog.product;
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;

  IF coalesce(btrim(p_code), '') = '' THEN
    RAISE EXCEPTION 'کد کالا نمی‌تواند خالی باشد.';
  END IF;
  IF coalesce(btrim(p_name_internal), '') = '' THEN
    RAISE EXCEPTION 'نام کالا نمی‌تواند خالی باشد.';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO catalog.product (
      code, name_internal, name_web, brand_id, category_id, season,
      collection, fabric, fit, origin_country, tax_rate_code, notes)
    VALUES (
      btrim(p_code), btrim(p_name_internal), p_name_web, p_brand_id,
      p_category_id, p_season, p_collection, p_fabric, p_fit,
      p_origin_country, coalesce(p_tax_rate_code, 'standard'), p_notes)
    RETURNING id INTO v_id;

    PERFORM platform.audit(
      'product.create', 'catalog.product', v_id::text,
      to_jsonb((SELECT p FROM catalog.product p WHERE p.id = v_id)), v_actor);
    RETURN v_id;
  END IF;

  SELECT * INTO v_old FROM catalog.product WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'کالا یافت نشد: %', p_id;
  END IF;

  -- کد روی SKU و برچسب چاپ‌شده نشسته؛ عوض‌کردنش یعنی برچسب‌های قفسه
  -- به چیزی اشاره کنند که دیگر وجود ندارد.
  IF btrim(p_code) IS DISTINCT FROM v_old.code THEN
    RAISE EXCEPTION 'کد کالا پس از ساخت عوض نمی‌شود (SKU و بارکد از رویش ساخته شده‌اند).';
  END IF;

  UPDATE catalog.product SET
    name_internal  = btrim(p_name_internal),
    name_web       = p_name_web,
    brand_id       = p_brand_id,
    category_id    = p_category_id,
    season         = p_season,
    collection     = p_collection,
    fabric         = p_fabric,
    fit            = p_fit,
    origin_country = p_origin_country,
    tax_rate_code  = coalesce(p_tax_rate_code, 'standard'),
    notes          = p_notes
  WHERE id = p_id;

  PERFORM platform.audit(
    'product.update', 'catalog.product', p_id::text,
    to_jsonb((SELECT p FROM catalog.product p WHERE p.id = p_id)),
    v_actor, NULL, to_jsonb(v_old));
  RETURN p_id;
END $$;

-- ── ۵. بایگانی و بازگرداندن کالا ─────────────────────────────────────
-- بایگانی، تنوع‌های فعال را هم می‌بندد: کالایی که دیگر فروخته نمی‌شود
-- نباید از راه اسکن بارکد وارد سبد شود.
CREATE OR REPLACE FUNCTION catalog.set_product_status(
  p_id uuid, p_status text, p_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_old   text;
  v_n     int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;
  IF p_status NOT IN ('active', 'archived') THEN
    RAISE EXCEPTION 'وضعیت نامعتبر: %', p_status;
  END IF;

  SELECT status INTO v_old FROM catalog.product WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'کالا یافت نشد: %', p_id;
  END IF;
  IF v_old = p_status THEN RETURN; END IF;

  UPDATE catalog.product SET status = p_status WHERE id = p_id;

  IF p_status = 'archived' THEN
    UPDATE catalog.variation SET status = 'archived'
     WHERE product_id = p_id AND status <> 'archived';
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    -- بازگرداندن، تنوع‌ها را **باز نمی‌گرداند**: کدام‌شان باید دوباره
    -- فعال شوند یک تصمیم است، نه نتیجه یک محاسبه.
    v_n := 0;
  END IF;

  PERFORM platform.audit(
    'product.status', 'catalog.product', p_id::text,
    jsonb_build_object('status', p_status, 'variations_archived', v_n),
    v_actor, p_reason, jsonb_build_object('status', v_old));
END $$;

-- ── ۶. وضعیت یک تنوع ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION catalog.set_variation_status(
  p_id uuid, p_status text, p_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_old   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;
  IF p_status NOT IN ('active', 'paused', 'preorder', 'archived') THEN
    RAISE EXCEPTION 'وضعیت نامعتبر: %', p_status;
  END IF;

  SELECT status INTO v_old FROM catalog.variation WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'تنوع یافت نشد: %', p_id;
  END IF;
  IF v_old = p_status THEN RETURN; END IF;

  UPDATE catalog.variation SET status = p_status WHERE id = p_id;

  PERFORM platform.audit(
    'variation.status', 'catalog.variation', p_id::text,
    jsonb_build_object('status', p_status), v_actor, p_reason,
    jsonb_build_object('status', v_old));
END $$;

-- ── ۷. اصلاح مشخصه تنوع — فقط تا وقتی دست‌نخورده است ─────────────────
-- رنگ و سایز روی برچسب چاپ‌شده و در Snapshot فاکتور نشسته‌اند. عوض‌کردن
-- رنگ تنوعی که فروش رفته، یعنی فاکتور پارسال چیز دیگری می‌گوید.
-- پس تنها پنجره اصلاح، پیش از اولین حرکت انبار و اولین فروش است —
-- همان جایی که «غلط تایپی موقع ورود» واقعاً رخ می‌دهد.
CREATE OR REPLACE FUNCTION catalog.amend_variation(
  p_id uuid, p_color text, p_size text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_old   catalog.variation;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;

  SELECT * INTO v_old FROM catalog.variation WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'تنوع یافت نشد: %', p_id;
  END IF;

  IF EXISTS (SELECT 1 FROM inventory.stock_movement WHERE variation_id = p_id) THEN
    RAISE EXCEPTION
      'این تنوع حرکت انبار دارد؛ رنگ و سایزش دیگر عوض نمی‌شود. تنوع تازه بسازید و این را بایگانی کنید.';
  END IF;
  IF EXISTS (SELECT 1 FROM sales.invoice_line WHERE variation_id = p_id) THEN
    RAISE EXCEPTION
      'این تنوع روی فاکتور نشسته؛ رنگ و سایزش دیگر عوض نمی‌شود.';
  END IF;

  UPDATE catalog.variation
     SET color = nullif(btrim(coalesce(p_color, '')), ''),
         size  = nullif(btrim(coalesce(p_size,  '')), '')
   WHERE id = p_id;

  PERFORM platform.audit(
    'variation.amend', 'catalog.variation', p_id::text,
    jsonb_build_object('color', p_color, 'size', p_size), v_actor, NULL,
    jsonb_build_object('color', v_old.color, 'size', v_old.size));
END $$;

-- ── ۸. تغییر قیمت ────────────────────────────────────────────────────
-- تنها مسیر نوشتن روی `catalog.price` پس از این مهاجرت.
--
-- قفل روی سطر **تنوع** گرفته می‌شود، نه سطر قیمت: وقتی هنوز هیچ قیمتی
-- ثبت نشده سطر قیمتی هم برای قفل‌کردن نیست، و دو درخواست هم‌زمان هر دو
-- درج می‌کردند. ایندکس یکتای بند ۲ دومی را رد می‌کرد، ولی با خطای
-- دیتابیس نه پیام فارسی. قفل روی تنوع هر دو حالت را یکجا حل می‌کند.
CREATE OR REPLACE FUNCTION catalog.set_price(
  p_variation_id uuid,
  p_amount       platform.money,
  p_kind         text DEFAULT 'regular',
  p_reason       text DEFAULT NULL,
  p_price_list   text DEFAULT 'default'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_open  catalog.price;
  v_at    timestamptz;
  v_new   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'قیمت منفی ثبت نمی‌شود.';
  END IF;
  IF p_kind NOT IN ('regular', 'markdown', 'promo') THEN
    RAISE EXCEPTION 'نوع قیمت نامعتبر: %', p_kind;
  END IF;

  PERFORM 1 FROM catalog.variation WHERE id = p_variation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'تنوع یافت نشد: %', p_variation_id;
  END IF;

  SELECT * INTO v_open FROM catalog.price
   WHERE variation_id = p_variation_id
     AND price_list   = p_price_list
     AND valid_to IS NULL
   FOR UPDATE;

  -- همان قیمت دوباره = هیچ اتفاقی. یک سطر تاریخچه بدون تغییر مبلغ،
  -- فقط گزارش را شلوغ می‌کند.
  IF FOUND AND v_open.amount = p_amount AND v_open.kind = p_kind THEN
    RETURN v_open.id;
  END IF;

  v_at := clock_timestamp();
  IF FOUND AND v_at <= v_open.valid_from THEN
    v_at := v_open.valid_from + interval '1 microsecond';
  END IF;

  IF FOUND THEN
    UPDATE catalog.price SET valid_to = v_at WHERE id = v_open.id;
  END IF;

  INSERT INTO catalog.price (
    variation_id, price_list, amount, kind, reason, valid_from, created_by)
  VALUES (
    p_variation_id, p_price_list, p_amount, p_kind, p_reason, v_at, v_actor)
  RETURNING id INTO v_new;

  PERFORM platform.audit(
    'price.change', 'catalog.variation', p_variation_id::text,
    jsonb_build_object('amount', p_amount::text, 'kind', p_kind,
                       'price_list', p_price_list, 'valid_from', v_at),
    v_actor, p_reason,
    CASE WHEN v_open.id IS NULL THEN NULL
         ELSE jsonb_build_object('amount', v_open.amount::text,
                                 'kind', v_open.kind) END);
  RETURN v_new;
END $$;

-- ── ۹. نمای «قیمت مؤثر امروز» ────────────────────────────────────────
-- تا هر گزارشی یک تعریف بخواند، نه اینکه هر کوئری شرط زمانی خودش را
-- بنویسد و یکی‌شان `valid_to` را فراموش کند.
CREATE OR REPLACE VIEW catalog.current_price AS
SELECT p.variation_id, p.price_list, p.amount, p.kind, p.valid_from, p.id AS price_id
  FROM catalog.price p
 WHERE p.valid_to IS NULL;

COMMENT ON VIEW catalog.current_price IS
  'قیمت باز هر تنوع. برای «قیمت در تاریخ X» از خودِ catalog.price با بازه استفاده کنید.';

COMMIT;
