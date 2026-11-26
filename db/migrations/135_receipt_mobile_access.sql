BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE platform.receipt_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts smallint NOT NULL DEFAULT 0,
  sent_at timestamptz,
  session_hash text UNIQUE,
  session_until timestamptz
);
CREATE INDEX receipt_access_mobile_time ON platform.receipt_access(mobile,created_at);
CREATE INDEX receipt_access_cleanup ON platform.receipt_access(created_at);
COMMIT;
