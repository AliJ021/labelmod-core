-- =====================================================================
-- تست پیش‌نمایش حساب مرجوعی (مهاجرت ۱۱۶)
-- =====================================================================
-- ادعای مرکزی: **پیش‌نمایش همان چیزی است که `post_return` می‌نشاند.**
-- هر سناریو اول `return_account_preview` را می‌خواند، بعد همان برگ را با
-- همان بازپرداخت ثبت می‌کند و ارزش، صرف بدهی (`receivable_applied`) و
-- اعتبار مشتری (`credit_applied`) را با برگ ثبت‌شده مقایسه می‌کند.
--
-- سناریوها همان مثال‌هایی‌اند که به مالک توضیح داده شد:
--   الف. فاکتور تسویه‌شده — پیشنهاد = ارزش کالا (رفتار قبلی، بی تغییر).
--   ب. بدهی بیش از ارزش کالا — همه صرف بدهی؛ پیشنهاد صفر.
--   ج. بدهی کمتر از ارزش — اول بدهی، باقی بازپرداخت.
--   د. بازپرداخت کمتر از پیشنهاد — مازاد اعتبار مشتری.
--   هـ. گرد کردن سه مرجوعی پیاپی از یک سطر غیربخش‌پذیر.
--   و. بازپرداخت نامجاز خطا نیست، «مشکل» برمی‌گردد — و ثبت همان را رد می‌کند.
-- کنترل حساسیت: در «ب» پیشنهاد سرور با جمع ساده‌ای که مرورگر پیشنهاد می‌داد
-- (ارزش کامل) فرق دارد؛ وگرنه این آزمون چیزی را جدا نمی‌کرد.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(p_label text, p_actual numeric, p_expected numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_label text, p_sql text, p_like text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE p_like THEN RAISE EXCEPTION E'\n  ✗ %\n      پیام نادرست: %', p_label, SQLERRM; END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 78);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- فاکتور یک‌سطری نهایی‌شده با دریافت جزئی/کامل.
CREATE OR REPLACE FUNCTION pg_temp.invoice(p_shift uuid, p_var uuid, p_cust uuid, p_qty numeric, p_net numeric, p_paid numeric, p_user uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_inv uuid;
BEGIN
  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
  VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000101', p_shift, p_cust,
          '2026-06-05 10:00+03:30', p_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES (v_inv, 1, p_var, p_qty, round(p_net / p_qty), p_net);
  IF p_paid > 0 THEN
    INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount) VALUES (v_inv, p_shift, 'cash', p_paid);
  END IF;
  PERFORM sales.finalize_invoice(v_inv, p_user);
  RETURN v_inv;
END $$;

-- پیش‌نمایش، ثبت با همان بازپرداخت، مقایسه. برمی‌گرداند: بازپرداختی که ثبت شد.
CREATE OR REPLACE FUNCTION pg_temp.preview_then_post(p_label text, p_inv uuid, p_qty numeric, p_refund numeric, p_user uuid)
RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE pv record; v_line uuid; v_ret uuid; r sales.sale_return%ROWTYPE;
BEGIN
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = p_inv;
  SELECT * INTO pv FROM sales.return_account_preview(p_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', p_qty::text)), p_refund);
  IF pv.problem IS NOT NULL THEN RAISE EXCEPTION 'پیش‌نمایش «%» مشکل داد: %', p_label, pv.problem; END IF;
  INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, reason_code, refund_amount, refund_method, occurred_at, created_by)
  VALUES ('00000000-0000-7000-8000-000000000001', p_inv, '00000000-0000-7000-8000-000000000101', 'changed_mind',
          pv.refund, 'cash', '2026-06-06', p_user) RETURNING id INTO v_ret;
  INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
  VALUES (v_ret, v_line, p_qty, 0, 0, 0, 0);
  PERFORM sales.post_return(v_ret, p_user);
  SELECT * INTO r FROM sales.sale_return WHERE id = v_ret;
  PERFORM pg_temp.assert_eq(p_label || ' — ارزش کالا', pv.returned_value, r.net_amount + r.tax_amount + r.shipping_amount);
  PERFORM pg_temp.assert_eq(p_label || ' — صرف بدهی (receivable_applied)', pv.debt_applied, r.receivable_applied);
  PERFORM pg_temp.assert_eq(p_label || ' — اعتبار مشتری (credit_applied)', pv.customer_credit, r.credit_applied);
  PERFORM pg_temp.assert_eq(p_label || ' — بازپرداخت', pv.refund, r.refund_amount);
  RETURN r.refund_amount;
END $$;

DO $test$
DECLARE
  v_user uuid; v_sup uuid; v_cust uuid; v_prod uuid; v_var uuid; v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid;
  pv record;
BEGIN
  RAISE NOTICE E'\n═══ آماده‌سازی ═══';
  INSERT INTO identity.app_user (username, full_name) VALUES ('retpreview', 'تست پیش‌نمایش مرجوعی') RETURNING id INTO v_user;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user, 'admin', '00000000-0000-7000-8000-000000000001');
  PERFORM platform.set_actor(v_user);
  PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb, 'تست: پیش‌نمایش حساب مرجوعی', v_user);
  INSERT INTO purchasing.supplier (code, name) VALUES ('S-RAP', 'تأمین‌کننده') RETURNING id INTO v_sup;
  INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit) VALUES ('09120000116', 'مشتری پیش‌نمایش', 100000000) RETURNING id INTO v_cust;
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-RAP', 'کالای پیش‌نمایش مرجوعی') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod, 'سفید', 'L', 'RAP-L') RETURNING id INTO v_var;
  INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
  VALUES (platform.next_document_no('00000000-0000-7000-8000-000000000001', 'purchase', 1405::smallint),
          '00000000-0000-7000-8000-000000000001', v_sup, '00000000-0000-7000-8000-000000000101', '2026-06-01') RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount) VALUES (v_rcpt, v_var, 30, 1000000, 30000000);
  PERFORM purchasing.post_receipt(v_rcpt, v_user);
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
  VALUES ('00000000-0000-7000-8000-000000000001', v_user, 0, '2026-06-05 09:00+03:30') RETURNING id INTO v_shift;

  RAISE NOTICE E'\n═══ الف. فاکتور تسویه‌شده: پیشنهاد = ارزش کالا ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 5000000, 5000000, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')));
  PERFORM pg_temp.assert_eq('بدهی', pv.outstanding, 0);
  PERFORM pg_temp.assert_eq('پشتوانه', pv.funds, 5000000);
  PERFORM pg_temp.assert_eq('پیشنهاد = ارزش', pv.suggested_refund, 2500000);
  PERFORM pg_temp.assert_eq('سقف', pv.max_refund, 2500000);
  PERFORM pg_temp.preview_then_post('الف', v_inv, 1, NULL, v_user);

  RAISE NOTICE E'\n═══ ب. بدهی ۳ میلیون، ارزش کالا ۲٫۵ میلیون: همه صرف بدهی ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 5000000, 2000000, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')));
  PERFORM pg_temp.assert_eq('بدهی', pv.outstanding, 3000000);
  PERFORM pg_temp.assert_eq('صرف بدهی', pv.debt_applied, 2500000);
  PERFORM pg_temp.assert_eq('پیشنهاد صفر', pv.suggested_refund, 0);
  -- کنترل حساسیت: پیشنهاد قبلی مرورگر «ارزش کامل» بود.
  IF pv.suggested_refund = pv.returned_value THEN RAISE EXCEPTION '  ✗ کنترل حساسیت: پیشنهاد با ارزش کامل فرق ندارد'; END IF;
  RAISE NOTICE '  ✓ کنترل حساسیت: پیشنهاد سرور % ≠ ارزش کامل %', pv.suggested_refund, pv.returned_value;
  PERFORM pg_temp.preview_then_post('ب', v_inv, 1, NULL, v_user);

  RAISE NOTICE E'\n═══ ج. بدهی ۱ میلیون، ارزش ۲٫۵ میلیون: اول بدهی، باقی بازپرداخت ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 5000000, 4000000, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')));
  PERFORM pg_temp.assert_eq('پیشنهاد = ارزش − بدهی', pv.suggested_refund, 1500000);
  PERFORM pg_temp.assert_eq('صرف بدهی', pv.debt_applied, 1000000);
  PERFORM pg_temp.assert_eq('اعتبار', pv.customer_credit, 0);
  PERFORM pg_temp.preview_then_post('ج', v_inv, 1, NULL, v_user);

  RAISE NOTICE E'\n═══ د. بازپرداخت دلخواه کمتر: مازاد اعتبار مشتری ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 5000000, 4000000, v_user);
  PERFORM pg_temp.preview_then_post('د', v_inv, 1, 500000, v_user);
  PERFORM pg_temp.assert_eq('اعتبار مشتری ساخته شد',
    (SELECT credit_applied FROM sales.sale_return WHERE invoice_id = v_inv AND status = 'posted'), 1000000);

  RAISE NOTICE E'\n═══ هـ. سه مرجوعی پیاپی از سطر غیربخش‌پذیر ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 3, 1000000, 1000000, v_user);
  PERFORM pg_temp.preview_then_post('هـ اول', v_inv, 1, NULL, v_user);
  PERFORM pg_temp.preview_then_post('هـ دوم', v_inv, 1, NULL, v_user);
  PERFORM pg_temp.preview_then_post('هـ آخر', v_inv, 1, NULL, v_user);
  PERFORM pg_temp.assert_eq('جمع سه ارزش = خالص فاکتور',
    (SELECT sum(net_amount + tax_amount) FROM sales.sale_return WHERE invoice_id = v_inv AND status = 'posted'), 1000000);

  -- جایگزین آزمون‌های واحد `suggestedRefund` مرورگر (حذف‌شده): گرد کردن نیم‌به‌بالا و تخفیف درون خالص سطر.
  RAISE NOTICE E'\n═══ هـ۲. گرد کردن نیم‌به‌بالا و خالص پس از تخفیف ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 1001, 1001, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')));
  PERFORM pg_temp.assert_eq('۱۰۰۱ ÷ ۲ → ۵۰۱ (نه ۵۰۰)', pv.returned_value, 501);
  PERFORM pg_temp.preview_then_post('هـ۲', v_inv, 1, NULL, v_user);
  -- خالص سطر تخفیف را در خود دارد: ۲ عدد با خالص ۱٫۵ میلیون → هر عدد ۷۵۰ هزار، نه بهای فهرست.
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 1500000, 1500000, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')));
  PERFORM pg_temp.assert_eq('ارزش از خالص سطر', pv.returned_value, 750000);

  RAISE NOTICE E'\n═══ و. بازپرداخت نامجاز: «مشکل»، و ثبت همان را رد می‌کند ═══';
  v_inv := pg_temp.invoice(v_shift, v_var, v_cust, 2, 5000000, 2000000, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '2')), 2500000);
  PERFORM pg_temp.assert_eq('بیش از دریافتی → مشکل', (pv.problem LIKE 'بازپرداخت بیش از مبلغ دریافت‌شده%')::int, 1);
  PERFORM pg_temp.assert_eq('سقف = دریافتی', pv.max_refund, 2000000);
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')), 2600000);
  PERFORM pg_temp.assert_eq('بیش از ارزش → مشکل', (pv.problem LIKE 'بازپرداخت بیش از ارزش%')::int, 1);
  -- خودِ `post_return` (نه کمکی این آزمون) همان بازپرداخت را رد می‌کند.
  PERFORM pg_temp.assert_raises('ثبتِ همان بازپرداخت رد می‌شود', format($q$
    WITH r AS (INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, reason_code, refund_amount, refund_method, occurred_at, created_by)
      VALUES ('00000000-0000-7000-8000-000000000001', %L, '00000000-0000-7000-8000-000000000101', 'changed_mind', 2500000, 'cash', '2026-06-06', %L) RETURNING id),
    l AS (INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
      SELECT id, %L, 2, 0, 0, 0, 0 FROM r RETURNING return_id)
    SELECT sales.post_return((SELECT return_id FROM l), %L)$q$, v_inv, v_user, v_line, v_user), 'بازپرداخت%بیش از مبلغ دریافت‌شده%');
  -- فروش ناشناس با مازاد → مشکل
  v_inv := pg_temp.invoice(v_shift, v_var, NULL, 2, 5000000, 5000000, v_user);
  SELECT id INTO v_line FROM sales.invoice_line WHERE invoice_id = v_inv;
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')), 1000000);
  PERFORM pg_temp.assert_eq('ناشناس با اعتبار → مشکل', (pv.problem LIKE 'فروش ناشناس%')::int, 1);
  SELECT * INTO pv FROM sales.return_account_preview(v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '1')));
  PERFORM pg_temp.assert_eq('ناشناس با پیشنهاد → بی مشکل', (pv.problem IS NULL)::int, 1);

  RAISE NOTICE E'\n═══ ز. ورودی نادرست، همان پیام ثبت ═══';
  PERFORM pg_temp.assert_raises('بیش از باقی‌مانده',
    format('SELECT * FROM sales.return_account_preview(%L, %L)', v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', v_line, 'qty', '3'))),
    'تعداد مرجوعی بیش از باقی‌مانده%');
  PERFORM pg_temp.assert_raises('سطر بیگانه',
    format('SELECT * FROM sales.return_account_preview(%L, %L)', v_inv, jsonb_build_array(jsonb_build_object('invoiceLineId', gen_random_uuid(), 'qty', '1'))),
    'سطر مرجوعی به این فاکتور%');
  PERFORM pg_temp.assert_raises('سطر تکراری',
    format('SELECT * FROM sales.return_account_preview(%L, %L)', v_inv, jsonb_build_array(
      jsonb_build_object('invoiceLineId', v_line, 'qty', '1'), jsonb_build_object('invoiceLineId', v_line, 'qty', '1'))),
    'یک سطر فاکتور دو بار%');
  PERFORM pg_temp.assert_eq('STABLE و بی DEFINER',
    (SELECT (provolatile = 's' AND NOT prosecdef)::int FROM pg_proc WHERE oid = 'sales.return_account_preview(uuid, jsonb, numeric)'::regprocedure), 1);
END $test$;

ROLLBACK;
