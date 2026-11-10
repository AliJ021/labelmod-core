-- =====================================================================
-- ۱۱۳ — «وجه دریافتی» روز، به تفکیک فاکتور همان روز و روزهای قبل
-- =====================================================================
-- تصمیم مالک (۲۰۲۶/۱۱/۰۷): زیر کارت «وجه دریافتی» بنویسیم چه مقدار از آن
-- بابت فاکتورهای روزهای قبل است — همان چیزی که دریافتی را از فروش همان
-- روز جدا می‌کند.
--
-- ⚠️ **تعریف «وجه دریافتی» عوض نمی‌شود.** همان پرداخت‌های CTE `cash` در
--    `sales.daily_summary` (۰۱۸): `treasury.payment` با وضعیت succeeded/
--    settled/reconciled، ورودی مثبت و خروجی منفی، شعبهٔ فاکتور یا برگ
--    مرجوعی، و تاریخ کاری خودِ پرداخت. این تابع فقط همان پول را دو بخش
--    می‌کند و جمع دو بخش **دقیقاً** `daily_summary.received_amount` است
--    (`db/test/daily-received-split.sql`).
--
-- «فاکتور مبدأ» هر پرداخت: فاکتور خودش، یا برای بازپرداخت مرجوعی، فاکتوری
-- که مرجوعی از آن است. «روزهای قبل» یعنی تاریخ کاری فاکتور مبدأ پیش از روز
-- گزارش. پس بازپرداخت مرجوعیِ فاکتور دیروز در «بابت قبل» منفی می‌نشیند و
-- پرداخت دیرهنگامِ سفارشی که دیروز ثبت شده مثبت.
--
-- ⚠️ دریافت از مشتری بابت نسیهٔ قبلی (`treasury.transaction`، نوع
--    customer_receipt) در «وجه دریافتی» داشبورد نیست و اینجا هم نیست؛ آن
--    همان لحظه سند می‌خورد و طلب ثبت‌شده را کم می‌کند.
--
-- بدون جدول، بدون تغییر داده، بدون `SECURITY DEFINER`.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.daily_received_split(p_branch uuid, p_date date DEFAULT platform.business_date())
RETURNS TABLE (business_date date, received_amount platform.money, same_day_amount platform.money, earlier_amount platform.money)
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  WITH cash AS (
    SELECT CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END AS net,
           platform.business_date(coalesce(i.occurred_at, ri.occurred_at)) < p_date AS earlier
      FROM treasury.payment p
      LEFT JOIN sales.invoice i     ON i.id = p.invoice_id
      LEFT JOIN sales.sale_return r ON r.id = p.return_id
      LEFT JOIN sales.invoice ri    ON ri.id = r.invoice_id
     WHERE p.status IN ('succeeded', 'settled', 'reconciled')
       AND coalesce(i.branch_id, r.branch_id) = p_branch
       AND platform.business_date(p.occurred_at) = p_date
  )
  SELECT p_date,
         coalesce(sum(net), 0)::platform.money,
         coalesce(sum(net) FILTER (WHERE NOT earlier), 0)::platform.money,
         coalesce(sum(net) FILTER (WHERE earlier), 0)::platform.money
    FROM cash;
$$;
COMMENT ON FUNCTION sales.daily_received_split IS
  'وجه دریافتی یک روز (همان cash در sales.daily_summary) به تفکیک تاریخ فاکتور مبدأ: همان روز و روزهای قبل. same_day + earlier = received_amount.';

COMMIT;
