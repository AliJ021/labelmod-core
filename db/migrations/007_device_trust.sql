-- =====================================================================
-- ۰۰۷ — اعتماد دستگاه و ارتقای نشست
-- =====================================================================
-- بازبینی امنیتی روی PR لایه API سه شکاف پیدا کرد که هر سه به یک چیز
-- برمی‌گردند: **PIN به‌عنوان عامل دوم جدی گرفته نشده بود.**
--
-- ۱. شرط چهارم دفاع PIN مرده بود.
--    identity.can پارامتر p_via_pin داشت و تست هم داشت، ولی هیچ مسیری
--    نمی‌دانست نشست با PIN باز شده — پس همیشه false می‌فرستاد. یعنی
--    «PIN هرگز عملیات حساس را مجاز نمی‌کند» در سیستم در حال اجرا
--    اعمال نمی‌شد. سندی که کنترلی را ادعا کند که وجود ندارد، از نبودِ
--    کنترل بدتر است.
--
-- ۲. هویت دستگاه فقط یک رشته بود که کلاینت می‌فرستاد.
--    کل دفاع PIN روی «دستگاه ثبت‌شده و تأییدشده» بنا شده بود، ولی
--    اثباتی در کار نبود. هر کسی که رشته fingerprint یک تبلت تأییدشده
--    را می‌دانست، می‌توانست نشستش را روی آن «دستگاه مورد اعتماد»
--    بنشاند بدون اینکه فیزیکی به آن دسترسی داشته باشد.
--
-- ۳. راهی برای «احراز هویت کامل مجدد» نبود.
--    بند ۱ SECURITY.md می‌گوید عملیات حساس پس از PIN نیازمند احراز
--    کامل مجدد است — ولی هیچ تابعی نشست را از حالت PIN درنمی‌آورد.
--
-- ⚠️ مهاجرت ۰۰۶ ویرایش نشد: روی main نشسته و در CI اجرا شده.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. راز ثبت‌نام دستگاه
-- ---------------------------------------------------------------------
-- fingerprint یک **شناسه** است، نه یک راز: کلاینت می‌سازدش و هر کسی
-- می‌تواند تکرارش کند. راز ثبت‌نام را سرور صادر می‌کند و فقط یک بار —
-- در اولین ورود کاملِ پس از تأیید مدیر. پس هرگز به کسی که فقط
-- fingerprint را می‌داند نمی‌رسد.

ALTER TABLE identity.device
  ADD COLUMN secret_hash text CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN enrolled_at timestamptz;

ALTER TABLE identity.device
  ADD CONSTRAINT device_enrollment_shape CHECK (
    (secret_hash IS NULL) = (enrolled_at IS NULL)),
  ADD CONSTRAINT device_enrollment_needs_approval CHECK (
    secret_hash IS NULL OR is_approved);

COMMENT ON COLUMN identity.device.secret_hash IS
  'SHA-256 راز ثبت‌نام دستگاه. خودِ راز فقط یک بار به دستگاه داده می‌شود و ذخیره نمی‌شود.';

-- ---------------------------------------------------------------------
-- ۲. نشست: آیا هم‌اکنون با PIN باز شده؟
-- ---------------------------------------------------------------------
-- Projection نیست، حالت است: با unlock_session روشن و با reauth_session
-- خاموش می‌شود. با گذشت زمان خودبه‌خود پاک نمی‌شود.

ALTER TABLE identity.session
  ADD COLUMN pin_unlocked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN identity.session.pin_unlocked IS
  'نشست با PIN باز شده و «ارتقایافته» نیست. identity.can عملیات فهرست auth.pin_forbidden_operations را رویش می‌بندد.';

CREATE INDEX ON identity.session (user_id) WHERE pin_unlocked;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۳. PIN حالا راز دستگاه می‌خواهد
-- ---------------------------------------------------------------------
-- امضای تابع عوض می‌شود، پس نسخه قبلی صریح حذف می‌شود. اگر فقط
-- CREATE OR REPLACE می‌زدیم، دو تابع هم‌نام می‌ماند و فراخوان دوآرگومانی
-- مبهم می‌شد — یعنی مسیری که راز نمی‌فرستد بی‌صدا به نسخه قدیمیِ
-- بی‌دفاع می‌رسید.

DROP FUNCTION IF EXISTS identity.pin_allowed(uuid, uuid);

CREATE OR REPLACE FUNCTION identity.pin_allowed(
  p_user uuid, p_device uuid, p_secret_hash text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE d identity.device%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_device IS NULL THEN RETURN false; END IF;

  SELECT * INTO d FROM identity.device WHERE id = p_device;
  IF NOT FOUND OR NOT d.is_approved THEN RETURN false; END IF;

  -- دستگاه باید ثبت‌نام شده باشد و راز درست را ارائه کند
  IF d.secret_hash IS NULL THEN RETURN false; END IF;
  IF p_secret_hash IS NULL OR p_secret_hash <> d.secret_hash THEN RETURN false; END IF;

  IF identity.is_locked(p_user, p_device, 'pin') THEN RETURN false; END IF;

  -- ورود کامل امروز روی همین دستگاه
  PERFORM 1 FROM identity.auth_attempt
   WHERE user_id = p_user AND device_id = p_device
     AND kind IN ('password','totp','webauthn') AND succeeded
     AND at::date = current_date
   LIMIT 1;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------
-- ۴. ثبت‌نام و تأیید دستگاه
-- ---------------------------------------------------------------------

-- صدور راز — فقط یک بار، و فقط برای دستگاه تأییدشده.
-- فراخوان پس از یک ورود *کامل* روی همان دستگاه صدایش می‌زند.
CREATE OR REPLACE FUNCTION identity.enroll_device(
  p_device uuid, p_secret_hash text, p_user uuid
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE d identity.device%ROWTYPE;
BEGIN
  SELECT * INTO d FROM identity.device WHERE id = p_device FOR UPDATE;
  IF NOT FOUND OR NOT d.is_approved THEN RETURN false; END IF;
  IF d.secret_hash IS NOT NULL THEN RETURN false; END IF;   -- قبلاً ثبت‌نام شده

  UPDATE identity.device
     SET secret_hash = p_secret_hash, enrolled_at = now()
   WHERE id = p_device;

  PERFORM platform.audit('device.enroll', 'identity_device', p_device::text,
    jsonb_build_object('label', d.label), p_user);
  RETURN true;
END $$;

-- تأیید دستگاه توسط مدیر. تأیید دوباره، ثبت‌نام را باطل می‌کند تا
-- دستگاه گم‌شده یا مشکوک بتواند راز تازه بگیرد و راز قدیمی بمیرد.
CREATE OR REPLACE FUNCTION identity.approve_device(
  p_device uuid, p_actor uuid
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE identity.device
     SET is_approved = true, approved_by = p_actor, approved_at = now(),
         secret_hash = NULL, enrolled_at = NULL
   WHERE id = p_device;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM platform.audit('device.approve', 'identity_device', p_device::text,
    jsonb_build_object('reset_enrollment', true), p_actor);
  RETURN true;
END $$;

-- ابطال اعتماد یک دستگاه: تأیید و راز هر دو می‌روند، و هر نشستی که
-- رویش باز است باطل می‌شود. این همان «تبلت گم شد» است.
CREATE OR REPLACE FUNCTION identity.revoke_device(
  p_device uuid, p_actor uuid, p_reason text DEFAULT 'device_revoked'
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  UPDATE identity.device
     SET is_approved = false, approved_by = NULL, approved_at = NULL,
         secret_hash = NULL, enrolled_at = NULL
   WHERE id = p_device;

  UPDATE identity.session SET revoked_at = now(), revoke_reason = p_reason
   WHERE device_id = p_device AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM platform.audit('device.revoke', 'identity_device', p_device::text,
    jsonb_build_object('reason', p_reason, 'sessions_revoked', v_n), p_actor);
  RETURN v_n;
END $$;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۵. قفل صفحه، باز کردن با PIN، و احراز کامل مجدد
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS identity.unlock_session(text, uuid);

CREATE OR REPLACE FUNCTION identity.unlock_session(
  p_token_hash text, p_user uuid, p_secret_hash text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE s identity.session%ROWTYPE;
BEGIN
  SELECT * INTO s FROM identity.session
   WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF s.user_id <> p_user THEN
    RAISE EXCEPTION 'نشست متعلق به کاربر دیگری است';
  END IF;
  IF s.revoked_at IS NOT NULL OR s.expires_at <= now() THEN RETURN false; END IF;

  IF NOT identity.pin_allowed(s.user_id, s.device_id, p_secret_hash) THEN
    RAISE EXCEPTION
      'PIN روی این دستگاه مجاز نیست: دستگاه تأیید یا ثبت‌نام نشده، راز دستگاه نادرست است، یا امروز ورود کاملی روی آن انجام نشده است.';
  END IF;

  -- نشست باز می‌شود، ولی **ارتقایافته نیست**: pin_unlocked روشن می‌ماند
  -- تا identity.can عملیات حساس را ببندد.
  UPDATE identity.session
     SET locked_at = NULL, last_seen_at = now(), pin_unlocked = true
   WHERE id = s.id;

  PERFORM platform.audit('session.unlock', 'identity_session', s.id::text,
    jsonb_build_object('device', s.device_id, 'pin_unlocked', true), p_user);
  RETURN true;
END $$;

-- احراز هویت کامل مجدد روی نشست موجود — تنها راه پاک‌کردن pin_unlocked.
-- تطبیق رمز در Node انجام شده؛ اینجا مالکیت نشست سنجیده می‌شود.
CREATE OR REPLACE FUNCTION identity.reauth_session(
  p_token_hash text, p_user uuid
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE s identity.session%ROWTYPE;
BEGIN
  SELECT * INTO s FROM identity.session WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF s.user_id <> p_user THEN
    RAISE EXCEPTION 'نشست متعلق به کاربر دیگری است';
  END IF;
  IF s.revoked_at IS NOT NULL OR s.expires_at <= now() THEN RETURN false; END IF;

  UPDATE identity.session
     SET pin_unlocked = false, locked_at = NULL, last_seen_at = now()
   WHERE id = s.id;

  PERFORM platform.audit('session.reauth', 'identity_session', s.id::text,
    jsonb_build_object('device', s.device_id), p_user);
  RETURN true;
END $$;

-- ---------------------------------------------------------------------
-- ۶. نشست حالا وضعیت PIN خودش را هم برمی‌گرداند
-- ---------------------------------------------------------------------
-- بدون این، لایه API راهی برای دانستن «این نشست با PIN باز شده» ندارد
-- و مجبور است viaPin=false بفرستد — همان چیزی که کنترل را مرده کرده بود.

DROP FUNCTION IF EXISTS identity.session_from_token(text);

CREATE OR REPLACE FUNCTION identity.session_from_token(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, device_id uuid,
               subject text, auth_method text, expires_at timestamptz,
               pin_unlocked boolean)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  UPDATE identity.session s
     SET last_seen_at = now()
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.locked_at  IS NULL
     AND s.expires_at > now()
  RETURNING s.id, s.user_id, s.device_id, s.subject, s.auth_method,
            s.expires_at, s.pin_unlocked;
END $$;

-- ---------------------------------------------------------------------
-- ۷. نمای وضعیت اعتماد دستگاه — برای پنل مدیر
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW identity.device_trust AS
SELECT d.id, d.fingerprint, d.label, d.kind, d.branch_id,
       d.is_approved,
       d.secret_hash IS NOT NULL AS is_enrolled,
       d.approved_at, d.enrolled_at, d.last_seen_at,
       u.full_name AS approved_by_name,
       (SELECT count(*) FROM identity.session s
         WHERE s.device_id = d.id AND s.revoked_at IS NULL
           AND s.expires_at > now()) AS active_sessions,
       CASE
         WHEN NOT d.is_approved              THEN 'ثبت‌نشده — فقط ورود کامل'
         WHEN d.secret_hash IS NULL          THEN 'تأییدشده — منتظر اولین ورود کامل'
         ELSE                                     'ثبت‌نام‌شده — PIN فعال'
       END AS trust_state
  FROM identity.device d
  LEFT JOIN identity.app_user u ON u.id = d.approved_by;

COMMIT;
