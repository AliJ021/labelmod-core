-- در نصب تازه، نقش‌ها پس از مهاجرت‌ها ساخته می‌شوند؛ پیش‌فرض مستقل مجوز «سفارش‌های سایت» (مهاجرت ۱۰۱).
-- روی دیتابیس عملیاتی seed اجرا نمی‌شود؛ ارتقا از مهاجرت 101 است.
BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,'web.orders.view',(r.code='admin'),NULL,NULL,NULL
FROM identity.role r
ON CONFLICT (role_code,operation) DO NOTHING;
COMMIT;
