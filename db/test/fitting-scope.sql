\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(label text, actual numeric, expected numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '%: انتظار %، واقعی %', label, expected, actual;
  END IF;
  RAISE NOTICE '✓ %', label;
END $$;

DO $$
DECLARE
  br uuid; wh uuid; actor uuid; other_br uuid; other_wh uuid;
  customer uuid; product uuid; variation uuid; qty numeric; n numeric;
BEGIN
  SELECT id INTO br FROM platform.branch WHERE code='MAIN';
  SELECT id INTO wh FROM inventory.warehouse WHERE code='STORE';
  SELECT id INTO actor FROM identity.app_user WHERE username='system';
  INSERT INTO platform.branch(code,name) VALUES('SCOPE-B2','شعبه مصنوعی') RETURNING id INTO other_br;
  INSERT INTO inventory.warehouse(branch_id,code,name,kind)
    VALUES(other_br,'SCOPE-W2','انبار مصنوعی','store') RETURNING id INTO other_wh;
  INSERT INTO sales.customer(full_name) VALUES('مشتری مصنوعی دامنه') RETURNING id INTO customer;
  INSERT INTO catalog.product(code,name_internal) VALUES('SCOPE-FIT','محصول مصنوعی') RETURNING id INTO product;
  INSERT INTO catalog.variation(product_id,color,size,sku)
    VALUES(product,'آبی','M','SCOPE-FIT-M') RETURNING id INTO variation;
  PERFORM inventory.apply_movement(variation,wh,5,'purchase_receipt',NULL,NULL,actor,1000);
  PERFORM inventory.apply_movement(variation,other_wh,77,'purchase_receipt',NULL,NULL,actor,1000);
  SELECT on_hand INTO qty FROM catalog.fitting_variations(customer,NULL,NULL,50,ARRAY[br])
    WHERE variation_id=variation;
  PERFORM pg_temp.assert_eq('جمع فقط شعبه مجاز',qty,5);
  SELECT count(*) INTO n FROM catalog.fitting_variations(customer,other_wh,NULL,50,ARRAY[br]);
  PERFORM pg_temp.assert_eq('انبار خارج از دامنه نتیجه ندارد',n,0);
  SELECT count(*) INTO n FROM catalog.fitting_variations(customer,NULL,NULL,50,ARRAY[]::uuid[]);
  PERFORM pg_temp.assert_eq('دامنه خالی دسترسی همه نیست',n,0);
  SELECT on_hand INTO qty FROM catalog.fitting_variations(customer,NULL,NULL,50,NULL::uuid[])
    WHERE variation_id=variation;
  PERFORM pg_temp.assert_eq('دامنه سراسری',qty,82);
  SELECT on_hand INTO qty FROM catalog.fitting_variations(customer)
    WHERE variation_id=variation;
  PERFORM pg_temp.assert_eq('سازگاری فراخوان داخلی قبلی',qty,82);
END $$;

ROLLBACK;
