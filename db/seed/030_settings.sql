-- =====================================================================
-- تنظیمات — همان «تصمیم‌های باز» بخش ۳۷ سند
-- =====================================================================
-- هر ردیف اینجا یک تصمیمی است که هنوز قطعی نشده. مقادیر فعلی
-- پیش‌فرض‌های پیشنهادی‌اند و تا تصویب، سیستم نباید با داده واقعی
-- بهره‌برداری شود. تغییرشان UPDATE است، نه Deploy.
-- =====================================================================

BEGIN;

INSERT INTO platform.setting (key, value, description, requires_approval) VALUES

('currency.base', '"IRR"'::jsonb,
 'واحد مبنای ذخیره‌سازی. ریال صحیح، بدون اعشار.', true),

('currency.display', '"IRT"'::jsonb,
 'واحد نمایش در رابط کاربری. تومان = ریال ÷ ۱۰.', false),

('costing.method', '"moving_weighted_average"'::jsonb,
 'روش بهای تمام‌شده. نیازمند تصویب کتبی حسابدار مسئول.', true),

('costing.rounding', '"round"'::jsonb,
 'روش گرد کردن بهای واحد: round | floor.', true),

('tax.default_rate', '10'::jsonb,
 'نرخ پیش‌فرض ارزش افزوده به درصد. نرخ واقعی هر گروه کالا در catalog.product.tax_rate_code.', true),

('tax.enabled', 'false'::jsonb,
 'تا تأیید وضعیت مشمولیت توسط مشاور مالیاتی، خاموش بماند.', true),

('tax.einvoice_mode', '"none"'::jsonb,
 'صورتحساب الکترونیکی: none | trusted_company | direct. توصیه: trusted_company.', true),

('ledger.sale_posting', '"per_shift"'::jsonb,
 'تجمیع سند فروش: per_shift | per_invoice. با ۴۰ فاکتور در روز، per_shift توصیه می‌شود.', true),

('inventory.allow_negative', 'false'::jsonb,
 'اجازه فروش با موجودی منفی. توصیه اکید: false.', true),

('inventory.reservation_ttl_minutes', '30'::jsonb,
 'مدت اعتبار رزرو موجودی برای سبد خرید سایت.', false),

('inventory.web_buffer_qty', '1'::jsonb,
 'موجودی حائل — تعدادی که به ووکامرس گزارش نمی‌شود تا فروش هم‌زمان کمتر شود.', false),

('discount.require_reason_above_percent', '10'::jsonb,
 'درصدی که بالاتر از آن، ثبت دلیل تخفیف اجباری می‌شود.', false),

('return.window_days', '7'::jsonb,
 'مهلت مرجوعی بدون تأیید مدیر.', true),

('return.reason_codes',
 '["size_small","size_large","length_short","length_long","color_mismatch","quality","changed_mind","wrong_item","gift_return"]'::jsonb,
 'فهرست بسته علت مرجوعی. از روز اول اجباری — سوخت موتور پیشنهاد سایز.', false),

('payment.unknown_auto_retry', 'false'::jsonb,
 'تلاش مجدد خودکار روی پرداخت نامشخص. باید همیشه false بماند.', true),

('pos.require_customer', 'false'::jsonb,
 'اجبار انتخاب مشتری پیش از نهایی‌کردن فروش.', false),

('backup.retention_days', '90'::jsonb,
 'مدت نگهداری بکاپ روزانه.', false),

('backup.restore_drill_days', '30'::jsonb,
 'فاصله مجاز میان دو تمرین Restore. عبور از آن هشدار می‌دهد.', false),

('cheque.due_warning_days', '7'::jsonb,
 'چند روز پیش از سررسید، چک در فهرست هشدار دیده شود.', false),

('cheque.allow_endorse', 'true'::jsonb,
 'اجازه خرج‌کردن چک دریافتی به تأمین‌کننده. برخی حسابداران آن را ممنوع می‌کنند چون مسئولیت ظهرنویسی روی ماست.', true),

('cheque.max_due_days', '180'::jsonb,
 'حداکثر فاصله سررسید تا تاریخ صدور. چک با وعده بلندتر نیازمند تأیید مدیر است.', true)

-- DO NOTHING است، نه DO UPDATE: اگر حسابدار نرخ مالیات یا سقف تخفیف را
-- تصویب و عوض کرده باشد، اجرای دوباره seed نباید آن را به پیش‌فرض
-- برگرداند. تنظیم تازه اضافه می‌شود؛ تنظیم موجود دست‌نخورده می‌ماند.
ON CONFLICT (key) DO NOTHING;

COMMIT;
