BEGIN;
-- مرجع داخلی پذیرنده؛ نه ticket دیجی‌پی و نه شناسه حدس‌زده‌شدهٔ درگاه.
CREATE SEQUENCE sales.provider_merchant_reference MINVALUE 10000 MAXVALUE 9999999999 START 10000 NO CYCLE;
CREATE TABLE sales.provider_intent (
 id uuid PRIMARY KEY DEFAULT platform.uuid_v7(), invoice_id uuid NOT NULL REFERENCES sales.invoice(id),
 branch_id uuid NOT NULL REFERENCES platform.branch(id), actor_id uuid NOT NULL REFERENCES identity.app_user(id),
 provider text NOT NULL CHECK(provider IN ('snappay','digipay')), channel text NOT NULL CHECK(channel='online'),
 idempotency_key uuid NOT NULL, config_revision text NOT NULL CHECK(config_revision ~ '^[a-f0-9]{64}$'),
 merchant_reference text NOT NULL UNIQUE DEFAULT nextval('sales.provider_merchant_reference')::text,
 amount platform.money NOT NULL CHECK(amount>0), snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,idempotency_key), UNIQUE(invoice_id,provider)
);
CREATE TABLE sales.provider_intent_event (
 id uuid PRIMARY KEY DEFAULT platform.uuid_v7(), intent_id uuid NOT NULL REFERENCES sales.provider_intent(id),
 version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN
 ('token_claimed','token_ready','verify_claimed','verified','settle_claimed','settled_evidence','status_claimed','unknown','cancelled_evidence')),
 operation text NOT NULL CHECK(operation IN ('token','verify','settle','status','expire')),
 claim_id uuid, expires_at timestamptz, evidence jsonb NOT NULL DEFAULT '{}',
 actor_id uuid NOT NULL REFERENCES identity.app_user(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intent_id,version)
);
CREATE TABLE sales.provider_callback_event (
 id uuid PRIMARY KEY DEFAULT platform.uuid_v7(), intent_id uuid NOT NULL REFERENCES sales.provider_intent(id),
 event_key uuid NOT NULL, payload_hash text NOT NULL, signal text NOT NULL CHECK(signal IN ('OK','FAILED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(intent_id,event_key)
);
CREATE FUNCTION sales.provider_store_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'قصد و شواهد درگاه تغییرناپذیرند'; END $$;
CREATE FUNCTION sales.provider_store_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user<>(SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'نوشتن قصد فقط از توابع کانونی مجاز است'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guarded_insert BEFORE INSERT ON sales.provider_intent FOR EACH ROW EXECUTE FUNCTION sales.provider_store_insert_guard();
CREATE TRIGGER guarded_insert BEFORE INSERT ON sales.provider_intent_event FOR EACH ROW EXECUTE FUNCTION sales.provider_store_insert_guard();
CREATE TRIGGER guarded_insert BEFORE INSERT ON sales.provider_callback_event FOR EACH ROW EXECUTE FUNCTION sales.provider_store_insert_guard();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON sales.provider_intent FOR EACH ROW EXECUTE FUNCTION sales.provider_store_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON sales.provider_intent_event FOR EACH ROW EXECUTE FUNCTION sales.provider_store_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON sales.provider_callback_event FOR EACH ROW EXECUTE FUNCTION sales.provider_store_immutable();

CREATE FUNCTION sales.provider_store_guard(p_actor uuid,p_branch uuid,p_operation text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM identity.app_user WHERE id=p_actor AND is_active)
 OR NOT EXISTS(SELECT 1 FROM identity.can(p_actor,p_operation) WHERE verdict='allow')
 OR NOT EXISTS(SELECT 1 FROM identity.user_role WHERE user_id=p_actor AND (branch_id IS NULL OR branch_id=p_branch))
 THEN RAISE EXCEPTION 'مجوز یا دامنه شعبه برای قصد درگاه کافی نیست'; END IF;
 PERFORM platform.set_actor(p_actor);
END $$;

CREATE FUNCTION sales.create_provider_intent(p_invoice uuid,p_provider text,p_key uuid,p_revision text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inv sales.invoice%ROWTYPE; existing sales.provider_intent%ROWTYPE; snap jsonb; amount numeric; result uuid;
BEGIN
 SELECT * INTO inv FROM sales.invoice WHERE id=p_invoice FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;
 PERFORM sales.provider_store_guard(p_actor,inv.branch_id,'sale.create');
 SELECT * INTO existing FROM sales.provider_intent WHERE actor_id=p_actor AND idempotency_key=p_key;
 IF FOUND THEN
   IF existing.invoice_id<>p_invoice OR existing.provider<>p_provider OR existing.config_revision<>p_revision
   THEN RAISE EXCEPTION 'کلید قصد با درخواست متفاوت استفاده شده است'; END IF;
   RETURN existing.id;
 END IF;
 IF inv.channel<>'web' OR inv.status NOT IN ('draft','confirmed','partially_paid') OR NOT EXISTS(SELECT 1 FROM sales.invoice_line WHERE invoice_id=p_invoice)
 THEN RAISE EXCEPTION 'قصد آفلاین فقط برای فاکتور باز سایت است'; END IF;
 SELECT coalesce(sum(net_amount+tax_amount),0)+inv.shipping_amount INTO amount FROM sales.invoice_line WHERE invoice_id=p_invoice;
 SELECT jsonb_build_object('invoiceId',inv.id,'branchId',inv.branch_id,'currency','IRR','amount',amount::text,
   'shippingAmount',inv.shipping_amount::text,'lines',jsonb_agg(jsonb_build_object('lineId',id,'variationId',variation_id,
   'qty',qty::text,'unitPrice',unit_price::text,'netAmount',net_amount::text,'taxAmount',tax_amount::text) ORDER BY line_no))
 INTO snap FROM sales.invoice_line WHERE invoice_id=p_invoice;
 INSERT INTO sales.provider_intent(invoice_id,branch_id,actor_id,provider,channel,idempotency_key,config_revision,amount,snapshot,snapshot_hash)
 VALUES(p_invoice,inv.branch_id,p_actor,p_provider,'online',p_key,p_revision,amount,snap,encode(public.digest(snap::text,'sha256'),'hex'))
 ON CONFLICT(actor_id,idempotency_key) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN
   SELECT * INTO existing FROM sales.provider_intent WHERE actor_id=p_actor AND idempotency_key=p_key;
   IF existing.invoice_id<>p_invoice OR existing.provider<>p_provider OR existing.config_revision<>p_revision
   THEN RAISE EXCEPTION 'کلید قصد با درخواست متفاوت استفاده شده است'; END IF;
   RETURN existing.id;
 END IF;
 PERFORM platform.audit('provider.intent.create','provider_intent',result::text,jsonb_build_object('invoiceId',p_invoice,'provider',p_provider),p_actor);
 RETURN result;
END $$;

CREATE FUNCTION sales.claim_provider_intent(p_intent uuid,p_version integer,p_operation text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i sales.provider_intent%ROWTYPE; e sales.provider_intent_event%ROWTYPE; state text; claim uuid:=platform.uuid_v7();
BEGIN
 SELECT * INTO i FROM sales.provider_intent WHERE id=p_intent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'قصد یافت نشد'; END IF;
 PERFORM sales.provider_store_guard(p_actor,i.branch_id,'settings.security');
 SELECT * INTO e FROM sales.provider_intent_event WHERE intent_id=p_intent ORDER BY version DESC LIMIT 1;
 IF coalesce(e.version,0)<>p_version THEN RAISE EXCEPTION 'نسخه قصد تغییر کرده است'; END IF;
 state:=coalesce(e.state,'created');
 IF NOT ((p_operation='token' AND state='created') OR (p_operation='verify' AND state='token_ready')
 OR (p_operation='settle' AND state='verified') OR (p_operation='status' AND state='unknown'
   AND EXISTS(SELECT 1 FROM sales.provider_intent_event WHERE intent_id=p_intent AND evidence ? 'paymentToken')))
 THEN RAISE EXCEPTION 'گذار قصد مجاز نیست؛ نتیجه نامعلوم مجوز تلاش تازه نیست'; END IF;
 INSERT INTO sales.provider_intent_event(intent_id,version,state,operation,claim_id,expires_at,actor_id)
 VALUES(p_intent,p_version+1,p_operation||'_claimed',p_operation,claim,clock_timestamp()+interval '30 seconds',p_actor);
 RETURN claim;
END $$;

CREATE FUNCTION sales.finish_provider_intent(p_intent uuid,p_version integer,p_claim uuid,p_outcome text,p_evidence jsonb,p_actor uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i sales.provider_intent%ROWTYPE; e sales.provider_intent_event%ROWTYPE; target text;
BEGIN
 SELECT * INTO i FROM sales.provider_intent WHERE id=p_intent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'قصد یافت نشد'; END IF;
 PERFORM sales.provider_store_guard(p_actor,i.branch_id,'settings.security');
 SELECT * INTO e FROM sales.provider_intent_event WHERE intent_id=p_intent ORDER BY version DESC LIMIT 1;
 -- پاسخ تکراریِ همان claim، شاهد تازه نمی‌سازد.
 IF e.version=p_version+1 AND e.claim_id=p_claim AND e.evidence=p_evidence AND e.state=p_outcome THEN RETURN e.version; END IF;
 IF e.version IS DISTINCT FROM p_version OR e.claim_id IS DISTINCT FROM p_claim OR coalesce(e.state,'') NOT LIKE '%_claimed'
 THEN RAISE EXCEPTION 'claim یا نسخه قصد معتبر نیست'; END IF;
 IF p_outcome='unknown' THEN
   IF p_evidence<>'{}'::jsonb THEN RAISE EXCEPTION 'نتیجه نامعلوم شاهد تأییدشده ندارد'; END IF;
   target:='unknown';
 ELSE
   IF e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'claim منقضی شده؛ ابتدا وضعیت نامعلوم ثبت شود'; END IF;
   IF p_evidence->>'source' IS DISTINCT FROM 'server_adapter' OR p_evidence->>'transactionId' IS DISTINCT FROM i.merchant_reference
     OR p_evidence->>'amount' IS DISTINCT FROM i.amount::text
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_evidence) k WHERE k NOT IN ('source','transactionId','amount','paymentToken'))
   THEN RAISE EXCEPTION 'شاهد سرور با قصد تطبیق ندارد'; END IF;
   IF e.operation='token' AND p_outcome='token_ready' AND length(p_evidence->>'paymentToken') BETWEEN 1 AND 1024 THEN target:=p_outcome;
   ELSIF e.operation='verify' AND p_outcome='verified' THEN target:=p_outcome;
   ELSIF e.operation='settle' AND p_outcome='settled_evidence' THEN target:=p_outcome;
   ELSIF e.operation='status' AND p_outcome IN ('token_ready','verified','settled_evidence','cancelled_evidence') THEN target:=p_outcome;
   ELSE RAISE EXCEPTION 'شاهد برای مرحله قصد معتبر نیست'; END IF;
 END IF;
 INSERT INTO sales.provider_intent_event(intent_id,version,state,operation,claim_id,evidence,actor_id)
 VALUES(p_intent,p_version+1,target,e.operation,p_claim,p_evidence,p_actor);
 RETURN p_version+1;
END $$;

CREATE FUNCTION sales.expire_provider_intent(p_intent uuid,p_version integer,p_actor uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i sales.provider_intent%ROWTYPE; e sales.provider_intent_event%ROWTYPE;
BEGIN
 SELECT * INTO i FROM sales.provider_intent WHERE id=p_intent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'قصد یافت نشد'; END IF;
 PERFORM sales.provider_store_guard(p_actor,i.branch_id,'settings.security');
 SELECT * INTO e FROM sales.provider_intent_event WHERE intent_id=p_intent ORDER BY version DESC LIMIT 1;
 IF e.version IS DISTINCT FROM p_version OR e.state NOT LIKE '%_claimed' OR e.expires_at>clock_timestamp()
 THEN RAISE EXCEPTION 'claim هنوز قابل انقضا نیست'; END IF;
 RETURN sales.finish_provider_intent(p_intent,p_version,e.claim_id,'unknown','{}',p_actor);
END $$;

CREATE FUNCTION sales.record_provider_callback(p_intent uuid,p_key uuid,p_reference text,p_amount text,p_signal text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i sales.provider_intent%ROWTYPE; result uuid; expected text; prior text;
BEGIN
 SELECT * INTO i FROM sales.provider_intent WHERE id=p_intent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'قصد یافت نشد'; END IF;
 PERFORM sales.provider_store_guard(p_actor,i.branch_id,'settings.security');
 IF p_reference IS DISTINCT FROM i.merchant_reference OR p_amount IS DISTINCT FROM i.amount::text OR p_signal NOT IN ('OK','FAILED')
 THEN RAISE EXCEPTION 'callback با قصد ذخیره‌شده تطبیق ندارد'; END IF;
 expected:=encode(public.digest(jsonb_build_array(p_reference,p_amount,p_signal)::text,'sha256'),'hex');
 INSERT INTO sales.provider_callback_event(intent_id,event_key,payload_hash,signal) VALUES(p_intent,p_key,expected,p_signal)
 ON CONFLICT(intent_id,event_key) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN
 SELECT id,payload_hash INTO result,prior FROM sales.provider_callback_event WHERE intent_id=p_intent AND event_key=p_key;
 IF prior<>expected THEN RAISE EXCEPTION 'کلید callback با بدنه متفاوت استفاده شده است'; END IF;
 END IF;
 RETURN result;
END $$;
-- جدول‌ها مسیر نوشتن عمومی نیستند؛ نقش اپلیکیشن نیز در db-roles بسته می‌شود.
REVOKE ALL ON sales.provider_intent,sales.provider_intent_event,sales.provider_callback_event FROM PUBLIC;
COMMIT;
