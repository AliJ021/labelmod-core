-- =====================================================================
-- تناسب سایز — «کدام کالا به این شخص می‌خورد؟»
-- =====================================================================
-- سه چیزی که یک پیاده‌سازی ساده‌انگارانه در آن‌ها می‌شکند:
--
--   ۱. کالای بدون اندازه **حذف** شود → نصف ویترین ناپیدا
--   ۲. کلید نامشترک امتیاز را نصف کند → کالای کم‌اندازه جریمه شود
--   ۳. تحمل ثابت باشد → ۲ سانت روی سینه و روی کفش یکی شمرده شود
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(p_label text, p_actual numeric, p_expected numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual::text,'NULL');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual,'NULL');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_label text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % — رد شد: %', p_label, left(SQLERRM, 70); RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ % — باید رد می‌شد ولی نشد', p_label;
END $$;

DO $outer$
DECLARE
  BR uuid; WH uuid; v_user uuid; v_sup uuid; v_prod uuid;
  v_fit uuid; v_near uuid; v_far uuid; v_blank uuid; v_gone uuid;
  v_rcpt uuid; v_cust uuid; v_n numeric; v_i int; v_t text;
BEGIN
  SELECT id INTO BR FROM platform.branch WHERE code='MAIN';
  SELECT id INTO WH FROM inventory.warehouse WHERE code='STORE';
  SELECT id INTO v_user FROM identity.app_user WHERE username='system';
  PERFORM platform.set_actor(v_user, NULL, NULL);

  RAISE NOTICE E'\n═══ ۱. تحمل به‌ازای هر اندازه، نه یک عدد ثابت ═══';
  -- دو سانت روی سینه هیچ است، روی کفش یک سایز کامل.
  SELECT tolerance_cm INTO v_n FROM sales.measure_key WHERE key='chest';
  PERFORM pg_temp.assert_eq('تحمل دور سینه', v_n, 4.0);
  SELECT tolerance_cm INTO v_n FROM sales.measure_key WHERE key='foot_length';
  PERFORM pg_temp.assert_eq('تحمل طول کف پا', v_n, 0.7);

  RAISE NOTICE E'\n═══ ۲. کلید اندازه کالا از همان فهرست می‌آید ═══';
  INSERT INTO purchasing.supplier (code,name) VALUES ('S-FIT','تأمین سایز') RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code,name_internal) VALUES ('P-FIT','پیراهن سایز') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'سفید','M','FIT-M') RETURNING id INTO v_fit;
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'سفید','L','FIT-L') RETURNING id INTO v_near;
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'سفید','XXL','FIT-XXL') RETURNING id INTO v_far;
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'سفید','S','FIT-S') RETURNING id INTO v_blank;

  -- کلید نامعتبر رد می‌شود: اگر کالا `dour_sine` بنویسد و مشتری
  -- `chest`، هرگز با هم مقایسه نمی‌شوند و نتیجه بی‌صدا خالی می‌ماند.
  PERFORM pg_temp.assert_raises('کلید اندازه تعریف‌نشده رد می‌شود',
    format($q$INSERT INTO catalog.variation_measure (variation_id,key,value_cm)
              VALUES (%L::uuid,'dour_sine',100)$q$, v_fit));

  INSERT INTO catalog.variation_measure (variation_id,key,value_cm) VALUES
    (v_fit,  'chest', 100), (v_fit,  'waist', 84),
    (v_near, 'chest', 104), (v_near, 'waist', 88),
    (v_far,  'chest', 120), (v_far,  'waist', 108);
  -- v_blank عمداً هیچ اندازه‌ای ندارد.

  INSERT INTO purchasing.receipt (number,branch_id,supplier_id,warehouse_id,occurred_at)
  VALUES (platform.next_document_no(BR,'purchase',1405::smallint),BR,v_sup,WH,now())
  RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id,variation_id,qty,unit_price,line_amount)
  VALUES (v_rcpt,v_fit,5,300000,1500000), (v_rcpt,v_near,5,300000,1500000),
         (v_rcpt,v_far,5,300000,1500000), (v_rcpt,v_blank,5,300000,1500000);
  PERFORM purchasing.post_receipt(v_rcpt,v_user);

  INSERT INTO sales.customer (mobile_normalized, full_name)
  VALUES ('09141110001','مشتری سایز') RETURNING id INTO v_cust;
  PERFORM sales.set_customer_measures(v_cust,
    '{"chest": 100, "waist": 84, "height": 175}'::jsonb, v_user);

  RAISE NOTICE E'\n═══ ۳. امتیاز تناسب ═══';
  SELECT score, matched_keys INTO v_n, v_i FROM catalog.fit_score(v_fit, v_cust);
  PERFORM pg_temp.assert_eq('اندازه دقیقاً برابر → امتیاز کامل', v_n, 1.000);
  -- ⚠️ فقط دو کلید مشترک شمرده شد، نه سه: کالا «قد» ندارد و نبودش
  --    نباید امتیاز را نصف کند.
  PERFORM pg_temp.assert_eq('فقط کلیدهای مشترک شمرده شدند', v_i, 2);

  SELECT score INTO v_n FROM catalog.fit_score(v_near, v_cust);
  -- سینه ۴ اختلاف با تحمل ۴ → صفر؛ کمر ۴ اختلاف با تحمل ۴ → صفر.
  PERFORM pg_temp.assert_eq('یک سایز بالاتر، لبه تحمل', v_n, 0.000);

  SELECT score INTO v_n FROM catalog.fit_score(v_far, v_cust);
  PERFORM pg_temp.assert_eq('خیلی بزرگ‌تر → صفر', v_n, 0.000);

  RAISE NOTICE E'\n═══ ۴. «اندازه ندارد» با «نمی‌خورد» یکی نیست ═══';
  SELECT count(*) INTO v_n FROM catalog.fit_score(v_blank, v_cust);
  PERFORM pg_temp.assert_eq('کالای بی‌اندازه سطری برنمی‌گرداند', v_n, 0);

  RAISE NOTICE E'\n═══ ۵. فهرست پیشنهاد ═══';
  SELECT count(*) INTO v_n FROM catalog.fitting_variations(v_cust, WH);
  PERFORM pg_temp.assert_eq('هر چهار کالای موجود می‌آیند', v_n, 4);

  -- ⚠️ مهم‌ترین ادعا: کالای بدون اندازه **حذف نمی‌شود**، فقط آخر
  --    می‌نشیند. حذفش یعنی فروشگاه نصف ویترینش را نشان ندهد چون
  --    انباردار هنوز اندازه‌ها را وارد نکرده.
  SELECT match_score INTO v_n FROM catalog.fitting_variations(v_cust, WH)
   WHERE variation_id = v_blank;
  PERFORM pg_temp.assert_eq('کالای بی‌اندازه NULL می‌گیرد، نه صفر', v_n, NULL);

  SELECT sku INTO v_t FROM catalog.fitting_variations(v_cust, WH) LIMIT 1;
  PERFORM pg_temp.assert_txt('بهترین تناسب اول فهرست', v_t, 'FIT-M');

  -- و NULL آخر می‌نشیند، نه اول.
  SELECT sku INTO v_t FROM (
    SELECT sku, row_number() OVER () AS rn FROM catalog.fitting_variations(v_cust, WH)
  ) t WHERE rn = 4;
  PERFORM pg_temp.assert_txt('کالای بی‌اندازه آخر فهرست', v_t, 'FIT-S');

  RAISE NOTICE E'\n═══ ۶. فیلتر حداقل امتیاز ═══';
  SELECT count(*) INTO v_n FROM catalog.fitting_variations(v_cust, WH, 0.5);
  PERFORM pg_temp.assert_eq('فقط کالای واقعاً مناسب', v_n, 1);

  RAISE NOTICE E'\n═══ ۷. کالای ناموجود پیشنهاد نمی‌شود ═══';
  -- پیشنهاد سایزی که در قفسه نیست، مشتری را سر کار می‌گذارد.
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'سفید','XL','FIT-XL') RETURNING id INTO v_gone;
  INSERT INTO catalog.variation_measure (variation_id,key,value_cm)
  VALUES (v_gone,'chest',100), (v_gone,'waist',84);
  SELECT count(*) INTO v_n FROM catalog.fitting_variations(v_cust, WH)
   WHERE variation_id = v_gone;
  PERFORM pg_temp.assert_eq('کالای بدون موجودی، حتی با تناسب کامل', v_n, 0);

  RAISE NOTICE E'\n═══ ۸. تحمل قابل تغییر است، بدون Deploy ═══';
  UPDATE sales.measure_key SET tolerance_cm = 12 WHERE key IN ('chest','waist');
  SELECT score INTO v_n FROM catalog.fit_score(v_near, v_cust);
  -- با تحمل ۱۲، اختلاف ۴ یعنی ۱ − ۴/۱۲ = ۰٫۶۶۷
  PERFORM pg_temp.assert_eq('با تحمل بزرگ‌تر، همان کالا مناسب شد', v_n, 0.667);

  RAISE NOTICE E'\n═══ ۹. مشتری بدون اندازه ═══';
  INSERT INTO sales.customer (mobile_normalized, full_name)
  VALUES ('09141110002','بدون اندازه') RETURNING id INTO v_cust;
  SELECT count(*) INTO v_n FROM catalog.fitting_variations(v_cust, WH);
  -- فهرست خالی نمی‌شود — همه کالاها با امتیاز NULL می‌آیند. مشتری
  -- تازه که هنوز اندازه‌اش را نداده، نباید ویترین خالی ببیند.
  PERFORM pg_temp.assert_eq('ویترین خالی نمی‌شود', v_n, 4);
  SELECT count(*) INTO v_n FROM catalog.fitting_variations(v_cust, WH)
   WHERE match_score IS NOT NULL;
  PERFORM pg_temp.assert_eq('ولی هیچ امتیازی هم ندارد', v_n, 0);

  RAISE NOTICE E'\n✓ تناسب سایز — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
