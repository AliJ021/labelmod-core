-- =====================================================================
-- ۰۴۳ — فصل کالا، انبار آوتلت، و مقصد کالای مرجوعی
-- =====================================================================
--
-- سه چیز که مالک خواسته و تا امروز نبودند:
--
--   ۱. تفکیک کالا به فصل گرم و سرد
--   ۲. آوتلت — کالای تک‌سایزِ حراجی
--   ۳. «کالای سالمِ برگشتی به فروشگاه برمی‌گردد یا به آوتلت؟»
--
-- ── چرا آوتلت یک انبار است، نه یک برچسب روی کالا ─────────────────────
--
-- وسوسه‌اش یک ستون `is_outlet` روی `catalog.variation` بود. ولی آوتلت
-- یک **مکان** است نه یک صفت: همان تنوع می‌تواند سه تا در قفسه فروشگاه
-- داشته باشد و دو تا در آوتلت، با قیمت‌های متفاوت. یک برچسب روی کالا
-- این را نمی‌تواند بگوید و ناچار بود موجودی را دو تکه کند — یعنی
-- دوباره‌نویسی چیزی که `inventory.stock_balance` از روز اول دارد.
--
-- به‌علاوه انتقال بین انبارها از قبل ساخته شده و ارزش را **دقیقاً**
-- جابه‌جا می‌کند. بردن کالا به آوتلت یعنی همان انتقال، نه یک مسیر تازه.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۱. آوتلت، یک نوع انبار
-- ---------------------------------------------------------------------
-- قید قبلی چهار نوع داشت. جایگزینی قید یعنی سطرهای موجود دوباره
-- سنجیده شوند — که خوب است: اگر امروز نوعی خارج از فهرست در جدول
-- باشد، همین‌جا لو می‌رود نه شش ماه بعد.

ALTER TABLE inventory.warehouse DROP CONSTRAINT IF EXISTS warehouse_kind_check;
ALTER TABLE inventory.warehouse
  ADD CONSTRAINT warehouse_kind_check
  CHECK (kind IN ('store','stock','defective','transit','outlet'));

COMMENT ON COLUMN inventory.warehouse.kind IS
  'store قفسه · stock پشتیبان · defective معیوب · transit در راه · outlet حراجی تک‌سایز';


-- ---------------------------------------------------------------------
-- ۲. فصل — داده، نه متن آزاد
-- ---------------------------------------------------------------------
-- ستون `catalog.product.season` از روز اول `text` آزاد بود. متن آزاد
-- یعنی «پاییز»، «پاييز» (با ی عربی) و «Autumn» سه فصل متفاوت شوند و
-- فیلتر انبار هیچ‌کدام را کامل نگیرد.
--
-- ⚠️ قید با Trigger اعمال می‌شود نه با FOREIGN KEY: کالاهای موجود
--    `season` خالی دارند و یک FK فوری، هر مقدار قدیمیِ خارج از فهرست
--    را به خطای مهاجرت تبدیل می‌کرد. Trigger فقط مقدارِ **تازه** را
--    می‌سنجد و `NULL` را می‌پذیرد.

CREATE TABLE IF NOT EXISTS catalog.season (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  -- گرم یا سرد — همان تفکیکی که مالک خواسته. `all` برای کالای
  -- چهارفصل، که نه گرم است نه سرد و حذفش یعنی زیرپوش هم فصل بگیرد.
  climate    text NOT NULL CHECK (climate IN ('warm','cold','all')),
  sort_order smallint NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE catalog.season IS
  'فصل‌های مجاز کالا با تفکیک گرم/سرد. افزودن فصل یک INSERT است، نه مهاجرت.';

CREATE OR REPLACE FUNCTION catalog.check_season() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- ⚠️ مقدارِ دست‌نخورده رد نمی‌شود.
  --
  -- کالاهای امروز `season` متن آزاد دارند («پاییز ۱۴۰۵»). اگر هر
  -- `UPDATE` روی کالا این مقدار قدیمی را دوباره می‌سنجید، اصلاح
  -- **نام** یک کالای قدیمی هم شکست می‌خورد — انباردار می‌خواست غلط
  -- تایپی نام را درست کند و خطای «فصل تعریف نشده» می‌گرفت، بدون
  -- اینکه بفهمد ربطش چیست.
  --
  -- پس فقط مقدارِ **تازه** سنجیده می‌شود. مقدار قدیمی سر جایش
  -- می‌ماند تا کسی عمداً عوضش کند.
  IF TG_OP = 'UPDATE' AND NEW.season IS NOT DISTINCT FROM OLD.season THEN
    RETURN NEW;
  END IF;

  IF NEW.season IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM catalog.season
                      WHERE code = NEW.season AND is_active) THEN
    RAISE EXCEPTION 'فصل «%» تعریف نشده است.', NEW.season;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS product_season_check ON catalog.product;
CREATE TRIGGER product_season_check
  BEFORE INSERT OR UPDATE OF season ON catalog.product
  FOR EACH ROW EXECUTE FUNCTION catalog.check_season();


-- ---------------------------------------------------------------------
-- ۳. مقصد کالای مرجوعی
-- ---------------------------------------------------------------------
-- `sales.sale_return.warehouse_id` از قبل بود و `post_return` هم
-- کالای **معیوب** را به انبار معیوب می‌فرستد. آنچه نبود، انتخاب مقصد
-- برای کالای **سالم** است: امروز همیشه به انبار همان فاکتور
-- برمی‌گردد.
--
-- تصمیمِ «به قفسه یا به آوتلت» یک تصمیم انسانی است، نه نتیجه یک
-- محاسبه — مثل بستن سفارش خرید. پس تابعی که مقصد را عوض کند، و
-- سنجشی که نگذارد برگه‌ی ثبت‌شده جابه‌جا شود.

CREATE OR REPLACE FUNCTION sales.set_return_warehouse(
  p_return    uuid,
  p_warehouse uuid,
  p_user      uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_branch uuid; v_status text; v_wh_branch uuid; v_kind text;
BEGIN
  SELECT branch_id, status INTO v_branch, v_status
    FROM sales.sale_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'برگ مرجوعی یافت نشد.';
  END IF;

  -- برگه ثبت‌شده تغییرناپذیر است. جابه‌جایی پس از ثبت یعنی موجودی در
  -- انباری بنشیند که حرکتش جای دیگری ثبت شده — و حرکت انبار
  -- تغییرناپذیر است، پس اصلاحش فقط با حرکت معکوس ممکن بود.
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'برگ مرجوعی ثبت‌شده است و مقصدش عوض نمی‌شود. برای جابه‌جایی از انتقال بین انبارها استفاده کنید.';
  END IF;

  SELECT branch_id, kind INTO v_wh_branch, v_kind
    FROM inventory.warehouse WHERE id = p_warehouse AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'انبار مقصد یافت نشد یا غیرفعال است.';
  END IF;

  -- دامنه شعبه: بدون این، برگه‌ی شعبه A می‌توانست کالا را به انبار
  -- شعبه B ببرد — همان کلاسی که `transfer-routes.ts` سه سنجش برایش
  -- دارد.
  IF v_wh_branch <> v_branch THEN
    RAISE EXCEPTION 'انبار مقصد متعلق به شعبه دیگری است.';
  END IF;

  -- انبار «در راه» مقصد یک مرجوعی نیست: کالایی که مشتری پس داده،
  -- در راه جایی نیست.
  IF v_kind = 'transit' THEN
    RAISE EXCEPTION 'انبار در راه نمی‌تواند مقصد مرجوعی باشد.';
  END IF;

  UPDATE sales.sale_return SET warehouse_id = p_warehouse WHERE id = p_return;

  PERFORM platform.audit('return.set_warehouse', 'sale_return', p_return::text,
                         jsonb_build_object('warehouse_id', p_warehouse), p_user);
END $$;
COMMENT ON FUNCTION sales.set_return_warehouse IS
  'مقصد کالای سالمِ برگشتی — قفسه یا آوتلت. فقط روی پیش‌نویس، و فقط در همان شعبه. معیوب همچنان خودکار به انبار معیوب می‌رود.';


-- ---------------------------------------------------------------------
-- ۴. نمای موجودی آوتلت
-- ---------------------------------------------------------------------
-- «چه چیزی در آوتلت است و چند وقت است آنجاست» — پرسشی که تصمیم
-- حراج بعدی را می‌سازد. از `stock_balance` می‌آید، نه از یک ستون
-- موازی.

CREATE OR REPLACE VIEW inventory.outlet_stock AS
  SELECT w.id            AS warehouse_id,
         w.code          AS warehouse_code,
         w.branch_id,
         v.id            AS variation_id,
         v.sku,
         p.name_internal AS product_name,
         v.color,
         v.size,
         p.season,
         s.climate,
         b.on_hand AS qty,
         b.total_value,
         CASE WHEN b.on_hand > 0 THEN round(b.total_value / b.on_hand) ELSE 0 END AS unit_cost
    FROM inventory.stock_balance b
    JOIN inventory.warehouse w  ON w.id = b.warehouse_id
    JOIN catalog.variation   v  ON v.id = b.variation_id
    JOIN catalog.product     p  ON p.id = v.product_id
    LEFT JOIN catalog.season s  ON s.code = p.season
   WHERE w.kind = 'outlet' AND b.on_hand <> 0;

COMMENT ON VIEW inventory.outlet_stock IS
  'موجودی آوتلت با فصل و بهای واحد. از stock_balance می‌آید، نه از ستون موازی.';
