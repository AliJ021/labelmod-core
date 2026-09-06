-- =====================================================================
-- پنل مدیریتی — ساعت، مقایسه دوره، تحلیل سبد
-- =====================================================================
-- ادعای مرکزی همان ادعای بقیه گزارش‌هاست: **عدد با منبعش می‌خواند.**
--
--   report_hourly   جمعش با  report_summary
--   report_basket   جمعش با  report_summary
--   report_compare  هر دو طرفش با  report_summary
--
-- به‌علاوه سه چیزی که فقط اینجا سنجیده می‌شوند و بی‌صدا می‌شکنند:
--
--   ۱. ساعت از منطقه زمانی **کسب‌وکار** می‌آید، نه سرور
--   ۲. مبلغ در گزارش هر مشتری به تعداد سطرها **ضرب نمی‌شود**
--   ۳. فاکتور بی‌شماره «یک مشتری» شمرده نمی‌شود
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

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

DO $outer$
DECLARE
  BR   uuid; WH uuid;
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid;
  v_c1 uuid; v_c2 uuid;
  v_day date; v_n numeric; v_txt text;
  r record;
BEGIN
  SELECT id INTO BR FROM platform.branch WHERE code = 'MAIN';
  SELECT id INTO WH FROM inventory.warehouse WHERE branch_id = BR LIMIT 1;
  SELECT id INTO v_user FROM identity.app_user WHERE username = 'system';
  PERFORM platform.set_actor(v_user, NULL, NULL);

  INSERT INTO purchasing.supplier (code, name) VALUES ('S-MP','تأمین‌کننده پنل')
    RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-MP','کالای پنل')
    RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, color, size, sku)
    VALUES (v_prod,'سبز','L','MP-L') RETURNING id INTO v_var;
  INSERT INTO catalog.variation (product_id, color, size, sku)
    VALUES (v_prod,'زرد','M','MP-M') RETURNING id INTO v_var2;
  INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var,'default',1000000);
  INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var2,'default',500000);

  INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
  VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, now())
  RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
  VALUES (v_rcpt, v_var, 100, 400000, 40000000);
  INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
  VALUES (v_rcpt, v_var2, 100, 200000, 20000000);
  PERFORM purchasing.post_receipt(v_rcpt, v_user);

  v_day := platform.business_date();
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
  VALUES (BR, v_user, 0, now()) RETURNING id INTO v_shift;

  INSERT INTO sales.customer (mobile_normalized, full_name)
  VALUES ('09120000001','مشتری یک') RETURNING id INTO v_c1;
  INSERT INTO sales.customer (mobile_normalized, full_name)
  VALUES ('09120000002','مشتری دو') RETURNING id INTO v_c2;

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۱. ساعتِ کاری از تنظیم می‌آید، نه از سرور ═══';
  -- ═════════════════════════════════════════════════════════════════
  -- سرور CI با UTC بالا می‌آید. اگر `extract(hour ...)` مستقیم روی
  -- timestamptz نوشته می‌شد، این ادعا ۳ ساعت و نیم خطا می‌داد — و
  -- برخلاف باگ تاریخ که فقط بامداد دیده می‌شد، این **هر ساعتی**
  -- غلط است.

  PERFORM pg_temp.assert_eq(
    'ساعت ۰۸:۰۰ تهران، ساعت ۸ است',
    platform.business_hour('2026-03-01 08:00:00+03:30'::timestamptz), 8);

  PERFORM pg_temp.assert_eq(
    'همان لحظه به UTC، باز هم ساعت ۸ است',
    platform.business_hour('2026-03-01 04:30:00+00'::timestamptz), 8);

  -- ۲۳:۳۰ تهران در UTC روزِ قبل و ساعت ۲۰ است. اگر ساعت از سرور
  -- خوانده شود، فروشِ آخر شب زیر ساعت ۲۰ می‌نشیند.
  PERFORM pg_temp.assert_eq(
    'نیم‌ساعت به نیمه‌شب تهران، ساعت ۲۳ است نه ۲۰',
    platform.business_hour('2026-03-01 23:30:00+03:30'::timestamptz), 23);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۲. بازه بی‌فروش، سطر ندارد ═══';
  -- ═════════════════════════════════════════════════════════════════
  SELECT count(*) INTO v_n FROM sales.report_hourly('2020-01-01','2020-01-31');
  PERFORM pg_temp.assert_eq('گزارش ساعتی روی بازه خالی', v_n, 0);
  SELECT count(*) INTO v_n FROM sales.report_basket('2020-01-01','2020-01-31');
  PERFORM pg_temp.assert_eq('تحلیل سبد روی بازه خالی', v_n, 0);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۳. سه فاکتور: دو مشتری شناخته، یکی بی‌شماره ═══';
  -- ═════════════════════════════════════════════════════════════════
  -- مشتری یک: دو فاکتور، مجموعاً ۵ قلم
  -- مشتری دو: یک فاکتور، ۱ قلم
  -- بی‌شماره : یک فاکتور، ۴ قلم
  -- جمع: ۴ فاکتور، ۱۰ قلم — و پرسش همین است که ده قلم را چند نفر بردند.

  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
  VALUES (BR, WH, v_shift, v_c1, now(), v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 1, v_var, 3, 1000000, 3000000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
  VALUES (v_inv, v_shift, 'cash', 'in', 3000000, 'succeeded', now());
  PERFORM sales.finalize_invoice(v_inv, v_user);

  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
  VALUES (BR, WH, v_shift, v_c1, now(), v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 1, v_var2, 2, 500000, 1000000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
  VALUES (v_inv, v_shift, 'cash', 'in', 1000000, 'succeeded', now());
  PERFORM sales.finalize_invoice(v_inv, v_user);

  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
  VALUES (BR, WH, v_shift, v_c2, now(), v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 1, v_var2, 1, 500000, 500000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
  VALUES (v_inv, v_shift, 'cash', 'in', 500000, 'succeeded', now());
  PERFORM sales.finalize_invoice(v_inv, v_user);

  -- بی‌شماره: دو سطر، مجموعاً ۴ قلم
  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
  VALUES (BR, WH, v_shift, now(), v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 1, v_var, 1, 1000000, 1000000);
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 2, v_var2, 3, 500000, 1500000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction, amount, status, occurred_at)
  VALUES (v_inv, v_shift, 'cash', 'in', 2500000, 'succeeded', now());
  PERFORM sales.finalize_invoice(v_inv, v_user);

  SELECT * INTO r FROM sales.report_basket(v_day, v_day, BR) WHERE channel = 'pos';
  PERFORM pg_temp.assert_eq('چهار فاکتور', r.invoice_count, 4);
  PERFORM pg_temp.assert_eq('ده قلم', r.item_qty, 10);
  PERFORM pg_temp.assert_eq('پنج سطر فاکتور', r.line_count, 5);
  PERFORM pg_temp.assert_eq('دو مشتری شناخته‌شده، نه سه', r.known_customers, 2);
  PERFORM pg_temp.assert_eq('یک فاکتور بی‌شماره — جدا شمرده شد', r.anonymous_count, 1);
  PERFORM pg_temp.assert_eq('میانگین قلم در فاکتور', r.qty_per_invoice, 2.50);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۴. تحلیل سبد با گزارش فروش می‌خواند ═══';
  -- ═════════════════════════════════════════════════════════════════
  SELECT b.net_amount - s.net_amount INTO v_n
    FROM sales.report_basket(v_day, v_day, BR) b
    JOIN sales.report_summary(v_day, v_day, BR) s ON s.channel = b.channel;
  PERFORM pg_temp.assert_eq('مبلغ تحلیل سبد = مبلغ گزارش فروش', v_n, 0);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۵. گزارش ساعتی با گزارش فروش می‌خواند ═══';
  -- ═════════════════════════════════════════════════════════════════
  SELECT sum(h.net_amount) - max(s.net_amount) INTO v_n
    FROM sales.report_hourly(v_day, v_day, BR) h
    CROSS JOIN sales.report_summary(v_day, v_day, BR) s
   WHERE h.channel = 'pos' AND s.channel = 'pos';
  PERFORM pg_temp.assert_eq('جمع ساعت‌ها = فروش خالص روز', v_n, 0);

  SELECT sum(h.item_qty) INTO v_n FROM sales.report_hourly(v_day, v_day, BR) h;
  PERFORM pg_temp.assert_eq('جمع اقلام ساعتی = ده قلم', v_n, 10);

  SELECT count(*) INTO v_n FROM sales.report_hourly(v_day, v_day, BR)
   WHERE hour_of_day = platform.business_hour(now());
  PERFORM pg_temp.assert_eq('همه فروش‌ها زیر ساعت جاری نشستند', v_n, 1);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۶. مبلغ هر مشتری به تعداد سطرها ضرب نمی‌شود ═══';
  -- ═════════════════════════════════════════════════════════════════
  -- مشتری یک دو فاکتور دارد: ۳٬۰۰۰٬۰۰۰ و ۱٬۰۰۰٬۰۰۰ = ۴٬۰۰۰٬۰۰۰.
  -- اگر `JOIN invoice_line` می‌بود، هر فاکتور به تعداد سطرهایش تکرار
  -- می‌شد و این عدد بزرگ‌تر درمی‌آمد — بی‌آنکه خطایی بدهد.

  SELECT * INTO r FROM sales.report_customer_basket(v_day, v_day, BR) WHERE customer_id = v_c1;
  PERFORM pg_temp.assert_eq('مبلغ مشتری یک', r.net_amount, 4000000);
  PERFORM pg_temp.assert_eq('دو فاکتور', r.invoice_count, 2);
  PERFORM pg_temp.assert_eq('پنج قلم', r.item_qty, 5);
  PERFORM pg_temp.assert_txt('نام مشتری', r.full_name, 'مشتری یک');

  SELECT count(*) INTO v_n FROM sales.report_customer_basket(v_day, v_day, BR);
  PERFORM pg_temp.assert_eq('فاکتور بی‌شماره در فهرست اشخاص نمی‌آید', v_n, 2);

  SELECT sum(net_amount) INTO v_n FROM sales.report_customer_basket(v_day, v_day, BR);
  PERFORM pg_temp.assert_eq('جمع اشخاص = کل منهای بی‌شماره', v_n, 4500000);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۷. مقایسه دو دوره ═══';
  -- ═════════════════════════════════════════════════════════════════
  -- دوره جاری امروز است (۷٬۰۰۰٬۰۰۰ خالص، ۴ فاکتور)، دوره مبنا یک بازه
  -- خالی. رشد از صفر، درصد ندارد — NULL است، نه بی‌نهایت.

  SELECT * INTO r FROM sales.report_compare(v_day, v_day, '2020-01-01','2020-01-31', BR)
   WHERE channel = 'pos';
  PERFORM pg_temp.assert_eq('فروش دوره جاری', r.net_amount, 7000000);
  PERFORM pg_temp.assert_eq('دوره مبنا خالی بود', r.prev_net_amount, 0);
  PERFORM pg_temp.assert_eq('تفاوت', r.delta_amount, 7000000);
  PERFORM pg_temp.assert_txt('جهت رو به بالا', r.direction, 'up');
  IF r.delta_percent IS NOT NULL THEN
    RAISE EXCEPTION '✗ رشد از صفر نباید درصد داشته باشد، واقعی: %', r.delta_percent;
  END IF;
  RAISE NOTICE '  ✓ رشد از صفر درصد ندارد (NULL)، نه بی‌نهایت';

  -- جهت معکوس: دوره جاری خالی، مبنا امروز.
  SELECT * INTO r FROM sales.report_compare('2020-01-01','2020-01-31', v_day, v_day, BR)
   WHERE channel = 'pos';
  PERFORM pg_temp.assert_eq('دوره جاری خالی', r.net_amount, 0);
  PERFORM pg_temp.assert_eq('تفاوت منفی', r.delta_amount, -7000000);
  PERFORM pg_temp.assert_txt('جهت رو به پایین', r.direction, 'down');
  PERFORM pg_temp.assert_eq('درصد کاهش صد', r.delta_percent, -100.0);

  -- دو دوره یکسان: بدون تغییر، نه «رشد صفر درصد».
  SELECT * INTO r FROM sales.report_compare(v_day, v_day, v_day, v_day, BR)
   WHERE channel = 'pos';
  PERFORM pg_temp.assert_txt('دوره در برابر خودش: بدون تغییر', r.direction, 'flat');
  PERFORM pg_temp.assert_eq('تفاوت صفر', r.delta_amount, 0);
  PERFORM pg_temp.assert_eq('درصد صفر', r.delta_percent, 0.0);

  -- ═════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۸. دامنه شعبه واقعاً فیلتر می‌کند ═══';
  -- ═════════════════════════════════════════════════════════════════
  SELECT count(*) INTO v_n
    FROM sales.report_basket(v_day, v_day, '00000000-0000-0000-0000-000000000000'::uuid);
  PERFORM pg_temp.assert_eq('شعبه دیگر، هیچ سطری', v_n, 0);
  SELECT count(*) INTO v_n
    FROM sales.report_hourly(v_day, v_day, '00000000-0000-0000-0000-000000000000'::uuid);
  PERFORM pg_temp.assert_eq('گزارش ساعتی هم شعبه را می‌فهمد', v_n, 0);

  RAISE NOTICE E'\n✓ پنل مدیریتی — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
