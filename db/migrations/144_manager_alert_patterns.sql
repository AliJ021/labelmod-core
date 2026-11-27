BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE platform.melipayamak_credential
  ADD COLUMN cheque_pattern integer CHECK(cheque_pattern>0),
  ADD COLUMN health_pattern integer CHECK(health_pattern>0);
COMMIT;
