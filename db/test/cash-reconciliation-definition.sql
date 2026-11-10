-- =====================================================================
-- گزارش «مغایرت نقد» با تعریف بستن شیفت (مهاجرت ۱۱۱)
-- =====================================================================
-- ادعای مرکزی: برای هر شیفت بسته، ستون‌های پول گزارش دقیقاً «انتظار»
-- ثبت‌شده را می‌سازند:
--   نقد اول + فروش نقدی − بازپرداخت نقدی + ورود غیرفروشی − خروج غیرفروشی
--     = expected_cash نوشته‌شده توسط sales.close_shift
--
-- سناریو دقیقاً همان دو حالتی را دارد که تعریف قدیمی (۰۳۸) نمی‌دید:
--   • پرداخت نقدی که بعداً `settled` شده
--   • روش پرداخت دومی با `kind = 'cash'` (کد متفاوت از 'cash')
-- و آنچه نباید شمرده شود: کارت‌خوان، پرداخت در انتظار/ناموفق.
-- بند ۳ کنترل حساسیت است: همان سناریو با تعریف قدیمی برابر نمی‌شد.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual numeric, p_expected numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

DO $test$
DECLARE
  BR      uuid := '00000000-0000-7000-8000-000000000001';
  WH      uuid := '00000000-0000-7000-8000-000000000101';
  CASHBOX uuid := '00000000-0000-7000-8000-000000000201';
  POS     uuid := '00000000-0000-7000-8000-000000000203';
  D       date := '2026-09-17';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_rcpt uuid; v_shift uuid;
  v_inv uuid; v_line uuid; v_ret uuid; v_tx uuid; v_pay uuid;
  r RECORD; v_old_sales numeric;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('crd','تست تعریف مغایرت نقد') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- روش نقدی دوم (مثلاً صندوق ارزی): کد دیگر، همان نوع.
INSERT INTO treasury.payment_method (code, name, kind, settlement_days, fee_percent, requires_ref)
VALUES ('cash_alt', 'نقد دوم آزمون', 'cash', 0, 0, false);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-CRD','تأمین‌کننده') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-CRD','کالای تست') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'مشکی','M','CRD-A') RETURNING id INTO v_a;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',1000000);
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, platform.business_day_start(D) + interval '8 hours')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount) VALUES (v_rcpt, v_a, 20, 400000, 8000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 300000, platform.business_day_start(D) + interval '8 hours 30 minutes') RETURNING id INTO v_shift;

-- فاکتور یک: سه A، پرداخت ۱٬۰۰۰٬۰۰۰ نقد + ۱٬۰۰۰٬۰۰۰ نقد دوم + ۱٬۰۰۰٬۰۰۰ کارت.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '9 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_a, 3, 1000000, 3000000) RETURNING id INTO v_line;
PERFORM sales.refresh_invoice_totals(v_inv);
-- مشتری‌دار، تا پرداخت در انتظار پایین فاکتور ناشناسِ مانده‌دار نسازد (بستن دوره آن را رد می‌کند).
WITH c AS (INSERT INTO sales.customer (full_name, credit_limit) VALUES ('مشتری آزمون مغایرت', 5000000) RETURNING id)
UPDATE sales.invoice SET customer_id = (SELECT id FROM c) WHERE id = v_inv;
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', CASHBOX, 'in', 1000000, 'succeeded', platform.business_day_start(D) + interval '9 hours 1 minute')
RETURNING id INTO v_pay;
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash_alt', CASHBOX, 'in', 1000000, 'succeeded', platform.business_day_start(D) + interval '9 hours 2 minutes');
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, ref_no, occurred_at)
VALUES (v_inv, v_shift, 'card', POS, 'in', 1000000, 'succeeded', 'CRD-1', platform.business_day_start(D) + interval '9 hours 3 minutes');
PERFORM sales.finalize_invoice(v_inv, v_user);
-- پرداخت نقدی اول بعداً تطبیق داده می‌شود: هنوز همان پول کشوست.
UPDATE treasury.payment SET status = 'settled' WHERE id = v_pay;

-- پرداخت در انتظار و ناموفق: پول نیستند.
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 400000, 'pending', platform.business_day_start(D) + interval '10 hours'),
       (v_inv, v_shift, 'cash', 'in', 200000, 'failed',  platform.business_day_start(D) + interval '10 hours 1 minute');

-- مرجوعی یک A با بازپرداخت نقدی.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv, WH, v_shift, 'size_small', 1000000, 'cash', platform.business_day_start(D) + interval '11 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- آورده و هزینهٔ کشو.
INSERT INTO treasury.transaction (branch_id, purpose, to_account_id, amount, shift_id, occurred_at, created_by)
VALUES (BR, 'capital', CASHBOX, 250000, v_shift, platform.business_day_start(D) + interval '12 hours', v_user) RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);
INSERT INTO treasury.transaction (branch_id, purpose, from_account_id, expense_account_code, amount, shift_id, occurred_at, created_by)
VALUES (BR, 'expense', CASHBOX, '6102', 90000, v_shift, platform.business_day_start(D) + interval '13 hours', v_user) RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);

PERFORM sales.close_shift(v_shift, 2460000, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. ستون‌های گزارش ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT * INTO r FROM treasury.report_cash_reconciliation(D, D, BR) WHERE shift_id = v_shift;
PERFORM pg_temp.assert_eq('نقد اول', r.opening_cash, 300000);
PERFORM pg_temp.assert_eq('فروش نقدی: نقد settled + روش نقدی دوم؛ نه کارت، نه در انتظار', r.cash_sales, 2000000);
PERFORM pg_temp.assert_eq('بازپرداخت نقدی', r.cash_refunds, 1000000);
PERFORM pg_temp.assert_eq('ورود غیرفروشی', r.cash_in, 250000);
PERFORM pg_temp.assert_eq('خروج غیرفروشی', r.cash_out, 90000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. جمع ستون‌ها = انتظار ثبت‌شدهٔ close_shift ═══';
-- ═══════════════════════════════════════════════════════════════════
PERFORM pg_temp.assert_eq('انتظار ثبت‌شده', r.expected_cash, 1460000);
PERFORM pg_temp.assert_eq('اول + فروش − بازپرداخت + ورود − خروج = انتظار',
  r.opening_cash + r.cash_sales - r.cash_refunds + r.cash_in - r.cash_out, r.expected_cash);
PERFORM pg_temp.assert_eq('همان تابع انتظار زنده', sales.shift_expected_cash(v_shift), r.expected_cash);
PERFORM pg_temp.assert_eq('مغایرت', r.variance, 1000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. کنترل حساسیت: تعریف قدیمی (۰۳۸) همین را نمی‌دید ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT coalesce(sum(p.amount), 0) INTO v_old_sales FROM treasury.payment p
 WHERE p.shift_id = v_shift AND p.direction = 'in' AND p.status = 'succeeded' AND p.method_code = 'cash';
PERFORM pg_temp.assert_eq('تعریف قدیمی فروش نقدی را صفر می‌دید', v_old_sales, 0);
PERFORM pg_temp.assert_eq('و با انتظار جمع نمی‌شد', (r.opening_cash + v_old_sales - r.cash_refunds + r.cash_in - r.cash_out = r.expected_cash)::int, 0);

END $test$;

ROLLBACK;
