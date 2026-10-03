-- Existing installations already have the guarded PIN setting. Prepare it
-- through its audited gateway before 085; do not change applied migrations.
BEGIN;
DO $pin$
DECLARE
  v_value jsonb;
  v_system uuid;
BEGIN
  SELECT value INTO v_value FROM platform.setting
    WHERE key = 'auth.pin_forbidden_operations' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF; -- Fresh installations receive the full seed.

  UPDATE platform.setting
    SET options = coalesce(options, '[]'::jsonb)
      || '[{"value":"exchange.policy","label":"سیاست بدهی در تعویض"}]'::jsonb
    WHERE key = 'auth.pin_forbidden_operations'
      AND NOT (coalesce(options, '[]'::jsonb) @> '[{"value":"exchange.policy"}]'::jsonb);

  IF v_value ? 'exchange.policy' THEN RETURN; END IF;
  SELECT id INTO STRICT v_system FROM identity.app_user WHERE username = 'system';
  PERFORM platform.set_setting('auth.pin_forbidden_operations',
    v_value || '["exchange.policy"]'::jsonb,
    'مهاجرت ۰۸۴ تکمیلی — سیاست بدهی تعویض به ورود کامل نیاز دارد', v_system);
END $pin$;
COMMIT;
