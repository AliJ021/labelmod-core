-- =====================================================================
-- کمبود موجودی (۱۰۴): یک تعریف برای داشبورد و گزارش
-- =====================================================================
-- هر مرز تعریف یک سطر دارد که **باید** بیرون بماند، کنار سطری که باید
-- بیاید — وگرنه تابعی که همه‌چیز یا هیچ‌چیز برمی‌گرداند هم «پاس» می‌شد:
--   مرز آستانه (= و +۱)، رزرو، کف صفر، انبار معیوب و در راه و غیرفعال،
--   کالای بایگانی و تنوع غیرفعال، تنوع ردیابی‌نشده، و آستانهٔ NULL (نامعلوم).
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

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual,'NULL');
END $$;

DO $outer$
DECLARE
  BR CONSTANT uuid := '00000000-0000-7000-8000-000000000001';
  STORE CONSTANT uuid := '00000000-0000-7000-8000-000000000101';
  STOCK CONSTANT uuid := '00000000-0000-7000-8000-000000000102';
  DEFECT CONSTANT uuid := '00000000-0000-7000-8000-000000000103';
  v_user uuid; v_prod uuid; v_off uuid; v_transit uuid; v_idle uuid;
  v_eq uuid; v_over uuid; v_res uuid; v_zero uuid; v_neg uuid; v_def uuid; v_tr uuid; v_in uuid;
  v_paused uuid; v_offv uuid; v_untracked uuid;
  v_n numeric; v_t text;
BEGIN
  INSERT INTO identity.app_user (username, full_name) VALUES ('lowstock','تست کمبود') RETURNING id INTO v_user;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',NULL);
  PERFORM platform.set_actor(v_user);

  INSERT INTO inventory.warehouse (branch_id, code, name, kind) VALUES (BR,'LS-TR','در راه','transit') RETURNING id INTO v_transit;
  INSERT INTO inventory.warehouse (branch_id, code, name, kind, is_active) VALUES (BR,'LS-IDLE','غیرفعال','store', false) RETURNING id INTO v_idle;

  INSERT INTO catalog.product (code, name_internal) VALUES ('P-LS','کالای کمبود') RETURNING id INTO v_prod;
  INSERT INTO catalog.product (code, name_internal, status) VALUES ('P-LS-OFF','کالای بایگانی','archived') RETURNING id INTO v_off;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES
    (v_prod,'آبی','S','LS-EQ') RETURNING id INTO v_eq;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'آبی','M','LS-OVER') RETURNING id INTO v_over;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'آبی','L','LS-RES') RETURNING id INTO v_res;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'آبی','XL','LS-ZERO') RETURNING id INTO v_zero;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'سبز','S','LS-NEG') RETURNING id INTO v_neg;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'سبز','M','LS-DEF') RETURNING id INTO v_def;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'سبز','L','LS-TRN') RETURNING id INTO v_tr;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'سبز','XL','LS-IDL') RETURNING id INTO v_in;
  INSERT INTO catalog.variation (product_id, color, size, sku, status) VALUES (v_prod,'قرمز','S','LS-PAUSED','paused') RETURNING id INTO v_paused;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_off,'قرمز','M','LS-OFFPROD') RETURNING id INTO v_offv;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'قرمز','L','LS-UNTRACKED') RETURNING id INTO v_untracked;

  -- موجودی فقط از دروازهٔ خودش (opening تنها حرکت بی‌مرجع است).
  PERFORM inventory.apply_movement(v_eq, STORE, 2, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_over, STORE, 3, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_res, STORE, 5, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_zero, STORE, 1, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_zero, STORE, -1, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_neg, STOCK, 4, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_def, DEFECT, 1, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_tr, v_transit, 1, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_in, v_idle, 1, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_paused, STORE, 1, 'opening', p_user => v_user, p_unit_cost => 1000);
  PERFORM inventory.apply_movement(v_offv, STORE, 1, 'opening', p_user => v_user, p_unit_cost => 1000);
  -- رزرو: ۵ فیزیکی، ۴ رزرو → قابل‌فروش ۱. و یکی رزروِ بیش از فیزیکی (کف صفر): ۴ فیزیکی، ۶ رزرو.
  -- ستون رزرو را فقط مسیرهای رزرو می‌نویسند؛ اینجا داده‌ساز آزمون است و نگهبان رزرو (۰۹۲) فقط کاهش on_hand را می‌پاید.
  UPDATE inventory.stock_balance SET reserved = 4 WHERE variation_id = v_res AND warehouse_id = STORE;
  UPDATE inventory.stock_balance SET reserved = 6 WHERE variation_id = v_neg AND warehouse_id = STOCK;

  RAISE NOTICE E'\n═══ ۱. پیش‌فرض آستانه ۲ است و از تنظیم خوانده می‌شود ═══';
  PERFORM pg_temp.assert_eq('آستانهٔ پیش‌فرض', platform.setting_num('inventory.low_stock_threshold'), 2);

  RAISE NOTICE E'\n═══ ۲. با آستانهٔ ۲: مرز، رزرو، صفر و کف صفر داخل؛ ۳ بیرون ═══';
  SELECT string_agg(v.sku || '@' || l.available::text, ',' ORDER BY v.sku) INTO v_t
    FROM inventory.low_stock(2) l JOIN catalog.variation v ON v.id = l.variation_id
   WHERE v.sku LIKE 'LS-%';
  PERFORM pg_temp.assert_txt('سطرهای کمبود', v_t, 'LS-EQ@2.000,LS-NEG@0.000,LS-RES@1.000,LS-ZERO@0.000');

  RAISE NOTICE E'\n═══ ۳. آستانهٔ ۳: همان مرز، حالا LS-OVER هم داخل ═══';
  SELECT count(*) INTO v_n FROM inventory.low_stock(3) l JOIN catalog.variation v ON v.id = l.variation_id WHERE v.sku LIKE 'LS-%';
  PERFORM pg_temp.assert_eq('با آستانهٔ ۳', v_n, 5);
  RAISE NOTICE E'\n═══ ۴. آستانهٔ صفر: فقط ناموجودها ═══';
  SELECT count(*) INTO v_n FROM inventory.low_stock(0) l JOIN catalog.variation v ON v.id = l.variation_id WHERE v.sku LIKE 'LS-%';
  PERFORM pg_temp.assert_eq('با آستانهٔ صفر', v_n, 2);

  RAISE NOTICE E'\n═══ ۵. بیرون‌ها: معیوب، در راه، انبار غیرفعال، تنوع متوقف، کالای بایگانی، ردیابی‌نشده ═══';
  SELECT count(*) INTO v_n FROM inventory.low_stock(1000) l
   WHERE l.variation_id IN (v_def, v_tr, v_in, v_paused, v_offv, v_untracked);
  PERFORM pg_temp.assert_eq('هیچ‌کدام حتی با آستانهٔ بزرگ', v_n, 0);
  -- کنترل مثبت: همان آستانهٔ بزرگ همهٔ پنج سطر ردیابی‌شدهٔ فعال را می‌آورد، پس صفرِ بالا از خالی‌بودن تابع نیست.
  SELECT count(*) INTO v_n FROM inventory.low_stock(1000) l JOIN catalog.variation v ON v.id = l.variation_id WHERE v.sku LIKE 'LS-%';
  PERFORM pg_temp.assert_eq('کنترل مثبت: آستانهٔ بزرگ', v_n, 5);

  RAISE NOTICE E'\n═══ ۶. آستانهٔ NULL (نامعلوم) هیچ سطری نمی‌دهد — مصرف‌کننده باید آن را جدا بگوید ═══';
  SELECT count(*) INTO v_n FROM inventory.low_stock(NULL);
  PERFORM pg_temp.assert_eq('NULL → بی سطر', v_n, 0);

  RAISE NOTICE E'\n═══ ۷. شعبه از انبار می‌آید ═══';
  SELECT count(DISTINCT l.branch_id) INTO v_n FROM inventory.low_stock(2) l JOIN catalog.variation v ON v.id = l.variation_id WHERE v.sku LIKE 'LS-%';
  PERFORM pg_temp.assert_eq('همه در شعبهٔ اصلی', v_n, 1);

  RAISE NOTICE E'\n═══ ۸. تنظیم از مسیر رسمی عوض می‌شود و بازه دارد ═══';
  PERFORM platform.set_setting('inventory.low_stock_threshold', '5'::jsonb, 'آزمون آستانه', v_user);
  PERFORM pg_temp.assert_eq('آستانهٔ تازه', platform.setting_num('inventory.low_stock_threshold'), 5);
  BEGIN
    PERFORM platform.set_setting('inventory.low_stock_threshold', '-1'::jsonb, 'آزمون منفی', v_user);
    RAISE EXCEPTION 'آستانهٔ منفی باید رد می‌شد';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'آستانهٔ منفی باید رد می‌شد' THEN RAISE; END IF;
    RAISE NOTICE '  ✓ آستانهٔ منفی رد شد: %', left(SQLERRM, 60);
  END;

  RAISE NOTICE E'\n✓ کمبود موجودی — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
