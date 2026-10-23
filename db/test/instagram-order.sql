-- =====================================================================
-- سفارش اینستاگرام — رزرو، نگهبان‌ها، انقضا، تأیید واریز و ثبت روز (مهاجرت ۱۰۲)
-- =====================================================================
-- قرارداد: docs/INSTAGRAM-ORDERS.md. اینجا لایهٔ دیتابیس سنجیده می‌شود: همان
-- چیزی که اگر مسیر API دور زده شود باید بایستد. رقابت واقعی دو نشست و مسیر
-- HTTP در apps/api/test/instagram-orders.integration.test.ts است.
--
-- ⚠️ هر نگهبان یک **کنترل منفی** دارد (بند ۱۲): با Trigger خاموش، همان حمله
--    باید **بگذرد**. بی آن، خطای دیگری (FK، قید) می‌توانست جای نگهبان «رد» را
--    سبز کند و حذف نگهبان از هیچ تستی رد نمی‌شد.
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

-- اجرای دستور و انتظار شکست با پیامی که الگو را دارد. شکست با پیام دیگر هم قرمز است:
-- «رد شد» به دلیلی غیر از نگهبان، چیزی دربارهٔ نگهبان ثابت نمی‌کند.
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
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_b uuid; v_rcpt uuid; v_cust uuid;
BEGIN
  INSERT INTO identity.app_user (username, full_name) VALUES ('ig_op', 'اپراتور اینستاگرام') RETURNING id INTO v_user;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user, 'admin', BR);
  PERFORM platform.set_actor(v_user);
  INSERT INTO purchasing.supplier (code, name) VALUES ('S-IG', 'تأمین‌کننده') RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-IG', 'مانتو تست') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod, 'مشکی', 'M', 'IG-A') RETURNING id INTO v_a;
  INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod, 'مشکی', 'L', 'IG-B') RETURNING id INTO v_b;
  INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a, 'default', 1000000), (v_b, 'default', 500000);
  INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
    VALUES (platform.next_document_no(BR, 'purchase', 1405::smallint), BR, v_sup, WH, now() - interval '2 days')
    RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
    VALUES (v_rcpt, v_a, 2, 400000, 800000), (v_rcpt, v_b, 5, 200000, 1000000);
  PERFORM purchasing.post_receipt(v_rcpt, v_user);
  -- سقف اعتبار بالا عمداً: نهایی‌سازی مستقیمِ بند ۳ باید به **نگهبان اینستاگرام** بخورد، نه به
  -- سنجش سقف اعتبار که زودتر در finalize_invoice می‌آید. وگرنه «رد شد» چیزی دربارهٔ نگهبان ثابت نمی‌کرد.
  INSERT INTO sales.customer (full_name, mobile_normalized, credit_limit)
    VALUES ('مشتری دایرکت', '09120000001', 1000000000000) RETURNING id INTO v_cust;
  INSERT INTO f VALUES ('br', BR), ('wh', WH), ('user', v_user), ('a', v_a), ('b', v_b), ('cust', v_cust),
    ('bank', (SELECT id FROM treasury.account WHERE code = 'P2P-1')),
    ('bank2', (SELECT id FROM treasury.account WHERE code = 'BANK-1')),
    ('cashbox', (SELECT id FROM treasury.account WHERE code = 'CASH-MAIN'));
  IF EXISTS (SELECT 1 FROM f WHERE v IS NULL) THEN RAISE EXCEPTION '  ✗ آماده‌سازی ناقص است'; END IF;
END $setup$;

-- سازندهٔ سفارش آزمون: همان دو گامی که InstagramOrderService می‌زند.
CREATE FUNCTION pg_temp.new_order(p_lines jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_inv uuid; v_order uuid; l jsonb; n int := 0;
  BR uuid := (SELECT v FROM f WHERE k = 'br'); WH uuid := (SELECT v FROM f WHERE k = 'wh');
  U uuid := (SELECT v FROM f WHERE k = 'user');
BEGIN
  PERFORM set_config('lmc.instagram_order', 'new', true);
  INSERT INTO sales.invoice (branch_id, warehouse_id, customer_id, channel, created_by)
    VALUES (BR, WH, (SELECT v FROM f WHERE k = 'cust'), 'instagram', U) RETURNING id INTO v_inv;
  INSERT INTO sales.instagram_order (invoice_id, branch_id, warehouse_id, customer_id, created_by, receiving_account_id)
    VALUES (v_inv, BR, WH, (SELECT v FROM f WHERE k = 'cust'), U, (SELECT v FROM f WHERE k = 'bank'))
    RETURNING id INTO v_order;
  PERFORM set_config('lmc.instagram_order', v_order::text, true);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    n := n + 1;
    INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
      SELECT v_inv, n, (SELECT v FROM f WHERE k = l->>'v'), (l->>'qty')::numeric, p.amount, p.amount * (l->>'qty')::numeric
        FROM catalog.price p WHERE p.variation_id = (SELECT v FROM f WHERE k = l->>'v') AND p.valid_to IS NULL;
  END LOOP;
  PERFORM sales.refresh_invoice_totals(v_inv);
  PERFORM set_config('lmc.instagram_order', '', true);
  RETURN v_order;
END $$;

CREATE FUNCTION pg_temp.avail(p_key text) RETURNS numeric LANGUAGE sql AS $$
  SELECT (on_hand - reserved)::numeric FROM inventory.stock_balance
   WHERE variation_id = (SELECT v FROM f WHERE k = p_key) AND warehouse_id = (SELECT v FROM f WHERE k = 'wh');
$$;
CREATE FUNCTION pg_temp.reserved(p_key text) RETURNS numeric LANGUAGE sql AS $$
  SELECT reserved::numeric FROM inventory.stock_balance
   WHERE variation_id = (SELECT v FROM f WHERE k = p_key) AND warehouse_id = (SELECT v FROM f WHERE k = 'wh');
$$;

\echo '── ۱. فاکتور اینستاگرام از مسیر عمومی ساخته یا ویرایش نمی‌شود ──'
SELECT pg_temp.rejects('درج فاکتور instagram بی زمینهٔ سفارش',
  format($q$INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by) VALUES (%L, %L, 'instagram', %L)$q$,
    (SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='user')),
  'فقط از مسیر سفارش اینستاگرام');
SELECT pg_temp.rejects('کانال ناشناخته «telegram»',
  format($q$INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by) VALUES (%L, %L, 'telegram', %L)$q$,
    (SELECT v FROM f WHERE k='br'), (SELECT v FROM f WHERE k='wh'), (SELECT v FROM f WHERE k='user')),
  'invoice_channel_check');

INSERT INTO f SELECT 'o1', pg_temp.new_order('[{"v":"a","qty":1}]');
SELECT pg_temp.eq('سفارش تازه پیش‌نویس است', (SELECT status FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), 'draft');
SELECT pg_temp.eq('هر سطر نسخه را یک واحد بالا برد', (SELECT version FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), 2);
SELECT pg_temp.eq('شمارهٔ سفارش از سرور', (SELECT order_no ~ '^IG-[0-9]{6}$' FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), true);
SELECT pg_temp.eq('پیش‌نویس هیچ رزروی نساخت', pg_temp.reserved('a'), 0::numeric);
SELECT pg_temp.rejects('افزودن قلم بی زمینهٔ همان سفارش (مسیر عمومی /invoices)',
  format($q$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
            VALUES (%L, 9, %L, 1, 1000000, 1000000)$q$,
    (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), (SELECT v FROM f WHERE k='b')),
  'فقط از صفحهٔ همان سفارش');
SELECT pg_temp.rejects('تعداد اعشاری',
  format($q$SELECT set_config('lmc.instagram_order', %L, true);
            INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
            VALUES (%L, 9, %L, 1.5, 500000, 750000)$q$,
    (SELECT v FROM f WHERE k='o1'),
    (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), (SELECT v FROM f WHERE k='b')),
  'عدد صحیح');

\echo '── ۲. رزرو اتمیک؛ رزرو دوباره Replay است ──'
SELECT pg_temp.eq('رزرو اول', (sales.instagram_reserve((SELECT v FROM f WHERE k='o1'), (SELECT v FROM f WHERE k='user')))->>'replayed', 'false');
SELECT pg_temp.eq('قابل‌فروش A پس از رزرو', pg_temp.avail('a'), 1::numeric);
SELECT pg_temp.eq('رزرو دوباره Replay است', (sales.instagram_reserve((SELECT v FROM f WHERE k='o1'), (SELECT v FROM f WHERE k='user')))->>'replayed', 'true');
SELECT pg_temp.eq('Replay رزرو دوم نساخت', pg_temp.reserved('a'), 1::numeric);
SELECT pg_temp.eq('یک ردیف رزرو باز', (SELECT count(*) FROM inventory.stock_reservation
  WHERE source='instagram' AND source_ref=(SELECT v FROM f WHERE k='o1')::text AND released_at IS NULL), 1::bigint);
SELECT pg_temp.rejects('تغییر اقلام سفارشِ رزروشده (حتی با زمینهٔ درست)',
  format($q$SELECT set_config('lmc.instagram_order', %L, true);
            UPDATE sales.invoice_line SET qty = 2 WHERE invoice_id = %L$q$,
    (SELECT v FROM f WHERE k='o1'), (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1'))),
  'ابتدا رزرو را برگردانید');

-- سفارش دوم: B×۱ و A×۲. A فقط یک قابل‌فروش دارد؛ B (به ترتیب شناسه شاید اول قفل شود) نباید نیمه‌کاره رزرو بماند.
INSERT INTO f SELECT 'o2', pg_temp.new_order('[{"v":"b","qty":1},{"v":"a","qty":2}]');
SELECT pg_temp.rejects('رزرو بیش از قابل‌فروش',
  format('SELECT sales.instagram_reserve(%L, %L)', (SELECT v FROM f WHERE k='o2'), (SELECT v FROM f WHERE k='user')),
  'موجودی قابل‌فروش کافی نیست');
SELECT pg_temp.eq('شکست رزرو، B را نیمه‌کاره رزرو نکرد', pg_temp.reserved('b'), 0::numeric);
SELECT pg_temp.eq('سفارش دوم پیش‌نویس ماند', (SELECT status FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o2')), 'draft');

\echo '── ۳. پول و نهایی‌سازی فقط در تراکنش تأیید واریز ──'
SELECT pg_temp.rejects('دریافت مستقیم روی فاکتور اینستاگرام',
  format($q$INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id)
            VALUES (%L, 'transfer', 1000000, 'X1', %L)$q$,
    (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), (SELECT v FROM f WHERE k='bank')),
  'فقط با تأیید واریز همان سفارش');
SELECT pg_temp.rejects('نهایی‌سازی مستقیم فاکتور اینستاگرام',
  format('SELECT sales.finalize_invoice(%L, %L)',
    (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), (SELECT v FROM f WHERE k='user')),
  'فقط از صفحهٔ همان سفارش|فقط در تراکنش تأیید واریز');

\echo '── ۴. انقضا هرگز کور نیست ──'
UPDATE sales.instagram_order SET reserved_until = now() - interval '1 minute' WHERE id = (SELECT v FROM f WHERE k='o1');
SELECT pg_temp.eq('علامت «مشتری می‌گوید واریز کرده»',
  (sales.instagram_mark_payment((SELECT v FROM f WHERE k='o1'), (SELECT v FROM f WHERE k='user'), 'claimed', 'مشتری گفت ۱۰ صبح'))->>'paymentState', 'claimed');
SELECT pg_temp.eq('با واریز در جریان، هیچ رزروی منقضی نشد',
  sales.instagram_expire_due((SELECT v FROM f WHERE k='user')), 0);
SELECT pg_temp.eq('رزرو A سر جایش', pg_temp.reserved('a'), 1::numeric);
SELECT pg_temp.rejects('لغو سفارشی که واریزش در جریان است',
  format($q$SELECT sales.instagram_release(%L, %L, 'cancelled', 'مشتری منصرف شد')$q$,
    (SELECT v FROM f WHERE k='o1'), (SELECT v FROM f WHERE k='user')),
  'در حال بررسی است');
SELECT sales.instagram_mark_payment((SELECT v FROM f WHERE k='o1'), (SELECT v FROM f WHERE k='user'), 'none', NULL);
SELECT pg_temp.eq('بی واریز در جریان، رزرو سررسیده منقضی شد',
  sales.instagram_expire_due((SELECT v FROM f WHERE k='user')), 1);
SELECT pg_temp.eq('وضعیت منقضی', (SELECT status FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')), 'expired');
SELECT pg_temp.eq('انقضا همان رزرو را آزاد کرد', pg_temp.reserved('a'), 0::numeric);

\echo '── ۵. تأیید واریز: نسخه، حساب، مبلغ ──'
CREATE TEMP TABLE c AS SELECT
  (SELECT v FROM f WHERE k='o1') AS o, (SELECT v FROM f WHERE k='user') AS u,
  (SELECT version FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o1')) AS ver,
  (SELECT payable_amount FROM sales.invoice i JOIN sales.instagram_order io ON io.invoice_id=i.id
     WHERE io.id=(SELECT v FROM f WHERE k='o1')) AS amt;
SELECT pg_temp.eq('مبلغ قابل پرداخت سفارش ۱', (SELECT amt FROM c), 1000000::platform.money);
SELECT pg_temp.rejects('نسخهٔ کهنه',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, %s, %L, now())',
    (SELECT o FROM c), (SELECT u FROM c), (SELECT ver - 1 FROM c), (SELECT v FROM f WHERE k='bank'), (SELECT amt FROM c), 'R-100'),
  'تغییر کرده است');
SELECT pg_temp.rejects('حساب غیربانکی (صندوق نقد)',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, %s, %L, now())',
    (SELECT o FROM c), (SELECT u FROM c), (SELECT ver FROM c), (SELECT v FROM f WHERE k='cashbox'), (SELECT amt FROM c), 'R-100'),
  'حساب مقصد واریز');
SELECT pg_temp.rejects('مبلغ ناقص',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, %s, %L, now())',
    (SELECT o FROM c), (SELECT u FROM c), (SELECT ver FROM c), (SELECT v FROM f WHERE k='bank'), (SELECT amt - 1 FROM c), 'R-100'),
  'برابر نیست');
SELECT pg_temp.rejects('مرجع خالی',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, %s, %L, now())',
    (SELECT o FROM c), (SELECT u FROM c), (SELECT ver FROM c), (SELECT v FROM f WHERE k='bank'), (SELECT amt FROM c), '  '),
  'شمارهٔ پیگیری');

\echo '── ۶. واریز دیررس پس از انقضا: موجودی دوباره سنجیده می‌شود؛ یک کسر ──'
SELECT pg_temp.eq('آغاز تأیید', (sales.instagram_begin_confirm((SELECT o FROM c), (SELECT u FROM c), (SELECT ver FROM c),
  (SELECT v FROM f WHERE k='bank'), (SELECT amt FROM c), ' R-100 ', now() - interval '1 hour'))->>'replayed', 'false');
SELECT pg_temp.eq('وضعیت میانی', (SELECT status FROM sales.instagram_order WHERE id=(SELECT o FROM c)), 'confirming');
SELECT pg_temp.eq('رزرو موقتِ سنجش آزاد شد', pg_temp.reserved('a'), 0::numeric);
INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id, client_event_id)
  SELECT io.invoice_id, 'transfer', (SELECT amt FROM c), 'R-100', (SELECT v FROM f WHERE k='bank'), 'ig:' || io.id
    FROM sales.instagram_order io WHERE io.id = (SELECT o FROM c);
SELECT sales.finalize_invoice((SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT o FROM c)), (SELECT u FROM c));
SELECT sales.instagram_finish_confirm((SELECT o FROM c), (SELECT u FROM c),
  (SELECT p.id FROM treasury.payment p JOIN sales.instagram_order io ON io.invoice_id = p.invoice_id WHERE io.id=(SELECT o FROM c)));
SELECT pg_temp.eq('سفارش نهایی', (SELECT status || '/' || payment_state FROM sales.instagram_order WHERE id=(SELECT o FROM c)), 'finalized/confirmed');
SELECT pg_temp.eq('موجودی A یک بار کم شد (۲ → ۱)', (SELECT on_hand::numeric FROM inventory.stock_balance
  WHERE variation_id=(SELECT v FROM f WHERE k='a') AND warehouse_id=(SELECT v FROM f WHERE k='wh')), 1::numeric);
SELECT pg_temp.eq('هیچ رزرو بازی نماند', (SELECT count(*) FROM inventory.stock_reservation
  WHERE source='instagram' AND source_ref=(SELECT o FROM c)::text AND released_at IS NULL), 0::bigint);
SELECT pg_temp.eq('دورهٔ ثبت روزانهٔ کانال اینستاگرام، نه شیفت و نه وب',
  (SELECT pb.kind || '/' || pb.channel FROM ledger.posting_batch pb JOIN sales.invoice i ON i.posting_batch_id = pb.id
    JOIN sales.instagram_order io ON io.invoice_id = i.id WHERE io.id=(SELECT o FROM c)), 'channel_day/instagram');
SELECT pg_temp.eq('حساب مقصد روی دریافت نشست', (SELECT p.account_id FROM treasury.payment p
  JOIN sales.instagram_order io ON io.invoice_id = p.invoice_id WHERE io.id=(SELECT o FROM c)), (SELECT v FROM f WHERE k='bank'));
SELECT pg_temp.eq('تأیید تکراری همان واریز: همان فاکتور', (sales.instagram_begin_confirm((SELECT o FROM c), (SELECT u FROM c),
  (SELECT ver FROM c), (SELECT v FROM f WHERE k='bank'), (SELECT amt FROM c), 'r-100', now()))->>'replayed', 'true');
SELECT pg_temp.rejects('تأیید با واریز دیگر روی سفارش قطعی',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, %s, %L, now())',
    (SELECT o FROM c), (SELECT u FROM c), (SELECT ver FROM c), (SELECT v FROM f WHERE k='bank'), (SELECT amt FROM c), 'R-999'),
  'با واریز دیگری');
SELECT pg_temp.rejects('لغو پس از نهایی‌سازی (مرجوعی رسمی لازم است)',
  format($q$SELECT sales.instagram_release(%L, %L, 'cancelled', 'x')$q$, (SELECT o FROM c), (SELECT u FROM c)),
  'فقط مرجوعی رسمی');

\echo '── ۷. مرجع تکراری در همان حساب و روز رد؛ حساب دیگر پذیرفته ──'
-- سفارش سوم فقط B دارد تا موجودی A (یکی مانده) در این بند دخیل نباشد.
INSERT INTO f SELECT 'o3', pg_temp.new_order('[{"v":"b","qty":1}]');
SELECT sales.instagram_reserve((SELECT v FROM f WHERE k='o3'), (SELECT v FROM f WHERE k='user'));
SELECT pg_temp.rejects('همان مرجع، همان حساب، همان روز',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, 500000, %L, now())',
    (SELECT v FROM f WHERE k='o3'), (SELECT v FROM f WHERE k='user'),
    (SELECT version FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o3')),
    (SELECT v FROM f WHERE k='bank'), 'R-100'),
  'واریز تکراری');
SELECT pg_temp.eq('همان مرجع در حساب دیگر پذیرفته می‌شود', (sales.instagram_begin_confirm((SELECT v FROM f WHERE k='o3'),
  (SELECT v FROM f WHERE k='user'), (SELECT version FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o3')),
  (SELECT v FROM f WHERE k='bank2'), 500000, 'R-100', now()))->>'replayed', 'false');

\echo '── ۸. لغو پیش از پرداخت همان رزرو را آزاد می‌کند ──'
INSERT INTO f SELECT 'o4', pg_temp.new_order('[{"v":"b","qty":2}]');
SELECT sales.instagram_reserve((SELECT v FROM f WHERE k='o4'), (SELECT v FROM f WHERE k='user'));
SELECT pg_temp.eq('B رزرو شد', pg_temp.reserved('b') >= 2, true);
CREATE TEMP TABLE rb AS SELECT pg_temp.reserved('b') AS before;
SELECT pg_temp.rejects('لغو بی دلیل',
  format($q$SELECT sales.instagram_release(%L, %L, 'cancelled', '  ')$q$, (SELECT v FROM f WHERE k='o4'), (SELECT v FROM f WHERE k='user')),
  'دلیل می‌خواهد');
SELECT sales.instagram_release((SELECT v FROM f WHERE k='o4'), (SELECT v FROM f WHERE k='user'), 'cancelled', 'مشتری منصرف شد');
SELECT pg_temp.eq('لغو دو واحد همان رزرو را آزاد کرد', pg_temp.reserved('b'), (SELECT before - 2 FROM rb));
SELECT pg_temp.eq('پیش‌نویس فاکتور لغو شد', (SELECT i.status FROM sales.invoice i JOIN sales.instagram_order io ON io.invoice_id=i.id
  WHERE io.id=(SELECT v FROM f WHERE k='o4')), 'cancelled');
SELECT pg_temp.eq('لغو دوباره Replay است', (sales.instagram_release((SELECT v FROM f WHERE k='o4'), (SELECT v FROM f WHERE k='user'),
  'cancelled', 'دوباره'))->>'replayed', 'true');

\echo '── ۹. واریز دیررس وقتی آخرین واحد در این فاصله فروخته شده: فروش کور نیست ──'
INSERT INTO f SELECT 'o5', pg_temp.new_order('[{"v":"a","qty":1}]');
SELECT sales.instagram_reserve((SELECT v FROM f WHERE k='o5'), (SELECT v FROM f WHERE k='user'));
UPDATE sales.instagram_order SET reserved_until = now() - interval '1 minute' WHERE id = (SELECT v FROM f WHERE k='o5');
SELECT sales.instagram_expire_due((SELECT v FROM f WHERE k='user'));
-- آخرین A در صندوق فروخته می‌شود (مسیر عادی فروش، نه درج مستقیم).
DO $pos$
DECLARE v_shift uuid; v_inv uuid;
  BR uuid := (SELECT v FROM f WHERE k='br'); WH uuid := (SELECT v FROM f WHERE k='wh'); U uuid := (SELECT v FROM f WHERE k='user');
BEGIN
  INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at) VALUES (BR, U, 0, now()) RETURNING id INTO v_shift;
  INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, created_by) VALUES (BR, WH, v_shift, U) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
    VALUES (v_inv, 1, (SELECT v FROM f WHERE k='a'), 1, 1000000, 1000000);
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount) VALUES (v_inv, v_shift, 'cash', 1000000);
  PERFORM sales.finalize_invoice(v_inv, U);
END $pos$;
SELECT pg_temp.eq('A در صندوق تمام شد', pg_temp.avail('a'), 0::numeric);
SELECT pg_temp.rejects('تأیید واریز دیررس بی موجودی',
  format('SELECT sales.instagram_begin_confirm(%L, %L, %s, %L, 1000000, %L, now())',
    (SELECT v FROM f WHERE k='o5'), (SELECT v FROM f WHERE k='user'),
    (SELECT version FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o5')), (SELECT v FROM f WHERE k='bank'), 'R-500'),
  'موجودی قابل‌فروش کافی نیست');
SELECT pg_temp.eq('سفارش منقضی ماند و پول ثبت نشد', (SELECT status FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o5')), 'expired');

\echo '── ۱۰. ارسال: فقط پس از نهایی‌سازی، رو به جلو، بی حرکت انبار ──'
CREATE TEMP TABLE mv AS SELECT count(*) AS n FROM inventory.stock_movement;
SELECT pg_temp.rejects('ارسال سفارش نهایی‌نشده',
  format($q$SELECT sales.instagram_set_shipping(%L, %L, 'packing', NULL)$q$, (SELECT v FROM f WHERE k='o5'), (SELECT v FROM f WHERE k='user')),
  'فقط پس از تأیید واریز');
SELECT sales.instagram_set_shipping((SELECT o FROM c), (SELECT u FROM c), 'packing', NULL);
SELECT pg_temp.rejects('«ارسال‌شده» بی کد رهگیری',
  format($q$SELECT sales.instagram_set_shipping(%L, %L, 'shipped', NULL)$q$, (SELECT o FROM c), (SELECT u FROM c)), 'کد رهگیری');
SELECT sales.instagram_set_shipping((SELECT o FROM c), (SELECT u FROM c), 'shipped', 'POST-123');
SELECT pg_temp.rejects('برگشت به عقب',
  format($q$SELECT sales.instagram_set_shipping(%L, %L, 'packing', NULL)$q$, (SELECT o FROM c), (SELECT u FROM c)), 'به عقب');
SELECT pg_temp.eq('ارسال هیچ حرکت انباری نساخت', (SELECT count(*) FROM inventory.stock_movement), (SELECT n FROM mv));

\echo '── ۱۱. خرید اینستاگرام «خرید حضوری» سایت نمی‌شود ──'
SELECT pg_temp.eq('هیچ اعلان web.instore_push برای فاکتور اینستاگرام', (SELECT count(*) FROM platform.outbox_message
  WHERE topic='web.instore_push' AND payload->>'invoiceId' IN (SELECT invoice_id::text FROM sales.instagram_order)), 0::bigint);

\echo '── ۱۲. کنترل منفی: بی نگهبان، همان حمله‌ها می‌گذشت ──'
DO $neg$
DECLARE v_inv uuid := (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o3'));
BEGIN
  -- دو لایه: درج پرداخت سرآیند پیش‌نویس را هم به‌روز می‌کند، پس نگهبان فاکتور هم جلویش است.
  -- کنترل منفی هر لایه را جدا می‌سنجد: با یکی خاموش هنوز رد می‌شود، با هر دو خاموش می‌گذرد.
  BEGIN
    ALTER TABLE treasury.payment DISABLE TRIGGER instagram_payment_guard;
    INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id) VALUES (v_inv, 'transfer', 1, 'NEG', (SELECT v FROM f WHERE k='bank'));
    RAISE EXCEPTION '  ✗ با خاموشی فقط نگهبان پرداخت، نگهبان فاکتور جلویش را نگرفت';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM !~ 'فقط از صفحهٔ همان سفارش' THEN RAISE EXCEPTION '%', SQLERRM; END IF;
    RAISE NOTICE '  ✓ لایهٔ دوم: بی instagram_payment_guard هم نگهبان فاکتور دریافت مستقیم را رد کرد';
  END;
  BEGIN
    ALTER TABLE treasury.payment DISABLE TRIGGER instagram_payment_guard;
    ALTER TABLE sales.invoice DISABLE TRIGGER instagram_invoice_guard;
    INSERT INTO treasury.payment (invoice_id, method_code, amount, ref_no, account_id) VALUES (v_inv, 'transfer', 1, 'NEG', (SELECT v FROM f WHERE k='bank'));
    RAISE EXCEPTION 'neg-ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'neg-ok' THEN RAISE EXCEPTION '  ✗ کنترل منفی پرداخت: %', SQLERRM; END IF;
    RAISE NOTICE '  ✓ بی هر دو نگهبان دریافت مستقیم پذیرفته می‌شد (نگهبان‌ها واقعاً لازم‌اند)';
  END;
  BEGIN
    ALTER TABLE sales.invoice_line DISABLE TRIGGER instagram_line_guard;
    UPDATE sales.invoice_line SET qty = 3 WHERE invoice_id = (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o5'));
    RAISE EXCEPTION '  ✗ با خاموشی فقط نگهبان اقلام، نگهبان فاکتور جلوی بازسازی جمع را نگرفت';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM !~ 'فقط از صفحهٔ همان سفارش' THEN RAISE EXCEPTION '%', SQLERRM; END IF;
    RAISE NOTICE '  ✓ لایهٔ دوم: بی instagram_line_guard هم بازسازی جمع فاکتور رد شد';
  END;
  BEGIN
    ALTER TABLE sales.invoice_line DISABLE TRIGGER instagram_line_guard;
    ALTER TABLE sales.invoice DISABLE TRIGGER instagram_invoice_guard;
    UPDATE sales.invoice_line SET qty = 3 WHERE invoice_id = (SELECT invoice_id FROM sales.instagram_order WHERE id=(SELECT v FROM f WHERE k='o5'));
    RAISE EXCEPTION 'neg-ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'neg-ok' THEN RAISE EXCEPTION '  ✗ کنترل منفی اقلام: %', SQLERRM; END IF;
    RAISE NOTICE '  ✓ بی instagram_line_guard اقلام سفارش بسته تغییر می‌کرد';
  END;
END $neg$;
SELECT pg_temp.eq('نگهبان‌ها پس از کنترل منفی دوباره روشن‌اند',
  (SELECT count(*) FROM pg_trigger WHERE tgname IN ('instagram_payment_guard','instagram_line_guard','instagram_invoice_guard')
     AND tgenabled = 'O'), 3::bigint);

ROLLBACK;
