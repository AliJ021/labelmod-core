-- =====================================================================
-- ۰۴۴ — خرید برای دیگری، و بسته‌بندی هدیه
-- =====================================================================
--
-- دو چیز که مالک خواسته:
--
--   «اگر برای خودش می‌خرد، محصولات بر اساس سایزش فیلتر شود.
--    اگر برای دیگری است، مشخصات آن شخص کامل وارد شود.»
--   «گزینه هدیه: شیوه بسته‌بندی، یادداشت، گل همراه، رنگ بسته.»
--
-- ── چرا گیرنده یک مشتری است، نه چند ستون روی فاکتور ─────────────────
--
-- وسوسه‌اش `recipient_name` و `recipient_mobile` روی `sales.invoice`
-- بود. ولی گیرنده **خودش یک مشتری است**: همان کسی که پارسال برایش
-- خریدند، امسال ممکن است خودش بیاید. با ستون روی فاکتور، آن دو
-- هرگز یکی نمی‌شدند و اندازه‌هایی که برای هدیه ثبت شده بود در
-- پرونده خودش پیدا نمی‌شد.
--
-- پس `recipient_id` یک ارجاع به `sales.customer` است و از همان
-- `normalize_mobile` می‌گذرد — یعنی شماره تکراری مشتری دوم نمی‌سازد،
-- همان قاعده‌ای که کل پرونده مشتری بر آن است.
--
-- ── چرا هدیه یک جدول جداست ─────────────────────────────────────────
--
-- شش ستون هدیه روی `invoice` یعنی هر فاکتور معمولی هم شش ستون خالی
-- حمل کند. و مهم‌تر: گزینه‌های بسته‌بندی و رنگ **داده‌اند** — فروشگاه
-- امسال سه رنگ کاغذ دارد و سال بعد پنج تا.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۱. گیرنده
-- ---------------------------------------------------------------------
ALTER TABLE sales.invoice
  ADD COLUMN IF NOT EXISTS recipient_id uuid REFERENCES sales.customer(id);

COMMENT ON COLUMN sales.invoice.recipient_id IS
  'گیرنده، وقتی خرید برای دیگری است. NULL یعنی خریدار خودش گیرنده است.';

-- ⚠️ گیرنده نمی‌تواند خودِ خریدار باشد.
--
-- نه از سر وسواس: «خرید برای دیگری» با گیرنده‌ای که همان خریدار است،
-- یعنی گزارش‌های بعدی یک هدیه بشمارند که هدیه نبوده. و اگر کسی
-- سهواً همان مشتری را انتخاب کند، هیچ خطایی نمی‌گرفت.
ALTER TABLE sales.invoice DROP CONSTRAINT IF EXISTS invoice_recipient_not_self;
ALTER TABLE sales.invoice
  ADD CONSTRAINT invoice_recipient_not_self
  CHECK (recipient_id IS NULL OR recipient_id IS DISTINCT FROM customer_id);


-- ---------------------------------------------------------------------
-- ۲. گزینه‌های بسته‌بندی — داده مرجع
-- ---------------------------------------------------------------------
-- `kind` می‌گوید این گزینه از کدام دسته است: کاغذ، رنگ، یا گل.
-- سه جدول جدا برای سه فهرستِ هم‌شکل، سه برابر کد یکسان می‌خواست.

CREATE TABLE IF NOT EXISTS sales.gift_option (
  code       text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('wrap','color','flower')),
  label      text NOT NULL,
  -- هزینه اختیاری. صفر یعنی رایگان — و `NULL` نیست، چون «رایگان» یک
  -- تصمیم است نه یک ندانستن.
  price      platform.money NOT NULL DEFAULT 0 CHECK (price >= 0),
  sort_order smallint NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE sales.gift_option IS
  'کاغذ، رنگ و گلِ بسته هدیه. افزودن گزینه یک INSERT است، نه مهاجرت.';


-- ---------------------------------------------------------------------
-- ۳. هدیه بودن یک فاکتور
-- ---------------------------------------------------------------------
-- یک سطر به‌ازای هر فاکتورِ هدیه. فاکتور معمولی سطری ندارد — نه یک
-- سطر با همه ستون‌های خالی.

CREATE TABLE IF NOT EXISTS sales.invoice_gift (
  invoice_id  uuid PRIMARY KEY REFERENCES sales.invoice(id) ON DELETE CASCADE,
  wrap_code   text REFERENCES sales.gift_option(code),
  color_code  text REFERENCES sales.gift_option(code),
  flower_code text REFERENCES sales.gift_option(code),
  -- یادداشت روی کارت. ورودی کاربر است و روی برگه چاپ می‌شود، پس
  -- طولش کران دارد و نویسه کنترلی در لایه API فیلتر می‌شود.
  note        text,
  -- ⚠️ «قیمت را روی کارت ننویس» — درخواست همیشگی خریدار هدیه.
  hide_prices boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sales.invoice_gift IS
  'بسته‌بندی هدیه یک فاکتور. نبودِ سطر یعنی هدیه نیست.';

-- هر کد باید از دسته درست باشد. بدون این، «گل رز» می‌توانست در
-- ستون کاغذ بنشیند و برگه چاپی چیز بی‌معنایی بگوید.
CREATE OR REPLACE FUNCTION sales.check_gift_kinds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF NEW.wrap_code IS NOT NULL THEN
    SELECT kind INTO k FROM sales.gift_option WHERE code = NEW.wrap_code;
    IF k <> 'wrap' THEN RAISE EXCEPTION '«%» یک شیوه بسته‌بندی نیست.', NEW.wrap_code; END IF;
  END IF;
  IF NEW.color_code IS NOT NULL THEN
    SELECT kind INTO k FROM sales.gift_option WHERE code = NEW.color_code;
    IF k <> 'color' THEN RAISE EXCEPTION '«%» یک رنگ نیست.', NEW.color_code; END IF;
  END IF;
  IF NEW.flower_code IS NOT NULL THEN
    SELECT kind INTO k FROM sales.gift_option WHERE code = NEW.flower_code;
    IF k <> 'flower' THEN RAISE EXCEPTION '«%» یک گل نیست.', NEW.flower_code; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS invoice_gift_kinds ON sales.invoice_gift;
CREATE TRIGGER invoice_gift_kinds
  BEFORE INSERT OR UPDATE ON sales.invoice_gift
  FOR EACH ROW EXECUTE FUNCTION sales.check_gift_kinds();


-- ---------------------------------------------------------------------
-- ۴. نوشتن — تنها مسیر
-- ---------------------------------------------------------------------
-- ⚠️ فقط روی فاکتور **باز**. پس از نهایی‌شدن، فاکتور تغییرناپذیر
--    است و برگه هدیه هم بخشی از همان سند است: تغییرش پس از تحویل
--    یعنی چیزی که مشتری برد با آنچه در سیستم است فرق کند.

CREATE OR REPLACE FUNCTION sales.set_invoice_gift(
  p_invoice uuid,
  p_wrap    text DEFAULT NULL,
  p_color   text DEFAULT NULL,
  p_flower  text DEFAULT NULL,
  p_note    text DEFAULT NULL,
  p_hide    boolean DEFAULT true,
  p_user    uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد.'; END IF;
  IF v_status NOT IN ('draft','confirmed','partially_paid') THEN
    RAISE EXCEPTION 'فاکتور نهایی شده است و بسته‌بندی‌اش عوض نمی‌شود.';
  END IF;

  INSERT INTO sales.invoice_gift
    (invoice_id, wrap_code, color_code, flower_code, note, hide_prices)
  VALUES (p_invoice, p_wrap, p_color, p_flower, p_note, coalesce(p_hide, true))
  ON CONFLICT (invoice_id) DO UPDATE
     SET wrap_code   = EXCLUDED.wrap_code,
         color_code  = EXCLUDED.color_code,
         flower_code = EXCLUDED.flower_code,
         note        = EXCLUDED.note,
         hide_prices = EXCLUDED.hide_prices;

  PERFORM platform.audit('invoice.set_gift', 'invoice', p_invoice::text,
    jsonb_build_object('wrap', p_wrap, 'color', p_color, 'flower', p_flower,
                       'hide_prices', coalesce(p_hide, true)),
    p_user);
END $$;

CREATE OR REPLACE FUNCTION sales.clear_invoice_gift(
  p_invoice uuid, p_user uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد.'; END IF;
  IF v_status NOT IN ('draft','confirmed','partially_paid') THEN
    RAISE EXCEPTION 'فاکتور نهایی شده است و بسته‌بندی‌اش عوض نمی‌شود.';
  END IF;
  DELETE FROM sales.invoice_gift WHERE invoice_id = p_invoice;
  PERFORM platform.audit('invoice.clear_gift', 'invoice', p_invoice::text, NULL, p_user);
END $$;


-- ---------------------------------------------------------------------
-- ۵. گیرنده
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sales.set_invoice_recipient(
  p_invoice uuid, p_recipient uuid, p_user uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_status text; v_customer uuid;
BEGIN
  SELECT status, customer_id INTO v_status, v_customer
    FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد.'; END IF;
  IF v_status NOT IN ('draft','confirmed','partially_paid') THEN
    RAISE EXCEPTION 'فاکتور نهایی شده است و گیرنده‌اش عوض نمی‌شود.';
  END IF;

  IF p_recipient IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales.customer WHERE id = p_recipient) THEN
      RAISE EXCEPTION 'گیرنده یافت نشد.';
    END IF;
    IF p_recipient = v_customer THEN
      RAISE EXCEPTION 'گیرنده نمی‌تواند خودِ خریدار باشد.';
    END IF;
  END IF;

  UPDATE sales.invoice SET recipient_id = p_recipient WHERE id = p_invoice;
  PERFORM platform.audit('invoice.set_recipient', 'invoice', p_invoice::text,
    jsonb_build_object('recipient_id', p_recipient), p_user);
END $$;
