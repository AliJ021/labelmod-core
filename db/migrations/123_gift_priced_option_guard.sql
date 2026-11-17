-- =====================================================================
-- ۱۲۳ — گزینهٔ هدیهٔ قیمت‌دار به فاکتور نمی‌نشیند (fail-closed)
-- =====================================================================
-- ردیف ۴ دفتر امنیتی (`docs/SECURITY-FINDINGS-HANDOFF-2026-09-26.md`):
-- «Paid gift options can be finalized without being charged».
--
-- ── مشکل ──────────────────────────────────────────────────────────
-- `sales.gift_option.price` از مهاجرت ۰۴۴ هست، ولی هیچ مسیری آن را به جمع
-- فاکتور نمی‌برد: نه `refresh_invoice_totals`، نه `finalize_invoice`. گزینه‌ای
-- که قیمت بگیرد روی برگهٔ هدیه می‌نشیند، مشتری بسته‌بندی را می‌برد، و فاکتور
-- همان مبلغ کالا را نشان می‌دهد — درآمدی که نه دریافت شد و نه در دفتر هست.
-- Seed همهٔ گزینه‌ها را رایگان می‌سازد و صفحه‌ای برای قیمت‌دادن نیست، پس تنها
-- راه رسیدن به این حالت یک `UPDATE` دستی بود؛ ولی آن `UPDATE` هیچ هشداری نمی‌داد.
--
-- ── چرا «حساب‌کردن قیمت» نه ───────────────────────────────────────
-- شارژکردن بسته‌بندی یعنی انتخاب سرفصل درآمد و وضعیت مالیاتش، و هر دو
-- تصمیم حسابدارند (قاعدهٔ ادامهٔ همان سند: «تعیین سرفصل و مالیات را از حسابدار
-- بگیر»). تا آن تصمیم، گزینهٔ قیمت‌دار **رد می‌شود** — نه رایگان فروخته می‌شود و
-- نه با یک پیش‌فرض مالی اختراعی شارژ می‌شود.
--
-- ── دو لایه ────────────────────────────────────────────────────────
-- ۱. انتخاب: Trigger روی `sales.invoice_gift`. هر مسیر نوشتن (تابع یا درج
--    مستقیم) را می‌گیرد.
-- ۲. نهایی‌سازی: Trigger روی گذار وضعیت فاکتور. گزینه‌ای که **پس از** انتخاب
--    قیمت گرفت، یا سطری که پیش از این مهاجرت نشسته بود، همین‌جا می‌ایستد.
--
-- ⚠️ فاکتورهای **نهایی‌شدهٔ** قدیمی با گزینهٔ قیمت‌دار (اگر باشند) دست نمی‌خورند؛
--    سند قطعی بازنویسی نمی‌شود. `db/test/gift-recipient.sql` بند ۱۰.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION sales.priced_gift_option(p_invoice uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT o.label
    FROM sales.invoice_gift g
    JOIN sales.gift_option o ON o.code IN (g.wrap_code, g.color_code, g.flower_code)
   WHERE g.invoice_id = p_invoice AND o.price > 0
   ORDER BY o.sort_order, o.code
   LIMIT 1
$$;

COMMENT ON FUNCTION sales.priced_gift_option(uuid) IS
  'برچسب اولین گزینهٔ هدیهٔ قیمت‌دار این فاکتور؛ NULL یعنی همه رایگان‌اند.';

CREATE FUNCTION sales.assert_gift_not_priced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_label text;
BEGIN
  SELECT o.label INTO v_label
    FROM sales.gift_option o
   WHERE o.code IN (NEW.wrap_code, NEW.color_code, NEW.flower_code) AND o.price > 0
   ORDER BY o.sort_order, o.code
   LIMIT 1;
  IF v_label IS NOT NULL THEN
    RAISE EXCEPTION 'گزینهٔ هدیهٔ «%» قیمت دارد و هنوز به فاکتور اضافه نمی‌شود: مبلغ بسته‌بندی در جمع فاکتور نمی‌آید و سرفصل و مالیاتش تصویب نشده است.', v_label;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoice_gift_not_priced
  BEFORE INSERT OR UPDATE ON sales.invoice_gift
  FOR EACH ROW EXECUTE FUNCTION sales.assert_gift_not_priced();

CREATE FUNCTION sales.assert_no_priced_gift_on_finalize() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_label text := sales.priced_gift_option(NEW.id);
BEGIN
  IF v_label IS NOT NULL THEN
    RAISE EXCEPTION 'گزینهٔ هدیهٔ «%» قیمت دارد و مبلغش در این فاکتور نیامده است؛ پیش از نهایی‌کردن، بسته‌بندی را عوض یا حذف کنید.', v_label;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoice_no_priced_gift_on_finalize
  BEFORE UPDATE OF status ON sales.invoice
  FOR EACH ROW
  WHEN (OLD.status IN ('draft', 'confirmed', 'partially_paid')
        AND NEW.status IN ('finalized', 'paid'))
  EXECUTE FUNCTION sales.assert_no_priced_gift_on_finalize();

COMMIT;
