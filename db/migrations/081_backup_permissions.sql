-- مجوزهای مستقل بکاپ؛ اجرا فقط در سرویس مدیریتی جداگانه است.
BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,o.operation,(r.code='admin'),NULL,NULL,NULL
FROM identity.role r CROSS JOIN (VALUES ('backup.view'),('backup.create'),('backup.download'),('backup.restore')) AS o(operation)
ON CONFLICT (role_code,operation) DO NOTHING;
COMMIT;
