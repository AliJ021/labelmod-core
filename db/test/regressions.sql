-- =====================================================================
-- تست‌های رگرسیون — شکاف‌های بازبینی معماری
-- =====================================================================
-- هر بخش این فایل یک باگ واقعی است که پیش از مهاجرت ۰۰۳ وجود داشت و
-- هیچ‌کدام از تست‌های قبلی آن را نمی‌گرفتند. اگر روزی یکی از این‌ها
-- دوباره قرمز شد، یعنی اصلاح برگشته است.
--
--   C1  فروش بدون شیفت صندوق (کانال آنلاین) هیچ سند حسابداری نمی‌گرفت
--   C2  مرجوعی فروش نسیه، بدهی مشتری را تسویه نمی‌کرد
--   C3  بازپرداخت نقدی، مغایرت کاذب می‌ساخت و دو بار در دفتر می‌نشست
--   C4  سطرهای سند تأییدشده قابل بازنویسی بودند
--   C5  لاگ حسابرسی هرگز نوشته نمی‌شد و زنجیره هش مسابقه داشت
--   H1  پرداخت «نامشخص» به‌عنوان پول واقعی شمرده می‌شد
--   H5  فاکتور روی شیفت بسته نهایی می‌شد و درآمدش از دفتر می‌افتاد
--   H6  دو قاعده ثبت برای یک مؤلفه، سمت سند را تصادفی می‌کرد
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual numeric, p_expected numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

-- اجرای یک دستور که باید خطا بدهد. اگر بدون خطا اجرا شود، تست رد است.
-- EXECUTE داخل بلوک با EXCEPTION یک Savepoint می‌سازد، پس اثر دستورِ
-- ناموفق (و حتی موفق ولی نامطلوب) روی داده تست باقی نمی‌ماند.
CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_cust uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_inv_web uuid; v_inv uuid; v_line uuid; v_ret uuid;
  v_shift1 uuid; v_shift2 uuid; v_shift3 uuid;
  v_inv_unknown uuid; v_inv_late uuid; v_entry uuid;
  v_n int; v_qty numeric; v_val numeric;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('reg','تست رگرسیون')
  RETURNING id INTO v_user;
INSERT INTO purchasing.supplier (code, name) VALUES ('S-REG','تأمین‌کننده رگرسیون')
  RETURNING id INTO v_sup;
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
  VALUES ('09121111111','مشتری رگرسیون', 100000000) RETURNING id INTO v_cust;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-REG','کالای رگرسیون')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','REG-M') RETURNING id INTO v_var;

-- خرید ۱۰ عدد × ۱٬۰۰۰٬۰۰۰ → ارزش انبار ۱۰٬۰۰۰٬۰۰۰
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-19')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 1000000, 10000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ C1. فروش اینترنتی بدون شیفت صندوق ═══';
-- سفارش ووکامرس هیچ شیفت صندوقی ندارد. پیش از اصلاح، سند فروش فقط
-- در close_shift و فقط برای فاکتورهای همان شیفت زده می‌شد — یعنی
-- انبار کم می‌شد ولی نه درآمدی ثبت می‌شد نه بهای تمام‌شده‌ای.

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id,
                           channel, occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', '2026-06-20 12:00+03:30', v_user)
RETURNING id INTO v_inv_web;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv_web, 1, v_var, 2, 3000000, 6000000);
INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, status)
VALUES (v_inv_web, 'gateway', 6000000, 'GW-1', 'succeeded');

PERFORM sales.finalize_invoice(v_inv_web, v_user);

SELECT on_hand, total_value INTO v_qty, v_val
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('(C1) موجودی پس از فروش آنلاین', v_qty, 8);

-- بستن دوره ثبت کانال آنلاین — همان کاری که close_shift برای صندوق می‌کند
PERFORM sales.close_channel_day(BR, 'web', DATE '2026-06-20', v_user);

PERFORM pg_temp.assert_eq('(C1) درآمد فروش آنلاین در دفتر کل',
  (SELECT coalesce(sum(credit - debit),0) FROM ledger.journal_line
    WHERE account_code = '4101'), 6000000);
PERFORM pg_temp.assert_eq('(C1) بهای تمام‌شده فروش آنلاین در دفتر کل',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '5101'), 2000000);
PERFORM pg_temp.assert_eq('(C1) وجوه در راه درگاه',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1104'), 6000000);
PERFORM pg_temp.assert_eq('(C1) ارزش موجودی: دفتر کل = انبار',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1301'),
  (SELECT coalesce(sum(total_value),0) FROM inventory.stock_balance));

SELECT count(*) INTO v_n FROM sales.unposted_revenue;
PERFORM pg_temp.assert_eq('(C1) فاکتور نهایی‌شده بدون سند فروش', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ C2. مرجوعی فروش نسیه باید بدهی مشتری را تسویه کند ═══';
-- فاکتور ۵٬۰۰۰٬۰۰۰ با ۲٬۰۰۰٬۰۰۰ نقدی → بدهی ۳٬۰۰۰٬۰۰۰.
-- مرجوعی کامل: ۲٬۰۰۰٬۰۰۰ نقد برمی‌گردد و ۳٬۰۰۰٬۰۰۰ بدهی صفر می‌شود.
-- پیش از اصلاح، بدهی دست‌نخورده می‌ماند و کل مبلغ به «اعتبار مشتری» می‌رفت.

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-21 09:00+03:30') RETURNING id INTO v_shift1;

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id,
                           channel, occurred_at, created_by)
VALUES (BR, WH, v_shift1, v_cust, 'pos', '2026-06-21 10:00+03:30', v_user)
RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 2500000, 5000000) RETURNING id INTO v_line;
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount)
VALUES (v_inv, v_shift1, 'cash', 2000000);

PERFORM sales.finalize_invoice(v_inv, v_user);
PERFORM sales.close_shift(v_shift1, 2000000, v_user);

PERFORM pg_temp.assert_eq('(C2) بدهی مشتری پس از فروش نسیه',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1201'), 3000000);

-- شیفت جدید: پول قبلی هنوز در کشو است، پس افتتاحیه ۲٬۰۰۰٬۰۰۰
INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 2000000, '2026-06-22 09:00+03:30') RETURNING id INTO v_shift2;

-- نمی‌شود پولی را پس داد که هرگز گرفته نشده
PERFORM pg_temp.assert_raises('(C2) بازپرداخت بیش از مبلغ دریافت‌شده', format($q$
  DO $d$ DECLARE r uuid; BEGIN
    INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                                   reason_code, refund_amount, occurred_at, created_by)
    VALUES (%L,%L,%L,%L,'changed_mind',5000000,'2026-06-22 11:00+03:30',%L)
    RETURNING id INTO r;
    INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                        unit_price, net_amount, unit_cost, cogs_amount)
    VALUES (r,%L,2,0,0,0,0);
    PERFORM sales.post_return(r, %L);
  END $d$;
$q$, BR, v_inv, WH, v_shift2, v_user, v_line, v_user));

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method,
                               occurred_at, created_by)
VALUES (BR, v_inv, WH, v_shift2, 'changed_mind', 2000000, 'cash',
        '2026-06-22 11:00+03:30', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 2, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

PERFORM pg_temp.assert_eq('(C2) بدهی مشتری پس از مرجوعی کامل',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1201'), 0);
PERFORM pg_temp.assert_eq('(C2) بدهی تسویه‌شده روی برگ مرجوعی',
  (SELECT receivable_applied FROM sales.sale_return WHERE id = v_ret), 3000000);
PERFORM pg_temp.assert_eq('(C2) اعتبار مشتری — نباید ساخته شود',
  (SELECT coalesce(sum(credit - debit),0) FROM ledger.journal_line
    WHERE account_code = '2301'), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ C3. بازپرداخت نقدی نباید مغایرت کاذب بسازد ═══';
-- کشو با ۲٬۰۰۰٬۰۰۰ باز شد، ۲٬۰۰۰٬۰۰۰ بازپرداخت شد، پس باید خالی باشد.
-- پیش از اصلاح، close_shift فقط ورودی نقد را می‌دید و کسری ۲ میلیونی
-- می‌ساخت که به حساب «مغایرت صندوق» می‌رفت — یعنی یک خروج وجه، دو بار.

PERFORM sales.close_shift(v_shift2, 0, v_user);

PERFORM pg_temp.assert_eq('(C3) مغایرت شیفت پس از بازپرداخت نقدی',
  (SELECT variance FROM sales.cash_shift WHERE id = v_shift2), 0);
PERFORM pg_temp.assert_eq('(C3) نقد مورد انتظار',
  (SELECT expected_cash FROM sales.cash_shift WHERE id = v_shift2), 0);

SELECT count(*) INTO v_n FROM ledger.journal_entry
 WHERE kind = 'shift_variance' AND ref_id = v_shift2;
PERFORM pg_temp.assert_eq('(C3) سند مغایرت ساخته نشد', v_n, 0);

PERFORM pg_temp.assert_eq('(C3) خالص گردش صندوق در دفتر کل',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1101'), 0);

PERFORM pg_temp.assert_eq('(C3) بازپرداخت به‌صورت پرداخت خزانه ثبت شد',
  (SELECT coalesce(sum(amount),0) FROM treasury.payment
    WHERE return_id = v_ret AND direction = 'out'), 2000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ C4. سطر سند تأییدشده تغییرناپذیر است ═══';
-- پیش از اصلاح فقط journal_entry محافظت داشت. سطرها آزاد بودند و
-- Constraint توازن هم اگر هر دو طرف با هم عوض می‌شدند چیزی نمی‌گفت.

SELECT id INTO v_entry FROM ledger.journal_entry
 WHERE kind = 'sale_shift' AND status = 'confirmed' ORDER BY created_at LIMIT 1;

PERFORM pg_temp.assert_raises('(C4) دو برابر کردن متوازن سطرهای سند',
  format('UPDATE ledger.journal_line SET debit = debit * 2, credit = credit * 2
           WHERE entry_id = %L', v_entry));
PERFORM pg_temp.assert_raises('(C4) حذف سطر سند تأییدشده',
  format('DELETE FROM ledger.journal_line WHERE entry_id = %L', v_entry));
PERFORM pg_temp.assert_raises('(C4) حذف خود سند تأییدشده',
  format('DELETE FROM ledger.journal_entry WHERE id = %L', v_entry));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ C5. لاگ حسابرسی واقعاً نوشته می‌شود ═══';
-- پیش از اصلاح، جدول audit_log و trigger زنجیره هش وجود داشتند ولی
-- هیچ تابعی در آن چیزی نمی‌نوشت.

PERFORM pg_temp.assert_eq('(C5) لاگ رسید خرید',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'purchase.post'), 1);
PERFORM pg_temp.assert_eq('(C5) لاگ نهایی‌کردن فاکتور',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'invoice.finalize'), 2);
PERFORM pg_temp.assert_eq('(C5) لاگ مرجوعی',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'return.post'), 1);
PERFORM pg_temp.assert_eq('(C5) لاگ بستن شیفت',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'shift.close'), 2);
PERFORM pg_temp.assert_eq('(C5) لاگ بستن دوره ثبت',
  (SELECT count(*) FROM platform.audit_log WHERE action = 'batch.post'), 3);

-- زنجیره هش باید پیوسته باشد: prev_hash هر ردیف = hash ردیف قبلی
SELECT count(*) INTO v_n FROM (
  SELECT prev_hash, lag(hash) OVER (ORDER BY id) AS expected_prev
    FROM platform.audit_log) x
 WHERE prev_hash IS DISTINCT FROM expected_prev;
PERFORM pg_temp.assert_eq('(C5) گسست در زنجیره هش حسابرسی', v_n, 0);

PERFORM pg_temp.assert_eq('(C5) کاربر عامل روی لاگ ثبت شده',
  (SELECT count(*) FROM platform.audit_log WHERE actor_id IS NULL), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ H1. پرداخت نامشخص پول واقعی نیست ═══';
-- تراکنش کارت‌خوانی که نتیجه‌اش معلوم نیست نباید حساب «وجوه در راه
-- کارت‌خوان» را بدهکار کند و نباید فاکتور را پرداخت‌شده نشان دهد.

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-23 09:00+03:30') RETURNING id INTO v_shift3;

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id,
                           channel, occurred_at, created_by)
VALUES (BR, WH, v_shift3, v_cust, 'pos', '2026-06-23 10:00+03:30', v_user)
RETURNING id INTO v_inv_unknown;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv_unknown, 1, v_var, 1, 2000000, 2000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, ref_no, status)
VALUES (v_inv_unknown, v_shift3, 'card', 2000000, 'UNK-1', 'unknown');

PERFORM sales.finalize_invoice(v_inv_unknown, v_user);

PERFORM pg_temp.assert_eq('(H1) مبلغ پرداخت‌شده فاکتور',
  (SELECT paid_amount FROM sales.invoice WHERE id = v_inv_unknown), 0);

PERFORM sales.close_shift(v_shift3, 0, v_user);

PERFORM pg_temp.assert_eq('(H1) وجوه در راه کارت‌خوان — نباید بدهکار شود',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1103'), 0);
PERFORM pg_temp.assert_eq('(H1) حساب پرداخت نامشخص',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1106'), 2000000);
PERFORM pg_temp.assert_eq('(H1) طلب کاذب از مشتری ایجاد نشد',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1201'), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ H5. فاکتور روی شیفت بسته نهایی نمی‌شود ═══';
-- پیش از اصلاح این کار مجاز بود و درآمد آن فاکتور برای همیشه از
-- دفتر می‌افتاد، چون سند شیفت قبلاً زده شده بود.

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id,
                           channel, occurred_at, created_by)
VALUES (BR, WH, v_shift3, v_cust, 'pos', '2026-06-23 23:00+03:30', v_user)
RETURNING id INTO v_inv_late;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv_late, 1, v_var, 1, 2000000, 2000000);

PERFORM pg_temp.assert_raises('(H5) نهایی‌کردن روی شیفت بسته',
  format('SELECT sales.finalize_invoice(%L, %L)', v_inv_late, v_user));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ H6. یک مؤلفه، فقط یک قاعده ثبت فعال ═══';
-- post_entry قاعده را با LIMIT 1 و بدون ORDER BY می‌خواند. اگر دو
-- قاعده فعال با سمت متفاوت وجود داشته باشد، سند تصادفی برعکس می‌شود.

PERFORM pg_temp.assert_raises('(H6) قاعده ثبت متعارض برای یک مؤلفه',
  $q$INSERT INTO ledger.posting_rule (event_type, leg, side, account_code, description)
     VALUES ('sale_shift','cash','credit','1101','قاعده متعارض')$q$);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';

SELECT coalesce(sum(debit),0) - coalesce(sum(credit),0) INTO v_val
  FROM ledger.journal_line;
PERFORM pg_temp.assert_eq('جمع بدهکار − جمع بستانکار', v_val, 0);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

SELECT count(*) INTO v_n FROM ledger.journal_line l
  JOIN ledger.account a ON a.code = l.account_code WHERE NOT a.is_postable;
PERFORM pg_temp.assert_eq('سطر سند روی حساب غیرقابل ثبت', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف Projection با حرکت‌ها', v_n, 0);

PERFORM pg_temp.assert_eq('ارزش موجودی: دفتر کل = انبار',
  (SELECT coalesce(sum(debit - credit),0) FROM ledger.journal_line
    WHERE account_code = '1301'),
  (SELECT coalesce(sum(total_value),0) FROM inventory.stock_balance));

SELECT count(*) INTO v_n FROM sales.unposted_revenue;
PERFORM pg_temp.assert_eq('درآمد ثبت‌نشده در پایان تست', v_n, 0);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تمام تست‌های رگرسیون پاس شدند         ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
