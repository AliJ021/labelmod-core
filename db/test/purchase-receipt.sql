-- =====================================================================
-- تست شماره‌گذاری و ثبت رسید خرید
-- =====================================================================
-- ادعای مرکزی: **پیش‌نویس رهاشده شماره نمی‌سوزاند.**
--
-- تا مهاجرت ۰۲۵، `number` اجباری بود و هر پیش‌نویس در لحظه ساخته‌شدن
-- یک شماره می‌گرفت. با یک صفحه واقعی، انبارداری که فرم را باز و رها
-- می‌کند یک شماره را برای همیشه می‌سوزاند — و شماره غایب در دفتر خرید
-- سؤالی است که کسی نمی‌تواند جوابش را بدهد.
--
-- به‌علاوه سه مرزی که بی‌آن‌ها این تغییر خطرناک است:
--   • دو پیش‌نویس بی‌شماره کنار هم می‌نشینند (NULL روی UNIQUE)
--   • شماره‌ها پشت‌سرهم‌اند، بدون پرش، به همان ترتیب **ثبت**
--   • رسید ثبت‌شده شماره‌اش را نگه می‌دارد و دوباره ثبت نمی‌شود
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
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid;
  v_a uuid; v_b uuid; v_c uuid;
  v_no_a text; v_no_b text; v_no_c text;
  v_counter_before bigint; v_counter_after bigint;
  v_entry uuid; v_n int;
BEGIN

RAISE NOTICE E'\n═══ آماده‌سازی ═══';

INSERT INTO identity.app_user (username, full_name) VALUES ('purch','تست رسید خرید')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-PR','تأمین‌کننده تست')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-PR','کالای تست رسید')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod, 'PR-1', '2000000000015', 'مشکی', 'L')
  RETURNING id INTO v_var;

SELECT last_no INTO v_counter_before
  FROM platform.document_counter
 WHERE branch_id = BR AND doc_type = 'purchase' AND fiscal_year = 1405;

-- ── سه پیش‌نویس بی‌شماره ────────────────────────────────────────────
RAISE NOTICE E'\n═══ سه پیش‌نویس، هیچ‌کدام شماره نمی‌گیرند ═══';

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-10') RETURNING id INTO v_a;
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-11') RETURNING id INTO v_b;
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-12') RETURNING id INTO v_c;

SELECT count(*) INTO v_n FROM purchasing.receipt
 WHERE id IN (v_a, v_b, v_c) AND number IS NULL;
PERFORM pg_temp.assert_eq('پیش‌نویس بدون شماره', v_n, 3);

SELECT last_no INTO v_counter_after
  FROM platform.document_counter
 WHERE branch_id = BR AND doc_type = 'purchase' AND fiscal_year = 1405;
PERFORM pg_temp.assert_eq('شمارنده دست‌نخورده مانده',
                          v_counter_after - v_counter_before, 0);

INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_a, v_var, 5, 1000000, 5000000),
       (v_b, v_var, 3, 1000000, 3000000),
       (v_c, v_var, 2, 1000000, 2000000);

-- ── ثبت به ترتیب معکوسِ ساخت ────────────────────────────────────────
-- شماره باید ترتیب **ثبت** را بگیرد، نه ترتیب ساخت پیش‌نویس. یعنی
-- پیش‌نویسی که هفته پیش باز شده و امروز ثبت می‌شود، شماره امروز را
-- می‌گیرد — همان چیزی که در دفتر خرید معنا دارد.
RAISE NOTICE E'\n═══ ثبت به ترتیب c، a، b ═══';

PERFORM purchasing.post_receipt(v_c, v_user);
PERFORM purchasing.post_receipt(v_a, v_user);
PERFORM purchasing.post_receipt(v_b, v_user);

SELECT number INTO v_no_a FROM purchasing.receipt WHERE id = v_a;
SELECT number INTO v_no_b FROM purchasing.receipt WHERE id = v_b;
SELECT number INTO v_no_c FROM purchasing.receipt WHERE id = v_c;

PERFORM pg_temp.assert_txt('اولین ثبت‌شده',  v_no_c, 'P-1405-' || lpad((v_counter_before+1)::text, 6, '0'));
PERFORM pg_temp.assert_txt('دومین ثبت‌شده',  v_no_a, 'P-1405-' || lpad((v_counter_before+2)::text, 6, '0'));
PERFORM pg_temp.assert_txt('سومین ثبت‌شده',  v_no_b, 'P-1405-' || lpad((v_counter_before+3)::text, 6, '0'));

-- پرش نداشتن، صریح: سه ثبت، دقیقاً سه پله روی شمارنده.
SELECT last_no INTO v_counter_after
  FROM platform.document_counter
 WHERE branch_id = BR AND doc_type = 'purchase' AND fiscal_year = 1405;
PERFORM pg_temp.assert_eq('شمارنده دقیقاً ۳ پله رفت',
                          v_counter_after - v_counter_before, 3);

-- ── رسید ثبت‌شده تغییر نمی‌کند ──────────────────────────────────────
RAISE NOTICE E'\n═══ ثبت دوباره ═══';

PERFORM pg_temp.assert_raises(
  'ثبت دوباره رد می‌شود',
  format('SELECT purchasing.post_receipt(%L::uuid, %L::uuid)', v_a, v_user));

SELECT number INTO v_no_a FROM purchasing.receipt WHERE id = v_a;
PERFORM pg_temp.assert_txt('شماره پس از تلاش دوم عوض نشد',
                           v_no_a, 'P-1405-' || lpad((v_counter_before+2)::text, 6, '0'));

-- ── شماره دستی محترم است ────────────────────────────────────────────
-- مهاجرت داده از سیستم قبلی شماره‌های خودش را می‌آورد. اگر تابع آن‌ها
-- را بازنویسی کند، ارجاع‌های کاغذی می‌شکنند.
RAISE NOTICE E'\n═══ شماره دستی ═══';

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES ('P-OLD-77', BR, v_sup, WH, '2026-06-13') RETURNING id INTO v_a;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_a, v_var, 1, 1000000, 1000000);
PERFORM purchasing.post_receipt(v_a, v_user);

SELECT number INTO v_no_a FROM purchasing.receipt WHERE id = v_a;
PERFORM pg_temp.assert_txt('شماره دستی دست‌نخورده ماند', v_no_a, 'P-OLD-77');

SELECT last_no INTO v_counter_after
  FROM platform.document_counter
 WHERE branch_id = BR AND doc_type = 'purchase' AND fiscal_year = 1405;
PERFORM pg_temp.assert_eq('شمارنده برای شماره دستی مصرف نشد',
                          v_counter_after - v_counter_before, 3);

-- ── سند و انبار ─────────────────────────────────────────────────────
RAISE NOTICE E'\n═══ اثر مالی ═══';

SELECT count(*) INTO v_n FROM ledger.journal_entry
 WHERE ref_type = 'purchase_receipt' AND description LIKE 'رسید خرید P-1405-%';
PERFORM pg_temp.assert_eq('هر رسید شماره‌گرفته یک سند دارد', v_n, 3);

-- شرح سند نباید «رسید خرید » با دنباله خالی شده باشد: تخصیص شماره پیش
-- از ساخت سند اتفاق می‌افتد، نه بعدش. اگر ترتیب برعکس شود، شرحِ سندِ
-- خرید بی‌شماره می‌ماند و پیگیری‌اش از دفتر ناممکن.
SELECT count(*) INTO v_n FROM ledger.journal_entry
 WHERE ref_type = 'purchase_receipt' AND description = 'رسید خرید ';
PERFORM pg_temp.assert_eq('هیچ سند خریدی بدون شماره در شرح نیست', v_n, 0);

SELECT count(*) INTO v_n FROM ledger.journal_entry
 WHERE ref_type = 'purchase_receipt' AND description = 'رسید خرید P-OLD-77';
PERFORM pg_temp.assert_eq('سند رسید با شماره دستی', v_n, 1);

SELECT on_hand INTO v_n FROM inventory.stock_balance
 WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی = ۵+۳+۲+۱', v_n, 11);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تست رسید خرید پاس شد                  ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
