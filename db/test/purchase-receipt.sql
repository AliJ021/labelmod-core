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
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
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
INSERT INTO catalog.variation (product_id, sku, barcode, color, size)
VALUES (v_prod, 'PR-2', '2000000000022', 'سفید', 'M')
  RETURNING id INTO v_var2;

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

-- ── هزینه‌ای که به بهای کالا نمی‌رود ────────────────────────────────
-- رگرسیون مهاجرت ۰۲۶. تا پیش از آن، هزینه با تخصیص «none» تمامش روی
-- **آخرین سطر** می‌نشست: گزینه‌ای که می‌گفت «به بها نرو»، همه‌اش را
-- روی یک قلم دلخواه می‌گذاشت. سند متوازن می‌ماند و هیچ تستی قرمز
-- نمی‌شد — فقط بهای تمام‌شده آن قلم بی‌دلیل بالا می‌رفت.
RAISE NOTICE E'\n═══ هزینه با تخصیص «بدون تخصیص» ═══';

-- عدد این بخش به روش قیمت تمام‌شده وابسته است، پس خودش انتخابش
-- می‌کند: با «آخرین قیمت خرید»، یک سطر تجدید ارزیابی هم به حساب
-- ۱۳۰۱ می‌خورد و ادعای زیر را مبهم می‌کند.
PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb,
  'تست: جداکردن هزینه دوره از بهای کالا');

INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-14') RETURNING id INTO v_b;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_b, v_var, 4, 1000000, 4000000),
       (v_b, v_var2, 4, 1000000, 4000000);

-- دو هزینه: یکی وارد بها می‌شود، یکی نه.
INSERT INTO purchasing.receipt_charge
  (receipt_id, charge_type, amount, allocation, paid_from, payee_type)
VALUES (v_b, 'حمل', 800000, 'by_value', 'payable', 'other');
INSERT INTO purchasing.receipt_charge
  (receipt_id, charge_type, amount, allocation, paid_from, payee_type, expense_account_code)
VALUES (v_b, 'بسته‌بندی', 500000, 'none', 'payable', 'other', '6103');

SELECT purchasing.post_receipt(v_b, v_user) INTO v_entry;

-- هر سطر فقط سهم خودش از هزینه ۸۰۰٬۰۰۰ را می‌گیرد — نه یک ریال بیشتر.
SELECT sum(charge_alloc) INTO v_n FROM purchasing.receipt_line WHERE receipt_id = v_b;
PERFORM pg_temp.assert_eq('تخصیص کل = فقط هزینه واردشونده به بها', v_n, 800000);

SELECT max(charge_alloc) INTO v_n FROM purchasing.receipt_line WHERE receipt_id = v_b;
PERFORM pg_temp.assert_eq('هیچ سطری هزینه «بدون تخصیص» را نگرفت', v_n, 400000);

-- سطر سند: بسته‌بندی به حسابِ خودش، نه به موجودی کالا.
SELECT coalesce(sum(debit), 0) INTO v_n FROM ledger.journal_line
 WHERE entry_id = v_entry AND account_code = '6103';
PERFORM pg_temp.assert_eq('هزینه دوره روی حساب ۶۱۰۳', v_n, 500000);

SELECT coalesce(sum(debit), 0) INTO v_n FROM ledger.journal_line
 WHERE entry_id = v_entry AND account_code = '1301';
PERFORM pg_temp.assert_eq('موجودی کالا = کالا + هزینه واردشونده', v_n, 8800000);

SELECT coalesce(sum(debit) - sum(credit), 0) INTO v_n FROM ledger.journal_line
 WHERE entry_id = v_entry;
PERFORM pg_temp.assert_eq('سند همچنان متوازن است', v_n, 0);

-- حساب هزینه روی هزینه‌ای که به بها می‌رود بی‌معناست و رد می‌شود.
PERFORM pg_temp.assert_raises(
  'حساب هزینه روی تخصیص by_value رد می‌شود',
  format($q$INSERT INTO purchasing.receipt_charge
             (receipt_id, charge_type, amount, allocation, expense_account_code)
           VALUES (%L::uuid, 'حمل', 1, 'by_value', '6103')$q$, v_b));

-- کلاینت قابل اعتماد نیست: کد صندوق، بانک یا هر حساب غیرهزینه نباید
-- از مسیر مستقیم درج هم به مؤلفهٔ expensed_charge راه پیدا کند.
PERFORM pg_temp.assert_raises(
  'حساب دارایی به‌عنوان سرفصل هزینه رد می‌شود',
  format($q$INSERT INTO purchasing.receipt_charge
             (receipt_id, charge_type, amount, allocation, expense_account_code)
           VALUES (%L::uuid, 'بسته‌بندی', 1, 'none', '1101')$q$, v_b));

-- حساب پرداخت شعبه دیگر حتی با نوشتن مستقیم SQL پذیرفته نمی‌شود.
INSERT INTO platform.branch (id, code, name)
VALUES ('00000000-0000-7000-8000-000000000099', 'OTHER-PR', 'شعبه دیگر');
INSERT INTO treasury.account
  (id, code, name, kind, branch_id, ledger_account_code)
VALUES
  ('00000000-0000-7000-8000-000000000299', 'BANK-OTHER-PR', 'بانک شعبه دیگر',
   'bank', '00000000-0000-7000-8000-000000000099', '1102');
INSERT INTO purchasing.receipt (branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (BR, v_sup, WH, '2026-06-15') RETURNING id INTO v_c;
PERFORM pg_temp.assert_raises(
  'حساب خزانه شعبه دیگر روی رسید رد می‌شود',
  format($q$INSERT INTO purchasing.receipt_charge
             (receipt_id, charge_type, amount, allocation, paid_from,
              payee_type, paid_account_id)
           VALUES (%L::uuid, 'حمل', 1, 'by_value', 'treasury', 'other',
                   '00000000-0000-7000-8000-000000000299'::uuid)$q$, v_c));

UPDATE treasury.account SET branch_id = BR
 WHERE id = '00000000-0000-7000-8000-000000000299';
INSERT INTO purchasing.receipt_charge
  (receipt_id, charge_type, amount, allocation, paid_from, payee_type, paid_account_id)
VALUES (v_c, 'حمل', 1, 'by_value', 'treasury', 'other',
        '00000000-0000-7000-8000-000000000299');
PERFORM pg_temp.assert_raises('شعبه حساب استفاده‌شده ثابت می‌ماند',
  $q$UPDATE treasury.account SET branch_id = '00000000-0000-7000-8000-000000000099'
      WHERE id = '00000000-0000-7000-8000-000000000299'$q$);
PERFORM pg_temp.assert_raises('شعبه رسید دارای هزینه ثابت می‌ماند',
  format($q$UPDATE purchasing.receipt SET branch_id = '00000000-0000-7000-8000-000000000099'
       WHERE id = %L::uuid$q$, v_c));

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تست رسید خرید پاس شد                  ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
