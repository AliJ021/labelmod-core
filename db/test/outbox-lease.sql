-- =====================================================================
-- تست توکن اجارهٔ Outbox — مهاجرت ۱۰۰
-- =====================================================================
-- ادعای مرکزی: **فقط دارندهٔ اجارهٔ جاری می‌تواند پیام را ببندد، تمدید
-- کند یا شکستش را ثبت کند.** مالکِ کهنه هیچ ستونی را عوض نمی‌کند.
--
-- بند ۱ همان سناریوی probe ریشه است
-- (docs/evidence/2026-10-20-worker-lease-token/core-worker-lease-baseline-probe.log):
-- روی ۰۹۹ «A دیررس» پیامِ B را `sent` و جدا `pending` می‌کرد. اینجا هر دو
-- رد می‌شوند و سطر بایت‌به‌بایت همان می‌ماند. کنترل مثبت (B می‌بندد)
-- اجباری است: بی‌آن، تابعی که هیچ‌وقت نمی‌بندد هم «پاس» می‌شد.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

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

-- تصویر کامل سطر، برای ادعای «هیچ ستونی عوض نشد».
CREATE OR REPLACE FUNCTION pg_temp.snap(p_id bigint) RETURNS text
LANGUAGE sql AS $$
  SELECT row(status, attempts, claimed_by, claim_token, next_attempt_at,
             sent_at, last_error)::text
    FROM platform.outbox_message WHERE id = p_id
$$;

DELETE FROM platform.outbox_message;

DO $test$
DECLARE
  v_id     bigint;
  v_a      uuid;
  v_b      uuid;
  v_before text;
  v_n      int;
  v_t      text;
BEGIN

RAISE NOTICE E'\n═══ ۱. مالکِ کهنه اجارهٔ تازه‌تر را تغییر نمی‌دهد ═══';

INSERT INTO platform.outbox_message (topic, payload)
VALUES ('probe.lease', '{}'::jsonb) RETURNING id INTO v_id;

SELECT c.claim_token INTO v_a FROM platform.claim_outbox(1, 'A', 120, ARRAY['probe.lease']) c;
-- اجارهٔ A می‌گذرد (Worker کند یا ایستاده)؛ B دوباره برمی‌دارد.
UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second' WHERE id = v_id;
SELECT c.claim_token INTO v_b FROM platform.claim_outbox(1, 'B', 120, ARRAY['probe.lease']) c;

PERFORM pg_temp.assert_txt('B برداشت: تلاش ۲ و نام B',
  (SELECT attempts||'/'||claimed_by FROM platform.outbox_message WHERE id = v_id), '2/B');
PERFORM pg_temp.assert_txt('توکن B تازه است، نه همان A',
  (v_a IS NOT NULL AND v_b IS NOT NULL AND v_a <> v_b)::text, 'true');

v_before := pg_temp.snap(v_id);

PERFORM pg_temp.assert_txt('A دیررس: complete رد شد',
  platform.complete_outbox(v_id, v_a)::text, 'false');
PERFORM pg_temp.assert_txt('… و هیچ ستونی عوض نشد', pg_temp.snap(v_id), v_before);

PERFORM pg_temp.assert_txt('A دیررس: fail «lost» است',
  platform.fail_outbox(v_id, v_a, 'شکست دیررس A', 8, false), 'lost');
PERFORM pg_temp.assert_txt('… و نه وضعیت، نه خطا، نه زمان عوض نشد', pg_temp.snap(v_id), v_before);

PERFORM pg_temp.assert_txt('A دیررس: fail دائمی هم «lost»',
  platform.fail_outbox(v_id, v_a, 'رد قطعی A', 8, true), 'lost');
PERFORM pg_temp.assert_txt('… و پیام مرده نشد', pg_temp.snap(v_id), v_before);

PERFORM pg_temp.assert_txt('A دیررس: تمدید رد شد',
  platform.renew_outbox(v_id, v_a, 120)::text, 'false');
PERFORM pg_temp.assert_txt('… و اجارهٔ B جابه‌جا نشد', pg_temp.snap(v_id), v_before);

RAISE NOTICE E'\n═══ ۲. کنترل مثبت: مالک جاری تمدید می‌کند و می‌بندد ═══';

UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second' WHERE id = v_id;
PERFORM pg_temp.assert_txt('B تمدید می‌کند (حتی پس از انقضا، تا کسی برنداشته)',
  platform.renew_outbox(v_id, v_b, 300)::text, 'true');
PERFORM pg_temp.assert_txt('اجاره ۳۰۰ ثانیه جلو رفت',
  (SELECT (next_attempt_at = now() + interval '300 seconds')::text
     FROM platform.outbox_message WHERE id = v_id), 'true');
PERFORM pg_temp.assert_txt('B می‌بندد', platform.complete_outbox(v_id, v_b)::text, 'true');
PERFORM pg_temp.assert_txt('sent، با sent_at و بی توکن',
  (SELECT status||'/'||(sent_at IS NOT NULL)||'/'||(claim_token IS NULL)
     FROM platform.outbox_message WHERE id = v_id), 'sent/true/true');

v_before := pg_temp.snap(v_id);
PERFORM pg_temp.assert_txt('بستن دوباره با همان توکن رد می‌شود',
  platform.complete_outbox(v_id, v_b)::text, 'false');
PERFORM pg_temp.assert_txt('شکستِ پس از بسته‌شدن «lost»',
  platform.fail_outbox(v_id, v_b, 'دیر', 8, false), 'lost');
PERFORM pg_temp.assert_txt('پیام بسته‌شده دست نخورد', pg_temp.snap(v_id), v_before);

RAISE NOTICE E'\n═══ ۳. توکن تهی هرگز مالک نیست — از جمله سطر برداشته‌شده پیش از ۱۰۰ ═══';

-- سطری که Worker قدیمی پیش از مهاجرت برداشته: `sending` با توکن تهی.
INSERT INTO platform.outbox_message (topic, payload, status, attempts, claimed_by, next_attempt_at)
VALUES ('probe.lease', '{}'::jsonb, 'sending', 1, 'قدیمی', now() + interval '2 minutes')
RETURNING id INTO v_id;
v_before := pg_temp.snap(v_id);
PERFORM pg_temp.assert_txt('complete با توکن تهی', platform.complete_outbox(v_id, NULL)::text, 'false');
PERFORM pg_temp.assert_txt('fail با توکن تهی', platform.fail_outbox(v_id, NULL, 'x', 8, false), 'lost');
PERFORM pg_temp.assert_txt('renew با توکن تهی', platform.renew_outbox(v_id, NULL, 120)::text, 'false');
PERFORM pg_temp.assert_txt('سطر قدیمی دست نخورد', pg_temp.snap(v_id), v_before);
-- و پس از اجاره، مسیر عادی با توکن تازه برش می‌دارد — تحویل گم نمی‌شود.
UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second' WHERE id = v_id;
SELECT count(*) INTO v_n FROM platform.claim_outbox(10, 'تازه', 120, ARRAY['probe.lease']) c
 WHERE c.id = v_id AND c.claim_token IS NOT NULL;
PERFORM pg_temp.assert_txt('پس از اجاره با توکن برداشته شد', v_n::text, '1');

RAISE NOTICE E'\n═══ ۴. نسخه‌های بی‌توکن دیگر وجود ندارند ═══';

PERFORM pg_temp.assert_txt('complete_outbox(bigint) حذف شد',
  (to_regprocedure('platform.complete_outbox(bigint)') IS NULL)::text, 'true');
PERFORM pg_temp.assert_txt('fail_outbox(bigint,text,int,boolean) حذف شد',
  (to_regprocedure('platform.fail_outbox(bigint,text,integer,boolean)') IS NULL)::text, 'true');
PERFORM pg_temp.assert_txt('claim_outbox چهارپارامتری حذف شد',
  (to_regprocedure('platform.claim_outbox(integer,text,integer,text[])') IS NULL)::text, 'true');

RAISE NOTICE E'\n═══ ۵. بازه‌ها در دیتابیس اجبار می‌شوند ═══';

PERFORM pg_temp.assert_raises('دستهٔ صفر', $$SELECT * FROM platform.claim_outbox(0, 'w', 120)$$);
PERFORM pg_temp.assert_raises('دستهٔ ۲۰۱', $$SELECT * FROM platform.claim_outbox(201, 'w', 120)$$);
PERFORM pg_temp.assert_raises('اجارهٔ صفر', $$SELECT * FROM platform.claim_outbox(1, 'w', 0)$$);
PERFORM pg_temp.assert_raises('اجارهٔ ۲۹', $$SELECT * FROM platform.claim_outbox(1, 'w', 29)$$);
PERFORM pg_temp.assert_raises('اجارهٔ ۳۶۰۱', $$SELECT * FROM platform.claim_outbox(1, 'w', 3601)$$);
PERFORM pg_temp.assert_raises('تمدید با اجارهٔ صفر',
  format($$SELECT platform.renew_outbox(%s, gen_random_uuid(), 0)$$, v_id));
PERFORM pg_temp.assert_raises('موضوع و استثنا با هم',
  $$SELECT * FROM platform.claim_outbox(1, 'w', 120, ARRAY['a'], ARRAY['b'])$$);
PERFORM pg_temp.assert_raises('فهرست موضوع خالی',
  $$SELECT * FROM platform.claim_outbox(1, 'w', 120, ARRAY[]::text[])$$);
PERFORM pg_temp.assert_raises('Retry-After منفی',
  format($$SELECT platform.fail_outbox(%s, gen_random_uuid(), 'x', 8, false, -1)$$, v_id));
PERFORM pg_temp.assert_raises('Retry-After بیش از یک روز',
  format($$SELECT platform.fail_outbox(%s, gen_random_uuid(), 'x', 8, false, 86401)$$, v_id));
PERFORM pg_temp.assert_raises('بستن پیام ناموجود',
  $$SELECT platform.fail_outbox(999999999::bigint, gen_random_uuid(), 'x')$$);

RAISE NOTICE E'\n═══ ۶. Retry-After کفِ واقعی است (بی بریدن به یک ساعت)؛ لرزش محدود و فقط رو به بالا ═══';
-- قرارداد (بازبینی ریشه روی 92dc61c): Retry-After سنجیده‌شده **هرگز کوتاه نمی‌شود**. سقف یک ساعت فقط
-- مال Backoff نمایی است. تأخیر = greatest(least(backoff، ۱ ساعت) × (1 + 0.2 × لرزش)، Retry-After).
-- لرزش در تولید random() است و در آزمون صریح داده می‌شود (p_jitter) تا عدد دقیق سنجیده شود.

DELETE FROM platform.outbox_message;
INSERT INTO platform.outbox_message (topic, payload)
SELECT 'probe.retry', jsonb_build_object('case', c, 'ra', ra, 'j', j)
  FROM (VALUES ('none', NULL::int, 0.0), ('zero', 0, 0.0), ('ten_min', 600, 0.0),
               ('hour_plus', 3601, 0.0), ('two_hours', 7200, 0.0), ('day', 86400, 0.0),
               ('j_half', NULL, 0.5), ('j_full', NULL, 1.0), ('ra_61_j0', 61, 0.0), ('ra_61_j1', 61, 1.0),
               ('ra_600_j1', 600, 1.0), ('dead', 7200, 1.0)) v(c, ra, j);
PERFORM count(*) FROM platform.claim_outbox(20, 'w', 120, ARRAY['probe.retry']);

-- تلاش اول: Backoff پایه یک دقیقه.
SELECT string_agg(payload->>'case' || '=' ||
  platform.fail_outbox(id, claim_token, 'x', 8, payload->>'case' = 'dead',
    (payload->>'ra')::int, (payload->>'j')::float8),
  ',' ORDER BY id) INTO v_t
  FROM platform.outbox_message WHERE topic = 'probe.retry';
PERFORM pg_temp.assert_txt('وضعیت‌ها', v_t,
  'none=pending,zero=pending,ten_min=pending,hour_plus=pending,two_hours=pending,day=pending,'
  || 'j_half=pending,j_full=pending,ra_61_j0=pending,ra_61_j1=pending,ra_600_j1=pending,dead=dead');

SELECT string_agg(payload->>'case' || '=' || (next_attempt_at - now())::text, ',' ORDER BY id) INTO v_t
  FROM platform.outbox_message WHERE topic = 'probe.retry';
PERFORM pg_temp.assert_txt(
  'تأخیرها: Retry-After بالای یک ساعت کامل می‌ماند (۳۶۰۱، ۷۲۰۰، ۸۶۴۰۰)؛ لرزش ۰ تا ۲۰٪ رو به بالا؛ هرگز زیر Retry-After',
  v_t, 'none=00:01:00,zero=00:01:00,ten_min=00:10:00,hour_plus=01:00:01,two_hours=02:00:00,day=1 day,'
    || 'j_half=00:01:06,j_full=00:01:12,ra_61_j0=00:01:01,ra_61_j1=00:01:12,ra_600_j1=00:10:00,dead=00:00:00');

-- کنترل حساسیت: کفِ کمتر از Backoff آن را پایین نمی‌آورد.
UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second', attempts = 4
 WHERE topic = 'probe.retry' AND payload->>'case' = 'none';
PERFORM count(*) FROM platform.claim_outbox(10, 'w', 120, ARRAY['probe.retry']);
PERFORM platform.fail_outbox(id, claim_token, 'x', 8, false, 30, 0)
   FROM platform.outbox_message WHERE topic = 'probe.retry' AND payload->>'case' = 'none';
PERFORM pg_temp.assert_txt('تلاش پنجم: Backoff ۱۶ دقیقه بر کف ۳۰ ثانیه برنده است',
  (SELECT (next_attempt_at - now())::text FROM platform.outbox_message
    WHERE topic = 'probe.retry' AND payload->>'case' = 'none'), '00:16:00');

-- سقف Backoff (نه Retry-After) یک ساعت است؛ لرزش روی خودِ سقف هم می‌نشیند تا Workerها پس از قطعی
-- طولانی هم‌گام نشوند.
UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second', attempts = 11
 WHERE topic = 'probe.retry' AND payload->>'case' IN ('zero', 'j_full');
PERFORM count(*) FROM platform.claim_outbox(10, 'w', 120, ARRAY['probe.retry']);
PERFORM platform.fail_outbox(id, claim_token, 'x', 20, false, NULL, CASE payload->>'case' WHEN 'zero' THEN 0 ELSE 1 END)
   FROM platform.outbox_message WHERE topic = 'probe.retry' AND payload->>'case' IN ('zero', 'j_full');
PERFORM pg_temp.assert_txt('تلاش دوازدهم: سقف Backoff یک ساعت، با لرزش تا ۷۲ دقیقه',
  (SELECT string_agg(payload->>'case' || '=' || (next_attempt_at - now())::text, ',' ORDER BY id)
     FROM platform.outbox_message WHERE topic = 'probe.retry' AND payload->>'case' IN ('zero', 'j_full')),
  'zero=01:00:00,j_full=01:12:00');

PERFORM pg_temp.assert_raises('لرزش منفی',
  format($$SELECT platform.fail_outbox(%s, gen_random_uuid(), 'x', 8, false, NULL, -0.01)$$, v_id));
PERFORM pg_temp.assert_raises('لرزش بیش از یک',
  format($$SELECT platform.fail_outbox(%s, gen_random_uuid(), 'x', 8, false, NULL, 1.01)$$, v_id));

-- لرزش پیش‌فرض (تولید) واقعاً تصادفی است و در همان بازه می‌ماند: سی پیام، یک شکست هم‌زمان.
DELETE FROM platform.outbox_message;
INSERT INTO platform.outbox_message (topic, payload)
SELECT 'probe.jitter', '{}'::jsonb FROM generate_series(1, 30);
PERFORM count(*) FROM platform.claim_outbox(50, 'w', 120, ARRAY['probe.jitter']);
PERFORM platform.fail_outbox(id, claim_token, 'x', 8, false, 61)
   FROM platform.outbox_message WHERE topic = 'probe.jitter';
PERFORM pg_temp.assert_txt('لرزش پیش‌فرض: همه بین ۶۱ و ۷۲ ثانیه (هرگز زیر Retry-After ۶۱)، و نه همه یکسان',
  (SELECT (min(next_attempt_at - now()) >= interval '61 seconds'
       AND max(next_attempt_at - now()) <= interval '72 seconds'
       AND count(DISTINCT next_attempt_at) > 1)::text
     FROM platform.outbox_message WHERE topic = 'probe.jitter'), 'true');

RAISE NOTICE E'\n═══ ۷. دو خط موضوع: بی‌همپوشانی و کامل ═══';

DELETE FROM platform.outbox_message;
INSERT INTO platform.outbox_message (topic, payload)
SELECT t, '{}'::jsonb
  FROM unnest(ARRAY['web.stock_push','web.price_push','web.instore_push',
                    'invoice.finalized','cheque.due','health.alert','auth.sms_otp',
                    'موضوع.ناشناخته']) t;

-- ⚠️ هر دو ترتیب: خطی که اول می‌رود همه‌چیزِ سررسیده را می‌بیند. اگر فقط
--    web اول برود، notifyی که استثنا را نادیده بگیرد چیزی برای ربودن ندارد
--    و «پاس» می‌شود (جهش M6 همین‌طور زنده ماند).
CREATE TEMP TABLE lane_claim (round text, lane text, id bigint, topic text) ON COMMIT DROP;
FOR v_t IN SELECT unnest(ARRAY['notify-first','web-first']) LOOP
  UPDATE platform.outbox_message
     SET status = 'pending', claim_token = NULL, next_attempt_at = now() - interval '1 second';
  IF v_t = 'notify-first' THEN
    INSERT INTO lane_claim SELECT v_t, 'notify', c.id, c.topic
      FROM platform.claim_outbox(200, 'notify', 120, NULL,
             ARRAY['web.stock_push','web.price_push','web.instore_push']) c;
  END IF;
  INSERT INTO lane_claim SELECT v_t, 'web', c.id, c.topic
    FROM platform.claim_outbox(200, 'web', 120,
           ARRAY['web.stock_push','web.price_push','web.instore_push']) c;
  IF v_t = 'web-first' THEN
    INSERT INTO lane_claim SELECT v_t, 'notify', c.id, c.topic
      FROM platform.claim_outbox(200, 'notify', 120, NULL,
             ARRAY['web.stock_push','web.price_push','web.instore_push']) c;
  END IF;

  PERFORM pg_temp.assert_txt(v_t || ': هر پیام دقیقاً یک بار برداشته شد',
    (SELECT count(*)||'/'||count(DISTINCT id) FROM lane_claim WHERE round = v_t), '8/8');
  PERFORM pg_temp.assert_txt(v_t || ': هیچ پیامی بی‌صاحب نماند',
    (SELECT count(*)::text FROM platform.outbox_message WHERE status = 'pending'), '0');
  PERFORM pg_temp.assert_txt(v_t || ': خط web فقط سه موضوع سایت',
    (SELECT string_agg(topic, ',' ORDER BY topic) FROM lane_claim WHERE round = v_t AND lane = 'web'),
    'web.instore_push,web.price_push,web.stock_push');
  PERFORM pg_temp.assert_txt(v_t || ': خط notify بقیه، از جمله موضوع ناشناخته',
    (SELECT count(*)||'/'||count(*) FILTER (WHERE topic = 'موضوع.ناشناخته')
       FROM lane_claim WHERE round = v_t AND lane = 'notify'), '5/1');
END LOOP;

RAISE NOTICE E'\n✔ توکن اجاره — مالک کهنه هیچ‌چیز را عوض نمی‌کند، مالک جاری می‌بندد، بازه‌ها و خط‌ها اجبار می‌شوند';
END $test$;

ROLLBACK;
