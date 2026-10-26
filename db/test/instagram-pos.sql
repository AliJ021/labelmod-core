-- =====================================================================
-- فروش اینستاگرام از همان صندوق (مهاجرت ۱۰۵)
-- =====================================================================
-- قرارداد: docs/INSTAGRAM-POS-MODE-FA.md. لایهٔ دیتابیس: آنچه اگر API دور زده شود
-- باید بایستد. رقابت واقعی و مسیر HTTP در apps/api/test/instagram-pos*.test.ts است.
--
-- هر رد یک کنترل دارد: یا همان کار با شرط درست **پذیرفته** می‌شود، یا (بند ۹) با
-- Trigger خاموش همان حمله می‌گذرد — وگرنه خطای دیگری می‌توانست جای نگهبان «رد» شود.
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
  v_br2 uuid; v_op uuid; v_op2 uuid; v_cash uuid; v_prod uuid; v_a uuid; v_cust uuid; v_shift uuid;
BEGIN
  INSERT INTO identity.app_user (username, full_name) VALUES ('igpos_op', 'اپراتور اینستاگرام') RETURNING id INTO v_op;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_op, 'instagram_operator', BR);
  INSERT INTO platform.branch (code, name) VALUES ('IGPOS-B2', 'شعبهٔ دوم') RETURNING id INTO v_br2;
  INSERT INTO identity.app_user (username, full_name) VALUES ('igpos_op2', 'اپراتور شعبهٔ دیگر') RETURNING id INTO v_op2;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_op2, 'instagram_operator', v_br2);
  INSERT INTO identity.app_user (username, full_name) VALUES ('igpos_cash', 'صندوق‌دار') RETURNING id INTO v_cash;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_cash, 'cashier', BR);
  PERFORM platform.set_actor(v_cash);
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-IGPOS', 'مانتو تست') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod, 'مشکی', 'M', 'IGPOS-A') RETURNING id INTO v_a;
  INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a, 'default', 1000000);
  PERFORM inventory.apply_movement(v_a, WH, 3, 'opening', p_user => v_cash, p_unit_cost => 400000);
  INSERT INTO sales.customer (full_name, mobile_normalized, credit_limit)
    VALUES ('مشتری دایرکت', '09120000009', 1000000000000) RETURNING id INTO v_cust;
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash) VALUES (BR, v_cash, 0) RETURNING id INTO v_shift;
  INSERT INTO f VALUES ('br', BR), ('wh', WH), ('op', v_op), ('op2', v_op2), ('cash', v_cash), ('a', v_a),
    ('cust', v_cust), ('shift', v_shift), ('bank', (SELECT id FROM treasury.account WHERE code = 'P2P-1'));
  IF EXISTS (SELECT 1 FROM f WHERE v IS NULL) THEN RAISE EXCEPTION '  ✗ آماده‌سازی ناقص است'; END IF;
END $setup$;

CREATE FUNCTION pg_temp.ig_invoice(p_user text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('lmc.instagram_order', 'pos', true);
  INSERT INTO sales.invoice (branch_id, warehouse_id, customer_id, channel, created_by)
    VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='cust'),
            'instagram', (SELECT v FROM f WHERE k=p_user)) RETURNING id INTO v_id;
  PERFORM set_config('lmc.instagram_order', '', true);
  RETURN v_id;
END $$;

\echo '── ۱. ساخت: زمینه، مجوز، شعبه و شیفت ──'
SELECT pg_temp.rejects('بی زمینهٔ حالت صندوق (مسیر عمومی)',
  format($q$INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by) VALUES (%L, %L, 'instagram', %L)$q$,
    (SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='op')),
  'فقط از مسیر سفارش اینستاگرام');
SELECT pg_temp.rejects('صندوق‌دار بی مجوز اینستاگرام', $q$SELECT pg_temp.ig_invoice('cash')$q$, 'مجوز فروش اینستاگرام ندارد');
SELECT pg_temp.rejects('اپراتور شعبهٔ دیگر', $q$SELECT pg_temp.ig_invoice('op2')$q$, 'بیرون از شعبهٔ کاربر');
SELECT pg_temp.rejects('فاکتور اینستاگرامِ شیفت‌دار',
  format($q$SELECT set_config('lmc.instagram_order', 'pos', true);
            INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by, shift_id) VALUES (%L, %L, 'instagram', %L, %L)$q$,
    (SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='op'), (SELECT v FROM f WHERE k='shift')),
  'به شیفت کشو نمی‌چسبد');
INSERT INTO f SELECT 'inv', pg_temp.ig_invoice('op');
SELECT pg_temp.eq('اپراتور همان شعبه فاکتور اینستاگرام ساخت', (SELECT channel FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')), 'instagram');
SELECT pg_temp.rejects('کانال پس از ساخت عوض نمی‌شود',
  format($q$UPDATE sales.invoice SET channel = 'pos' WHERE id = %L$q$, (SELECT v FROM f WHERE k='inv')), 'قابل تغییر نیست');

\echo '── ۲. اقلام: مسیر عادی صندوق، فقط تعداد صحیح ──'
SELECT pg_temp.rejects('تعداد کسری',
  format($q$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
            VALUES (%L, 1, %L, 1.5, 1000000, 1500000)$q$, (SELECT v FROM f WHERE k='inv'), (SELECT v FROM f WHERE k='a')),
  'عدد صحیح');
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES ((SELECT v FROM f WHERE k='inv'), 1, (SELECT v FROM f WHERE k='a'), 2, 1000000, 2000000);
SELECT sales.refresh_invoice_totals((SELECT v FROM f WHERE k='inv'));
SELECT pg_temp.eq('سطر صحیح بی زمینهٔ سفارش پذیرفته شد (کنترل)', (SELECT count(*) FROM sales.invoice_line WHERE invoice_id=(SELECT v FROM f WHERE k='inv')), 1::bigint);

\echo '── ۳. روش پرداخت: کارت‌خوان، نقد و نسیه نه؛ کارت‌به‌کارت بله ──'
SELECT pg_temp.rejects('کارت‌خوان',
  format($q$INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no) VALUES (%L, 'card', 1000000, 'T1')$q$,
    (SELECT v FROM f WHERE k='inv')), 'برای فروش اینستاگرام مجاز نیست');
SELECT pg_temp.rejects('نقد',
  format($q$INSERT INTO treasury.payment (invoice_id, method_code, amount) VALUES (%L, 'cash', 1000000)$q$,
    (SELECT v FROM f WHERE k='inv')), 'برای فروش اینستاگرام مجاز نیست');
SELECT pg_temp.rejects('نسیه',
  format($q$INSERT INTO treasury.payment (invoice_id, method_code, amount) VALUES (%L, 'credit', 1000000)$q$,
    (SELECT v FROM f WHERE k='inv')), 'برای فروش اینستاگرام مجاز نیست');
INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id)
  VALUES ((SELECT v FROM f WHERE k='inv'), 'transfer', 1500000, 'C2C-1', (SELECT v FROM f WHERE k='bank'));
SELECT pg_temp.eq('کارت‌به‌کارت پذیرفته شد (کنترل)', (SELECT count(*) FROM treasury.payment WHERE invoice_id=(SELECT v FROM f WHERE k='inv')), 1::bigint);

\echo '── ۴. نهایی‌سازی فقط با پرداخت کامل، هرچه کلید نسیه بگوید ──'
SELECT pg_temp.eq('کلید نسیه روشن است (پیش‌فرض)', platform.setting_bool('sales.credit_enabled', true), true);
SELECT pg_temp.rejects('پرداخت ناقص با مشتری و سقف اعتبار کافی',
  format('SELECT sales.finalize_invoice(%L, %L)', (SELECT v FROM f WHERE k='inv'), (SELECT v FROM f WHERE k='op')),
  'فقط با پرداخت کامل نهایی می‌شود');
SELECT pg_temp.eq('موجودی دست نخورد', (SELECT on_hand::numeric FROM inventory.stock_balance
  WHERE variation_id=(SELECT v FROM f WHERE k='a') AND warehouse_id=(SELECT v FROM f WHERE k='wh')), 3::numeric);
INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id)
  VALUES ((SELECT v FROM f WHERE k='inv'), 'transfer', 500000, 'C2C-2', (SELECT v FROM f WHERE k='bank'));
SELECT sales.finalize_invoice((SELECT v FROM f WHERE k='inv'), (SELECT v FROM f WHERE k='op'));
SELECT pg_temp.eq('نهایی با پرداخت کامل و ترکیبی',
  (SELECT status || '/' || paid_amount::text || '/' || payable_amount::text FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')),
  'finalized/2000000/2000000');
SELECT pg_temp.eq('دورهٔ ثبت روزانهٔ کانال اینستاگرام، نه شیفت',
  (SELECT b.kind || '/' || b.channel FROM sales.invoice i JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
    WHERE i.id=(SELECT v FROM f WHERE k='inv')), 'channel_day/instagram');
SELECT pg_temp.eq('کالا یک بار خارج شد (۳ → ۱)', (SELECT on_hand::numeric FROM inventory.stock_balance
  WHERE variation_id=(SELECT v FROM f WHERE k='a') AND warehouse_id=(SELECT v FROM f WHERE k='wh')), 1::numeric);
SELECT pg_temp.eq('هیچ رزرو کسب‌وکاری نماند', (SELECT reserved::numeric FROM inventory.stock_balance
  WHERE variation_id=(SELECT v FROM f WHERE k='a') AND warehouse_id=(SELECT v FROM f WHERE k='wh')), 0::numeric);

\echo '── ۵. تغییر نقش، کانال فاکتور ساخته‌شده را عوض نمی‌کند ──'
DELETE FROM identity.user_role WHERE user_id = (SELECT v FROM f WHERE k='op');
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES ((SELECT v FROM f WHERE k='op'), 'cashier', (SELECT v FROM f WHERE k='br'));
SELECT pg_temp.eq('فاکتور پس از تغییر نقش', (SELECT channel FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')), 'instagram');
SELECT pg_temp.rejects('همان کاربر با نقش تازه دیگر فاکتور اینستاگرام نمی‌سازد', $q$SELECT pg_temp.ig_invoice('op')$q$, 'مجوز فروش اینستاگرام ندارد');

\echo '── ۶. صندوق حضوری دست نخورد: نقد و کارت‌خوان و نسیه مثل قبل ──'
INSERT INTO sales.invoice (branch_id, warehouse_id, customer_id, channel, created_by, shift_id)
  VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='cust'), 'pos',
          (SELECT v FROM f WHERE k='cash'), (SELECT v FROM f WHERE k='shift'));
INSERT INTO f SELECT 'pos', id FROM sales.invoice WHERE channel = 'pos' AND created_by = (SELECT v FROM f WHERE k='cash') ORDER BY id DESC LIMIT 1;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
  VALUES ((SELECT v FROM f WHERE k='pos'), 1, (SELECT v FROM f WHERE k='a'), 1, 1000000, 1000000);
SELECT sales.refresh_invoice_totals((SELECT v FROM f WHERE k='pos'));
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount) VALUES ((SELECT v FROM f WHERE k='pos'), (SELECT v FROM f WHERE k='shift'), 'cash', 400000);
SELECT sales.finalize_invoice((SELECT v FROM f WHERE k='pos'), (SELECT v FROM f WHERE k='cash'));
SELECT pg_temp.eq('فروش حضوری با نقد و مانده (نسیه) نهایی شد', (SELECT status || '/' || paid_amount::text FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='pos')), 'finalized/400000');

\echo '── ۷. مسیر سفارش v1 (زمینهٔ new) همچنان ساخته می‌شود ──'
SELECT set_config('lmc.instagram_order', 'new', true);
INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by)
  VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), 'instagram', (SELECT v FROM f WHERE k='cash'));
SELECT set_config('lmc.instagram_order', '', true);
SELECT pg_temp.eq('درج با زمینهٔ v1 ماند (مجوز آن در مسیر سفارش سنجیده می‌شود)',
  (SELECT count(*) FROM sales.invoice WHERE channel='instagram' AND created_by=(SELECT v FROM f WHERE k='cash')), 1::bigint);

\echo '── ۸. کنترل منفی: با نگهبان خاموش، پرداخت ناقص و نقد می‌گذشتند ──'
DO $neg$
DECLARE v_inv uuid; v_user uuid := (SELECT v FROM f WHERE k='op2');
BEGIN
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user, 'instagram_operator', (SELECT v FROM f WHERE k='br'))
    ON CONFLICT (user_id, role_code) DO UPDATE SET branch_id = EXCLUDED.branch_id;
  PERFORM inventory.apply_movement((SELECT v FROM f WHERE k='a'), (SELECT v FROM f WHERE k='wh'), 1, 'opening',
    p_user => v_user, p_unit_cost => 400000);
  PERFORM set_config('lmc.instagram_order', 'pos', true);
  INSERT INTO sales.invoice (branch_id, warehouse_id, customer_id, channel, created_by)
    VALUES ((SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='cust'), 'instagram', v_user)
    RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
    VALUES (v_inv, 1, (SELECT v FROM f WHERE k='a'), 1, 1000000, 1000000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  ALTER TABLE treasury.payment DISABLE TRIGGER instagram_payment_guard;
  INSERT INTO treasury.payment (invoice_id, method_code, amount) VALUES (v_inv, 'cash', 100000);
  ALTER TABLE treasury.payment ENABLE TRIGGER instagram_payment_guard;
  ALTER TABLE sales.invoice DISABLE TRIGGER instagram_invoice_guard;
  PERFORM sales.finalize_invoice(v_inv, v_user);
  ALTER TABLE sales.invoice ENABLE TRIGGER instagram_invoice_guard;
  IF (SELECT status FROM sales.invoice WHERE id = v_inv) <> 'finalized' THEN
    RAISE EXCEPTION '  ✗ کنترل منفی: بی نگهبان هم رد شد؛ پس رد بالا از نگهبان نبود';
  END IF;
  RAISE NOTICE '  ✓ کنترل منفی: بی دو نگهبان، نقد و مانده می‌گذشت — رد بالا کار همین نگهبان‌هاست';
END $neg$;

\echo '✓ فروش اینستاگرام از صندوق — همه ادعاها پاس شدند'
ROLLBACK;
