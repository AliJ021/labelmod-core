-- =====================================================================
-- ۱۱۱ — گزارش «مغایرت نقد» با همان تعریف بستن شیفت
-- =====================================================================
-- یافتهٔ WP4 دستهٔ ۴ (۲۰۲۶/۱۱/۰۶)، به خواست مالک اصلاح شد.
--
-- `treasury.report_cash_reconciliation` (۰۳۸) «فروش نقدی» و «بازپرداخت
-- نقدی» را فقط از پرداخت با `method_code = 'cash'` و وضعیت `succeeded`
-- می‌شمرد. `sales.close_shift` (۰۳۹) همان پول را از هر روش با
-- `payment_method.kind = 'cash'` و وضعیت‌های succeeded/settled/reconciled
-- می‌شمارد و «انتظار» را از آن می‌سازد. پس پرداخت نقدی‌ای که بعداً
-- `settled` یا `reconciled` شد، یا روش نقدی دومی، در ستون‌های گزارش
-- نبود ولی در «انتظار» همان سطر بود: جمع ستون‌ها با انتظار نمی‌خواند و
-- حسابدار مغایرتی می‌دید که وجود نداشت.
--
-- ── یک تعریف ─────────────────────────────────────────────────────────
--
-- `sales.shift_cash_flows(شیفت)` چهار جمع پول کشو را یک جا تعریف می‌کند —
-- **عیناً** دو جمع `close_shift`:
--   cash_in / cash_out  پرداخت با روش `kind = 'cash'`، وضعیت
--                       succeeded/settled/reconciled، ورودی/خروجی
--   tx_in  / tx_out     حرکت خزانهٔ posted همین شیفت به/از `cash_box`
-- و دو مصرف‌کننده دارد:
--   • `sales.shift_expected_cash` (۱۱۰) — حالا از همین تابع؛ خروجی‌اش
--     بیت‌به‌بیت همان است (`db/test/shift-expected-cash.sql` دست‌نخورده).
--   • `treasury.report_cash_reconciliation` — امضا و ستون‌ها همان، فقط
--     چهار ستون پول از همین تابع.
-- `close_shift` بازنویسی نمی‌شود (بدنهٔ بلند ثبت دوره و سند مغایرت)؛
-- برابری‌اش با این تابع را `db/test/shift-expected-cash.sql` و
-- `db/test/cash-reconciliation-definition.sql` قفل کرده‌اند.
--
-- ⚠️ ستون‌های انتظار، شمرده و مغایرت گزارش از خودِ شیفت‌اند و عوض
--    نمی‌شوند. سند یا دادهٔ تاریخی بازنویسی نمی‌شود؛ گزارش فقط خواندنی است.
--
-- بدون جدول، بدون تغییر داده، بدون `SECURITY DEFINER`.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.shift_cash_flows(p_shift uuid)
RETURNS TABLE (cash_in platform.money, cash_out platform.money, tx_in platform.money, tx_out platform.money)
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  SELECT coalesce(p.cash_in, 0)::platform.money, coalesce(p.cash_out, 0)::platform.money,
         coalesce(t.tx_in, 0)::platform.money,   coalesce(t.tx_out, 0)::platform.money
    FROM (SELECT sum(x.amount) FILTER (WHERE x.direction = 'in')  AS cash_in,
                 sum(x.amount) FILTER (WHERE x.direction = 'out') AS cash_out
            FROM treasury.payment x
            JOIN treasury.payment_method m ON m.code = x.method_code
           WHERE x.shift_id = p_shift AND m.kind = 'cash'
             AND x.status IN ('succeeded', 'settled', 'reconciled')) p,
         (SELECT sum(x.amount) FILTER (WHERE ta.kind = 'cash_box') AS tx_in,
                 sum(x.amount) FILTER (WHERE fa.kind = 'cash_box') AS tx_out
            FROM treasury.transaction x
            LEFT JOIN treasury.account ta ON ta.id = x.to_account_id
            LEFT JOIN treasury.account fa ON fa.id = x.from_account_id
           WHERE x.shift_id = p_shift AND x.status = 'posted') t;
$$;
COMMENT ON FUNCTION sales.shift_cash_flows IS
  'چهار جمع پول کشوی یک شیفت با همان تعریف sales.close_shift: نقد ورودی/خروجی پرداخت (kind=cash، succeeded/settled/reconciled) و ورود/خروج غیرفروشی (posted، cash_box).';

CREATE OR REPLACE FUNCTION sales.shift_expected_cash(p_shift uuid)
RETURNS platform.money
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  SELECT s.opening_cash + f.cash_in + f.tx_in - f.cash_out - f.tx_out
    FROM sales.cash_shift s
    CROSS JOIN LATERAL sales.shift_cash_flows(s.id) f
   WHERE s.id = p_shift;
$$;

CREATE OR REPLACE FUNCTION treasury.report_cash_reconciliation(
  p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  shift_id      uuid,
  branch_name   text,
  user_name     text,
  opened_at     timestamptz,
  closed_at     timestamptz,
  opening_cash  platform.money,
  cash_sales    platform.money,
  cash_refunds  platform.money,
  cash_in       platform.money,
  cash_out      platform.money,
  expected_cash platform.money,
  counted_cash  platform.money,
  variance      platform.money,
  status        text
) LANGUAGE sql STABLE AS $$
  SELECT s.id, b.name, u.full_name, s.opened_at, s.closed_at, s.opening_cash,
         -- همان چهار جمعی که close_shift «انتظار» را از آن‌ها می‌سازد (۱۱۱).
         f.cash_in, f.cash_out, f.tx_in, f.tx_out,
         s.expected_cash, s.counted_cash, s.variance, s.status
    FROM sales.cash_shift s
    JOIN platform.branch     b ON b.id = s.branch_id
    JOIN identity.app_user   u ON u.id = s.user_id
    CROSS JOIN LATERAL sales.shift_cash_flows(s.id) f
   WHERE s.opened_at >= platform.business_day_start(p_from)
     AND s.opened_at <  platform.business_day_start(p_to + 1)
     AND (p_branch IS NULL OR s.branch_id = p_branch)
   ORDER BY s.opened_at DESC;
$$;

COMMIT;
