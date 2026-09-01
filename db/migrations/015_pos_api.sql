-- =====================================================================
-- ۰۱۵ — تغییر اتمیک تعداد سطر، و «سبد فقط در Draft عوض می‌شود» در دیتابیس
-- =====================================================================
-- صندوق باید بتواند تعداد یک قلم را کم و زیاد کند. تا امروز هیچ مسیری
-- برای این کار نبود و تنها راه، حذف سطر و افزودن دوباره‌اش بود —
-- یعنی Snapshot قیمت از دست می‌رفت و قیمت دوباره از `catalog.price`
-- خوانده می‌شد. برای فاکتوری که قیمت لحظه فروش را نگه می‌دارد، این
-- یک اصلاح نیست؛ یک بازقیمت‌گذاری بی‌صداست.
--
-- سه چیز، همه افزایشی:
--
--   ۱. `sales.refresh_invoice_totals` — همان SQL بازسازی جمع‌ها که تا
--      امروز فقط داخل لایه TypeScript بود. دو مسیر نباید دو تعریف از
--      یک جمع داشته باشند.
--   ۲. `sales.set_line_qty` — تغییر تعداد زیر قفل فاکتور، با حفظ
--      کامل Snapshot و محاسبه مبلغ در SQL.
--   ۳. `invoice_line_draft_guard` — قاعده «سبد فقط تا پیش از
--      نهایی‌سازی عوض می‌شود» از لایه API به دیتابیس می‌آید.
--
-- درباره ۳ و اینکه چرا نهایی‌سازی و مرجوعی را نمی‌شکند:
--   `sales.finalize_invoice` اول `unit_cost` و `cogs_amount` سطرها را
--   می‌نویسد و **بعد** وضعیت فاکتور را عوض می‌کند — یعنی در آن لحظه
--   فاکتور هنوز `draft` است و نگهبان کاری ندارد. تنها نوشتنِ پس از
--   نهایی‌سازی، افزودن `returned_qty` در `sales.post_return` است و
--   نگهبان دقیقاً همان یک ستون را باز می‌گذارد.
--
-- توابع بدون SECURITY DEFINER می‌مانند (مثل بقیه توابع این مخزن): با
-- دسترسی خودِ فراخوان اجرا می‌شوند و هیچ اختیار تازه‌ای نمی‌دهند.
-- `search_path` صریح پین شده تا نام‌ها از اسکیمای جعلی خوانده نشوند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. بازسازی جمع‌های فاکتور — یک تعریف، در دیتابیس
-- ---------------------------------------------------------------------
-- جمع‌ها از سطرها **بازساخته** می‌شوند، نه انباشته. انباشتن یعنی حذف
-- یک سطر باید دقیقاً همان عددی را کم کند که افزوده بود؛ یک گرد کردن
-- متفاوت و جمع‌ها بی‌صدا از سطرها جدا می‌افتند.

CREATE OR REPLACE FUNCTION sales.refresh_invoice_totals(p_invoice uuid)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog AS $$
  UPDATE sales.invoice i SET
    gross_amount    = t.gross,
    discount_amount = t.disc,
    net_amount      = t.net,
    tax_amount      = t.tax,
    payable_amount  = t.net + t.tax + i.shipping_amount
  FROM (
    SELECT coalesce(sum(qty * unit_price), 0) AS gross,
           coalesce(sum(discount_amount), 0)  AS disc,
           coalesce(sum(net_amount), 0)       AS net,
           coalesce(sum(tax_amount), 0)       AS tax
      FROM sales.invoice_line WHERE invoice_id = p_invoice
  ) t
  WHERE i.id = p_invoice;
$$;

COMMENT ON FUNCTION sales.refresh_invoice_totals IS
  'جمع‌های فاکتور را از روی سطرها بازمی‌سازد. تنها مرجع جمع فاکتور.';

-- ---------------------------------------------------------------------
-- ۲. تغییر اتمیک تعداد
-- ---------------------------------------------------------------------
-- قفل روی خودِ فاکتور است نه فقط سطر: دو اسکن هم‌زمان یک سبد باید
-- ترتیب قطعی داشته باشند، وگرنه یکی از افزایش‌ها گم می‌شود.
--
-- `platform.qty` را می‌پذیرد نه فقط عدد صحیح — دیتابیس جای محدودکردن
-- واحد فروش نیست. صندوق پوشاک امروز کالای تعدادی می‌فروشد و همان
-- محدودیت را لایه API اعمال می‌کند؛ اگر روزی متر پارچه فروخته شود،
-- این تابع لازم نیست عوض شود.
--
-- سطری که قیمتش دستی خورده یا تخفیف دارد از این مسیر رد می‌شود:
-- `discount_amount` یک مبلغ **مطلق** برای تعدادِ آن لحظه است. با
-- تغییر تعداد، یا باید مطلق بماند (و درصد کاهش بی‌صدا عوض شود) یا
-- نسبتی شود (و مبلغ ثبت‌شده بی‌صدا عوض شود). هر دو یک تصمیم مالی‌اند،
-- نه یک جزئیات فنی — پس تا وقتی گرفته نشده، این مسیر بازش نمی‌کند.

CREATE OR REPLACE FUNCTION sales.set_line_qty(
  p_invoice uuid, p_line uuid, p_qty platform.qty
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE
  v_status text;
  l        sales.invoice_line%ROWTYPE;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'تعداد باید بزرگ‌تر از صفر باشد';
  END IF;

  -- قفل فاکتور **پیش از** خواندن سطر: بدون این، دو درخواست هم‌زمان
  -- هر دو تعداد قدیمی را می‌خوانند.
  SELECT status INTO v_status FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاکتور یافت نشد';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'فاکتور در وضعیت «%» است و سبد آن دیگر تغییر نمی‌کند', v_status;
  END IF;

  -- تعلق سطر به همین فاکتور، در همان کوئری. جدا سنجیدنش یعنی یک
  -- مسیر دیگر می‌تواند فراموشش کند.
  SELECT * INTO l FROM sales.invoice_line
    WHERE id = p_line AND invoice_id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'این قلم در فاکتور نیست';
  END IF;

  IF l.discount_amount > 0 OR l.list_price IS NOT NULL THEN
    RAISE EXCEPTION 'تعداد سطری که تخفیف خورده یا قیمتش دستی تغییر کرده از این مسیر عوض نمی‌شود؛ سطر را حذف و دوباره ثبت کنید.';
  END IF;

  UPDATE sales.invoice_line
     SET qty        = p_qty,
         net_amount = round(p_qty * unit_price) - discount_amount
   WHERE id = p_line;

  PERFORM sales.refresh_invoice_totals(p_invoice);
END $$;

COMMENT ON FUNCTION sales.set_line_qty IS
  'تعداد یک سطر سبد را زیر قفل فاکتور عوض می‌کند. Snapshot قیمت دست‌نخورده می‌ماند و مبلغ در SQL حساب می‌شود.';

-- ---------------------------------------------------------------------
-- ۳. سبد فقط تا پیش از نهایی‌سازی عوض می‌شود
-- ---------------------------------------------------------------------
-- تا امروز این قاعده فقط در لایه API بود و آنجا هم بیرون از تراکنش
-- سنجیده می‌شد: میان «خواندم و draft بود» تا «نوشتم»، یک نهایی‌سازی
-- هم‌زمان جا می‌شد. حالا دیتابیس خودش جلویش را می‌گیرد.
--
-- مقایسه با `to_jsonb` روی کل سطر انجام می‌شود، نه ستون‌به‌ستون: ستون
-- تازه‌ای که فردا اضافه شود، خودبه‌خود پوشانده می‌شود. فهرست دستی
-- ستون‌ها همان چیزی است که شش ماه بعد از قلم می‌افتد.

CREATE OR REPLACE FUNCTION sales.invoice_line_draft_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE
  v_invoice uuid;
  v_status  text;
BEGIN
  v_invoice := coalesce(NEW.invoice_id, OLD.invoice_id);

  SELECT status INTO v_status FROM sales.invoice WHERE id = v_invoice;
  IF NOT FOUND THEN
    -- خودِ فاکتور در حال حذف است (CASCADE). چیزی برای محافظت نمانده.
    RETURN coalesce(NEW, OLD);
  END IF;

  IF v_status = 'draft' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- تنها تغییر مجاز پس از نهایی‌سازی: ثبت مقدار مرجوعی.
    IF (to_jsonb(NEW) - 'returned_qty') IS DISTINCT FROM (to_jsonb(OLD) - 'returned_qty') THEN
      RAISE EXCEPTION
        'سطر فاکتور نهایی‌شده تغییر نمی‌کند (وضعیت «%»)؛ اصلاح فقط با مرجوعی یا سند معکوس.',
        v_status;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'سبد فاکتور در وضعیت «%» عوض نمی‌شود؛ افزودن و حذف قلم فقط پیش از نهایی‌سازی ممکن است.',
    v_status;
END $$;

COMMENT ON FUNCTION sales.invoice_line_draft_guard IS
  'افزودن و حذف قلم فقط روی فاکتور draft. پس از نهایی‌سازی تنها returned_qty تغییر می‌کند.';

DROP TRIGGER IF EXISTS invoice_line_draft_guard ON sales.invoice_line;
CREATE TRIGGER invoice_line_draft_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales.invoice_line
  FOR EACH ROW EXECUTE FUNCTION sales.invoice_line_draft_guard();

COMMIT;
