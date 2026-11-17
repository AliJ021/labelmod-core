-- =====================================================================
-- تست نگه‌داشت موجودی هنگام پرداخت آنلاین — مهاجرت ۱۲۵
-- =====================================================================
-- ثابت این پرونده: **یک قلم آخر را دو نفر نمی‌خرند.** از لحظهٔ نگه‌داشت تا
-- پرداخت (یا انقضا) صندوق نمی‌فروشدش و مشتری آنلاین دوم نمی‌تواند نگهش دارد؛
-- اگر صندوق زودتر فروخته باشد، نگه‌داشت پیش از رفتن به بانک رد می‌شود.
--
-- ⚠️ بند ۱ عدد سایت را می‌سنجد: نگه‌داشت **نباید** عدد سایت را عوض کند، وگرنه
--    خود همان مشتری در «پرداخت دوباره» با «موجودی کافی نیست» رد می‌شد.
-- ⚠️ بند ۲ و ۳ کنترل‌های اصلی‌اند؛ بند ۵ کنترل منفی: پس از ثبت سفارش، صندوق
--    دیگر با «رزرو سایت» رد نمی‌شود بلکه با نبودِ کالا.
-- ⚠️ بند ۷ ادعای «یا همه یا هیچ» است: کمبود یک قلم، قلم دیگر را هم نگه نمی‌دارد.
-- ⚠️ بند ۱۰ آزادسازی دوباره را می‌سنجد: سطری که دو مسیر هم‌زمان آزاد کنند
--    فقط یک بار از reserved کم می‌شود.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text, p_like text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE p_like THEN
      RAISE EXCEPTION E'\n  ✗ %\n      انتظار خطا مثل: %\n      واقعی : %', p_label, p_like, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- «on_hand reserved checkout_held» یک کالا در انبار فروشگاه.
CREATE OR REPLACE FUNCTION pg_temp.bal(p_sku text) RETURNS text LANGUAGE sql AS $$
  SELECT trim_scale(b.on_hand) || ' ' || trim_scale(b.reserved) || ' ' || trim_scale(b.checkout_held)
    FROM inventory.stock_balance b JOIN catalog.variation v ON v.id = b.variation_id
   WHERE v.sku = p_sku AND b.warehouse_id = '00000000-0000-7000-8000-000000000101'
$$;
-- عدد سایت از **خودِ** Push: آخرین پیام صف برای این کالا.
CREATE OR REPLACE FUNCTION pg_temp.pushed(p_sku text) RETURNS text LANGUAGE sql AS $$
  SELECT m.payload->>'onHand' FROM platform.outbox_message m
   WHERE m.topic = 'web.stock_push' AND m.payload->>'sku' = p_sku
   ORDER BY (m.payload->>'version')::bigint DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION pg_temp.pushes(p_sku text) RETURNS text LANGUAGE sql AS $$
  SELECT count(*)::text FROM platform.outbox_message m
   WHERE m.topic = 'web.stock_push' AND m.payload->>'sku' = p_sku
$$;
CREATE OR REPLACE FUNCTION pg_temp.lines(p_sku text, p_qty text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('sku', p_sku, 'qty', p_qty))
$$;

DO $test$
DECLARE
  BR  uuid := '00000000-0000-7000-8000-000000000001';
  WH  uuid := '00000000-0000-7000-8000-000000000101';
  v_actor uuid; v_prod uuid; v1 uuid; v2 uuid; v3 uuid;
  r jsonb; v_rev bigint; v_exp timestamptz; v_line uuid;
BEGIN

INSERT INTO identity.app_user(username,full_name,is_active)
  VALUES('sql-hold-125','کلاینت آزمون نگه‌داشت',false) RETURNING id INTO v_actor;
INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(v_actor,'web',BR);
PERFORM platform.set_actor(v_actor);
PERFORM platform.set_setting('web.push_enabled', 'true', 'آزمون', v_actor);
PERFORM platform.set_setting('web.stock_warehouse', '"STORE"', 'آزمون', v_actor);

INSERT INTO catalog.product(code,name_internal) VALUES('P-HOLD','آزمون نگه‌داشت') RETURNING id INTO v_prod;
INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(v_prod,'HOLD-1','مشکی','S') RETURNING id INTO v1;
INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(v_prod,'HOLD-2','مشکی','M') RETURNING id INTO v2;
INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(v_prod,'HOLD-3','مشکی','L') RETURNING id INTO v3;
-- تک‌قلم، مثل بیشتر کالاهای فروشگاه.
PERFORM inventory.apply_movement(v1,WH,1,'opening',NULL,NULL,v_actor,1000000);
PERFORM inventory.apply_movement(v2,WH,2,'opening',NULL,NULL,v_actor,1000000);
PERFORM inventory.apply_movement(v3,WH,3,'opening',NULL,NULL,v_actor,1000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. نگه‌داشت تک‌قلم؛ عدد سایت عوض نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
PERFORM pg_temp.assert_eq('پیش از نگه‌داشت', pg_temp.bal('HOLD-1'), '1 0 0');
PERFORM pg_temp.assert_eq('عدد سایت پیش از نگه‌داشت', pg_temp.pushed('HOLD-1'), '1');
SELECT row_version INTO v_rev FROM inventory.stock_balance WHERE variation_id=v1 AND warehouse_id=WH;
r := inventory.web_checkout_hold(v_actor,'WOO-A',BR,WH,pg_temp.lines('HOLD-1','1'));
PERFORM pg_temp.assert_eq('نگه‌داشت سفارش A', r->>'status', 'held');
PERFORM pg_temp.assert_eq('سهم در reserved و checkout_held', pg_temp.bal('HOLD-1'), '1 1 1');
PERFORM pg_temp.assert_eq('نگه‌داشت Push تازه نمی‌سازد', pg_temp.pushes('HOLD-1'), '1');
-- واترمارک (Trigger ۰۹۷) با هر تغییر reserved جلو می‌رود؛ یکنواخت است و محتوای همان نسخه درست.
PERFORM pg_temp.assert_eq('واترمارک فقط جلو می‌رود',
  ((SELECT row_version FROM inventory.stock_balance WHERE variation_id=v1 AND warehouse_id=WH) > v_rev)::text, 'true');
PERFORM pg_temp.assert_eq('خوراک و Push: موجودی ۱ − رزرو ۱ + نگه‌داشت ۱',
  (SELECT trim_scale(on_hand - reserved + checkout_held)::text FROM inventory.stock_balance WHERE variation_id=v1 AND warehouse_id=WH), '1');
PERFORM pg_temp.assert_eq('مهلت از تنظیم (۲۰ دقیقه)',
  (SELECT (expires_at - now() BETWEEN interval '19 minutes' AND interval '21 minutes')::text
     FROM inventory.web_order_reservation WHERE external_id='WOO-A'), 'true');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. صندوق قلمِ نگه‌داشته را نمی‌فروشد ═══';
-- ═══════════════════════════════════════════════════════════════════
PERFORM pg_temp.assert_raises('فروش حضوری قلم نگه‌داشته',
  format($q$SELECT inventory.apply_movement(%L::uuid,%L::uuid,-1,'sale','test',%L::uuid,%L::uuid)$q$, v1, WH, v_prod, v_actor),
  '%رزرو شده%');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. مشتری آنلاین دوم همان قلم را نگه نمی‌دارد ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_checkout_hold(v_actor,'WOO-B',BR,WH,pg_temp.lines('HOLD-1','1'));
PERFORM pg_temp.assert_eq('سفارش B', r->>'status', 'unavailable');
PERFORM pg_temp.assert_eq('کمبود از پرداخت در جریان دیگری است',
  (r->'unavailable'->0->>'sku') || ' ' || (r->'unavailable'->0->>'available') || ' ' || (r->'unavailable'->0->>'heldByCheckout'),
  'HOLD-1 0 true');
PERFORM pg_temp.assert_eq('ردِ B چیزی را عوض نکرد', pg_temp.bal('HOLD-1'), '1 1 1');
PERFORM pg_temp.assert_eq('B ردی از سفارش نساخت',
  (SELECT count(*)::text FROM inventory.web_order_reservation WHERE external_id='WOO-B'), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. پرداخت دوبارهٔ همان سفارش: تمدید، نه دو برابر ═══';
-- ═══════════════════════════════════════════════════════════════════
UPDATE inventory.web_order_reservation SET expires_at = now() + interval '1 minute' WHERE external_id='WOO-A';
r := inventory.web_checkout_hold(v_actor,'WOO-A',BR,WH,pg_temp.lines('HOLD-1','1'));
PERFORM pg_temp.assert_eq('نگه‌داشت دوباره', r->>'status', 'held');
PERFORM pg_temp.assert_eq('همان یک سهم', pg_temp.bal('HOLD-1'), '1 1 1');
PERFORM pg_temp.assert_eq('مهلت تمدید شد',
  (SELECT (expires_at > now() + interval '15 minutes')::text FROM inventory.web_order_reservation WHERE external_id='WOO-A'), 'true');
PERFORM pg_temp.assert_eq('یک سطر رزرو فعال',
  (SELECT count(*)::text FROM inventory.stock_reservation WHERE variation_id=v1 AND released_at IS NULL), '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. پرداخت موفق: ثبت سفارش نگه‌داشت را مصرف می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_order_reserve(v_actor,'WOO-A',BR,WH,pg_temp.lines('HOLD-1','1'),'lock');
PERFORM pg_temp.assert_eq('قفل سفارش پرداخت‌شده', r->>'status', 'locked');
-- پرداخت آنلاین «تحویل» نمی‌خواهد؛ پرداخت در محل می‌خواهد (بند ۸).
r := inventory.web_order_reserve(v_actor,'WOO-A',BR,WH,pg_temp.lines('HOLD-1','1'),'consume');
PERFORM pg_temp.assert_eq('مصرف بی تحویل', r->>'status', 'consumed');
PERFORM pg_temp.assert_eq('نگه‌داشت آزاد شد', pg_temp.bal('HOLD-1'), '1 0 0');
PERFORM inventory.apply_movement(v1,WH,-1,'sale','test',v_prod,v_actor);   -- همان نهایی‌سازی فاکتور
PERFORM pg_temp.assert_eq('قلم فروخته شد', pg_temp.bal('HOLD-1'), '0 0 0');
PERFORM pg_temp.assert_eq('سایت صفر دید', pg_temp.pushed('HOLD-1'), '0');
r := inventory.web_checkout_hold(v_actor,'WOO-B',BR,WH,pg_temp.lines('HOLD-1','1'));
PERFORM pg_temp.assert_eq('کنترل منفی: حالا کمبود از فروش است، نه از نگه‌داشت',
  (r->>'status') || ' ' || (r->'unavailable'->0->>'heldByCheckout'), 'unavailable false');
r := inventory.web_checkout_hold(v_actor,'WOO-A',BR,WH,pg_temp.lines('HOLD-1','1'));
PERFORM pg_temp.assert_eq('نگه‌داشتِ سفارش ثبت‌شده', r->>'status', 'consumed');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. انقضا: هنگام نگه‌داشت دیگر و با جاروی دقیقه‌ای ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_checkout_hold(v_actor,'WOO-C',BR,WH,pg_temp.lines('HOLD-2','2'));
PERFORM pg_temp.assert_eq('C هر دو قلم را نگه داشت', pg_temp.bal('HOLD-2'), '2 2 2');
UPDATE inventory.stock_reservation SET expires_at = now() - interval '1 second'
 WHERE source='woo_checkout' AND source_ref=(SELECT id::text FROM inventory.web_order_reservation WHERE external_id='WOO-C');
UPDATE inventory.web_order_reservation SET expires_at = now() - interval '1 second' WHERE external_id='WOO-C';
r := inventory.web_checkout_hold(v_actor,'WOO-D',BR,WH,pg_temp.lines('HOLD-2','1'));
PERFORM pg_temp.assert_eq('D با آزادشدن C در همان لحظه', r->>'status', 'held');
PERFORM pg_temp.assert_eq('فقط سهم D مانده', pg_temp.bal('HOLD-2'), '2 1 1');
PERFORM pg_temp.assert_eq('جارو: سطرهای C از قبل آزادند', inventory.expire_checkout_holds(v_actor)::text, '0');
PERFORM pg_temp.assert_eq('ولی وضعیت C آزاد شد',
  (SELECT status FROM inventory.web_order_reservation WHERE external_id='WOO-C'), 'released');

r := inventory.web_checkout_hold(v_actor,'WOO-E',BR,WH,pg_temp.lines('HOLD-2','1'));
UPDATE inventory.stock_reservation SET expires_at = now() - interval '1 second'
 WHERE source='woo_checkout' AND source_ref=(SELECT id::text FROM inventory.web_order_reservation WHERE external_id='WOO-E');
UPDATE inventory.web_order_reservation SET expires_at = now() - interval '1 second' WHERE external_id='WOO-E';
PERFORM pg_temp.assert_eq('جارو سطر E را آزاد کرد', inventory.expire_checkout_holds(v_actor)::text, '1');
PERFORM pg_temp.assert_eq('D سر جایش ماند', pg_temp.bal('HOLD-2'), '2 1 1');
PERFORM pg_temp.assert_eq('جاروی تکراری بی‌اثر', inventory.expire_checkout_holds(v_actor)::text, '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. یا همه یا هیچ: کمبود یک قلم، قلم دیگر را هم نگه نمی‌دارد ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_checkout_hold(v_actor,'WOO-H',BR,WH,
  pg_temp.lines('HOLD-3','1') || pg_temp.lines('HOLD-2','2'));
PERFORM pg_temp.assert_eq('H رد شد و قلم کم را گفت',
  (r->>'status') || ' ' || jsonb_array_length(r->'unavailable')::text || ' ' || (r->'unavailable'->0->>'sku'),
  'unavailable 1 HOLD-2');
PERFORM pg_temp.assert_eq('HOLD-3 نگه داشته نشد', pg_temp.bal('HOLD-3'), '3 0 0');
PERFORM pg_temp.assert_eq('HOLD-2 دست نخورد', pg_temp.bal('HOLD-2'), '2 1 1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. پرداخت در محل: نگه‌داشت به رزرو بی‌انقضا تبدیل می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_checkout_hold(v_actor,'WOO-F',BR,WH,pg_temp.lines('HOLD-3','1'));
PERFORM pg_temp.assert_eq('F نگه داشت', pg_temp.bal('HOLD-3'), '3 1 1');
PERFORM pg_temp.assert_eq('سایت هنوز ۳', pg_temp.pushed('HOLD-3'), '3');
r := inventory.web_order_reserve(v_actor,'WOO-F',BR,WH,pg_temp.lines('HOLD-3','1'),'reserve');
PERFORM pg_temp.assert_eq('رزرو پرداخت در محل', r->>'status', 'reserved');
PERFORM pg_temp.assert_eq('سهم ماند، دیگر نگه‌داشت نیست', pg_temp.bal('HOLD-3'), '3 1 0');
PERFORM pg_temp.assert_eq('حالا از عدد سایت کم شد (همان رزرو ۰۹۲)', pg_temp.pushed('HOLD-3'), '2');
PERFORM pg_temp.assert_eq('بی انقضا',
  (SELECT kind || ' ' || coalesce(expires_at::text, 'NULL') FROM inventory.web_order_reservation WHERE external_id='WOO-F'),
  'cod NULL');
PERFORM pg_temp.assert_eq('جارو رزرو پرداخت در محل را نمی‌برد', inventory.expire_checkout_holds(v_actor)::text, '0');
PERFORM pg_temp.assert_raises('پرداخت در محل همچنان تحویل می‌خواهد',
  format($q$SELECT inventory.web_order_reserve(%L::uuid,'WOO-F',%L::uuid,%L::uuid,%L::jsonb,'consume')$q$,
         v_actor, BR, WH, pg_temp.lines('HOLD-3','1')),
  '%تأیید تحویل%');
r := inventory.web_checkout_hold(v_actor,'WOO-F',BR,WH,pg_temp.lines('HOLD-3','1'));
PERFORM pg_temp.assert_eq('نگه‌داشتِ دوباره روی رزرو پرداخت در محل', r->>'status', 'reserved');
PERFORM pg_temp.assert_eq('و دو برابر نشد', pg_temp.bal('HOLD-3'), '3 1 0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۹. سفارش پرداخت‌شده با نگه‌داشتِ منقضی یا اقلام متفاوت رد نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_order_reserve(v_actor,'WOO-C',BR,WH,pg_temp.lines('HOLD-2','1'),'lock');
PERFORM pg_temp.assert_eq('قفل روی نگه‌داشت منقضی', r->>'status', 'locked');
r := inventory.web_order_reserve(v_actor,'WOO-C',BR,WH,pg_temp.lines('HOLD-2','1'),'consume');
PERFORM pg_temp.assert_eq('مصرف روی نگه‌داشت منقضی', r->>'status', 'consumed');
PERFORM pg_temp.assert_eq('چیزی از دیگران آزاد نشد', pg_temp.bal('HOLD-2'), '2 1 1');

r := inventory.web_checkout_hold(v_actor,'WOO-G',BR,WH,pg_temp.lines('HOLD-3','1'));
PERFORM pg_temp.assert_eq('G نگه داشت', pg_temp.bal('HOLD-3'), '3 2 1');
r := inventory.web_order_reserve(v_actor,'WOO-G',BR,WH,pg_temp.lines('HOLD-3','2'),'consume');
PERFORM pg_temp.assert_eq('اقلام متفاوت: مصرف و آزادسازی', r->>'status', 'consumed');
PERFORM pg_temp.assert_eq('نگه‌داشت G آزاد شد', pg_temp.bal('HOLD-3'), '3 1 0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۰. لغو، و آزادسازی دوبارهٔ یک سطر ═══';
-- ═══════════════════════════════════════════════════════════════════
r := inventory.web_checkout_hold(v_actor,'WOO-I',BR,WH,pg_temp.lines('HOLD-3','1'));
SELECT id INTO v_line FROM inventory.stock_reservation
 WHERE source_ref=(SELECT id::text FROM inventory.web_order_reservation WHERE external_id='WOO-I');
PERFORM pg_temp.assert_eq('آزادسازی اول', inventory.release_web_reservation_line(v_line)::text, 'true');
PERFORM pg_temp.assert_eq('آزادسازی دوم بی‌اثر', inventory.release_web_reservation_line(v_line)::text, 'false');
PERFORM pg_temp.assert_eq('فقط یک بار کم شد', pg_temp.bal('HOLD-3'), '3 1 0');
r := inventory.web_order_reserve(v_actor,'WOO-I',BR,WH,'[]','release');
PERFORM pg_temp.assert_eq('لغو سفارش', r->>'status', 'released');
PERFORM pg_temp.assert_eq('لغو چیزی را دو بار کم نکرد', pg_temp.bal('HOLD-3'), '3 1 0');
PERFORM pg_temp.assert_eq('قید checkout_held ≤ reserved برقرار',
  (SELECT count(*)::text FROM inventory.stock_balance WHERE checkout_held < 0 OR checkout_held > reserved), '0');

RAISE NOTICE E'\n✔ نگه‌داشت پرداخت آنلاین — تک‌قلم، صندوق، مشتری دوم، تمدید، مصرف، انقضا، همه یا هیچ، پرداخت در محل، منقضی، لغو';
END $test$;

ROLLBACK;
