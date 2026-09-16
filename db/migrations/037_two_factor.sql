-- =====================================================================
-- ۰۳۷ — احراز هویت دومرحله‌ای: TOTP، کد بازیابی، WebAuthn
-- =====================================================================
-- بند ۱ `docs/SECURITY.md` این را از روز اول الزام کرده بود:
--
--   «اولویت اول: WebAuthn / Passkey … پشتیبان: TOTP … کدهای بازیابی
--    یک‌بارمصرف، درهم‌شده ذخیره شوند.»
--
-- ستون `app_user.totp_secret` هم از روز اول بود و **هیچ‌چیز
-- نمی‌نوشتش**. یعنی الزامی که در سند نوشته شده بود، در محصول یک ستون
-- خالی بود.
--
-- ── چهار تصمیمی که این مهاجرت می‌گیرد ─────────────────────────────
--
-- **راز تأییدنشده، راز نیست.** `app_user.totp_secret` فقط راز
-- **تأییدشده** را نگه می‌دارد و تا آن لحظه `NULL` است. راز در جریان
-- ثبت‌نام جای دیگری می‌نشیند (`identity.totp_enrollment`). اگر یکی
-- بودند، کاربری که وسط ثبت‌نام رها می‌کرد، دفعه بعد پشت یک کد
-- دومرحله‌ای که هرگز اسکن نکرده قفل می‌شد.
--
-- **کد بازیابی با SHA-256، نه Argon2id.** این یک استثنا نیست: کد
-- بازیابی یک **راز تصادفی ۲۰ کاراکتری** است، نه یک رمز انسانی. حمله
-- فرهنگ‌لغت رویش بی‌معناست و Argon2id فقط ده برابر کندش می‌کند. همان
-- استدلالی که برای توکن نشست هست.
--
-- **شمارنده WebAuthn برمی‌گردد → کلید Clone شده.** استاندارد
-- می‌گوید شمارنده باید صعودی باشد؛ نزول یعنی همان کلید جای دیگری هم
-- هست. ستونش اینجاست و منطقش در لایه API.
--
-- **«چه کسی ۲FA لازم دارد» داده است، نه کد.** `auth.require_2fa_roles`
-- یک تنظیم است. بند ۱ می‌گوید مدیر و حسابدار، ولی مالک باید بتواند
-- بدون Deploy عوضش کند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. ثبت‌نام TOTP در جریان
-- ---------------------------------------------------------------------
-- یک ردیف برای هر کاربر، حداکثر. ثبت‌نام تازه، قبلی را جایگزین می‌کند.

CREATE TABLE identity.totp_enrollment (
  user_id    uuid PRIMARY KEY REFERENCES identity.app_user(id) ON DELETE CASCADE,
  secret     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.totp_enrollment IS
  'راز TOTP در جریان ثبت‌نام — تا تأیید نشود به app_user.totp_secret منتقل نمی‌شود.';

-- ---------------------------------------------------------------------
-- ۲. کد بازیابی یک‌بارمصرف
-- ---------------------------------------------------------------------
-- تنها راه ورود وقتی گوشی گم شده است. هر کد **یک بار** و تمام.

CREATE TABLE identity.recovery_code (
  id         uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- همان کد دو بار برای یک کاربر ساخته نمی‌شود.
  UNIQUE (user_id, code_hash)
);

CREATE INDEX ON identity.recovery_code (user_id) WHERE used_at IS NULL;

COMMENT ON TABLE identity.recovery_code IS
  'کد بازیابی یک‌بارمصرف، SHA-256 شده. متن خام فقط یک بار در لحظه ساخت دیده می‌شود.';

-- مصرف‌شده هرگز به استفاده‌نشده برنمی‌گردد. بدون این، یک `UPDATE`
-- کافی بود تا کدی که یک بار خرج شده دوباره کار کند.
CREATE OR REPLACE FUNCTION identity.recovery_code_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'کد بازیابی مصرف‌شده دوباره فعال نمی‌شود';
  END IF;
  IF NEW.code_hash <> OLD.code_hash OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'کد بازیابی تغییر نمی‌کند؛ فهرست تازه بسازید';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER recovery_code_guard
  BEFORE UPDATE ON identity.recovery_code
  FOR EACH ROW EXECUTE FUNCTION identity.recovery_code_guard();

-- ---------------------------------------------------------------------
-- ۳. کلید WebAuthn
-- ---------------------------------------------------------------------
-- `public_key` و `credential_id` هر دو Base64URL ذخیره می‌شوند: مقدار
-- خام باینری‌اند و `bytea` در JSON و در لاگ، خواندنشان را سخت می‌کند
-- بی‌آنکه امنیتی اضافه کند.

CREATE TABLE identity.webauthn_credential (
  id             uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  user_id        uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  credential_id  text NOT NULL UNIQUE,
  public_key     text NOT NULL,
  -- شمارنده صعودی. نزولش یعنی کلید Clone شده — استاندارد همین را
  -- می‌گوید و لایه API ردش می‌کند.
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[],
  device_type    text,
  backed_up      boolean NOT NULL DEFAULT false,
  name           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);

CREATE INDEX ON identity.webauthn_credential (user_id);

COMMENT ON TABLE identity.webauthn_credential IS
  'کلید عمومی WebAuthn. شمارنده باید صعودی بماند؛ نزولش نشانه Clone شدن کلید است.';

-- ---------------------------------------------------------------------
-- ۴. چالش در جریان — برای ثبت‌نام و ورود
-- ---------------------------------------------------------------------
-- چالش WebAuthn باید سمت سرور نگه داشته شود و **یک بار** مصرف شود.
-- نگه‌داشتنش در حافظه یعنی با Restart همه چالش‌های باز می‌میرند و در
-- دو نمونه اصلاً کار نمی‌کند.

CREATE TABLE identity.webauthn_challenge (
  id         uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  challenge  text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('register','login')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON identity.webauthn_challenge (user_id, kind);

-- ---------------------------------------------------------------------
-- ۵. مرحله دوم ورود — نشست نیمه‌ساخته
-- ---------------------------------------------------------------------
-- رمز درست بود ولی هنوز عامل دوم نیامده. این **نشست نیست**: هیچ
-- مسیری را باز نمی‌کند و فقط می‌گوید «این کاربر رمزش را داده است».
--
-- عمرش کوتاه است (پیش‌فرض ۵ دقیقه) چون تنها کارش رساندن کاربر به
-- مرحله دوم است.

CREATE TABLE identity.pending_login (
  id          uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  device_id   uuid REFERENCES identity.device(id),
  ip          inet,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON identity.pending_login (user_id);

COMMENT ON TABLE identity.pending_login IS
  'رمز درست بود، عامل دوم نه. هیچ مسیری را باز نمی‌کند — فقط پل مرحله دوم است.';

-- ---------------------------------------------------------------------
-- ۶. آیا این کاربر عامل دوم لازم دارد؟
-- ---------------------------------------------------------------------
-- **داده، نه کد.** `auth.require_2fa_roles` فهرست نقش‌هایی است که
-- بدون عامل دوم وارد نمی‌شوند. بند ۱ SECURITY.md مدیر و حسابدار را
-- می‌گوید، ولی مالک باید بتواند بدون Deploy عوضش کند.
--
-- ⚠️ کاربری که هنوز ۲FA راه نینداخته و نقشش در فهرست است، **قفل
--    نمی‌شود** — وگرنه اولین بار که مالک این تنظیم را روشن کند، خودش
--    هم بیرون می‌ماند. به‌جایش وارد می‌شود و صفحه به او می‌گوید که
--    باید راه بیندازد. اجبار واقعی وقتی معنا دارد که راه‌اندازی
--    ممکن باشد.

CREATE OR REPLACE FUNCTION identity.needs_second_factor(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.app_user u
     WHERE u.id = p_user
       AND (u.totp_secret IS NOT NULL
            OR EXISTS (SELECT 1 FROM identity.webauthn_credential w
                        WHERE w.user_id = p_user))
  );
$$;

COMMENT ON FUNCTION identity.needs_second_factor IS
  'کاربری که عامل دومی راه انداخته باشد، از آن به بعد بدون آن وارد نمی‌شود. کاربر بدون عامل دوم قفل نمی‌شود — تنظیم فقط هشدار می‌سازد.';

/**
 * آیا نقش این کاربر در فهرست الزام است؟ — برای هشدار، نه برای قفل.
 */
CREATE OR REPLACE FUNCTION identity.should_have_second_factor(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.user_role r
     WHERE r.user_id = p_user
       AND to_jsonb(r.role_code) <@ platform.setting_json('auth.require_2fa_roles')
  );
$$;

COMMIT;
