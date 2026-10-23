-- =====================================================================
-- ۱۰۱ — مجوز «سفارش‌های سایت» (فقط دیدن)
-- =====================================================================
-- منوی مدیر سفارش‌های ووکامرس را فقط‌خواندنی و امضاشده از افزونه می‌خواند
-- (`GET /web/orders`). عملیات تازه‌ای در Core نیست. تنها چیزی که لازم است، یک
-- مجوز جدا است: دیدن نام صورت‌حساب و مبلغ سفارش‌های سایت نباید هم‌پای
-- `settings.view` یا `report.view` به سرپرست و حسابدار برسد.
--
-- پیش‌فرض فقط `admin` است. نقش‌های دیگر سطر «رد» می‌گیرند تا تصمیم صریح
-- باشد، نه نبودِ سطر. عوض‌کردنش یک `UPDATE` روی `identity.permission_rule` است.
--
-- ⚠️ شماره ۱۰۰ را PR توکن اجارهٔ Outbox گرفته است. این دو مستقل‌اند و
--    ترتیب اجرایشان مهم نیست.
-- نصب تازه: db/seed/101_web_orders_permission.sql (نقش‌ها پس از مهاجرت ساخته می‌شوند).
-- =====================================================================
BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT r.code,'web.orders.view',(r.code='admin'),NULL,NULL,NULL
FROM identity.role r
ON CONFLICT (role_code,operation) DO NOTHING;
COMMIT;
