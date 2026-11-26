BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE platform.invoice_sms_dispatch
  ADD COLUMN rendered text,
  ADD COLUMN pattern_id integer;
COMMIT;
