BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE sales.invoice_archive (
  invoice_id uuid PRIMARY KEY REFERENCES sales.invoice(id),
  actor_id uuid NOT NULL REFERENCES identity.app_user(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
  archived_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
