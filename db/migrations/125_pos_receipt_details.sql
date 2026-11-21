BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE sales.invoice_number_counter
SET last_value = greatest(last_value, 1404)
WHERE singleton AND last_value < 1404;

ALTER TABLE sales.customer ADD COLUMN salutation text CHECK (salutation IN ('mr','ms'));
ALTER TABLE sales.invoice ADD COLUMN receipt_customer_name text;
ALTER TABLE sales.invoice ADD COLUMN seller_id uuid REFERENCES identity.app_user(id);

CREATE FUNCTION sales.customer_print_name(p_name text, p_title text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN nullif(trim(p_name),'') IS NULL THEN NULL
   WHEN p_title IS NULL OR trim(p_name) ~ '^(آقا|آقای|خانم)([[:space:]‌]|$)' THEN trim(p_name)
   WHEN p_title='mr' THEN 'آقا ' || trim(p_name)
   ELSE 'خانم ' || trim(p_name) END
$$;

CREATE FUNCTION sales.snapshot_receipt_customer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  SELECT sales.customer_print_name(c.full_name,c.salutation) INTO NEW.receipt_customer_name
    FROM sales.customer c WHERE c.id=NEW.customer_id;
  NEW.receipt_customer_name := coalesce(NEW.receipt_customer_name,'');
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_receipt_customer BEFORE UPDATE OF number ON sales.invoice
FOR EACH ROW WHEN (OLD.number IS NULL AND NEW.number IS NOT NULL)
EXECUTE FUNCTION sales.snapshot_receipt_customer();
COMMIT;
