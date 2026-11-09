-- =====================================================================
-- تست پیش‌نمایش برگشت از خرید (مهاجرت ۱۱۵)
-- =====================================================================
-- ادعای مرکزی: **پیش‌نمایش همان عددی است که ثبت می‌نشاند.** هر سناریو
-- اول `purchase_return_preview` را می‌خواند، بعد همان برگه را با
-- `post_purchase_return` ثبت می‌کند و پنج عدد را با ستون‌های ثبت‌شده و سطر
-- بدهی سند مقایسه می‌کند.
--
-- سناریوها عمداً جاهایی‌اند که فرمول ساده (`qty × بها`) اشتباه می‌کند:
--   ۱. مالیات غیرصفر روی رسید — کاهش بدهی = کالا + سهم مالیات.
--   ۲. نرخ گرد‌نشونده و حمل تسهیم‌شده — گرد کردن سطر به سطر.
--   ۳. برگشت آخرین تکهٔ یک سطر — باقی‌ماندهٔ گرد کردن را می‌برد.
--   ۴. برگشت دوم روی همان رسید — مالیات از جمع برگشت‌های قبلی کم می‌شود.
-- کنترل حساسیت: در سناریوی ۳ فرمول ساده با عدد ثبت‌شده **فرق دارد**؛ اگر
-- نداشت، این آزمون چیزی را از «جمع در مرورگر» جدا نمی‌کرد.
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
    IF SQLERRM NOT LIKE p_like THEN
      RAISE EXCEPTION E'\n  ✗ %\n      پیام نادرست: %', p_label, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 78);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- پیش‌نمایش، ثبت، و مقایسهٔ پنج عدد. برمی‌گرداند: کاهش بدهی ثبت‌شده.
CREATE OR REPLACE FUNCTION pg_temp.preview_then_post(p_label text, p_receipt uuid, p_lines jsonb, p_user uuid)
RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
  pv record; r purchasing.purchase_return%ROWTYPE; v_ret uuid; v_entry uuid; v_payable numeric; x jsonb;
BEGIN
  SELECT * INTO pv FROM purchasing.purchase_return_preview(p_receipt, p_lines);
  INSERT INTO purchasing.purchase_return (branch_id, receipt_id, warehouse_id, reason_code, occurred_at)
  SELECT branch_id, id, warehouse_id, 'quality', '2026-06-06' FROM purchasing.receipt WHERE id = p_receipt
  RETURNING id INTO v_ret;
  FOR x IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
    VALUES (v_ret, (x->>'receiptLineId')::uuid, (x->>'qty')::numeric);
  END LOOP;
  v_entry := purchasing.post_purchase_return(v_ret, p_user);
  SELECT * INTO r FROM purchasing.purchase_return WHERE id = v_ret;
  SELECT coalesce(sum(debit), 0) INTO v_payable FROM ledger.journal_line WHERE entry_id = v_entry AND account_code = '2101';
  PERFORM pg_temp.assert_eq(p_label || ' — بهای کالا', pv.goods_amount, r.goods_amount);
  PERFORM pg_temp.assert_eq(p_label || ' — ارزش دفتری', pv.cost_amount, r.cost_amount);
  PERFORM pg_temp.assert_eq(p_label || ' — مالیات', pv.tax_amount, r.tax_amount);
  PERFORM pg_temp.assert_eq(p_label || ' — حمل برنگشتنی', pv.charge_loss, r.charge_loss);
  PERFORM pg_temp.assert_eq(p_label || ' — کاهش بدهی (سطر ۲۱۰۱ سند)', pv.payable_reduction, v_payable);
  RETURN v_payable;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_b uuid; v_rcpt uuid; v_la uuid; v_lb uuid;
  v_payable numeric; v_naive numeric; v_cost numeric;
BEGIN
  RAISE NOTICE E'\n═══ آماده‌سازی ═══';
  INSERT INTO identity.app_user (username, full_name) VALUES ('pretpreview', 'تست پیش‌نمایش برگشت') RETURNING id INTO v_user;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user, 'admin', BR);
  PERFORM platform.set_actor(v_user);
  PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb, 'تست: پیش‌نمایش برگشت از خرید', v_user);

  INSERT INTO purchasing.supplier (code, name) VALUES ('S-PRV', 'تأمین‌کنندهٔ پیش‌نمایش') RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-PRV', 'کالای پیش‌نمایش') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, sku, barcode, color, size) VALUES (v_prod, 'PRV-1', '2000000000916', 'مشکی', 'L') RETURNING id INTO v_a;
  INSERT INTO catalog.variation (product_id, sku, barcode, color, size) VALUES (v_prod, 'PRV-2', '2000000000923', 'سفید', 'M') RETURNING id INTO v_b;

  -- ۳ عدد × ۳۳۳٬۳۳۳ و ۷ عدد × ۱٬۰۰۰٬۰۰۱؛ حمل ۱۰۰٬۰۰۰ به نسبت مبلغ؛ مالیات ۷۷۷٬۷۷۷.
  INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at, tax_amount)
  VALUES (BR, v_sup, WH, '2026-06-01', 777777) RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
  VALUES (v_rcpt, v_a, 3, 333333, 999999) RETURNING id INTO v_la;
  INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
  VALUES (v_rcpt, v_b, 7, 1000001, 7000007) RETURNING id INTO v_lb;
  INSERT INTO purchasing.receipt_charge (receipt_id, charge_type, amount, allocation, paid_from, payee_type)
  VALUES (v_rcpt, 'حمل', 100000, 'by_value', 'payable', 'other');
  PERFORM purchasing.post_receipt(v_rcpt, v_user);

  RAISE NOTICE E'\n═══ ۰. ورودی نادرست، همان پیام ثبت ═══';
  PERFORM pg_temp.assert_raises('بیش از رسیدشده',
    format('SELECT * FROM purchasing.purchase_return_preview(%L, %L)', v_rcpt, jsonb_build_array(jsonb_build_object('receiptLineId', v_la, 'qty', '4'))),
    'بیشتر از آنچه رسید شده%');
  PERFORM pg_temp.assert_raises('سطر رسید دیگر',
    format('SELECT * FROM purchasing.purchase_return_preview(%L, %L)', v_rcpt, jsonb_build_array(jsonb_build_object('receiptLineId', gen_random_uuid(), 'qty', '1'))),
    'سطر برگشت به هیچ سطری%');
  PERFORM pg_temp.assert_raises('سطر تکراری',
    format('SELECT * FROM purchasing.purchase_return_preview(%L, %L)', v_rcpt, jsonb_build_array(
      jsonb_build_object('receiptLineId', v_la, 'qty', '1'), jsonb_build_object('receiptLineId', v_la, 'qty', '1'))),
    'یک سطر رسید دو بار%');
  PERFORM pg_temp.assert_raises('بی قلم',
    format('SELECT * FROM purchasing.purchase_return_preview(%L, %L)', v_rcpt, '[]'), 'برگ برگشت بدون قلم%');
  PERFORM pg_temp.assert_raises('تعداد صفر',
    format('SELECT * FROM purchasing.purchase_return_preview(%L, %L)', v_rcpt, jsonb_build_array(jsonb_build_object('receiptLineId', v_la, 'qty', '0'))),
    'تعداد باید بزرگ‌تر%');

  RAISE NOTICE E'\n═══ ۱ و ۲. برگشت جزئی با مالیات و گرد کردن ═══';
  v_payable := pg_temp.preview_then_post('برگشت اول', v_rcpt, jsonb_build_array(
    jsonb_build_object('receiptLineId', v_la, 'qty', '1'), jsonb_build_object('receiptLineId', v_lb, 'qty', '2')), v_user);
  PERFORM pg_temp.assert_eq('کاهش بدهی بیش از بهای کالاست (مالیات دارد)',
    (v_payable > (SELECT goods_amount FROM purchasing.purchase_return WHERE receipt_id = v_rcpt AND status = 'posted'))::int, 1);

  RAISE NOTICE E'\n═══ ۳ و ۴. برگشت آخرین تکه، برگشت دوم روی همان رسید ═══';
  -- کنترل حساسیت: فرمول ساده «تعداد × بهای دفتری واحد» برای آخرین تکه با عدد ثبت‌شده فرق دارد.
  SELECT round(landed_unit_cost * 2) INTO v_naive FROM purchasing.receipt_line WHERE id = v_la;
  SELECT cost_amount INTO v_cost FROM purchasing.purchase_return_preview(v_rcpt, jsonb_build_array(jsonb_build_object('receiptLineId', v_la, 'qty', '2')));
  IF v_naive = v_cost THEN
    RAISE EXCEPTION E'\n  ✗ کنترل حساسیت: فرمول ساده (%) با پیش‌نمایش آخرین تکه (%) فرق ندارد؛ سناریو چیزی نمی‌سنجد', v_naive, v_cost;
  END IF;
  RAISE NOTICE '  ✓ کنترل حساسیت: تعداد × بهای واحد = % ولی آخرین تکه = %', v_naive, v_cost;
  PERFORM pg_temp.preview_then_post('برگشت دوم (آخرین تکهٔ سطر اول)', v_rcpt, jsonb_build_array(
    jsonb_build_object('receiptLineId', v_la, 'qty', '2'), jsonb_build_object('receiptLineId', v_lb, 'qty', '5')), v_user);
  PERFORM pg_temp.assert_eq('کل سطرها برگشت؛ ارزش دفتری کل = مبلغ سطر + سهم حمل',
    (SELECT sum(cost_amount) FROM purchasing.purchase_return WHERE receipt_id = v_rcpt AND status = 'posted'),
    (SELECT sum(line_amount + charge_alloc) FROM purchasing.receipt_line WHERE receipt_id = v_rcpt));
  PERFORM pg_temp.assert_eq('کل مالیات رسید برگشت',
    (SELECT sum(tax_amount) FROM purchasing.purchase_return WHERE receipt_id = v_rcpt AND status = 'posted'), 777777);

  RAISE NOTICE E'\n═══ ۵. پیش‌نمایش چیزی نمی‌نویسد و قفلی نمی‌گیرد ═══';
  PERFORM pg_temp.assert_eq('تابع STABLE است',
    (SELECT (provolatile = 's')::int FROM pg_proc WHERE oid = 'purchasing.purchase_return_preview(uuid, jsonb)'::regprocedure), 1);
  PERFORM pg_temp.assert_eq('تابع SECURITY DEFINER نیست',
    (SELECT (NOT prosecdef)::int FROM pg_proc WHERE oid = 'purchasing.purchase_return_preview(uuid, jsonb)'::regprocedure), 1);
END $test$;

ROLLBACK;
