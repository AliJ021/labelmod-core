-- =====================================================================
-- ۰۹۳ — خلاصه روز برای یک بازهٔ روزها: فروش، وجه دریافتی، سود
-- =====================================================================
-- روند «روزانه» و «ماهانه»ی داشبورد به خلاصهٔ هر روز در یک بازه نیاز دارد.
-- صدا زدن `sales.daily_summary` (۰۱۸) یک بار برای هر روز درست بود ولی
-- برای دوازده ماه ۳۶۵ بار همهٔ فاکتورهای شعبه را می‌پیمود، چون محمول
-- `business_date(occurred_at) = p_date` از هیچ ایندکسی استفاده نمی‌کند.
--
-- این تابع همان سه CTE خلاصه روز است — همان فیلترها، همان علامت‌ها — فقط
-- **یک بار** روی بازه و به تفکیک روز کاری:
--
--   فروش        فاکتورِ غیرپیش‌نویس و غیرباطل منهای مرجوعیِ ثبت‌شده، هر
--               کدام در روزِ `occurred_at` خودش.
--   وجه دریافتی پرداختِ `succeeded`/`settled`/`reconciled`؛ `in` مثبت و
--               `out` منفی؛ شعبه از فاکتور یا برگ مرجوعی.
--   سود         (فروش − بها) منهای (مرجوعی − بهای مرجوعی).
--
-- ⚠️ **ثابت اصلی:** هر سطر این تابع ستون‌به‌ستون دقیقاً برابر
--    `daily_summary(شعبه، همان روز)` است. `db/test/daily-summary-range.sql`
--    این را روز‌به‌روز، با مرز ۰۰:۰۰ تا ۰۳:۳۰ بامداد تهران، می‌سنجد.
--
-- ⚠️ مرز بازه از `platform.business_day_start` است (مهاجرت ۰۳۸)، نه
--    `p_from::timestamptz`؛ و برای اطمینانِ دوم، خودِ `business_date` هم
--    در محمول می‌ماند. پس معنا همان خلاصهٔ روز است. مرز روی فاکتور از ایندکس
--    `(branch_id, occurred_at)` (۰۷۹) استفاده می‌کند؛ مرجوعی و پرداخت چنین
--    ایندکسی ندارند و یک بار پیموده می‌شوند — باز هم یک بار، نه یک بار برای هر روز.
--
-- ⚠️ **یک سطر برای هر روزِ بازه**، روزِ بی‌فعالیت صفر، مرتب. «سطری نیست»
--    و «صفر بود» یکی نمی‌شوند و کلاینت روزها را حدس نمی‌زند.
--
-- ⚠️ بازه حداکثر ۴۰۰ روز است: روند ماهانهٔ داشبورد دوازده ماه جلالی است
--    (حداکثر ۳۶۶ روز). شعبه اجباری است؛ «همهٔ شعبه‌ها» کار این تابع نیست.
--
-- ⚠️ سود اینجا همیشه حساب می‌شود؛ پوشاندنش برای کاربرِ بی `cost.view` کار
--    مسیر API است — همان قراردادِ `/reports/daily`.
--
-- `daily_summary` و `daily_summary_hourly` دست نمی‌خورند. بدون جدول تازه،
-- بدون تغییر داده، بدون `SECURITY DEFINER`.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.daily_summary_range(
  p_branch uuid, p_from date, p_to date
) RETURNS TABLE (
  business_date   date,
  sales_amount    platform.money,
  received_amount platform.money,
  profit_amount   platform.money,
  invoice_count   bigint,
  return_count    bigint,
  payment_count   bigint
)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  IF p_branch IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'شعبه و بازهٔ تاریخ خلاصه روز اجباری است';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'تاریخ پایان نمی‌تواند پیش از تاریخ شروع باشد';
  END IF;
  IF p_to - p_from >= 400 THEN
    RAISE EXCEPTION 'بازهٔ خلاصه روز حداکثر ۴۰۰ روز است';
  END IF;
  v_start := platform.business_day_start(p_from);
  v_end   := platform.business_day_start(p_to + 1);

  RETURN QUERY
  WITH days AS (
    SELECT d::date AS day FROM generate_series(p_from, p_to, interval '1 day') AS d
  ),
  sold AS (
    -- همان فیلترِ `daily_summary`: وضعیت‌ها برشمرده نمی‌شوند.
    SELECT platform.business_date(i.occurred_at) AS day,
           sum(i.net_amount)  AS net,
           sum(i.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.invoice i
     WHERE i.branch_id = p_branch
       AND i.status NOT IN ('draft', 'cancelled')
       AND i.occurred_at >= v_start AND i.occurred_at < v_end
       AND platform.business_date(i.occurred_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  returned AS (
    SELECT platform.business_date(r.occurred_at) AS day,
           sum(r.net_amount)  AS net,
           sum(r.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.sale_return r
     WHERE r.branch_id = p_branch
       AND r.status = 'posted'
       AND r.occurred_at >= v_start AND r.occurred_at < v_end
       AND platform.business_date(r.occurred_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  cash AS (
    SELECT platform.business_date(p.occurred_at) AS day,
           sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END) AS net,
           count(*) AS n
      FROM treasury.payment p
      LEFT JOIN sales.invoice i     ON i.id = p.invoice_id
      LEFT JOIN sales.sale_return r ON r.id = p.return_id
     WHERE p.status IN ('succeeded', 'settled', 'reconciled')
       AND coalesce(i.branch_id, r.branch_id) = p_branch
       AND p.occurred_at >= v_start AND p.occurred_at < v_end
       AND platform.business_date(p.occurred_at) BETWEEN p_from AND p_to
     GROUP BY 1
  )
  SELECT d.day,
         (coalesce(s.net, 0) - coalesce(r.net, 0))::platform.money,
         coalesce(c.net, 0)::platform.money,
         ((coalesce(s.net, 0) - coalesce(r.net, 0)) - (coalesce(s.cogs, 0) - coalesce(r.cogs, 0)))::platform.money,
         coalesce(s.n, 0)::bigint,
         coalesce(r.n, 0)::bigint,
         coalesce(c.n, 0)::bigint
    FROM days d
    LEFT JOIN sold s     ON s.day = d.day
    LEFT JOIN returned r ON r.day = d.day
    LEFT JOIN cash c     ON c.day = d.day
   ORDER BY d.day;
END
$$;
COMMENT ON FUNCTION sales.daily_summary_range IS
  'خلاصه روز برای هر روزِ یک بازه (حداکثر ۴۰۰ روز، یک سطر برای هر روز). هر سطر دقیقاً برابر sales.daily_summary همان روز است.';

COMMIT;
