-- =====================================================================
-- داده مرجع: شعبه، انبار، نقش‌ها، ماتریس تأیید، روش پرداخت، سال مالی
-- =====================================================================

BEGIN;

-- شعبه و انبارها ------------------------------------------------------
INSERT INTO platform.branch (id, code, name) VALUES
('00000000-0000-7000-8000-000000000001', 'MAIN', 'شعبه اصلی');

INSERT INTO inventory.warehouse (id, branch_id, code, name, kind) VALUES
('00000000-0000-7000-8000-000000000101',
 '00000000-0000-7000-8000-000000000001', 'STORE', 'قفسه فروشگاه', 'store'),
('00000000-0000-7000-8000-000000000102',
 '00000000-0000-7000-8000-000000000001', 'STOCK', 'انبار پشتیبان', 'stock'),
('00000000-0000-7000-8000-000000000103',
 '00000000-0000-7000-8000-000000000001', 'DEFECT', 'کالای معیوب', 'defective');

-- سال مالی و شمارنده اسناد --------------------------------------------
-- ⚠️ تاریخ شروع سال مالی باید توسط حسابدار تأیید شود.
INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status) VALUES
(1405, '2026-03-21', '2027-03-20', 'open');

INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix) VALUES
('00000000-0000-7000-8000-000000000001', 'invoice',      1405, 'F-1405-'),
('00000000-0000-7000-8000-000000000001', 'sale_return',  1405, 'R-1405-'),
('00000000-0000-7000-8000-000000000001', 'purchase',     1405, 'P-1405-'),
('00000000-0000-7000-8000-000000000001', 'journal',      1405, 'J-1405-');

-- نقش‌ها ---------------------------------------------------------------
INSERT INTO identity.role (code, name) VALUES
('admin',      'مدیر کل'),
('accountant', 'حسابدار'),
('supervisor', 'سرپرست فروشگاه'),
('cashier',    'صندوق‌دار'),
('warehouse',  'انباردار'),
('marketing',  'بازاریاب و پشتیبانی');

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
('admin','cost.view',              true,  NULL,   NULL,  NULL);

-- روش‌های پرداخت -------------------------------------------------------
-- ⚠️ دوره تسویه و نرخ کارمزد باید از PSP گرفته و اینجا اصلاح شود.
INSERT INTO treasury.payment_method
  (code, name, kind, clearing_account_code, settlement_days, fee_percent, requires_ref) VALUES
('cash',     'نقدی',           'cash',        NULL,   0, 0,     false),
('card',     'کارت‌خوان',      'card_reader', '1103', 1, 0,     true),
('transfer', 'کارت‌به‌کارت',   'transfer',    '1105', 0, 0,     true),
('gateway',  'درگاه پرداخت',   'gateway',     '1104', 1, 0,     true),
('credit',   'نسیه',           'credit',      NULL,   0, 0,     false),
('points',   'امتیاز باشگاه',  'points',      NULL,   0, 0,     false);

COMMIT;
