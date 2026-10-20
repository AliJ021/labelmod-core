-- =====================================================================
-- خلاصهٔ دوره‌ای داشبورد (مهاجرت ۰۹۹) — کانال، مرجوعی ≠ بازپرداخت، ترکیب پرداخت
-- =====================================================================
-- ادعای مرکزی: جمع کانال‌های `sales.dashboard_period` دقیقاً جمع
-- `sales.daily_summary_range` همان (شعبه، بازه) است، و جمع خالص
-- `sales.dashboard_payment_mix` دقیقاً جمع دریافتی آن. داشبورد هیچ عددی
-- نمی‌سازد که خلاصهٔ روز تعریف دیگری از آن داشته باشد.
--
-- روزها ثابت‌اند (D = ۲۴ شهریور ۱۴۰۵):
--
--   D 01:10  صندوق، نقد ۲٬۰۰۰٬۰۰۰                بامداد تهران، شب قبل به UTC
--   D 11:00  صندوق، نسیه ۱٬۰۰۰٬۰۰۰               بی پول
--   D 14:00  سایت، زیر بها ۹۰۰٬۰۰۰               پرداخت «در انتظار» — پول نیست
--   D 15:00  سایت، کارت ۱٬۰۰۰٬۰۰۰
--   D 23:50  سایت ۱٬۰۰۰٬۰۰۰، کارتِ ۰۰:۰۵ D+1     فروشِ D، دریافتیِ D+1
--   D+1      مرجوعی فاکتور نقدی با بازپرداخت نقد      صندوق
--   D+1      مرجوعی فاکتور نسیه **بی بازپرداخت**     صندوق — کالا برگشت، پول نه
--   D+1      مرجوعی سفارش سایت در فروشگاه، بازپرداخت کارت — از «سایت» کم می‌شود
--   شعبهٔ دوم D  صندوق، نقد ۱٬۰۰۰٬۰۰۰               فقط در «همهٔ شعبه‌ها»
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

-- جمع کانال‌ها و ترکیب پرداخت در برابر جمع خلاصهٔ روزِ همان بازه. شعبهٔ NULL
-- یعنی همه: جمع خلاصهٔ روز روی همهٔ شعبه‌هایی که سطری دارند.
CREATE OR REPLACE FUNCTION pg_temp.assert_reconciles(p_label text, p_branch uuid, p_from date, p_to date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p RECORD; d RECORD; mix numeric;
BEGIN
  SELECT coalesce(sum(sales_amount), 0) AS sales, coalesce(sum(profit_amount), 0) AS profit,
         coalesce(sum(invoice_count), 0) AS n, coalesce(sum(return_count), 0) AS rn,
         coalesce(sum(gross_amount), 0) - coalesce(sum(return_amount), 0) AS gross_minus_ret
    INTO p FROM sales.dashboard_period(p_branch, p_from, p_to);
  SELECT coalesce(sum(r.sales_amount), 0) AS sales, coalesce(sum(r.profit_amount), 0) AS profit,
         coalesce(sum(r.invoice_count), 0) AS n, coalesce(sum(r.return_count), 0) AS rn,
         coalesce(sum(r.received_amount), 0) AS received
    INTO d
    FROM platform.branch b, sales.daily_summary_range(b.id, p_from, p_to) r
   WHERE p_branch IS NULL OR b.id = p_branch;
  SELECT coalesce(sum(net_amount), 0) INTO mix FROM sales.dashboard_payment_mix(p_branch, p_from, p_to);
  IF (p.sales, p.profit, p.n, p.rn, p.gross_minus_ret, mix) IS DISTINCT FROM (d.sales, d.profit, d.n, d.rn, d.sales, d.received) THEN
    RAISE EXCEPTION E'\n  ✗ %: با خلاصهٔ روز نمی‌خواند\n      داشبورد: % / ترکیب پرداخت %\n      خلاصه  : %', p_label, p, mix, d;
  END IF;
  RAISE NOTICE '  ✓ %: فروش %، سود %، فاکتور %، مرجوعی %، دریافت % — برابر خلاصهٔ روز', p_label, p.sales, p.profit, p.n, p.rn, mix;
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  D    date := '2026-09-15';
  v_br2 uuid; v_wh2 uuid;
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_b uuid; v_cust uuid;
  v_rcpt uuid; v_shift uuid; v_shift2 uuid; v_inv uuid; v_line uuid;
  v_cash uuid; v_cash_line uuid; v_credit uuid; v_credit_line uuid; v_web uuid; v_web_line uuid;
  v_ret uuid;
  s RECORD; n numeric; msg text;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('dpd','تست خلاصهٔ دوره')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',NULL);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DPD','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DPD','کالای تست')
  RETURNING id INTO v_prod;
-- A: قیمت ۱٬۰۰۰٬۰۰۰، بها ۴۰۰٬۰۰۰. B: قیمت ۳۰۰٬۰۰۰ زیر بهای ۴۰۰٬۰۰۰.
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','DPD-A') RETURNING id INTO v_a;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','DPD-B') RETURNING id INTO v_b;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',1000000), (v_b,'default',300000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH,
        platform.business_day_start(D) + interval '5 minutes')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_a, 100, 400000, 40000000), (v_rcpt, v_b, 10, 400000, 4000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, platform.business_day_start(D) + interval '10 minutes') RETURNING id INTO v_shift;
INSERT INTO sales.customer (full_name, credit_limit) VALUES ('period credit fixture', 5000000)
  RETURNING id INTO v_cust;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. بازهٔ خالی: صندوق و سایت صفر، میانگین تهی، ترکیب پرداخت خالی ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO n FROM sales.dashboard_period(BR, D - 10, D - 1);
PERFORM pg_temp.assert_eq('بازهٔ خالی: دو سطر (صندوق، سایت)', n, 2);
SELECT count(*) INTO n FROM sales.dashboard_period(BR, D - 10, D - 1)
 WHERE invoice_count = 0 AND gross_amount = 0 AND return_amount = 0 AND sales_amount = 0 AND average_invoice IS NULL;
PERFORM pg_temp.assert_eq('بازهٔ خالی: هر دو صفر و میانگین تهی (نه صفر)', n, 2);
SELECT count(*) INTO n FROM sales.dashboard_payment_mix(BR, D - 10, D - 1);
PERFORM pg_temp.assert_eq('بازهٔ خالی: هیچ روش پرداختی', n, 0);
PERFORM pg_temp.assert_reconciles('بازهٔ خالی', BR, D - 10, D - 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. روز D: صندوق و سایت ═══';
-- ═══════════════════════════════════════════════════════════════════

-- صندوق، ۰۱:۱۰ بامداد تهران، نقد.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '1 hour 10 minutes', v_user) RETURNING id INTO v_cash;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_cash, 1, v_a, 2, 1000000, 2000000) RETURNING id INTO v_cash_line;
PERFORM sales.refresh_invoice_totals(v_cash);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_cash, v_shift, 'cash', 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '1 hour 11 minutes');
PERFORM sales.finalize_invoice(v_cash, v_user);

-- صندوق، نسیه.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by, customer_id)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '11 hours', v_user, v_cust) RETURNING id INTO v_credit;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_credit, 1, v_a, 1, 1000000, 1000000) RETURNING id INTO v_credit_line;
PERFORM sales.refresh_invoice_totals(v_credit);
PERFORM sales.finalize_invoice(v_credit, v_user);

-- سایت، سه B زیر بها؛ پرداخت درگاه «در انتظار».
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', platform.business_day_start(D) + interval '14 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_b, 3, 300000, 900000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, ref_no, occurred_at)
VALUES (v_inv, 'gateway', 'in', 900000, 'pending', 'GW-1', platform.business_day_start(D) + interval '14 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- سایت، کارت.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', platform.business_day_start(D) + interval '15 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, ref_no, occurred_at)
VALUES (v_inv, 'card', 'in', 1000000, 'succeeded', 'C-1', platform.business_day_start(D) + interval '15 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- سایت، ۲۳:۵۰؛ کارتِ ۰۰:۰۵ فردا.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', platform.business_day_start(D) + interval '23 hours 50 minutes', v_user) RETURNING id INTO v_web;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_web, 1, v_a, 1, 1000000, 1000000) RETURNING id INTO v_web_line;
PERFORM sales.refresh_invoice_totals(v_web);
INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, ref_no, occurred_at)
VALUES (v_web, 'card', 'in', 1000000, 'succeeded', 'C-2', platform.business_day_start(D + 1) + interval '5 minutes');
PERFORM sales.finalize_invoice(v_web, v_user);

SELECT * INTO s FROM sales.dashboard_period(BR, D, D) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('D صندوق: دو فاکتور', s.invoice_count, 2);
PERFORM pg_temp.assert_eq('D صندوق: ناخالص ۳٬۰۰۰٬۰۰۰ (نسیه هم فروش است)', s.gross_amount, 3000000);
PERFORM pg_temp.assert_eq('D صندوق: میانگین ۱٬۵۰۰٬۰۰۰', s.average_invoice, 1500000);
SELECT * INTO s FROM sales.dashboard_period(BR, D, D) WHERE channel = 'web';
PERFORM pg_temp.assert_eq('D سایت: سه فاکتور', s.invoice_count, 3);
PERFORM pg_temp.assert_eq('D سایت: ناخالص ۲٬۹۰۰٬۰۰۰', s.gross_amount, 2900000);
PERFORM pg_temp.assert_eq('D سایت: میانگین ۲٬۹۰۰٬۰۰۰÷۳ گرد به ریال (۹۶۶٬۶۶۶٫۶۷ → ۹۶۶٬۶۶۷)', s.average_invoice, 966667);
PERFORM pg_temp.assert_eq('D سایت: سود (۰٫۹−۱٫۲) + (۱−۰٫۴)×۲', s.profit_amount, 900000);
PERFORM pg_temp.assert_reconciles('روز D', BR, D, D);

SELECT * INTO s FROM sales.dashboard_payment_mix(BR, D, D) WHERE method_code = 'gateway';
PERFORM pg_temp.assert_eq('D: درگاهِ «در انتظار» پول نیست (سطری ندارد)', coalesce(s.received_amount, 0), 0);
SELECT count(*) INTO n FROM sales.dashboard_payment_mix(BR, D, D) WHERE method_code = 'gateway';
PERFORM pg_temp.assert_eq('D: روش بی پول موفق سطری ندارد', n, 0);
SELECT * INTO s FROM sales.dashboard_payment_mix(BR, D, D) WHERE method_code = 'card';
PERFORM pg_temp.assert_eq('D کارت: فقط پرداخت همان روز (۰۰:۰۵ فردا نه)', s.received_amount, 1000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. روز D+1: سه مرجوعی، دو بازپرداخت ═══';
-- ═══════════════════════════════════════════════════════════════════

-- مرجوعی فاکتور نقدی، بازپرداخت نقد.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_cash, WH, v_shift, 'size_small', 1000000, 'cash',
        platform.business_day_start(D + 1) + interval '10 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_cash_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- مرجوعی فاکتور نسیه: بدهی صفر می‌شود، پولی برنمی‌گردد.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, occurred_at, created_by)
VALUES (BR, v_credit, WH, v_shift, 'size_small', 0,
        platform.business_day_start(D + 1) + interval '11 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_credit_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- سفارش سایت در فروشگاه پس داده شد؛ بازپرداخت به همان کارت.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_web, WH, v_shift, 'size_small', 1000000, 'card',
        platform.business_day_start(D + 1) + interval '12 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_web_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

SELECT * INTO s FROM sales.dashboard_period(BR, D + 1, D + 1) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('D+1 صندوق: دو مرجوعی', s.return_count, 2);
PERFORM pg_temp.assert_eq('D+1 صندوق: ارزش برگشتی ۲٬۰۰۰٬۰۰۰', s.return_amount, 2000000);
PERFORM pg_temp.assert_eq('D+1 صندوق: فاکتوری ندارد، میانگین تهی (−۱ نشانهٔ NULL)', coalesce(s.average_invoice, -1), -1);
SELECT * INTO s FROM sales.dashboard_period(BR, D + 1, D + 1) WHERE channel = 'web';
PERFORM pg_temp.assert_eq('D+1 سایت: مرجوعیِ در فروشگاه از «سایت» کم می‌شود', s.return_amount, 1000000);
PERFORM pg_temp.assert_eq('D+1 سایت: فروش خالص منفی', s.sales_amount, -1000000);

SELECT sum(return_amount) INTO n FROM sales.dashboard_period(BR, D + 1, D + 1);
PERFORM pg_temp.assert_eq('D+1 ارزش کالای برگشتی (سه مرجوعی)', n, 3000000);
SELECT sum(refunded_amount) INTO n FROM sales.dashboard_payment_mix(BR, D + 1, D + 1);
PERFORM pg_temp.assert_eq('D+1 پول برگشتی (دو بازپرداخت) — مرجوعی ≠ بازپرداخت', n, 2000000);
SELECT sum(refund_count) INTO n FROM sales.dashboard_payment_mix(BR, D + 1, D + 1);
PERFORM pg_temp.assert_eq('D+1 دو بازپرداخت، نه سه', n, 2);
PERFORM pg_temp.assert_reconciles('روز D+1', BR, D + 1, D + 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. بازهٔ دوروزه ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO s FROM sales.dashboard_period(BR, D, D + 1) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('D..D+1 صندوق: فروش خالص ۳ − ۲', s.sales_amount, 1000000);
PERFORM pg_temp.assert_eq('D..D+1 صندوق: سود (۳−۲) − (۱٫۲−۰٫۸)', s.profit_amount, 600000);
PERFORM pg_temp.assert_eq('D..D+1 صندوق: میانگین از فاکتورها، نه از خالص پس از مرجوعی', s.average_invoice, 1500000);
SELECT * INTO s FROM sales.dashboard_period(BR, D, D + 1) WHERE channel = 'web';
PERFORM pg_temp.assert_eq('D..D+1 سایت: فروش خالص ۲٫۹ − ۱', s.sales_amount, 1900000);
PERFORM pg_temp.assert_eq('D..D+1 سایت: سود (۲٫۹−۱) − (۲−۰٫۴)', s.profit_amount, 300000);

SELECT * INTO s FROM sales.dashboard_payment_mix(BR, D, D + 1) WHERE method_code = 'cash';
PERFORM pg_temp.assert_eq('نقد: ورودی', s.received_amount, 2000000);
PERFORM pg_temp.assert_eq('نقد: بازپرداخت', s.refunded_amount, 1000000);
PERFORM pg_temp.assert_eq('نقد: خالص', s.net_amount, 1000000);
SELECT * INTO s FROM sales.dashboard_payment_mix(BR, D, D + 1) WHERE method_code = 'card';
PERFORM pg_temp.assert_eq('کارت: ورودی دو پرداخت', s.received_amount, 2000000);
PERFORM pg_temp.assert_eq('کارت: شمار ورودی', s.payment_count, 2);
PERFORM pg_temp.assert_eq('کارت: بازپرداخت', s.refunded_amount, 1000000);
-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. شعبهٔ دوم و «همهٔ شعبه‌ها» ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO platform.branch (code, name) VALUES ('DPD-B2','شعبهٔ دوم آزمون داشبورد') RETURNING id INTO v_br2;
INSERT INTO inventory.warehouse (branch_id, code, name, kind)
VALUES (v_br2,'DPD-B2-STORE','قفسهٔ شعبهٔ دوم','store') RETURNING id INTO v_wh2;
INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
SELECT v_br2, doc_type, fiscal_year, prefix FROM platform.document_counter WHERE branch_id = BR;
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(v_br2,'purchase',1405::smallint), v_br2, v_sup, v_wh2,
        platform.business_day_start(D) + interval '6 minutes')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_a, 10, 400000, 4000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);
INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (v_br2, v_user, 0, platform.business_day_start(D) + interval '10 minutes') RETURNING id INTO v_shift2;
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (v_br2, v_wh2, v_shift2, platform.business_day_start(D) + interval '12 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift2, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(D) + interval '12 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT sum(gross_amount) INTO n FROM sales.dashboard_period(BR, D, D + 1);
PERFORM pg_temp.assert_eq('شعبهٔ اصلی فروش شعبهٔ دوم را نمی‌بیند', n, 5900000);
SELECT * INTO s FROM sales.dashboard_period(v_br2, D, D + 1) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('شعبهٔ دوم: یک فاکتور', s.invoice_count, 1);
SELECT * INTO s FROM sales.dashboard_period(NULL, D, D + 1) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('همه: صندوق ۳ + ۱ ناخالص', s.gross_amount, 4000000);
PERFORM pg_temp.assert_eq('همه: میانگین صندوق ۴٬۰۰۰٬۰۰۰÷۳ گرد (۱٬۳۳۳٬۳۳۳٫۳۳ → ۱٬۳۳۳٬۳۳۳)', s.average_invoice, 1333333);
SELECT * INTO s FROM sales.dashboard_payment_mix(NULL, D, D + 1) WHERE method_code = 'cash';
PERFORM pg_temp.assert_eq('همه: نقد ورودی ۲ + ۱', s.received_amount, 3000000);
SELECT * INTO s FROM sales.dashboard_payment_mix(v_br2, D, D + 1) WHERE method_code = 'cash';
PERFORM pg_temp.assert_eq('شعبهٔ دوم: نقد خودش', s.received_amount, 1000000);
PERFORM pg_temp.assert_reconciles('شعبهٔ اصلی، دو روز', BR, D, D + 1);
PERFORM pg_temp.assert_reconciles('شعبهٔ دوم', v_br2, D, D + 1);
PERFORM pg_temp.assert_reconciles('همهٔ شعبه‌ها', NULL, D, D + 1);
PERFORM pg_temp.assert_reconciles('بازهٔ بلند', NULL, D - 200, D + 165);
PERFORM pg_temp.assert_reconciles('شعبهٔ ناموجود', gen_random_uuid(), D - 1, D + 2);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. کنترل حساسیت: آشتی نابرابری را می‌بیند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- آشتی‌ای که هیچ‌وقت شکست نخورد چیزی ثابت نمی‌کند: همان سنجش با روزِ
-- جابه‌جا و با شعبهٔ دیگر باید نابرابر باشد.
IF (SELECT sum(sales_amount) FROM sales.dashboard_period(BR, D, D))
   = (SELECT sales_amount FROM sales.daily_summary(BR, D + 1)) THEN
  RAISE EXCEPTION 'کنترل حساسیت شکست: روز D و D+1 یک فروش دارند';
END IF;
RAISE NOTICE '  ✓ روز D (≠) روز D+1';
IF (SELECT sum(gross_amount) FROM sales.dashboard_period(NULL, D, D))
   = (SELECT sum(gross_amount) FROM sales.dashboard_period(BR, D, D)) THEN
  RAISE EXCEPTION 'کنترل حساسیت شکست: «همه» با یک شعبه برابر است';
END IF;
RAISE NOTICE '  ✓ «همه» (≠) یک شعبه';
IF (SELECT sum(return_amount) FROM sales.dashboard_period(BR, D + 1, D + 1))
   = (SELECT sum(refunded_amount) FROM sales.dashboard_payment_mix(BR, D + 1, D + 1)) THEN
  RAISE EXCEPTION 'کنترل حساسیت شکست: مرجوعی و بازپرداخت یکی شدند';
END IF;
RAISE NOTICE '  ✓ مرجوعی (≠) بازپرداخت';
-- و فاکتور ۰۱:۱۰ واقعاً مرز UTC را می‌آزماید.
IF NOT (platform.business_day_start(D) + interval '1 hour 10 minutes' < (D::timestamp AT TIME ZONE 'UTC')) THEN
  RAISE EXCEPTION 'کنترل حساسیت شکست: فاکتور بامداد تهران مرز UTC را نمی‌آزماید';
END IF;
SELECT gross_amount INTO n FROM sales.dashboard_period(BR, D - 1, D - 1) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('D−1 خالی: فاکتور بامداد تهران مال D است', n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. ورودی نامعتبر: پیام فارسی با P0001 ═══';
-- ═══════════════════════════════════════════════════════════════════

BEGIN
  PERFORM * FROM sales.dashboard_period(BR, D, D - 1);
  RAISE EXCEPTION 'بازهٔ معکوس پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  IF msg NOT LIKE 'تاریخ پایان%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ بازهٔ معکوس رد شد: %', msg;
END;
BEGIN
  PERFORM * FROM sales.dashboard_payment_mix(BR, D - 400, D);
  RAISE EXCEPTION 'بازهٔ ۴۰۱ روزه پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  IF msg NOT LIKE 'بازهٔ خلاصهٔ دوره حداکثر%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ بازهٔ ۴۰۱ روزه رد شد: %', msg;
END;
SELECT count(*) INTO n FROM sales.dashboard_period(BR, D - 399, D);
PERFORM pg_temp.assert_eq('بازهٔ ۴۰۰ روزه مجاز است (دو سطر کانال)', n, 2);
BEGIN
  PERFORM * FROM sales.dashboard_period(BR, NULL, D);
  RAISE EXCEPTION 'تاریخ تهی پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  IF msg NOT LIKE 'بازهٔ تاریخ%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ تاریخ تهی رد شد: %', msg;
END;

RAISE NOTICE E'\n✔ خلاصهٔ دوره‌ای داشبورد — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
