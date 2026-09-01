-- =====================================================================
-- ۰۱۸ — خلاصه روز: فروش، وجه دریافتی، سود
-- =====================================================================
-- داشبورد تا امروز داده نمونه داشت، چون هیچ مسیری این سه عدد را
-- نمی‌داد. اینجا در SQL حساب می‌شوند، نه در TypeScript — همان قاعده‌ای
-- که کل این پروژه رویش ایستاده: تقسیم و جمع پول در جاوااسکریپت با
-- جمع دیتابیس یکی درنمی‌آید.
--
-- ── چرا این سه عدد، و چرا جدا ─────────────────────────────────────
--
-- `.claude/rules/design.md` صریح است: «هیچ کارتی در داشبورد بدون
-- برچسب صریح یکی از این سه نباشد: فروش · وجه دریافتی · سود. این سه
-- هرگز زیر «دخل» جمع نمی‌شوند.»
--
-- دلیلش این است که سه چیز کاملاً متفاوت‌اند و مالکِ فروشگاه اگر
-- یکی‌شان کند، تصمیم غلط می‌گیرد:
--
--   **فروش** چقدر کالا رفت. مستقل از اینکه پولش رسیده یا نه.
--   **وجه دریافتی** چقدر پول واقعاً آمد. نسیه اینجا نیست؛ پول فردا
--                   هم اینجا نیست.
--   **سود** فروش منهای بهای تمام‌شده. عددی که هیچ‌کدام از آن دو
--          نشانش نمی‌دهند.
--
-- روزی که مشتری فاکتور ده‌میلیونی نسیه ببرد، «فروش» بالا می‌رود و
-- «وجه دریافتی» تکان نمی‌خورد. اگر یکی بودند، مالک فکر می‌کرد پول در
-- کشوست.
--
-- ── مرجوعی کم می‌شود، نه اینکه نادیده گرفته شود ───────────────────
--
-- مرجوعیِ ثبت‌شده هم از فروش کم می‌شود، هم از بهای تمام‌شده، هم
-- بازپرداختش از وجه دریافتی. نشان‌دادن فروشِ ناخالص در داشبورد یعنی
-- روزی که نصف فروش برگشت، عدد همان می‌ماند.
--
-- ── «امروز» یک تعریف دارد ─────────────────────────────────────────
--
-- `platform.business_date()` از تنظیم `platform.timezone` می‌آید، نه
-- از منطقه زمانی سرور. بدون این، فروش یک بامداد روی سروری با UTC به
-- روز قبل می‌خورد.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sales.daily_summary(
  p_branch uuid, p_date date DEFAULT platform.business_date()
) RETURNS TABLE (
  business_date  date,
  sales_amount   platform.money,
  received_amount platform.money,
  profit_amount  platform.money,
  invoice_count  bigint,
  return_count   bigint
)
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  WITH sold AS (
    -- هر فاکتوری که پیش‌نویس و باطل‌شده نیست، فروش است. وضعیت‌ها را
    -- برنمی‌شماریم: فهرست بستهٔ CHECK روزی گزینه تازه می‌گیرد و آن
    -- روز این کوئری باید خودش درست بماند، نه اینکه بی‌صدا از قلم
    -- بیندازدش.
    SELECT coalesce(sum(i.net_amount), 0)  AS net,
           coalesce(sum(i.cogs_amount), 0) AS cogs,
           count(*)                        AS n
      FROM sales.invoice i
     WHERE i.branch_id = p_branch
       AND i.status NOT IN ('draft', 'cancelled')
       AND platform.business_date(i.occurred_at) = p_date
  ),
  returned AS (
    SELECT coalesce(sum(r.net_amount), 0)  AS net,
           coalesce(sum(r.cogs_amount), 0) AS cogs,
           count(*)                        AS n
      FROM sales.sale_return r
     WHERE r.branch_id = p_branch
       AND r.status = 'posted'
       AND platform.business_date(r.occurred_at) = p_date
  ),
  cash AS (
    -- پول **واقعاً موفق**. «نامشخص» و «در انتظار» پول نیستند — همان
    -- تعریفی که `paidSoFar` در لایه فروش دارد.
    --
    -- `direction` هر دو طرف را می‌گیرد: بازپرداخت مرجوعی یک
    -- `payment` با جهت `out` است و باید از دریافتی کم شود، وگرنه
    -- روزی که همه‌چیز برگشت، داشبورد پول نشان می‌داد.
    SELECT coalesce(sum(
             CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END
           ), 0) AS net
      FROM treasury.payment p
      LEFT JOIN sales.invoice i     ON i.id = p.invoice_id
      LEFT JOIN sales.sale_return r ON r.id = p.return_id
     WHERE p.status IN ('succeeded', 'settled', 'reconciled')
       AND coalesce(i.branch_id, r.branch_id) = p_branch
       AND platform.business_date(p.occurred_at) = p_date
  )
  SELECT p_date,
         sold.net - returned.net,
         cash.net,
         (sold.net - returned.net) - (sold.cogs - returned.cogs),
         sold.n,
         returned.n
    FROM sold, returned, cash;
$$;

COMMENT ON FUNCTION sales.daily_summary IS
  'فروش، وجه دریافتی و سود یک شعبه در یک روز کاری. مرجوعی از هر سه کم می‌شود. این سه هرگز زیر «دخل» جمع نمی‌شوند.';

COMMIT;
