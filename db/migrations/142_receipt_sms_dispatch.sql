BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE platform.receipt_access ADD COLUMN sending_at timestamptz;
COMMIT;
