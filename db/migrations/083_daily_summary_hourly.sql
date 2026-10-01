-- =====================================================================
-- ۰۸۳ — خلاصه روز به تفکیک ساعت: فروش، وجه دریافتی، سود
-- =====================================================================
-- داشبورد سه شاخص امروز را از `sales.daily_summary` (۰۱۸) می‌خواند، ولی
-- روند ساعتی‌اش از `sales.report_hourly` (۰۴۱) می‌آمد — و آن دو **یک
-- تعریف نیستند**: `report_hourly` مرجوعی را کم نمی‌کند (پرسشش «چه ساعتی
-- شلوغ است؟» است) و فقط فروش دارد. یعنی جمع نمودار با کارت «فروش»
-- نمی‌خواند، و «وجه دریافتی» و «سود» اصلاً روند ساعتی نداشتند.
--
-- این تابع همان سه CTE خلاصه روز است، فقط به تفکیک ساعتِ کاری:
--
--   فروش        فاکتورِ غیرپیش‌نویس و غیرباطل منهای مرجوعیِ ثبت‌شده،
--               هر کدام در ساعتِ `occurred_at` خودش. مرجوعی ساعت ۱۶ از
--               ساعت ۱۶ کم می‌شود، نه از ساعت فروش اصلی — همان‌طور که
--               خلاصه روز آن را از روزِ خودش کم می‌کند.
--   وجه دریافتی پرداختِ `succeeded`/`settled`/`reconciled`؛ `in` مثبت و
--               `out` منفی؛ شعبه از فاکتور یا برگ مرجوعی؛ ساعتِ
--               `occurred_at` پرداخت.
--   سود         (فروش − بها) منهای (مرجوعی − بهای مرجوعی)، در همان ساعت‌ها.
--
-- ⚠️ **ثابت اصلی:** برای هر (شعبه، روز) جمع ۲۴ سطر این تابع دقیقاً
--    برابر `daily_summary` است — ستون‌به‌ستون، با برابری عدد صحیح.
--    `platform.business_date` و `platform.business_hour` هر دو از همان
--    تنظیم `platform.timezone` می‌آیند، پس هر ردیفی که در روز شمرده شود
--    دقیقاً در یک ساعتِ همان روز می‌افتد. `db/test/daily-summary-hourly.sql`
--    این را با فروش، مرجوعی در ساعت دیگر، پرداخت برگشتی و سود منفی می‌سنجد.
--
-- ⚠️ **`daily_summary` و `report_hourly` دست نمی‌خورند.** اولی مرجع است؛
--    دومی در صفحهٔ گزارش‌ها معنای «شلوغی» دارد و تغییرش گزارش دیگری را
--    بی‌صدا عوض می‌کرد.
--
-- ⚠️ **همیشه ۲۴ سطر**، ساعت ۰ تا ۲۳، ساعتِ بی‌فعالیت صفر. «سطری نیست»
--    و «صفر بود» یکی نمی‌شوند و کلاینت ساعت‌ها را حدس نمی‌زند.
--
-- ⚠️ سود اینجا همیشه حساب می‌شود؛ پوشاندنش برای کاربرِ بی `cost.view`
--    کار مسیر API است — همان قراردادِ `/reports/daily`.
--
-- بدون جدول تازه، بدون تغییر داده، بدون `SECURITY DEFINER`: همان حقِ
-- خواندنی که `daily_summary` لازم دارد.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.daily_summary_hourly(
  p_branch uuid, p_date date DEFAULT platform.business_date()
) RETURNS TABLE (
  business_date   date,
  hour_of_day     smallint,
  sales_amount    platform.money,
  received_amount platform.money,
  profit_amount   platform.money,
  invoice_count   bigint,
  return_count    bigint,
  payment_count   bigint
)
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  WITH hours AS (
    SELECT h::smallint AS hour FROM generate_series(0, 23) AS h
  ),
  sold AS (
    -- همان فیلترِ `daily_summary`: وضعیت‌ها برشمرده نمی‌شوند.
    SELECT platform.business_hour(i.occurred_at) AS hour,
           sum(i.net_amount)  AS net,
           sum(i.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.invoice i
     WHERE i.branch_id = p_branch
       AND i.status NOT IN ('draft', 'cancelled')
       AND platform.business_date(i.occurred_at) = p_date
     GROUP BY 1
  ),
  returned AS (
    SELECT platform.business_hour(r.occurred_at) AS hour,
           sum(r.net_amount)  AS net,
           sum(r.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.sale_return r
     WHERE r.branch_id = p_branch
       AND r.status = 'posted'
       AND platform.business_date(r.occurred_at) = p_date
     GROUP BY 1
  ),
  cash AS (
    SELECT platform.business_hour(p.occurred_at) AS hour,
           sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END) AS net,
           count(*) AS n
      FROM treasury.payment p
      LEFT JOIN sales.invoice i     ON i.id = p.invoice_id
      LEFT JOIN sales.sale_return r ON r.id = p.return_id
     WHERE p.status IN ('succeeded', 'settled', 'reconciled')
       AND coalesce(i.branch_id, r.branch_id) = p_branch
       AND platform.business_date(p.occurred_at) = p_date
     GROUP BY 1
  )
  SELECT p_date,
         h.hour,
         coalesce(s.net, 0) - coalesce(r.net, 0),
         coalesce(c.net, 0),
         (coalesce(s.net, 0) - coalesce(r.net, 0)) - (coalesce(s.cogs, 0) - coalesce(r.cogs, 0)),
         coalesce(s.n, 0),
         coalesce(r.n, 0),
         coalesce(c.n, 0)
    FROM hours h
    LEFT JOIN sold s     ON s.hour = h.hour
    LEFT JOIN returned r ON r.hour = h.hour
    LEFT JOIN cash c     ON c.hour = h.hour
   ORDER BY h.hour;
$$;
COMMENT ON FUNCTION sales.daily_summary_hourly IS
  'خلاصه روز به تفکیک ساعت کاری (۲۴ سطر). جمع سطرها دقیقاً برابر sales.daily_summary است؛ مرجوعی در ساعت خودش کم می‌شود.';

COMMIT;
