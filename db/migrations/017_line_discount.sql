-- =====================================================================
-- ۰۱۷ — تخفیف روی سطری که همین حالا در سبد است
-- =====================================================================
-- تا امروز تخفیف فقط در لحظه **افزودن** قلم تنظیم می‌شد. صندوق‌داری
-- که کالا را اسکن کرده و بعد می‌خواهد رویش تخفیف بدهد، تنها یک راه
-- داشت: حذف سطر و افزودن دوباره‌اش.
--
-- همان راهی که مهاجرت ۰۱۵ برای «تغییر تعداد» ردش کرد، و به همان
-- دلیل: افزودن دوباره، قیمت را از `catalog.price` **دوباره** می‌خواند.
-- برای فاکتوری که قیمت لحظه فروش را نگه می‌دارد، این یک اصلاح نیست؛
-- یک بازقیمت‌گذاری بی‌صداست. اگر وسط شیفت قیمت عوض شده باشد، مشتری
-- تخفیف می‌گیرد و هم‌زمان قیمت پایه‌اش عوض می‌شود بی‌آنکه کسی بفهمد.
--
-- ── چه چیزی اینجا **نیست** ────────────────────────────────────────
--
-- سقف تخفیف و مجوزها. آن‌ها در `identity.permission_rule` و لایه API
-- می‌مانند، دقیقاً همان‌جا که برای `POST /lines` هستند — و همان تابع
-- مشترک هر دو مسیر را می‌سنجد. اگر اینجا هم می‌سنجیدیم، دو تعریف از
-- یک قاعده داشتیم.
--
-- آنچه دیتابیس اجبار می‌کند سر جایش می‌ماند و این تابع دورش نمی‌زند:
-- `invoice_line_reason_guard` (مهاجرت ۰۱۰) همچنان روی همین UPDATE
-- اجرا می‌شود، پس کاهش بالاتر از آستانه بدون دلیل از این مسیر هم رد
-- می‌شود.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sales.set_line_discount(
  p_invoice uuid, p_line uuid,
  p_discount platform.money, p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
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
         discount_reason = coalesce(nullif(btrim(p_reason), ''), discount_reason)
   WHERE id = p_line;

  PERFORM sales.refresh_invoice_totals(p_invoice);
END $$;

COMMENT ON FUNCTION sales.set_line_discount IS
  'تخفیف یک سطر سبد را زیر قفل فاکتور می‌گذارد. Snapshot قیمت دست‌نخورده می‌ماند؛ سقف و مجوز کار لایه API است.';

COMMIT;
