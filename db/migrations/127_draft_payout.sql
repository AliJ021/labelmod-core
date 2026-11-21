BEGIN;
SET LOCAL lock_timeout = '5s';

-- هر پرداخت خروجی به دریافت واقعی خود وصل است؛ شمارهٔ پیگیری هر دو نگه داشته می‌شود.
ALTER TABLE treasury.payment ADD COLUMN draft_refund_of uuid REFERENCES treasury.payment(id);
CREATE UNIQUE INDEX payment_draft_refund_once ON treasury.payment(draft_refund_of) WHERE draft_refund_of IS NOT NULL;

CREATE FUNCTION sales.post_draft_payout(p_invoice uuid, p_payment uuid, p_method text, p_ref text, p_reason text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  inv sales.invoice%ROWTYPE;
  paid treasury.payment%ROWTYPE;
  src_kind text;
  dst_kind text;
  src_code text;
  dst_code text;
  payout uuid;
BEGIN
  SELECT * INTO STRICT inv FROM sales.invoice WHERE id=p_invoice FOR UPDATE;
  SELECT * INTO STRICT paid FROM treasury.payment WHERE id=p_payment AND invoice_id=inv.id FOR UPDATE;
  IF inv.channel<>'pos' OR inv.status<>'draft' OR inv.posting_batch_id IS NOT NULL OR
     paid.direction<>'in' OR paid.status NOT IN ('succeeded','settled','reconciled') OR
     nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'وضعیت پیش‌نویس برای برگشت وجه معتبر نیست'; END IF;
  PERFORM 1 FROM sales.cash_shift WHERE id=inv.shift_id AND branch_id=inv.branch_id AND status='open' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'شیفت باز همان شعبه لازم است'; END IF;
  SELECT kind INTO STRICT src_kind FROM treasury.payment_method WHERE code=paid.method_code;
  SELECT kind INTO STRICT dst_kind FROM treasury.payment_method WHERE code=p_method AND is_active;
  IF paid.method_code IN ('snappay','digipay') OR src_kind NOT IN ('cash','card_reader','gateway','transfer') OR
     (p_method <> paid.method_code AND dst_kind NOT IN ('cash','transfer')) THEN
    RAISE EXCEPTION 'روش انتخابی برای این بازپرداخت پشتیبانی نمی‌شود';
  END IF;
  IF dst_kind<>'cash' AND nullif(trim(p_ref),'') IS NULL THEN RAISE EXCEPTION 'شماره پیگیری پرداخت بانکی لازم است'; END IF;
  SELECT account_code INTO STRICT src_code FROM ledger.posting_rule WHERE event_type='sale_shift' AND is_active AND side='debit' AND
    leg=CASE src_kind WHEN 'cash' THEN 'cash' WHEN 'transfer' THEN 'p2p_clearing' WHEN 'card_reader' THEN 'card_clearing' ELSE 'gateway_clearing' END;
  IF paid.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM treasury.account WHERE id=paid.account_id AND ledger_account_code=src_code) THEN
    RAISE EXCEPTION 'نگاشت حساب دریافت تغییر کرده است؛ بررسی حسابدار لازم است';
  END IF;
  SELECT account_code INTO STRICT dst_code FROM ledger.posting_rule WHERE event_type='sale_shift' AND is_active AND side='debit' AND
    leg=CASE dst_kind WHEN 'cash' THEN 'cash' WHEN 'transfer' THEN 'p2p_clearing' WHEN 'card_reader' THEN 'card_clearing' ELSE 'gateway_clearing' END;
  INSERT INTO treasury.payment(invoice_id,shift_id,method_code,direction,amount,status,ref_no,note,draft_refund_of,account_id)
    VALUES(inv.id,inv.shift_id,p_method,'out',paid.amount,'succeeded',nullif(trim(p_ref),''),p_reason,paid.id,
           CASE WHEN p_method=paid.method_code THEN paid.account_id END) RETURNING id INTO payout;
  -- پیش‌نویس فروش در سند دوره وارد نمی‌شود. اختلاف روش دریافت و پرداخت همین‌جا به دفتر می‌رود.
  IF src_code<>dst_code THEN
    PERFORM ledger.post_entry('treasury_transfer',inv.branch_id,platform.business_date(),'بازپرداخت پیش‌نویس',
      jsonb_build_array(jsonb_build_object('leg','to_account','amount',paid.amount,'account_code',src_code),
                        jsonb_build_object('leg','from_account','amount',paid.amount,'account_code',dst_code)),
      'draft_payout',payout,p_actor);
  END IF;
  PERFORM platform.audit('invoice.draft_payout','payment',payout::text,
    jsonb_build_object('invoice',inv.id,'source',paid.id,'from_method',paid.method_code,'to_method',p_method,
                       'amount',paid.amount,'ref',p_ref,'shift',inv.shift_id),p_actor,p_reason);
  RETURN payout;
END $$;
COMMIT;
