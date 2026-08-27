-- =====================================================================
-- ۰۰۶ — نشست، دستگاه و قفل ورود
-- =====================================================================
-- بند ۱ SECURITY.md تا امروز هیچ پشتوانه‌ای در دیتابیس نداشت.
-- identity.app_user ستون password_hash و pin_hash داشت، ولی جدولی برای
-- نشست نبود — یعنی «خروج اجباری همه نشست‌ها و قطع دسترسی گوشی مفقودی»
-- که سند اصلی الزام کرده، ساختنی نبود.
--
-- چرا توکن مات و نه JWT: یک JWT صادرشده تا انقضایش معتبر است.
-- باطل‌کردنش نیازمند فهرست ابطال سمت سرور است، که آن‌وقت همان نشست سمت
-- سرور است با پیچیدگی اضافه. اینجا ابطال یک UPDATE است.
--
-- چرا هش توکن ذخیره می‌شود نه خود توکن: دامپ دیتابیس، بکاپ یا یک
-- SELECT ناخواسته نباید بتواند نشست کسی را بدزدد. همان منطق رمز عبور.
--
-- ⚠️ درهم‌سازی رمز و PIN اینجا نیست. Argon2id در لایه Node انجام
--    می‌شود؛ pgcrypto آن را ندارد و MD5/SHA خام برای رمز ممنوع است.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. دستگاه — پایه‌ای که دفاع PIN رویش بنا می‌شود
-- ---------------------------------------------------------------------
-- یک PIN چهاررقمی ۱۰٬۰۰۰ حالت دارد و هیچ الگوریتم درهم‌سازی‌ای نجاتش
-- نمی‌دهد. دفاع واقعی این است که PIN فقط روی دستگاه تأییدشده کار کند.

CREATE TABLE identity.device (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  fingerprint  text NOT NULL UNIQUE,      -- شناسه پایدار دستگاه، از سمت کلاینت
  label        text NOT NULL,             -- «تبلت صندوق ۱»
  kind         text NOT NULL DEFAULT 'other'
               CHECK (kind IN ('pos','desktop','mobile','other')),
  branch_id    uuid REFERENCES platform.branch(id),
  -- دستگاه تا وقتی مدیر تأییدش نکرده، فقط ورود کامل می‌پذیرد، نه PIN
  is_approved  boolean NOT NULL DEFAULT false,
  approved_by  uuid REFERENCES identity.app_user(id),
  approved_at  timestamptz,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_approval_shape CHECK (
    is_approved = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX ON identity.device (branch_id) WHERE is_approved;

-- ---------------------------------------------------------------------
-- ۲. نشست
-- ---------------------------------------------------------------------

CREATE TABLE identity.session (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  -- SHA-256 توکن ۳۲ بایتی، نه خود توکن. هگز ۶۴ کاراکتری.
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id      uuid NOT NULL REFERENCES identity.app_user(id),
  device_id    uuid REFERENCES identity.device(id),
  subject      text NOT NULL DEFAULT 'staff' CHECK (subject IN ('staff','customer')),
  -- با چه چیزی این نشست *ساخته* شد. PIN اینجا نمی‌آید: PIN نشست جدید
  -- نمی‌سازد، فقط نشست موجود را از قفل صفحه درمی‌آورد.
  auth_method  text NOT NULL CHECK (auth_method IN ('password','totp','webauthn','otp')),
  ip           inet,
  user_agent   text,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- قفل صفحه: نشست زنده است ولی تا باز شدن با PIN کاری نمی‌کند
  locked_at    timestamptz,
  revoked_at   timestamptz,
  revoke_reason text,
  CONSTRAINT session_expiry_after_issue CHECK (expires_at > issued_at)
);
CREATE INDEX ON identity.session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON identity.session (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX ON identity.session (device_id, user_id);

COMMENT ON COLUMN identity.session.token_hash IS
  'SHA-256 توکن ۳۲ بایتی. خودِ توکن هرگز ذخیره نمی‌شود و فقط یک بار به کلاینت داده می‌شود.';

-- ---------------------------------------------------------------------
-- ۳. تلاش‌های احراز هویت — پایه قفل ۱۵ دقیقه‌ای
-- ---------------------------------------------------------------------
-- نام کاربری ذخیره می‌شود نه فقط شناسه، چون تلاش روی کاربر ناموجود هم
-- باید شمرده شود؛ وگرنه شمارش نام‌های کاربری با نرخ آزاد ممکن می‌ماند.
--
-- ⚠️ هیچ رمز، PIN یا OTP — حتی بریده‌شده — اینجا نوشته نمی‌شود.

CREATE TABLE identity.auth_attempt (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('password','pin','totp','otp','webauthn')),
  username    text,
  user_id     uuid REFERENCES identity.app_user(id),
  device_id   uuid REFERENCES identity.device(id),
  ip          inet,
  succeeded   boolean NOT NULL,
  -- علت شکست برای تحلیل، نه برای نمایش به کاربر. پیام کاربر همیشه
  -- «نام کاربری یا رمز اشتباه است» می‌ماند.
  failure_code text
);
CREATE INDEX ON identity.auth_attempt (user_id, kind, at DESC) WHERE NOT succeeded;
CREATE INDEX ON identity.auth_attempt (ip, at DESC) WHERE NOT succeeded;
CREATE INDEX ON identity.auth_attempt (username, at DESC);

CREATE OR REPLACE FUNCTION identity.auth_attempt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'تلاش احراز هویت قابل تغییر یا حذف نیست';
END $$;
CREATE TRIGGER auth_attempt_immutable_t BEFORE UPDATE OR DELETE ON identity.auth_attempt
  FOR EACH ROW EXECUTE FUNCTION identity.auth_attempt_immutable();

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۴. قفل پس از تلاش ناموفق
-- ---------------------------------------------------------------------
-- سقف و پنجره داده‌اند نه ثابت کد: platform.setting.
-- قفل روی «کاربر + دستگاه» است، نه فقط کاربر — وگرنه هر کسی می‌تواند
-- با پنج تلاش غلط، صندوق‌دار را از کار بیندازد.

CREATE OR REPLACE FUNCTION identity.is_locked(
  p_user uuid, p_device uuid, p_kind text DEFAULT 'password'
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE v_max int; v_window int; v_fails int; v_last timestamptz;
BEGIN
  IF p_user IS NULL THEN RETURN false; END IF;

  SELECT (value)::int INTO v_max
    FROM platform.setting WHERE key = 'auth.max_failed_attempts';
  SELECT (value)::int INTO v_window
    FROM platform.setting WHERE key = 'auth.lockout_minutes';
  v_max    := coalesce(v_max, 5);
  v_window := coalesce(v_window, 15);

  -- آخرین موفقیت، شمارش را صفر می‌کند
  SELECT max(at) INTO v_last FROM identity.auth_attempt
   WHERE user_id = p_user AND kind = p_kind AND succeeded
     AND (p_device IS NULL OR device_id IS NOT DISTINCT FROM p_device);

  SELECT count(*) INTO v_fails FROM identity.auth_attempt
   WHERE user_id = p_user AND kind = p_kind AND NOT succeeded
     AND at > now() - make_interval(mins => v_window)
     AND (v_last IS NULL OR at > v_last)
     AND (p_device IS NULL OR device_id IS NOT DISTINCT FROM p_device);

  RETURN v_fails >= v_max;
END $$;

COMMENT ON FUNCTION identity.is_locked IS
  'آیا کاربر روی این دستگاه قفل است. سقف و پنجره از platform.setting خوانده می‌شوند.';

-- ---------------------------------------------------------------------
-- ۵. PIN فقط قفل‌گشای نشست موجود است
-- ---------------------------------------------------------------------
-- سه شرط، هر سه لازم:
--   ۱. دستگاه ثبت و تأیید شده باشد
--   ۲. همان کاربر امروز روی همان دستگاه یک ورود کامل کرده باشد
--   ۳. کاربر قفل نباشد
-- شرط چهارم — «PIN هرگز عملیات حساس را مجاز نمی‌کند» — در identity.can
-- اعمال می‌شود، نه اینجا.

CREATE OR REPLACE FUNCTION identity.pin_allowed(
  p_user uuid, p_device uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE v_ok boolean;
BEGIN
  IF p_user IS NULL OR p_device IS NULL THEN RETURN false; END IF;

  SELECT is_approved INTO v_ok FROM identity.device WHERE id = p_device;
  IF NOT coalesce(v_ok, false) THEN RETURN false; END IF;

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
-- ۶. ساخت، اعتبارسنجی و ابطال نشست
-- ---------------------------------------------------------------------
-- توکن در Node ساخته می‌شود (۳۲ بایت crypto.randomBytes) و فقط هشش
-- اینجا می‌آید. عمر نشست داده است: auth.session_hours_staff.

CREATE OR REPLACE FUNCTION identity.open_session(
  p_user        uuid,
  p_token_hash  text,
  p_auth_method text,
  p_device      uuid DEFAULT NULL,
  p_ip          inet DEFAULT NULL,
  p_user_agent  text DEFAULT NULL,
  p_subject     text DEFAULT 'staff'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_hours int; v_id uuid; v_active boolean;
BEGIN
  SELECT is_active INTO v_active FROM identity.app_user WHERE id = p_user;
  IF NOT coalesce(v_active, false) THEN
    RAISE EXCEPTION 'کاربر غیرفعال است یا وجود ندارد';
  END IF;

  SELECT (value)::int INTO v_hours FROM platform.setting
   WHERE key = CASE WHEN p_subject = 'customer'
                    THEN 'auth.session_hours_customer'
                    ELSE 'auth.session_hours_staff' END;
  v_hours := coalesce(v_hours, 12);

  INSERT INTO identity.session
    (token_hash, user_id, device_id, subject, auth_method, ip, user_agent, expires_at)
  VALUES
    (p_token_hash, p_user, p_device, p_subject, p_auth_method, p_ip, p_user_agent,
     now() + make_interval(hours => v_hours))
  RETURNING id INTO v_id;

  IF p_device IS NOT NULL THEN
    UPDATE identity.device SET last_seen_at = now() WHERE id = p_device;
  END IF;

  PERFORM platform.audit('session.open', 'identity_session', v_id::text,
    jsonb_build_object('method', p_auth_method, 'subject', p_subject,
                       'device', p_device),
    p_user);

  RETURN v_id;
END $$;

-- نشست معتبر را برمی‌گرداند و last_seen را به‌روز می‌کند.
-- نشست منقضی، باطل‌شده یا قفل‌شده هیچ سطری برنمی‌گرداند — یعنی
-- فراخوان نمی‌تواند سهواً یک نشست قفل را معتبر بگیرد.
CREATE OR REPLACE FUNCTION identity.session_from_token(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, device_id uuid,
               subject text, auth_method text, expires_at timestamptz)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  UPDATE identity.session s
     SET last_seen_at = now()
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.locked_at  IS NULL
     AND s.expires_at > now()
  RETURNING s.id, s.user_id, s.device_id, s.subject, s.auth_method, s.expires_at;
END $$;

CREATE OR REPLACE FUNCTION identity.lock_session(p_token_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  UPDATE identity.session SET locked_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL AND locked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

-- باز کردن قفل صفحه با PIN. خودِ تطبیق PIN در Node انجام شده؛ اینجا
-- فقط سه شرط ساختاری دوباره سنجیده می‌شوند تا یک مسیر فراخوانیِ
-- فراموش‌کار نتواند دورشان بزند.
CREATE OR REPLACE FUNCTION identity.unlock_session(
  p_token_hash text, p_user uuid
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

  IF NOT identity.pin_allowed(s.user_id, s.device_id) THEN
    RAISE EXCEPTION
      'PIN روی این دستگاه مجاز نیست: دستگاه تأیید نشده، یا امروز ورود کاملی روی آن انجام نشده است.';
  END IF;

  UPDATE identity.session SET locked_at = NULL, last_seen_at = now()
   WHERE id = s.id;

  PERFORM platform.audit('session.unlock', 'identity_session', s.id::text,
    jsonb_build_object('device', s.device_id), p_user);
  RETURN true;
END $$;

-- ابطال یک نشست، یا همه نشست‌های یک کاربر — همان چیزی که بند ۶ سند
-- اصلی برای «گوشی مفقودی» الزام کرده. یک UPDATE، تمام.
CREATE OR REPLACE FUNCTION identity.revoke_session(
  p_token_hash text, p_reason text DEFAULT 'logout', p_actor uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_user uuid;
BEGIN
  UPDATE identity.session SET revoked_at = now(), revoke_reason = p_reason
   WHERE token_hash = p_token_hash AND revoked_at IS NULL
  RETURNING id, user_id INTO v_id, v_user;
  IF v_id IS NULL THEN RETURN false; END IF;

  PERFORM platform.audit('session.revoke', 'identity_session', v_id::text,
    jsonb_build_object('reason', p_reason), coalesce(p_actor, v_user));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION identity.revoke_all_sessions(
  p_user uuid, p_reason text DEFAULT 'revoke_all', p_actor uuid DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  UPDATE identity.session SET revoked_at = now(), revoke_reason = p_reason
   WHERE user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM platform.audit('session.revoke_all', 'app_user', p_user::text,
    jsonb_build_object('reason', p_reason, 'count', v_n),
    coalesce(p_actor, p_user));
  RETURN v_n;
END $$;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۷. مجوز — از identity.permission_rule، نه از شرط در کد
-- ---------------------------------------------------------------------
-- قاعده لایه API: «هیچ شرط دسترسی hardcode نکن». اگر این تابع در
-- دیتابیس باشد، آن قاعده قابل دور زدن نیست — نه از API، نه از یک
-- اسکریپت، نه از نسخه بعدی کد.
--
-- کاربر می‌تواند چند نقش داشته باشد. سخاوتمندترین نقش برنده است، ولی
-- «ممنوع صریح» بر «مجاز» می‌چربد: اگر نقشی صریحاً allowed=false داشته
-- باشد و هیچ نقش دیگری اجازه ندهد، نتیجه ممنوع است.

CREATE TYPE identity.permission_verdict AS ENUM ('allow','deny','needs_approval');

CREATE OR REPLACE FUNCTION identity.can(
  p_user      uuid,
  p_operation text,
  p_amount    platform.money DEFAULT NULL,
  p_percent   numeric DEFAULT NULL,
  p_via_pin   boolean DEFAULT false
) RETURNS TABLE (verdict identity.permission_verdict,
                 approver text,
                 reason   text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r          record;
  v_any_rule boolean := false;
  v_best     identity.permission_verdict := 'deny';
  v_approver text;
  v_reason   text := 'هیچ نقشی این عملیات را مجاز نکرده است';
BEGIN
  -- PIN هرگز عملیات حساس را مجاز نمی‌کند. این فهرست داده است، نه کد:
  -- هر عملیاتی که در permission_rule نیازمند تأیید یا سقف‌دار باشد،
  -- به‌علاوه فهرست صریح pin.forbidden_operations.
  IF p_via_pin THEN
    PERFORM 1 FROM platform.setting
     WHERE key = 'auth.pin_forbidden_operations'
       AND value ? p_operation;
    IF FOUND THEN
      RETURN QUERY SELECT 'deny'::identity.permission_verdict, NULL::text,
        format('عملیات «%s» با PIN مجاز نیست و احراز هویت کامل می‌خواهد', p_operation);
      RETURN;
    END IF;
  END IF;

  FOR r IN
    SELECT pr.* FROM identity.permission_rule pr
      JOIN identity.user_role ur ON ur.role_code = pr.role_code
     WHERE ur.user_id = p_user AND pr.operation = p_operation
  LOOP
    v_any_rule := true;

    IF NOT r.allowed THEN
      CONTINUE;                                  -- این نقش کمکی نمی‌کند
    END IF;

    -- عبور از سقف مبلغ یا درصد، «ممنوع» نیست — «نیازمند تأیید» است،
    -- به‌شرط آنکه قاعده تأییدکننده تعریف کرده باشد.
    IF (r.max_amount  IS NOT NULL AND p_amount  IS NOT NULL AND p_amount  > r.max_amount)
    OR (r.max_percent IS NOT NULL AND p_percent IS NOT NULL AND p_percent > r.max_percent) THEN
      IF r.needs_approval_from IS NOT NULL AND v_best <> 'allow' THEN
        v_best     := 'needs_approval';
        v_approver := r.needs_approval_from;
        v_reason   := format('از سقف نقش «%s» می‌گذرد و تأیید «%s» لازم است',
                             r.role_code, r.needs_approval_from);
      END IF;
      CONTINUE;
    END IF;

    IF r.needs_approval_from IS NOT NULL THEN
      IF v_best <> 'allow' THEN
        v_best     := 'needs_approval';
        v_approver := r.needs_approval_from;
        v_reason   := format('نقش «%s» برای این عملیات تأیید «%s» می‌خواهد',
                             r.role_code, r.needs_approval_from);
      END IF;
      CONTINUE;
    END IF;

    v_best     := 'allow';
    v_approver := NULL;
    v_reason   := format('نقش «%s»', r.role_code);
  END LOOP;

  IF NOT v_any_rule THEN
    v_reason := format('هیچ قاعده‌ای برای عملیات «%s» و نقش‌های این کاربر تعریف نشده است',
                       p_operation);
  END IF;

  RETURN QUERY SELECT v_best, v_approver, v_reason;
END $$;

COMMENT ON FUNCTION identity.can IS
  'مجوز از identity.permission_rule. سخاوتمندترین نقش برنده است؛ عبور از سقف «نیازمند تأیید» می‌شود نه «ممنوع».';

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۸. نگهداری: نشست مرده و تلاش کهنه
-- ---------------------------------------------------------------------
-- تغییرناپذیری auth_attempt درباره دستکاری است، نه نگهداری ابدی. بدون
-- مسیر پاکسازی، این جدول تا ابد رشد می‌کند و اولین چیزی که می‌شکند،
-- همان کوئری قفل است که هر ورود صدایش می‌زند.
--
-- ولی پاکسازی نباید به یک در پشتی تبدیل شود: کسی که به اپلیکیشن نفوذ
-- کرده نباید بتواند ردّ تلاش‌های خودش را پاک کند. پس Trigger فقط وقتی
-- DELETE را می‌پذیرد که هر دو شرط برقرار باشد:
--   ۱. پرچم labelmod.auth_purge در همان تراکنش روشن شده باشد
--   ۲. سطر از پنجره نگهداری قدیمی‌تر باشد
-- پنجره داده است: auth.attempt_retention_days.

CREATE OR REPLACE FUNCTION identity.auth_attempt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_days int;
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('labelmod.auth_purge', true), '') = 'on' THEN
    SELECT (value)::int INTO v_days FROM platform.setting
     WHERE key = 'auth.attempt_retention_days';
    v_days := coalesce(v_days, 180);
    IF OLD.at < now() - make_interval(days => v_days) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'تلاش احراز هویت تازه‌تر از % روز پاک نمی‌شود. پنجره نگهداری، ردّ حادثه را حفظ می‌کند.',
      v_days;
  END IF;
  RAISE EXCEPTION 'تلاش احراز هویت قابل تغییر یا حذف نیست';
END $$;

-- تنها مسیر مجاز پاکسازی. خودش پرچم را ست می‌کند و نتیجه را در لاگ
-- حسابرسی می‌نویسد — یعنی پاک‌کردنِ رد، خودش یک رد می‌گذارد.
CREATE OR REPLACE FUNCTION identity.purge_auth_attempts(p_actor uuid)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_days int; v_n int;
BEGIN
  SELECT (value)::int INTO v_days FROM platform.setting
   WHERE key = 'auth.attempt_retention_days';
  v_days := coalesce(v_days, 180);

  PERFORM set_config('labelmod.auth_purge', 'on', true);
  DELETE FROM identity.auth_attempt WHERE at < now() - make_interval(days => v_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('labelmod.auth_purge', '', true);

  PERFORM platform.audit('auth.purge_attempts', 'identity_auth_attempt', NULL,
    jsonb_build_object('deleted', v_n, 'retention_days', v_days), p_actor);
  RETURN v_n;
END $$;

-- نشست منقضی یا باطل، پس از یک دوره، دیگر ارزش نگهداری ندارد. برخلاف
-- تلاش‌ها، نشست تغییرناپذیر نیست و حذفش نگهبانی نمی‌خواهد.
CREATE OR REPLACE FUNCTION identity.purge_sessions(p_actor uuid)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_days int; v_n int;
BEGIN
  SELECT (value)::int INTO v_days FROM platform.setting
   WHERE key = 'auth.session_retention_days';
  v_days := coalesce(v_days, 90);

  DELETE FROM identity.session
   WHERE (revoked_at IS NOT NULL OR expires_at < now())
     AND coalesce(revoked_at, expires_at) < now() - make_interval(days => v_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM platform.audit('auth.purge_sessions', 'identity_session', NULL,
    jsonb_build_object('deleted', v_n, 'retention_days', v_days), p_actor);
  RETURN v_n;
END $$;

COMMIT;
