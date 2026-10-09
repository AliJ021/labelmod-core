\set ON_ERROR_STOP on
BEGIN;

DO $test$
DECLARE
  actor uuid;
  inv uuid;
  v_customer uuid;
  v_status text;
  v_product uuid; v_variation uuid; v_shift uuid; v_number text;
  br uuid := '00000000-0000-7000-8000-000000000001';
  wh uuid := '00000000-0000-7000-8000-000000000101';
BEGIN
  INSERT INTO identity.app_user(username,full_name) VALUES ('customer-policy-sql','آزمون مشتری صندوق') RETURNING id INTO actor;
  PERFORM platform.set_actor(actor);
  INSERT INTO sales.invoice(branch_id,warehouse_id,created_by) VALUES (br,wh,actor) RETURNING id INTO inv;
  PERFORM platform.set_setting('pos.require_customer','false',NULL,actor);
  PERFORM sales.assert_pos_customer(inv);
  PERFORM platform.set_setting('pos.require_customer','true',NULL,actor);
  FOREACH v_status IN ARRAY ARRAY['draft','confirmed','partially_paid'] LOOP
    UPDATE sales.invoice SET status=v_status WHERE id=inv;
    BEGIN
      PERFORM sales.finalize_invoice(inv,actor);
      RAISE EXCEPTION 'نگهبان نهایی‌سازی اجرا نشد: %',v_status USING ERRCODE='check_violation';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'برای فروش صندوق، شماره مشتری را ثبت کنید.' THEN RAISE; END IF;
    END;
  END LOOP;
  UPDATE sales.invoice SET status='draft' WHERE id=inv;
  BEGIN
    INSERT INTO treasury.payment(invoice_id,method_code,direction,amount,status)
      VALUES (inv,'cash','in',100,'pending');
    RAISE EXCEPTION 'نگهبان دریافت اجرا نشد' USING ERRCODE='check_violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'برای فروش صندوق، شماره مشتری را ثبت کنید.' THEN RAISE; END IF;
  END;
  IF EXISTS(SELECT 1 FROM treasury.payment WHERE invoice_id=inv)
     OR EXISTS(SELECT 1 FROM inventory.stock_movement WHERE ref_id=inv) THEN
    RAISE EXCEPTION 'رد سیاست مشتری اثر مالی گذاشت';
  END IF;
  INSERT INTO sales.customer(full_name) VALUES ('مشتری بدون شماره') RETURNING id INTO v_customer;
  UPDATE sales.invoice SET customer_id=v_customer WHERE id=inv;
  BEGIN
    PERFORM sales.assert_pos_customer(inv);
    RAISE EXCEPTION 'مشتری بدون شماره پذیرفته شد' USING ERRCODE='check_violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'برای فروش صندوق، شماره مشتری را ثبت کنید.' THEN RAISE; END IF;
  END;
  UPDATE sales.customer SET mobile_normalized='09129992233' WHERE id=v_customer;
  PERFORM sales.assert_pos_customer(inv);
  UPDATE sales.invoice SET customer_id=NULL,channel='web' WHERE id=inv;
  PERFORM sales.assert_pos_customer(inv);
  -- یک فروش واقعی در حالت اختیاری، سپس تکرار همان سند پس از فعال‌کردن سیاست.
  PERFORM platform.set_setting('pos.require_customer','false',NULL,actor);
  INSERT INTO sales.cash_shift(branch_id,user_id,opening_cash) VALUES (br,actor,0) RETURNING id INTO v_shift;
  UPDATE sales.invoice SET channel='pos',shift_id=v_shift WHERE id=inv;
  INSERT INTO catalog.product(code,name_internal) VALUES ('CUSTOMER-POLICY','آزمون مشتری') RETURNING id INTO v_product;
  INSERT INTO catalog.variation(product_id,sku) VALUES (v_product,'CUSTOMER-POLICY') RETURNING id INTO v_variation;
  INSERT INTO catalog.price(variation_id,price_list,amount) VALUES (v_variation,'default',100);
  PERFORM inventory.apply_movement(v_variation,wh,1,'purchase_receipt','test_receipt',v_variation,actor,50);
  INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount)
    VALUES (inv,1,v_variation,1,100,100);
  INSERT INTO treasury.payment(invoice_id,shift_id,method_code,direction,amount,status)
    VALUES (inv,v_shift,'cash','in',100,'succeeded');
  v_number := sales.finalize_invoice(inv,actor);
  PERFORM platform.set_setting('pos.require_customer','true',NULL,actor);
  IF sales.finalize_invoice(inv,actor) IS DISTINCT FROM v_number
     OR (SELECT count(*) FROM inventory.stock_movement WHERE ref_id=inv AND kind='sale')<>1 THEN
    RAISE EXCEPTION 'تکرار فاکتور قطعی پس از تغییر سیاست، شماره یا خروج را تغییر داد';
  END IF;
  RAISE NOTICE '✓ اجبار شماره مشتری در نهایی‌سازی و پرداخت؛ مشتری بدون شماره رد و سایت مستثنا شد';
END $test$;

ROLLBACK;
