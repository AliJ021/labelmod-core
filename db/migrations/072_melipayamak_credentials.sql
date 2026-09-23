-- راز در جدول تنظیمات عمومی یا لاگ حسابرسی نوشته نمی‌شود.
-- فقط ciphertext نگهداری می‌شود؛ کلید رمزگشایی در محیط API/Worker است.
BEGIN;
CREATE TABLE platform.melipayamak_credential (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_name text NOT NULL DEFAULT '' CHECK (length(account_name) <= 100),
  encrypted_key jsonb,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES identity.app_user(id)
);
INSERT INTO platform.melipayamak_credential(singleton) VALUES (true);
COMMENT ON TABLE platform.melipayamak_credential IS
  'کلید ملی‌پیامک با AES-256-GCM؛ راز خام و کلید اصلی هرگز در این جدول نیستند.';
COMMIT;
