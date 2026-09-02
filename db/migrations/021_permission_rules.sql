-- =====================================================================
-- ۰۲۱ — ویرایش سقف مجوزها از صفحه
-- =====================================================================
-- سقف تخفیف، سقف بازپرداخت و «چه نقشی چه کاری می‌تواند» همه در
-- `identity.permission_rule` نشسته‌اند. قاعده پروژه از اول این بود که
-- **هیچ شرط دسترسی در کد نباشد** — و نبود. ولی تغییرشان فقط از psql
-- ممکن بود، که برای مالک یعنی «باید کد بزنی».
--
-- ── چرا تابع، نه UPDATE مستقیم از API ───────────────────────────────
--
-- این جدول تعیین می‌کند چه کسی چقدر تخفیف می‌دهد و چه کسی می‌تواند
-- فاکتور را ابطال کند. یک `UPDATE` خام نه ردّ حسابرسی می‌گذارد، نه
-- جلوی قفل‌شدن کامل سیستم را می‌گیرد.
--
-- ── نگهبانی که بیشتر از همه اهمیت دارد ──────────────────────────────
--
-- کسی می‌تواند با یک کلیک، مجوز «ویرایش مجوزها» را از همه نقش‌ها
-- بردارد. آن‌وقت **هیچ‌کس** — حتی مدیر — نمی‌تواند برش گرداند، و تنها
-- راه، psql روی سرور است. این نگهبان جلویش را می‌گیرد.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. ثبت یا ویرایش یک قاعده
-- ---------------------------------------------------------------------

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
   WHERE operation = 'settings.security' AND allowed;

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

COMMENT ON FUNCTION identity.set_permission_rule IS
  'تنها مسیر تغییر مجوز و سقف: اعتبارسنجی، ردّ حسابرسی، و نگهبان قفل‌شدن.';

-- ---------------------------------------------------------------------
-- ۲. نمای مجوزها برای صفحه
-- ---------------------------------------------------------------------
-- عملیات‌های شناخته‌شده از خودِ قواعد موجود درمی‌آیند، نه از فهرستی در
-- کد. اگر فردا عملیات تازه‌ای اضافه شود، صفحه بدون تغییر می‌بیندش.

CREATE OR REPLACE VIEW identity.permission_matrix AS
SELECT r.code                AS role_code,
       r.name                AS role_name,
       o.operation,
       coalesce(p.allowed, false) AS allowed,
       p.max_amount,
       p.max_percent,
       p.needs_approval_from,
       (p.role_code IS NOT NULL)  AS has_rule
  FROM identity.role r
 CROSS JOIN (SELECT DISTINCT operation FROM identity.permission_rule) o
  LEFT JOIN identity.permission_rule p
         ON p.role_code = r.code AND p.operation = o.operation;

COMMIT;
