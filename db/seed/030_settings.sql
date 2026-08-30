-- =====================================================================
-- تنظیمات — همان «تصمیم‌های باز» بخش ۳۷ سند
-- =====================================================================
-- هر ردیف اینجا یک تصمیم است که در جدول نشسته، نه در کد. تغییرشان
-- UPDATE است، نه Deploy.
--
-- **دو چیز در این فایل هست و عمداً از هم جدا رفتار می‌کنند:**
--
--   value      → مقدارِ کسب‌وکار. مال مالک و حسابدار است.
--   بقیه ستون‌ها → فراداده. مال توسعه‌دهنده است: نوع، برچسب، گزینه‌ها،
--                  بازه مجاز، و اینکه چه مجوزی برای تغییرش لازم است.
--
-- پس `ON CONFLICT` فراداده را **به‌روز می‌کند** ولی `value` را
-- **دست نمی‌زند**. اجرای دوباره seed یک برچسب اصلاح‌شده یا یک گزینه
-- تازه را می‌آورد، بدون اینکه نرخ مالیاتِ تصویب‌شده حسابدار را به
-- پیش‌فرض برگرداند. نسخه قبلی این فایل `DO NOTHING` بود و همین باعث
-- می‌شد فراداده هرگز به سطرهای موجود نرسد.
-- =====================================================================

BEGIN;

INSERT INTO platform.setting AS t
  (key, value, description, requires_approval,
   kind, label, group_key, options, min_value, max_value, unit, help,
   sort_order, permission, is_editable)
SELECT * FROM (VALUES

-- ── عمومی ───────────────────────────────────────────────────────────
('currency.base', '"IRR"'::jsonb,
 'واحد مبنای ذخیره‌سازی. ریال صحیح، بدون اعشار.', true,
 'text', 'واحد مبنای ذخیره‌سازی', 'general', NULL::jsonb, NULL::numeric, NULL::numeric, NULL,
 'پس از ورود اولین سند مالی تغییر نمی‌کند — تمام مبالغ ذخیره‌شده به این واحدند.',
 10, 'settings.security', false),

('currency.display', '"IRT"'::jsonb,
 'واحد نمایش در رابط کاربری. تومان = ریال ÷ ۱۰.', false,
 'choice', 'واحد نمایش', 'general',
 '[{"value":"IRT","label":"تومان"},{"value":"IRR","label":"ریال"}]'::jsonb,
 NULL, NULL, NULL,
 'فقط ظاهر را عوض می‌کند. ذخیره‌سازی همیشه ریال است.',
 20, 'settings.manage', true),

-- ── انبار و قیمت تمام‌شده ───────────────────────────────────────────
('costing.method', '"moving_weighted_average"'::jsonb,
 'روش بهای تمام‌شده. نیازمند تصویب کتبی حسابدار مسئول.', true,
 'choice', 'روش قیمت تمام‌شده کالا', 'inventory',
 '[{"value":"moving_weighted_average","label":"میانگین متحرک موزون"},
   {"value":"last_purchase","label":"آخرین قیمت خرید"}]'::jsonb,
 NULL, NULL, NULL,
 'میانگین موزون: قیمت کالا میانگین وزنی همه خریدهاست. آخرین قیمت خرید (روش رایج هلو و دشت): قیمت کالا همان قیمت آخرین خرید است و ارزش موجودی با آن به‌روز می‌شود.',
 10, 'settings.security', true),

('costing.rounding', '"round"'::jsonb,
 'روش گرد کردن بهای واحد: round | floor.', true,
 'choice', 'گرد کردن بهای واحد', 'inventory',
 '[{"value":"round","label":"گرد کردن به نزدیک‌ترین ریال"},
   {"value":"floor","label":"همیشه به پایین"}]'::jsonb,
 NULL, NULL, NULL, NULL,
 20, 'settings.security', true),

('inventory.allow_negative', 'false'::jsonb,
 'اجازه فروش با موجودی منفی. توصیه اکید: false.', true,
 'bool', 'اجازه فروش با موجودی منفی', 'inventory', NULL, NULL, NULL, NULL,
 'روشن‌کردن این کلید یعنی انبار می‌تواند عدد منفی نشان دهد. توصیه اکید: خاموش بماند.',
 30, 'settings.security', true),

('inventory.reservation_ttl_minutes', '30'::jsonb,
 'مدت اعتبار رزرو موجودی برای سبد خرید سایت.', false,
 'int', 'مدت رزرو سبد خرید سایت', 'inventory', NULL, 1, 1440, 'دقیقه',
 'کالایی که مشتری سایت در سبد گذاشته، این مدت برایش کنار می‌ماند.',
 40, 'settings.manage', true),

('inventory.web_buffer_qty', '1'::jsonb,
 'موجودی حائل — تعدادی که به ووکامرس گزارش نمی‌شود تا فروش هم‌زمان کمتر شود.', false,
 'int', 'موجودی حائل سایت', 'inventory', NULL, 0, 20, 'عدد',
 'این تعداد از هر کالا به سایت گزارش نمی‌شود، تا آخرین عدد هم‌زمان در فروشگاه و سایت فروخته نشود.',
 50, 'settings.manage', true),

-- ── فروش و صندوق ────────────────────────────────────────────────────
('ledger.sale_posting', '"per_shift"'::jsonb,
 'تجمیع سند فروش: per_shift | per_invoice. با ۴۰ فاکتور در روز، per_shift توصیه می‌شود.', true,
 'choice', 'سند حسابداری فروش', 'sales',
 '[{"value":"per_shift","label":"یک سند برای هر شیفت (تجمیعی)"},
   {"value":"per_invoice","label":"یک سند برای هر فاکتور"}]'::jsonb,
 NULL, NULL, NULL,
 'تجمیعی: در پایان هر شیفت یک سند برای کل فروش آن شیفت زده می‌شود — دفتر خلوت می‌ماند. هر فاکتور: هر فروش سند خودش را دارد — ردیابی دقیق‌تر، دفتر شلوغ‌تر.',
 10, 'settings.security', true),

('discount.require_reason_above_percent', '10'::jsonb,
 'درصدی که بالاتر از آن، ثبت دلیل تخفیف اجباری می‌شود.', false,
 'percent', 'تخفیف بالاتر از این درصد، دلیل می‌خواهد', 'sales', NULL, 0, 100, '٪',
 'سقف مجاز تخفیف هر نقش جای دیگری است (جدول دسترسی‌ها). این فقط تعیین می‌کند از چه درصدی به بالا صندوق‌دار باید دلیل بنویسد.',
 20, 'settings.manage', true),

('pos.require_customer', 'false'::jsonb,
 'اجبار انتخاب مشتری پیش از نهایی‌کردن فروش.', false,
 'bool', 'انتخاب مشتری اجباری باشد', 'sales', NULL, NULL, NULL, NULL,
 'روشن‌کردن این کلید فروش بدون ثبت مشتری را نمی‌پذیرد. برای فروشگاه حضوری معمولاً خاموش می‌ماند.',
 30, 'settings.manage', true),

-- ── مالیات ──────────────────────────────────────────────────────────
('tax.enabled', 'false'::jsonb,
 'تا تأیید وضعیت مشمولیت توسط مشاور مالیاتی، خاموش بماند.', true,
 'bool', 'محاسبه ارزش افزوده فعال باشد', 'tax', NULL, NULL, NULL, NULL,
 'کلید اصلی مالیات. تا وقتی خاموش است، هیچ فاکتوری مالیات نمی‌خورد. روزی که مشمول شدید، همین یک کلید را روشن کنید.',
 10, 'settings.security', true),

('tax.default_rate', '10'::jsonb,
 'نرخ پیش‌فرض ارزش افزوده به درصد. نرخ واقعی هر گروه کالا در catalog.product.tax_rate_code.', true,
 'percent', 'نرخ پیش‌فرض ارزش افزوده', 'tax', NULL, 0, 100, '٪',
 'فقط وقتی کالایی نرخ اختصاصی نداشته باشد استفاده می‌شود.',
 20, 'settings.security', true),

('tax.einvoice_mode', '"none"'::jsonb,
 'صورتحساب الکترونیکی: none | trusted_company | direct. توصیه: trusted_company.', true,
 'choice', 'صورتحساب الکترونیکی', 'tax',
 '[{"value":"none","label":"غیرفعال"},
   {"value":"trusted_company","label":"از طریق شرکت معتمد (توصیه‌شده)"},
   {"value":"direct","label":"اتصال مستقیم به سامانه مؤدیان"}]'::jsonb,
 NULL, NULL, NULL,
 'اتصال مستقیم هنوز ساخته نشده است؛ انتخابش فقط قصد را ثبت می‌کند.',
 30, 'settings.security', true),

-- ── مرجوعی ──────────────────────────────────────────────────────────
('return.window_days', '7'::jsonb,
 'مهلت مرجوعی بدون تأیید مدیر.', true,
 'int', 'مهلت مرجوعی بدون تأیید مدیر', 'returns', NULL, 0, 365, 'روز',
 'بعد از این مهلت، مرجوعی همچنان ممکن است ولی تأیید مدیر می‌خواهد.',
 10, 'settings.security', true),

('return.reason_codes',
 '["size_small","size_large","length_short","length_long","color_mismatch","quality","changed_mind","wrong_item","gift_return"]'::jsonb,
 'فهرست بسته علت مرجوعی. از روز اول اجباری — سوخت موتور پیشنهاد سایز.', false,
 'multichoice', 'علت‌های مجاز مرجوعی', 'returns',
 '[{"value":"size_small","label":"سایز کوچک بود"},
   {"value":"size_large","label":"سایز بزرگ بود"},
   {"value":"length_short","label":"قد کوتاه بود"},
   {"value":"length_long","label":"قد بلند بود"},
   {"value":"color_mismatch","label":"رنگ با تصویر فرق داشت"},
   {"value":"quality","label":"ایراد کیفیت یا دوخت"},
   {"value":"changed_mind","label":"منصرف شد"},
   {"value":"wrong_item","label":"کالای اشتباه ارسال شد"},
   {"value":"gift_return","label":"برگشت هدیه"},
   {"value":"defective","label":"کالای معیوب"},
   {"value":"late_delivery","label":"دیر رسید"}]'::jsonb,
 NULL, NULL, NULL,
 'صندوق‌دار موقع مرجوعی باید یکی از این‌ها را انتخاب کند. متن آزاد عمداً نیست: بدون علت دسته‌بندی‌شده، هیچ گزارشی از «چرا برمی‌گردانند» ساخته نمی‌شود.',
 20, 'settings.manage', true),

-- ── خزانه و چک ──────────────────────────────────────────────────────
('cheque.due_warning_days', '7'::jsonb,
 'چند روز پیش از سررسید، چک در فهرست هشدار دیده شود.', false,
 'int', 'هشدار سررسید چک', 'treasury', NULL, 0, 90, 'روز',
 'چک‌هایی که سررسیدشان تا این تعداد روز مانده، در فهرست هشدار دیده می‌شوند.',
 10, 'settings.manage', true),

('cheque.allow_endorse', 'true'::jsonb,
 'اجازه خرج‌کردن چک دریافتی به تأمین‌کننده. برخی حسابداران آن را ممنوع می‌کنند چون مسئولیت ظهرنویسی روی ماست.', true,
 'bool', 'اجازه خرج‌کردن چک دریافتی (ظهرنویسی)', 'treasury', NULL, NULL, NULL, NULL,
 'یعنی چکی که از مشتری گرفته‌اید را به تأمین‌کننده بدهید. اگر چک برگشت بخورد، مسئولیتش با شماست — برخی حسابداران به همین دلیل خاموشش می‌کنند.',
 20, 'settings.security', true),

('cheque.max_due_days', '180'::jsonb,
 'حداکثر فاصله سررسید تا تاریخ صدور. چک با وعده بلندتر نیازمند تأیید مدیر است.', true,
 'int', 'حداکثر وعده چک', 'treasury', NULL, 1, 730, 'روز',
 'چک با وعده بلندتر از این، تأیید مدیر می‌خواهد.',
 30, 'settings.security', true),

('payment.unknown_auto_retry', 'false'::jsonb,
 'تلاش مجدد خودکار روی پرداخت نامشخص. باید همیشه false بماند.', true,
 'bool', 'تلاش خودکار مجدد روی پرداخت نامشخص', 'treasury', NULL, NULL, NULL, NULL,
 '⚠️ قفل‌شده. پرداختی که وضعیتش نامشخص است ممکن است در واقع موفق بوده باشد؛ تلاش مجدد خودکار یعنی احتمال دو بار برداشت از حساب مشتری. این کلید از هیچ مسیری روشن نمی‌شود.',
 40, 'settings.security', false),

-- ── امنیت و ورود ────────────────────────────────────────────────────
-- بند ۱ SECURITY.md. این‌ها سقف‌اند، نه پیشنهاد — بازه‌ها همان‌جا از
-- سند می‌آیند و set_setting بیرونشان را رد می‌کند.
('auth.session_hours_staff', '12'::jsonb,
 'عمر نشست پرسنل به ساعت.', false,
 'int', 'عمر نشست پرسنل', 'security', NULL, 1, 24, 'ساعت',
 'بعد از این مدت، پرسنل باید دوباره رمز کامل بزند.',
 10, 'settings.security', true),

('auth.session_hours_customer', '720'::jsonb,
 'عمر نشست مشتری به ساعت (۳۰ روز)، با تمدید چرخشی.', false,
 'int', 'عمر نشست مشتری', 'security', NULL, 1, 2160, 'ساعت',
 '۷۲۰ ساعت یعنی ۳۰ روز.',
 20, 'settings.security', true),

('auth.max_failed_attempts', '5'::jsonb,
 'تعداد تلاش ناموفق پیش از قفل. روی «کاربر + دستگاه» شمرده می‌شود، نه فقط کاربر.', false,
 'int', 'تعداد تلاش ناموفق تا قفل شدن', 'security', NULL, 3, 20, 'بار',
 'روی ترکیب «کاربر + دستگاه» شمرده می‌شود، پس یک نفر نمی‌تواند با تلاش عمدی حساب دیگری را قفل کند.',
 30, 'settings.security', true),

('auth.lockout_minutes', '15'::jsonb,
 'مدت قفل پس از عبور از سقف تلاش ناموفق.', false,
 'int', 'مدت قفل پس از تلاش‌های ناموفق', 'security', NULL, 1, 1440, 'دقیقه',
 NULL,
 40, 'settings.security', true),

('auth.min_password_length', '12'::jsonb,
 'حداقل طول رمز. قواعد پیچیدگی عمداً نیست — توصیه به‌روز خلافش است.', false,
 'int', 'حداقل طول رمز', 'security', NULL, 12, 64, 'نویسه',
 'زیر ۱۲ نویسه پذیرفته نمی‌شود. قاعده «حتماً یک علامت و یک عدد» عمداً نیست: توصیه به‌روز امنیتی خلافش است، چون رمزهای الگودار و ضعیف می‌سازد.',
 50, 'settings.security', true),

('auth.pin_length', '4'::jsonb,
 'طول PIN صندوق‌دار. PIN هرگز عملیات حساس را مجاز نمی‌کند؛ فقط قفل صفحه را باز می‌کند.', false,
 'int', 'طول PIN صندوق‌دار', 'security', NULL, 4, 8, 'رقم',
 'PIN فقط قفل صفحهٔ نشستِ باز را برمی‌دارد؛ نشست تازه نمی‌سازد. هر رقم بیشتر، حدس‌زدنش را ده برابر سخت‌تر می‌کند.',
 60, 'settings.security', true),

('auth.pin_forbidden_operations',
 '["refund.cash","invoice.cancel","price.change","stock.adjust","period.close","period.reopen","user.manage","journal.manual","return.late","settings.manage","settings.security"]'::jsonb,
 'عملیاتی که با PIN هرگز مجاز نیستند و احراز هویت کامل می‌خواهند — بند ۱ SECURITY.md.', true,
 'multichoice', 'کارهایی که با PIN انجام نمی‌شوند', 'security',
 '[{"value":"refund.cash","label":"بازپرداخت نقدی"},
   {"value":"invoice.cancel","label":"ابطال فاکتور"},
   {"value":"price.change","label":"تغییر قیمت"},
   {"value":"stock.adjust","label":"اصلاح موجودی"},
   {"value":"period.close","label":"بستن دوره مالی"},
   {"value":"period.reopen","label":"بازکردن دوره مالی"},
   {"value":"user.manage","label":"مدیریت کاربران"},
   {"value":"journal.manual","label":"سند دستی حسابداری"},
   {"value":"return.late","label":"مرجوعی خارج از مهلت"},
   {"value":"sale.discount_high","label":"تخفیف بالاتر از سقف"},
   {"value":"sale.credit","label":"فروش نسیه"},
   {"value":"stock.receive","label":"رسید انبار"},
   {"value":"stock.transfer","label":"انتقال بین انبار"},
   {"value":"catalog.manage","label":"تعریف کالا"},
   {"value":"cost.view","label":"دیدن قیمت خرید"},
   {"value":"shift.close","label":"بستن شیفت صندوق"},
   {"value":"settings.manage","label":"تغییر تنظیمات"},
   {"value":"settings.security","label":"تغییر تنظیمات امنیتی و مالی"}]'::jsonb,
 NULL, NULL, NULL,
 'صندوق‌داری که با PIN صفحه را باز کرده، این کارها را نمی‌تواند بکند و باید رمز کامل بزند. هرچه بیشتر انتخاب کنید سخت‌گیرانه‌تر است. حذف «بازپرداخت نقدی» یا «ابطال فاکتور» از این فهرست به‌شدت توصیه نمی‌شود.',
 70, 'settings.security', true),

('auth.attempt_retention_days', '180'::jsonb,
 'پنجره نگهداری تلاش‌های احراز هویت. تازه‌تر از این پاک نمی‌شود — ردّ حادثه باید بماند.', true,
 'int', 'نگهداری سابقه تلاش‌های ورود', 'security', NULL, 30, 3650, 'روز',
 'سابقه ورودهای ناموفق تا این مدت پاک نمی‌شود؛ ردّ یک حادثه امنیتی باید بماند.',
 80, 'settings.security', true),

('auth.session_retention_days', '90'::jsonb,
 'مدت نگهداری نشست منقضی یا باطل‌شده پیش از پاکسازی.', false,
 'int', 'نگهداری نشست‌های منقضی', 'security', NULL, 7, 3650, 'روز',
 NULL,
 90, 'settings.security', true),

-- ── پشتیبان‌گیری ────────────────────────────────────────────────────
('backup.retention_days', '90'::jsonb,
 'مدت نگهداری بکاپ روزانه.', false,
 'int', 'نگهداری بکاپ روزانه', 'backup', NULL, 7, 3650, 'روز',
 NULL,
 10, 'settings.manage', true),

('backup.restore_drill_days', '30'::jsonb,
 'فاصله مجاز میان دو تمرین Restore. عبور از آن هشدار می‌دهد.', false,
 'int', 'فاصله تمرین بازیابی', 'backup', NULL, 7, 365, 'روز',
 'بکاپی که یک بار بازیابی‌اش تست نشده، بکاپ نیست — یک فایل است با یک فرض. عبور از این فاصله هشدار می‌دهد.',
 20, 'settings.manage', true)

) AS v(key, value, description, requires_approval,
       kind, label, group_key, options, min_value, max_value, unit, help,
       sort_order, permission, is_editable)

-- `value` عمداً به‌روز **نمی‌شود**: اگر حسابدار نرخ مالیات یا سقف
-- تخفیف را تصویب و عوض کرده باشد، اجرای دوباره seed نباید آن را به
-- پیش‌فرض برگرداند. فراداده اما مال کد است و باید تازه بماند.
ON CONFLICT (key) DO UPDATE SET
  description       = EXCLUDED.description,
  requires_approval = EXCLUDED.requires_approval,
  kind              = EXCLUDED.kind,
  label             = EXCLUDED.label,
  group_key         = EXCLUDED.group_key,
  options           = EXCLUDED.options,
  min_value         = EXCLUDED.min_value,
  max_value         = EXCLUDED.max_value,
  unit              = EXCLUDED.unit,
  help              = EXCLUDED.help,
  sort_order        = EXCLUDED.sort_order,
  permission        = EXCLUDED.permission,
  is_editable       = EXCLUDED.is_editable
WHERE t.key = EXCLUDED.key;

COMMIT;
