-- مهاجرت ۱۰۶: نقد در فروش اینستاگرام از صندوق — با کشوی واقعی، نه با حذف روش.
--
-- بازنگری root (۲۶ اکتبر): مالک گفت «کارت‌به‌کارت جای کارت‌خوان، بقیهٔ روش‌های صندوق بمانند».
-- مهاجرت ۱۰۵ نقد را فقط چون فاکتور اینستاگرام شیفت ندارد رد می‌کرد؛ این حذفِ بی‌مجوز بود.
--
-- قاعدهٔ تازه — نقد اینستاگرام به **کشوی باز همان شعبه** می‌نشیند:
--   * فاکتور شیفت نمی‌گیرد (`shift_id` تهی می‌ماند) پس دورهٔ ثبتش همان (شعبه، instagram، روز) است
--     و کانالش اینستاگرام.
--   * ردیف پرداخت نقد `shift_id` کشو را می‌برد. `sales.close_shift` نقد را از
--     `treasury.payment.shift_id` می‌شمارد (۰۳۹)، نه از شیفت فاکتور، پس همین پول در شمارش
--     همان کشو می‌آید و مغایرت کاذب نمی‌سازد. انتخاب کشو کار لایهٔ HTTP است
--     (`treasury/cash-drawer.ts`، همان تعریف بازپرداخت مرجوعی و حرکت نقد غیرفروشی).
--   * **باقی پول نیست:** نقد اینستاگرام از مانده بیشتر نمی‌شود. باقی پول در نهایی‌سازی به
--     شیفت فاکتور می‌نشیند و این فاکتور شیفتی ندارد؛ اجازه‌اش یعنی پولی که از کشو بیرون رفته
--     ولی در هیچ شمارشی نیامده.
--   * **کشو با نقدِ پیش‌نویس بسته نمی‌شود:** `close_shift` فقط پیش‌نویس‌های **همان شیفت** را
--     می‌بیند. بی این نگهبان، کشو با نقد سبد اینستاگرامِ هنوز باز بسته می‌شد و برگشت بعدی آن
--     نقد از کشوی دیگری بیرون می‌رفت.
-- کارت‌خوان (مشتری حاضر نیست) و نسیه (فقط پرداخت کامل، ۱۰۵) همچنان رد می‌شوند.
-- جدول تازه یا تغییر داده ندارد؛ فقط دو تابع نگهبان.

BEGIN;

CREATE OR REPLACE FUNCTION sales.instagram_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o sales.instagram_order%ROWTYPE;
  inv sales.invoice%ROWTYPE;
  v_kind text;
  v_shift sales.cash_shift%ROWTYPE;
  v_paid platform.money;
  v_due platform.money;
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
  SELECT * INTO inv FROM sales.invoice WHERE id = NEW.invoice_id;
  IF inv.channel IS DISTINCT FROM 'instagram' OR NEW.direction <> 'in' THEN RETURN NEW; END IF;
  SELECT kind INTO v_kind FROM treasury.payment_method WHERE code = NEW.method_code;
  IF v_kind IN ('card_reader', 'credit') THEN
    RAISE EXCEPTION 'روش «%» برای فروش اینستاگرام مجاز نیست؛ کارت‌به‌کارت یا روش دیگری را انتخاب کنید',
      NEW.method_code;
  END IF;
  IF v_kind = 'cash' THEN
    IF NEW.shift_id IS NULL THEN
      RAISE EXCEPTION 'نقد فروش اینستاگرام باید به کشوی باز همین شعبه ثبت شود';
    END IF;
    -- FOR SHARE: با قفل `close_shift` (FOR UPDATE) ترتیب می‌گیرد؛ یا پرداخت پیش از بستن در
    -- کشو می‌نشیند (و آن‌وقت بستن به نگهبان پایین می‌خورد) یا پس از بستن رد می‌شود.
    SELECT * INTO v_shift FROM sales.cash_shift WHERE id = NEW.shift_id FOR SHARE;
    IF NOT FOUND OR v_shift.status <> 'open' OR v_shift.branch_id <> inv.branch_id THEN
      RAISE EXCEPTION 'کشوی نقد این پرداخت در شعبهٔ فاکتور باز نیست';
    END IF;
    -- همان «دریافتی» صندوق (`paidSoFar`): پرداخت‌های موفق غیرنسیه، ورودی منهای خروجی.
    SELECT coalesce(sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0) INTO v_paid
      FROM treasury.payment p JOIN treasury.payment_method m ON m.code = p.method_code
     WHERE p.invoice_id = inv.id AND m.kind <> 'credit' AND p.status IN ('succeeded','settled','reconciled');
    v_due := inv.net_amount + inv.tax_amount + inv.shipping_amount - v_paid - sales.exchange_in(inv.id);
    IF NEW.amount > greatest(v_due, 0) THEN
      RAISE EXCEPTION 'نقد فروش اینستاگرام از مانده بیشتر نمی‌شود (باقی پول ندارد)؛ حداکثر %', greatest(v_due, 0);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sales.cash_shift_open_draft_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status <> 'open' AND EXISTS (
       SELECT 1 FROM treasury.payment p
         JOIN treasury.payment_method m ON m.code = p.method_code
         JOIN sales.invoice i ON i.id = p.invoice_id
        WHERE p.shift_id = OLD.id AND m.kind = 'cash' AND p.direction = 'in'
          AND p.status IN ('succeeded','settled','reconciled')
          AND i.status IN ('draft','confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'کشو با نقدِ فاکتور نهایی‌نشده (فروش اینستاگرام) بسته نمی‌شود؛ ابتدا آن فاکتور را نهایی یا برگشت کنید';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cash_shift_open_draft_cash_guard ON sales.cash_shift;
CREATE TRIGGER cash_shift_open_draft_cash_guard BEFORE UPDATE OF status ON sales.cash_shift
  FOR EACH ROW EXECUTE FUNCTION sales.cash_shift_open_draft_cash_guard();

COMMIT;
