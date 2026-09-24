-- ۰۷۵ برای اصلاح مستقل مرجوعی در شاخه امنیت رزرو شده است.
BEGIN;
CREATE TABLE identity.sms_factor (
  user_id uuid PRIMARY KEY REFERENCES identity.app_user(id),
  mobile text NOT NULL CHECK (mobile ~ '^09[0-9]{9}$'),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.sms_challenge (
  id uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  user_id uuid NOT NULL REFERENCES identity.app_user(id),
  purpose text NOT NULL CHECK (purpose IN ('enroll','login')),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  mobile text NOT NULL CHECK (mobile ~ '^09[0-9]{9}$'),
  ip inet NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  encrypted_code jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '120 seconds',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  sent_at timestamptz,
  used_at timestamptz
);
CREATE INDEX sms_challenge_rate_mobile ON identity.sms_challenge(mobile, created_at);
CREATE INDEX sms_challenge_rate_ip ON identity.sms_challenge(ip, created_at);
CREATE INDEX sms_challenge_user ON identity.sms_challenge(user_id, purpose, created_at DESC);
CREATE OR REPLACE FUNCTION identity.needs_second_factor(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM identity.app_user WHERE id=p_user AND totp_secret IS NOT NULL)
   OR EXISTS (SELECT 1 FROM identity.webauthn_credential WHERE user_id=p_user)
   OR EXISTS (SELECT 1 FROM identity.sms_factor WHERE user_id=p_user);
$$;
COMMIT;
