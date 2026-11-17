-- =====================================================================
-- ۱۲۴ — رسید ثبت‌شده در دیتابیس هم تغییرناپذیر است؛ انبار از همان شعبه
-- =====================================================================
-- بازآزمایی ردیف ۲۹ دفتر امنیتی (۲۰۲۶/۱۱/۱۵). نگهبان‌های ۰۸۹ هر چه ادعا کرده
-- بودند می‌گیرند (شعبه، تأمین‌کننده، کالا، جابه‌جایی سطر). ولی سه راه دیگر برای
-- همان اثر — «سفارشی رسیده نشان داده شود که کالایش به آن شعبه نیامده» — فقط در
-- لایهٔ API بسته بود و دیتابیس آن‌ها را می‌پذیرفت. اندازه‌گیری شد، با نقش مالک:
--
--   • `UPDATE receipt_line SET qty = 50` روی رسید **ثبت‌شده** → پذیرفته شد؛
--     پیشرفت سفارش جلو رفت، بی حرکت انبار و بی سند.
--   • افزودن سطر سفارش‌دار به رسید ثبت‌شده، و وصل‌کردن رسید ثبت‌شدهٔ بی‌سفارش
--     به یک سفارش → پذیرفته شد؛ پیشرفت سفارش از ۲ به ۳ و از ۰ به ۴ رفت.
--   • رسید شعبهٔ «الف» با **انبار شعبهٔ «ب»**، وصل به سفارش شعبهٔ «الف» →
--     پذیرفته شد. ۰۸۹ «انبار دیگر همان شعبه» را عمداً باز گذاشت، ولی هیچ‌چیز
--     نمی‌سنجید که انبار واقعاً از همان شعبه باشد.
--
-- CLAUDE.md می‌گوید رسید «پس از ثبت تغییرناپذیر است»؛ آن قاعده فقط در
-- `apps/api/src/purchasing/receipt.ts` بود. نقش برنامه حق نوشتن مستقیم روی این
-- جدول‌ها را دارد، پس مسیر تازه‌ای که آن سنجش را فراموش کند بی‌صدا می‌گذشت.
--
-- ── قاعده ──────────────────────────────────────────────────────────
-- ۱. سربرگ رسید ثبت‌شده: هیچ `UPDATE` و `DELETE`. `post_receipt` وضعیت را در
--    **آخرین** نوشتنش «ثبت‌شده» می‌کند، پس خودش از این نگهبان نمی‌گذرد.
-- ۲. سطر و هزینهٔ رسید ثبت‌شده: نه درج، نه حذف، نه ویرایش — با **یک** استثنا:
--    `returned_qty` که `purchasing.post_purchase_return` جلو می‌برد.
-- ۳. انبار رسید و انبار سفارش خرید باید از همان شعبهٔ سند باشند. روی هر نوشتن
--    سنجیده می‌شود، پس پیش‌نویس قدیمی در گذار به «ثبت‌شده» هم می‌ایستد.
--
-- ⚠️ سطرهای موجود بازنویسی یا اعتبارسنجی نمی‌شوند؛ رسید ثبت‌شدهٔ قدیمی با انبار
--    شعبهٔ دیگر (اگر باشد) همان می‌ماند و فقط دیگر عوض نمی‌شود.
-- ⚠️ «برگشت از خرید» راه اصلاح رسید ثبت‌شده است، نه ویرایش آن.
--
-- آزمون: `db/test/purchase-receipt-immutable.sql`.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── ۱. سربرگ ──────────────────────────────────────────────────────────
CREATE FUNCTION purchasing.posted_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'رسید ثبت‌شده تغییر نمی‌کند و حذف نمی‌شود؛ اصلاح آن با برگشت از خرید است.';
END $$;

CREATE TRIGGER posted_receipt_immutable_t
  BEFORE UPDATE OR DELETE ON purchasing.receipt
  FOR EACH ROW
  WHEN (OLD.status = 'posted')
  EXECUTE FUNCTION purchasing.posted_receipt_immutable();

-- ── ۲. سطر و هزینه ────────────────────────────────────────────────────
CREATE FUNCTION purchasing.posted_receipt_child_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_posted boolean;
BEGIN
  SELECT bool_or(status = 'posted') INTO v_posted
    FROM purchasing.receipt
   WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.receipt_id END,
                CASE WHEN TG_OP <> 'DELETE' THEN NEW.receipt_id END);
  IF NOT coalesce(v_posted, false) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- تنها نوشتن مجاز روی سطر رسید ثبت‌شده: جلو رفتن «برگشتی» از برگشت از خرید.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'receipt_line'
     AND (to_jsonb(NEW) - 'returned_qty') = (to_jsonb(OLD) - 'returned_qty') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'سطر و هزینهٔ رسید ثبت‌شده تغییر نمی‌کند؛ اصلاح آن با برگشت از خرید است.';
END $$;

CREATE TRIGGER posted_receipt_line_immutable_t
  BEFORE INSERT OR UPDATE OR DELETE ON purchasing.receipt_line
  FOR EACH ROW EXECUTE FUNCTION purchasing.posted_receipt_child_immutable();

CREATE TRIGGER posted_receipt_charge_immutable_t
  BEFORE INSERT OR UPDATE OR DELETE ON purchasing.receipt_charge
  FOR EACH ROW EXECUTE FUNCTION purchasing.posted_receipt_child_immutable();

-- ── ۳. انبار از همان شعبه ─────────────────────────────────────────────
CREATE FUNCTION purchasing.assert_warehouse_in_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory.warehouse
                  WHERE id = NEW.warehouse_id AND branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'انبار این سند از شعبهٔ دیگری است؛ رسید و سفارش خرید فقط به انبار همان شعبه می‌روند.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER receipt_warehouse_in_branch_t
  BEFORE INSERT OR UPDATE ON purchasing.receipt
  FOR EACH ROW EXECUTE FUNCTION purchasing.assert_warehouse_in_branch();

CREATE TRIGGER purchase_order_warehouse_in_branch_t
  BEFORE INSERT OR UPDATE OF warehouse_id, branch_id ON purchasing.purchase_order
  FOR EACH ROW EXECUTE FUNCTION purchasing.assert_warehouse_in_branch();

REVOKE EXECUTE ON FUNCTION purchasing.posted_receipt_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION purchasing.posted_receipt_child_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION purchasing.assert_warehouse_in_branch() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sales.assert_gift_not_priced() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sales.assert_no_priced_gift_on_finalize() FROM PUBLIC;

COMMIT;
