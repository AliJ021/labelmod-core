-- =====================================================================
-- تست برگشت از خرید
-- =====================================================================
-- ادعای مرکزی:
--
--   **کالا با بهای همان رسید خارج می‌شود، نه میانگین جاری انبار.**
--
-- در روش «آخرین قیمت خرید»، هر خرید بعدی کل موجودی را تجدید ارزیابی
-- می‌کند. اگر برگشت به میانگین جاری خارج شود، کالایی که به نرخ ۱۰۰
-- آمده بود به نرخ ۱۲۰ برمی‌گردد و ۲۰ واحد ارزش از هوا کم می‌شود.
--
-- و ادعای دوم که به‌همان اندازه مهم است:
--
--   **بهای فاکتور و ارزش دفتری یکی نیستند.**
--
-- بدهی تأمین‌کننده به اندازه بهای فاکتور کم می‌شود؛ موجودی به اندازه
-- ارزش دفتری (بهای فاکتور + سهم حمل). تفاوتشان هزینه حملِ کالای
-- پس‌فرستاده است — یک زیان واقعی که سرفصل خودش را می‌خواهد.
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

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 78);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_rcpt2 uuid; v_line uuid; v_line2 uuid;
  v_ret uuid; v_entry uuid; v_no text; v_n numeric;
BEGIN

RAISE NOTICE E'\n═══ آماده‌سازی ═══';

INSERT INTO identity.app_user (username, full_name) VALUES ('preturn','تست برگشت از خرید')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- روش «آخرین قیمت خرید» صریح انتخاب می‌شود — دقیقاً همان روشی که
-- ادعای مرکزی را معنادار می‌کند: خرید دوم، موجودی اول را تجدید
-- ارزیابی می‌کند.
PERFORM platform.set_setting('costing.method', '"last_purchase"'::jsonb,
  'تست: برگشت از خرید', v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-PRET','تأمین‌کننده برگشت')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-PRET','کالای تست برگشت')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'PRET-1','2000000000015','مشکی','L') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'PRET-2','2000000000022','سفید','M') RETURNING id INTO v_var2;

-- رسید یک: ۱۰ عدد به نرخ ۱٬۰۰۰٬۰۰۰ + حمل ۲٬۰۰۰٬۰۰۰ به نسبت مبلغ
--   → سهم حمل هر واحد ۲۰۰٬۰۰۰، بهای دفتری هر واحد ۱٬۲۰۰٬۰۰۰
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-01') RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 1000000, 10000000) RETURNING id INTO v_line;
INSERT INTO purchasing.receipt_charge (receipt_id, charge_type, amount, allocation, paid_from, payee_type)
VALUES (v_rcpt, 'حمل', 2000000, 'by_value', 'payable', 'other');
PERFORM purchasing.post_receipt(v_rcpt, v_user);

PERFORM pg_temp.assert_eq('بهای دفتری هر واحد پس از حمل',
  (SELECT landed_unit_cost FROM purchasing.receipt_line WHERE id = v_line), 1200000);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. خرید دوم، موجودی اول را تجدید ارزیابی می‌کند ═══';
-- ═════════════════════════════════════════════════════════════════
-- این همان تله است: پس از این خرید، میانگین جاری دیگر ۱٬۲۰۰٬۰۰۰
-- نیست. اگر برگشت به میانگین جاری خارج شود، عدد غلط می‌دهد.

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-05') RETURNING id INTO v_rcpt2;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt2, v_var, 5, 2000000, 10000000) RETURNING id INTO v_line2;
PERFORM purchasing.post_receipt(v_rcpt2, v_user);

PERFORM pg_temp.assert_eq('موجودی پس از دو رسید',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WH), 15);
-- «آخرین قیمت خرید»: کل موجودی به نرخ ۲٬۰۰۰٬۰۰۰ ارزیابی شده.
PERFORM pg_temp.assert_eq('میانگین جاری پس از تجدید ارزیابی',
  (SELECT round(total_value / on_hand) FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WH), 2000000);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. برگشت با بهای همان رسید ═══';
-- ═════════════════════════════════════════════════════════════════
-- دو عدد از رسید **اول** برمی‌گردد:
--   بهای فاکتور  = ۲ × ۱٬۰۰۰٬۰۰۰ = ۲٬۰۰۰٬۰۰۰
--   ارزش دفتری   = ۲ × ۱٬۲۰۰٬۰۰۰ = ۲٬۴۰۰٬۰۰۰
--   حملِ برنگشتنی = ۴۰۰٬۰۰۰
--
-- اگر به میانگین جاری خارج می‌شد، ۴٬۰۰۰٬۰۰۰ ارزش کم می‌شد — یعنی
-- ۱٬۶۰۰٬۰۰۰ بیشتر از آنچه این کالا واقعاً ارزیده بود.

INSERT INTO purchasing.purchase_return
  (branch_id, receipt_id, warehouse_id, reason_code, occurred_at)
VALUES (BR, v_rcpt, WH, 'quality', '2026-06-06') RETURNING id INTO v_ret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
VALUES (v_ret, v_line, 2);

PERFORM pg_temp.assert_eq('برگه تازه شماره ندارد',
  (SELECT count(*) FROM purchasing.purchase_return WHERE id = v_ret AND number IS NULL), 1);

SELECT purchasing.post_purchase_return(v_ret, v_user) INTO v_entry;

SELECT number INTO v_no FROM purchasing.purchase_return WHERE id = v_ret;
PERFORM pg_temp.assert_txt('شماره در لحظه ثبت آمد', left(v_no, 8), 'PR-1405-');

PERFORM pg_temp.assert_eq('بهای فاکتور برگشتی',
  (SELECT goods_amount FROM purchasing.purchase_return WHERE id = v_ret), 2000000);
PERFORM pg_temp.assert_eq('ارزش دفتری برگشتی — از بهای همان رسید',
  (SELECT cost_amount FROM purchasing.purchase_return WHERE id = v_ret), 2400000);
PERFORM pg_temp.assert_eq('حملِ برنگشتنی',
  (SELECT charge_loss FROM purchasing.purchase_return WHERE id = v_ret), 400000);

PERFORM pg_temp.assert_eq('نرخ Snapshot سطر برگشت',
  (SELECT unit_cost FROM purchasing.purchase_return_line WHERE return_id = v_ret), 1200000);

PERFORM pg_temp.assert_eq('موجودی پس از برگشت',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WH), 13);

-- ادعای اصلی، به زبان ارزش: ۳۰٬۰۰۰٬۰۰۰ منهای ۲٬۴۰۰٬۰۰۰
PERFORM pg_temp.assert_eq('ارزش موجودی = ارزش قبلی − ارزش دفتری برگشتی',
  (SELECT total_value FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WH), 27600000);

PERFORM pg_temp.assert_eq('برگشتی روی سطر رسید ثبت شد',
  (SELECT returned_qty FROM purchasing.receipt_line WHERE id = v_line), 2);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. سند ═══';
-- ═════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('بدهکار تأمین‌کننده (۲۱۰۱) = بهای فاکتور',
  (SELECT coalesce(sum(debit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '2101'), 2000000);
PERFORM pg_temp.assert_eq('بستانکار موجودی (۱۳۰۱) = ارزش دفتری',
  (SELECT coalesce(sum(credit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '1301'), 2400000);
PERFORM pg_temp.assert_eq('بدهکار تعدیل بها (۵۱۰۲) = حملِ برنگشتنی',
  (SELECT coalesce(sum(debit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '5102'), 400000);
PERFORM pg_temp.assert_eq('سند متوازن',
  (SELECT coalesce(sum(debit)-sum(credit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry), 0);

-- سطر بدهی باید شناسه تأمین‌کننده داشته باشد، وگرنه گردش حساب اشخاص
-- از دفتر ساختنی نیست.
PERFORM pg_temp.assert_eq('سطر بدهی، شناسه تأمین‌کننده دارد',
  (SELECT count(*) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '2101'
      AND party_type = 'supplier' AND party_id = v_sup), 1);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. مرزها ═══';
-- ═════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('ثبت دوباره رد می‌شود',
  format('SELECT purchasing.post_purchase_return(%L::uuid, %L::uuid)', v_ret, v_user));

-- بیشتر از باقی‌مانده برنمی‌گردد: ۱۰ رسید شده، ۲ برگشته، ۹ درخواست.
INSERT INTO purchasing.purchase_return
  (branch_id, receipt_id, warehouse_id, reason_code)
VALUES (BR, v_rcpt, WH, 'quality') RETURNING id INTO v_ret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
VALUES (v_ret, v_line, 9);
PERFORM pg_temp.assert_raises('بیشتر از رسیدشده برنمی‌گردد',
  format('SELECT purchasing.post_purchase_return(%L::uuid, %L::uuid)', v_ret, v_user));
PERFORM pg_temp.assert_eq('برگه ردشده شماره نگرفت',
  (SELECT count(*) FROM purchasing.purchase_return WHERE id = v_ret AND number IS NULL), 1);

-- برگه بدون قلم
INSERT INTO purchasing.purchase_return
  (branch_id, receipt_id, warehouse_id, reason_code)
VALUES (BR, v_rcpt, WH, 'quality') RETURNING id INTO v_ret;
PERFORM pg_temp.assert_raises('برگه بدون قلم ثبت نمی‌شود',
  format('SELECT purchasing.post_purchase_return(%L::uuid, %L::uuid)', v_ret, v_user));

-- رسید ثبت‌نشده: چیزی نیامده که برگردد
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-07') RETURNING id INTO v_rcpt2;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt2, v_var2, 3, 500000, 1500000) RETURNING id INTO v_line2;
INSERT INTO purchasing.purchase_return
  (branch_id, receipt_id, warehouse_id, reason_code)
VALUES (BR, v_rcpt2, WH, 'quality') RETURNING id INTO v_ret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
VALUES (v_ret, v_line2, 1);
PERFORM pg_temp.assert_raises('رسید ثبت‌نشده برگشت ندارد',
  format('SELECT purchasing.post_purchase_return(%L::uuid, %L::uuid)', v_ret, v_user));

-- دو سطر برای یک سطر رسید
PERFORM pg_temp.assert_raises('دو سطر برای یک سطر رسید رد می‌شود',
  format($q$INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
            VALUES (%L::uuid, %L::uuid, 1)$q$, v_ret, v_line2));

-- تعداد صفر یا منفی
PERFORM pg_temp.assert_raises('تعداد صفر رد می‌شود',
  format($q$INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
            VALUES (%L::uuid, %L::uuid, 0)$q$, v_ret, v_line));

-- کالایی که فروخته شده، پس فرستادنی نیست: موجودی منفی نمی‌شود.
INSERT INTO purchasing.purchase_return
  (branch_id, receipt_id, warehouse_id, reason_code)
VALUES (BR, v_rcpt, WH, 'quality') RETURNING id INTO v_ret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
VALUES (v_ret, v_line, 8);
PERFORM inventory.apply_movement(v_var, WH, -12, 'sale', NULL, NULL, v_user);
PERFORM pg_temp.assert_raises('موجودی منفی نمی‌شود',
  format('SELECT purchasing.post_purchase_return(%L::uuid, %L::uuid)', v_ret, v_user));

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('هیچ موجودی منفی',
  (SELECT count(*) FROM inventory.stock_balance WHERE on_hand < 0), 0);
PERFORM pg_temp.assert_eq('Projection با حرکت‌ها می‌خواند',
  (SELECT count(*) FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0), 0);
PERFORM pg_temp.assert_eq('هیچ سند نامتوازن',
  (SELECT count(*) FROM (SELECT entry_id FROM ledger.journal_line
                          GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x), 0);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تست برگشت از خرید پاس شد              ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
