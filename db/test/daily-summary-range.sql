-- =====================================================================
-- خلاصه روز برای یک بازه (مهاجرت ۰۹۳) — ثابت آشتی با خلاصه روز
-- =====================================================================
-- ادعای مرکزی: هر سطر `sales.daily_summary_range` ستون‌به‌ستون **دقیقاً**
-- برابر `sales.daily_summary` همان (شعبه، روز) است — با برابری عدد صحیح.
-- روند روزانه و ماهانهٔ داشبورد جز جمع این سطرها چیزی نمی‌سازد.
--
-- روزها ثابت‌اند (۲۴ تا ۲۸ شهریور ۱۴۰۵)، نه «امروز». سناریو هر حالتی را دارد
-- که یک تعریفِ دوگانه یا مرز اشتباه را لو می‌دهد:
--
--   D      ۰۱:۱۰ بامداد تهران       شب قبل به وقت UTC — باید مال D باشد
--   D      فروش نقدی + نسیه + زیر بها
--   D+1    مرجوعیِ فروش D            از D+1 کم می‌شود، نه از D
--   D ۲۳:۵۰ فروش با پرداختِ ۰۰:۰۵ D+1  دریافتیِ D+1، فروشِ D
--   D+1    پرداخت در انتظار/ناموفق  شمرده نمی‌شود
--   D+2    پیش‌نویس                  شمرده نمی‌شود
--   D+2    ۲۳:۵۹                      همین روز؛ ۰۰:۰۰ D+3 نه
--   شعبهٔ دیگر                       هیچ‌چیز این شعبه را نمی‌بیند
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

-- هر روزِ بازه در برابر خلاصه روز، ستون‌به‌ستون؛ و یک سطر برای هر روز، مرتب.
CREATE OR REPLACE FUNCTION pg_temp.assert_reconciles(p_label text, p_branch uuid, p_from date, p_to date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d RECORD; r RECORD; expect date := p_from; n int := 0;
BEGIN
  FOR r IN SELECT * FROM sales.daily_summary_range(p_branch, p_from, p_to) LOOP
    IF r.business_date IS DISTINCT FROM expect THEN
      RAISE EXCEPTION '  ✗ %: روز % به‌جای % آمد (پشت‌هم و صعودی نیست)', p_label, r.business_date, expect;
    END IF;
    SELECT * INTO d FROM sales.daily_summary(p_branch, r.business_date);
    IF (r.sales_amount, r.received_amount, r.profit_amount, r.invoice_count, r.return_count)
       IS DISTINCT FROM (d.sales_amount, d.received_amount, d.profit_amount, d.invoice_count, d.return_count) THEN
      RAISE EXCEPTION E'\n  ✗ %: روز % با خلاصه روز نمی‌خواند\n      بازه: %\n      روز : %', p_label, r.business_date, r, d;
    END IF;
    expect := expect + 1; n := n + 1;
  END LOOP;
  PERFORM pg_temp.assert_eq(p_label || ': یک سطر برای هر روز', n, p_to - p_from + 1);
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  D    date := '2026-09-15';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_b uuid; v_cust uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line1 uuid; v_inv1 uuid; v_inv2 uuid; v_inv4 uuid; v_ret uuid;
  s RECORD; n numeric; msg text;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('dsr','تست خلاصه بازه')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DSR','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DSR','کالای تست')
  RETURNING id INTO v_prod;
-- A: قیمت ۱٬۰۰۰٬۰۰۰، بها ۴۰۰٬۰۰۰. B: قیمت ۳۰۰٬۰۰۰ زیر بهای ۴۰۰٬۰۰۰.
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','DSR-A') RETURNING id INTO v_a;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','DSR-B') RETURNING id INTO v_b;
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
INSERT INTO sales.customer (full_name, credit_limit) VALUES ('range credit fixture', 5000000)
  RETURNING id INTO v_cust;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. بازهٔ خالی: یک سطرِ صفر برای هر روز ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_reconciles('بازهٔ خالی', BR, D - 10, D - 1);
SELECT count(*) INTO n FROM sales.daily_summary_range(BR, D - 10, D - 1)
 WHERE sales_amount <> 0 OR received_amount <> 0 OR profit_amount <> 0 OR invoice_count <> 0 OR payment_count <> 0;
PERFORM pg_temp.assert_eq('بازهٔ خالی: هیچ روزی غیرصفر نیست', n, 0);
SELECT count(*) INTO n FROM sales.daily_summary_range(BR, D, D);
PERFORM pg_temp.assert_eq('بازهٔ یک‌روزه: یک سطر', n, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. روز D: بامداد تهران، نقدی، نسیه، زیر بها ═══';
-- ═══════════════════════════════════════════════════════════════════

-- ۰۱:۱۰ بامداد تهران — به وقت UTC هنوز روز قبل است. مرزی که از
-- `D::timestamptz` (منطقهٔ سرور) بیاید این فاکتور را از D می‌انداخت.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '1 hour 10 minutes', v_user) RETURNING id INTO v_inv1;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv1, 1, v_a, 2, 1000000, 2000000) RETURNING id INTO v_line1;
PERFORM sales.refresh_invoice_totals(v_inv1);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv1, v_shift, 'cash', 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '1 hour 11 minutes');
PERFORM sales.finalize_invoice(v_inv1, v_user);

-- نسیه — یک A: فروش D بی دریافتی در D.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by, customer_id)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '11 hours', v_user, v_cust) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv2);
-- پرداخت در انتظار و ناموفق (در روز D+1) پول نیستند.
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv2, v_shift, 'cash', 'in', 400000, 'pending', platform.business_day_start(D + 1) + interval '13 hours'),
       (v_inv2, v_shift, 'cash', 'in', 300000, 'failed',  platform.business_day_start(D + 1) + interval '13 hours 5 minutes');
PERFORM sales.finalize_invoice(v_inv2, v_user);

-- سه B زیر بها: فروش ۹۰۰٬۰۰۰، بها ۱٬۲۰۰٬۰۰۰.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '14 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_b, 3, 300000, 900000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 900000, 'succeeded', platform.business_day_start(D) + interval '14 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ۲۳:۵۰ D فروش، پولش ۰۰:۰۵ D+1 رسید: فروشِ D، دریافتیِ D+1.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '23 hours 50 minutes', v_user) RETURNING id INTO v_inv4;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv4, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv4);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv4, v_shift, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(D + 1) + interval '5 minutes');
PERFORM sales.finalize_invoice(v_inv4, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. روز D+1: مرجوعیِ فروش D ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv1, WH, v_shift, 'size_small', 1000000, 'cash',
        platform.business_day_start(D + 1) + interval '10 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line1, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. روز D+2: پیش‌نویس، ۲۳:۵۹، و ۰۰:۰۰ D+3 ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D + 2) + interval '9 hours', v_user);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D + 2) + interval '23 hours 59 minutes', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(D + 2) + interval '23 hours 59 minutes');
PERFORM sales.finalize_invoice(v_inv, v_user);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D + 3), v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(D + 3));
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. روز‌به‌روز، با عدد صریح ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO s FROM sales.daily_summary_range(BR, D - 1, D + 3) WHERE business_date = D - 1;
PERFORM pg_temp.assert_eq('D−1 خالی: فاکتور بامداد تهران مال D است', s.sales_amount, 0);

SELECT * INTO s FROM sales.daily_summary_range(BR, D - 1, D + 3) WHERE business_date = D;
PERFORM pg_temp.assert_eq('D فروش (۲ + ۱ نسیه + ۰٫۹ زیر بها + ۱ در ۲۳:۵۰)', s.sales_amount, 4900000);
PERFORM pg_temp.assert_eq('D دریافتی (نسیه و پرداختِ فردا نه)', s.received_amount, 2900000);
PERFORM pg_temp.assert_eq('D سود (۱٫۲ + ۰٫۶ − ۰٫۳ + ۰٫۶)', s.profit_amount, 2100000);
PERFORM pg_temp.assert_eq('D چهار فاکتور', s.invoice_count, 4);
PERFORM pg_temp.assert_eq('D دو پرداخت', s.payment_count, 2);

SELECT * INTO s FROM sales.daily_summary_range(BR, D - 1, D + 3) WHERE business_date = D + 1;
PERFORM pg_temp.assert_eq('D+1 مرجوعی: فروش منفی', s.sales_amount, -1000000);
PERFORM pg_temp.assert_eq('D+1 دریافتی: پرداخت ۰۰:۰۵ منهای بازپرداخت — صفر با دو رویداد', s.received_amount, 0);
PERFORM pg_temp.assert_eq('D+1 سود منفیِ مرجوعی', s.profit_amount, -600000);
PERFORM pg_temp.assert_eq('D+1 یک مرجوعی', s.return_count, 1);
PERFORM pg_temp.assert_eq('D+1 فاکتوری ندارد', s.invoice_count, 0);
PERFORM pg_temp.assert_eq('D+1 دو پرداخت موفق (در انتظار/ناموفق نه)', s.payment_count, 2);

SELECT * INTO s FROM sales.daily_summary_range(BR, D - 1, D + 3) WHERE business_date = D + 2;
PERFORM pg_temp.assert_eq('D+2 فقط ۲۳:۵۹ (پیش‌نویس نه)', s.sales_amount, 1000000);
PERFORM pg_temp.assert_eq('D+2 یک فاکتور', s.invoice_count, 1);

SELECT * INTO s FROM sales.daily_summary_range(BR, D - 1, D + 3) WHERE business_date = D + 3;
PERFORM pg_temp.assert_eq('۰۰:۰۰ D+3 مال D+3 است', s.sales_amount, 1000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. آشتی روز‌به‌روز با خلاصه روز ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_reconciles('بازهٔ کامل', BR, D - 3, D + 5);
-- بازه‌ای که از وسط شروع شود، روزهای بیرونش را نمی‌شمارد.
PERFORM pg_temp.assert_reconciles('بازهٔ میانی', BR, D + 1, D + 2);
SELECT sum(sales_amount) INTO n FROM sales.daily_summary_range(BR, D + 1, D + 2);
PERFORM pg_temp.assert_eq('جمع بازهٔ میانی فقط D+1 و D+2', n, -1000000 + 1000000);
-- بازهٔ طولانی (یک سال جلالی) هم همان است.
PERFORM pg_temp.assert_reconciles('یک سال', BR, D - 200, D + 165);
PERFORM pg_temp.assert_reconciles('شعبهٔ دیگر', gen_random_uuid(), D - 1, D + 3);
SELECT sum(sales_amount) + sum(received_amount) + sum(invoice_count) + sum(payment_count) INTO n
  FROM sales.daily_summary_range(gen_random_uuid(), D - 1, D + 3);
PERFORM pg_temp.assert_eq('شعبهٔ دیگر خالی', n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. کنترل حساسیت: آشتی واقعاً نابرابری را می‌بیند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- همان آزمون آشتی با روزِ جابه‌جا باید شکست بخورد؛ وگرنه «برابر بود» چیزی
-- ثابت نمی‌کرد.
-- و فاکتور ۰۱:۱۰ واقعاً همان مرز را می‌آزماید: به وقت UTC پیش از نیمه‌شبِ D است،
-- پس بازه‌ای با مرز `D::timestamptz` روی سرور UTC آن را از D می‌انداخت.
IF NOT (platform.business_day_start(D) + interval '1 hour 10 minutes' < (D::timestamp AT TIME ZONE 'UTC')) THEN
  RAISE EXCEPTION 'کنترل حساسیت شکست: فاکتور بامداد تهران مرز UTC را نمی‌آزماید';
END IF;
RAISE NOTICE '  ✓ فاکتور ۰۱:۱۰ تهران پیش از نیمه‌شب UTC روز D است — مرز آزموده می‌شود';
BEGIN
  IF (SELECT sales_amount FROM sales.daily_summary_range(BR, D, D))
     = (SELECT sales_amount FROM sales.daily_summary(BR, D + 1)) THEN
    RAISE EXCEPTION 'کنترل حساسیت شکست: روز D و D+1 یک فروش دارند';
  END IF;
  RAISE NOTICE '  ✓ روز D (≠) روز D+1 — مقایسه نابرابری را می‌بیند';
END;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. ورودی نامعتبر: پیام فارسی با P0001 ═══';
-- ═══════════════════════════════════════════════════════════════════

BEGIN
  PERFORM * FROM sales.daily_summary_range(BR, D, D - 1);
  RAISE EXCEPTION 'بازهٔ معکوس پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  IF msg NOT LIKE 'تاریخ پایان%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ بازهٔ معکوس رد شد: %', msg;
END;
BEGIN
  PERFORM * FROM sales.daily_summary_range(BR, D - 400, D);
  RAISE EXCEPTION 'بازهٔ ۴۰۱ روزه پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  IF msg NOT LIKE 'بازهٔ خلاصه روز حداکثر%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ بازهٔ ۴۰۱ روزه رد شد: %', msg;
END;
SELECT count(*) INTO n FROM sales.daily_summary_range(BR, D - 399, D);
PERFORM pg_temp.assert_eq('بازهٔ ۴۰۰ روزه مجاز است', n, 400);
BEGIN
  PERFORM * FROM sales.daily_summary_range(NULL, D, D);
  RAISE EXCEPTION 'شعبهٔ تهی پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  IF msg NOT LIKE 'شعبه و بازه%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ شعبهٔ تهی رد شد: %', msg;
END;

RAISE NOTICE E'\n✔ خلاصه روز بازه‌ای — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
