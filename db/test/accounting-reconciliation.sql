-- Regression of the financial failures observed on the staging ledger.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.eq(label text,actual numeric,expected numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION '%: expected %, got %',label,expected,actual; END IF;
 RAISE NOTICE 'PASS % = %',label,actual;
END $$;
CREATE FUNCTION pg_temp.reject(label text,command text,fragment text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN others THEN
   IF position(fragment IN SQLERRM)=0 THEN RAISE EXCEPTION '%: wrong failure %',label,SQLERRM; END IF;
   RAISE NOTICE 'PASS % rejected: %',label,SQLERRM; RETURN;
 END;
 RAISE EXCEPTION '% unexpectedly accepted',label;
END $$;
CREATE FUNCTION pg_temp.invoice(c uuid,v uuid,u uuid,amount numeric,q numeric DEFAULT 1) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE i uuid; price numeric:=ceil(amount/q);
BEGIN
 INSERT INTO sales.invoice(branch_id,warehouse_id,channel,customer_id,created_by)
 VALUES ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000101','web',c,u) RETURNING id INTO i;
 INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,discount_amount,net_amount)
 VALUES(i,1,v,q,price,q*price-amount,amount);
 RETURN i;
END $$;
CREATE FUNCTION pg_temp.return_sale(i uuid,u uuid,q numeric,refund numeric,method text DEFAULT 'gateway',restock boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
 INSERT INTO sales.sale_return(branch_id,invoice_id,warehouse_id,reason_code,refund_amount,refund_method,created_by)
 SELECT branch_id,id,warehouse_id,'size_small',refund,method,u FROM sales.invoice WHERE id=i RETURNING id INTO r;
 INSERT INTO sales.sale_return_line(return_id,invoice_line_id,qty,unit_price,net_amount,unit_cost,cogs_amount,restock)
 SELECT r,id,q,0,0,0,0,restock FROM sales.invoice_line WHERE invoice_id=i;
 PERFORM sales.post_return(r,u); RETURN r;
END $$;
DO $$
DECLARE
 br uuid:='00000000-0000-7000-8000-000000000001'; wh uuid:='00000000-0000-7000-8000-000000000101';
 u uuid; c uuid; empty_customer uuid; p uuid; v uuid; v2 uuid; sup uuid; rc uuid; rl uuid;
 i uuid; i2 uuid; ret uuid; n numeric; b numeric; method text; target text; audit_id bigint; legacy_hash text;
BEGIN
 INSERT INTO identity.app_user(username,full_name) VALUES('regression-accounting','Accounting regression') RETURNING id INTO u;
 INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(u,'admin',br);
 PERFORM platform.set_actor(u);
 INSERT INTO sales.customer(full_name,credit_limit) VALUES('Credit control',200000) RETURNING id INTO c;
 INSERT INTO sales.customer(full_name) VALUES('No prepaid funds') RETURNING id INTO empty_customer;
 INSERT INTO purchasing.supplier(code,name) VALUES('REG-FIN','Regression supplier') RETURNING id INTO sup;
 INSERT INTO catalog.product(code,name_internal) VALUES('REG-FIN','Regression stock') RETURNING id INTO p;
 INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(p,'REG-FIN-1','black','M') RETURNING id INTO v;
 INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(p,'REG-FIN-2','black','L') RETURNING id INTO v2;
 INSERT INTO purchasing.receipt(branch_id,supplier_id,warehouse_id) VALUES(br,sup,wh) RETURNING id INTO rc;
 INSERT INTO purchasing.receipt_line(receipt_id,variation_id,qty,unit_price,line_amount) VALUES(rc,v,100,100000,10000000);
 PERFORM purchasing.post_receipt(rc,u);

 i:=pg_temp.invoice(c,v,u,260000);
 PERFORM pg_temp.reject('F1 credit limit',format('SELECT sales.finalize_invoice(%L,%L)',i,u),'سقف اعتبار');
 UPDATE sales.customer SET status='blocked' WHERE id=c;
 i:=pg_temp.invoice(c,v,u,200000);
 PERFORM pg_temp.reject('F6 blocked customer',format('SELECT sales.finalize_invoice(%L,%L)',i,u),'مسدود');
 UPDATE sales.customer SET status='active' WHERE id=c;
 i:=pg_temp.invoice(c,v,u,180000);
 INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(i,'credit',180000);
 PERFORM sales.finalize_invoice(i,u);
 ret:=pg_temp.return_sale(i,u,1,0);
 PERFORM pg_temp.eq('F2 credit marker is not cash',(SELECT receivable_applied FROM sales.sale_return WHERE id=ret),180000);
 PERFORM pg_temp.eq('F2 no invented wallet credit',(SELECT credit_applied FROM sales.sale_return WHERE id=ret),0);
 -- بدهی قدیمی همراه فروش و مرجوعی در دوره باز نباید زیر سقف واقعی پنهان شود.
 PERFORM ledger.post_entry('sale_shift',br,platform.business_date(),'Prior receivable',
   jsonb_build_array(jsonb_build_object('leg','receivable','amount',200000,'party_type','customer','party_id',c),
     jsonb_build_object('leg','sales','amount',200000)),'test',c,u);
 i2:=pg_temp.invoice(c,v,u,100000);
 PERFORM pg_temp.reject('F1 returned unposted sale cannot double-release credit',
   format('SELECT sales.finalize_invoice(%L,%L)',i2,u),'سقف اعتبار');
 -- بقیه سناریوها پرداخت‌شده‌اند؛ هیچ دست‌کاری مانده برای عبور از نگهبان لازم نیست.

 i:=pg_temp.invoice(c,v,u,399999,2);
 INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(i,'gateway',399999);
 PERFORM sales.finalize_invoice(i,u);
 PERFORM pg_temp.return_sale(i,u,1,200000);
 PERFORM pg_temp.return_sale(i,u,1,199999);
 PERFORM pg_temp.eq('F5 split returns preserve one-rial residual',(SELECT sum(net_amount) FROM sales.sale_return WHERE invoice_id=i),399999);

 i:=pg_temp.invoice(c,v,u,200000);
 INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(i,'cash',210000);
 PERFORM sales.finalize_invoice(i,u);
 PERFORM pg_temp.eq('F7 cash change recorded',(SELECT sum(amount) FROM treasury.payment WHERE invoice_id=i AND direction='out'),10000);
 PERFORM pg_temp.eq('F7 invoice paid net of change',(SELECT paid_amount FROM sales.invoice WHERE id=i),200000);

 PERFORM ledger.post_entry('loyalty_grant',br,platform.business_date(),'Funded wallet',
   jsonb_build_array(jsonb_build_object('leg','expense','amount',200000),
   jsonb_build_object('leg','liability','amount',200000,'party_type','customer','party_id',c)),'test',c,u);
 i:=pg_temp.invoice(c,v,u,200000);
 INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(i,'points',200000);
 i2:=pg_temp.invoice(c,v,u,200000);
 PERFORM pg_temp.reject('F10 reserved wallet cannot be spent twice',format('INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(%L,''points'',200000)',i2),'پشتوانه');
 UPDATE treasury.payment SET status='settled' WHERE invoice_id=i;
 PERFORM pg_temp.eq('F10 funded status transition works',(SELECT count(*) FROM treasury.payment WHERE invoice_id=i AND status='settled'),1);
 i:=pg_temp.invoice(empty_customer,v,u,200000);
 PERFORM pg_temp.reject('F12 fabricated gift card',format('INSERT INTO treasury.payment(invoice_id,method_code,amount,ref_no) VALUES(%L,''gift_card'',200000,''FAKE-CARD'')',i),'پشتوانه');

 FOREACH method IN ARRAY ARRAY['card','gateway','transfer'] LOOP
  SELECT account_code INTO target FROM ledger.posting_rule WHERE event_type='sale_shift'
    AND leg=CASE method WHEN 'card' THEN 'card_clearing' WHEN 'gateway' THEN 'gateway_clearing' ELSE 'p2p_clearing' END;
  i:=pg_temp.invoice(c,v,u,200000);
  INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(i,method,200000);
  PERFORM sales.finalize_invoice(i,u);
  ret:=pg_temp.return_sale(i,u,1,200000,method);
  PERFORM pg_temp.eq('F11 refund uses original clearing account '||method,
   (SELECT sum(l.credit) FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id=l.entry_id WHERE e.ref_id=ret AND l.account_code=target),200000);
  PERFORM pg_temp.eq('F11 noncash refund leaves cash untouched '||method,
   (SELECT coalesce(sum(l.credit),0) FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id=l.entry_id WHERE e.ref_id=ret AND l.account_code='1101'),0);
 END LOOP;

 INSERT INTO purchasing.receipt(branch_id,supplier_id,warehouse_id,tax_amount) VALUES(br,sup,wh,1) RETURNING id INTO rc;
 INSERT INTO purchasing.receipt_line(receipt_id,variation_id,qty,unit_price,line_amount) VALUES(rc,v2,2,100000,200000) RETURNING id INTO rl;
 INSERT INTO purchasing.receipt_charge(receipt_id,charge_type,amount,allocation,paid_from,payee_type)
 VALUES(rc,'freight',1,'by_value','payable','supplier');
 PERFORM purchasing.post_receipt(rc,u);
 PERFORM pg_temp.eq('F8 extended receipt cost retains one rial',(SELECT total_value FROM inventory.stock_balance WHERE variation_id=v2 AND warehouse_id=wh),200001);
 FOR n IN 1..2 LOOP
  INSERT INTO purchasing.purchase_return(branch_id,receipt_id,warehouse_id,reason_code,created_by) VALUES(br,rc,wh,'defective',u) RETURNING id INTO ret;
  INSERT INTO purchasing.purchase_return_line(return_id,receipt_line_id,qty) VALUES(ret,rl,1);
  PERFORM purchasing.post_purchase_return(ret,u);
 END LOOP;
 PERFORM pg_temp.eq('F9 two returns refund exactly original tax',(SELECT sum(tax_amount) FROM purchasing.purchase_return WHERE receipt_id=rc),1);
 PERFORM pg_temp.eq('F8 complete return removes exact inventory value',(SELECT total_value FROM inventory.stock_balance WHERE variation_id=v2 AND warehouse_id=wh),0);

 PERFORM pg_temp.reject('F15 asset is not an expense',format('INSERT INTO treasury.transaction(branch_id,purpose,from_account_id,expense_account_code,amount) VALUES(%L,''expense'',''00000000-0000-7000-8000-000000000201'',''1301'',1)',br),'حساب');
 PERFORM platform.set_setting('tax.enabled','true','tax regression',u);
 PERFORM platform.set_setting('tax.default_rate','10','tax regression',u);
 PERFORM pg_temp.eq('F16 standard tax',sales.line_tax(v,200000),20000);
 UPDATE catalog.product SET tax_rate_code='exempt' WHERE id=p;
 PERFORM pg_temp.eq('F16 exempt goods',sales.line_tax(v,200000),0);

 PERFORM platform.audit('test.timezone','test','reg',jsonb_build_object('amount',1),u);
 SELECT max(id) INTO audit_id FROM platform.audit_log;
 PERFORM set_config('TimeZone','UTC',true);
 PERFORM pg_temp.eq('F22 audit checks in UTC',(SELECT count(*) FROM platform.audit_check WHERE id=audit_id),0);
 PERFORM set_config('TimeZone','Asia/Tehran',true);
 PERFORM pg_temp.eq('F22 audit checks in Tehran',(SELECT count(*) FROM platform.audit_check WHERE id=audit_id),0);
 SELECT diff INTO b FROM inventory.ledger_check;
 PERFORM pg_temp.eq('P1 pending COGS reconciles explicitly',b,0);

 -- Historical hashes remain verifiable without altering a single audit row.
 legacy_hash:=platform.audit_hash(3::smallint,NULL,'2026-06-01 12:34:56+00'::timestamptz,u,
   'legacy','test','old','{"amount":7}'::jsonb,NULL,'reason','correlation');
 PERFORM set_config('TimeZone','UTC',true);
 PERFORM pg_temp.eq('F22 legacy Tehran hash verifies from UTC',
   platform.audit_content_matches(legacy_hash,3::smallint,NULL,'2026-06-01 12:34:56+00'::timestamptz,u,
     'legacy','test','old','{"amount":7}'::jsonb,NULL,'reason','correlation')::int,1);
 PERFORM pg_temp.eq('F22 tampered legacy contents rejected',
   platform.audit_content_matches(legacy_hash,3::smallint,NULL,'2026-06-01 12:34:56+00'::timestamptz,u,
     'legacy','test','old','{"amount":8}'::jsonb,NULL,'reason','correlation')::int,0);
 PERFORM pg_temp.eq('F22 verifier restores caller timezone',(current_setting('TimeZone')='UTC')::int,1);

 FOREACH method IN ARRAY ARRAY['pay','cancel'] LOOP
   INSERT INTO treasury.cheque(direction,branch_id,cheque_no,bank_name,amount,issued_on,due_on,
     party_type,party_id,bank_account_id,created_by)
     VALUES('issued',br,'REG-BOUNCE-'||method,'Test bank',100000,platform.business_date(),
       platform.business_date(),'supplier',sup,'00000000-0000-7000-8000-000000000202',u) RETURNING id INTO ret;
   PERFORM treasury.post_cheque_event(ret,'issue',u);
   PERFORM treasury.post_cheque_event(ret,'bounce',u);
   PERFORM pg_temp.eq('F13 bounced liability remains due',(SELECT count(*) FROM treasury.cheque_due WHERE id=ret),1);
   i:=treasury.post_cheque_event(ret,method,u);
   i2:=treasury.post_cheque_event(ret,method,u);
   PERFORM pg_temp.eq('F13 pay/cancel retry preserves journal '||method,(i=i2)::int,1);
   PERFORM pg_temp.eq('F13 settled liability leaves due list '||method,(SELECT count(*) FROM treasury.cheque_due WHERE id=ret),0);
   PERFORM pg_temp.eq('F13 issued liability cleared exactly '||method,
     (SELECT coalesce(sum(l.credit-l.debit),0) FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id=l.entry_id
       WHERE e.ref_id=ret AND l.account_code='2401'),0);
 END LOOP;

 -- بازتولید F19: یک قلم از دو قلم قدیمی پیش از تغییر روش فروخته شده است.
 PERFORM platform.set_setting('costing.method','"moving_weighted_average"','F19',u);
 PERFORM inventory.apply_movement(v2,wh,2,'opening',NULL,NULL,u,100000);
 PERFORM inventory.apply_movement(v2,wh,-1,'sale','test_doc',v2,u);
 PERFORM inventory.apply_movement(v2,wh,2,'opening',NULL,NULL,u,200000);
 PERFORM pg_temp.eq('F19 only unsold physical layers remain',
   (SELECT sum(qty_left) FROM inventory.cost_layer WHERE variation_id=v2 AND warehouse_id=wh),3);
 PERFORM platform.set_setting('costing.method','"fifo"','F19',u);
 SELECT -value_delta INTO b FROM inventory.apply_movement(v2,wh,-2,'sale','test_doc',v2,u);
 PERFORM pg_temp.eq('F19 FIFO cannot reuse an already sold lot',b,300000);
 PERFORM pg_temp.eq('F19 remaining stock retains correct value',
   (SELECT total_value FROM inventory.stock_balance WHERE variation_id=v2 AND warehouse_id=wh),200000);
 PERFORM platform.set_setting('costing.method','"moving_weighted_average"','F19 mixed costs',u);
 PERFORM inventory.apply_movement(v2,wh,1,'opening',NULL,NULL,u,400000);
 PERFORM inventory.apply_movement(v2,wh,-1,'sale','test_doc',v2,u);
 PERFORM pg_temp.reject('F19 unsafe FIFO transition cannot silently change book value',
   format('SELECT platform.set_setting(''costing.method'',''"fifo"'',''F19 mismatch'',%L)',u),'تطبیق ارزش');
END $$;
ROLLBACK;
