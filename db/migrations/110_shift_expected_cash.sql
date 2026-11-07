-- =====================================================================
-- ۱۱۰ — «انتظار نقد» شیفت باز، با همان فرمول بستن شیفت
-- =====================================================================
-- طرح ۱۰ (WP4 دستهٔ ۴، خزانه): جدول «شیفت‌ها و کشوها» برای کشوی باز
-- «انتظار نقد» را نشان می‌دهد. ستون `sales.cash_shift.expected_cash` فقط در
-- لحظهٔ بستن پر می‌شود، پس برای کشوی باز `NULL` است.
--
-- ⚠️ **تعریف مالی تازه نیست.** این تابع همان دو جمع `sales.close_shift`
--    (۰۳۹) است، بی هیچ تغییری:
--      ۱) نقد فروش و بازپرداخت: `treasury.payment` همین شیفت، روش با
--         `kind = 'cash'`، وضعیت succeeded/settled/reconciled؛
--      ۲) حرکت نقد غیرفروشی همین شیفت با وضعیت posted: ورود به
--         `cash_box` و خروج از آن.
--    انتظار = موجودی اول + نقد ورودی + ورود غیرفروشی − نقد خروجی − خروج غیرفروشی.
--
-- ⚠️ **چرا از `treasury.report_cash_reconciliation` (۰۳۸) نمی‌خوانیم:** آن
--    گزارش فقط `method_code = 'cash'` و فقط وضعیت `succeeded` را می‌شمارد؛
--    پرداخت نقدی `settled` یا روش نقدی دیگر را نمی‌بیند. برای شیفت باز عددی
--    می‌داد که پس از بستن با «انتظار» ثبت‌شده فرق می‌کرد — صفحه‌ای که یک
--    عدد نشان می‌دهد و بعد از شمارش عدد دیگری، اعتماد به شمارش را می‌کشد.
--    آن گزارش اینجا عوض نمی‌شود؛ اختلافش در `docs/V10-WORK-PACKAGES-FA.md` ثبت است.
--
-- ⚠️ **یک تعریف، با قفل آزمون.** `close_shift` بدنهٔ بلندی دارد (ثبت دوره،
--    سند مغایرت، حسابرسی) و بازنویسی‌اش برای فراخوانی این تابع ریسکی بی‌سود
--    است. به‌جایش `db/test/shift-expected-cash.sql` شیفت واقعی می‌سازد و پس از
--    `close_shift` ادعا می‌کند این تابع دقیقاً همان `expected_cash` ثبت‌شده را
--    می‌دهد — با پرداخت غیرنقدی، بازپرداخت، ورود و خروج غیرفروشی و وضعیت
--    ناموفق که هر کدام اگر یکی از دو تعریف را عوض کند، قرمز می‌شود.
--
-- بدون جدول، بدون تغییر داده، بدون `SECURITY DEFINER` (فقط خواندن).
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.shift_expected_cash(p_shift uuid)
RETURNS platform.money
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  SELECT s.opening_cash
         + coalesce(p.cash_in, 0) + coalesce(t.tx_in, 0)
         - coalesce(p.cash_out, 0) - coalesce(t.tx_out, 0)
    FROM sales.cash_shift s
    LEFT JOIN LATERAL (
      SELECT sum(x.amount) FILTER (WHERE x.direction = 'in')  AS cash_in,
             sum(x.amount) FILTER (WHERE x.direction = 'out') AS cash_out
        FROM treasury.payment x
        JOIN treasury.payment_method m ON m.code = x.method_code
       WHERE x.shift_id = s.id AND m.kind = 'cash'
         AND x.status IN ('succeeded', 'settled', 'reconciled')
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT sum(x.amount) FILTER (WHERE ta.kind = 'cash_box') AS tx_in,
             sum(x.amount) FILTER (WHERE fa.kind = 'cash_box') AS tx_out
        FROM treasury.transaction x
        LEFT JOIN treasury.account ta ON ta.id = x.to_account_id
        LEFT JOIN treasury.account fa ON fa.id = x.from_account_id
       WHERE x.shift_id = s.id AND x.status = 'posted'
    ) t ON true
   WHERE s.id = p_shift;
$$;
COMMENT ON FUNCTION sales.shift_expected_cash IS
  'انتظار نقد کشو با همان فرمول sales.close_shift (۰۳۹). برای شیفت بسته باید برابر expected_cash ثبت‌شده باشد (db/test/shift-expected-cash.sql).';

COMMIT;
