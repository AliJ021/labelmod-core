-- =====================================================================
-- ۱۰۵ — فروش اینستاگرام از همان صندوق (بازنگری مالک ۲۶ اکتبر)
-- =====================================================================
-- قرارداد: docs/INSTAGRAM-POS-MODE-FA.md. این مهاجرت سفارش v1 (۱۰۲) را حذف نمی‌کند؛
-- فقط مسیر دومی برای فاکتور کانال `instagram` باز می‌کند: «حالت صندوق».
--
-- حالت صندوق = فاکتور `instagram` که سطر `sales.instagram_order` ندارد.
--   • ساخت: فقط با زمینهٔ محلی `lmc.instagram_order = 'pos'` و فقط برای سازنده‌ای که
--     `instagram.pos.sell` دارد و نقشی در همان شعبه (یا همهٔ شعبه‌ها) دارد. بی شیفت.
--   • کانال پس از درج عوض نمی‌شود (همان نگهبان ۱۰۲). تغییر بعدی نقش کاربر روی فاکتور
--     ساخته‌شده اثر ندارد.
--   • اقلام: مثل صندوق، ولی فقط تعداد صحیح (همان قاعدهٔ سفارش v1: پوشاک تکه‌ای است).
--   • پرداخت: کارت‌خوان (حضوری)، نقد (کشو ندارد) و نسیه رد می‌شوند. بقیهٔ روش‌های فعال
--     با نگهبان‌های خودشان (کارت‌به‌کارت با مرجع، اسنپ‌پی و دیجی‌پی دستیِ تأییدشده).
--   • نهایی‌سازی فقط با پرداخت کامل: «پرداخت‌شده + ارزش تعویض ≥ مبلغ قابل پرداخت».
--     کلید `sales.credit_enabled` و مجوز `sale.credit` اینجا هیچ اثری ندارند.
--   • دورهٔ ثبت: بی شیفت، پس `resolve_posting_batch` همان دورهٔ (شعبه، instagram، روز) را
--     می‌دهد که سفارش v1 داشت. تابع مشترک عوض نمی‌شود.
--
-- سفارش v1 (سطر instagram_order دارد) دقیقاً همان قواعد ۱۰۲ را نگه می‌دارد: هر شاخهٔ
-- تازه پشت «سطر سفارش نیست» است و شاخهٔ قبلی کلمه‌به‌کلمه می‌ماند.
--
-- نقش تازه `instagram_operator`: فقط `instagram.pos.sell`. `sale.create` ندارد، پس با
-- همین نقش فاکتور حضوری (`pos`) ساخته نمی‌شود. نصب تازه: db/seed/105_instagram_pos.sql.
-- =====================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO identity.role (code, name) VALUES ('instagram_operator', 'اپراتور اینستاگرام')
ON CONFLICT (code) DO NOTHING;

-- مدیر کل هر دو حالت را دارد؛ اپراتور فقط اینستاگرام. نقش‌های دیگر صریح «نه».
INSERT INTO identity.permission_rule (role_code, operation, allowed, max_amount, max_percent, needs_approval_from)
SELECT r.code, 'instagram.pos.sell', r.code IN ('admin', 'instagram_operator'), NULL, NULL, NULL
  FROM identity.role r
ON CONFLICT (role_code, operation) DO NOTHING;

CREATE OR REPLACE FUNCTION sales.instagram_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o sales.instagram_order%ROWTYPE;
  v_ctx text := coalesce(current_setting('lmc.instagram_order', true), '');
  v_due numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.channel = 'instagram' THEN
      IF v_ctx = 'new' THEN RETURN NEW; END IF;                      -- سفارش v1 (۱۰۲)
      IF v_ctx <> 'pos' THEN
        RAISE EXCEPTION 'فاکتور اینستاگرام فقط از مسیر سفارش اینستاگرام یا صندوق در حالت اینستاگرام ساخته می‌شود';
      END IF;
      IF NEW.created_by IS NULL OR NOT EXISTS (
           SELECT 1 FROM identity.can(NEW.created_by, 'instagram.pos.sell') c WHERE c.verdict = 'allow') THEN
        RAISE EXCEPTION 'این کاربر مجوز فروش اینستاگرام ندارد';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM identity.user_role ur
                      WHERE ur.user_id = NEW.created_by AND (ur.branch_id IS NULL OR ur.branch_id = NEW.branch_id)) THEN
        RAISE EXCEPTION 'فروش اینستاگرام بیرون از شعبهٔ کاربر مجاز نیست';
      END IF;
      IF NEW.shift_id IS NOT NULL THEN
        RAISE EXCEPTION 'فروش اینستاگرام به شیفت کشو نمی‌چسبد';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.channel = 'instagram') <> (NEW.channel = 'instagram') THEN
    RAISE EXCEPTION 'کانال اینستاگرام فاکتور قابل تغییر نیست';
  END IF;
  IF NEW.channel <> 'instagram' OR OLD.status <> 'draft' THEN RETURN NEW; END IF;

  SELECT * INTO o FROM sales.instagram_order WHERE invoice_id = NEW.id;
  IF NOT FOUND THEN
    -- حالت صندوق (یا لحظهٔ ساخت سفارش v1 پیش از درج سطر سفارش، که فقط پیش‌نویس است).
    IF NEW.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'فروش اینستاگرام به شیفت کشو نمی‌چسبد';
    END IF;
    IF NEW.status IN ('finalized', 'paid') THEN
      v_due := NEW.payable_amount - NEW.paid_amount - sales.exchange_in(NEW.id);
      IF v_due > 0 THEN
        RAISE EXCEPTION 'فروش اینستاگرام فقط با پرداخت کامل نهایی می‌شود؛ مانده % ریال است', v_due;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF v_ctx <> o.id::text THEN
    RAISE EXCEPTION 'پیش‌نویس سفارش اینستاگرام فقط از صفحهٔ همان سفارش تغییر می‌کند (%)', o.order_no;
  END IF;
  IF NEW.status = 'draft' THEN
    IF o.status NOT IN ('draft','confirming') THEN
      RAISE EXCEPTION 'سفارش % رزرو یا بسته است؛ برای تغییر ابتدا رزرو را برگردانید', o.order_no;
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    IF o.status <> 'cancelled' THEN RAISE EXCEPTION 'لغو فاکتور فقط با لغو سفارش %', o.order_no; END IF;
  ELSIF o.status <> 'confirming' THEN
    RAISE EXCEPTION 'فاکتور سفارش % فقط در تراکنش تأیید واریز نهایی می‌شود', o.order_no;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sales.instagram_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  inv record;
  o sales.instagram_order%ROWTYPE;
BEGIN
  SELECT channel, status INTO inv FROM sales.invoice WHERE id = v_invoice;
  IF inv.channel IS DISTINCT FROM 'instagram' OR inv.status <> 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO o FROM sales.instagram_order WHERE invoice_id = v_invoice FOR UPDATE;
  IF NOT FOUND THEN
    -- حالت صندوق: دروازه‌های عادی سطر (قیمت، کاهش قیمت، موجودی در نهایی‌سازی) و فقط تعداد صحیح.
    IF TG_OP <> 'DELETE' AND NEW.qty <> trunc(NEW.qty) THEN
      RAISE EXCEPTION 'تعداد کالای فروش اینستاگرام باید عدد صحیح باشد';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF coalesce(current_setting('lmc.instagram_order', true), '') <> o.id::text THEN
    RAISE EXCEPTION 'اقلام سفارش اینستاگرام فقط از صفحهٔ همان سفارش تغییر می‌کند';
  END IF;
  IF o.status = 'confirming' THEN                 -- Snapshot بها در نهایی‌سازی
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF o.status <> 'draft' THEN
    RAISE EXCEPTION 'سفارش % رزرو یا بسته است؛ برای تغییر اقلام ابتدا رزرو را برگردانید', o.order_no;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.qty <> trunc(NEW.qty) THEN
    RAISE EXCEPTION 'تعداد کالای سفارش اینستاگرام باید عدد صحیح باشد';
  END IF;
  UPDATE sales.instagram_order SET version = version + 1, updated_at = now() WHERE id = o.id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION sales.instagram_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o sales.instagram_order%ROWTYPE;
  v_channel text;
  v_kind text;
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM sales.instagram_order WHERE invoice_id = NEW.invoice_id) THEN
    -- سفارش v1: همان قاعدهٔ ۱۰۲.
    SELECT io.* INTO o FROM sales.instagram_order io
      JOIN sales.invoice i ON i.id = io.invoice_id
     WHERE io.invoice_id = NEW.invoice_id AND i.status = 'draft';
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF o.status <> 'confirming' OR coalesce(current_setting('lmc.instagram_order', true), '') <> o.id::text THEN
      RAISE EXCEPTION 'دریافت سفارش اینستاگرام فقط با تأیید واریز همان سفارش ثبت می‌شود (%)', o.order_no;
    END IF;
    RETURN NEW;
  END IF;
  SELECT channel INTO v_channel FROM sales.invoice WHERE id = NEW.invoice_id;
  IF v_channel IS DISTINCT FROM 'instagram' OR NEW.direction <> 'in' THEN RETURN NEW; END IF;
  SELECT kind INTO v_kind FROM treasury.payment_method WHERE code = NEW.method_code;
  IF v_kind IN ('card_reader', 'cash', 'credit') THEN
    RAISE EXCEPTION 'روش «%» برای فروش اینستاگرام مجاز نیست؛ کارت‌به‌کارت یا روش پرداخت از راه دور را انتخاب کنید',
      NEW.method_code;
  END IF;
  RETURN NEW;
END $$;

-- ساخت سفارش چندمرحله‌ای v1 بسته است، مگر با تصمیم صریح. سفارش‌های موجود دست نمی‌خورند:
-- خواندن، تأیید واریز، لغو، آزادسازی و انقضای همان قاعدهٔ ۱۰۲ باز می‌مانند.
INSERT INTO platform.setting AS t
  (key, value, description, requires_approval, kind, label, group_key, options,
   min_value, max_value, unit, help, sort_order, permission, is_editable)
VALUES ('instagram.legacy_order_create', 'false'::jsonb,
  'ساخت سفارش چندمرحله‌ای اینستاگرام (v1) با رزرو و ارسال.', false,
  'bool', 'ساخت سفارش اینستاگرام چندمرحله‌ای (قدیمی)', 'sales', NULL, NULL, NULL, NULL,
  'فروش تازهٔ اینستاگرام از صندوق در حالت اینستاگرام و فقط با پرداخت کامل ثبت می‌شود. این کلید فقط ساخت سفارش قدیمی را باز می‌کند؛ سفارش‌های موجود در هر حال قابل پیگیری و بستن‌اند.',
  61, 'settings.security', true)
ON CONFLICT (key) DO NOTHING;

COMMIT;
