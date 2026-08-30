-- =====================================================================
-- ۰۱۰ — تغییر دستی قیمت روی سطر فاکتور، و اجبار ثبت دلیل
-- =====================================================================
-- مالک خواسته: «مثل دشت، موقعی که محصول به فاکتور فروش اضافه می‌شود
-- باید امکان این باشد تا قیمت به‌صورت دستی تغییر کند» — با یک قید
-- صریح: «یک وقت داخل فاکتور فروش دوتا قیمت نخورد.»
--
-- ## آن قید، کل طراحی را تعیین می‌کند
--
-- راه ساده این بود که تفاوت را تخفیف بنویسیم. ولی آن‌وقت فاکتور
-- «۵۰۰٬۰۰۰ منهای ۵۰٬۰۰۰» نشان می‌داد، نه «۴۵۰٬۰۰۰» — یعنی دقیقاً
-- همان دو قیمتی که مالک نمی‌خواهد.
--
-- پس قیمت تازه در `unit_price` می‌نشیند و **فاکتور یک عدد نشان
-- می‌دهد**. قیمت فهرست در ستون تازه `list_price` نگه داشته می‌شود:
-- برای حسابرسی و گزارش، نه برای چاپ.
--
--   list_price IS NULL   → قیمت از فهرست آمده، دست نخورده
--   list_price NOT NULL  → قیمت دستی خورده، و این عدد اصلش است
--
-- ## و همین‌جا یک در باز می‌شود که باید بسته شود
--
-- `.claude/rules/api.md` می‌گوید «قیمت از دیتابیس می‌آید، نه از
-- کلاینت» و ادامه می‌دهد: «تخفیف یک میدان جداگانه و **مجوزدار** است،
-- نه یک قیمت کمتر.» حالا که قیمت کمتر ممکن شده، اگر مجوزش را نگیریم
-- کل نردبان تخفیف بی‌معنا می‌شود: صندوق‌داری با سقف ۱۰٪ کافی بود
-- به‌جای تخفیف، قیمت را نصف بنویسد.
--
-- پس دو دروازه، نه یکی:
--   sale.price_override  — اجازه **تایپ‌کردن** قیمت
--   sale.discount / _high — سقف **مبلغی که مشتری کمتر می‌دهد**،
--                           چه از راه تخفیف، چه از راه قیمت دستی
--
-- دروازه دوم در لایه API است (همان‌جا که نردبان تخفیف هست) و این
-- مهاجرت، دروازه سومی می‌سازد که هیچ مسیری نمی‌تواند دورش بزند.
--
-- ## دروازه سوم: تنظیمی که تا امروز چیزی نمی‌خواندش
--
-- `discount.require_reason_above_percent` از روز اول در جدول تنظیمات
-- بود و **هیچ کدی نمی‌خواندش**. یعنی یک وعده که سیستم عمل نمی‌کرد.
--
-- حالا یک Trigger روی `invoice_line` می‌سنجدش — و روی «کاهش کل» نه
-- فقط تخفیف: چه تخفیف باشد، چه قیمت دستی، چه هر دو. تنها راه بستن
-- این در بود؛ در لایه API هر مسیر تازه‌ای می‌توانست فراموشش کند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. قیمت فهرست، کنار قیمت فروش
-- ---------------------------------------------------------------------

ALTER TABLE sales.invoice_line
  ADD COLUMN list_price            platform.money,
  ADD COLUMN price_override_reason text,
  ADD CONSTRAINT invoice_line_list_price_ck CHECK (list_price IS NULL OR list_price > 0);

COMMENT ON COLUMN sales.invoice_line.list_price IS
  'قیمت فهرست در لحظه فروش — فقط وقتی قیمت دستی خورده باشد. NULL یعنی قیمت دست‌نخورده. برای حسابرسی است، نه برای چاپ فاکتور.';
COMMENT ON COLUMN sales.invoice_line.price_override_reason IS
  'دلیل تغییر دستی قیمت. بالاتر از discount.require_reason_above_percent اجباری است.';

-- ---------------------------------------------------------------------
-- ۲. «کاهش کل» — یک عدد، صرف‌نظر از راهش
-- ---------------------------------------------------------------------
-- مبلغی که مشتری نسبت به قیمت فهرست کمتر می‌دهد. اگر قیمت دستی نخورده
-- باشد، همان تخفیف است.

CREATE OR REPLACE FUNCTION sales.line_markdown(p_line sales.invoice_line)
RETURNS platform.money LANGUAGE sql IMMUTABLE AS $$
  SELECT round(p_line.qty * coalesce(p_line.list_price, p_line.unit_price))
       - (round(p_line.qty * p_line.unit_price) - p_line.discount_amount);
$$;

COMMENT ON FUNCTION sales.line_markdown IS
  'کاهش کل سطر نسبت به قیمت فهرست — تخفیف به‌علاوه تفاوت قیمت دستی. منفی یعنی گران‌تر از فهرست فروخته شده.';

-- ---------------------------------------------------------------------
-- ۳. دلیل، بالاتر از آستانه، اجباری
-- ---------------------------------------------------------------------
-- روی `invoice_line` می‌نشیند نه روی لایه API، چون آنجا هر مسیر تازه‌ای
-- می‌تواند فراموشش کند — و شش ماه بعد کسی نمی‌فهمد چرا نصف فاکتورها
-- بی‌دلیل تخفیف خورده‌اند.
--
-- آستانه **داده** است. صفر یعنی هر کاهشی دلیل می‌خواهد؛ ۱۰۰ یعنی
-- هیچ‌کدام.

CREATE OR REPLACE FUNCTION sales.invoice_line_reason_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_list      platform.money;
  v_markdown  platform.money;
  v_threshold numeric;
  v_percent   numeric;
BEGIN
  v_markdown := sales.line_markdown(NEW);
  IF v_markdown <= 0 THEN
    RETURN NEW;                       -- گران‌تر یا برابر فهرست: دلیلی لازم نیست
  END IF;

  v_list := round(NEW.qty * coalesce(NEW.list_price, NEW.unit_price));
  IF v_list <= 0 THEN
    RETURN NEW;
  END IF;

  v_threshold := platform.setting_num('discount.require_reason_above_percent', 100);
  v_percent   := v_markdown * 100 / v_list;

  IF v_percent > v_threshold
     AND coalesce(btrim(NEW.discount_reason), '') = ''
     AND coalesce(btrim(NEW.price_override_reason), '') = '' THEN
    RAISE EXCEPTION
      'کاهش قیمت %٪ بیشتر از سقف بدون دلیل (%٪) است؛ دلیل تخفیف یا تغییر قیمت را ثبت کنید.',
      round(v_percent, 1), v_threshold;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER invoice_line_reason_guard
  BEFORE INSERT OR UPDATE ON sales.invoice_line
  FOR EACH ROW EXECUTE FUNCTION sales.invoice_line_reason_guard();

-- ---------------------------------------------------------------------
-- ۴. قیمت دستی هم با PIN انجام نمی‌شود
-- ---------------------------------------------------------------------
-- `price.change` (تغییر قیمت کاتالوگ) از روز اول در فهرست ممنوعه PIN
-- بود. قیمت دستی روی فاکتور همان کار را با اثر مالی مستقیم‌تر می‌کند،
-- پس همان‌جا می‌نشیند.
--
-- برای دیتابیس موجود لازم است: seed مقدار را دست نمی‌زند (فقط فراداده
-- را تازه می‌کند)، پس بدون این UPDATE، شکاف روی نصب فعلی باز می‌ماند.
-- Idempotent و فقط افزودنی.

UPDATE platform.setting
   SET value = value || '["sale.price_override"]'::jsonb
 WHERE key = 'auth.pin_forbidden_operations'
   AND NOT (value ? 'sale.price_override');

COMMIT;
