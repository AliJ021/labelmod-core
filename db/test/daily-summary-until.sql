-- =====================================================================
-- خلاصه ساعتی «تا یک لحظه» و مرز «همین لحظهٔ دیروز» (مهاجرت ۱۰۹)
-- =====================================================================
-- چهار ادعا:
--   ۱. با مرز پایان روز، `daily_summary_hourly_until` بیت‌به‌بیت همان
--      `daily_summary_hourly` است — و جمعش همان `daily_summary`.
--   ۲. مرز وسط ساعت: رویداد پیش از مرز در همان ساعت شمرده می‌شود و پس
--      از آن نه؛ ساعت‌های بعد صفرند. مرجوعی و بازپرداختِ پیش از مرز کم
--      می‌شوند.
--   ۳. رویداد **دقیقاً** در لحظهٔ مرز بیرون است؛ یک میکروثانیه بعد، درون.
--   ۴. `previous_day_cutoff`: امروز ۱۸:۴۰ ← دیروز ۱۸:۴۰؛ تاریخ گذشته ←
--      کل روز قبل؛ تاریخ آینده ← آغاز روز قبل (هیچ).
--
-- روزها ثابت‌اند (D−1 = ۲۴ شهریور ۱۴۰۵) نه «امروز»، تا آزمون به ساعت
-- اجرای CI وابسته نباشد. «اکنون» صریح به تابع داده می‌شود.
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

CREATE OR REPLACE FUNCTION pg_temp.assert_ts(
  p_label text, p_actual timestamptz, p_expected timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ %', p_label;
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  D    date := '2026-09-16';
  Y    date := '2026-09-15';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_rcpt uuid; v_shift uuid;
  v_inv uuid; v_l uuid; v_line9 uuid; v_ret uuid;
  s RECORD; dsum RECORD; n bigint; cut timestamptz;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('dsu','تست خلاصه تا لحظه')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-DSU','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-DSU','کالای تست')
  RETURNING id INTO v_prod;
-- یک کالا و یک نرخ خرید: بها به `costing.method` وابسته نیست.
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','DSU-A') RETURNING id INTO v_a;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',1000000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH,
        platform.business_day_start(Y) + interval '8 hours')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_a, 50, 400000, 20000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, platform.business_day_start(Y) + interval '8 hours 30 minutes') RETURNING id INTO v_shift;

-- دیروز (Y): سه فروش نقدی یک‌تایی و یک مرجوعی.
--   ۰۹:۱۵ فروش    ۱۸:۲۰ فروش    ۱۸:۳۰ مرجوعیِ فروش ۰۹:۱۵ (نقد)    ۱۸:۵۰ فروش
FOR s IN SELECT * FROM (VALUES (interval '9 hours 15 minutes'), (interval '18 hours 20 minutes'),
                               (interval '18 hours 50 minutes')) AS t(at) LOOP
  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
  VALUES (BR, WH, v_shift, platform.business_day_start(Y) + s.at, v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 1, v_a, 1, 1000000, 1000000) RETURNING id INTO v_l;
  IF s.at = interval '9 hours 15 minutes' THEN v_line9 := v_l; END IF;
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
  VALUES (v_inv, v_shift, 'cash', 'in', 1000000, 'succeeded', platform.business_day_start(Y) + s.at);
  PERFORM sales.finalize_invoice(v_inv, v_user);
END LOOP;

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, (SELECT invoice_id FROM sales.invoice_line WHERE id = v_line9), WH, v_shift, 'size_small', 1000000, 'cash',
        platform.business_day_start(Y) + interval '18 hours 30 minutes', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line9, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. مرز پایان روز = همان خلاصه ساعتی و همان خلاصه روز ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO n FROM (
  (SELECT * FROM sales.daily_summary_hourly(BR, Y)
   EXCEPT ALL SELECT * FROM sales.daily_summary_hourly_until(BR, Y, platform.business_day_start(D)))
  UNION ALL
  (SELECT * FROM sales.daily_summary_hourly_until(BR, Y, platform.business_day_start(D))
   EXCEPT ALL SELECT * FROM sales.daily_summary_hourly(BR, Y))) x;
PERFORM pg_temp.assert_eq('اختلاف سطر به سطر با daily_summary_hourly', n, 0);

SELECT * INTO dsum FROM sales.daily_summary(BR, Y);
SELECT sum(sales_amount) AS sales, sum(received_amount) AS received, sum(profit_amount) AS profit,
       sum(invoice_count) AS inv, sum(return_count) AS ret
  INTO s FROM sales.daily_summary_hourly_until(BR, Y, platform.business_day_start(D));
PERFORM pg_temp.assert_eq('Σ فروش = خلاصه روز', s.sales, dsum.sales_amount);
PERFORM pg_temp.assert_eq('Σ دریافتی = خلاصه روز', s.received, dsum.received_amount);
PERFORM pg_temp.assert_eq('Σ سود = خلاصه روز', s.profit, dsum.profit_amount);
PERFORM pg_temp.assert_eq('Σ فاکتور = خلاصه روز', s.inv, dsum.invoice_count);
PERFORM pg_temp.assert_eq('فروش کل دیروز (۳ فروش − ۱ مرجوعی)', s.sales, 2000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. مرز ۱۸:۴۰ — فروش ۱۸:۲۰ و مرجوعی ۱۸:۳۰ درون، فروش ۱۸:۵۰ بیرون ═══';
-- ═══════════════════════════════════════════════════════════════════

cut := platform.business_day_start(Y) + interval '18 hours 40 minutes';
SELECT * INTO s FROM sales.daily_summary_hourly_until(BR, Y, cut) WHERE hour_of_day = 9;
PERFORM pg_temp.assert_eq('۰۹ فروش', s.sales_amount, 1000000);
PERFORM pg_temp.assert_eq('۰۹ دریافتی', s.received_amount, 1000000);
SELECT * INTO s FROM sales.daily_summary_hourly_until(BR, Y, cut) WHERE hour_of_day = 18;
PERFORM pg_temp.assert_eq('۱۸ فروش: فروش ۱۸:۲۰ منهای مرجوعی ۱۸:۳۰', s.sales_amount, 0);
PERFORM pg_temp.assert_eq('۱۸ دریافتی: نقد ۱۸:۲۰ منهای بازپرداخت ۱۸:۳۰', s.received_amount, 0);
PERFORM pg_temp.assert_eq('۱۸ فاکتور: فقط ۱۸:۲۰', s.invoice_count, 1);
PERFORM pg_temp.assert_eq('۱۸ مرجوعی', s.return_count, 1);
SELECT count(*) INTO n FROM sales.daily_summary_hourly_until(BR, Y, cut)
 WHERE hour_of_day > 18 AND (sales_amount <> 0 OR received_amount <> 0 OR invoice_count <> 0 OR payment_count <> 0);
PERFORM pg_temp.assert_eq('پس از ساعت ۱۸ هیچ ساعتی غیرصفر نیست', n, 0);
SELECT sum(sales_amount) AS sales, sum(invoice_count) AS inv
  INTO s FROM sales.daily_summary_hourly_until(BR, Y, cut);
PERFORM pg_temp.assert_eq('Σ فروش تا ۱۸:۴۰', s.sales, 1000000);
PERFORM pg_temp.assert_eq('Σ فاکتور تا ۱۸:۴۰', s.inv, 2);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. رویداد دقیقاً در لحظهٔ مرز بیرون است (نیم‌باز) ═══';
-- ═══════════════════════════════════════════════════════════════════

cut := platform.business_day_start(Y) + interval '18 hours 50 minutes';
SELECT sum(invoice_count) INTO n FROM sales.daily_summary_hourly_until(BR, Y, cut);
PERFORM pg_temp.assert_eq('مرز = ۱۸:۵۰: فروش ۱۸:۵۰ بیرون', n, 2);
SELECT sum(invoice_count) INTO n FROM sales.daily_summary_hourly_until(BR, Y, cut + interval '1 microsecond');
PERFORM pg_temp.assert_eq('یک میکروثانیه بعد: درون', n, 3);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. مرز «همین لحظهٔ دیروز» ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_ts('امروز ۱۸:۴۰ ← دیروز ۱۸:۴۰',
  sales.previous_day_cutoff(D, platform.business_day_start(D) + interval '18 hours 40 minutes'),
  platform.business_day_start(Y) + interval '18 hours 40 minutes');
PERFORM pg_temp.assert_ts('آغاز امروز ← آغاز دیروز (هیچ)',
  sales.previous_day_cutoff(D, platform.business_day_start(D)),
  platform.business_day_start(Y));
PERFORM pg_temp.assert_ts('تاریخ گذشته ← کل روز قبل',
  sales.previous_day_cutoff(D, platform.business_day_start(D + 5)),
  platform.business_day_start(D));
PERFORM pg_temp.assert_ts('تاریخ آینده ← آغاز روز قبل، نه منفی',
  sales.previous_day_cutoff(D, platform.business_day_start(D) - interval '3 hours'),
  platform.business_day_start(Y));
PERFORM pg_temp.assert_ts('مرز به ساعت کسب‌وکار است نه سرور: ثانیه‌ها هم حفظ می‌شوند',
  sales.previous_day_cutoff(D, platform.business_day_start(D) + interval '23 hours 59 minutes 59.5 seconds'),
  platform.business_day_start(Y) + interval '23 hours 59 minutes 59.5 seconds');

-- و مقایسهٔ واقعی: امروز ۱۸:۴۰، طرف مقایسه دیروز تا ۱۸:۴۰ است — نه کل دیروز.
SELECT sum(sales_amount) INTO n FROM sales.daily_summary_hourly_until(BR, Y,
  sales.previous_day_cutoff(D, platform.business_day_start(D) + interval '18 hours 40 minutes'));
PERFORM pg_temp.assert_eq('فروش دیروز تا همین لحظه (نه کل روز ۲٬۰۰۰٬۰۰۰)', n, 1000000);

RAISE NOTICE E'\n✔ خلاصه ساعتی تا لحظه و مرز دیروز — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
