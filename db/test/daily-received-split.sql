-- =====================================================================
-- «وجه دریافتی» به تفکیک فاکتور همان روز و روزهای قبل (مهاجرت ۱۱۳)
-- =====================================================================
-- ادعای مرکزی: همان روز + روزهای قبل = `sales.daily_summary.received_amount`
-- با برابری عدد صحیح؛ تفکیک فقط بخش می‌کند، چیزی اضافه یا کم نمی‌کند.
--
-- روز D:
--   فروش نقدی همان روز                      +۲٬۰۰۰٬۰۰۰  همان روز
--   پرداخت دیرهنگام سفارشی که D−1 ثبت شده    +۷۰۰٬۰۰۰  روزهای قبل
--   بازپرداخت نقدی مرجوعیِ فاکتور D−1      −۱٬۰۰۰٬۰۰۰  روزهای قبل (فروش ناشناس: بازپرداخت کامل)
--   پرداخت D−1                               نه — روز دیگر
--   پرداخت در انتظار                          نه — پول نیست
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
  D       date := '2026-09-20';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_rcpt uuid; v_shift uuid; v_cust uuid;
  v_inv uuid; v_old uuid; v_old_line uuid; v_late uuid; v_ret uuid;
  s RECORD; sm RECORD;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('drs','تست تفکیک دریافتی') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DRS','تأمین‌کننده') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DRS','کالای تست') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'مشکی','M','DRS-A') RETURNING id INTO v_a;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',1000000);
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, platform.business_day_start(D - 1) + interval '8 hours')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount) VALUES (v_rcpt, v_a, 30, 400000, 12000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);
INSERT INTO sales.customer (full_name, credit_limit) VALUES ('مشتری آزمون تفکیک', 10000000) RETURNING id INTO v_cust;

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, platform.business_day_start(D - 1) + interval '8 hours 30 minutes') RETURNING id INTO v_shift;

-- D−1: فاکتور نقدی ۱٬۰۰۰٬۰۰۰ (پرداخت همان D−1)، بعداً مرجوعی در D.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D - 1) + interval '10 hours', v_user) RETURNING id INTO v_old;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_old, 1, v_a, 1, 1000000, 1000000)
RETURNING id INTO v_old_line;
PERFORM sales.refresh_invoice_totals(v_old);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_old, v_shift, 'cash', CASHBOX, 'in', 1000000, 'succeeded', platform.business_day_start(D - 1) + interval '10 hours 1 minute');
PERFORM sales.finalize_invoice(v_old, v_user);

-- D−1: سفارش ۷۰۰٬۰۰۰ که پولش D رسید (پرداخت روی پیش‌نویس، بعد نهایی).
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, v_cust, platform.business_day_start(D - 1) + interval '20 hours', v_user) RETURNING id INTO v_late;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_late, 1, v_a, 1, 700000, 700000);
PERFORM sales.refresh_invoice_totals(v_late);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_late, v_shift, 'cash', CASHBOX, 'in', 700000, 'succeeded', platform.business_day_start(D) + interval '9 hours');
PERFORM sales.finalize_invoice(v_late, v_user);

-- D: فروش نقدی ۲٬۰۰۰٬۰۰۰ و یک پرداخت در انتظار.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, v_cust, platform.business_day_start(D) + interval '11 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_inv, 1, v_a, 3, 1000000, 3000000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', CASHBOX, 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '11 hours 1 minute');
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 300000, 'pending', platform.business_day_start(D) + interval '11 hours 2 minutes');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- D: مرجوعیِ فاکتور D−1 با بازپرداخت نقدی کامل ۱٬۰۰۰٬۰۰۰.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_old, WH, v_shift, 'size_small', 1000000, 'cash', platform.business_day_start(D) + interval '15 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_old_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. تفکیک روز D ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT * INTO s FROM sales.daily_received_split(BR, D);
SELECT * INTO sm FROM sales.daily_summary(BR, D);
PERFORM pg_temp.assert_eq('دریافتی کل = خلاصهٔ روز', s.received_amount, sm.received_amount);
PERFORM pg_temp.assert_eq('همان روز + روزهای قبل = دریافتی', s.same_day_amount + s.earlier_amount, sm.received_amount);
PERFORM pg_temp.assert_eq('بابت فاکتور همان روز', s.same_day_amount, 2000000);
PERFORM pg_temp.assert_eq('بابت روزهای قبل: پرداخت دیرهنگام منهای بازپرداخت', s.earlier_amount, -300000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. روز D−1 و روز خالی ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT * INTO s FROM sales.daily_received_split(BR, D - 1);
SELECT * INTO sm FROM sales.daily_summary(BR, D - 1);
PERFORM pg_temp.assert_eq('D−1: همه بابت همان روز', s.same_day_amount, sm.received_amount);
PERFORM pg_temp.assert_eq('D−1: بابت قبل صفر', s.earlier_amount, 0);
SELECT * INTO s FROM sales.daily_received_split(BR, D + 5);
PERFORM pg_temp.assert_eq('روز خالی: صفر، نه NULL', s.received_amount + s.same_day_amount + s.earlier_amount, 0);

END $test$;

ROLLBACK;
