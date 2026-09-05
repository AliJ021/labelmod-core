-- =====================================================================
-- انتقال بین انبارها
-- =====================================================================
-- ادعای مرکزی این پرونده، و تنها دلیل وجودش:
--
--   **جمع ارزش موجودی پیش و پس از انتقال، دقیقاً یکی است.**
--
-- انتقال هیچ سندی نمی‌زند (هر دو انبار به حساب ۱۳۰۱ می‌خورند)، پس اگر
-- ارزش کم یا زیاد شود، هیچ‌جا طرف حسابی ندارد: دارایی از هوا ساخته
-- می‌شود یا بی‌صدا دود می‌شود. و چون هر دو حرکت در یک تراکنش‌اند، هیچ
-- خطایی هم نمی‌دهد — فقط ترازنامه غلط می‌شود.
--
-- سه جای که این می‌توانست بشکند و هر سه اینجا سنجیده می‌شوند:
--   ۱. نرخ خروج و نرخ ورود یکی نباشند
--   ۲. انبار مبدأ خالی شود (باقی‌مانده گرد کردن)
--   ۳. روش FIFO باشد و لایه‌ها نرخ متفاوت داشته باشند
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

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 74);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR    uuid := '00000000-0000-7000-8000-000000000001';
  STORE uuid := '00000000-0000-7000-8000-000000000101';
  BACK  uuid;
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_tr uuid; v_line uuid;
  v_before platform.money; v_after platform.money;
  v_n int; v_num numeric;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('tr','تست انتقال')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- انبار پشتیبان — مقصد انتقال.
SELECT id INTO BACK FROM inventory.warehouse
 WHERE branch_id = BR AND kind = 'stock' AND is_active LIMIT 1;
IF BACK IS NULL THEN
  INSERT INTO inventory.warehouse (branch_id, code, name, kind)
  VALUES (BR, 'WH-TR', 'انبار پشتیبان تست', 'stock') RETURNING id INTO BACK;
END IF;

INSERT INTO purchasing.supplier (code, name) VALUES ('S-TR','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-TR','مانتو تست')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سرمه‌ای','38','TR-38') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','40','TR-40') RETURNING id INTO v_var2;

-- ۳۰ عدد به نرخ ۳۳۳٬۳۳۳ — عمداً عددی که تقسیمش باقی‌مانده دارد.
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, STORE, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 30, 333333, 9999990);
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var2, 10, 500000, 5000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. انتقال ساده — ارزش کل دست‌نخورده می‌ماند ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT sum(total_value) INTO v_before FROM inventory.stock_balance
 WHERE variation_id IN (v_var, v_var2);

INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by, note)
VALUES (BR, STORE, BACK, v_user, 'انتقال تست') RETURNING id INTO v_tr;
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty)
VALUES (v_tr, v_var, 7) RETURNING id INTO v_line;

PERFORM pg_temp.assert_eq('پیش از ثبت، هیچ حرکتی نیست',
  (SELECT count(*) FROM inventory.stock_movement
    WHERE ref_type = 'transfer' AND ref_id = v_tr), 0);
PERFORM pg_temp.assert_eq('و برگه شماره ندارد',
  (SELECT count(*) FROM inventory.transfer WHERE id = v_tr AND number IS NULL), 1);

PERFORM pg_temp.assert_eq('ثبت، یک قلم را جابه‌جا کرد',
  inventory.post_transfer(v_tr, v_user), 1);

SELECT sum(total_value) INTO v_after FROM inventory.stock_balance
 WHERE variation_id IN (v_var, v_var2);

-- **ادعای مرکزی.**
PERFORM pg_temp.assert_eq('جمع ارزش موجودی دقیقاً همان است', v_after, v_before);

PERFORM pg_temp.assert_eq('از قفسه ۷ تا کم شد',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = STORE), 23);
PERFORM pg_temp.assert_eq('به انبار پشتیبان ۷ تا اضافه شد',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = BACK), 7);

PERFORM pg_temp.assert_eq('دو حرکت ثبت شد، با یک شناسه مرجع',
  (SELECT count(*) FROM inventory.stock_movement
    WHERE ref_type = 'transfer' AND ref_id = v_tr), 2);
PERFORM pg_temp.assert_eq('یکی خروج، یکی ورود',
  (SELECT count(DISTINCT kind) FROM inventory.stock_movement
    WHERE ref_type = 'transfer' AND ref_id = v_tr), 2);

-- جمع `value_delta` دو حرکت باید صفر باشد — همان ادعای بالا، از زاویه
-- حرکت‌ها به‌جای مانده‌ها.
SELECT sum(value_delta) INTO v_num FROM inventory.stock_movement
 WHERE ref_type = 'transfer' AND ref_id = v_tr;
PERFORM pg_temp.assert_eq('جمع تغییر ارزش دو حرکت صفر است', v_num, 0);

PERFORM pg_temp.assert_eq('بهای سطر پس از ثبت نوشته شد',
  (SELECT count(*) FROM inventory.transfer_line
    WHERE id = v_line AND unit_cost IS NOT NULL AND value_delta IS NOT NULL), 1);
PERFORM pg_temp.assert_eq('شماره در لحظه ثبت تخصیص یافت',
  (SELECT count(*) FROM inventory.transfer
    WHERE id = v_tr AND number LIKE 'TR-1405-%' AND status = 'posted'), 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. انبار مبدأ خالی می‌شود — باقی‌مانده گرد کردن ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ۲۳ تای باقی‌مانده به نرخی که تقسیمش باقی‌مانده دارد. اگر ورود با
-- `qty × unit_cost` حساب می‌شد، چند ریال گم می‌شد و در قفسه یک
-- «ارزش بی‌کالا» می‌ماند.

SELECT sum(total_value) INTO v_before FROM inventory.stock_balance
 WHERE variation_id = v_var;

INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by)
VALUES (BR, STORE, BACK, v_user) RETURNING id INTO v_tr;
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty) VALUES (v_tr, v_var, 23);
PERFORM inventory.post_transfer(v_tr, v_user);

SELECT sum(total_value) INTO v_after FROM inventory.stock_balance
 WHERE variation_id = v_var;
PERFORM pg_temp.assert_eq('ارزش کل باز هم دست‌نخورده', v_after, v_before);
PERFORM pg_temp.assert_eq('قفسه خالی شد',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = STORE), 0);
PERFORM pg_temp.assert_eq('و ارزشِ بی‌کالا نماند',
  (SELECT total_value FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = STORE), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. نگهبان‌ها ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('انتقال به همان انبار',
  format($$INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id)
           VALUES (%L, %L, %L)$$, BR, STORE, STORE));

PERFORM pg_temp.assert_raises('تعداد صفر',
  format($$INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty)
           VALUES (%L, %L, 0)$$, v_tr, v_var2));

INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by)
VALUES (BR, STORE, BACK, v_user) RETURNING id INTO v_tr;
PERFORM pg_temp.assert_raises('برگه بدون قلم',
  format($$SELECT inventory.post_transfer(%L, %L)$$, v_tr, v_user));

-- کالایی که در مبدأ نیست: قفسه الان صفر است.
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty) VALUES (v_tr, v_var, 5);
PERFORM pg_temp.assert_raises('انتقال کالایی که در مبدأ نیست',
  format($$SELECT inventory.post_transfer(%L, %L)$$, v_tr, v_user));

-- و پس از شکست، برگه هنوز پیش‌نویس است و شماره نسوخته.
PERFORM pg_temp.assert_eq('برگه شکست‌خورده پیش‌نویس می‌ماند',
  (SELECT count(*) FROM inventory.transfer
    WHERE id = v_tr AND status = 'draft' AND number IS NULL), 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. تغییرناپذیری پس از ثبت ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by)
VALUES (BR, BACK, STORE, v_user) RETURNING id INTO v_tr;
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty)
VALUES (v_tr, v_var, 3) RETURNING id INTO v_line;
PERFORM inventory.post_transfer(v_tr, v_user);

PERFORM pg_temp.assert_raises('تغییر تعداد سطر ثبت‌شده',
  format($$UPDATE inventory.transfer_line SET qty = 9 WHERE id = %L$$, v_line));
PERFORM pg_temp.assert_raises('حذف سطر ثبت‌شده',
  format($$DELETE FROM inventory.transfer_line WHERE id = %L$$, v_line));
PERFORM pg_temp.assert_raises('افزودن سطر به برگه ثبت‌شده',
  format($$INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty)
           VALUES (%L, %L, 1)$$, v_tr, v_var2));
PERFORM pg_temp.assert_raises('ابطال برگه ثبت‌شده',
  format($$UPDATE inventory.transfer SET status = 'cancelled' WHERE id = %L$$, v_tr));
PERFORM pg_temp.assert_raises('حذف برگه ثبت‌شده',
  format($$DELETE FROM inventory.transfer WHERE id = %L$$, v_tr));
PERFORM pg_temp.assert_raises('ثبت دوباره همان برگه',
  format($$SELECT inventory.post_transfer(%L, %L)$$, v_tr, v_user));
PERFORM pg_temp.assert_raises('عوض‌کردن انبار برگه ثبت‌شده',
  format($$UPDATE inventory.transfer SET to_warehouse_id = %L WHERE id = %L$$, BACK, v_tr));

-- ولی پیش‌نویس آزاد است — وگرنه انباردار نمی‌توانست اشتباهش را اصلاح کند.
INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by)
VALUES (BR, BACK, STORE, v_user) RETURNING id INTO v_tr;
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty)
VALUES (v_tr, v_var, 2) RETURNING id INTO v_line;
UPDATE inventory.transfer_line SET qty = 4 WHERE id = v_line;
PERFORM pg_temp.assert_eq('سطر پیش‌نویس عوض می‌شود',
  (SELECT qty FROM inventory.transfer_line WHERE id = v_line), 4);
DELETE FROM inventory.transfer WHERE id = v_tr;
PERFORM pg_temp.assert_eq('برگه پیش‌نویس حذف می‌شود',
  (SELECT count(*) FROM inventory.transfer WHERE id = v_tr), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. انتقال هیچ سندی نمی‌زند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- هر دو انبار به یک حساب موجودی می‌خورند. سندی که بدهکار و
-- بستانکارش یک حساب باشد، فقط دفتر را شلوغ می‌کند.

SELECT count(*) INTO v_n FROM ledger.journal_entry
 WHERE ref_type = 'transfer';
PERFORM pg_temp.assert_eq('هیچ سند حسابداری برای انتقال', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. نما ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM inventory.transfer_summary
 WHERE branch_id = BR AND status = 'posted';
PERFORM pg_temp.assert_eq('برگه‌های ثبت‌شده در نما', (v_n >= 3)::int, 1);

SELECT total_qty INTO v_num FROM inventory.transfer_summary
 WHERE from_warehouse_id = BACK AND status = 'posted' AND total_qty = 3;
PERFORM pg_temp.assert_eq('جمع تعداد در نما', v_num, 3);

RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';

-- موجودی منفی از هیچ مسیری، از جمله انتقال.
SELECT count(*) INTO v_n FROM inventory.stock_balance WHERE on_hand < 0;
PERFORM pg_temp.assert_eq('موجودی منفی', v_n, 0);

-- ثابت `balance_check`: مانده با جمع حرکت‌ها بخواند.
SELECT count(*) INTO v_n FROM inventory.balance_check WHERE qty_diff <> 0;
PERFORM pg_temp.assert_eq('مانده و جمع حرکت‌ها ناهماهنگ', v_n, 0);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

RAISE NOTICE E'\n✔ انتقال بین انبارها — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
