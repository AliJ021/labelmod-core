-- =====================================================================
-- تست سناریوی طلایی
-- =====================================================================
-- تنها تستی که همه چیز را با هم می‌بندد:
--   خرید با هزینه حمل → خرید دوم با قیمت متفاوت → میانگین موزون →
--   فروش با تخفیف و مالیات → مرجوعی → بستن شیفت → سند متوازن
--
-- هر assert که رد شود، تراکنش را با پیام فارسی می‌شکند.
-- اجرا:  psql -v ON_ERROR_STOP=1 -f db/test/golden_path.sql
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual numeric, p_expected numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %\n      اختلاف: %',
      p_label, p_expected, p_actual, p_actual - p_expected;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

DO $test$
DECLARE
  BR    uuid := '00000000-0000-7000-8000-000000000001';
  WH    uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid;
  v_sup  uuid;
  v_cust uuid;
  v_prod uuid;
  v_var  uuid;
  v_rcpt uuid;
  v_shift uuid;
  v_inv  uuid;
  v_line uuid;
  v_ret  uuid;
  v_no   text;
  v_qty  numeric;
  v_val  numeric;
  v_dr   numeric;
  v_cr   numeric;
  v_n    int;
BEGIN
RAISE NOTICE E'\n═══ آماده‌سازی ═══';

INSERT INTO identity.app_user (username, full_name)
VALUES ('tester', 'کاربر تست') RETURNING id INTO v_user;

INSERT INTO purchasing.supplier (code, name)
VALUES ('S001', 'تأمین‌کننده آزمایشی') RETURNING id INTO v_sup;

INSERT INTO sales.customer (mobile_normalized, full_name)
VALUES (sales.normalize_mobile('۰۹۱۲۱۲۳۴۵۶۷'), 'مشتری آزمایشی')
RETURNING id INTO v_cust;

PERFORM pg_temp.assert_eq('نرمال‌سازی موبایل فارسی',
  (SELECT length(mobile_normalized) FROM sales.customer WHERE id = v_cust), 11);

INSERT INTO catalog.product (code, name_internal, name_web, fit)
VALUES ('P-KAY', 'شلوار کایمون', 'شلوار پارچه‌ای کایمون', 'نیم‌بگ')
RETURNING id INTO v_prod;

INSERT INTO catalog.variation (product_id, color, size, sku, barcode)
VALUES (v_prod, 'مشکی', 'XL', 'KAY-BLK-XL', '6260000000017')
RETURNING id INTO v_var;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. رسید خرید اول: ۱۰ عدد × ۱٬۰۰۰٬۰۰۰ + حمل ۵۰۰٬۰۰۰ نقدی ═══';
-- بهای تمام‌شده باید (۱۰٬۰۰۰٬۰۰۰ + ۵۰۰٬۰۰۰) ÷ ۱۰ = ۱٬۰۵۰٬۰۰۰ شود

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id,
                                tax_amount, occurred_at, created_by)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH,
        1000000, '2026-06-01 10:00+03:30', v_user)
RETURNING id INTO v_rcpt;

INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 1000000, 10000000);

INSERT INTO purchasing.receipt_charge (receipt_id, charge_type, amount, allocation, paid_from)
VALUES (v_rcpt, 'freight', 500000, 'by_value', 'cash');

PERFORM purchasing.post_receipt(v_rcpt, v_user);

PERFORM pg_temp.assert_eq('بهای تمام‌شده واحد پس از تخصیص حمل',
  (SELECT landed_unit_cost FROM purchasing.receipt_line WHERE receipt_id = v_rcpt), 1050000);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی', v_qty, 10);
PERFORM pg_temp.assert_eq('ارزش موجودی', v_val, 10500000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. رسید خرید دوم: ۵ عدد × ۱٬۲۰۰٬۰۰۰ ═══';
-- میانگین موزون باید (۱۰٬۵۰۰٬۰۰۰ + ۶٬۰۰۰٬۰۰۰) ÷ ۱۵ = ۱٬۱۰۰٬۰۰۰ شود

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id,
                                tax_amount, occurred_at, created_by)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH,
        600000, '2026-06-05 10:00+03:30', v_user)
RETURNING id INTO v_rcpt;

INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 5, 1200000, 6000000);

PERFORM purchasing.post_receipt(v_rcpt, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی', v_qty, 15);
PERFORM pg_temp.assert_eq('ارزش موجودی', v_val, 16500000);
PERFORM pg_temp.assert_eq('میانگین موزون متحرک', round(v_val / v_qty), 1100000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. فروش: ۳ عدد × ۲٬۰۰۰٬۰۰۰ با ۳۰۰٬۰۰۰ تخفیف ═══';

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 1000000, '2026-06-10 09:00+03:30') RETURNING id INTO v_shift;

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id,
                           channel, occurred_at, created_by, client_event_id)
VALUES (BR, WH, v_shift, v_cust, 'pos', '2026-06-10 11:00+03:30', v_user, 'evt-test-001')
RETURNING id INTO v_inv;

INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, discount_amount, tax_amount, net_amount)
VALUES (v_inv, 1, v_var, 3, 2000000, 300000, 570000, 5700000)
RETURNING id INTO v_line;

INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, ref_no)
VALUES (v_inv, v_shift, 'cash', 3000000, NULL),
       (v_inv, v_shift, 'card', 3270000, '123456');

v_no := sales.finalize_invoice(v_inv, v_user);
RAISE NOTICE '  شماره فاکتور: %', v_no;

PERFORM pg_temp.assert_eq('Snapshot بهای واحد روی سطر فروش',
  (SELECT unit_cost FROM sales.invoice_line WHERE id = v_line), 1100000);
PERFORM pg_temp.assert_eq('بهای تمام‌شده فاکتور',
  (SELECT cogs_amount FROM sales.invoice WHERE id = v_inv), 3300000);
PERFORM pg_temp.assert_eq('مبلغ قابل پرداخت',
  (SELECT payable_amount FROM sales.invoice WHERE id = v_inv), 6270000);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پس از فروش', v_qty, 12);
PERFORM pg_temp.assert_eq('ارزش موجودی پس از فروش', v_val, 13200000);
PERFORM pg_temp.assert_eq('میانگین بدون تغییر مانده', round(v_val / v_qty), 1100000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. Idempotency: نهایی‌کردن دوباره همان فاکتور ═══';

IF sales.finalize_invoice(v_inv, v_user) <> v_no THEN
  RAISE EXCEPTION '✗ فراخوانی دوم شماره متفاوتی برگرداند';
END IF;

SELECT count(*) INTO v_n FROM inventory.stock_movement
 WHERE ref_id = v_inv AND kind = 'sale';
PERFORM pg_temp.assert_eq('تعداد حرکت انبار پس از دو بار نهایی‌کردن', v_n, 1);

SELECT on_hand INTO v_qty FROM inventory.stock_balance
 WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی بدون اثر تکراری', v_qty, 12);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. مرجوعی: ۱ عدد از ۳ عدد فروخته‌شده ═══';

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, occurred_at, created_by)
VALUES (BR, v_inv, WH, v_shift, 'size_small', 2090000, '2026-06-10 13:00+03:30', v_user)
RETURNING id INTO v_ret;

INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 1, 0, 0, 0, 0);

PERFORM sales.post_return(v_ret, v_user);

PERFORM pg_temp.assert_eq('مبلغ خالص مرجوعی (نسبتی از ۵٬۷۰۰٬۰۰۰)',
  (SELECT net_amount FROM sales.sale_return WHERE id = v_ret), 1900000);
PERFORM pg_temp.assert_eq('بهای بازگشت — از Snapshot فروش، نه میانگین جاری',
  (SELECT cogs_amount FROM sales.sale_return WHERE id = v_ret), 1100000);
PERFORM pg_temp.assert_eq('وضعیت فاکتور',
  (SELECT CASE status WHEN 'partially_returned' THEN 1 ELSE 0 END
     FROM sales.invoice WHERE id = v_inv), 1);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پس از مرجوعی', v_qty, 13);
PERFORM pg_temp.assert_eq('ارزش موجودی پس از مرجوعی', v_val, 14300000);

RAISE NOTICE E'\n  → مرجوعی بیش از باقی‌مانده باید رد شود';
BEGIN
  INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, reason_code, occurred_at)
  VALUES (BR, v_inv, WH, 'quality', now()) RETURNING id INTO v_ret;
  INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                      unit_price, net_amount, unit_cost, cogs_amount)
  VALUES (v_ret, v_line, 5, 0, 0, 0, 0);
  PERFORM sales.post_return(v_ret, v_user);
  RAISE EXCEPTION '✗ مرجوعی بیش از حد پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  IF sqlerrm LIKE '✗%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ رد شد: %', left(sqlerrm, 60);
END;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. کنترل موجودی منفی ═══';
BEGIN
  PERFORM inventory.apply_movement(v_var, WH, -100, 'sale', NULL, NULL, v_user);
  RAISE EXCEPTION '✗ فروش بیش از موجودی پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  IF sqlerrm LIKE '✗%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ رد شد: %', left(sqlerrm, 60);
END;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. تغییرناپذیری حرکت انبار ═══';
BEGIN
  UPDATE inventory.stock_movement SET qty = 999 WHERE variation_id = v_var;
  RAISE EXCEPTION '✗ حرکت انبار قابل تغییر بود';
EXCEPTION WHEN raise_exception THEN
  IF sqlerrm LIKE '✗%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ رد شد: %', left(sqlerrm, 60);
END;

RAISE NOTICE E'\n  → حذف حرکت انبار هم باید رد شود';
BEGIN
  DELETE FROM inventory.stock_movement WHERE variation_id = v_var;
  RAISE EXCEPTION '✗ حرکت انبار قابل حذف بود';
EXCEPTION WHEN raise_exception THEN
  IF sqlerrm LIKE '✗%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ رد شد: %', left(sqlerrm, 60);
END;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. بستن شیفت و سند تجمیعی ═══';
-- نقد مورد انتظار: افتتاحیه ۱٬۰۰۰٬۰۰۰ + فروش نقدی ۳٬۰۰۰٬۰۰۰
--                  − بازپرداخت نقدی مرجوعی ۲٬۰۹۰٬۰۰۰ = ۱٬۹۱۰٬۰۰۰
-- شمارش واقعی ۱٬۸۶۰٬۰۰۰ → کسری ۵۰٬۰۰۰ که سند مستقل می‌گیرد.
-- خروج نقد بابت مرجوعی نباید به مغایرت تبدیل شود؛ سند خودش را دارد.

PERFORM sales.close_shift(v_shift, 1860000, v_user, 'کسری هنگام شمارش');

PERFORM pg_temp.assert_eq('نقد مورد انتظار پس از کسر بازپرداخت',
  (SELECT expected_cash FROM sales.cash_shift WHERE id = v_shift), 1910000);

PERFORM pg_temp.assert_eq('مغایرت صندوق',
  (SELECT variance FROM sales.cash_shift WHERE id = v_shift), -50000);

-- سند فروش و COGS به «دوره ثبت» گره خورده‌اند، نه مستقیم به شیفت —
-- چون فروش آنلاین هم دوره دارد ولی شیفت ندارد. مغایرت صندوق همچنان
-- مستقیماً به شیفت وصل است.
SELECT count(*) INTO v_n FROM ledger.journal_entry e
 WHERE (e.ref_type = 'cash_shift' AND e.ref_id = v_shift)
    OR (e.ref_type = 'posting_batch' AND e.ref_id =
        (SELECT id FROM ledger.posting_batch WHERE kind = 'shift' AND shift_id = v_shift));
PERFORM pg_temp.assert_eq('تعداد اسناد شیفت (فروش + COGS + مغایرت)', v_n, 3);

PERFORM pg_temp.assert_eq('دوره ثبت شیفت بسته و به هر دو سند وصل است',
  (SELECT count(*) FROM ledger.posting_batch
    WHERE kind = 'shift' AND shift_id = v_shift AND status = 'posted'
      AND sale_entry_id IS NOT NULL AND cogs_entry_id IS NOT NULL), 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۹. صحت دفتر کل ═══';

SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO v_dr, v_cr
  FROM ledger.journal_line;
PERFORM pg_temp.assert_eq('جمع بدهکار کل دفتر', v_dr, v_cr);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('تعداد اسناد نامتوازن', v_n, 0);

SELECT count(*) INTO v_n FROM ledger.journal_line l
  JOIN ledger.account a ON a.code = l.account_code
 WHERE NOT a.is_postable;
PERFORM pg_temp.assert_eq('سطر سند روی حساب غیرقابل ثبت', v_n, 0);

-- سود ناخالص: فروش خالص − برگشت − بهای تمام‌شده
-- (۶٬۰۰۰٬۰۰۰ − ۳۰۰٬۰۰۰) − ۱٬۹۰۰٬۰۰۰ − (۳٬۳۰۰٬۰۰۰ − ۱٬۱۰۰٬۰۰۰) = ۱٬۶۰۰٬۰۰۰
PERFORM pg_temp.assert_eq('سود ناخالص از دفتر کل',
  (SELECT
     coalesce(sum(CASE WHEN a.code = '4101' THEN l.credit - l.debit END),0)
   - coalesce(sum(CASE WHEN a.code IN ('4102','4103') THEN l.debit - l.credit END),0)
   - coalesce(sum(CASE WHEN a.code = '5101' THEN l.debit - l.credit END),0)
     FROM ledger.journal_line l JOIN ledger.account a ON a.code = l.account_code),
  1600000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۰. تطبیق Projection با مرجع ═══';

SELECT count(*) INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف موجودی با جمع حرکت‌ها', v_n, 0);

-- ارزش موجودی در دفتر باید با ارزش انبار بخواند
PERFORM pg_temp.assert_eq('ارزش موجودی: دفتر کل در برابر انبار',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1301'),
  (SELECT coalesce(sum(total_value),0) FROM inventory.stock_balance));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۱. سند نامتوازن باید رد شود ═══';
BEGIN
  PERFORM ledger.post_entry('sale_shift', BR, '2026-06-10',
    'سند عمداً نامتوازن',
    jsonb_build_array(jsonb_build_object('leg','cash','amount', 1000)),
    NULL, NULL, v_user);
  RAISE EXCEPTION '✗ سند نامتوازن پذیرفته شد';
EXCEPTION WHEN raise_exception THEN
  IF sqlerrm LIKE '✗%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ رد شد: %', left(sqlerrm, 70);
END;

RAISE NOTICE E'\n═══ ۱۲. حسابرسی و صف ═══';

-- لاگ را دیگر دستی نمی‌سازیم: خودِ توابع مالی می‌نویسند.
PERFORM pg_temp.assert_eq('لاگ حسابرسی رسید خرید',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'purchase.post'), 2);
PERFORM pg_temp.assert_eq('لاگ حسابرسی نهایی‌کردن فاکتور',
  (SELECT count(*) FROM platform.audit_log
    WHERE action = 'invoice.finalize' AND entity_id = v_inv::text), 1);
PERFORM pg_temp.assert_eq('لاگ حسابرسی بستن شیفت',
  (SELECT count(*) FROM platform.audit_log
    WHERE action = 'shift.close' AND entity_id = v_shift::text), 1);

-- زنجیره باید پیوسته باشد: prev_hash هر ردیف دقیقاً hash ردیف قبلی است
SELECT count(*) INTO v_n FROM (
  SELECT prev_hash, lag(hash) OVER (ORDER BY id) AS expected_prev
    FROM platform.audit_log) x
 WHERE prev_hash IS DISTINCT FROM expected_prev;
PERFORM pg_temp.assert_eq('گسست در زنجیره هش حسابرسی', v_n, 0);

BEGIN
  -- شناسه ثابت ننویس: bigserial با Rollback برنمی‌گردد و id=1 ممکن است
  -- در اجرای دوم اصلاً وجود نداشته باشد — آن‌وقت UPDATE صفر سطری
  -- بی‌سروصدا «موفق» می‌شود و تست دستکاری بی‌معنا می‌ماند.
  UPDATE platform.audit_log SET action = 'tampered'
   WHERE id = (SELECT min(id) FROM platform.audit_log);
  RAISE EXCEPTION '✗ لاگ حسابرسی قابل تغییر بود';
EXCEPTION WHEN raise_exception THEN
  IF sqlerrm LIKE '✗%' THEN RAISE; END IF;
  RAISE NOTICE '  ✓ رد شد: %', left(sqlerrm, 60);
END;

SELECT count(*) INTO v_n FROM platform.outbox_message WHERE topic = 'invoice.finalized';
PERFORM pg_temp.assert_eq('پیام Outbox پس از نهایی‌شدن فاکتور', v_n, 1);

RAISE NOTICE E'\n╔══════════════════════════════════════════════╗';
RAISE NOTICE   '║   تمام تست‌های سناریوی طلایی پاس شدند   ║';
RAISE NOTICE   '╚══════════════════════════════════════════════╝';
END $test$;

ROLLBACK;
