-- =====================================================================
-- خلاصه روز — فروش، وجه دریافتی، سود
-- =====================================================================
-- ادعای مرکزی این پرونده: **این سه عدد یکی نیستند و نباید بشوند.**
--
-- سناریوی طلایی‌اش همان چیزی است که در فروشگاه واقعی می‌افتد و اگر
-- اعداد یکی شوند، مالک تصمیم غلط می‌گیرد:
--
--   فاکتور نقدی کامل   هر سه بالا می‌روند
--   فاکتور نیمه‌پرداخت  فروش بالا، دریافتی کمتر
--   مرجوعی             هر سه پایین
--
-- روزی که مشتری فاکتور بزرگ نسیه ببرد، «فروش» بالا می‌رود و «وجه
-- دریافتی» تکان نمی‌خورد. اگر یکی بودند، مالک فکر می‌کرد پول در
-- کشوست.
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
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_inv2 uuid; v_line uuid; v_ret uuid;
  v_day date;
  s RECORD;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('ds','تست خلاصه روز')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DS','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DS','کالای تست')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','DS-M') RETURNING id INTO v_var;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var,'default',1000000);

-- بهای تمام‌شده ۴۰۰٬۰۰۰ برای هر واحد — تا سود قابل سنجش باشد.
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 100, 400000, 40000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

v_day := platform.business_date();

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, now()) RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. روز خالی، سه صفر ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO s FROM sales.daily_summary(BR, v_day);
PERFORM pg_temp.assert_eq('فروش روز خالی', s.sales_amount, 0);
PERFORM pg_temp.assert_eq('دریافتی روز خالی', s.received_amount, 0);
PERFORM pg_temp.assert_eq('سود روز خالی', s.profit_amount, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. یک فروش نقدی کامل ═══';
-- ═══════════════════════════════════════════════════════════════════
-- دو واحد به ۱٬۰۰۰٬۰۰۰ = فروش ۲٬۰۰۰٬۰۰۰، بهای تمام‌شده ۸۰۰٬۰۰۰،
-- پس سود ۱٬۲۰۰٬۰۰۰.

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, now(), v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 1000000, 2000000) RETURNING id INTO v_line;
PERFORM sales.refresh_invoice_totals(v_inv);

INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 2000000, 'succeeded', now());
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT * INTO s FROM sales.daily_summary(BR, v_day);
PERFORM pg_temp.assert_eq('فروش', s.sales_amount, 2000000);
PERFORM pg_temp.assert_eq('وجه دریافتی', s.received_amount, 2000000);
PERFORM pg_temp.assert_eq('سود = فروش منهای بهای تمام‌شده', s.profit_amount, 1200000);
PERFORM pg_temp.assert_eq('یک فاکتور شمرده شد', s.invoice_count, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. فروش نسیه — جایی که سه عدد از هم جدا می‌شوند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- **مهم‌ترین ادعای این پرونده.** یک واحد فروخته می‌شود ولی پولش
-- نمی‌آید. اگر «فروش» و «وجه دریافتی» یکی بودند، مالک فکر می‌کرد
-- یک میلیون در کشو دارد.

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, now(), v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_var, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv2);
-- Credit requires an identified customer with sufficient authorized limit.
WITH c AS (INSERT INTO sales.customer (full_name,credit_limit) VALUES ('daily credit fixture',1000000) RETURNING id)
UPDATE sales.invoice SET customer_id=(SELECT id FROM c) WHERE id=v_inv2;
PERFORM sales.finalize_invoice(v_inv2, v_user);

SELECT * INTO s FROM sales.daily_summary(BR, v_day);
PERFORM pg_temp.assert_eq('فروش بالا رفت', s.sales_amount, 3000000);
PERFORM pg_temp.assert_eq('وجه دریافتی تکان نخورد', s.received_amount, 2000000);
PERFORM pg_temp.assert_eq('سود هم بالا رفت — کالا رفته، پولش بدهی است',
  s.profit_amount, 1800000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. مرجوعی از هر سه کم می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- یک واحد از فاکتور اول برمی‌گردد و پولش پس داده می‌شود.

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv, WH, v_shift, 'size_small', 1000000, 'cash', now(), v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

SELECT * INTO s FROM sales.daily_summary(BR, v_day);
PERFORM pg_temp.assert_eq('فروش کم شد', s.sales_amount, 2000000);
PERFORM pg_temp.assert_eq('وجه دریافتی کم شد — پول از کشو رفت',
  s.received_amount, 1000000);
PERFORM pg_temp.assert_eq('سود کم شد', s.profit_amount, 1200000);
PERFORM pg_temp.assert_eq('یک مرجوعی شمرده شد', s.return_count, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. مرزها ═══';
-- ═══════════════════════════════════════════════════════════════════

-- پیش‌نویس فروش نیست.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, now(), v_user);
SELECT * INTO s FROM sales.daily_summary(BR, v_day);
PERFORM pg_temp.assert_eq('پیش‌نویس در فروش نمی‌آید', s.sales_amount, 2000000);

-- روز دیگر، اعداد این روز را نمی‌بیند.
SELECT * INTO s FROM sales.daily_summary(BR, v_day - 1);
PERFORM pg_temp.assert_eq('روز قبل خالی است', s.sales_amount, 0);

-- شعبه دیگر، اعداد این شعبه را نمی‌بیند.
SELECT * INTO s FROM sales.daily_summary(gen_random_uuid(), v_day);
PERFORM pg_temp.assert_eq('شعبه دیگر خالی است', s.sales_amount, 0);
PERFORM pg_temp.assert_eq('دریافتی شعبه دیگر هم خالی', s.received_amount, 0);

RAISE NOTICE E'\n✔ خلاصه روز — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
