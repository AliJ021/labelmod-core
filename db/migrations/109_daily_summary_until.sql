-- =====================================================================
-- ۱۰۹ — خلاصه ساعتی «تا یک لحظه» و مرز «همین لحظهٔ دیروز»
-- =====================================================================
-- تصمیم مالک (۲۰۲۶/۱۱/۰۲، طرح ۱۰): نمودار روند داشبورد تجمعی «تا این
-- لحظه» است و با «همین ساعت دیروز» مقایسه می‌شود؛ همان مقایسه روی کارت
-- فروش امروز هم می‌آید. جمع و اختلاف فقط در SQL.
--
-- «همین ساعت دیروز» یعنی چه — صریح، چون مقایسهٔ نابرابر بی‌صدا غلط است:
--
--   امروز ساعت ۱۸:۴۰ است. فروش امروز همهٔ رویدادهای امروز تا الان است.
--   طرف مقایسه همهٔ رویدادهای دیروز تا **۱۸:۴۰ دیروز** است — نه تا آخر
--   ساعت ۱۸ و نه کل دیروز. جمع کل دیروز (یا تا ۱۹:۰۰) فروش ساعت‌هایی را
--   می‌شمارد که امروز هنوز نیامده‌اند و هر روز ساعت ۱۸ «افت» کاذب نشان
--   می‌داد.
--
--   مرز به **مدت سپری‌شده از آغاز روز کاری** تعریف می‌شود
--   (`platform.business_day_start` و منطقه زمانی `platform.timezone`)، نه
--   به ساعت سرور و نه به ساعت مرورگر:
--     مرز دیروز = آغاز دیروز + (اکنون − آغاز امروز)
--   برای روزی که تمام شده (تاریخ گذشته)، مدت سپری‌شده کل روز است، پس طرف
--   مقایسه کل روز قبلش است. برای تاریخ آینده صفر است. مرز هیچ‌وقت از پایان
--   روز قبل جلوتر نمی‌رود (روز ۲۳ یا ۲۵ ساعتهٔ تغییر ساعت رسمی).
--
-- ⚠️ **یک تعریف، نه دو.** `daily_summary_hourly` (۰۸۳) از این پس همین تابع
--    است با مرز «پایان همان روز» — رویداد پس از پایان روز در آن روز نیست،
--    پس خروجی‌اش بیت‌به‌بیت همان است و `db/test/daily-summary-hourly.sql`
--    دست‌نخورده می‌گذرد. اگر فیلتر تازه‌ای لازم شود، یک جا نوشته می‌شود.
--
-- ⚠️ رویدادِ **دقیقاً** در لحظهٔ مرز بیرون است (`<`)، همان قرارداد نیم‌باز
--    بازه‌های گزارش (۰۳۸).
--
-- ⚠️ دیدن دیروز تصمیم این مهاجرت نیست. صندوق‌دار بی `report.view` فقط
--    «امروز» را می‌بیند؛ مسیر API مقایسه را برای او اصلاً نمی‌سازد.
--
-- بدون جدول، بدون تغییر داده، بدون `SECURITY DEFINER`.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.daily_summary_hourly_until(
  p_branch uuid, p_date date, p_cutoff timestamptz
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
       AND i.occurred_at < p_cutoff
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
       AND r.occurred_at < p_cutoff
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
       AND p.occurred_at < p_cutoff
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
COMMENT ON FUNCTION sales.daily_summary_hourly_until IS
  'خلاصه ساعتی یک روز کاری فقط با رویدادهای پیش از p_cutoff (نیم‌باز). با مرز پایان روز، دقیقاً sales.daily_summary_hourly است.';

-- یک تعریف: نسخهٔ ۰۸۳ همین تابع است با مرز پایان همان روز.
CREATE OR REPLACE FUNCTION sales.daily_summary_hourly(
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
  SELECT * FROM sales.daily_summary_hourly_until(p_branch, p_date, platform.business_day_start(p_date + 1));
$$;

CREATE FUNCTION sales.previous_day_cutoff(p_date date, p_now timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  SELECT least(
           platform.business_day_start(p_date - 1)
             + make_interval(secs => greatest(0::numeric, least(
                 extract(epoch FROM p_now - platform.business_day_start(p_date)),
                 extract(epoch FROM platform.business_day_start(p_date + 1) - platform.business_day_start(p_date))
               ))::double precision),
           platform.business_day_start(p_date));
$$;
COMMENT ON FUNCTION sales.previous_day_cutoff IS
  'مرز «همین لحظهٔ روز قبل»: آغاز روز قبل + مدت سپری‌شده از آغاز p_date تا p_now (بین صفر و کل روز)، و هرگز پس از پایان روز قبل.';

COMMIT;
