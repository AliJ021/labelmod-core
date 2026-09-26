-- در نصب تازه، نقش‌ها پس از مهاجرت‌ها ساخته می‌شوند؛ پیش‌فرض مستقل مجوزهای بکاپ.
-- روی دیتابیس عملیاتی seed اجرا نمی‌شود؛ ارتقا از مهاجرت 081 است.
BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,o.operation,(r.code='admin'),NULL,NULL,NULL
FROM identity.role r CROSS JOIN (VALUES ('backup.view'),('backup.create'),('backup.download'),('backup.restore')) AS o(operation)
ON CONFLICT (role_code,operation) DO NOTHING;
COMMIT;
