-- =====================================================================
-- تست تغییرناپذیری رسید ثبت‌شده و انبارِ همان شعبه (مهاجرت ۱۲۴)
-- =====================================================================
-- بازآزمایی ردیف ۲۹ دفتر امنیتی. ثابت این پرونده: پیشرفت یک سفارش خرید
-- فقط با **ثبت** یک رسیدِ همان شعبه جلو می‌رود — نه با دست‌بردن در رسیدی که
-- قبلاً ثبت شده، و نه با رسیدی که کالایش به انبار شعبهٔ دیگری رفته.
--
-- ⚠️ بند ۱ **کنترل مثبت** است: پیش‌نویس آزادانه ویرایش می‌شود، ثبت می‌شود،
--    و برگشت از خرید همچنان `returned_qty` سطر ثبت‌شده را جلو می‌برد. بی این،
--    نگهبانی که همه‌چیز را رد کند هم بندهای بعدی را سبز می‌کرد و خرید را می‌شکست.
-- ⚠️ بند ۲ اثر را از **نمای پیشرفت سفارش** می‌خواند، نه فقط از «خطا داد».
-- ⚠️ هر ردّ، پیام خودش را دارد (`assert_raises` الگو می‌گیرد): خطایی که به
--    دلیل دیگری بیفتد، قاعده را ثابت نمی‌کند.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text, p_like text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE p_like THEN
      RAISE EXCEPTION E'\n  ✗ %\n      انتظار خطا مثل: %\n      واقعی : %', p_label, p_like, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 80);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  WH_BACK uuid := '00000000-0000-7000-8000-000000000102';
  v_user uuid; v_br2 uuid; v_wh2 uuid; v_sup uuid; v_prod uuid; v_var uuid;
  o1 uuid; ol1 uuid; o2 uuid; ol2 uuid;
  r1 uuid; rl1 uuid; rc1 uuid; r3 uuid; rl3 uuid; v_ret uuid; v_draft uuid; v_draft_line uuid;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('rcpt_immut', 'انباردار آزمون') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user, 'admin', NULL);
PERFORM platform.set_actor(v_user);

INSERT INTO platform.branch (code, name) VALUES ('RI-B2', 'شعبهٔ دوم آزمون رسید') RETURNING id INTO v_br2;
INSERT INTO inventory.warehouse (branch_id, code, name, kind)
VALUES (v_br2, 'RI-B2-W', 'انبار شعبهٔ دوم', 'store') RETURNING id INTO v_wh2;
INSERT INTO purchasing.supplier (code, name) VALUES ('S-RI', 'تأمین‌کنندهٔ آزمون') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-RI', 'کالای آزمون رسید') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, sku) VALUES (v_prod, 'RI-1') RETURNING id INTO v_var;

INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id) VALUES (BR, v_sup, WH) RETURNING id INTO o1;
INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price) VALUES (o1, v_var, 5, 1000) RETURNING id INTO ol1;
INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id) VALUES (BR, v_sup, WH) RETURNING id INTO o2;
INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price) VALUES (o2, v_var, 5, 1000) RETURNING id INTO ol2;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. کنترل مثبت: پیش‌نویس ویرایش می‌شود، ثبت می‌شود، برگشت می‌خورد ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, order_id, occurred_at)
VALUES (BR, v_sup, WH, o1, now()) RETURNING id INTO r1;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount, order_line_id)
VALUES (r1, v_var, 1, 1000, 1000, ol1) RETURNING id INTO rl1;
INSERT INTO purchasing.receipt_charge (receipt_id, charge_type, amount) VALUES (r1, 'freight', 100) RETURNING id INTO rc1;

-- پیش‌نویس: سطر، هزینه و سربرگ آزادانه عوض می‌شوند.
UPDATE purchasing.receipt_line SET qty = 2, line_amount = 2000 WHERE id = rl1;
UPDATE purchasing.receipt_charge SET amount = 200 WHERE id = rc1;
UPDATE purchasing.receipt SET note = 'اصلاح پیش‌نویس', warehouse_id = WH_BACK WHERE id = r1;
PERFORM pg_temp.assert_eq('پیش‌نویس ویرایش شد',
  (SELECT l.qty::int::text || ' ' || c.amount::text || ' ' || (r.warehouse_id = WH_BACK)::text
     FROM purchasing.receipt r, purchasing.receipt_line l, purchasing.receipt_charge c
    WHERE r.id = r1 AND l.id = rl1 AND c.id = rc1), '2 200 true');

PERFORM purchasing.post_receipt(r1, v_user);
PERFORM pg_temp.assert_eq('رسید ثبت شد و پیشرفت سفارش جلو رفت',
  (SELECT r.status || ' ' || p.received_qty::int::text
     FROM purchasing.receipt r, purchasing.order_progress p
    WHERE r.id = r1 AND p.order_line_id = ol1), 'posted 2');

-- برگشت از خرید همچنان `returned_qty` سطر ثبت‌شده را جلو می‌برد.
INSERT INTO purchasing.purchase_return (branch_id, receipt_id, warehouse_id, reason_code, occurred_at)
VALUES (BR, r1, WH_BACK, 'quality', now()) RETURNING id INTO v_ret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty) VALUES (v_ret, rl1, 1);
PERFORM purchasing.post_purchase_return(v_ret, v_user);
PERFORM pg_temp.assert_eq('برگشت از خرید «برگشتی» سطر ثبت‌شده را جلو برد',
  (SELECT returned_qty::int::text FROM purchasing.receipt_line WHERE id = rl1), '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. رسید ثبت‌شده: نه سربرگ، نه سطر، نه هزینه ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('تغییر یادداشت سربرگ',
  format('UPDATE purchasing.receipt SET note = %L WHERE id = %L', 'دست‌کاری', r1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('برگرداندن به پیش‌نویس',
  format('UPDATE purchasing.receipt SET status = %L WHERE id = %L', 'draft', r1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('حذف رسید',
  format('DELETE FROM purchasing.receipt WHERE id = %L', r1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('تغییر تعداد سطر',
  format('UPDATE purchasing.receipt_line SET qty = 50 WHERE id = %L', rl1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('تغییر تعداد همراه برگشتی',
  format('UPDATE purchasing.receipt_line SET qty = 50, returned_qty = 0 WHERE id = %L', rl1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('برداشتن اتصال سطر به سفارش',
  format('UPDATE purchasing.receipt_line SET order_line_id = NULL WHERE id = %L', rl1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('افزودن سطر سفارش‌دار',
  format('INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount, order_line_id)
          VALUES (%L, %L, 3, 1000, 3000, %L)', r1, v_var, ol1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('حذف سطر',
  format('DELETE FROM purchasing.receipt_line WHERE id = %L', rl1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('تغییر هزینه',
  format('UPDATE purchasing.receipt_charge SET amount = 1 WHERE id = %L', rc1), '%رسید ثبت‌شده تغییر نمی‌کند%');
PERFORM pg_temp.assert_raises('افزودن هزینه',
  format('INSERT INTO purchasing.receipt_charge (receipt_id, charge_type, amount) VALUES (%L, %L, 5)', r1, 'freight'),
  '%رسید ثبت‌شده تغییر نمی‌کند%');

-- رسید ثبت‌شدهٔ بی‌سفارش بعداً به سفارشی وصل نمی‌شود (پیشرفت بی حرکت انبار).
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, now()) RETURNING id INTO r3;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (r3, v_var, 4, 1000, 4000) RETURNING id INTO rl3;
PERFORM purchasing.post_receipt(r3, v_user);
PERFORM pg_temp.assert_raises('وصل‌کردن رسید ثبت‌شده به سفارش',
  format('UPDATE purchasing.receipt SET order_id = %L WHERE id = %L', o2, r3), '%رسید ثبت‌شده تغییر نمی‌کند%');
-- سطر یک پیش‌نویس هم به زیر رسید ثبت‌شده نمی‌رود.
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, now()) RETURNING id INTO v_draft;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_draft, v_var, 1, 1000, 1000) RETURNING id INTO v_draft_line;
PERFORM pg_temp.assert_raises('بردن سطر پیش‌نویس به زیر رسید ثبت‌شده',
  format('UPDATE purchasing.receipt_line SET receipt_id = %L WHERE id = %L', r3, v_draft_line),
  '%رسید ثبت‌شده تغییر نمی‌کند%');

PERFORM pg_temp.assert_eq('پیشرفت دو سفارش دست‌نخورده ماند',
  (SELECT string_agg(received_qty::int::text, ' ' ORDER BY (order_line_id = ol1) DESC)
     FROM purchasing.order_progress WHERE order_line_id IN (ol1, ol2)), '1 0');
PERFORM pg_temp.assert_eq('و انبار با حرکت‌ها می‌خواند',
  (SELECT count(*)::text FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. انبار از همان شعبهٔ سند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('رسید این شعبه با انبار شعبهٔ دیگر، وصل به سفارش این شعبه',
  format('INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, order_id, occurred_at)
          VALUES (%L, %L, %L, %L, now())', BR, v_sup, v_wh2, o2), '%انبار این سند از شعبهٔ دیگری است%');
PERFORM pg_temp.assert_raises('رسید بی‌سفارش با انبار شعبهٔ دیگر',
  format('INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
          VALUES (%L, %L, %L, now())', BR, v_sup, v_wh2), '%انبار این سند از شعبهٔ دیگری است%');
PERFORM pg_temp.assert_raises('سفارش خرید با انبار شعبهٔ دیگر',
  format('INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id)
          VALUES (%L, %L, %L)', BR, v_sup, v_wh2), '%انبار این سند از شعبهٔ دیگری است%');
PERFORM pg_temp.assert_raises('بردن انبار سفارش به شعبهٔ دیگر',
  format('UPDATE purchasing.purchase_order SET warehouse_id = %L WHERE id = %L', v_wh2, o2),
  '%انبار این سند از شعبهٔ دیگری است%');

-- پیش‌نویسی که پیش از ۱۲۴ با انبار شعبهٔ دیگر نشسته بود، در ثبت می‌ایستد.
ALTER TABLE purchasing.receipt DISABLE TRIGGER receipt_warehouse_in_branch_t;
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, v_wh2, now()) RETURNING id INTO r3;
ALTER TABLE purchasing.receipt ENABLE TRIGGER receipt_warehouse_in_branch_t;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (r3, v_var, 1, 1000, 1000);
PERFORM pg_temp.assert_raises('پیش‌نویس قدیمی با انبار شعبهٔ دیگر ثبت نمی‌شود',
  format('SELECT purchasing.post_receipt(%L::uuid, %L::uuid)', r3, v_user), '%انبار این سند از شعبهٔ دیگری است%');
PERFORM pg_temp.assert_eq('و کالایی به انبار شعبهٔ دیگر نرفت',
  (SELECT count(*)::text FROM inventory.stock_movement WHERE warehouse_id = v_wh2), '0');

-- کنترل منفی: انبار پشتیبان **همان** شعبه مجاز است (تصمیم ۰۸۹).
INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id) VALUES (BR, v_sup, WH_BACK);
PERFORM pg_temp.assert_eq('سفارش با انبار پشتیبان همان شعبه ساخته شد',
  (SELECT count(*)::text FROM purchasing.purchase_order WHERE branch_id = BR AND warehouse_id = WH_BACK), '1');

RAISE NOTICE E'\n✔ رسید ثبت‌شده — کنترل مثبت، سربرگ و سطر و هزینه، اتصال دیرهنگام، انبار همان شعبه';
END $test$;

ROLLBACK;
