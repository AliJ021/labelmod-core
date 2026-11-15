-- =====================================================================
-- ۱۲۰ — پیوستگی نقد میان دو شیفت
-- =====================================================================
-- یافتهٔ ممیزی LM-08 (۲۰۲۶/۱۱/۱۲). تصمیم مالک (۲۰۲۶/۱۱/۱۵): اختلاف رد
-- نمی‌شود، **با دلیل اجباری پذیرفته می‌شود**.
--
-- تا امروز `opening_cash` عددی بود که صندوق‌دار تایپ می‌کرد و فقط «منفی
-- نباشد» سنجیده می‌شد. شیفت قبل با شمارش ۵ میلیون بسته می‌شد، بعدی با ۲
-- میلیون باز می‌شد، و ۳ میلیون بی هیچ سند، هشدار یا ردی ناپدید بود — در
-- حالی که حساب ۱۱۰۱ در دفتر همچنان ۵ میلیون را داشت.
--
-- ── قاعده ──────────────────────────────────────────────────────────
-- «انتظار» = `counted_cash` آخرین شیفت بستهٔ همان شعبه. اگر موجودی اول
-- شیفت تازه با آن نخواند:
--   • بی دلیل رد می‌شود؛
--   • با دلیل پذیرفته می‌شود، انتظار و اختلاف و دلیل روی خود شیفت
--     می‌نشینند، و اختلاف همان سند مغایرت صندوق را می‌گیرد که بستن شیفت
--     می‌زند (`shift_variance`: صندوق ۱۱۰۱ در برابر مغایرت ۴۲۰۳). بی این
--     سند، دفتر نقدی را نشان می‌داد که در کشو نیست.
--
-- ⚠️ **شمارش کور:** پیام خطا عدد مورد انتظار را **نمی‌گوید**. اگر بگوید،
--    صندوق‌دار به‌جای شمردن همان عدد را تایپ می‌کند — همان دلیلی که صفحهٔ
--    انبارگردانی موجودی سیستم را پیش از ثبت نشان نمی‌دهد. مدیر هر دو عدد را
--    روی شیفت و در لاگ حسابرسی می‌بیند.
-- ⚠️ **کشوی دوم:** اگر شیفت باز دیگری در همان شعبه هست، انتظار تعریف‌نشده
--    است (نقد ممکن است میان دو کشو تقسیم شده باشد) و سنجش انجام نمی‌شود؛
--    نتیجه در `opening_expected = NULL` دیده می‌شود. اولین شیفت شعبه هم
--    انتظاری ندارد.
-- ⚠️ اگر اختلاف در واقع یک واریز به بانک بوده، این سند آن را «مغایرت»
--    ثبت می‌کند؛ اصلاح طبقه‌بندی به سند معکوس/دستی نیاز دارد که هنوز ساخته
--    نشده (LM-06) — همان محدودیتی که مغایرت بستن شیفت از قبل داشت.
--
-- «انتظار» یک تعریف دارد: `sales.shift_opening_expected(شعبه)`. سرویس API
-- پیش از درج از آن پاسخ خوانا (۴۲۲) می‌سازد و `sales.open_shift` زیر قفل
-- همان را دوباره می‌سنجد.
--
-- آزمون: `db/test/shift-opening.sql`.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE sales.cash_shift
  ADD COLUMN opening_expected platform.money,
  ADD COLUMN opening_variance platform.money,
  ADD COLUMN opening_note     text;

COMMENT ON COLUMN sales.cash_shift.opening_expected IS
  'شمارش پایان آخرین شیفت بستهٔ شعبه هنگام باز شدن این شیفت؛ NULL یعنی سنجش انجام نشد';
COMMENT ON COLUMN sales.cash_shift.opening_variance IS
  'موجودی اول این شیفت منهای انتظار؛ منفی یعنی کسری میان دو شیفت';
COMMENT ON COLUMN sales.cash_shift.opening_note IS
  'دلیل اختلاف موجودی اول با شمارش شیفت قبل — اجباری وقتی اختلاف هست';

-- ── ۱. تعریف واحد «انتظار» ──────────────────────────────────────────
CREATE FUNCTION sales.shift_opening_expected(p_branch uuid)
RETURNS platform.money
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM sales.cash_shift
                         WHERE branch_id = p_branch AND status = 'open') THEN NULL
           ELSE (SELECT counted_cash FROM sales.cash_shift
                  WHERE branch_id = p_branch AND status = 'closed'
                  ORDER BY closed_at DESC, id DESC
                  LIMIT 1)
         END
$$;

COMMENT ON FUNCTION sales.shift_opening_expected(uuid) IS
  'نقدی که شیفت تازهٔ شعبه باید با آن شروع شود؛ NULL یعنی سنجش ندارد (اولین شیفت یا کشوی باز دیگر)';

-- ── ۲. باز کردن شیفت ────────────────────────────────────────────────
CREATE FUNCTION sales.open_shift(
  p_branch  uuid,
  p_user    uuid,
  p_opening platform.money,
  p_note    text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_expected platform.money;
  v_variance platform.money;
  v_note     text := nullif(btrim(p_note), '');
  v_id       uuid;
BEGIN
  IF p_opening IS NULL OR p_opening < 0 THEN
    RAISE EXCEPTION 'موجودی اول شیفت منفی نمی‌شود';
  END IF;
  -- ⚠️ `set_actor` اینجا صدا زده **نمی‌شود**: فراخوان HTTP آن را با IP، دستگاه و
  --    Correlation ID ست کرده و صدا زدنِ دوباره با یک آرگومان، هر سه را در لاگ
  --    حسابرسی تهی می‌کرد. نبود کاربر عامل را خودِ `platform.audit` رد می‌کند.
  IF platform.current_actor() IS NULL THEN
    RAISE EXCEPTION 'باز کردن شیفت بدون کاربر عامل مجاز نیست. platform.set_actor() فراخوانی نشده است.';
  END IF;

  -- قفل پیش از خواندن انتظار: دو باز کردن هم‌زمان در یک شعبه نباید هر دو
  -- «کشوی باز دیگری نیست» ببینند.
  PERFORM pg_advisory_xact_lock(hashtextextended('sales.open_shift:' || p_branch::text, 0));

  -- «یک شیفت باز برای هر کاربر» را ایندکس یکتای `one_open_shift_per_user`
  -- اجبار می‌کند و `errors.ts` آن را به ۴۰۹ `shift_already_open` ترجمه می‌کند؛
  -- سنجش دوم اینجا همان قاعده را با کد خطای دیگری گزارش می‌کرد.

  v_expected := sales.shift_opening_expected(p_branch);
  v_variance := CASE WHEN v_expected IS NULL THEN NULL ELSE p_opening - v_expected END;

  IF v_variance IS NOT NULL AND v_variance <> 0 AND v_note IS NULL THEN
    RAISE EXCEPTION 'موجودی اول شیفت با شمارش پایان شیفت قبل نمی‌خواند؛ دوباره بشمارید، یا اگر درست است دلیل اختلاف را بنویسید';
  END IF;

  INSERT INTO sales.cash_shift
    (branch_id, user_id, opening_cash, status, opening_expected, opening_variance, opening_note)
  VALUES
    (p_branch, p_user, p_opening, 'open', v_expected, v_variance,
     CASE WHEN v_variance IS NOT NULL AND v_variance <> 0 THEN v_note END)
  RETURNING id INTO v_id;

  -- اختلاف همان سند مغایرت صندوقِ بستن شیفت را می‌گیرد؛ مبلغ منفی سمت‌ها
  -- را برمی‌گرداند (کسری: بدهکار مغایرت، بستانکار صندوق).
  IF v_variance IS NOT NULL AND v_variance <> 0 THEN
    PERFORM ledger.post_entry(
      'shift_variance', p_branch, platform.business_date(),
      'مغایرت موجودی اول شیفت با شمارش شیفت قبل',
      jsonb_build_array(
        jsonb_build_object('leg', 'cash',     'amount', v_variance),
        jsonb_build_object('leg', 'variance', 'amount', v_variance)),
      'cash_shift', v_id, p_user);
  END IF;

  PERFORM platform.audit('shift.open', 'cash_shift', v_id::text,
    jsonb_build_object('opening_cash', p_opening,
                       'expected', v_expected,
                       'variance', v_variance),
    p_user,
    CASE WHEN v_variance IS NOT NULL AND v_variance <> 0 THEN v_note END);

  RETURN v_id;
END $$;

COMMENT ON FUNCTION sales.open_shift(uuid, uuid, platform.money, text) IS
  'باز کردن شیفت با سنجش پیوستگی نقد؛ اختلاف بی دلیل رد و با دلیل سند مغایرت می‌گیرد';

COMMIT;
