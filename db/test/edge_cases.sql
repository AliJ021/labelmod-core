-- =====================================================================
-- تست حالت‌های لبه‌ای
-- =====================================================================
-- این‌ها جاهایی‌اند که سیستم‌های مالی معمولاً بی‌سروصدا اشتباه می‌کنند:
-- گرد کردن میانگین، تخلیه کامل موجودی، فروش نسیه، و مرجوعی کامل.
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
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_cust uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid; v_ret uuid;
  v_qty numeric; v_val numeric; v_dr numeric; v_cr numeric; v_n int;
  v_ledger_inv numeric; v_stock_inv numeric;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('edge','تست لبه')
RETURNING id INTO v_user;
INSERT INTO purchasing.supplier (code, name) VALUES ('S9','تأمین‌کننده')
RETURNING id INTO v_sup;
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
VALUES ('09120000000','مشتری نسیه', 50000000) RETURNING id INTO v_cust;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-EDGE','کالای تست')
RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
VALUES (v_prod,'سفید','L','EDGE-L') RETURNING id INTO v_var;

-- این فایل رفتار **میانگین متحرک موزون** را می‌سنجد: گرد کردن
-- غیربخش‌پذیر، تخلیه کامل موجودی، و باقی‌مانده ارزش. پس روش را صریح
-- انتخاب می‌کند و به پیش‌فرض سیستم تکیه نمی‌کند — پیش‌فرض از مهاجرت
-- ۰۱۳ «آخرین قیمت خرید» است و ادعاهای عددی این فایل را عوض می‌کرد.
--
-- تکیه‌نکردن به پیش‌فرض، خودش یک قاعده است: تستی که عددش با یک تنظیم
-- عوض می‌شود، باید همان تنظیم را خودش بگذارد.
-- کاربر عامل صریح پاس داده می‌شود: این دو فایل `set_actor` را در
-- نشست ست نمی‌کنند و توابع مالی را با `p_user` صدا می‌زنند.
PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb,
  'تست حالت لبه‌ای: سنجش میانگین موزون', v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. میانگین غیربخش‌پذیر و تخلیه کامل موجودی ═══';
-- ۲ عدد × ۱٬۰۰۰٬۰۰۰ و ۱ عدد × ۱٬۰۰۰٬۰۰۱ → ارزش ۳٬۰۰۰٬۰۰۱ روی ۳ عدد
-- میانگین = ۱٬۰۰۰٬۰۰۰.۳۳ که عدد صحیح نیست. اینجا جایی است که
-- دفتر کل و انبار معمولاً از هم جدا می‌افتند.

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 2, 1000000, 2000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-02')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 1, 1000001, 1000001);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('ارزش موجودی غیربخش‌پذیر', v_val, 3000001);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-03 09:00+03:30') RETURNING id INTO v_shift;

-- فروش ۱ عدد: بهای واحد = round(3,000,001/3) = 1,000,000
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-03 10:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 1, 2000000, 2000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount)
VALUES (v_inv, v_shift, 'cash', 2000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پس از فروش اول', v_qty, 2);
PERFORM pg_temp.assert_eq('ارزش باقی‌مانده', v_val, 2000001);

-- فروش ۲ عدد باقی‌مانده: آخرین واحدها باید کل ارزش را جذب کنند
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-03 11:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 2000000, 4000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount)
VALUES (v_inv, v_shift, 'cash', 4000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پس از تخلیه کامل', v_qty, 0);
PERFORM pg_temp.assert_eq('ارزش موجودی دقیقاً صفر — بدون ریال سرگردان', v_val, 0);
PERFORM pg_temp.assert_eq('COGS فاکتور دوم = کل ارزش باقی‌مانده',
  (SELECT cogs_amount FROM sales.invoice WHERE id = v_inv), 2000001);

PERFORM sales.close_shift(v_shift, 6000000, v_user);

-- ادعای اصلی: دفتر کل و انبار حتی در حالت گرد کردن هم نباید جدا شوند
SELECT coalesce(sum(debit - credit),0) INTO v_ledger_inv
  FROM ledger.journal_line WHERE account_code = '1301';
SELECT coalesce(sum(total_value),0) INTO v_stock_inv FROM inventory.stock_balance;
PERFORM pg_temp.assert_eq('ارزش موجودی: دفتر کل = انبار', v_ledger_inv, v_stock_inv);
PERFORM pg_temp.assert_eq('هر دو صفر', v_ledger_inv, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. فروش نسیه — سند باید متوازن بماند ═══';
-- فاکتور ۵٬۰۰۰٬۰۰۰ با فقط ۲٬۰۰۰٬۰۰۰ دریافتی نقدی.
-- دریافتنی باید ۳٬۰۰۰٬۰۰۰ به‌صورت باقی‌مانده محاسبه شود.

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-04')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 5, 1000000, 5000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-05 09:00+03:30') RETURNING id INTO v_shift;

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id,
                           occurred_at, created_by)
VALUES (BR, WH, v_shift, v_cust, '2026-06-05 10:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 2500000, 5000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount)
VALUES (v_inv, v_shift, 'cash', 2000000);
PERFORM sales.finalize_invoice(v_inv, v_user);
PERFORM sales.close_shift(v_shift, 2000000, v_user);

PERFORM pg_temp.assert_eq('حساب دریافتنی مشتری',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1201'), 3000000);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن پس از فروش نسیه', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. مرجوعی کامل فروش نسیه ═══';
-- فاکتور ۵٬۰۰۰٬۰۰۰ بود که فقط ۲٬۰۰۰٬۰۰۰ نقدی دریافت شده. مرجوعی کامل
-- باید همان ۲٬۰۰۰٬۰۰۰ را برگرداند و ۳٬۰۰۰٬۰۰۰ بدهی را صفر کند —
-- نه اینکه ۵٬۰۰۰٬۰۰۰ نقد بدهد و بدهی را دست‌نخورده بگذارد.

SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id,
                               reason_code, refund_amount, refund_method,
                               occurred_at, created_by)
VALUES (BR, v_inv, WH, 'changed_mind', 2000000, 'cash', '2026-06-06', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 2, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

PERFORM pg_temp.assert_eq('وضعیت فاکتور پس از مرجوعی کامل',
  (SELECT CASE status WHEN 'returned' THEN 1 ELSE 0 END
     FROM sales.invoice WHERE id = v_inv), 1);
PERFORM pg_temp.assert_eq('بهای برگشتی = بهای خارج‌شده',
  (SELECT cogs_amount FROM sales.sale_return WHERE id = v_ret),
  (SELECT cogs_amount FROM sales.invoice_line WHERE id = v_line));
PERFORM pg_temp.assert_eq('بدهی مشتری پس از مرجوعی کامل',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1201'), 0);
PERFORM pg_temp.assert_eq('بدهی تسویه‌شده روی برگ مرجوعی',
  (SELECT receivable_applied FROM sales.sale_return WHERE id = v_ret), 3000000);
PERFORM pg_temp.assert_eq('اعتبار مشتری — نباید ساخته شود',
  (SELECT coalesce(sum(credit - debit),0) FROM ledger.journal_line
    WHERE account_code = '2301'), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. صحت نهایی کل دفتر ═══';

SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO v_dr, v_cr
  FROM ledger.journal_line;
PERFORM pg_temp.assert_eq('جمع بدهکار = جمع بستانکار', v_dr, v_cr);

SELECT coalesce(sum(debit - credit),0) INTO v_ledger_inv
  FROM ledger.journal_line WHERE account_code = '1301';
SELECT coalesce(sum(total_value),0) INTO v_stock_inv FROM inventory.stock_balance;
PERFORM pg_temp.assert_eq('ارزش موجودی: دفتر کل = انبار', v_ledger_inv, v_stock_inv);

SELECT count(*) INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف Projection با مرجع حرکت‌ها', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.stock_balance WHERE on_hand < 0;
PERFORM pg_temp.assert_eq('موجودی منفی', v_n, 0);

RAISE NOTICE E'\n╔════════════════════════════════════════╗';
RAISE NOTICE   '║   تمام تست‌های حالت لبه‌ای پاس شدند   ║';
RAISE NOTICE   '╚════════════════════════════════════════╝';
END $test$;

ROLLBACK;
