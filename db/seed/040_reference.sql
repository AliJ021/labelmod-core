-- =====================================================================
-- داده مرجع: شعبه، انبار، نقش‌ها، ماتریس تأیید، روش پرداخت، سال مالی
-- =====================================================================

BEGIN;

-- شعبه و انبارها ------------------------------------------------------
INSERT INTO platform.branch (id, code, name) VALUES
('00000000-0000-7000-8000-000000000001', 'MAIN', 'شعبه اصلی')
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory.warehouse (id, branch_id, code, name, kind) VALUES
('00000000-0000-7000-8000-000000000101',
 '00000000-0000-7000-8000-000000000001', 'STORE', 'قفسه فروشگاه', 'store'),
('00000000-0000-7000-8000-000000000102',
 '00000000-0000-7000-8000-000000000001', 'STOCK', 'انبار پشتیبان', 'stock'),
('00000000-0000-7000-8000-000000000103',
 '00000000-0000-7000-8000-000000000001', 'DEFECT', 'کالای معیوب', 'defective')
ON CONFLICT (id) DO NOTHING;

-- سال مالی و شمارنده اسناد --------------------------------------------
-- ⚠️ تاریخ شروع سال مالی باید توسط حسابدار تأیید شود.
INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status) VALUES
(1405, '2026-03-21', '2027-03-20', 'open')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix) VALUES
('00000000-0000-7000-8000-000000000001', 'invoice',      1405, 'F-1405-'),
('00000000-0000-7000-8000-000000000001', 'sale_return',  1405, 'R-1405-'),
('00000000-0000-7000-8000-000000000001', 'purchase',     1405, 'P-1405-'),
('00000000-0000-7000-8000-000000000001', 'journal',      1405, 'J-1405-'),
('00000000-0000-7000-8000-000000000001', 'treasury',     1405, 'T-1405-'),
('00000000-0000-7000-8000-000000000001', 'settlement',   1405, 'S-1405-'),
('00000000-0000-7000-8000-000000000001', 'cheque',       1405, 'CHQ-1405-')
ON CONFLICT (branch_id, doc_type, fiscal_year) DO NOTHING;

-- حساب‌های خزانه ------------------------------------------------------
-- ⚠️ نام بانک، شماره حساب، شبا و کارمزد باید با اطلاعات واقعی و
--    صورتحساب PSP جایگزین شوند.
INSERT INTO treasury.account
  (id, code, name, kind, branch_id, ledger_account_code,
   bank_name, settlement_days, fee_percent) VALUES
('00000000-0000-7000-8000-000000000201', 'CASH-MAIN', 'صندوق فروشگاه',
 'cash_box', '00000000-0000-7000-8000-000000000001', '1101', NULL, 0, 0),
('00000000-0000-7000-8000-000000000202', 'BANK-1',    'حساب جاری اصلی',
 'bank',     '00000000-0000-7000-8000-000000000001', '1102', 'نامشخص', 0, 0),
('00000000-0000-7000-8000-000000000203', 'POS-1',     'کارت‌خوان فروشگاه',
 'card_terminal', '00000000-0000-7000-8000-000000000001', '1103', NULL, 1, 0),
('00000000-0000-7000-8000-000000000204', 'GW-1',      'درگاه پرداخت سایت',
 'gateway',  '00000000-0000-7000-8000-000000000001', '1104', NULL, 1, 0),
('00000000-0000-7000-8000-000000000205', 'P2P-1',     'کارت‌به‌کارت',
 'bank',     '00000000-0000-7000-8000-000000000001', '1105', 'نامشخص', 0, 0)
ON CONFLICT (code) DO NOTHING;

UPDATE treasury.account
   SET settlement_account_id = '00000000-0000-7000-8000-000000000202'
 WHERE code IN ('POS-1','GW-1') AND settlement_account_id IS NULL;

-- نقش‌ها ---------------------------------------------------------------
INSERT INTO identity.role (code, name) VALUES
('admin',      'مدیر کل'),
('accountant', 'حسابدار'),
('supervisor', 'سرپرست فروشگاه'),
('cashier',    'صندوق‌دار'),
('warehouse',  'انباردار'),
('marketing',  'بازاریاب و پشتیبانی')
ON CONFLICT (code) DO NOTHING;

-- ماتریس تأیید ---------------------------------------------------------
-- ⚠️ سقف‌ها پیشنهادی‌اند و باید توسط مالک کسب‌وکار تصویب شوند.
-- مبالغ به ریال.
INSERT INTO identity.permission_rule
  (role_code, operation, allowed, max_amount, max_percent, needs_approval_from) VALUES

('cashier','sale.create',          true,  NULL,   NULL,  NULL),
('cashier','sale.discount',        true,  NULL,   10.00, NULL),
('cashier','sale.discount_high',   true,  NULL,   25.00, 'supervisor'),
('cashier','sale.credit',          false, NULL,   NULL,  NULL),
('cashier','return.same_day',      true,  NULL,   NULL,  NULL),
('cashier','return.late',          false, NULL,   NULL,  NULL),
('cashier','refund.cash',          false, NULL,   NULL,  NULL),
('cashier','invoice.cancel',       false, NULL,   NULL,  NULL),
('cashier','cost.view',            false, NULL,   NULL,  NULL),

('supervisor','sale.create',       true,  NULL,   NULL,  NULL),
('supervisor','sale.discount',     true,  NULL,   25.00, NULL),
('supervisor','sale.discount_high',true,  NULL,   NULL,  'admin'),
('supervisor','sale.credit',       true,  NULL,   NULL,  NULL),
('supervisor','return.same_day',   true,  NULL,   NULL,  NULL),
('supervisor','return.late',       true,  NULL,   NULL,  'admin'),
('supervisor','refund.cash',       true,  NULL,   NULL,  NULL),
('supervisor','invoice.cancel',    false, NULL,   NULL,  NULL),
('supervisor','stock.receive',     true,  NULL,   NULL,  NULL),
('supervisor','stock.adjust',      true,  NULL,   NULL,  'admin'),
('supervisor','shift.close',       true,  NULL,   NULL,  NULL),
('supervisor','cost.view',         false, NULL,   NULL,  NULL),

('warehouse','stock.receive',      true,  NULL,   NULL,  NULL),
('warehouse','stock.transfer',     true,  NULL,   NULL,  NULL),
('warehouse','stock.count',        true,  NULL,   NULL,  NULL),
('warehouse','stock.adjust',       true,  NULL,   NULL,  'admin'),
('warehouse','cost.view',          false, NULL,   NULL,  NULL),

('accountant','journal.manual',    true,  NULL,   NULL,  NULL),
('accountant','period.close',      true,  NULL,   NULL,  'admin'),
('accountant','cost.view',         true,  NULL,   NULL,  NULL),
('accountant','settings.security', false, NULL,   NULL,  NULL),

('admin','sale.create',            true,  NULL,   NULL,  NULL),
('admin','sale.discount',          true,  NULL,   NULL,  NULL),
('admin','sale.credit',            true,  NULL,   NULL,  NULL),
('admin','return.late',            true,  NULL,   NULL,  NULL),
('admin','refund.cash',            true,  NULL,   NULL,  NULL),
('admin','invoice.cancel',         true,  NULL,   NULL,  NULL),
('admin','stock.adjust',           true,  NULL,   NULL,  NULL),
('admin','price.change',           true,  NULL,   NULL,  NULL),
('admin','journal.manual',         true,  NULL,   NULL,  NULL),
('admin','period.close',           true,  NULL,   NULL,  NULL),
('admin','period.reopen',          true,  NULL,   NULL,  NULL),
('admin','user.manage',            true,  NULL,   NULL,  NULL),
('admin','deadletter.replay',      true,  NULL,   NULL,  NULL),
('admin','cost.view',              true,  NULL,   NULL,  NULL),

-- هفت ردیفی که در فهرست دستیِ بالا جا افتاده بودند و شکافشان فقط با
-- ساخته‌شدن مسیر مرجوعی معلوم شد. سه‌تایشان **ناسازگار** بودند، نه فقط
-- ناقص — مدیر عملیات سخت‌تر را داشت و آسان‌تر را نه:
--
--   return.same_day   — مدیر «مرجوعی دیرهنگام» را داشت ولی مرجوعی
--                       همان‌روز را نه. یعنی مرجوعی روز اول رد می‌شد و
--                       روز هشتم قبول.
--   sale.discount_high— مدیر تخفیف عادی را داشت ولی پله بالاتر را نه،
--                       در حالی که همان پله برای صندوق‌دار باز است.
--   shift.close       — مدیر دوره ثبت را می‌بندد ولی کشوی صندوق را نه.
--                       صندوق‌داری که بدون بستن شیفت رفته، در فروشگاهی
--                       که سرپرست ندارد، هیچ‌کس نمی‌توانست شیفتش را
--                       ببندد.
--
-- و یکی از آن‌ها را **هیچ نقشی** نداشت:
--
--   settings.security — حسابدار صریحاً ممنوع بود و کسی مجاز نبود.
--                       یعنی تنظیمات امنیتی از مسیر API تغییرناپذیر
--                       بودند؛ عملیاتی که هیچ‌کس نمی‌تواند انجامش دهد،
--                       در عمل وجود ندارد.
--
-- سه‌تای انبار برای همین است که مدیر در فروشگاه تک‌نفره، خودش انبار را
-- هم می‌گرداند.
--
-- ⚠️ اگر مالک نمی‌خواهد مدیر یکی از این‌ها را داشته باشد، حذفش یک
--    DELETE است — نه یک Deploy. سقف‌ها روی نقش‌های پایین‌ترند، نه اینجا.
('admin','return.same_day',        true,  NULL,   NULL,  NULL),
('admin','sale.discount_high',     true,  NULL,   NULL,  NULL),
('admin','shift.close',            true,  NULL,   NULL,  NULL),
('admin','settings.security',      true,  NULL,   NULL,  NULL),
('admin','stock.count',            true,  NULL,   NULL,  NULL),
('admin','stock.receive',          true,  NULL,   NULL,  NULL),
('admin','stock.transfer',         true,  NULL,   NULL,  NULL)
ON CONFLICT (role_code, operation) DO NOTHING;

-- روش‌های پرداخت -------------------------------------------------------
-- ⚠️ دوره تسویه و نرخ کارمزد باید از PSP گرفته و در treasury.account
--    اصلاح شود. نگاشت حساب دفتر اینجا نیست — تنها مرجع آن
--    ledger.posting_rule است (مؤلفه‌های sale_shift).
INSERT INTO treasury.payment_method
  (code, name, kind, settlement_days, fee_percent, requires_ref) VALUES
('cash',     'نقدی',           'cash',        0, 0, false),
('card',     'کارت‌خوان',      'card_reader', 1, 0, true),
('transfer', 'کارت‌به‌کارت',   'transfer',    0, 0, true),
('gateway',  'درگاه پرداخت',   'gateway',     1, 0, true),
('credit',   'نسیه',           'credit',      0, 0, false),
('points',   'امتیاز باشگاه',  'points',      0, 0, false),
('giftcard', 'کارت هدیه',      'gift_card',   0, 0, true)
ON CONFLICT (code) DO NOTHING;

COMMIT;
