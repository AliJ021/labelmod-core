\set ON_ERROR_STOP on
BEGIN;
-- مهاجرت ۰۹۷: واترمارک موجودی سایت (row_version) و stockRev در Push.
-- docs/STOCK-SYNC-PROTOCOL.md. تراکنش آخر همهٔ دادهٔ آزمون را برمی‌گرداند.
DO $$
DECLARE
  v_admin uuid; v_web uuid;
  v_branch uuid := '00000000-0000-7000-8000-000000000001';
  v_warehouse uuid := '00000000-0000-7000-8000-000000000101';
  v_product uuid; v_variation uuid; v_rev bigint; v_rev2 bigint; v_payload jsonb; v_msg jsonb;
  v_lines jsonb;
BEGIN
  INSERT INTO identity.app_user(username,full_name,is_active) VALUES('sql-wm-admin','مدیر آزمون واترمارک',false) RETURNING id INTO v_admin;
  INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(v_admin,'admin',NULL);
  INSERT INTO identity.app_user(username,full_name,is_active) VALUES('sql-wm-web','سایت آزمون واترمارک',false) RETURNING id INTO v_web;
  INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(v_web,'web',v_branch);
  INSERT INTO catalog.product(code,name_internal) VALUES('SQL-WM-097','آزمون واترمارک') RETURNING id INTO v_product;
  INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(v_product,'SQL-WM-097','آبی','M') RETURNING id INTO v_variation;

  -- ۱. هر تغییر موجودی دقیقاً یک واحد جلو می‌رود، از هر مسیر.
  PERFORM inventory.apply_movement(v_variation,v_warehouse,5,'opening',NULL,NULL,v_admin,1000);
  SELECT row_version INTO v_rev FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  PERFORM inventory.apply_movement(v_variation,v_warehouse,-1,'sale','test',v_product,v_admin);
  SELECT row_version INTO v_rev2 FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF v_rev2 <> v_rev + 1 THEN RAISE EXCEPTION 'خروج انبار واترمارک را دقیقاً یک واحد جلو نبرد: % → %', v_rev, v_rev2; END IF;
  v_lines := jsonb_build_array(jsonb_build_object('sku','SQL-WM-097','qty','1'));
  PERFORM inventory.web_order_reserve(v_web,'SQL-WM-A',v_branch,v_warehouse,v_lines,'reserve');
  SELECT row_version INTO v_rev FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF v_rev <> v_rev2 + 1 THEN RAISE EXCEPTION 'رزرو واترمارک را دقیقاً یک واحد جلو نبرد: % → %', v_rev2, v_rev; END IF;

  -- ۲. نویسندهٔ مستقیمی که row_version را دست نمی‌زند هم جلو می‌برد (Trigger، نه نویسنده)؛
  --    و نوشتنی که موجودی/رزرو را عوض نکند جلو نمی‌برد.
  UPDATE inventory.stock_balance SET on_hand=on_hand+1 WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  SELECT row_version INTO v_rev2 FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF v_rev2 <> v_rev + 1 THEN RAISE EXCEPTION 'نوشتن مستقیم on_hand واترمارک را جلو نبرد'; END IF;
  UPDATE inventory.stock_balance SET updated_at=updated_at WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF (SELECT row_version FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse) <> v_rev2 THEN
    RAISE EXCEPTION 'نوشتن بی تغییر موجودی واترمارک را جلو برد';
  END IF;
  -- کنترل منفی: بی Trigger همان نوشتن جلو نمی‌رود؛ پس بند ۲ چیزی را واقعاً می‌سنجد.
  ALTER TABLE inventory.stock_balance DISABLE TRIGGER stock_balance_bump_row_version;
  UPDATE inventory.stock_balance SET on_hand=on_hand-1 WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF (SELECT row_version FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse) <> v_rev2 THEN
    RAISE EXCEPTION 'کنترل منفی: بی Trigger هم واترمارک جلو رفت؛ آزمون حساس نیست';
  END IF;
  ALTER TABLE inventory.stock_balance ENABLE TRIGGER stock_balance_bump_row_version;

  -- ۳. Push همان عدد و همان واترمارکِ یک خواندن را می‌برد؛ پیام معلق تجمیع‌شده تازه می‌شود.
  PERFORM platform.set_actor(v_admin);
  PERFORM platform.set_setting('web.push_enabled','true'::jsonb,'آزمون ۰۹۷',v_admin);
  PERFORM platform.set_setting('web.stock_warehouse',to_jsonb((SELECT code FROM inventory.warehouse WHERE id=v_warehouse)),'آزمون ۰۹۷',v_admin);
  PERFORM inventory.apply_movement(v_variation,v_warehouse,2,'opening',NULL,NULL,v_admin,1000);
  SELECT payload INTO v_msg FROM platform.outbox_message
   WHERE topic='web.stock_push' AND status='pending' AND payload->>'variationId'=v_variation::text;
  SELECT row_version INTO v_rev FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse;
  IF v_msg->>'stockRev' IS DISTINCT FROM v_rev::text OR v_msg->>'warehouseId' IS DISTINCT FROM v_warehouse::text THEN
    RAISE EXCEPTION 'Push واترمارک یا انبار درست ندارد: %', v_msg;
  END IF;
  IF (v_msg->>'onHand')::numeric <> (SELECT on_hand-reserved FROM inventory.stock_balance WHERE variation_id=v_variation AND warehouse_id=v_warehouse) THEN
    RAISE EXCEPTION 'Push عدد قابل‌فروش (on_hand − reserved) را نبرد: %', v_msg;
  END IF;
  PERFORM inventory.web_order_reserve(v_web,'SQL-WM-B',v_branch,v_warehouse,v_lines,'reserve');
  SELECT payload INTO v_payload FROM platform.outbox_message
   WHERE topic='web.stock_push' AND status='pending' AND payload->>'variationId'=v_variation::text;
  IF (v_payload->>'stockRev')::bigint <> v_rev + 1 OR (v_payload->>'onHand')::numeric <> (v_msg->>'onHand')::numeric - 1 THEN
    RAISE EXCEPTION 'پیام معلق پس از رزرو تازه نشد: % → %', v_msg, v_payload;
  END IF;
  IF (v_payload->>'version')::bigint <= (v_msg->>'version')::bigint THEN
    RAISE EXCEPTION 'نسخهٔ سراسری Push جلو نرفت';
  END IF;
  RAISE NOTICE 'واترمارک ۰۹۷: یک واحد به‌ازای هر تغییر، Trigger مستقل از نویسنده (با کنترل منفی) و stockRev در Push تأیید شد';
END $$;
ROLLBACK;
