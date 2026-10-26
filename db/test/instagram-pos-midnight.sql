-- =====================================================================
-- فروش اینستاگرام از صندوق: زمان فروش = لحظهٔ نهایی‌سازی (مهاجرت ۱۰۶)
-- =====================================================================
-- فاکتور بی‌شیفت دورهٔ ثبتش را از روز کاریِ occurred_at می‌گیرد (۰۸۲). سبدی که پیش از نیمه‌شب
-- ساخته شده (یا Replay دیررس صف آفلاین) نباید به روز دیروز بخورد یا به دورهٔ بسته‌شدهٔ دیروز گیر کند.
-- پیش‌نویس «دیروز» با جابه‌جاکردن occurred_at ساخته می‌شود — همان چیزی که گذر واقعی نیمه‌شب می‌سازد.
-- کنترل منفی: بی نگهبان، نهایی‌سازیِ بی تازه‌سازی به همان خطای «دورهٔ بسته» می‌خورد (باگ واقعی).
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
  v_op uuid; v_prod uuid; v_a uuid;
BEGIN
  INSERT INTO identity.app_user (username, full_name) VALUES ('igmid_op', 'اپراتور اینستاگرام') RETURNING id INTO v_op;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_op, 'instagram_operator', BR);
  PERFORM platform.set_actor(v_op);
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-IGMID', 'کت تست') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod, 'طوسی', 'L', 'IGMID-A') RETURNING id INTO v_a;
  INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a, 'default', 1000000);
  PERFORM inventory.apply_movement(v_a, WH, 5, 'opening', p_user => v_op, p_unit_cost => 400000);
  INSERT INTO f VALUES ('br', BR), ('wh', WH), ('op', v_op), ('a', v_a),
    ('bank', (SELECT id FROM treasury.account WHERE code = 'P2P-1'));
END $setup$;

-- سبد تمام‌پرداختِ «ساخته‌شده دیروز»: درج و پرداخت امروز، سپس occurred_at فاکتور و پرداخت یک روز عقب.
CREATE FUNCTION pg_temp.yesterday_cart(p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
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
  INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id, occurred_at)
    VALUES (v_id, 'transfer', 1000000, 'C2C-MID-' || p_key, (SELECT v FROM f WHERE k='bank'), now() - interval '1 day');
  UPDATE sales.invoice SET occurred_at = now() - interval '1 day' WHERE id = v_id;
  INSERT INTO f VALUES (p_key, v_id);
  RETURN v_id;
END $$;

-- همان کاری که مسیر صندوق زیر قفل فاکتور پیش از finalize_invoice می‌کند.
CREATE FUNCTION pg_temp.stamp_and_finalize(p_key text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sales.invoice SET occurred_at = now() WHERE id = (SELECT v FROM f WHERE k=p_key) AND status = 'draft';
  PERFORM sales.finalize_invoice((SELECT v FROM f WHERE k=p_key), (SELECT v FROM f WHERE k='op'));
END $$;

\echo '── ۱. دورهٔ دیروز بسته شده؛ پیش‌نویس دیروز بی تازه‌سازی گیر می‌کند (باگ گزارش‌شده) ──'
INSERT INTO ledger.posting_batch (branch_id, kind, channel, business_date, status, posted_at)
  VALUES ((SELECT v FROM f WHERE k='br'), 'channel_day', 'instagram', platform.business_date(now()) - 1, 'posted', now() - interval '1 hour');
INSERT INTO f SELECT 'closed', id FROM ledger.posting_batch
  WHERE kind = 'channel_day' AND channel = 'instagram' AND business_date = platform.business_date(now()) - 1;
SELECT pg_temp.yesterday_cart('inv');
SELECT pg_temp.rejects('نهایی‌سازی با زمان پیش‌نویس (پیش از نگهبان، همان گیرِ دورهٔ بسته)',
  format('SELECT sales.finalize_invoice(%L, %L)', (SELECT v FROM f WHERE k='inv'), (SELECT v FROM f WHERE k='op')),
  'زمان فروش اینستاگرام باید لحظهٔ نهایی‌سازی باشد|دوره ثبت این فاکتور قبلاً بسته شده است');

\echo '── ۲. با تازه‌سازی زمان: دورهٔ امروز، دورهٔ بستهٔ دیروز دست‌نخورده، زمان پرداخت همان دیروز ──'
SELECT pg_temp.stamp_and_finalize('inv');
SELECT pg_temp.eq('نهایی شد',
  (SELECT status FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')), 'finalized');
SELECT pg_temp.eq('دورهٔ ثبت = روز نهایی‌سازی',
  (SELECT b.business_date FROM sales.invoice i JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
    WHERE i.id=(SELECT v FROM f WHERE k='inv')), platform.business_date(now()));
SELECT pg_temp.eq('دورهٔ بستهٔ دیروز باز نشد و فاکتوری نگرفت',
  (SELECT status || '/' || (SELECT count(*) FROM sales.invoice WHERE posting_batch_id = b.id)::text
     FROM ledger.posting_batch b WHERE b.id=(SELECT v FROM f WHERE k='closed')), 'posted/0');
SELECT pg_temp.eq('زمان پرداخت بازنویسی نشد (هنوز دیروز)',
  (SELECT platform.business_date(occurred_at) FROM treasury.payment WHERE invoice_id=(SELECT v FROM f WHERE k='inv')),
  platform.business_date(now()) - 1);
SELECT pg_temp.eq('خروج کالا با تاریخ امروز',
  (SELECT platform.business_date(max(occurred_at)) FROM inventory.stock_movement
    WHERE ref_type = 'invoice' AND ref_id = (SELECT v FROM f WHERE k='inv')), platform.business_date(now()));

\echo '── ۳. فاکتور نهایی بازنویسی نمی‌شود: تازه‌سازی دوباره اثری ندارد ──'
UPDATE sales.invoice SET occurred_at = now() + interval '1 hour' WHERE id = (SELECT v FROM f WHERE k='inv') AND status = 'draft';
SELECT pg_temp.eq('تازه‌سازی فقط روی پیش‌نویس',
  (SELECT occurred_at = now() FROM sales.invoice WHERE id=(SELECT v FROM f WHERE k='inv')), true);

\echo '── ۴. نیمه‌شب با دورهٔ دیروزِ هنوز باز: فروش به امروز می‌خورد، نه دیروز ──'
UPDATE ledger.posting_batch SET status = 'open', posted_at = NULL WHERE id = (SELECT v FROM f WHERE k='closed');
SELECT pg_temp.yesterday_cart('inv2');
SELECT pg_temp.rejects('بی تازه‌سازی، حتی با دورهٔ باز دیروز',
  format('SELECT sales.finalize_invoice(%L, %L)', (SELECT v FROM f WHERE k='inv2'), (SELECT v FROM f WHERE k='op')),
  'زمان فروش اینستاگرام باید لحظهٔ نهایی‌سازی باشد');
SELECT pg_temp.stamp_and_finalize('inv2');
SELECT pg_temp.eq('به دورهٔ امروز رفت، نه دورهٔ باز دیروز',
  (SELECT b.business_date FROM sales.invoice i JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
    WHERE i.id=(SELECT v FROM f WHERE k='inv2')), platform.business_date(now()));

\echo '── ۵. کنترل منفی: بی نگهبان، پیش‌نویس دیروز بی‌صدا به دورهٔ دیروز می‌خورد ──'
DO $neg$
DECLARE v_inv uuid; v_date date;
BEGIN
  v_inv := pg_temp.yesterday_cart('inv3');
  ALTER TABLE sales.invoice DISABLE TRIGGER instagram_invoice_guard;
  PERFORM sales.finalize_invoice(v_inv, (SELECT v FROM f WHERE k='op'));
  ALTER TABLE sales.invoice ENABLE TRIGGER instagram_invoice_guard;
  SELECT b.business_date INTO v_date FROM sales.invoice i JOIN ledger.posting_batch b ON b.id = i.posting_batch_id WHERE i.id = v_inv;
  IF v_date <> platform.business_date(now()) - 1 THEN
    RAISE EXCEPTION '  ✗ کنترل منفی: بی نگهبان هم به روز درست رفت (%); پس رد بند ۴ از نگهبان نبود', v_date;
  END IF;
  RAISE NOTICE '  ✓ کنترل منفی: بی نگهبان، فروش امروز به دورهٔ دیروز (%) خورد — همان باگ', v_date;
END $neg$;

ROLLBACK;
\echo '✓ زمان فروش اینستاگرام = لحظهٔ نهایی‌سازی — همه ادعاها پاس شدند'
