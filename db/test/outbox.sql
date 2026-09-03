-- =====================================================================
-- تست صف Outbox — مهاجرت ۰۳۱
-- =====================================================================
-- ادعای مرکزی: **هیچ پیامی بی‌صدا گم نمی‌شود.**
--
-- صف پیام جایی است که خرابی‌ها ساکت‌اند: پیامکی که نرفت، خطایی نمی‌دهد.
-- پس هر مسیرِ گم‌شدن باید یک ادعا داشته باشد:
--
--   • Workerی که وسط ارسال بمیرد → اجاره تمام می‌شود و پیام برمی‌گردد
--   • دو Worker هم‌زمان        → یک پیام دو بار برداشته نمی‌شود
--   • خطای تکرارشونده          → Backoff، و در نهایت نامه مرده
--   • هشدار چک                 → یک بار در هر روز کاری، نه بیست بار
--
-- و یک ادعای منفی که به‌اندازه بقیه مهم است: پیامی که **بسته** شده،
-- هرگز دوباره برداشته نمی‌شود.
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
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- صف را خالی می‌کنیم تا ادعاهای شمارشی به داده خودشان محدود باشند.
DELETE FROM platform.outbox_message;

\echo '── برداشتن و بستن ────────────────────────────────────────────'

INSERT INTO platform.outbox_message (topic, payload) VALUES
  ('t.a', '{"n":1}'::jsonb),
  ('t.b', '{"n":2}'::jsonb),
  ('t.c', '{"n":3}'::jsonb);

SELECT pg_temp.assert_eq(
  'سه پیام برداشته شد',
  (SELECT count(*) FROM platform.claim_outbox(10, 'w1', 120)),
  3);

-- ⚠️ هسته اجاره: پیامِ برداشته‌شده تا پایان مهلت دوباره برداشته
--    نمی‌شود. بدون این، دو Worker یک پیامک را دو بار می‌فرستادند.
SELECT pg_temp.assert_eq(
  'همان لحظه، دوباره برداشته نمی‌شود',
  (SELECT count(*) FROM platform.claim_outbox(10, 'w2', 120)),
  0);

SELECT pg_temp.assert_eq(
  'هر سه در وضعیت sending',
  (SELECT count(*) FROM platform.outbox_message WHERE status = 'sending'),
  3);

SELECT pg_temp.assert_txt(
  'برداشتن، نامِ Worker را ثبت می‌کند',
  (SELECT DISTINCT claimed_by FROM platform.outbox_message),
  'w1');

SELECT platform.complete_outbox(id) FROM platform.outbox_message WHERE topic = 't.a';

SELECT pg_temp.assert_txt(
  'پیام بسته‌شده sent است',
  (SELECT status FROM platform.outbox_message WHERE topic = 't.a'),
  'sent');

SELECT pg_temp.assert_eq(
  'پیام بسته‌شده sent_at دارد',
  (SELECT count(*) FROM platform.outbox_message
    WHERE topic = 't.a' AND sent_at IS NOT NULL),
  1);

\echo '── اجاره منقضی: Workerی که مرد ────────────────────────────────'

-- Workerی که وسط ارسال کشته شود، پیام را در `sending` جا می‌گذارد.
-- بدون مهلت، آن پیام تا ابد آنجا می‌ماند و هیچ‌کس هم نمی‌فهمد.
UPDATE platform.outbox_message
   SET next_attempt_at = now() - interval '1 minute'
 WHERE topic = 't.b';

SELECT pg_temp.assert_eq(
  'پیام رهاشده دوباره برداشته می‌شود',
  (SELECT count(*) FROM platform.claim_outbox(10, 'w2', 120)),
  1);

SELECT pg_temp.assert_eq(
  'و شمارنده تلاشش بالا رفت',
  (SELECT attempts FROM platform.outbox_message WHERE topic = 't.b'),
  2);

-- ⚠️ و ادعای منفی که به‌اندازه بقیه مهم است: پیام **بسته‌شده** هرگز
--    برنمی‌گردد، حتی با تاریخ گذشته. اگر برمی‌گشت، مشتری هر دور یک
--    پیامک تکراری می‌گرفت.
UPDATE platform.outbox_message
   SET next_attempt_at = now() - interval '1 day'
 WHERE topic = 't.a';

SELECT pg_temp.assert_eq(
  'پیام sent هرگز برنمی‌گردد',
  (SELECT count(*) FROM platform.claim_outbox(10, 'w3', 120)
    WHERE topic = 't.a'),
  0);

\echo '── Backoff و نامه مرده ───────────────────────────────────────'

SELECT pg_temp.assert_txt(
  'شکست موقت → دوباره در صف',
  (SELECT platform.fail_outbox(id, 'شبکه قطع بود')
     FROM platform.outbox_message WHERE topic = 't.b'),
  'pending');

SELECT pg_temp.assert_eq(
  'تلاش بعدی در آینده است، نه همین حالا',
  (SELECT count(*) FROM platform.outbox_message
    WHERE topic = 't.b' AND next_attempt_at > now()),
  1);

SELECT pg_temp.assert_eq(
  'و پیام خطا ثبت شد',
  (SELECT count(*) FROM platform.outbox_message
    WHERE topic = 't.b' AND last_error = 'شبکه قطع بود'),
  1);

-- خطای دائمی: شماره غلط با تلاش صدم هم درست نمی‌شود.
SELECT pg_temp.assert_txt(
  'شکست دائمی → مستقیم نامه مرده',
  (SELECT platform.fail_outbox(id, 'شماره نامعتبر', 8, true)
     FROM platform.outbox_message WHERE topic = 't.c'),
  'dead');

SELECT pg_temp.assert_eq(
  'نامه مرده در نمای هشدار دیده می‌شود',
  (SELECT count(*) FROM platform.outbox_dead WHERE topic = 't.c'),
  1);

-- سقف تلاش: پیامی که بارها شکسته، باید بایستد.
UPDATE platform.outbox_message SET attempts = 8 WHERE topic = 't.b';
SELECT pg_temp.assert_txt(
  'پس از سقف تلاش، نامه مرده',
  (SELECT platform.fail_outbox(id, 'باز هم نشد', 8)
     FROM platform.outbox_message WHERE topic = 't.b'),
  'dead');

SELECT pg_temp.assert_raises(
  'بستن پیام ناموجود خطا می‌دهد',
  $$SELECT platform.fail_outbox(999999999::bigint, 'x')$$);

\echo '── نشانی عمومی فاکتور ────────────────────────────────────────'

-- توکن باید Idempotent باشد: لینکی که یک بار پیامک شده، با ارسال
-- دوباره عوض نمی‌شود — وگرنه مشتری با پیامک اول به صفحه‌ای می‌رسید که
-- دیگر وجود ندارد.
DO $$
DECLARE
  v_user uuid := '00000000-0000-7000-8000-0000000000f1';
  v_br   uuid; v_wh uuid; v_inv uuid; v_inv2 uuid; t1 text; t2 text;
BEGIN
  -- ⚠️ فاکتور را **خودمان** می‌سازیم، نه اینکه از دیتابیس برداریم.
  --    نسخه اول این تست `LIMIT 1` می‌زد و روی دیتابیس تازه هیچ
  --    فاکتوری نبود — پس ادعاها بی‌صدا رد می‌شدند و تست سبز بود
  --    بی‌آنکه چیزی سنجیده باشد. ادعایی که می‌تواند رد شود، ادعا
  --    نیست.
  SELECT id INTO v_br FROM platform.branch LIMIT 1;
  SELECT id INTO v_wh FROM inventory.warehouse WHERE branch_id = v_br LIMIT 1;

  INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by)
  VALUES (v_br, v_wh, 'pos', v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by)
  VALUES (v_br, v_wh, 'pos', v_user) RETURNING id INTO v_inv2;

  t1 := sales.ensure_public_token(v_inv);
  t2 := sales.ensure_public_token(v_inv);
  IF t1 IS DISTINCT FROM t2 THEN
    RAISE EXCEPTION E'\n  ✗ توکن Idempotent نیست: % ≠ %', t1, t2;
  END IF;
  IF t1 !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION E'\n  ✗ توکن برای URL امن نیست: %', t1;
  END IF;
  IF length(t1) < 30 THEN
    RAISE EXCEPTION E'\n  ✗ توکن کوتاه‌تر از انتظار است: % کاراکتر', length(t1);
  END IF;
  RAISE NOTICE '  ✓ توکن Idempotent و امن برای URL (% کاراکتر)', length(t1);

  -- دو فاکتور، دو توکن. اگر یکتایی نبود، لینک یک مشتری فاکتور
  -- مشتری دیگر را باز می‌کرد.
  IF sales.ensure_public_token(v_inv2) = t1 THEN
    RAISE EXCEPTION E'\n  ✗ دو فاکتور توکن یکسان گرفتند';
  END IF;
  RAISE NOTICE '  ✓ هر فاکتور توکن خودش را دارد';

  BEGIN
    UPDATE sales.invoice SET public_token = t1 WHERE id = v_inv2;
    RAISE EXCEPTION E'\n  ✗ توکن تکراری پذیرفته شد';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '  ✓ توکن تکراری روی قید یکتایی رد شد';
  END;
END $$;

\echo '── هشدار سررسید چک ───────────────────────────────────────────'

DO $$
DECLARE
  v_user  uuid := '00000000-0000-7000-8000-0000000000f1';
  v_br    uuid;
  v_sup   uuid;
  v_bank  uuid;
  v_ch    uuid;
  n1 int; n2 int; n3 int;
BEGIN
  SELECT id INTO v_br   FROM platform.branch LIMIT 1;
  SELECT id INTO v_bank FROM treasury.account WHERE kind = 'bank' LIMIT 1;

  INSERT INTO purchasing.supplier (code, name)
  VALUES ('S-OUTBOX', 'تأمین‌کننده تست صف') RETURNING id INTO v_sup;

  PERFORM platform.set_actor(v_user);

  -- چک `draft` درج می‌شود و با رویداد حرکت می‌کند (ADR-004).
  INSERT INTO treasury.cheque
    (direction, branch_id, party_type, party_id, bank_name, cheque_no, amount,
     issued_on, due_on, bank_account_id, created_by)
  VALUES ('issued', v_br, 'supplier', v_sup, 'ملت', 'CH-OUTBOX', 3000000,
          platform.business_date() - 20, platform.business_date() + 3,
          v_bank, v_user)
  RETURNING id INTO v_ch;

  PERFORM treasury.post_cheque_event(v_ch, 'issue', v_user);

  DELETE FROM platform.outbox_message WHERE topic = 'cheque.due';

  n1 := treasury.enqueue_due_cheque_alerts();
  IF n1 < 1 THEN
    RAISE EXCEPTION E'\n  ✗ چک نزدیک سررسید هشدار نساخت';
  END IF;
  RAISE NOTICE '  ✓ هشدار چک ساخته شد = %', n1;

  -- ⚠️ هسته این بخش: Worker هر چند ثانیه صدایش می‌زند. بدون
  --    Idempotency روی (چک، روز کاری)، مالک تا ظهر بیست پیامک یکسان
  --    می‌گرفت و بعد همه‌شان را نادیده می‌گرفت.
  n2 := treasury.enqueue_due_cheque_alerts();
  IF n2 <> 0 THEN
    RAISE EXCEPTION E'\n  ✗ اجرای دوباره در همان روز % پیام تازه ساخت', n2;
  END IF;
  RAISE NOTICE '  ✓ اجرای دوباره در همان روز، پیام تازه نساخت';

  -- ولی فردا دوباره: هشدار روزانه است، نه یک‌باره.
  n3 := treasury.enqueue_due_cheque_alerts(platform.business_date() + 1);
  IF n3 < 1 THEN
    RAISE EXCEPTION E'\n  ✗ روز بعد هشدار تازه نساخت';
  END IF;
  RAISE NOTICE '  ✓ روز بعد هشدار تازه دارد = %', n3;

  -- چک وصول‌شده دیگر هشدار نمی‌گیرد.
  PERFORM treasury.post_cheque_event(v_ch, 'pay', v_user, v_bank);
  DELETE FROM platform.outbox_message WHERE topic = 'cheque.due';

  IF treasury.enqueue_due_cheque_alerts() <> 0 THEN
    RAISE EXCEPTION E'\n  ✗ چک وصول‌شده هنوز هشدار می‌سازد';
  END IF;
  RAISE NOTICE '  ✓ چک وصول‌شده هشدار نمی‌سازد';
END $$;

\echo '✓ صف Outbox — همه ادعاها'

ROLLBACK;
