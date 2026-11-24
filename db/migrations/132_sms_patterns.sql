BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE platform.melipayamak_credential
  ADD COLUMN transport text NOT NULL DEFAULT 'console' CHECK (transport IN ('console','panel')),
  ADD COLUMN otp_pattern integer CHECK (otp_pattern > 0),
  ADD COLUMN invoice_pattern integer CHECK (invoice_pattern > 0),
  ADD COLUMN otp_copy text NOT NULL DEFAULT '',
  ADD COLUMN invoice_copy text NOT NULL DEFAULT '';

CREATE TABLE platform.invoice_sms_dispatch (
  invoice_id uuid PRIMARY KEY REFERENCES sales.invoice(id),
  state text NOT NULL CHECK (state IN ('sending','accepted','unknown')),
  provider_ref text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_sms_dispatch_recent ON platform.invoice_sms_dispatch(updated_at DESC);

COMMIT;
