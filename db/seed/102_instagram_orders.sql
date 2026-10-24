-- در نصب تازه، نقش‌ها پس از مهاجرت‌ها ساخته می‌شوند؛ پیش‌فرض مستقل مجوزهای «سفارش اینستاگرام» (مهاجرت ۱۰۲).
-- روی دیتابیس عملیاتی seed اجرا نمی‌شود؛ ارتقا از مهاجرت 102 است.
BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code, op, (r.code='admin'), NULL, NULL, NULL
FROM identity.role r
CROSS JOIN (VALUES ('instagram.order.manage'), ('instagram.payment.verify')) v(op)
ON CONFLICT (role_code,operation) DO NOTHING;

COMMIT;
