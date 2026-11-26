BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO treasury.payment_method(code, name, kind, requires_ref)
VALUES ('shopino', 'شاپینو — وصول توسط بازارگاه', 'gateway', false);

-- A different subsidiary account per branch. A statement supplies the actual
-- destination bank when posted. No contractual/scheduled bank credit.
ALTER TABLE treasury.account ADD COLUMN marketplace_method text REFERENCES treasury.payment_method(code);
ALTER TABLE treasury.account ADD CONSTRAINT marketplace_clearing_shape CHECK (
  marketplace_method IS NULL OR
  (kind='gateway' AND branch_id IS NOT NULL AND settlement_account_id IS NULL)
);
CREATE UNIQUE INDEX account_marketplace_branch ON treasury.account(branch_id, marketplace_method)
  WHERE marketplace_method IS NOT NULL;

CREATE OR REPLACE FUNCTION treasury.payment_terminal(p_branch uuid, p_method text)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(a.id::text)::uuid END
    FROM treasury.payment_method m
    JOIN ledger.posting_rule pr
      ON pr.event_type='sale_shift' AND pr.side='debit' AND pr.is_active
     AND pr.leg=CASE m.kind WHEN 'card_reader' THEN 'card_clearing' WHEN 'gateway' THEN 'gateway_clearing' END
    JOIN treasury.account a
      ON a.is_active AND a.marketplace_method IS NULL
     AND a.kind=CASE m.kind WHEN 'card_reader' THEN 'card_terminal' WHEN 'gateway' THEN 'gateway' END
     AND a.ledger_account_code=pr.account_code AND (a.branch_id=p_branch OR a.branch_id IS NULL)
     AND a.id::text NOT IN (coalesce(platform.setting_text('payment.snappay_account_id',''),''),
                            coalesce(platform.setting_text('payment.digipay_account_id',''),''))
   WHERE m.code=p_method AND m.code<>'shopino'
$$;

CREATE FUNCTION treasury.route_shopino_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_branch uuid;
  v_gl text;
  v_account uuid;
  v_origin treasury.payment%ROWTYPE;
  v_return sales.sale_return%ROWTYPE;
  v_refunded numeric;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.method_code='shopino' OR NEW.method_code='shopino') THEN
    IF (OLD.method_code,OLD.amount,OLD.direction,OLD.invoice_id,OLD.return_id,OLD.account_id,OLD.client_event_id,OLD.refund_origin_id)
       IS DISTINCT FROM
       (NEW.method_code,NEW.amount,NEW.direction,NEW.invoice_id,NEW.return_id,NEW.account_id,NEW.client_event_id,NEW.refund_origin_id) THEN
      RAISE EXCEPTION 'هویت پرداخت شاپینو قابل تغییر نیست';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.method_code<>'shopino' THEN
    IF NEW.account_id IS NOT NULL AND EXISTS (SELECT FROM treasury.account WHERE id=NEW.account_id AND marketplace_method='shopino') THEN
      RAISE EXCEPTION 'حساب شاپینو فقط برای پرداخت همین بازارگاه است';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.direction='in' THEN
    -- Only the website import opens this inbox row before recording the payment.
    SELECT i.branch_id INTO STRICT v_branch FROM sales.invoice i JOIN platform.inbox_message m
      ON m.source='api.web.order' AND m.event_id='woo-order:' || substr(NEW.client_event_id,5)
     AND m.payload->>'paymentMethod'='shopino' AND m.payload->>'branchId'=i.branch_id::text
     AND NEW.client_event_id='woo:' || (m.payload->>'externalId') AND m.result_ref IS NULL
     AND m.payload->>'actorId'=i.created_by::text
     WHERE i.id=NEW.invoice_id AND i.channel='web';
    SELECT account_code INTO STRICT v_gl FROM ledger.posting_rule
      WHERE event_type='sale_shift' AND side='debit' AND leg='gateway_clearing' AND is_active;
    SELECT id INTO v_account FROM treasury.account WHERE branch_id=v_branch AND marketplace_method='shopino';
    IF v_account IS NULL THEN
      INSERT INTO treasury.account(code,name,kind,branch_id,ledger_account_code,marketplace_method)
        VALUES ('SHOPINO-'||v_branch,'مطالبات از شاپینو','gateway',v_branch,v_gl,'shopino')
        ON CONFLICT (branch_id,marketplace_method) WHERE marketplace_method IS NOT NULL DO NOTHING;
    END IF;
    SELECT id INTO STRICT v_account FROM treasury.account WHERE branch_id=v_branch
      AND marketplace_method='shopino' AND is_active AND ledger_account_code=v_gl;
  ELSE
    SELECT * INTO STRICT v_return FROM sales.sale_return WHERE id=NEW.return_id;
    -- A Woo invoice has one incoming payment. Follow an explicit origin for
    -- exchange/split refunds. Serialize partial refunds on that payment.
    SELECT p.* INTO STRICT v_origin FROM treasury.payment p
      JOIN sales.exchange_ancestors(v_return.invoice_id) a ON a.invoice_id=p.invoice_id
      WHERE p.method_code='shopino' AND p.direction='in' AND p.status IN ('succeeded','settled','reconciled')
        AND (coalesce(NEW.refund_origin_id,v_return.refund_payment_id) IS NULL
             OR p.id=coalesce(NEW.refund_origin_id,v_return.refund_payment_id))
      FOR UPDATE OF p;
    SELECT coalesce(sum(amount),0) INTO v_refunded FROM treasury.payment
      WHERE refund_origin_id=v_origin.id AND direction='out' AND status IN ('succeeded','settled','reconciled');
    IF NEW.amount+v_refunded>v_origin.amount THEN RAISE EXCEPTION 'بازپرداخت از ماندهٔ دریافت شاپینو بیشتر است'; END IF;
    v_account:=v_origin.account_id;
    NEW.refund_origin_id:=v_origin.id;
  END IF;
  IF v_account IS NULL OR (NEW.account_id IS NOT NULL AND NEW.account_id<>v_account) THEN
    RAISE EXCEPTION 'حساب مطالبات شاپینو با پرداخت تطبیق ندارد';
  END IF;
  NEW.account_id:=v_account;
  RETURN NEW;
END $$;

-- Alphabetically after payment_fill_terminal. A statement can still update
-- settlement_id on the original payment.
CREATE TRIGGER route_shopino_payment BEFORE INSERT OR UPDATE ON treasury.payment
  FOR EACH ROW EXECUTE FUNCTION treasury.route_shopino_payment();

CREATE FUNCTION treasury.check_marketplace_statement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_branch uuid;
BEGIN
  SELECT branch_id INTO source_branch FROM treasury.account WHERE id=NEW.source_account_id AND marketplace_method='shopino';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF source_branch<>NEW.branch_id OR NEW.bank_reported_amount IS NULL OR NEW.bank_reported_amount<0
     OR EXISTS (SELECT FROM treasury.account WHERE id=NEW.bank_account_id AND branch_id<>NEW.branch_id) THEN
    RAISE EXCEPTION 'برای تسویهٔ شاپینو مبلغ واریز واقعی و شعبهٔ همان حساب لازم است';
  END IF;
  -- post_settlement calculates a fee from the difference for bank terminals.
  -- For a marketplace, an unpaid balance must never silently become a fee.
  IF TG_OP='UPDATE' AND OLD.status='draft' AND OLD.fee_amount<>NEW.fee_amount THEN
    RAISE EXCEPTION 'واریز شاپینو و کارمزد صورت‌حساب با جمع سفارش‌های این بازه برابر نیست';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_marketplace_statement BEFORE INSERT OR UPDATE ON treasury.settlement
  FOR EACH ROW WHEN (NEW.status='posted') EXECUTE FUNCTION treasury.check_marketplace_statement();
COMMIT;
