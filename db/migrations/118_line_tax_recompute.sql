-- =====================================================================
-- ۱۱۸ — مالیات سطر پس از تخفیف یا قیمت دستی بازمحاسبه می‌شود
-- =====================================================================
-- یافتهٔ ممیزی LM-01 (۲۰۲۶/۱۱/۱۲). مالیات سطر فقط هنگام **درج** حساب
-- می‌شد (`sales.line_tax`، مهاجرت ۰۶۳). `sales.set_line_discount` و
-- `sales.set_line_price` خالص سطر را عوض می‌کردند و `tax_amount` را دست
-- نمی‌زدند. با `tax.enabled = true`:
--
--   قلم ۱٬۰۰۰٬۰۰۰  → مالیات ۱۰۰٬۰۰۰
--   تخفیف ۵۰۰٬۰۰۰  → خالص ۵۰۰٬۰۰۰، مالیات **همچنان ۱۰۰٬۰۰۰** (درست: ۵۰٬۰۰۰)
--
-- و فاکتور بی هیچ خطایی نهایی می‌شد: سند متوازن است، پس هیچ ثابتی قرمز
-- نمی‌شد (توازن ≠ صحت معنایی). امروز مالیات خاموش است و این نهفته بود،
-- ولی `tax.enabled` از صفحهٔ تنظیمات روشن می‌شود — یک کلیک فاصله داشت.
--
-- ── اصلاح ──────────────────────────────────────────────────────────
-- هر دو تابع مالیات را از خالصِ **تازه** و با **همان** `sales.line_tax`
-- می‌نویسند که مسیر درج دارد. یک تعریف، نه دو تا. بقیهٔ بدنهٔ هر دو تابع
-- دست‌نخورده از تعریف جاری دیتابیس آمده است.
--
-- ── آنچه عمداً عوض **نشد** ─────────────────────────────────────────
--   • `sales.set_line_qty` همچنان سطر مالیات‌دار را رد می‌کند. آن رفتار
--     fail-closed است، نه عدد غلط؛ بازکردنش تصمیم جداست.
--   • سفارش سایت: سایت مالیات نمی‌فرستد و Core آن را **روی** قیمت
--     پرداخت‌شده حساب می‌کند، پس با مالیات روشن `payable ≠ paid` و سفارش
--     رد می‌شود (fail-closed، `web-order.ts`). اینکه قیمت سایت شامل مالیات
--     است یا نه تصمیم مشاور مالیاتی است و اینجا حدس زده نمی‌شود.
--
-- ⚠️ مالیات خاموش: `line_tax` صفر می‌دهد و ستون صفر می‌ماند — رفتار امروز.
-- ⚠️ `search_path` هر دو تابع `pg_catalog` است؛ فراخوان با نام کامل است.
--
-- آزمون: `db/test/line-tax.sql` — هر ترتیب تخفیف/قیمت، با کنترل منفی
-- (مالیات خاموش) و جمع فاکتور نهایی‌شده.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sales.set_line_discount(p_invoice uuid, p_line uuid, p_discount platform.money, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_status text;
  l        sales.invoice_line%ROWTYPE;
  v_gross  platform.money;
BEGIN
  IF p_discount IS NULL OR p_discount < 0 THEN
    RAISE EXCEPTION 'تخفیف نمی‌تواند منفی باشد';
  END IF;

  -- قفل فاکتور پیش از خواندن سطر — همان ترتیب `set_line_qty`.
  SELECT status INTO v_status FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاکتور یافت نشد';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'فاکتور در وضعیت «%» است و سبد آن دیگر تغییر نمی‌کند', v_status;
  END IF;

  SELECT * INTO l FROM sales.invoice_line
    WHERE id = p_line AND invoice_id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'این قلم در فاکتور نیست';
  END IF;

  -- تخفیف از مبلغ خودِ قلم بیشتر نمی‌شود. ناخالص با همان `round()`
  -- ساخته می‌شود که `set_line_qty` و `refresh_invoice_totals` دارند —
  -- وگرنه سقف با عددی سنجیده می‌شد که روی فاکتور ننشسته.
  v_gross := round(l.qty * l.unit_price);
  IF p_discount > v_gross THEN
    RAISE EXCEPTION 'تخفیف (%) از مبلغ خودِ قلم (%) بیشتر است', p_discount, v_gross;
  END IF;

  -- `unit_price` و `list_price` **دست نمی‌خورند**. کل دلیل وجود این
  -- تابع همین است.
  UPDATE sales.invoice_line
     SET discount_amount = p_discount,
         net_amount      = v_gross - p_discount,
         -- مهاجرت ۱۱۸: مالیات از خالصِ **تازه**، با همان تعریف مسیر درج.
         tax_amount      = sales.line_tax(l.variation_id, v_gross - p_discount),
         discount_reason = coalesce(nullif(btrim(p_reason), ''), discount_reason)
   WHERE id = p_line;

  PERFORM sales.refresh_invoice_totals(p_invoice);
END $function$;

CREATE OR REPLACE FUNCTION sales.set_line_price(p_invoice uuid, p_line uuid, p_price platform.money, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_status  text;
  l         sales.invoice_line%ROWTYPE;
  v_list    platform.money;
  v_gross   platform.money;
  v_reason  text;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'قیمت باید بزرگ‌تر از صفر باشد';
  END IF;

  -- قفل فاکتور پیش از خواندن سطر — همان ترتیب `set_line_qty` و
  -- `set_line_discount`. ترتیب متفاوت میان این سه یعنی Deadlock.
  SELECT status INTO v_status FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاکتور یافت نشد';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'فاکتور در وضعیت «%» است و سبد آن دیگر تغییر نمی‌کند', v_status;
  END IF;

  SELECT * INTO l FROM sales.invoice_line
    WHERE id = p_line AND invoice_id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'این قلم در فاکتور نیست';
  END IF;

  -- قیمت فهرست واقعی: اگر سطر قبلاً دستکاری شده، همان Snapshot اول.
  v_list := coalesce(l.list_price, l.unit_price);

  -- ناخالص با همان `round()` که `set_line_qty` و
  -- `refresh_invoice_totals` دارند. تقسیم و ضرب در لایه دیگر، جمع
  -- فاکتور را از جمع سطرها جدا می‌کند.
  v_gross := round(l.qty * p_price);
  IF l.discount_amount > v_gross THEN
    RAISE EXCEPTION
      'تخفیف ثبت‌شده (%) از مبلغ قلم با قیمت تازه (%) بیشتر می‌شود؛ اول تخفیف را کم کنید',
      l.discount_amount, v_gross;
  END IF;

  IF p_price = v_list THEN
    -- برگشت به فهرست: سطر دوباره دست‌نخورده است.
    UPDATE sales.invoice_line
       SET unit_price            = p_price,
           list_price            = NULL,
           price_override_reason = NULL,
           net_amount            = v_gross - l.discount_amount,
           -- مهاجرت ۱۱۸: مالیات از خالصِ **تازه**، با همان تعریف مسیر درج.
           tax_amount            = sales.line_tax(l.variation_id, v_gross - l.discount_amount)
     WHERE id = p_line;
    v_reason := NULL;
  ELSE
    -- دلیل تازه جای دلیل قبلی را می‌گیرد؛ دلیل خالی آن را پاک نمی‌کند.
    v_reason := coalesce(nullif(btrim(p_reason), ''), l.price_override_reason);
    UPDATE sales.invoice_line
       SET unit_price            = p_price,
           list_price            = v_list,
           price_override_reason = v_reason,
           net_amount            = v_gross - l.discount_amount,
           -- مهاجرت ۱۱۸: مالیات از خالصِ **تازه**، با همان تعریف مسیر درج.
           tax_amount            = sales.line_tax(l.variation_id, v_gross - l.discount_amount)
     WHERE id = p_line;
  END IF;

  -- ردّ حسابرسی داخل خودِ تابع، نه در لایه فراخوان: مسیر تازه‌ای که
  -- روزی این تابع را صدا بزند نباید بتواند فراموشش کند. کاربر عامل
  -- از `platform.set_actor()` می‌آید و نبودش عمداً خطا می‌دهد.
  -- ⚠️ مبالغ **رشته** ذخیره می‌شوند، نه عدد JSON. قاعده «پول در JSON
  --    رشته است» به مرز API محدود نیست: عدد JSON بالای ۹ کوادریلیون
  --    دقت را از دست می‌دهد و هر خواننده‌ای که این ردّ را با
  --    JSON.parse بخواند همان‌جا خرابش می‌کند. مسیر `addLine` هم از
  --    روز اول رشته می‌نوشت؛ دو شکل در یک ستون یعنی گزارش حسابرسی
  --    باید هر دو را بفهمد.
  PERFORM platform.audit(
    'sale.price_override', 'invoice_line', p_line::text,
    jsonb_build_object(
      'unitPrice', p_price::text, 'listPrice', v_list::text, 'qty', l.qty::text,
      'variationId', l.variation_id, 'invoiceId', p_invoice),
    NULL, v_reason,
    jsonb_build_object(
      'unitPrice', l.unit_price::text,
      'listPrice', CASE WHEN l.list_price IS NULL THEN NULL ELSE l.list_price::text END));

  PERFORM sales.refresh_invoice_totals(p_invoice);
END $function$;

COMMIT;
