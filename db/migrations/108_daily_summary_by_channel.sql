-- =====================================================================
-- ۱۰۸ — خلاصه روز به تفکیک کانال (طرح ۱۰، کارت «فروش به تفکیک کانال» داشبورد)
-- =====================================================================
-- همان سه عدد `sales.daily_summary` (فروش، وجه دریافتی، سود) و همان
-- شمارش‌ها، این بار برای هر کانال. ادعای مرکزی همان ۰۸۳ است:
-- **جمع کانال‌ها دقیقاً برابر خلاصه روز است**، با برابری عدد صحیح
-- (`db/test/daily-summary-channels.sql`).
--
-- کانال هر رقم از **فاکتور** می‌آید:
--   - فروش و بهای آن: کانال خود فاکتور.
--   - مرجوعی: کانال فاکتوری که مرجوع شده — مرجوعی سایت از فروش سایت کم
--     می‌شود، نه از صندوق، حتی اگر پولش از کشو برگردد.
--   - پرداخت: کانال فاکتورش؛ بازپرداخت مرجوعی کانال فاکتور اصلیِ آن مرجوعی.
--
-- فقط کانال‌هایی که در آن روز اثری دارند سطر می‌گیرند؛ روز خالی هیچ
-- سطری ندارد و جمعِ هیچ، صفر است — همان خلاصه روزِ خالی.
--
-- فقط یک تابع STABLE: بی جدول، بی تغییر داده، بی قفل روی جدولی.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.daily_summary_by_channel(
  p_branch uuid, p_date date DEFAULT platform.business_date()
) RETURNS TABLE (
  business_date   date,
  channel         text,
  sales_amount    platform.money,
  received_amount platform.money,
  profit_amount   platform.money,
  invoice_count   bigint,
  return_count    bigint
)
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  WITH sold AS (
    SELECT i.channel,
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
    SELECT i.channel,
           sum(r.net_amount)  AS net,
           sum(r.cogs_amount) AS cogs,
           count(*)           AS n
      FROM sales.sale_return r
      JOIN sales.invoice i ON i.id = r.invoice_id
     WHERE r.branch_id = p_branch
       AND r.status = 'posted'
       AND platform.business_date(r.occurred_at) = p_date
     GROUP BY 1
  ),
  cash AS (
    SELECT coalesce(i.channel, ri.channel) AS channel,
           sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END) AS net
      FROM treasury.payment p
      LEFT JOIN sales.invoice i     ON i.id = p.invoice_id
      LEFT JOIN sales.sale_return r ON r.id = p.return_id
      LEFT JOIN sales.invoice ri    ON ri.id = r.invoice_id
     WHERE p.status IN ('succeeded', 'settled', 'reconciled')
       AND coalesce(i.branch_id, r.branch_id) = p_branch
       AND platform.business_date(p.occurred_at) = p_date
     GROUP BY 1
  ),
  channels AS (
    SELECT channel FROM sold UNION SELECT channel FROM returned UNION SELECT channel FROM cash
  )
  SELECT p_date,
         ch.channel,
         coalesce(s.net, 0) - coalesce(r.net, 0),
         coalesce(c.net, 0),
         (coalesce(s.net, 0) - coalesce(r.net, 0)) - (coalesce(s.cogs, 0) - coalesce(r.cogs, 0)),
         coalesce(s.n, 0),
         coalesce(r.n, 0)
    FROM channels ch
    LEFT JOIN sold s     ON s.channel = ch.channel
    LEFT JOIN returned r ON r.channel = ch.channel
    LEFT JOIN cash c     ON c.channel = ch.channel
   ORDER BY 3 DESC, 2;
$$;
COMMENT ON FUNCTION sales.daily_summary_by_channel IS
  'خلاصه روز به تفکیک کانال فاکتور. جمع سطرها دقیقاً برابر sales.daily_summary است؛ مرجوعی و بازپرداخت به کانال فاکتور اصلی می‌خورند.';

COMMIT;
