-- 077 — حفظ دسترسی مستقل مدیر و محدودکردن نشست PIN.
BEGIN;

CREATE OR REPLACE FUNCTION identity.set_permission_rule(
  p_role      text,
  p_operation text,
  p_allowed   boolean,
  p_max_amount  platform.money,
  p_max_percent numeric,
  p_needs_approval_from text,
  p_reason    text,
  p_user      uuid
) RETURNS identity.permission_rule
LANGUAGE plpgsql AS $$
DECLARE
  v_before identity.permission_rule%ROWTYPE;
  v_after  identity.permission_rule%ROWTYPE;
  v_left   int;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'تغییر مجوز بدون کاربر عامل مجاز نیست.';
  END IF;
  PERFORM platform.set_actor(p_user);

  IF NOT EXISTS (SELECT 1 FROM identity.role WHERE code = p_role) THEN
    RAISE EXCEPTION 'نقش % وجود ندارد.', p_role;
  END IF;

  IF coalesce(btrim(p_operation), '') = '' THEN
    RAISE EXCEPTION 'نام عملیات نمی‌تواند خالی باشد.';
  END IF;

  IF p_max_percent IS NOT NULL AND (p_max_percent < 0 OR p_max_percent > 100) THEN
    RAISE EXCEPTION 'سقف درصدی باید بین ۰ و ۱۰۰ باشد (دریافت‌شده: %).', p_max_percent;
  END IF;

  IF p_max_amount IS NOT NULL AND p_max_amount < 0 THEN
    RAISE EXCEPTION 'سقف مبلغی نمی‌تواند منفی باشد.';
  END IF;

  IF p_needs_approval_from IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM identity.role WHERE code = p_needs_approval_from) THEN
    RAISE EXCEPTION 'نقشِ تأییدکننده % وجود ندارد.', p_needs_approval_from;
  END IF;

  -- تغییرهای هم‌زمان نباید هر دو آخرین مجوز مستقل را حذف کنند.
  PERFORM pg_advisory_xact_lock(hashtextextended('identity.set_permission_rule', 0));

  SELECT * INTO v_before FROM identity.permission_rule
   WHERE role_code = p_role AND operation = p_operation;

  INSERT INTO identity.permission_rule
    (role_code, operation, allowed, max_amount, max_percent, needs_approval_from)
  VALUES
    (p_role, btrim(p_operation), coalesce(p_allowed, false),
     p_max_amount, p_max_percent, p_needs_approval_from)
  ON CONFLICT (role_code, operation) DO UPDATE
    SET allowed             = EXCLUDED.allowed,
        max_amount          = EXCLUDED.max_amount,
        max_percent         = EXCLUDED.max_percent,
        needs_approval_from = EXCLUDED.needs_approval_from
  RETURNING * INTO v_after;

  -- ── نگهبان قفل‌شدن ─────────────────────────────────────────────
  -- اگر این تغییر آخرین نقشی را که می‌تواند مجوز عوض کند هم ببندد،
  -- دیگر راهی برای برگرداندنش از داخل سیستم نمی‌ماند.
  SELECT count(*) INTO v_left
    FROM identity.permission_rule
   WHERE operation = 'settings.security' AND allowed AND needs_approval_from IS NULL;

  IF v_left = 0 THEN
    RAISE EXCEPTION
      'این تغییر آخرین نقشی را که می‌تواند مجوزها را عوض کند می‌بندد. دست‌کم یک نقش باید «settings.security» داشته باشد.';
  END IF;

  PERFORM platform.audit('permission.set', 'permission_rule',
    p_role || ':' || p_operation,
    jsonb_build_object(
      'before', CASE WHEN v_before.role_code IS NULL THEN NULL ELSE to_jsonb(v_before) END,
      'after',  to_jsonb(v_after),
      'reason', p_reason),
    p_user);

  RETURN v_after;
END $$;

DO $pin$
DECLARE
  v_value jsonb;
  v_next jsonb;
  v_system uuid;
BEGIN
  SELECT value INTO v_value FROM platform.setting WHERE key='auth.pin_forbidden_operations' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF; -- نصب تازه از seed مقدار کامل می‌گیرد.
  UPDATE platform.setting SET options=coalesce(options,'[]'::jsonb)
    || '[{"value":"stock.count","label":"ثبت انبارگردانی"}]'::jsonb
    WHERE key='auth.pin_forbidden_operations'
      AND NOT (coalesce(options,'[]'::jsonb) @> '[{"value":"stock.count"}]'::jsonb);
  UPDATE platform.setting SET options=coalesce(options,'[]'::jsonb)
    || '[{"value":"report.customer_insight","label":"دیدن تحلیل سبد و خرید هر مشتری"}]'::jsonb
    WHERE key='auth.pin_forbidden_operations'
      AND NOT (coalesce(options,'[]'::jsonb) @> '[{"value":"report.customer_insight"}]'::jsonb);
  v_next := v_value;
  IF NOT (v_next ? 'stock.count') THEN v_next := v_next || '["stock.count"]'::jsonb; END IF;
  IF NOT (v_next ? 'report.customer_insight') THEN v_next := v_next || '["report.customer_insight"]'::jsonb; END IF;
  IF v_next = v_value THEN RETURN; END IF;
  SELECT id INTO STRICT v_system FROM identity.app_user WHERE username='system';
  PERFORM platform.set_setting('auth.pin_forbidden_operations', v_next,
    'مهاجرت ۰۷۷ — انبارگردانی و تحلیل خرید مشتری به ورود کامل نیاز دارند', v_system);
END $pin$;

COMMIT;
