-- =====================================================================
-- نقد در فروش اینستاگرام از صندوق — به کشوی باز همان شعبه (مهاجرت ۱۰۶)
-- =====================================================================
-- قرارداد: docs/INSTAGRAM-POS-MODE-FA.md (قاعدهٔ ۳ و ۴). فاکتور بی شیفت می‌ماند و دورهٔ
-- ثبتش (شعبه، instagram، روز) است. ردیف نقد `shift_id` کشو را می‌برد تا `close_shift` آن را
-- در همان کشو بشمارد. باقی پول نیست. کشو با نقدِ پیش‌نویس بسته نمی‌شود.
-- هر رد یک کنترل دارد: یا همان کار با شرط درست پذیرفته می‌شود، یا (بند ۶) با Trigger خاموش
-- همان کار می‌گذرد.
-- =====================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN;

CREATE FUNCTION pg_temp.eq(p_label text, p_actual anyelement, p_expected anyelement) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE FUNCTION pg_temp.rejects(p_label text, p_sql text, p_pattern text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ p_pattern THEN
      RAISE EXCEPTION E'\n  ✗ % — رد شد ولی با پیام دیگر:\n      %', p_label, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % — رد شد', p_label;
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ % — پذیرفته شد', p_label;
END $$;

CREATE TEMP TABLE f (k text PRIMARY KEY, v uuid);

DO $setup$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := (SELECT id FROM inventory.warehouse WHERE code = 'STORE');
  v_br2 uuid; v_op uuid; v_c1 uuid; v_c2 uuid; v_prod uuid; v_a uuid; v_s1 uuid; v_s2 uuid;
BEGIN
  INSERT INTO identity.app_user (username, full_name) VALUES ('igcash_op', 'اپراتور اینستاگرام') RETURNING id INTO v_op;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_op, 'instagram_operator', BR);
  INSERT INTO identity.app_user (username, full_name) VALUES ('igcash_c1', 'صندوق‌دار') RETURNING id INTO v_c1;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_c1, 'cashier', BR);
  INSERT INTO platform.branch (code, name) VALUES ('IGCASH-B2', 'شعبهٔ دوم') RETURNING id INTO v_br2;
  INSERT INTO identity.app_user (username, full_name) VALUES ('igcash_c2', 'صندوق‌دار شعبهٔ دوم') RETURNING id INTO v_c2;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_c2, 'cashier', v_br2);
  PERFORM platform.set_actor(v_c1);
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-IGCASH', 'شومیز تست') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod, 'سفید', 'S', 'IGCASH-A') RETURNING id INTO v_a;
  INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a, 'default', 1000000);
  PERFORM inventory.apply_movement(v_a, WH, 5, 'opening', p_user => v_c1, p_unit_cost => 400000);
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash) VALUES (BR, v_c1, 0) RETURNING id INTO v_s1;
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash) VALUES (v_br2, v_c2, 0) RETURNING id INTO v_s2;
  INSERT INTO f VALUES ('br', BR), ('wh', WH), ('op', v_op), ('c1', v_c1), ('a', v_a), ('s1', v_s1), ('s2', v_s2),
    ('bank', (SELECT id FROM treasury.account WHERE code = 'P2P-1'));
  IF EXISTS (SELECT 1 FROM f WHERE v IS NULL) THEN RAISE EXCEPTION '  ✗ آماده‌سازی ناقص است'; END IF;
END $setup$;

-- سبد اینستاگرامِ یک‌قلمی (۱٬۰۰۰٬۰۰۰ ریال) از مسیر صندوق.
CREATE FUNCTION pg_temp.ig_cart(p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('lmc.instagram_order', 'pos', true);
  INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by)
    VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), 'instagram', (SELECT v FROM f WHERE k='op'))
    RETURNING id INTO v_id;
  PERFORM set_config('lmc.instagram_order', '', true);
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
    VALUES (v_id, 1, (SELECT v FROM f WHERE k='a'), 1, 1000000, 1000000);
  PERFORM sales.refresh_invoice_totals(v_id);
  INSERT INTO f VALUES (p_key, v_id);
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.cash(p_inv text, p_shift text, p_amount numeric) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount) VALUES (%L, %L, 'cash', %s)$q$,
    (SELECT v FROM f WHERE k=p_inv), (SELECT v FROM f WHERE k=p_shift), p_amount)
$$;

\echo '── ۱. نقد به کشوی همان شعبه، فقط تا مانده ──'
SELECT pg_temp.ig_cart('inv');
SELECT pg_temp.rejects('کشوی شعبهٔ دیگر', pg_temp.cash('inv', 's2', 600000), 'در شعبهٔ فاکتور باز نیست');
SELECT pg_temp.rejects('نقد بیش از مانده (باقی پول ندارد)', pg_temp.cash('inv', 's1', 1000001), 'از مانده بیشتر نمی‌شود');
DO $$ BEGIN EXECUTE pg_temp.cash('inv', 's1', 600000); END $$;
SELECT pg_temp.eq('نقد با کشوی همان شعبه پذیرفته شد (کنترل)',
  (SELECT count(*) FROM treasury.payment WHERE invoice_id=(SELECT v FROM f WHERE k='inv') AND shift_id=(SELECT v FROM f WHERE k='s1')), 1::bigint);
SELECT pg_temp.rejects('نقد دوم بیش از مانده‌ی تازه (۴۰۰٬۰۰۰)', pg_temp.cash('inv', 's1', 400001), 'از مانده بیشتر نمی‌شود');
INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id)
  VALUES ((SELECT v FROM f WHERE k='inv'), 'transfer', 400000, 'C2C-CASH-1', (SELECT v FROM f WHERE k='bank'));
SELECT pg_temp.eq('فاکتور هنوز بی شیفت است', (SELECT shift_id FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')), NULL::uuid);

\echo '── ۲. کشو با نقدِ پیش‌نویس اینستاگرام بسته نمی‌شود ──'
SELECT pg_temp.rejects('بستن کشو پیش از نهایی‌سازی',
  format('SELECT * FROM sales.close_shift(%L, 600000, %L)', (SELECT v FROM f WHERE k='s1'), (SELECT v FROM f WHERE k='c1')),
  'کشو با نقدِ فاکتور نهایی‌نشده');

\echo '── ۳. نهایی‌سازی: کانال و دورهٔ ثبت اینستاگرام، پول کامل ──'
SELECT sales.finalize_invoice((SELECT v FROM f WHERE k='inv'), (SELECT v FROM f WHERE k='op'));
SELECT pg_temp.eq('نهایی، تمام‌پرداخت، بی باقی پول',
  (SELECT status || '/' || paid_amount::text || '/' || payable_amount::text || '/' || channel FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')),
  'finalized/1000000/1000000/instagram');
SELECT pg_temp.eq('هیچ ردیف خروجی (باقی پول) ساخته نشد',
  (SELECT count(*) FROM treasury.payment WHERE invoice_id=(SELECT v FROM f WHERE k='inv') AND direction='out'), 0::bigint);
SELECT pg_temp.eq('دورهٔ ثبت روزانهٔ کانال اینستاگرام، نه شیفت کشو',
  (SELECT b.kind || '/' || b.channel FROM sales.invoice i JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
    WHERE i.id=(SELECT v FROM f WHERE k='inv')), 'channel_day/instagram');

\echo '── ۴. شمارش کشو همان نقد اینستاگرام را دارد: بی مغایرت کاذب ──'
SELECT pg_temp.eq('مغایرت بستن کشو با شمارش ۶۰۰٬۰۰۰',
  (SELECT variance::numeric FROM sales.close_shift((SELECT v FROM f WHERE k='s1'), 600000, (SELECT v FROM f WHERE k='c1'))), 0::numeric);
SELECT pg_temp.eq('انتظار نقد کشو', (SELECT expected_cash::numeric FROM sales.cash_shift WHERE id=(SELECT v FROM f WHERE k='s1')), 600000::numeric);

\echo '── ۵. کشوی بسته نقد تازه نمی‌گیرد ──'
SELECT pg_temp.ig_cart('inv2');
SELECT pg_temp.rejects('نقد به کشوی بسته', pg_temp.cash('inv2', 's1', 500000), 'در شعبهٔ فاکتور باز نیست');

\echo '── ۶. کنترل منفی: بی نگهبان‌ها، کشوی بسته نقد می‌گرفت و کشو با نقدِ پیش‌نویس بسته می‌شد ──'
DO $neg$
DECLARE v_s3 uuid; v_var numeric;
BEGIN
  ALTER TABLE treasury.payment DISABLE TRIGGER instagram_payment_guard;
  EXECUTE pg_temp.cash('inv2', 's1', 1500000);
  ALTER TABLE treasury.payment ENABLE TRIGGER instagram_payment_guard;
  RAISE NOTICE '  ✓ کنترل منفی ۱: بی نگهبان پرداخت، نقدِ بیش از مانده به کشوی بسته نشست — ردهای بالا کار همین نگهبان است';

  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash)
    VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='c1'), 0) RETURNING id INTO v_s3;
  INSERT INTO f VALUES ('s3', v_s3);
  PERFORM pg_temp.ig_cart('inv3');
  EXECUTE pg_temp.cash('inv3', 's3', 300000);
  ALTER TABLE sales.cash_shift DISABLE TRIGGER cash_shift_open_draft_cash_guard;
  SELECT variance INTO v_var FROM sales.close_shift(v_s3, 300000, (SELECT v FROM f WHERE k='c1'));
  ALTER TABLE sales.cash_shift ENABLE TRIGGER cash_shift_open_draft_cash_guard;
  IF (SELECT status FROM sales.cash_shift WHERE id = v_s3) <> 'closed' THEN
    RAISE EXCEPTION '  ✗ کنترل منفی ۲: بی نگهبان هم بسته نشد؛ پس رد بند ۲ از نگهبان نبود';
  END IF;
  RAISE NOTICE '  ✓ کنترل منفی ۲: بی نگهبان بستن، کشو با نقدِ پیش‌نویس بسته می‌شد — رد بند ۲ کار همین نگهبان است';
END $neg$;

\echo '── ۷. صندوق حضوری دست نخورد: نقد با باقی پول روی فاکتور شیفت‌دار ──'
DO $pos$
DECLARE v_s4 uuid; v_inv uuid;
BEGIN
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash)
    VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='c1'), 0) RETURNING id INTO v_s4;
  INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by, shift_id)
    VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), 'pos', (SELECT v FROM f WHERE k='c1'), v_s4)
    RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
    VALUES (v_inv, 1, (SELECT v FROM f WHERE k='a'), 1, 1000000, 1000000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount) VALUES (v_inv, v_s4, 'cash', 1200000);
  PERFORM sales.finalize_invoice(v_inv, (SELECT v FROM f WHERE k='c1'));
  PERFORM pg_temp.eq('فروش حضوری: نقد بیش از مبلغ با باقی پول نهایی شد',
    (SELECT status FROM sales.invoice WHERE id = v_inv), 'finalized');
END $pos$;

ROLLBACK;
\echo '✓ نقد فروش اینستاگرام با کشوی همان شعبه — همه ادعاها پاس شدند'
