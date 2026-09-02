-- =====================================================================
-- تست سفارش خرید
-- =====================================================================
-- ادعای مرکزی، و تنها دلیل وجود این فایل:
--
--   **سفارش خرید هیچ اثر مالی و انباری ندارد.**
--
-- خطای رایجی است که سیستم سفارش را در دفتر بنشاند و ترازنامه‌ای
-- بسازد که کالای نرسیده را دارایی می‌بیند. اینجا صریح ادعا می‌شود:
-- نه سندی، نه حرکتی، نه بدهی‌ای — تا وقتی کالا نیامده.
--
-- و سه مرز:
--   • «چقدرش رسیده» از خودِ رسیدها می‌آید و برگشتی را کم می‌کند
--   • سطر رسید به سفارش **دیگری** نمی‌چسبد
--   • بستن سفارشِ نیمه‌رسیده دلیل می‌خواهد
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
  v_ord uuid; v_ord2 uuid; v_ol uuid; v_ol2 uuid; v_ol_other uuid;
  v_rcpt uuid; v_rl uuid; v_ret uuid;
  v_no text; v_entries_before int; v_moves_before int;
BEGIN

RAISE NOTICE E'\n═══ آماده‌سازی ═══';

INSERT INTO identity.app_user (username, full_name) VALUES ('porder','تست سفارش خرید')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-PO','تأمین‌کننده سفارش')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-PO','کالای تست سفارش')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'PO-1','2000000000015','مشکی','L') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod,'PO-2','2000000000022','سفید','M') RETURNING id INTO v_var2;

SELECT count(*) INTO v_entries_before FROM ledger.journal_entry;
SELECT count(*) INTO v_moves_before   FROM inventory.stock_movement;

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. سفارش هیچ اثر مالی و انباری ندارد ═══';
-- ═════════════════════════════════════════════════════════════════

INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id, expected_at)
VALUES (BR, v_sup, WH, '2026-07-01') RETURNING id INTO v_ord;
INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price)
VALUES (v_ord, v_var, 10, 1000000) RETURNING id INTO v_ol;
INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price)
VALUES (v_ord, v_var2, 5, 2000000) RETURNING id INTO v_ol2;

PERFORM pg_temp.assert_eq('پیش‌نویس سفارش شماره ندارد',
  (SELECT count(*) FROM purchasing.purchase_order WHERE id = v_ord AND number IS NULL), 1);

SELECT purchasing.send_purchase_order(v_ord, v_user) INTO v_no;
PERFORM pg_temp.assert_txt('شماره در لحظه فرستادن آمد', left(v_no, 8), 'PO-1405-');
PERFORM pg_temp.assert_eq('وضعیت: فرستاده‌شده',
  (SELECT count(*) FROM purchasing.purchase_order WHERE id = v_ord AND status = 'sent'), 1);

-- ادعای مرکزی. تعهد، نه رویداد مالی.
PERFORM pg_temp.assert_eq('هیچ سند حسابداری ساخته نشد',
  (SELECT count(*) FROM ledger.journal_entry) - v_entries_before, 0);
PERFORM pg_temp.assert_eq('هیچ حرکت انباری ساخته نشد',
  (SELECT count(*) FROM inventory.stock_movement) - v_moves_before, 0);
PERFORM pg_temp.assert_eq('هیچ بدهی به تأمین‌کننده ثبت نشد',
  (SELECT count(*) FROM ledger.journal_line
    WHERE party_type = 'supplier' AND party_id = v_sup), 0);

-- ولی در لاگ حسابرسی هست: تعهد هم یک واقعیت است.
PERFORM pg_temp.assert_eq('فرستادن سفارش در لاگ حسابرسی',
  (SELECT count(*) FROM platform.audit_log
    WHERE action = 'purchase.order_sent' AND entity_id = v_ord::text), 1);

PERFORM pg_temp.assert_eq('پیشرفت اولیه: هیچ‌چیز نرسیده',
  (SELECT sum(received_qty) FROM purchasing.order_progress WHERE order_id = v_ord), 0);
PERFORM pg_temp.assert_eq('باقی‌مانده = کل سفارش',
  (SELECT sum(remaining_qty) FROM purchasing.order_progress WHERE order_id = v_ord), 15);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. رسید جزئی، پیشرفت را جلو می‌برد ═══';
-- ═════════════════════════════════════════════════════════════════

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, order_id, occurred_at)
VALUES (BR, v_sup, WH, v_ord, '2026-07-05') RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line
  (receipt_id, variation_id, qty, unit_price, line_amount, order_line_id)
VALUES (v_rcpt, v_var, 6, 1000000, 6000000, v_ol) RETURNING id INTO v_rl;

-- رسید **ثبت‌نشده** پیشرفت نمی‌سازد: کالا هنوز نیامده.
PERFORM pg_temp.assert_eq('رسید ثبت‌نشده پیشرفتی نمی‌سازد',
  (SELECT received_qty FROM purchasing.order_progress WHERE order_line_id = v_ol), 0);

PERFORM purchasing.post_receipt(v_rcpt, v_user);

PERFORM pg_temp.assert_eq('رسیده',
  (SELECT received_qty FROM purchasing.order_progress WHERE order_line_id = v_ol), 6);
PERFORM pg_temp.assert_eq('باقی‌مانده همان سطر',
  (SELECT remaining_qty FROM purchasing.order_progress WHERE order_line_id = v_ol), 4);
PERFORM pg_temp.assert_eq('سطر دیگر دست‌نخورده',
  (SELECT received_qty FROM purchasing.order_progress WHERE order_line_id = v_ol2), 0);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. برگشت از خرید، پیشرفت را عقب می‌برد ═══';
-- ═════════════════════════════════════════════════════════════════
-- کالایی که آمده و پس رفته، سفارش را برآورده نکرده. اگر پیشرفت از
-- «جمع رسیدها» خوانده می‌شد و نه «رسیده منهای برگشتی»، سفارشی که
-- کالایش پس رفته «کامل» می‌ماند و کسی دنبال بقیه‌اش نمی‌رفت.

INSERT INTO purchasing.purchase_return (branch_id, receipt_id, warehouse_id, reason_code)
VALUES (BR, v_rcpt, WH, 'quality') RETURNING id INTO v_ret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
VALUES (v_ret, v_rl, 2);
PERFORM purchasing.post_purchase_return(v_ret, v_user);

PERFORM pg_temp.assert_eq('رسیده پس از برگشت',
  (SELECT received_qty FROM purchasing.order_progress WHERE order_line_id = v_ol), 4);
PERFORM pg_temp.assert_eq('باقی‌مانده پس از برگشت',
  (SELECT remaining_qty FROM purchasing.order_progress WHERE order_line_id = v_ol), 6);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. بیش‌تحویل بسته نیست، ولی دیده می‌شود ═══';
-- ═════════════════════════════════════════════════════════════════
-- بستنش یعنی انباردار نتواند محموله واقعی را ثبت کند و کالای در قفسه
-- در سیستم نباشد — بدتر از خودِ بیش‌تحویل.

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, order_id, occurred_at)
VALUES (BR, v_sup, WH, v_ord, '2026-07-08') RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line
  (receipt_id, variation_id, qty, unit_price, line_amount, order_line_id)
VALUES (v_rcpt, v_var2, 8, 2000000, 16000000, v_ol2);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

PERFORM pg_temp.assert_eq('۸ آمد در برابر ۵ سفارش',
  (SELECT received_qty FROM purchasing.order_progress WHERE order_line_id = v_ol2), 8);
PERFORM pg_temp.assert_eq('باقی‌مانده منفی نمی‌شود',
  (SELECT remaining_qty FROM purchasing.order_progress WHERE order_line_id = v_ol2), 0);
PERFORM pg_temp.assert_eq('بیش‌تحویل صریح دیده می‌شود',
  (SELECT over_qty FROM purchasing.order_progress WHERE order_line_id = v_ol2), 3);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. سطر رسید به سفارش دیگری نمی‌چسبد ═══';
-- ═════════════════════════════════════════════════════════════════
-- کلید خارجی این را نمی‌گیرد: سطر واقعاً وجود دارد، فقط مال سفارش
-- دیگری است. بدون Trigger، یک شناسه اشتباه می‌توانست سفارشی را
-- «رسیده» نشان بدهد که کالایش هرگز نیامده.

INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id)
VALUES (BR, v_sup, WH) RETURNING id INTO v_ord2;
INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price)
VALUES (v_ord2, v_var, 3, 1000000) RETURNING id INTO v_ol_other;

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, order_id, occurred_at)
VALUES (BR, v_sup, WH, v_ord, '2026-07-09') RETURNING id INTO v_rcpt;

PERFORM pg_temp.assert_raises('سطر سفارش دیگر رد می‌شود',
  format($q$INSERT INTO purchasing.receipt_line
             (receipt_id, variation_id, qty, unit_price, line_amount, order_line_id)
           VALUES (%L::uuid, %L::uuid, 1, 1000, 1000, %L::uuid)$q$,
         v_rcpt, v_var, v_ol_other));

-- رسید بدون سفارش، سطر سفارش‌دار نمی‌گیرد
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-07-10') RETURNING id INTO v_rcpt;
PERFORM pg_temp.assert_raises('رسید بی‌سفارش، سطر سفارش‌دار نمی‌گیرد',
  format($q$INSERT INTO purchasing.receipt_line
             (receipt_id, variation_id, qty, unit_price, line_amount, order_line_id)
           VALUES (%L::uuid, %L::uuid, 1, 1000, 1000, %L::uuid)$q$,
         v_rcpt, v_var, v_ol));

-- ولی خرید بدون سفارش کار عادی است
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 1, 1000000, 1000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);
PERFORM pg_temp.assert_eq('خرید بدون سفارش، پیشرفت هیچ سفارشی را عوض نکرد',
  (SELECT received_qty FROM purchasing.order_progress WHERE order_line_id = v_ol), 4);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. بستن سفارش ═══';
-- ═════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بستن سفارش نیمه‌رسیده بدون دلیل',
  format('SELECT purchasing.close_purchase_order(%L::uuid, NULL, %L::uuid)', v_ord, v_user));

PERFORM purchasing.close_purchase_order(v_ord, 'تأمین‌کننده گفت بقیه‌اش نمی‌آید', v_user);
PERFORM pg_temp.assert_eq('سفارش بسته شد',
  (SELECT count(*) FROM purchasing.purchase_order WHERE id = v_ord AND status = 'closed'), 1);
PERFORM pg_temp.assert_txt('دلیل بستن ثبت شد',
  (SELECT close_reason FROM purchasing.purchase_order WHERE id = v_ord),
  'تأمین‌کننده گفت بقیه‌اش نمی‌آید');

PERFORM pg_temp.assert_raises('بستن دوباره رد می‌شود',
  format('SELECT purchasing.close_purchase_order(%L::uuid, %L, %L::uuid)', v_ord, 'باز هم', v_user));

-- پیش‌نویسِ بسته‌شده «باطل» است، نه «بسته»: هرگز فرستاده نشده.
PERFORM purchasing.close_purchase_order(v_ord2, 'منصرف شدیم', v_user);
PERFORM pg_temp.assert_eq('پیش‌نویس بسته‌شده، باطل می‌شود',
  (SELECT count(*) FROM purchasing.purchase_order WHERE id = v_ord2 AND status = 'cancelled'), 1);
PERFORM pg_temp.assert_eq('سفارش باطل شماره نگرفت',
  (SELECT count(*) FROM purchasing.purchase_order WHERE id = v_ord2 AND number IS NULL), 1);

-- ═════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. مرزهای فرستادن ═══';
-- ═════════════════════════════════════════════════════════════════

INSERT INTO purchasing.purchase_order (branch_id, supplier_id, warehouse_id)
VALUES (BR, v_sup, WH) RETURNING id INTO v_ord2;
PERFORM pg_temp.assert_raises('سفارش بدون قلم فرستادنی نیست',
  format('SELECT purchasing.send_purchase_order(%L::uuid, %L::uuid)', v_ord2, v_user));
PERFORM pg_temp.assert_eq('سفارش ردشده شماره نسوزاند',
  (SELECT count(*) FROM purchasing.purchase_order WHERE id = v_ord2 AND number IS NULL), 1);

PERFORM pg_temp.assert_raises('دو سطر برای یک کالا در یک سفارش',
  format($q$INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price)
            VALUES (%L::uuid, %L::uuid, 1, 100), (%L::uuid, %L::uuid, 2, 200)$q$,
         v_ord2, v_var, v_ord2, v_var));

PERFORM pg_temp.assert_raises('تعداد صفر در سفارش',
  format($q$INSERT INTO purchasing.purchase_order_line (order_id, variation_id, qty, unit_price)
            VALUES (%L::uuid, %L::uuid, 0, 100)$q$, v_ord2, v_var));

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
RAISE NOTICE   '║   تست سفارش خرید پاس شد                 ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
