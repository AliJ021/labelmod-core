-- =====================================================================
-- ۰۳۳ — مجوز مدیریت دستگاه، و نمای دستگاه‌های مورد اعتماد
-- =====================================================================
-- `identity.approve_device()` و `identity.revoke_device()` از مهاجرت
-- ۰۰۷ وجود داشتند و تست هم داشتند — ولی **هیچ فراخوان تولیدی**
-- نداشتند. تنها صداکننده‌هایشان فایل‌های تست بودند.
--
-- نتیجه‌اش این بود که ADR-005 روی کاغذ درست بود و در عمل نه:
--
--     ثبت‌نشده ──تأیید مدیر──→ تأییدشده ──ورود کامل──→ ثبت‌نام‌شده
--                  ▲
--                  └── این گام در محصول وجود نداشت
--
-- یعنی هیچ دستگاهی هرگز تأیید نمی‌شد، پس **PIN صندوق‌دار هیچ‌وقت باز
-- نمی‌شد**. هر بار قفل صفحه = ورود کامل با رمز. و بند ۱ SECURITY.md
-- («قطع دسترسی گوشی مفقودی») هم از محصول شدنی نبود.
--
-- این مهاجرت خودِ توابع را دست نمی‌زند — درست‌اند. فقط مجوزی که
-- مسیرشان لازم دارد، و نمایی که صفحه از آن می‌خواند.
-- =====================================================================

BEGIN;

-- ── ۱. مجوز و فهرست ممنوعه PIN — برای نصب‌های موجود ─────────────────
-- ⚠️ قاعده مجوز و مقدار پیش‌فرض تنظیم، **داده مرجع‌اند و در
--    `db/seed/` می‌نشینند**، نه اینجا. نقش‌ها هم از همان seed می‌آیند،
--    پس درج قاعده در مهاجرت اصلاً ممکن نیست: کلید خارجی `role_code`
--    هنوز چیزی برای اشاره ندارد.
--
-- آنچه اینجا می‌ماند فقط کاری است که seed **نمی‌تواند** بکند: seed
-- عمداً Idempotent است و سطر موجود را دست نمی‌زند، پس روی نصبی که
-- قبلاً بالا آمده، گزینه تازه هرگز به تنظیم اضافه نمی‌شود.
--
-- روی دیتابیس خالی این دو دستور بی‌اثرند (تنظیم هنوز وجود ندارد و
-- seed بعد از مهاجرت اجرا می‌شود) و همان seed مقدار درست را می‌گذارد.

-- نشستی که با PIN باز شده نباید بتواند دستگاه تازه‌ای را تأیید کند —
-- وگرنه کسی که PIN را دارد می‌تواند دستگاه خودش را «مورد اعتماد» کند
-- و دفاع لایه‌ای فرو می‌ریزد.
--
-- ⚠️ **مقدار از `platform.set_setting()` عوض می‌شود، نه با `UPDATE`.**
--    نسخه اول این مهاجرت `UPDATE platform.setting SET value = …`
--    داشت و روی هر نصبِ موجود می‌شکست:
--
--        ERROR: مقدار تنظیم «auth.pin_forbidden_operations» فقط از
--               platform.set_setting() عوض می‌شود
--
--    روی دیتابیس خالی دیده نمی‌شد، چون آنجا تنظیم هنوز وجود ندارد
--    (مهاجرت پیش از seed اجرا می‌شود) و `UPDATE` صفر سطر می‌گرفت.
--    یعنی دقیقاً همان کلاسِ باگی که مسیر ارتقا برای گرفتنش هست.
--
--    `options` اما با `UPDATE` عوض می‌شود و همین درست است: نگهبان فقط
--    روی `value` است، چون آن داده مالی است و این فراداده نمایش.
DO $pin$
DECLARE
  v_value  jsonb;
  v_system uuid;
BEGIN
  SELECT value INTO v_value FROM platform.setting
   WHERE key = 'auth.pin_forbidden_operations';

  -- روی دیتابیس خالی هنوز وجود ندارد؛ seed مقدار درست را می‌گذارد.
  IF NOT FOUND THEN RETURN; END IF;
  IF v_value ? 'device.manage' THEN RETURN; END IF;

  -- گزینه نمایشی — فراداده است، نه مقدار، پس نگهبان ندارد.
  UPDATE platform.setting
     SET options = coalesce(options, '[]'::jsonb)
                || '[{"value":"device.manage","label":"تأیید و ابطال دستگاه"}]'::jsonb
   WHERE key = 'auth.pin_forbidden_operations'
     AND NOT (coalesce(options, '[]'::jsonb) @> '[{"value":"device.manage"}]'::jsonb);

  -- کاربر «سیستم» را seed می‌سازد و هرگز وارد نمی‌شود؛ همان نامی است
  -- که کار خودکار به آن ثبت می‌شود. اگر نبود، تغییر انجام نمی‌شود —
  -- سکوت بهتر از سندی است که کاربر عاملش دروغ باشد.
  SELECT id INTO v_system FROM identity.app_user WHERE username = 'system';
  IF NOT FOUND THEN
    RAISE NOTICE 'کاربر «سیستم» نیست؛ device.manage به فهرست ممنوعه PIN اضافه نشد. پس از seed دوباره اجرا شود.';
    RETURN;
  END IF;

  PERFORM platform.set_setting(
    'auth.pin_forbidden_operations',
    v_value || '["device.manage"]'::jsonb,
    'مهاجرت ۰۳۳ — تأیید دستگاه نباید با PIN ممکن باشد',
    v_system);
END $pin$;

-- ── ۳. نمای دستگاه‌ها ────────────────────────────────────────────────
-- سه چیزی که صفحه لازم دارد و هیچ‌کدام در `identity.device` نیستند:
-- نام تأییدکننده، تعداد نشست زنده، و اینکه دستگاه ثبت‌نام کامل کرده
-- یا فقط تأیید شده.
--
-- ⚠️ `secret_hash` **در این نما نیست و نباید باشد.** یک راز است؛
--    حتی هشش هم به لایه API نمی‌رود. `enrolled` فقط می‌گوید هست یا نه.
CREATE OR REPLACE VIEW identity.device_overview AS
SELECT
  d.id,
  d.fingerprint,
  d.label,
  d.kind,
  d.branch_id,
  b.name        AS branch_name,
  d.is_approved,
  d.approved_at,
  d.approved_by,
  u.full_name   AS approved_by_name,
  (d.secret_hash IS NOT NULL) AS enrolled,
  d.enrolled_at,
  d.last_seen_at,
  d.created_at,
  (SELECT count(*) FROM identity.session s
    WHERE s.device_id = d.id
      AND s.revoked_at IS NULL
      AND s.expires_at > now())::int AS active_sessions
FROM identity.device d
LEFT JOIN platform.branch    b ON b.id = d.branch_id
LEFT JOIN identity.app_user  u ON u.id = d.approved_by;

COMMENT ON VIEW identity.device_overview IS
  'دستگاه‌ها برای صفحه مدیریت. secret_hash عمداً اینجا نیست — یک راز است.';

-- ── ۴. ابطال همه نشست‌های یک کاربرِ دیگر ─────────────────────────────
-- `identity.revoke_all_sessions()` از مهاجرت ۰۰۶ هست، ولی تنها مسیر
-- API‌اش `/auth/revoke-all` بود که فقط نشست‌های **خودِ** کاربر را
-- می‌بندد. «گوشی صندوق‌دار گم شد» را خودِ صندوق‌دار نمی‌تواند حل کند —
-- گوشی دستش نیست.
--
-- تابع تازه‌ای لازم نیست؛ فقط یک تابع نازک که دلیل را استاندارد
-- می‌کند و مطمئن می‌شود کاربر عامل ثبت می‌شود.
CREATE OR REPLACE FUNCTION identity.revoke_user_access(
  p_user uuid, p_reason text DEFAULT 'admin_revoked'
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := platform.current_actor();
  v_n     int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.app_user WHERE id = p_user) THEN
    RAISE EXCEPTION 'کاربر یافت نشد: %', p_user;
  END IF;

  v_n := identity.revoke_all_sessions(p_user, p_reason, v_actor);
  RETURN v_n;
END $$;

COMMIT;
