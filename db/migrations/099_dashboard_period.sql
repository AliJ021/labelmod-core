-- =====================================================================
-- ۰۹۹ — خلاصهٔ دوره‌ای داشبورد: کانال، مرجوعی، بازپرداخت، ترکیب پرداخت
-- =====================================================================
-- دستهٔ B داشبورد (مصوب مالک) برای یک بازهٔ دلخواه و دورهٔ مبنای آن
-- می‌پرسد: صندوق در برابر سایت چقدر فروخت، میانگین فاکتور چقدر بود، چقدر
-- کالا برگشت، چقدر **پول** پس داده شد، و پول با چه روش‌هایی آمد.
--
-- دو تابع، هر دو فقط‌خواندنی:
--
--   sales.dashboard_period(شعبه، از، تا)       یک سطر برای هر کانال
--   sales.dashboard_payment_mix(شعبه، از، تا)  یک سطر برای هر روش پرداخت
--
-- ── تعریف‌ها همان خلاصهٔ روز است، نه تعریف تازه ──────────────────────
--
--   فروش ناخالص   فاکتورِ غیرپیش‌نویس و غیرباطل در روزِ `occurred_at` خودش
--                 (همان فیلتر `daily_summary` — وضعیت‌ها برشمرده نمی‌شوند).
--   مرجوعی        **ارزش کالای برگشتی** (`sale_return.net_amount` ثبت‌شده) در
--                 روزِ خودِ مرجوعی، و کانالِ فاکتور اصلی.
--   فروش خالص     ناخالص منهای مرجوعی = `sales_amount` خلاصهٔ روز.
--   بازپرداخت     **پولی که واقعاً برگشت** (`payment.direction = 'out'` موفق).
--                 با مرجوعی یکی نیست: مرجوعیِ نسیه یا اعتبار مشتری کالا
--                 برمی‌گرداند بی‌آنکه پولی برگردد. یکی کردنشان یعنی مالک
--                 گمان کند پول از کشو رفته.
--   دریافت خالص   ورودیِ موفق منهای بازپرداخت = `received_amount` خلاصهٔ روز.
--   میانگین فاکتور فروش ناخالص ÷ شمار فاکتور، گرد به ریال در SQL؛ بی فاکتور
--                 `NULL`، نه صفر — «فاکتوری نبود» میانگین صفر نیست.
--
-- ⚠️ **ثابت اصلی:** جمعِ کانال‌های `dashboard_period` برای یک شعبه دقیقاً
--    جمع `daily_summary_range` همان بازه است (فروش، سود، شمار فاکتور و
--    مرجوعی)، و جمعِ روش‌های `dashboard_payment_mix` دقیقاً جمع دریافتی
--    آن. `db/test/dashboard-period.sql` این را می‌سنجد، با کنترل حساسیت.
--
-- ⚠️ شعبهٔ `NULL` یعنی «همهٔ شعبه‌ها» — مثل توابع `report_*`. تصمیمش با
--    مسیر API است (`resolveBranch`)، نه کلاینت. شعبهٔ پرداخت از فاکتور یا
--    برگ مرجوعی‌اش می‌آید؛ قید `payment_has_one_parent` (۰۰۱) یکی از آن دو را
--    اجباری کرده است.
--
-- ⚠️ سود همیشه حساب می‌شود؛ پوشاندنش برای کاربرِ بی `cost.view` کار مسیر
--    است. درصد اینجا ساخته نمی‌شود: دورهٔ مبنا یک فراخوان دوم با همین تابع
--    است و تفاضل bigint دقیق در SQL مسیر حساب می‌شود.
--
-- بازه حداکثر ۴۰۰ روز. بی جدول تازه، بی تغییر داده، بی `SECURITY DEFINER`.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.dashboard_period(
  p_branch uuid, p_from date, p_to date
) RETURNS TABLE (
  channel          text,
  invoice_count    bigint,
  gross_amount     platform.money,
  return_count     bigint,
  return_amount    platform.money,
  sales_amount     platform.money,
  profit_amount    platform.money,
  average_invoice  platform.money
)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'بازهٔ تاریخ خلاصهٔ دوره اجباری است';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'تاریخ پایان نمی‌تواند پیش از تاریخ شروع باشد';
  END IF;
  IF p_to - p_from >= 400 THEN
    RAISE EXCEPTION 'بازهٔ خلاصهٔ دوره حداکثر ۴۰۰ روز است';
  END IF;
  v_start := platform.business_day_start(p_from);
  v_end   := platform.business_day_start(p_to + 1);

  RETURN QUERY
  WITH sold AS (
    SELECT i.channel AS ch,
           sum(i.net_amount)  AS net,
           sum(i.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.invoice i
     WHERE (p_branch IS NULL OR i.branch_id = p_branch)
       AND i.status NOT IN ('draft', 'cancelled')
       AND i.occurred_at >= v_start AND i.occurred_at < v_end
       AND platform.business_date(i.occurred_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  returned AS (
    -- کانالِ مرجوعی کانالِ فاکتور اصلی است: کالای سفارش سایت که در فروشگاه
    -- پس گرفته شود، از فروش «سایت» کم می‌شود، نه «صندوق».
    SELECT i.channel AS ch,
           sum(r.net_amount)  AS net,
           sum(r.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.sale_return r
      JOIN sales.invoice i ON i.id = r.invoice_id
     WHERE (p_branch IS NULL OR r.branch_id = p_branch)
       AND r.status = 'posted'
       AND r.occurred_at >= v_start AND r.occurred_at < v_end
       AND platform.business_date(r.occurred_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  -- صندوق و سایت همیشه سطر دارند (صفر = «فروشی نبود»، نه «نمی‌دانم»)؛ هر
  -- کانالِ دیگری فقط وقتی فعالیت دارد. فهرست بستهٔ CHECK اینجا تکرار نمی‌شود.
  channels AS (
    SELECT 'pos'::text AS ch UNION SELECT 'web' UNION SELECT ch FROM sold UNION SELECT ch FROM returned
  )
  SELECT c.ch,
         coalesce(s.n, 0)::bigint,
         coalesce(s.net, 0)::platform.money,
         coalesce(r.n, 0)::bigint,
         coalesce(r.net, 0)::platform.money,
         (coalesce(s.net, 0) - coalesce(r.net, 0))::platform.money,
         ((coalesce(s.net, 0) - coalesce(r.net, 0)) - (coalesce(s.cogs, 0) - coalesce(r.cogs, 0)))::platform.money,
         (CASE WHEN coalesce(s.n, 0) = 0 THEN NULL
               ELSE round(s.net / s.n) END)::platform.money
    FROM channels c
    LEFT JOIN sold s     ON s.ch = c.ch
    LEFT JOIN returned r ON r.ch = c.ch
   ORDER BY CASE c.ch WHEN 'pos' THEN 0 WHEN 'web' THEN 1 ELSE 2 END, c.ch;
END
$$;
COMMENT ON FUNCTION sales.dashboard_period IS
  'خلاصهٔ دوره به تفکیک کانال (حداکثر ۴۰۰ روز؛ شعبهٔ NULL = همه). جمع کانال‌ها دقیقاً جمع daily_summary_range همان بازه است.';

CREATE FUNCTION sales.dashboard_payment_mix(
  p_branch uuid, p_from date, p_to date
) RETURNS TABLE (
  method_code      text,
  method_name      text,
  received_amount  platform.money,
  refunded_amount  platform.money,
  net_amount       platform.money,
  payment_count    bigint,
  refund_count     bigint
)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'بازهٔ تاریخ خلاصهٔ دوره اجباری است';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'تاریخ پایان نمی‌تواند پیش از تاریخ شروع باشد';
  END IF;
  IF p_to - p_from >= 400 THEN
    RAISE EXCEPTION 'بازهٔ خلاصهٔ دوره حداکثر ۴۰۰ روز است';
  END IF;
  v_start := platform.business_day_start(p_from);
  v_end   := platform.business_day_start(p_to + 1);

  -- فقط روش‌هایی که در بازه پول موفق داشته‌اند؛ «در انتظار» و «نامشخص» پول
  -- نیستند (همان تعریف خلاصهٔ روز). ترتیب: بیشترین ورودی، بعد کد — پایدار.
  RETURN QUERY
  SELECT p.method_code,
         m.name,
         coalesce(sum(p.amount) FILTER (WHERE p.direction = 'in'), 0)::platform.money,
         coalesce(sum(p.amount) FILTER (WHERE p.direction = 'out'), 0)::platform.money,
         sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END)::platform.money,
         count(*) FILTER (WHERE p.direction = 'in'),
         count(*) FILTER (WHERE p.direction = 'out')
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
    LEFT JOIN sales.invoice i     ON i.id = p.invoice_id
    LEFT JOIN sales.sale_return r ON r.id = p.return_id
   WHERE p.status IN ('succeeded', 'settled', 'reconciled')
     AND (p_branch IS NULL OR coalesce(i.branch_id, r.branch_id) = p_branch)
     AND p.occurred_at >= v_start AND p.occurred_at < v_end
     AND platform.business_date(p.occurred_at) BETWEEN p_from AND p_to
   GROUP BY p.method_code, m.name
   ORDER BY 3 DESC, 1;
END
$$;
COMMENT ON FUNCTION sales.dashboard_payment_mix IS
  'ترکیب روش پرداخت در بازه: ورودی، بازپرداخت و خالص هر روش (شعبهٔ NULL = همه). جمع خالص دقیقاً جمع received_amount خلاصهٔ روز است.';

COMMIT;
