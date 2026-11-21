BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION sales.return_shipping_remaining(p_invoice uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT i.shipping_amount-coalesce((SELECT sum(r.shipping_amount) FROM sales.sale_return r
    WHERE r.invoice_id=i.id AND r.status='posted'),0) FROM sales.invoice i WHERE i.id=p_invoice
$$;

-- The three-argument contract continues to preview selected merchandise only.
CREATE FUNCTION sales.return_account_preview(p_invoice uuid, p_lines jsonb, p_refund numeric, p_full boolean)
RETURNS TABLE (returned_value numeric, outstanding numeric, funds numeric, max_refund numeric,
  suggested_refund numeric, refund numeric, debt_applied numeric, customer_credit numeric, problem text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE base record; due numeric; paid numeric;
BEGIN
  SELECT * INTO STRICT base FROM sales.return_account_preview(p_invoice,p_lines,p_refund);
  IF NOT p_full THEN
    RETURN QUERY SELECT base.returned_value,base.outstanding,base.funds,base.max_refund,base.suggested_refund,
      base.refund,base.debt_applied,base.customer_credit,base.problem;
    RETURN;
  END IF;
  returned_value:=base.returned_value+sales.return_shipping_remaining(p_invoice);
  due:=base.outstanding;
  paid:=base.funds;
  outstanding:=due;
  funds:=paid;
  max_refund:=least(returned_value,greatest(paid,0));
  suggested_refund:=least(greatest(paid,0),greatest(returned_value-due,0));
  refund:=suggested_refund;
  debt_applied:=least(greatest(returned_value-refund,0),due);
  customer_credit:=returned_value-refund-debt_applied;
  problem:=NULL;
  RETURN NEXT;
END $$;

-- Keep the bank confirmation on the outgoing payment as well as its return.
CREATE FUNCTION sales.return_payout_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.ref_no IS NULL THEN
    SELECT r.refund_reference INTO NEW.ref_no FROM sales.sale_return r WHERE r.id=NEW.return_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER return_payout_reference BEFORE INSERT ON treasury.payment FOR EACH ROW
WHEN (NEW.return_id IS NOT NULL AND NEW.direction='out') EXECUTE FUNCTION sales.return_payout_reference();
COMMIT;
