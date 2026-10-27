-- در نصب تازه، نقش‌ها پس از مهاجرت‌ها ساخته می‌شوند؛ پیش‌فرض مستقل فروش اینستاگرام از صندوق (مهاجرت ۱۰۵).
-- روی دیتابیس عملیاتی seed اجرا نمی‌شود؛ ارتقا از مهاجرت 105 است.
BEGIN;
INSERT INTO identity.role (code, name) VALUES ('instagram_operator', 'اپراتور اینستاگرام')
ON CONFLICT (code) DO NOTHING;

INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code, 'instagram.pos.sell', r.code IN ('admin', 'instagram_operator'), NULL, NULL, NULL
FROM identity.role r
ON CONFLICT (role_code,operation) DO NOTHING;

COMMIT;
