-- =====================================================================
-- تست اجرای مجدد نامهٔ مرده — `platform.requeue_dead_letter()`
-- =====================================================================
-- بند ۴ این پرونده مهم‌ترین بند است و دلیل وجودش:
--
--   یک `UPDATE status='pending'` دستی هم پیام را «زنده» نشان می‌داد،
--   ولی `attempts` روی سقف می‌ماند — پس اولین شکستِ بعدی همان لحظه
--   دوباره می‌کشتش. یعنی «اجرای مجدد»ی که **یک بار هم تلاش نمی‌کرد**.
--
-- پس ادعا این نیست که ستون عوض می‌شود؛ ادعا این است که پیام **واقعاً
-- دوباره برداشته می‌شود** و **یک شکست دیگر هم تحمل می‌کند**.
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
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  v_user uuid; v_id bigint; v_live bigint; v_n int; v_status text;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('requeue','تست صف مرده') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. یک پیام را واقعاً می‌کشیم ═══';
-- ═══════════════════════════════════════════════════════════════════
-- عمداً با `fail_outbox` و نه با `UPDATE status='dead'`: اگر سطر را
-- دستی مرده کنیم، `attempts` هرگز بالا نمی‌رود و بند ۴ بی‌معنا سبز
-- می‌شد — همان تلهٔ اصلی این پرونده.

INSERT INTO platform.outbox_message (topic, payload)
VALUES ('cheque.due', jsonb_build_object('cheque_id', gen_random_uuid()::text))
RETURNING id INTO v_id;

-- ⚠️ `fail_outbox` با Backoff نمایی `next_attempt_at` را جلو می‌برد و
--    `claim_outbox` فقط پیامِ سررسیدشده را برمی‌دارد. پس میان دورها
--    **گذر زمان** شبیه‌سازی می‌شود، وگرنه دور دوم چیزی برنمی‌داشت و
--    `attempts` روی ۱ می‌ماند — و بند ۴ بی‌معنا سبز می‌شد.
--    این `UPDATE` روی `next_attempt_at` مجاز است: `outbox_message` جدول
--    مالی تغییرناپذیر نیست و خودِ Worker هم همین ستون را می‌نویسد.
FOR v_n IN 1..3 LOOP
  UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second'
   WHERE id = v_id;
  PERFORM platform.claim_outbox(10, 'tester', 60);
  PERFORM platform.fail_outbox(v_id, 'خطای ساختگی شماره '||v_n, 3, false);
END LOOP;

SELECT status INTO v_status FROM platform.outbox_message WHERE id = v_id;
PERFORM pg_temp.assert_eq('وضعیت پس از رسیدن به سقف تلاش', v_status, 'dead');
PERFORM pg_temp.assert_eq('شمار تلاش‌ها',
  (SELECT attempts::text FROM platform.outbox_message WHERE id = v_id), '3');
PERFORM pg_temp.assert_eq('در نمای نامهٔ مرده دیده می‌شود',
  (SELECT count(*)::text FROM platform.outbox_dead WHERE id = v_id), '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. سه راه غلط ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بدون دلیل',
  format($$SELECT platform.requeue_dead_letter(%s, '  ',
    (SELECT id FROM identity.app_user WHERE username='requeue'))$$, v_id));

PERFORM pg_temp.assert_raises('پیامی که وجود ندارد',
  $$SELECT platform.requeue_dead_letter(999999999,'دلیل',
    (SELECT id FROM identity.app_user WHERE username='requeue'))$$);

-- روی یک پیامِ سالم: ارسال دوباره به مشتری، بی اینکه چیزی خراب بوده باشد.
INSERT INTO platform.outbox_message (topic, payload, status, sent_at)
VALUES ('cheque.due', '{}'::jsonb, 'sent', now()) RETURNING id INTO v_live;
PERFORM pg_temp.assert_raises('پیامی که مرده نیست',
  format($$SELECT platform.requeue_dead_letter(%s,'دلیل',
    (SELECT id FROM identity.app_user WHERE username='requeue'))$$, v_live));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. زنده‌کردن، با ردّ حسابرسی ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.requeue_dead_letter(v_id,
  'قطعی شبکه رفع شد — درخواست مدیر', v_user);

PERFORM pg_temp.assert_eq('وضعیت پس از زنده‌کردن',
  (SELECT status FROM platform.outbox_message WHERE id = v_id), 'pending');
PERFORM pg_temp.assert_eq('شمار تلاش صفر شد',
  (SELECT attempts::text FROM platform.outbox_message WHERE id = v_id), '0');
PERFORM pg_temp.assert_eq('از نمای نامهٔ مرده بیرون رفت',
  (SELECT count(*)::text FROM platform.outbox_dead WHERE id = v_id), '0');

-- ⚠️ «چرا مرده بود» تنها چیزی است که از سطر پاک می‌شود، پس باید در
--    دفتر حسابرسی مانده باشد — وگرنه تاریخ گم شده است.
SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'outbox.requeue'
   AND entity_id = v_id::text
   AND before->>'status' = 'dead'
   AND before->>'attempts' = '3'
   AND before->>'last_error' LIKE 'خطای ساختگی شماره 3%'
   AND after->>'status' = 'pending'
   AND reason LIKE 'قطعی شبکه%';
PERFORM pg_temp.assert_eq('سطر حسابرسی با دلیل مرگ و دلیل زنده‌کردن', v_n::text, '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. و واقعاً دوباره برداشته می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- بندهای بالا فقط ستون را می‌سنجیدند. این بند از **دروازهٔ خودِ
-- Worker** رد می‌شود.

SELECT count(*) INTO v_n FROM platform.claim_outbox(10, 'tester2', 60)
 WHERE id = v_id;
-- `requeue` خودش `next_attempt_at = now()` می‌گذارد، پس اینجا لازم نیست
-- زمان شبیه‌سازی شود — و همین هم یک ادعاست: پیام **فوراً** برداشتنی است،
-- نه پس از یک Backoff که هیچ‌کس انتظارش را ندارد.
PERFORM pg_temp.assert_eq('Worker پیام زنده‌شده را برداشت', v_n::text, '1');

-- و یک شکستِ دیگر هم تحمل می‌کند: بی صفرکردن `attempts`، همین فراخوان
-- پیام را **دوباره مرده** می‌کرد و «اجرای مجدد» یک بار هم تلاش نمی‌کرد.
PERFORM platform.fail_outbox(v_id, 'یک شکست دیگر', 3, false);
PERFORM pg_temp.assert_eq('پس از یک شکست دیگر همچنان در صف است',
  (SELECT status FROM platform.outbox_message WHERE id = v_id), 'pending');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. و می‌تواند موفق شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- کنترل مثبت: بی این، تابعی که پیام را به وضعیتی می‌برد که هرگز
-- نمی‌تواند `sent` شود هم «پاس» می‌شد.

UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second'
 WHERE id = v_id;
PERFORM platform.claim_outbox(10, 'tester3', 60);
PERFORM platform.complete_outbox(v_id);
PERFORM pg_temp.assert_eq('پیام زنده‌شده به سرانجام رسید',
  (SELECT status FROM platform.outbox_message WHERE id = v_id), 'sent');

RAISE NOTICE E'\n✔ اجرای مجدد نامهٔ مرده — سه رد، ردّ حسابرسی، برداشت واقعی، و سرانجام';
END $test$;

ROLLBACK;
