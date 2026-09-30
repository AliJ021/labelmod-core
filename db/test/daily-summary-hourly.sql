-- =====================================================================
-- خلاصه روز به تفکیک ساعت (مهاجرت ۰۸۳) — ثابت آشتی با خلاصه روز
-- =====================================================================
-- ادعای مرکزی: برای همان (شعبه، روز)، جمع ساعت‌ها **دقیقاً** برابر
-- `sales.daily_summary` است — فروش، وجه دریافتی، سود و شمارش‌ها، با
-- برابری عدد صحیح و بی هیچ تلورانس.
--
-- روز ثابت است (۲۵ شهریور ۱۴۰۵) نه «امروز»: ساعت‌ها صریح‌اند و آزمون به
-- ساعت اجرای CI وابسته نیست. سناریو هر حالتی را دارد که یک تعریفِ
-- دوگانه را لو می‌دهد:
--
--   ساعت  ۹  فروش نقدی                 سود مثبت
--   ساعت ۱۱  فروش نسیه                 فروش بی دریافتی
--   ساعت ۱۴  فروش زیر بها              سود منفی
--   ساعت ۱۶  مرجوعی فروشِ ساعت ۹       فروش، دریافتی و سودِ منفی در ساعتی دیگر
--   ساعت ۱۷  پرداخت در انتظار/ناموفق  نباید شمرده شود
--   ساعت ۱۸  پیش‌نویس                  نباید شمرده شود
--   ساعت ۲۳  آخرین دقیقهٔ روز          همین روز
--   فردا ۰۰:۰۰ مرز روز                 نه این روز
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

-- جمع ساعت‌ها در برابر خلاصه روز، ستون‌به‌ستون.
CREATE OR REPLACE FUNCTION pg_temp.assert_reconciles(p_label text, p_branch uuid, p_day date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d RECORD; h RECORD;
BEGIN
  SELECT * INTO d FROM sales.daily_summary(p_branch, p_day);
  SELECT count(*) AS rows, sum(sales_amount) AS sales, sum(received_amount) AS received,
         sum(profit_amount) AS profit, sum(invoice_count) AS invoices, sum(return_count) AS returns
    INTO h FROM sales.daily_summary_hourly(p_branch, p_day);
  PERFORM pg_temp.assert_eq(p_label || ': ۲۴ ساعت', h.rows, 24);
  PERFORM pg_temp.assert_eq(p_label || ': Σ فروش ساعتی = فروش روز', h.sales, d.sales_amount);
  PERFORM pg_temp.assert_eq(p_label || ': Σ دریافتی ساعتی = دریافتی روز', h.received, d.received_amount);
  PERFORM pg_temp.assert_eq(p_label || ': Σ سود ساعتی = سود روز', h.profit, d.profit_amount);
  PERFORM pg_temp.assert_eq(p_label || ': Σ فاکتور ساعتی = فاکتور روز', h.invoices, d.invoice_count);
  PERFORM pg_temp.assert_eq(p_label || ': Σ مرجوعی ساعتی = مرجوعی روز', h.returns, d.return_count);
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  D    date := '2026-09-16';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_b uuid;
  v_rcpt uuid; v_shift uuid; v_inv1 uuid; v_inv2 uuid; v_inv3 uuid; v_inv4 uuid; v_inv5 uuid;
  v_line1 uuid; v_ret uuid;
  s RECORD; n int; prev int;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('dsh','تست خلاصه ساعتی')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DSH','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DSH','کالای تست')
  RETURNING id INTO v_prod;
-- ساعت‌ها از `business_day_start(D)` ساخته می‌شوند: وقت کاری، نه وقت سرور.
-- A: قیمت ۱٬۰۰۰٬۰۰۰، بها ۴۰۰٬۰۰۰. B: قیمت ۳۰۰٬۰۰۰ زیر بهای ۴۰۰٬۰۰۰ (سود منفی).
-- یک نرخ خرید برای هر کالا، پس بها به `costing.method` وابسته نیست.
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','DSH-A') RETURNING id INTO v_a;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','DSH-B') RETURNING id INTO v_b;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',1000000), (v_b,'default',300000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH,
        platform.business_day_start(D) + interval '8 hours')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_a, 100, 400000, 40000000), (v_rcpt, v_b, 10, 400000, 4000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, platform.business_day_start(D) + interval '8 hours 30 minutes') RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. روز خالی: ۲۴ ساعتِ صفر، مرتب ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_reconciles('روز خالی', BR, D - 1);
SELECT count(*) INTO n FROM sales.daily_summary_hourly(BR, D - 1)
 WHERE sales_amount <> 0 OR received_amount <> 0 OR profit_amount <> 0 OR invoice_count <> 0 OR payment_count <> 0;
PERFORM pg_temp.assert_eq('روز خالی: هیچ ساعتی غیرصفر نیست', n, 0);
prev := -1;
FOR s IN SELECT * FROM sales.daily_summary_hourly(BR, D - 1) LOOP
  PERFORM pg_temp.assert_eq('ساعت‌ها پشت‌هم و صعودی', s.hour_of_day, prev + 1);
  PERFORM pg_temp.assert_eq('تاریخ همان روز درخواستی', s.business_date - (D - 1), 0);
  prev := s.hour_of_day;
END LOOP;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. فروش‌ها در ساعت‌های مختلف ═══';
-- ═══════════════════════════════════════════════════════════════════

-- ۰۹:۱۵ نقدی — دو A: فروش ۲٬۰۰۰٬۰۰۰، بها ۸۰۰٬۰۰۰.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '9 hours 15 minutes', v_user) RETURNING id INTO v_inv1;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv1, 1, v_a, 2, 1000000, 2000000) RETURNING id INTO v_line1;
PERFORM sales.refresh_invoice_totals(v_inv1);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv1, v_shift, 'cash', 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '9 hours 16 minutes');
PERFORM sales.finalize_invoice(v_inv1, v_user);

-- ۱۱:۳۰ نسیه — یک A: فروش بی دریافتی.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '11 hours 30 minutes', v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv2);
WITH c AS (INSERT INTO sales.customer (full_name,credit_limit) VALUES ('hourly credit fixture',1000000) RETURNING id)
UPDATE sales.invoice SET customer_id=(SELECT id FROM c) WHERE id=v_inv2;
PERFORM sales.finalize_invoice(v_inv2, v_user);

-- ۱۴:۰۵ سه B زیر بها: فروش ۹۰۰٬۰۰۰، بها ۱٬۲۰۰٬۰۰۰ — سود −۳۰۰٬۰۰۰.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '14 hours 5 minutes', v_user) RETURNING id INTO v_inv3;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv3, 1, v_b, 3, 300000, 900000);
PERFORM sales.refresh_invoice_totals(v_inv3);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv3, v_shift, 'cash', 'in', 900000, 'succeeded', platform.business_day_start(D) + interval '14 hours 6 minutes');
PERFORM sales.finalize_invoice(v_inv3, v_user);

PERFORM pg_temp.assert_reconciles('پس از سه فروش', BR, D);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. مرجوعیِ فروش ساعت ۹، در ساعت ۱۶ ═══';
-- ═══════════════════════════════════════════════════════════════════
-- یک A برمی‌گردد و پولش نقد پس داده می‌شود. از ساعت ۱۶ کم می‌شود، نه ۹:
-- خلاصه روز هم آن را در روزِ خودش کم می‌کند.

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv1, WH, v_shift, 'size_small', 1000000, 'cash',
        platform.business_day_start(D) + interval '16 hours 40 minutes', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line1, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. آنچه نباید شمرده شود ═══';
-- ═══════════════════════════════════════════════════════════════════

-- پرداخت در انتظار و ناموفق روی فاکتور نسیه — پول نیستند.
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv2, v_shift, 'cash', 'in', 400000, 'pending', platform.business_day_start(D) + interval '17 hours'),
       (v_inv2, v_shift, 'cash', 'in', 300000, 'failed',  platform.business_day_start(D) + interval '17 hours 5 minutes');

-- پیش‌نویس فروش نیست.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '18 hours', v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. مرز روز: ۲۳:۵۹ همین روز، ۰۰:۰۰ فردا نه ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '23 hours 59 minutes', v_user) RETURNING id INTO v_inv4;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv4, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv4);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv4, v_shift, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(D) + interval '23 hours 59 minutes');
PERFORM sales.finalize_invoice(v_inv4, v_user);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D + 1), v_user) RETURNING id INTO v_inv5;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv5, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv5);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv5, v_shift, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(D + 1));
PERFORM sales.finalize_invoice(v_inv5, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. ساعت‌به‌ساعت، با عدد صریح ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 9;
PERFORM pg_temp.assert_eq('۰۹ فروش', s.sales_amount, 2000000);
PERFORM pg_temp.assert_eq('۰۹ دریافتی', s.received_amount, 2000000);
PERFORM pg_temp.assert_eq('۰۹ سود', s.profit_amount, 1200000);
PERFORM pg_temp.assert_eq('۰۹ فاکتور', s.invoice_count, 1);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 11;
PERFORM pg_temp.assert_eq('۱۱ فروش نسیه', s.sales_amount, 1000000);
PERFORM pg_temp.assert_eq('۱۱ دریافتی صفر است، نه فروش', s.received_amount, 0);
PERFORM pg_temp.assert_eq('۱۱ سود', s.profit_amount, 600000);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 14;
PERFORM pg_temp.assert_eq('۱۴ فروش زیر بها', s.sales_amount, 900000);
PERFORM pg_temp.assert_eq('۱۴ دریافتی', s.received_amount, 900000);
PERFORM pg_temp.assert_eq('۱۴ سود منفی می‌ماند', s.profit_amount, -300000);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 16;
PERFORM pg_temp.assert_eq('۱۶ مرجوعی: فروش منفی', s.sales_amount, -1000000);
PERFORM pg_temp.assert_eq('۱۶ بازپرداخت: دریافتی منفی', s.received_amount, -1000000);
PERFORM pg_temp.assert_eq('۱۶ سود منفیِ مرجوعی (−فروش + بها)', s.profit_amount, -600000);
PERFORM pg_temp.assert_eq('۱۶ یک مرجوعی', s.return_count, 1);
PERFORM pg_temp.assert_eq('۱۶ یک پرداخت خروجی', s.payment_count, 1);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 9;
PERFORM pg_temp.assert_eq('۰۹ دست‌نخورده پس از مرجوعی — مرجوعی مال ساعت ۱۶ است', s.sales_amount, 2000000);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 17;
PERFORM pg_temp.assert_eq('۱۷ پرداخت در انتظار/ناموفق شمرده نمی‌شود', s.received_amount, 0);
PERFORM pg_temp.assert_eq('۱۷ و پرداختی هم شمرده نمی‌شود', s.payment_count, 0);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 18;
PERFORM pg_temp.assert_eq('۱۸ پیش‌نویس فروش نیست', s.invoice_count, 0);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 23;
PERFORM pg_temp.assert_eq('۲۳:۵۹ همین روز است', s.sales_amount, 1000000);

SELECT * INTO s FROM sales.daily_summary_hourly(BR, D) WHERE hour_of_day = 0;
PERFORM pg_temp.assert_eq('۰۰:۰۰ فردا در ساعت ۰ این روز نیست', s.sales_amount, 0);
SELECT * INTO s FROM sales.daily_summary_hourly(BR, D + 1) WHERE hour_of_day = 0;
PERFORM pg_temp.assert_eq('۰۰:۰۰ فردا در ساعت ۰ فرداست', s.sales_amount, 1000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. آشتی نهایی با خلاصه روز ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO s FROM sales.daily_summary(BR, D);
PERFORM pg_temp.assert_eq('فروش روز (کنترل مستقل)', s.sales_amount, 2000000 + 1000000 + 900000 - 1000000 + 1000000);
PERFORM pg_temp.assert_eq('دریافتی روز (کنترل مستقل)', s.received_amount, 2000000 + 900000 - 1000000 + 1000000);
PERFORM pg_temp.assert_eq('سود روز (کنترل مستقل)', s.profit_amount, 1200000 + 600000 - 300000 - 600000 + 600000);
PERFORM pg_temp.assert_reconciles('روز کامل', BR, D);
PERFORM pg_temp.assert_reconciles('فردا', BR, D + 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. کنترل حساسیت: `report_hourly` قدیمی آشتی نمی‌داد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- همان روز با تابع روند قبلی داشبورد: مرجوعی کم نمی‌شود، پس جمعش
-- ۱٬۰۰۰٬۰۰۰ بیشتر از کارت «فروش» است. آزمونِ برابری‌ای که این نابرابری را
-- نبیند، سبزِ بی‌معناست — و این دقیقاً شکافی است که ۰۸۳ برای بستنش آمد.
SELECT sum(net_amount) INTO n FROM sales.report_hourly(D, D, BR);
PERFORM pg_temp.assert_eq('report_hourly: فروش ناخالص، بی مرجوعی', n, 4900000);
SELECT sales_amount INTO s FROM sales.daily_summary(BR, D);
IF n = s.sales_amount THEN
  RAISE EXCEPTION 'کنترل حساسیت شکست: report_hourly و daily_summary برابر شدند';
END IF;
RAISE NOTICE '  ✓ report_hourly (%) ≠ فروش روز (%) — شکاف دیده می‌شود', n, s.sales_amount;

-- شعبهٔ دیگر هیچ‌چیز این شعبه را نمی‌بیند.
PERFORM pg_temp.assert_reconciles('شعبهٔ دیگر', gen_random_uuid(), D);
SELECT sum(sales_amount) + sum(received_amount) + sum(invoice_count) INTO n
  FROM sales.daily_summary_hourly(gen_random_uuid(), D);
PERFORM pg_temp.assert_eq('شعبهٔ دیگر خالی', n, 0);

RAISE NOTICE E'\n✔ خلاصه روز ساعتی — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
