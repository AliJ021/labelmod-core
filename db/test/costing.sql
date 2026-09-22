-- =====================================================================
-- تست روش قیمت تمام‌شده — «آخرین قیمت خرید» در برابر میانگین موزون
-- =====================================================================
-- ادعای مرکزی، به زبان خود مالک:
--
--   خرداد  ۱۰ عدد × ۲۰۰٬۰۰۰  →  انبار ۱۰ تا، ارزش ۲٬۰۰۰٬۰۰۰
--   شهریور ۱۰ عدد × ۳۰۰٬۰۰۰  →  انبار ۲۰ تا، ارزش ۶٬۰۰۰٬۰۰۰
--
-- با میانگین موزون، ارزش ۵٬۰۰۰٬۰۰۰ می‌شود. با «آخرین قیمت خرید»،
-- ۶٬۰۰۰٬۰۰۰ — و آن یک میلیون تفاوت باید در دفتر یک طرف حساب داشته
-- باشد، وگرنه سند نامتوازن می‌شود و دارایی از هوا زیاد شده است.
--
-- این فایل هر دو روش را روی **همان داده** اجرا می‌کند و سه چیز را
-- می‌سنجد که به‌تنهایی هیچ‌کدام کافی نیستند:
--   ۱. ارزش انبار
--   ۲. توازن سند خرید و سطر تعدیل
--   ۳. **جمع سود در طول عمر کالا با هر دو روش یکی است** — تنها
--      تفاوت، زمان شناسایی است.
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

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 78);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_entry uuid; v_shift uuid; v_inv uuid;
  v_qty platform.qty; v_val platform.money;
  v_n int; v_reval platform.money; v_cogs platform.money;
  v_dr platform.money; v_cr platform.money;
  v_sale_rev platform.money; v_profit_wa platform.money; v_profit_lp platform.money;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('cost','تست قیمت‌گذاری')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);
INSERT INTO purchasing.supplier (code, name) VALUES ('S-COST','تأمین‌کننده قیمت')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-COST','مانتو تست')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','COST-M') RETURNING id INTO v_var;
INSERT INTO catalog.price (variation_id, price_list, amount)
  VALUES (v_var, 'default', 500000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. میانگین موزون — روش دوم، هنوز کامل کار می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════

-- پیش‌فرض از مهاجرت ۰۱۳ «آخرین قیمت خرید» شد (تصمیم مالک). این بخش
-- رفتار میانگین موزون را می‌سنجد، پس صریح روشنش می‌کند.
PERFORM pg_temp.assert_eq('پیش‌فرض سیستم، آخرین قیمت خرید است',
  (platform.setting_text('costing.method') = 'last_purchase')::int, 1);
PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb,
  'تست: سنجش روش میانگین');

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 200000, 2000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('خرداد — تعداد', v_qty, 10);
PERFORM pg_temp.assert_eq('خرداد — ارزش', v_val, 2000000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-02')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 300000, 3000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('شهریور با میانگین موزون — تعداد', v_qty, 20);
PERFORM pg_temp.assert_eq('شهریور با میانگین موزون — ارزش', v_val, 5000000);

SELECT count(*) INTO v_n FROM inventory.stock_movement
 WHERE variation_id = v_var AND kind = 'revaluation';
PERFORM pg_temp.assert_eq('حرکت تجدید ارزیابی در روش میانگین', v_n, 0);

-- سود کل با میانگین موزون: ۲۰ عدد به ۵۰۰٬۰۰۰ فروخته می‌شود.
-- درآمد ۱۰٬۰۰۰٬۰۰۰ − بهای تمام‌شده ۵٬۰۰۰٬۰۰۰ = ۵٬۰۰۰٬۰۰۰
v_profit_wa := 20 * 500000 - v_val;
PERFORM pg_temp.assert_eq('سود کل با میانگین موزون (اگر همه بفروشد)', v_profit_wa, 5000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. آخرین قیمت خرید — همان سناریو، از اول ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.set_setting('costing.method', '"last_purchase"'::jsonb,
  'تست: روش رایج هلو و دشت');

-- یک تنوع تازه تا داده قبلی دخالت نکند
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سرمه‌ای','M','COST-M2') RETURNING id INTO v_var;
INSERT INTO catalog.price (variation_id, price_list, amount)
  VALUES (v_var, 'default', 500000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-03')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 200000, 2000000);
v_entry := purchasing.post_receipt(v_rcpt, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('خرداد — ارزش (اولین خرید، تعدیلی ندارد)', v_val, 2000000);

SELECT count(*) INTO v_n FROM inventory.stock_movement
 WHERE variation_id = v_var AND kind = 'revaluation';
PERFORM pg_temp.assert_eq('اولین خرید حرکت تجدید ارزیابی نمی‌سازد', v_n, 0);

-- خرید دوم: اینجاست که دو روش از هم جدا می‌شوند
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-04')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 300000, 3000000);
v_entry := purchasing.post_receipt(v_rcpt, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('شهریور — تعداد', v_qty, 20);
-- **همان عددی که مالک گفت**: ۲۰ × ۳۰۰٬۰۰۰
PERFORM pg_temp.assert_eq('شهریور — ارزش = تعداد × آخرین قیمت', v_val, 6000000);

SELECT value_delta INTO v_reval FROM inventory.stock_movement
 WHERE variation_id = v_var AND kind = 'revaluation';
PERFORM pg_temp.assert_eq('تفاوت تجدید ارزیابی', v_reval, 1000000);

SELECT count(*) INTO v_n FROM inventory.stock_movement
 WHERE variation_id = v_var AND kind = 'revaluation' AND qty <> 0;
PERFORM pg_temp.assert_eq('حرکت تجدید ارزیابی تعداد را دست نمی‌زند', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. دفتر: آن یک میلیون طرف حساب دارد ═══';
-- ═══════════════════════════════════════════════════════════════════

-- بدون سطر تعدیل، دارایی از هوا زیاد شده بود و سند نامتوازن می‌ماند.
SELECT sum(debit), sum(credit) INTO v_dr, v_cr
  FROM ledger.journal_line WHERE entry_id = v_entry;
PERFORM pg_temp.assert_eq('سند خرید متوازن است', v_dr - v_cr, 0);

SELECT coalesce(sum(debit),0) INTO v_val FROM ledger.journal_line
 WHERE entry_id = v_entry AND account_code = '1301';
PERFORM pg_temp.assert_eq('بدهکار موجودی کالا = کالا + تعدیل', v_val, 4000000);

SELECT coalesce(sum(credit),0) INTO v_val FROM ledger.journal_line
 WHERE entry_id = v_entry AND account_code = '5102';
PERFORM pg_temp.assert_eq('بستانکار تعدیل بهای تمام‌شده', v_val, 1000000);

-- ارزش دفتری موجودی باید با انبار بخواند — همان ادعای پایدار CI،
-- ولی اینجا نقطه‌ای و روی همین سناریو.
SELECT sum(debit) - sum(credit) INTO v_val FROM ledger.journal_line
 WHERE account_code = '1301';
SELECT sum(total_value) INTO v_qty FROM inventory.stock_balance;
PERFORM pg_temp.assert_eq('دفتر کل موجودی = جمع ارزش انبار', v_val - v_qty, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. سود کل عوض نمی‌شود، فقط زمانش ═══';
-- ═══════════════════════════════════════════════════════════════════
-- این مهم‌ترین ادعای این فایل است. با «آخرین قیمت خرید» یک میلیون
-- سود در **لحظه خرید** شناسایی می‌شود؛ با میانگین موزون همان یک
-- میلیون در **لحظه فروش**. جمع، یکی است.

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-05 09:00+03:30') RETURNING id INTO v_shift;

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-05 10:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 20, 500000, 10000000);
-- This snapshot/stock scenario is a paid sale, not anonymous credit.
INSERT INTO treasury.payment (invoice_id,shift_id,method_code,amount,status)
SELECT i.id,i.shift_id,'cash',sum(l.net_amount+l.tax_amount),'succeeded'
  FROM sales.invoice i JOIN sales.invoice_line l ON l.invoice_id=i.id
 WHERE i.id=v_inv GROUP BY i.id;
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT total_value INTO v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('پس از فروش کل، ارزش انبار صفر', v_val, 0);

SELECT abs(sum(value_delta)) INTO v_cogs FROM inventory.stock_movement
 WHERE variation_id = v_var AND kind = 'sale';
PERFORM pg_temp.assert_eq('بهای تمام‌شده فروش با آخرین قیمت خرید', v_cogs, 6000000);

-- سود این روش = (درآمد − COGS) + تعدیلِ زمان خرید
v_sale_rev  := 20 * 500000;
v_profit_lp := (v_sale_rev - v_cogs) + v_reval;
PERFORM pg_temp.assert_eq('سود کل با آخرین قیمت خرید', v_profit_lp, 5000000);
PERFORM pg_temp.assert_eq('سود کل دو روش یکی است', v_profit_lp - v_profit_wa, 0);

-- ولی زمان‌بندی فرق می‌کند، و این را هم صریح ثبت می‌کنیم:
PERFORM pg_temp.assert_eq('سهمِ شناسایی‌شده در لحظه خرید', v_reval, 1000000);
PERFORM pg_temp.assert_eq('سهمِ شناسایی‌شده در لحظه فروش', v_sale_rev - v_cogs, 4000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. تجدید ارزیابی رو به پایین ═══';
-- ═══════════════════════════════════════════════════════════════════
-- نرخ تازه‌ای پایین‌تر از موجودی فعلی یعنی **زیان** تعدیل، نه سود.
-- post_entry باید هر دو سطر را برعکس کند.

INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'زرشکی','L','COST-L') RETURNING id INTO v_var;

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-06')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 300000, 3000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-07')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 200000, 2000000);
v_entry := purchasing.post_receipt(v_rcpt, v_user);

SELECT total_value INTO v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('ارزش پس از ارزان‌شدن = ۲۰ × ۲۰۰٬۰۰۰', v_val, 4000000);

SELECT coalesce(sum(debit),0) INTO v_val FROM ledger.journal_line
 WHERE entry_id = v_entry AND account_code = '5102';
PERFORM pg_temp.assert_eq('زیان تعدیل، بدهکار ۵۱۰۲ می‌شود', v_val, 1000000);

SELECT sum(debit) - sum(credit) INTO v_val FROM ledger.journal_line WHERE entry_id = v_entry;
PERFORM pg_temp.assert_eq('سند خرید ارزان‌تر هم متوازن است', v_val, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. نگهبان‌ها ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('حرکت تعداد صفر با نوع غیر تجدید ارزیابی',
  format($$INSERT INTO inventory.stock_movement
             (variation_id, warehouse_id, qty, unit_cost, value_delta, kind)
           VALUES (%L, %L, 0, 100, 100, 'correction')$$, v_var, WH));

PERFORM pg_temp.assert_raises('تجدید ارزیابی با تعداد غیرصفر',
  format($$INSERT INTO inventory.stock_movement
             (variation_id, warehouse_id, qty, unit_cost, value_delta, kind)
           VALUES (%L, %L, 5, 100, 100, 'revaluation')$$, v_var, WH));

PERFORM pg_temp.assert_raises('تجدید ارزیابی با نرخ منفی',
  format($$SELECT inventory.revalue_to_cost(%L, %L, -1)$$, v_var, WH));

-- انباری که موجودی ندارد ارزیابی نمی‌شود — نه خطا، نه حرکت.
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'طوسی','S','COST-S') RETURNING id INTO v_var;
PERFORM pg_temp.assert_eq('تنوع بدون موجودی: تفاوت صفر',
  inventory.revalue_to_cost(v_var, WH, 900000), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف Projection با حرکت‌ها', v_n, 0);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.stock_balance WHERE on_hand < 0;
PERFORM pg_temp.assert_eq('موجودی منفی', v_n, 0);

RAISE NOTICE E'\n✔ قیمت‌گذاری — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
