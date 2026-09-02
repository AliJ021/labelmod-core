-- =====================================================================
-- روش سوم قیمت تمام‌شده: FIFO (مهاجرت ۰۲۰)
-- =====================================================================
-- سناریو با عدد گرد، تا اشتباه در چشم بزند:
--
--   خرید ۱:  ۱۰ عدد × ۱۰۰٬۰۰۰  =  ۱٬۰۰۰٬۰۰۰
--   خرید ۲:  ۱۰ عدد × ۲۰۰٬۰۰۰  =  ۲٬۰۰۰٬۰۰۰
--   فروش ۱:  ۱۵ عدد
--
-- با FIFO بهای فروش = ۱۰×۱۰۰٬۰۰۰ + ۵×۲۰۰٬۰۰۰ = ۲٬۰۰۰٬۰۰۰
-- با میانگین موزون   = ۱۵×۱۵۰٬۰۰۰                = ۲٬۲۵۰٬۰۰۰
-- با آخرین قیمت خرید = ۱۵×۲۰۰٬۰۰۰                = ۳٬۰۰۰٬۰۰۰
--
-- هر سه درست‌اند و هر سه استانداردِ خودشان را دارند. آنچه **نباید**
-- فرق کند، جمع سود در طول عمر کالاست — و همان اینجا سنجیده می‌شود.
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

DO $test$
DECLARE
  BR    uuid := '00000000-0000-7000-8000-000000000001';
  WH    uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_prod uuid; v_var uuid;
  v_qty  platform.qty;
  v_val  platform.money;
  v_cogs platform.money;
  v_n    int;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('fifo_test','تست فایفو') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO catalog.product (code, name_internal) VALUES ('P-FIFO','پیراهن فایفو')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'آبی','L','FIFO-L') RETURNING id INTO v_var;

-- روش را **صریح** انتخاب می‌کنیم. تکیه به پیش‌فرض یعنی یک UPDATE در
-- تنظیمات این تست را قرمز کند.
PERFORM platform.set_setting('costing.method', '"fifo"'::jsonb, 'تست FIFO');
PERFORM pg_temp.assert_txt('روش روی FIFO است',
  platform.setting_text('costing.method'), 'fifo');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. هر ورود یک لایه می‌سازد ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM inventory.apply_movement(v_var, WH, 10, 'purchase_receipt',
  NULL, NULL, v_user, 100000, false, '2026-06-01'::timestamptz);
PERFORM inventory.apply_movement(v_var, WH, 10, 'purchase_receipt',
  NULL, NULL, v_user, 200000, false, '2026-06-10'::timestamptz);

SELECT count(*) INTO v_n FROM inventory.cost_layer
 WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('دو لایه ساخته شد', v_n, 2);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پس از دو خرید', v_qty, 20);
PERFORM pg_temp.assert_eq('ارزش پس از دو خرید', v_val, 3000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. فروش از قدیمی‌ترین لایه می‌خورد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- این ادعای مرکزی FIFO است. اگر بشکند، بهای فروش عدد دیگری می‌دهد و
-- سودِ گزارش‌شده غلط است — بدون اینکه هیچ سندی نامتوازن شود.

SELECT abs(value_delta) INTO v_cogs FROM (
  SELECT (inventory.apply_movement(v_var, WH, -15, 'sale',
            NULL, NULL, v_user, NULL, false, '2026-06-20'::timestamptz)).value_delta
) x(value_delta);

PERFORM pg_temp.assert_eq('بهای فروش FIFO = ۱۰×۱۰۰هزار + ۵×۲۰۰هزار', v_cogs, 2000000);

-- لایه اول باید کاملاً خالی شده باشد و دومی نیمه
PERFORM pg_temp.assert_eq('لایه ۱۰۰هزاری خالی شد',
  (SELECT qty_left FROM inventory.cost_layer
    WHERE variation_id = v_var AND unit_cost = 100000), 0);
PERFORM pg_temp.assert_eq('لایه ۲۰۰هزاری پنج‌تا مانده',
  (SELECT qty_left FROM inventory.cost_layer
    WHERE variation_id = v_var AND unit_cost = 200000), 5);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پس از فروش', v_qty, 5);
PERFORM pg_temp.assert_eq('ارزش باقی‌مانده = ۵×۲۰۰هزار', v_val, 1000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. ثابتِ FIFO: لایه‌ها با موجودی می‌خوانند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- اگر این بشکند، سود بی‌صدا غلط می‌شود. نمای `fifo_check` هست تا این
-- انحراف **دیده** شود، نه اینکه در گزارش بنشیند.

SELECT count(*) INTO v_n FROM inventory.fifo_check
 WHERE variation_id = v_var AND (qty_diff <> 0 OR value_diff <> 0);
PERFORM pg_temp.assert_eq('انحراف لایه از موجودی', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. جمع سود با هر سه روش یکی است ═══';
-- ═══════════════════════════════════════════════════════════════════
-- مهم‌ترین ادعای این فایل، و همان چیزی که `costing.sql` برای دو روش
-- دیگر می‌سنجد. تا کالا تمام شود، جمعِ بهای فروش باید دقیقاً برابر
-- جمعِ بهای خرید باشد — هر روشی که انتخاب شود. فرق روش‌ها **زمان**
-- شناسایی است، نه مقدارش.

-- باقی‌مانده را هم می‌فروشیم تا عمر کالا تمام شود
PERFORM inventory.apply_movement(v_var, WH, -5, 'sale',
  NULL, NULL, v_user, NULL, false, '2026-06-25'::timestamptz);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی صفر شد', v_qty, 0);
PERFORM pg_temp.assert_eq('ارزش هم صفر شد — نه ریالی جامانده', v_val, 0);

SELECT sum(value_delta) INTO v_val FROM inventory.stock_movement
 WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('جمع ارزش ورودی و خروجی صفر است', v_val, 0);

SELECT -sum(value_delta) INTO v_cogs FROM inventory.stock_movement
 WHERE variation_id = v_var AND warehouse_id = WH AND qty < 0;
PERFORM pg_temp.assert_eq('جمع بهای فروش = جمع بهای خرید', v_cogs, 3000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. سوییچ وسط عمر کالا — کاشت تنبل لایه ═══';
-- ═══════════════════════════════════════════════════════════════════
-- کسی که امروز با میانگین موزون کار می‌کند و فردا به FIFO سوییچ کند،
-- موجودی دارد ولی لایه ندارد. به‌جای یک مهاجرت داده که فقط یک بار
-- اجرا می‌شود، لایه در اولین خروج به نرخ میانگین جاری ساخته می‌شود.

PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb, 'برگشت موقت');

INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سبز','M','FIFO-SWITCH') RETURNING id INTO v_var;

PERFORM inventory.apply_movement(v_var, WH, 10, 'purchase_receipt',
  NULL, NULL, v_user, 100000, false, '2026-07-01'::timestamptz);

PERFORM platform.set_setting('costing.method', '"fifo"'::jsonb, 'سوییچ به FIFO');

-- لایه ورود از قبل ساخته شده بود (هر ورود لایه می‌سازد، حتی وقتی روش
-- FIFO نیست) — پس سوییچ بدون کاشت هم کار می‌کند.
PERFORM pg_temp.assert_eq('لایه ورودِ پیش از سوییچ موجود است',
  (SELECT count(*) FROM inventory.cost_layer WHERE variation_id = v_var), 1);

SELECT abs(value_delta) INTO v_cogs FROM (
  SELECT (inventory.apply_movement(v_var, WH, -4, 'sale',
            NULL, NULL, v_user, NULL, false, '2026-07-05'::timestamptz)).value_delta
) x(value_delta);
PERFORM pg_temp.assert_eq('فروش پس از سوییچ، از لایه خورد', v_cogs, 400000);

SELECT count(*) INTO v_n FROM inventory.fifo_check
 WHERE variation_id = v_var AND (qty_diff <> 0 OR value_diff <> 0);
PERFORM pg_temp.assert_eq('پس از سوییچ هم لایه با موجودی می‌خواند', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. مرجوعی لایه تازه می‌سازد، نه لایه قدیمی ═══';
-- ═══════════════════════════════════════════════════════════════════
-- قاعده پروژه: مرجوعی با بهای **همان فروش** برمی‌گردد. پس ورودش نرخ
-- صریح دارد و یک لایه تازه می‌سازد — نه اینکه لایه‌ای که خالی شده را
-- دوباره پر کند، که ترتیب FIFO را به‌هم می‌زد.

PERFORM inventory.apply_movement(v_var, WH, 2, 'sale_return',
  NULL, NULL, v_user, 100000, false, '2026-07-06'::timestamptz);

PERFORM pg_temp.assert_eq('مرجوعی لایه تازه ساخت',
  (SELECT count(*) FROM inventory.cost_layer WHERE variation_id = v_var), 2);

SELECT count(*) INTO v_n FROM inventory.fifo_check
 WHERE variation_id = v_var AND (qty_diff <> 0 OR value_diff <> 0);
PERFORM pg_temp.assert_eq('پس از مرجوعی هم می‌خواند', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف Projection با حرکت‌ها', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.fifo_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('انحراف لایه در کل انبار', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.cost_layer WHERE qty_left > qty_in OR qty_left < 0;
PERFORM pg_temp.assert_eq('لایه با باقی‌مانده نامعتبر', v_n, 0);

RAISE NOTICE E'\n✔ FIFO — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
