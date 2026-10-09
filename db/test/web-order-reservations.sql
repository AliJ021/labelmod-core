\set ON_ERROR_STOP on
BEGIN;
-- آزمون مستقل مرز SQL؛ تراکنش آخر همهٔ دادهٔ آزمون را برمی‌گرداند.
DO $$
DECLARE
  v_actor uuid;
  v_branch uuid := '00000000-0000-7000-8000-000000000001';
  v_warehouse uuid := '00000000-0000-7000-8000-000000000101';
  v_product uuid; v_variation uuid; v_payload jsonb; v_result jsonb;
  v_before numeric; v_reserved numeric; v_on_hand numeric;
BEGIN
  -- کاربر خودکار seed مجوز فروش ندارد؛ همان نقش شعبه‌دار اتصال واقعی را می‌سازیم.
  INSERT INTO identity.app_user(username,full_name,is_active)
    VALUES('sql-cod-092','کلاینت آزمون رزرو',false) RETURNING id INTO v_actor;
  INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(v_actor,'web',v_branch);
  INSERT INTO catalog.product(code,name_internal) VALUES('SQL-COD-092','آزمون رزرو') RETURNING id INTO v_product;
  INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(v_product,'SQL-COD-092','آبی','M') RETURNING id INTO v_variation;
  PERFORM inventory.apply_movement(v_variation,v_warehouse,3,'opening',NULL,NULL,v_actor,1000);
  v_payload := jsonb_build_array(jsonb_build_object('sku','SQL-COD-092','qty','2'));
  SELECT count(*) INTO v_before FROM inventory.stock_movement WHERE variation_id=v_variation;
  v_result := inventory.web_order_reserve(v_actor,'SQL-COD-A',v_branch,v_warehouse,v_payload,'reserve');
  IF v_result->>'status'<>'reserved' THEN RAISE EXCEPTION 'رزرو ثبت نشد'; END IF;
  SELECT reserved,on_hand INTO v_reserved,v_on_hand FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF v_reserved<>2 OR v_on_hand<>3 THEN RAISE EXCEPTION 'رزرو موجودی فیزیکی را تغییر داد'; END IF;
  IF (SELECT count(*) FROM inventory.stock_movement WHERE variation_id=v_variation)<>v_before THEN RAISE EXCEPTION 'رزرو حرکت انبار ساخت'; END IF;
  v_result := inventory.web_order_reserve(v_actor,'SQL-COD-A',v_branch,v_warehouse,v_payload,'reserve');
  IF v_result->>'replayed'<>'true' THEN RAISE EXCEPTION 'تکرار رزرو ناموفق'; END IF;
  BEGIN
    PERFORM inventory.web_order_reserve(v_actor,'SQL-COD-B',v_branch,v_warehouse,v_payload,'reserve');
    RAISE EXCEPTION 'TEST_FAIL: رزرو بیش از موجودی پذیرفته شد';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM inventory.apply_movement(v_variation,v_warehouse,-2,'sale','test',v_product,v_actor);
    RAISE EXCEPTION 'TEST_FAIL: خروج سهم رزروشده پذیرفته شد';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM inventory.web_order_reserve(v_actor,'SQL-COD-A',v_branch,v_warehouse,v_payload,'consume');
    RAISE EXCEPTION 'TEST_FAIL: خروج بدون تحویل پذیرفته شد';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF;
  END;
  v_result := inventory.web_order_reserve(v_actor,'SQL-COD-A',v_branch,v_warehouse,'[]','release');
  IF v_result->>'status'<>'released' THEN RAISE EXCEPTION 'لغو ناموفق'; END IF;
  v_result := inventory.web_order_reserve(v_actor,'SQL-COD-A',v_branch,v_warehouse,v_payload,'reserve');
  IF v_result->>'status'<>'released' THEN RAISE EXCEPTION 'رزرو لغوشده احیا شد'; END IF;
  v_result := inventory.web_order_reserve(v_actor,'SQL-COD-C',v_branch,v_warehouse,v_payload,'reserve');
  v_result := inventory.web_order_reserve(v_actor,'SQL-COD-C',v_branch,v_warehouse,v_payload,'consume',true);
  PERFORM inventory.apply_movement(v_variation,v_warehouse,-2,'sale','test',v_product,v_actor);
  SELECT reserved,on_hand INTO v_reserved,v_on_hand FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF v_reserved<>0 OR v_on_hand<>1 THEN RAISE EXCEPTION 'خروج سهم سفارش صحیح نیست'; END IF;
  RAISE NOTICE 'رزرو، تکرار، کسری، محافظت خروج، تحویل و لغو SQL تأیید شد';
END $$;
ROLLBACK;
