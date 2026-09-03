-- =====================================================================
-- تست انبارگردانی
-- =====================================================================
-- ادعای مرکزی — و تنها دلیلی که این فایل وجود دارد:
--
--   **فروشی که وسط شمارش اتفاق می‌افتد، کسری کاذب نمی‌سازد.**
--
-- انبارگردانی ساعت‌ها طول می‌کشد و فروشگاه باز است. اگر عدد سیستم را
-- هنگام تایپ سطر Snapshot بگیریم، آن فروش دو بار کم می‌شود: یک بار
-- خودش، یک بار تعدیلی که آن را کسری می‌بیند. نتیجه هم کسری کاذب است
-- هم موجودیِ غلط روی قفسه.
--
-- به‌علاوه چهار مرز:
--   • کالای شمرده‌نشده صفر نمی‌شود
--   • اضافه و کسری در یک سند، با علامت درست
--   • خنثی‌شدن کامل → هیچ سندی ساخته نمی‌شود
--   • برگه ثبت‌شده دوباره ثبت نمی‌شود
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
  v_user uuid; v_sup uuid; v_prod uuid;
  v_a uuid; v_b uuid; v_c uuid; v_untouched uuid;
  v_rcpt uuid; v_count uuid; v_entry uuid;
  v_n numeric; v_no text;
BEGIN

RAISE NOTICE E'\n═══ آماده‌سازی ═══';

INSERT INTO identity.app_user (username, full_name) VALUES ('counter','تست انبارگردانی')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- روش قیمت تمام‌شده صریح انتخاب می‌شود: عددهای این فایل به آن
-- وابسته‌اند و تکیه به پیش‌فرض یعنی یک UPDATE در تنظیمات، تست را
-- قرمز کند.
PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb,
  'تست: انبارگردانی', v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-CNT','تأمین‌کننده شمارش')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-CNT','کالای تست شمارش')
  RETURNING id INTO v_prod;

INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'CNT-A','2000000000015','مشکی','L') RETURNING id INTO v_a;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'CNT-B','2000000000022','سفید','M') RETURNING id INTO v_b;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'CNT-C','2000000000039','آبی','S') RETURNING id INTO v_c;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'CNT-D','2000000000046','سبز','XL') RETURNING id INTO v_untouched;

-- ورود اولیه: هرکدام ۱۰ عدد به نرخ ۱٬۰۰۰٬۰۰۰
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-01') RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_a, 10, 1000000, 10000000),
       (v_rcpt, v_b, 10, 1000000, 10000000),
       (v_rcpt, v_c, 10, 1000000, 10000000),
       (v_rcpt, v_untouched, 10, 1000000, 10000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. فروش وسط شمارش، کسری کاذب نمی‌سازد ═══';
-- ═════════════════════════════════════════════════════════════════
-- سناریو: انباردار قفسه را می‌شمارد و ۱۰ عدد می‌بیند. سطر را وارد
-- می‌کند. **بعد** یک عدد فروخته می‌شود. برگه ساعتی بعد ثبت می‌شود.
--
-- عدد درست: کسری صفر — چون شمارش ۱۰ بود و آن یک عدد **پس از** شمارش
-- رفته. ولی موجودی نهایی باید ۹ بماند، نه ۱۰: فروش واقعی است.
--
-- اگر system_qty هنگام ورود سطر Snapshot می‌شد، تعدیل «۱۰ − ۱۰ = ۰»
-- را می‌دید و موجودی روی ۹ می‌ماند — که درست است. مشکل حالت برعکس
-- است و همین را می‌سنجیم: با خواندن **در لحظه ثبت**، تفاوت ۱۰ − ۹ =
-- ۱ می‌شود و انبارگردانی یک عدد **برمی‌گرداند**، چون شمارنده گفته
-- ۱۰ تا روی قفسه بوده.
--
-- کدام درست است؟ عدد شمارنده، در لحظه ثبت. برگه انبارگردانی می‌گوید
-- «الان روی قفسه ۱۰ تاست»؛ اگر بین شمارش و ثبت چیزی فروخته شده،
-- انباردار باید برگه را دوباره بشمارد یا ثبت را جلو بیندازد. آنچه
-- سیستم **نباید** بکند، خواندن یک عدد کهنه است.

INSERT INTO inventory.stock_count (branch_id, warehouse_id) VALUES (BR, WH)
  RETURNING id INTO v_count;
INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
VALUES (v_count, v_a, 10);

PERFORM pg_temp.assert_eq('برگه تازه شماره ندارد',
  (SELECT count(*) FROM inventory.stock_count WHERE id = v_count AND number IS NULL), 1);
PERFORM pg_temp.assert_eq('system_qty تا ثبت خالی است',
  (SELECT count(*) FROM inventory.stock_count_line
    WHERE count_id = v_count AND system_qty IS NULL), 1);

-- فروش یک عدد، پس از ورود سطر شمارش
PERFORM inventory.apply_movement(v_a, WH, -1, 'sale', NULL, NULL, v_user);
PERFORM pg_temp.assert_eq('موجودی پس از فروش',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_a AND warehouse_id = WH), 9);

SELECT inventory.post_stock_count(v_count, v_user) INTO v_entry;

PERFORM pg_temp.assert_eq('موجودی سیستم در لحظه ثبت خوانده شد (۹، نه ۱۰)',
  (SELECT system_qty FROM inventory.stock_count_line
    WHERE count_id = v_count AND variation_id = v_a), 9);
PERFORM pg_temp.assert_eq('تفاوت = شمارش − موجودیِ لحظه ثبت',
  (SELECT diff_qty FROM inventory.stock_count_line
    WHERE count_id = v_count AND variation_id = v_a), 1);
PERFORM pg_temp.assert_eq('موجودی به عدد شمارنده رسید',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_a AND warehouse_id = WH), 10);

SELECT number INTO v_no FROM inventory.stock_count WHERE id = v_count;
PERFORM pg_temp.assert_txt('شماره در لحظه ثبت آمد', left(v_no, 7), 'C-1405-');

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. کالای شمرده‌نشده دست نمی‌خورد ═══';
-- ═════════════════════════════════════════════════════════════════
-- انبارگردانی جزئی — یک قفسه، یک برند — کار عادی است. اگر نبودِ سطر
-- «صفر» تعبیر شود، اولین شمارش جزئی کل انبار را پاک می‌کند.

PERFORM pg_temp.assert_eq('کالای خارج از برگه دست‌نخورده ماند',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_untouched AND warehouse_id = WH), 10);
PERFORM pg_temp.assert_eq('هیچ حرکتی برای کالای شمرده‌نشده ثبت نشد',
  (SELECT count(*) FROM inventory.stock_movement
    WHERE variation_id = v_untouched AND kind = 'count_adjust'), 0);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. کسری و اضافه در یک برگه ═══';
-- ═════════════════════════════════════════════════════════════════
-- B کسری دو عدد، C اضافه یک عدد. خالص = کسری یک عدد = ۱٬۰۰۰٬۰۰۰
-- کسریِ ارزش.

INSERT INTO inventory.stock_count (branch_id, warehouse_id) VALUES (BR, WH)
  RETURNING id INTO v_count;
INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
VALUES (v_count, v_b, 8),    -- ۱۰ بود، ۸ شمرده شد → کسری ۲
       (v_count, v_c, 11);   -- ۱۰ بود، ۱۱ شمرده شد → اضافه ۱

SELECT inventory.post_stock_count(v_count, v_user) INTO v_entry;

PERFORM pg_temp.assert_eq('کسری B',
  (SELECT diff_qty FROM inventory.stock_count_line
    WHERE count_id = v_count AND variation_id = v_b), -2);
PERFORM pg_temp.assert_eq('اضافه C',
  (SELECT diff_qty FROM inventory.stock_count_line
    WHERE count_id = v_count AND variation_id = v_c), 1);

PERFORM pg_temp.assert_eq('موجودی B',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_b AND warehouse_id = WH), 8);
PERFORM pg_temp.assert_eq('موجودی C',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_c AND warehouse_id = WH), 11);

-- اضافه به نرخ **همان کالا** ارزیابی می‌شود، نه یک عدد دلخواه:
-- کالایی که در شمارش پیدا می‌شود همان کالاست، نه خریدی تازه.
PERFORM pg_temp.assert_eq('نرخ اضافه = میانگین جاری همان کالا',
  (SELECT unit_cost FROM inventory.stock_count_line
    WHERE count_id = v_count AND variation_id = v_c), 1000000);

-- سند: کسری خالص ۱٬۰۰۰٬۰۰۰ → بدهکار ۵۱۰۳، بستانکار ۱۳۰۱
PERFORM pg_temp.assert_eq('بدهکار کسری انبار (۵۱۰۳)',
  (SELECT coalesce(sum(debit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '5103'), 1000000);
PERFORM pg_temp.assert_eq('بستانکار موجودی کالا (۱۳۰۱)',
  (SELECT coalesce(sum(credit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '1301'), 1000000);
PERFORM pg_temp.assert_eq('سند متوازن',
  (SELECT coalesce(sum(debit)-sum(credit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry), 0);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. اضافه خالص → سند برعکس می‌شود ═══';
-- ═════════════════════════════════════════════════════════════════
-- اضافه یک رویداد تازه نیست؛ همان سند کسری با مبلغ منفی است و
-- post_entry هر دو سطر را برعکس می‌کند.

INSERT INTO inventory.stock_count (branch_id, warehouse_id) VALUES (BR, WH)
  RETURNING id INTO v_count;
INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
VALUES (v_count, v_b, 10);   -- ۸ بود، ۱۰ شمرده شد → اضافه ۲

SELECT inventory.post_stock_count(v_count, v_user) INTO v_entry;

PERFORM pg_temp.assert_eq('بستانکار ۵۱۰۳ (اضافه، نه کسری)',
  (SELECT coalesce(sum(credit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '5103'), 2000000);
PERFORM pg_temp.assert_eq('بدهکار موجودی کالا',
  (SELECT coalesce(sum(debit),0) FROM ledger.journal_line
    WHERE entry_id = v_entry AND account_code = '1301'), 2000000);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. خنثی‌شدن کامل، سند نمی‌سازد ═══';
-- ═════════════════════════════════════════════════════════════════
-- کسری یک کالا و اضافه کالای دیگر با همان ارزش: موجودیِ هر کالا عوض
-- می‌شود ولی ارزش کل نه. سند نداشتن اینجا درست است، نه یک شکاف.

INSERT INTO inventory.stock_count (branch_id, warehouse_id) VALUES (BR, WH)
  RETURNING id INTO v_count;
INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
VALUES (v_count, v_b, 9),    -- ۱۰ → ۹، کسری ۱
       (v_count, v_c, 12);   -- ۱۱ → ۱۲، اضافه ۱

SELECT inventory.post_stock_count(v_count, v_user) INTO v_entry;

PERFORM pg_temp.assert_eq('سندی ساخته نشد', (v_entry IS NULL)::int, 1);
PERFORM pg_temp.assert_eq('ولی حرکت انبار ثبت شد',
  (SELECT count(*) FROM inventory.stock_movement
    WHERE ref_type = 'stock_count' AND ref_id = v_count), 2);
PERFORM pg_temp.assert_eq('برگه ثبت شد',
  (SELECT count(*) FROM inventory.stock_count
    WHERE id = v_count AND status = 'posted'), 1);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. مرزها ═══';
-- ═════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('ثبت دوباره رد می‌شود',
  format('SELECT inventory.post_stock_count(%L::uuid, %L::uuid)', v_count, v_user));

INSERT INTO inventory.stock_count (branch_id, warehouse_id) VALUES (BR, WH)
  RETURNING id INTO v_count;
PERFORM pg_temp.assert_raises('برگه بدون سطر ثبت نمی‌شود',
  format('SELECT inventory.post_stock_count(%L::uuid, %L::uuid)', v_count, v_user));
PERFORM pg_temp.assert_eq('برگه ردشده شماره نگرفت',
  (SELECT count(*) FROM inventory.stock_count WHERE id = v_count AND number IS NULL), 1);

PERFORM pg_temp.assert_raises('دو سطر برای یک کالا رد می‌شود',
  format($q$INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
            VALUES (%L::uuid, %L::uuid, 1), (%L::uuid, %L::uuid, 2)$q$,
         v_count, v_b, v_count, v_b));

PERFORM pg_temp.assert_raises('شمارش منفی رد می‌شود',
  format($q$INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
            VALUES (%L::uuid, %L::uuid, -1)$q$, v_count, v_b));

-- شمارش صفر یک شمارش است: «گشتیم و نبود» با «نشمردیم» یکی نیست.
INSERT INTO inventory.stock_count (branch_id, warehouse_id) VALUES (BR, WH)
  RETURNING id INTO v_count;
INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
VALUES (v_count, v_a, 0);
PERFORM inventory.post_stock_count(v_count, v_user);
PERFORM pg_temp.assert_eq('شمارش صفر، موجودی را صفر می‌کند',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_a AND warehouse_id = WH), 0);
-- خالی‌شدن انبار باید ارزش را **دقیقاً** صفر کند، نه یک ریال کمتر.
PERFORM pg_temp.assert_eq('ارزش هم دقیقاً صفر شد',
  (SELECT total_value FROM inventory.stock_balance
    WHERE variation_id = v_a AND warehouse_id = WH), 0);

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
RAISE NOTICE   '║   تست انبارگردانی پاس شد                ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
