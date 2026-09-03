-- =====================================================================
-- ۰۳۰ — کلاینت ماشینی (کلید API)
-- =====================================================================
-- افزونه ووکامرس یک مرورگر نیست: نه کوکی نشست دارد، نه صفحه ورود، و
-- نه کسی پشتش نشسته که رمز بزند. برای فرستادن سفارش سایت به این
-- سیستم، یک راه احراز هویت **ماشینی** لازم است.
--
-- ── تصمیمی که همه‌چیز را ساده کرد ───────────────────────────────────
--
-- هر کلاینت API یک **کاربر واقعی** پشتش دارد (`user_id`).
--
-- وسوسه اول یک سیستم مجوز جدا بود — «Scope»ها روی خودِ کلاینت. رد
-- شد: آن‌وقت دو تعریف از دسترسی داشتیم، و قاعده «هیچ شرط دسترسی در
-- کد نیست» فقط برای یکی‌شان برقرار می‌ماند.
--
-- با کاربر پشتی، همه‌چیز دست‌نخورده کار می‌کند:
--   • `identity.can()` همان `user_role` را می‌خواند
--   • `platform.audit()` همان کاربر را می‌نویسد، پس در لاگ حسابرسی
--     معلوم است «سایت این را ثبت کرده»، نه یک کاربر ناشناس
--   • `journal_line.party_id` و بقیه، همه بی‌تغییر
--
-- آن کاربر مثل کاربر «سیستم» هرگز نمی‌تواند وارد شود: نه رمز، نه PIN،
-- و `is_active = false`. مسیر ورود `is_active` را می‌سنجد
-- (`auth/service.ts`)، پس کلید API تنها راه اوست.
--
-- ── کلید مثل توکن نشست، فقط هش می‌نشیند ─────────────────────────────
--
-- SHA-256 کلید در جدول است، نه خودِ کلید (همان قاعده بند ۱
-- SECURITY.md برای نشست). یک بار در لحظه ساخت چاپ می‌شود و بس.
-- باطل‌کردنش یک `UPDATE is_active = false` است.
--
-- Argon2 اینجا لازم نیست و اشتباه است: کلید ۳۲ بایت تصادفی است، نه
-- رمزی که آدم انتخاب کرده. حمله فرهنگ‌لغتی رویش معنا ندارد و هزینه
-- Argon2 روی **هر درخواست** سایت می‌نشست.
-- =====================================================================

BEGIN;

CREATE TABLE identity.api_client (
  id          uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  name        text NOT NULL,
  -- کاربر پشتی — همه مجوزها و ردّ حسابرسی از او می‌آید.
  user_id     uuid NOT NULL REFERENCES identity.app_user(id),
  -- SHA-256 کلید، شصت‌وچهار رقم هگز. خودِ کلید هرگز ذخیره نمی‌شود.
  key_hash    text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES identity.app_user(id),
  -- برای اینکه بشود دید کدام کلید هنوز زنده است و کدام فراموش شده.
  last_used_at timestamptz,
  note        text
);

CREATE INDEX api_client_user_idx ON identity.api_client (user_id);

COMMENT ON TABLE identity.api_client IS
  'کلاینت ماشینی (افزونه ووکامرس و مانند آن). مجوزش از کاربر پشتی می‌آید، نه از خودش.';

-- ---------------------------------------------------------------------
-- حل کلید → کاربر
-- ---------------------------------------------------------------------
-- تابع، نه یک SELECT در لایه API: `last_used_at` باید در همان رفت‌وبرگشت
-- به‌روز شود، وگرنه یا یک کوئری اضافه می‌خورد یا هرگز نوشته نمی‌شود.

CREATE FUNCTION identity.api_client_from_key(p_key_hash text)
RETURNS TABLE (client_id uuid, user_id uuid, client_name text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  UPDATE identity.api_client c
     SET last_used_at = now()
   WHERE c.key_hash = p_key_hash
     AND c.is_active
     -- کاربر پشتی هم باید وجود داشته باشد. حذف کاربر ممکن نیست
     -- (کلید خارجی)، ولی این شرط رفتار را صریح می‌کند.
     AND EXISTS (SELECT 1 FROM identity.app_user u WHERE u.id = c.user_id)
  RETURNING c.id, c.user_id, c.name;
END $$;

COMMENT ON FUNCTION identity.api_client_from_key IS
  'کلید فعال → کاربر پشتی. زمان استفاده را در همان رفت‌وبرگشت به‌روز می‌کند.';

COMMIT;
