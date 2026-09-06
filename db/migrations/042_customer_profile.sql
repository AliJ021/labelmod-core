-- =====================================================================
-- ۰۴۲ — شناسنامه مشتری: نشانی، کد پستی، و اندازه‌های بدن
-- =====================================================================
--
-- تا امروز `sales.customer` فقط نام، موبایل، ایمیل و تولد داشت. برای
-- ارسال سفارش سایت نشانی لازم است، و برای «کدام سایز به این شخص
-- می‌خورد» اندازه بدنش.
--
-- ── چرا اندازه یک جدول است، نه چند ستون ──────────────────────────────
--
-- ستون‌های `chest`، `waist`، `inseam` … یعنی هر اندازه تازه یک مهاجرت
-- می‌خواهد. فروشگاه پوشاک امروز دور سینه می‌خواهد و فردا دور مچ؛
-- اندازه‌ها **داده‌اند نه اسکیما**. `catalog.variation_measure` از روز
-- اول همین شکل را داشت و این جدول قرینه‌اش است — تا روزی که موتور
-- پیشنهاد سایز این دو را کنار هم بگذارد.
--
-- ⚠️ کلیدهای مجاز در `sales.measure_key` می‌نشینند، نه در CHECK: یک
--    CHECK یعنی افزودن «دور مچ» باز هم مهاجرت بخواهد. جدول مرجع یعنی
--    یک `INSERT` در Seed.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۱. نشانی و کد پستی
-- ---------------------------------------------------------------------
-- نشانی یک متن آزاد است و باید باشد: نشانی ایرانی قالب ثابتی ندارد و
-- شکستنش به کوچه و پلاک، انباردار را وادار می‌کند چیزی را در خانه‌ای
-- بگذارد که جایش نیست.
--
-- کد پستی اما **ده رقم** است و قالب دارد. همان قاعده موبایل: نرمال‌سازی
-- در دیتابیس، نه در TypeScript — وگرنه سفارش سایت و صندوق دو تعریف
-- پیدا می‌کنند و یکی‌شان رقم فارسی را رد می‌کند.

ALTER TABLE sales.customer
  ADD COLUMN IF NOT EXISTS address     text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS city        text,
  ADD COLUMN IF NOT EXISTS province    text;

COMMENT ON COLUMN sales.customer.postal_code IS
  'ده رقم، نرمال‌شده با sales.normalize_postal_code. NULL یعنی نداریم.';

/**
 * نرمال‌سازی کد پستی — تنها تعریف.
 *
 * رقم فارسی و عربی، فاصله و خط تیره را می‌پذیرد و ده رقم لاتین
 * می‌دهد. هر چیز دیگری `NULL` است، نه یک رشته نصفه: کد پستی نصفه در
 * برچسب پستی یعنی بسته برنگردد.
 */
CREATE OR REPLACE FUNCTION sales.normalize_postal_code(p_raw text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d ~ '^[0-9]{10}$' THEN d
    ELSE NULL
  END
  FROM (
    SELECT regexp_replace(
             translate(coalesce(p_raw, ''),
                       '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩',
                       '01234567890123456789'),
             '[^0-9]', '', 'g') AS d
  ) t;
$$;
COMMENT ON FUNCTION sales.normalize_postal_code IS
  'کد پستی ده‌رقمی. رقم فارسی و عربی و جداکننده را می‌فهمد؛ هر چیز دیگری NULL.';


-- ---------------------------------------------------------------------
-- ۲. کلیدهای اندازه — داده، نه CHECK
-- ---------------------------------------------------------------------
-- برچسب فارسی، واحد و بازه مجاز اینجا می‌نشینند تا فرم `apps/web` از
-- همین فراداده ساخته شود — همان الگوی `platform.setting`. اگر لازم شد
-- فهرست کلیدها را در React بنویسیم، یعنی یک ستون اینجا کم است.

CREATE TABLE IF NOT EXISTS sales.measure_key (
  key        text PRIMARY KEY,
  label      text NOT NULL,
  unit       text NOT NULL DEFAULT 'cm',
  -- بازه، برای گرفتن غلط تایپی. قد ۱۷ سانت یا ۱۷۰۰ سانت وجود ندارد.
  min_value  numeric(6,1) NOT NULL,
  max_value  numeric(6,1) NOT NULL,
  -- گروه: بالاتنه | پایین‌تنه | پا | عمومی
  group_key  text NOT NULL DEFAULT 'general',
  sort_order smallint NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true,
  CONSTRAINT measure_range CHECK (max_value > min_value)
);
COMMENT ON TABLE sales.measure_key IS
  'کلیدهای مجاز اندازه بدن — با برچسب، واحد و بازه. فرم از همین ساخته می‌شود.';

CREATE TABLE IF NOT EXISTS sales.customer_measure (
  customer_id uuid NOT NULL REFERENCES sales.customer(id) ON DELETE CASCADE,
  key         text NOT NULL REFERENCES sales.measure_key(key),
  value_cm    numeric(6,1) NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, key)
);
COMMENT ON TABLE sales.customer_measure IS
  'اندازه بدن مشتری. اختیاری و قابل حذف — بند ۳ SECURITY.md.';


-- ---------------------------------------------------------------------
-- ۳. نوشتن اندازه‌ها
-- ---------------------------------------------------------------------
-- ⚠️ بازه از **جدول** خوانده می‌شود نه از یک CHECK ثابت، پس مالک
--    می‌تواند بازه را عوض کند بدون Deploy. مقدار بیرون بازه رد می‌شود،
--    نه گرد: «۱۷ سانت قد» یک غلط تایپی است و ذخیره‌اش یعنی موتور
--    پیشنهاد سایز فردا چیز عجیبی بگوید.
--
-- ⚠️ `p_values` یک JSON از کلید به عدد است و **جایگزین کامل** می‌شود،
--    نه ادغام: فرمی که یک اندازه را پاک می‌کند باید واقعاً پاکش کند.

CREATE OR REPLACE FUNCTION sales.set_customer_measures(
  p_customer uuid,
  p_values   jsonb,
  p_user     uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  k text; v numeric; lo numeric; hi numeric; lbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sales.customer WHERE id = p_customer) THEN
    RAISE EXCEPTION 'مشتری یافت نشد.';
  END IF;

  FOR k, v IN SELECT key, (value #>> '{}')::numeric FROM jsonb_each(p_values)
  LOOP
    SELECT min_value, max_value, label INTO lo, hi, lbl
      FROM sales.measure_key WHERE key = k AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'اندازه «%» تعریف نشده است.', k;
    END IF;
    IF v < lo OR v > hi THEN
      RAISE EXCEPTION 'مقدار % برای «%» خارج از بازه مجاز (% تا %) است.',
        v, lbl, lo, hi;
    END IF;
  END LOOP;

  DELETE FROM sales.customer_measure WHERE customer_id = p_customer;
  INSERT INTO sales.customer_measure (customer_id, key, value_cm)
  SELECT p_customer, key, (value #>> '{}')::numeric FROM jsonb_each(p_values);

  PERFORM platform.audit('customer.set_measures', 'customer',
                         p_customer::text, p_values, p_user);
END $$;
COMMENT ON FUNCTION sales.set_customer_measures IS
  'جایگزینی کامل اندازه‌های یک مشتری. بازه از sales.measure_key می‌آید، نه از CHECK.';
