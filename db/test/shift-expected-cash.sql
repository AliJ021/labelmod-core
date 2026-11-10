-- =====================================================================
-- «انتظار نقد» کشو (مهاجرت ۱۱۰) — همان عدد بستن شیفت
-- =====================================================================
-- ادعای مرکزی: `sales.shift_expected_cash(شیفت)` پیش از بستن همان عددی است
-- که `sales.close_shift` در `expected_cash` ثبت می‌کند — با برابری عدد صحیح.
-- صفحهٔ خزانه انتظار کشوی باز را از این تابع نشان می‌دهد؛ اگر با عدد پس از
-- شمارش فرق کند، مغایرتی که صندوق‌دار می‌بیند ساختگی است.
--
-- سناریو هر جزء فرمول را جدا می‌گذارد تا تغییر هر یک از دو تعریف قرمز شود:
--   موجودی اول                     ۵۰۰٬۰۰۰
--   فروش نقدی (succeeded)        ۲٬۰۰۰٬۰۰۰  +
--   فروش کارت‌خوان                ۱٬۰۰۰٬۰۰۰  نه — نقد نیست
--   فروش نسیه                     ۱٬۰۰۰٬۰۰۰  نه — دریافتی ندارد
--   پرداخت نقدی در انتظار/ناموفق   ۷۰۰٬۰۰۰  نه — پول نیست
--   بازپرداخت نقدی مرجوعی          ۱٬۰۰۰٬۰۰۰  −
--   آوردهٔ نقد به کشو (سرمایه)       ۳۰۰٬۰۰۰  +
--   هزینهٔ پیک از کشو                ۱۸۰٬۰۰۰  −
--   انتقال بانک به بانک               ۹۰۰٬۰۰۰  نه — کشو درگیر نیست
--   حرکت پیش‌نویس از کشو (شیفت دوم)  ۵۰٬۰۰۰  نه — ثبت نشده
--   انتظار = ۵۰۰٬۰۰۰ + ۲٬۰۰۰٬۰۰۰ − ۱٬۰۰۰٬۰۰۰ + ۳۰۰٬۰۰۰ − ۱۸۰٬۰۰۰ = ۱٬۶۲۰٬۰۰۰
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
  BANK    uuid := '00000000-0000-7000-8000-000000000202';
  POS     uuid := '00000000-0000-7000-8000-000000000203';
  D       date := '2026-09-16';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_rcpt uuid; v_shift uuid; v_other uuid;
  v_inv1 uuid; v_inv2 uuid; v_inv3 uuid; v_line1 uuid; v_ret uuid; v_tx uuid;
  v_live numeric; v_bank2 uuid;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('sec','تست انتظار نقد')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-SEC','تأمین‌کننده') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-SEC','کالای تست') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'مشکی','M','SEC-A') RETURNING id INTO v_a;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',1000000);
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, platform.business_day_start(D) + interval '8 hours')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_a, 20, 400000, 8000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 500000, platform.business_day_start(D) + interval '8 hours 30 minutes') RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. کشوی تازه: انتظار همان موجودی اول ═══';
-- ═══════════════════════════════════════════════════════════════════
PERFORM pg_temp.assert_eq('کشوی بی‌حرکت', sales.shift_expected_cash(v_shift), 500000);
PERFORM pg_temp.assert_eq('شیفت ناموجود: NULL، نه صفر',
  coalesce(sales.shift_expected_cash('00000000-0000-7000-8000-00000000dead'), -1), -1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. هر جزء فرمول، جدا ═══';
-- ═══════════════════════════════════════════════════════════════════

-- فروش نقدی دو A
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '9 hours', v_user) RETURNING id INTO v_inv1;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv1, 1, v_a, 2, 1000000, 2000000) RETURNING id INTO v_line1;
PERFORM sales.refresh_invoice_totals(v_inv1);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv1, v_shift, 'cash', CASHBOX, 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '9 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv1, v_user);
PERFORM pg_temp.assert_eq('پس از فروش نقدی', sales.shift_expected_cash(v_shift), 2500000);

-- فروش کارت‌خوان: نقد نیست
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '10 hours', v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv2);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, ref_no, occurred_at)
VALUES (v_inv2, v_shift, 'card', POS, 'in', 1000000, 'succeeded', 'SEC-1', platform.business_day_start(D) + interval '10 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv2, v_user);
PERFORM pg_temp.assert_eq('کارت‌خوان در کشو نیست', sales.shift_expected_cash(v_shift), 2500000);

-- پرداخت نقدی در انتظار و ناموفق روی فاکتور نسیه: پول نیستند
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '11 hours', v_user) RETURNING id INTO v_inv3;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv3, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv3);
WITH c AS (INSERT INTO sales.customer (full_name, credit_limit) VALUES ('مشتری نسیهٔ آزمون', 1000000) RETURNING id)
UPDATE sales.invoice SET customer_id = (SELECT id FROM c) WHERE id = v_inv3;
PERFORM sales.finalize_invoice(v_inv3, v_user);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv3, v_shift, 'cash', 'in', 400000, 'pending', platform.business_day_start(D) + interval '11 hours 1 minute'),
       (v_inv3, v_shift, 'cash', 'in', 300000, 'failed',  platform.business_day_start(D) + interval '11 hours 2 minutes');
PERFORM pg_temp.assert_eq('در انتظار و ناموفق شمرده نمی‌شوند', sales.shift_expected_cash(v_shift), 2500000);

-- مرجوعی یک A با بازپرداخت نقدی
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv1, WH, v_shift, 'size_small', 1000000, 'cash', platform.business_day_start(D) + interval '12 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line1, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);
PERFORM pg_temp.assert_eq('بازپرداخت نقدی کم می‌شود', sales.shift_expected_cash(v_shift), 1500000);

-- آوردهٔ نقد به کشو
INSERT INTO treasury.transaction (branch_id, purpose, to_account_id, amount, shift_id, occurred_at, note, created_by)
VALUES (BR, 'capital', CASHBOX, 300000, v_shift, platform.business_day_start(D) + interval '13 hours', 'پول خرد', v_user)
RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);
PERFORM pg_temp.assert_eq('ورود غیرفروشی اضافه می‌شود', sales.shift_expected_cash(v_shift), 1800000);

-- هزینهٔ پیک از کشو
INSERT INTO treasury.transaction (branch_id, purpose, from_account_id, expense_account_code, amount, shift_id, occurred_at, note, created_by)
VALUES (BR, 'expense', CASHBOX, '6102', 180000, v_shift, platform.business_day_start(D) + interval '14 hours', 'کرایهٔ پیک', v_user)
RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);
PERFORM pg_temp.assert_eq('خروج غیرفروشی کم می‌شود', sales.shift_expected_cash(v_shift), 1620000);

-- حرکت بی‌کشو و حرکت ثبت‌نشده: اثری ندارند
INSERT INTO treasury.account (branch_id, code, name, kind, ledger_account_code)
SELECT BR, 'BANK-SEC-2', 'بانک دوم آزمون', 'bank', ledger_account_code FROM treasury.account WHERE id = BANK
RETURNING id INTO v_bank2;
INSERT INTO treasury.transaction (branch_id, purpose, from_account_id, to_account_id, amount, shift_id, occurred_at, created_by)
VALUES (BR, 'transfer', BANK, v_bank2, 900000, v_shift, platform.business_day_start(D) + interval '15 hours', v_user)
RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);
PERFORM pg_temp.assert_eq('حرکت بی‌کشو اثری ندارد', sales.shift_expected_cash(v_shift), 1620000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. بستن شیفت: همان عدد، بیت‌به‌بیت ═══';
-- ═══════════════════════════════════════════════════════════════════
v_live := sales.shift_expected_cash(v_shift);
-- شیفت دوم همان شعبه، تا مطمئن شویم حرکت شیفت دیگر قاطی نمی‌شود.
INSERT INTO identity.app_user (username, full_name) VALUES ('sec2','صندوق‌دار دوم') RETURNING id INTO v_other;
INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_other, 70000, platform.business_day_start(D) + interval '16 hours') RETURNING id INTO v_other;
-- حرکت پیش‌نویس از کشو ثبت نشده و پول نیست (روی شیفت دوم، چون شیفت با حرکت ثبت‌نشده بسته نمی‌شود).
INSERT INTO treasury.transaction (branch_id, purpose, from_account_id, expense_account_code, amount, shift_id, occurred_at, created_by)
VALUES (BR, 'expense', CASHBOX, '6102', 50000, v_other, platform.business_day_start(D) + interval '16 hours 30 minutes', v_user);
PERFORM pg_temp.assert_eq('شیفت دیگر: فقط موجودی اول خودش؛ پیش‌نویس اثری ندارد', sales.shift_expected_cash(v_other), 70000);

PERFORM sales.close_shift(v_shift, 1600000, v_user);
PERFORM pg_temp.assert_eq('انتظار ثبت‌شده در بستن = انتظار زنده پیش از بستن',
  (SELECT expected_cash FROM sales.cash_shift WHERE id = v_shift), v_live);
PERFORM pg_temp.assert_eq('پس از بستن هم همان عدد',
  sales.shift_expected_cash(v_shift), (SELECT expected_cash FROM sales.cash_shift WHERE id = v_shift));
PERFORM pg_temp.assert_eq('مغایرت = شمرده − انتظار',
  (SELECT variance FROM sales.cash_shift WHERE id = v_shift), 1600000 - v_live);

END $test$;

ROLLBACK;
