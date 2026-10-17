-- در نصب تازه، نقش‌ها پس از مهاجرت‌ها ساخته می‌شوند؛ پیش‌فرض مستقل مجوزهای دفتر پاداش (مهاجرت ۰۹۸).
-- روی دیتابیس عملیاتی seed اجرا نمی‌شود؛ ارتقا از مهاجرت 098 است.
-- درخواست و دیدن پاداش «خود» مجوز نمی‌خواهد؛ این دو فقط دفتر همه و مدیریت مدیر کل‌اند.
BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,o.operation,(r.code='admin'),NULL,NULL,NULL
FROM identity.role r CROSS JOIN (VALUES ('bonus.view_all'),('bonus.manage')) AS o(operation)
ON CONFLICT (role_code,operation) DO NOTHING;
COMMIT;
