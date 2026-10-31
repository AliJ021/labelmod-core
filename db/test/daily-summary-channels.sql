-- =====================================================================
-- خلاصه روز به تفکیک کانال (مهاجرت ۱۰۸) — ثابت آشتی با خلاصه روز
-- =====================================================================
-- ادعای مرکزی: برای همان (شعبه، روز)، جمع کانال‌ها **دقیقاً** برابر
-- `sales.daily_summary` است — با برابری عدد صحیح و بی تلورانس.
--
--   صندوق  دو A نقدی                    فروش و دریافتی صندوق
--   سایت   دو A با کارت، یکی مرجوع      مرجوعی و بازپرداختش از سایت کم می‌شوند، نه از صندوق،
--                                       هرچند پولش از کشوی صندوق برگشته است
--   تلفن   یک A نسیه                    فروش بی دریافتی
--   پیش‌نویس سایت                       نه فروش و نه کانال
--   روز خالی                            هیچ سطری — و جمعِ هیچ همان صفرِ خلاصه روز
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

-- جمع کانال‌ها در برابر خلاصه روز، ستون‌به‌ستون.
CREATE OR REPLACE FUNCTION pg_temp.assert_reconciles(p_label text, p_branch uuid, p_day date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d RECORD; h RECORD;
BEGIN
  SELECT * INTO d FROM sales.daily_summary(p_branch, p_day);
  SELECT coalesce(sum(sales_amount),0) AS sales, coalesce(sum(received_amount),0) AS received,
         coalesce(sum(profit_amount),0) AS profit, coalesce(sum(invoice_count),0) AS invoices,
         coalesce(sum(return_count),0) AS returns
    INTO h FROM sales.daily_summary_by_channel(p_branch, p_day);
  PERFORM pg_temp.assert_eq(p_label || ': Σ فروش کانال‌ها = فروش روز', h.sales, d.sales_amount);
  PERFORM pg_temp.assert_eq(p_label || ': Σ دریافتی کانال‌ها = دریافتی روز', h.received, d.received_amount);
  PERFORM pg_temp.assert_eq(p_label || ': Σ سود کانال‌ها = سود روز', h.profit, d.profit_amount);
  PERFORM pg_temp.assert_eq(p_label || ': Σ فاکتور کانال‌ها = فاکتور روز', h.invoices, d.invoice_count);
  PERFORM pg_temp.assert_eq(p_label || ': Σ مرجوعی کانال‌ها = مرجوعی روز', h.returns, d.return_count);
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  D    date := '2026-09-16';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_b uuid;
  v_rcpt uuid; v_shift uuid; v_inv1 uuid; v_inv2 uuid; v_inv3 uuid; v_inv4 uuid; v_inv5 uuid;
  v_line1 uuid; v_line2 uuid; v_ret uuid;
  s RECORD; n int; prev int;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('dsc','تست خلاصه کانال')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DSC','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DSC','کالای تست')
  RETURNING id INTO v_prod;
-- ساعت‌ها از `business_day_start(D)` ساخته می‌شوند: وقت کاری، نه وقت سرور.
-- A: قیمت ۱٬۰۰۰٬۰۰۰، بها ۴۰۰٬۰۰۰. B: قیمت ۳۰۰٬۰۰۰ زیر بهای ۴۰۰٬۰۰۰ (سود منفی).
-- یک نرخ خرید برای هر کالا، پس بها به `costing.method` وابسته نیست.
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','DSC-A') RETURNING id INTO v_a;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','DSC-B') RETURNING id INTO v_b;
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
RAISE NOTICE E'\n═══ ۱. روز خالی: هیچ کانالی، جمع صفر ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT count(*) INTO n FROM sales.daily_summary_by_channel(BR, D - 1);
PERFORM pg_temp.assert_eq('روز خالی: سطری نیست', n, 0);
PERFORM pg_temp.assert_reconciles('روز خالی', BR, D - 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. سه کانال و یک مرجوعی ═══';
-- ═══════════════════════════════════════════════════════════════════

-- صندوق ۰۹:۰۰ — دو A نقدی.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '9 hours', v_user) RETURNING id INTO v_inv1;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv1, 1, v_a, 2, 1000000, 2000000);
PERFORM sales.refresh_invoice_totals(v_inv1);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv1, v_shift, 'cash', 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '9 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv1, v_user);

-- سایت ۱۰:۰۰ — دو A با کارت.
INSERT INTO sales.invoice (branch_id, warehouse_id, channel, occurred_at, created_by)
VALUES (BR, WH, 'web', platform.business_day_start(D) + interval '10 hours', v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_a, 2, 1000000, 2000000) RETURNING id INTO v_line2;
PERFORM sales.refresh_invoice_totals(v_inv2);
INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, occurred_at, ref_no)
VALUES (v_inv2, 'card', 'in', 2000000, 'succeeded', platform.business_day_start(D) + interval '10 hours 1 minute', 'DSC-WEB-1');
PERFORM sales.finalize_invoice(v_inv2, v_user);

-- تلفن ۱۱:۰۰ — یک A نسیه.
INSERT INTO sales.invoice (branch_id, warehouse_id, channel, occurred_at, created_by)
VALUES (BR, WH, 'phone', platform.business_day_start(D) + interval '11 hours', v_user) RETURNING id INTO v_inv3;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv3, 1, v_a, 1, 1000000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv3);
WITH c AS (INSERT INTO sales.customer (full_name,credit_limit) VALUES ('channel credit fixture',1000000) RETURNING id)
UPDATE sales.invoice SET customer_id=(SELECT id FROM c) WHERE id=v_inv3;
PERFORM sales.finalize_invoice(v_inv3, v_user);

-- پیش‌نویس سایت — نه فروش، نه کانال.
INSERT INTO sales.invoice (branch_id, warehouse_id, channel, occurred_at, created_by)
VALUES (BR, WH, 'web', platform.business_day_start(D) + interval '12 hours', v_user);

-- مرجوعی یک A از فروش سایت، ۱۶:۰۰، پول نقد از کشوی صندوق.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv2, WH, v_shift, 'size_small', 1000000, 'cash',
        platform.business_day_start(D) + interval '16 hours', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line2, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

PERFORM pg_temp.assert_reconciles('سه کانال و مرجوعی', BR, D);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. کانال‌به‌کانال، با عدد صریح ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT count(*) INTO n FROM sales.daily_summary_by_channel(BR, D);
PERFORM pg_temp.assert_eq('فقط سه کانالِ دارای اثر', n, 3);

SELECT * INTO s FROM sales.daily_summary_by_channel(BR, D) WHERE channel = 'pos';
PERFORM pg_temp.assert_eq('صندوق فروش', s.sales_amount, 2000000);
PERFORM pg_temp.assert_eq('صندوق دریافتی (بازپرداخت سایت از آن کم نشده)', s.received_amount, 2000000);
PERFORM pg_temp.assert_eq('صندوق سود', s.profit_amount, 1200000);
PERFORM pg_temp.assert_eq('صندوق مرجوعی', s.return_count, 0);

SELECT * INTO s FROM sales.daily_summary_by_channel(BR, D) WHERE channel = 'web';
PERFORM pg_temp.assert_eq('سایت فروش پس از مرجوعی', s.sales_amount, 1000000);
PERFORM pg_temp.assert_eq('سایت دریافتی پس از بازپرداخت', s.received_amount, 1000000);
PERFORM pg_temp.assert_eq('سایت سود', s.profit_amount, 600000);
PERFORM pg_temp.assert_eq('سایت فاکتور (پیش‌نویس نه)', s.invoice_count, 1);
PERFORM pg_temp.assert_eq('سایت مرجوعی', s.return_count, 1);

SELECT * INTO s FROM sales.daily_summary_by_channel(BR, D) WHERE channel = 'phone';
PERFORM pg_temp.assert_eq('تلفن فروش', s.sales_amount, 1000000);
PERFORM pg_temp.assert_eq('تلفن دریافتی (نسیه)', s.received_amount, 0);

-- ترتیب: بیشترین فروش اول.
SELECT channel INTO s FROM sales.daily_summary_by_channel(BR, D) LIMIT 1;
PERFORM pg_temp.assert_eq('اول صندوق (بیشترین فروش)', (s.channel = 'pos')::int, 1);

END $test$;

ROLLBACK;
