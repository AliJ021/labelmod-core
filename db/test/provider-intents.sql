BEGIN;
DO $$
DECLARE actor uuid; inv uuid; product uuid; variation uuid; intent uuid; claim uuid; callback uuid; reference text;
BEGIN
 INSERT INTO identity.app_user(username,full_name) VALUES ('intent_sql_'||platform.uuid_v7(),'قصد مصنوعی') RETURNING id INTO actor;
 INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(actor,'admin',NULL);
 INSERT INTO catalog.product(code,name_internal) VALUES('INTENT-'||actor,'کالای مصنوعی') RETURNING id INTO product;
 INSERT INTO catalog.variation(product_id,sku) VALUES(product,'INTENT-'||actor) RETURNING id INTO variation;
 INSERT INTO sales.invoice(branch_id,warehouse_id,channel,created_by)
 SELECT w.branch_id,w.id,'web',actor FROM inventory.warehouse w WHERE w.code='STORE' LIMIT 1 RETURNING id INTO inv;
 INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount)
 VALUES(inv,1,variation,1,900719925474099301,900719925474099301);
 intent:=sales.create_provider_intent(inv,'snappay',actor,repeat('a',64),actor);
 IF intent<>sales.create_provider_intent(inv,'snappay',actor,repeat('a',64),actor) THEN RAISE EXCEPTION 'replay متفاوت'; END IF;
 SELECT merchant_reference INTO reference FROM sales.provider_intent WHERE id=intent;
 IF reference !~ '^\d{5,10}$' THEN RAISE EXCEPTION 'مرجع خارج قرارداد'; END IF;
 BEGIN PERFORM sales.create_provider_intent(inv,'digipay',actor,repeat('a',64),actor); RAISE EXCEPTION 'قبول کلید متفاوت';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='قبول کلید متفاوت' THEN RAISE; END IF; END;
 BEGIN UPDATE sales.provider_intent SET amount=1 WHERE id=intent; RAISE EXCEPTION 'ویرایش قصد';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='ویرایش قصد' THEN RAISE; END IF; END;
 callback:=sales.record_provider_callback(intent,actor,reference,'900719925474099301','OK',actor);
 IF callback<>sales.record_provider_callback(intent,actor,reference,'900719925474099301','OK',actor)
 OR EXISTS(SELECT 1 FROM sales.provider_intent_event WHERE intent_id=intent) THEN RAISE EXCEPTION 'callback اثر قطعی ساخت'; END IF;
 BEGIN PERFORM sales.record_provider_callback(intent,actor,reference,'900719925474099302','OK',actor); RAISE EXCEPTION 'قبول مبلغ غلط';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='قبول مبلغ غلط' THEN RAISE; END IF; END;
 claim:=sales.claim_provider_intent(intent,0,'token',actor);
 BEGIN PERFORM sales.expire_provider_intent(intent,1,actor); RAISE EXCEPTION 'انقضای زودرس';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='انقضای زودرس' THEN RAISE; END IF; END;
 PERFORM sales.finish_provider_intent(intent,1,claim,'token_ready',jsonb_build_object('source','server_adapter','transactionId',reference,'amount','900719925474099301','paymentToken','synthetic'),actor);
 claim:=sales.claim_provider_intent(intent,2,'verify',actor);
 PERFORM sales.finish_provider_intent(intent,3,claim,'unknown','{}',actor);
 BEGIN PERFORM sales.claim_provider_intent(intent,4,'verify',actor); RAISE EXCEPTION 'retry خودکار';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='retry خودکار' THEN RAISE; END IF; END;
 claim:=sales.claim_provider_intent(intent,4,'status',actor);
 PERFORM sales.finish_provider_intent(intent,5,claim,'verified',jsonb_build_object('source','server_adapter','transactionId',reference,'amount','900719925474099301'),actor);
 claim:=sales.claim_provider_intent(intent,6,'settle',actor);
 PERFORM sales.finish_provider_intent(intent,7,claim,'settled_evidence',jsonb_build_object('source','server_adapter','transactionId',reference,'amount','900719925474099301'),actor);
 IF EXISTS(SELECT 1 FROM treasury.payment WHERE invoice_id=inv) THEN RAISE EXCEPTION 'store رسید مالی ساخت'; END IF;
END $$;
ROLLBACK;
