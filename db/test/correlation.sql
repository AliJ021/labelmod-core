-- =====================================================================
-- تست شناسهٔ پیگیری — FND-018، مهاجرت ۰۵۶
-- =====================================================================
-- بند ۴ مهم‌ترین بند این پرونده است:
--
--   میدان تازه‌ای که بیرون از پوشش هش بماند، **جعلش دیده نمی‌شود** —
--   همان اشکالی که FND-017 بود. پس اینجا `correlation_id` یک سطر
--   دست‌کاری می‌شود و ادعا می‌شود `audit_check` می‌گیردش.
--
-- و بند ۶ کنترل مثبتش است: سطرهای نسخهٔ ۱ و ۲ باید **سالم** بمانند،
-- وگرنه هر رکورد تاریخی «دست‌کاری‌شده» گزارش می‌شد.
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

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  v_user uuid; v_n int; v_id bigint; v_msg bigint;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('corr','تست شناسه پیگیری') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. بیرون از HTTP: NULL، و این درست است ═══';
-- ═══════════════════════════════════════════════════════════════════
-- Worker و CLI درخواستی ندارند که شناسه‌ای داشته باشد. ساختن یک شناسهٔ
-- جعلی بدتر از نداشتنش است.

PERFORM platform.set_actor(v_user);
PERFORM platform.audit('test.no_corr', 'thing', 'x1', '{"a":1}'::jsonb);

PERFORM pg_temp.assert_eq('شناسهٔ پیگیری بیرون از درخواست',
  (SELECT coalesce(correlation_id, '‹NULL›') FROM platform.audit_log
    WHERE action = 'test.no_corr'), '‹NULL›');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. با زمینهٔ درخواست: می‌نشیند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.set_actor(v_user, '10.0.0.7'::inet, 'dev-1', 'req-4242');
PERFORM platform.audit('test.with_corr', 'thing', 'x2', '{"a":2}'::jsonb);

SELECT id INTO v_id FROM platform.audit_log WHERE action = 'test.with_corr';
PERFORM pg_temp.assert_eq('شناسهٔ پیگیری ثبت شد',
  (SELECT correlation_id FROM platform.audit_log WHERE id = v_id), 'req-4242');
PERFORM pg_temp.assert_eq('نسخهٔ فرمول هش',
  (SELECT hash_version::text FROM platform.audit_log WHERE id = v_id), '3');
-- و ip و device هم همان‌جا ماندند — مهاجرت ۰۵۶ چیزی را نشکست.
PERFORM pg_temp.assert_eq('IP هم همراهش',
  (SELECT host(ip) FROM platform.audit_log WHERE id = v_id), '10.0.0.7');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. فراخوان سه‌آرگومانی شناسه را **پاک** می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ⚠️ این بند یک نشتی را می‌بندد، نه یک قابلیت را می‌سنجد: اگر
--    `set_actor` سه‌آرگومانی GUC را پاک نمی‌کرد، درخواست بعدی روی همان
--    اتصال Pool‌شده شناسهٔ درخواست **قبلی** را می‌گرفت. همان کلاسی که
--    `enterWith` داشت (FND-020).

PERFORM platform.set_actor(v_user, '10.0.0.8'::inet, 'dev-2');
PERFORM platform.audit('test.cleared', 'thing', 'x3', '{"a":3}'::jsonb);

PERFORM pg_temp.assert_eq('شناسهٔ درخواست قبلی نشت نکرد',
  (SELECT coalesce(correlation_id, '‹NULL›') FROM platform.audit_log
    WHERE action = 'test.cleared'), '‹NULL›');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. جعل شناسهٔ پیگیری **دیده می‌شود** ═══';
-- ═══════════════════════════════════════════════════════════════════
-- مهم‌ترین بند. بی این، میدان تازه فقط یک ستون تزئینی بود.

PERFORM pg_temp.assert_eq('پیش از دست‌کاری، دفتر سالم',
  (SELECT count(*)::text FROM platform.audit_check), '0');

-- Trigger تغییرناپذیری باید موقتاً خاموش شود — همان روشی که
-- `db/test/audit-chain.sql` برای هفت میدان دیگر به کار می‌برد.
ALTER TABLE platform.audit_log DISABLE TRIGGER USER;
UPDATE platform.audit_log SET correlation_id = 'req-9999' WHERE id = v_id;
ALTER TABLE platform.audit_log ENABLE TRIGGER USER;

SELECT count(*) INTO v_n FROM platform.audit_check WHERE id = v_id;
PERFORM pg_temp.assert_eq('سطر دست‌کاری‌شده گرفته شد', v_n::text, '1');
PERFORM pg_temp.assert_eq('و نوعش «تغییر محتوا» است',
  (SELECT problem FROM platform.audit_check WHERE id = v_id), 'content_changed');

-- برگرداندن، تا بندهای بعدی روی دفتر سالم اجرا شوند.
ALTER TABLE platform.audit_log DISABLE TRIGGER USER;
UPDATE platform.audit_log SET correlation_id = 'req-4242' WHERE id = v_id;
ALTER TABLE platform.audit_log ENABLE TRIGGER USER;
PERFORM pg_temp.assert_eq('پس از برگرداندن، دفتر سالم',
  (SELECT count(*)::text FROM platform.audit_check), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. و حذف شناسه هم جعل است ═══';
-- ═══════════════════════════════════════════════════════════════════
-- پاک‌کردن یک میدان، به‌اندازهٔ عوض‌کردنش پوشاندنِ رد است.

ALTER TABLE platform.audit_log DISABLE TRIGGER USER;
UPDATE platform.audit_log SET correlation_id = NULL WHERE id = v_id;
ALTER TABLE platform.audit_log ENABLE TRIGGER USER;
PERFORM pg_temp.assert_eq('حذف شناسه هم گرفته شد',
  (SELECT count(*)::text FROM platform.audit_check WHERE id = v_id), '1');
ALTER TABLE platform.audit_log DISABLE TRIGGER USER;
UPDATE platform.audit_log SET correlation_id = 'req-4242' WHERE id = v_id;
ALTER TABLE platform.audit_log ENABLE TRIGGER USER;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. کنترل مثبت: سطر تاریخی سالم می‌ماند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ⚠️ بی این بند، فرمولی که همهٔ سطرهای قدیمی را «دست‌کاری‌شده» بخواند
--    هم «پاس» می‌شد — و `audit_check` برای همیشه پر می‌ماند و بی‌معنا.

ALTER TABLE platform.audit_log DISABLE TRIGGER USER;
UPDATE platform.audit_log
   SET hash_version = 2,
       hash = platform.audit_hash(2::smallint, prev_hash, at, actor_id, action,
                                  entity, entity_id, after, before, reason),
       correlation_id = NULL
 WHERE id = v_id;
ALTER TABLE platform.audit_log ENABLE TRIGGER USER;

PERFORM pg_temp.assert_eq('سطر نسخهٔ ۲ سالم شمرده می‌شود',
  (SELECT count(*)::text FROM platform.audit_check WHERE id = v_id), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. صف پیام هم شناسه می‌گیرد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- پنج جا در مهاجرت‌های مختلف در این جدول درج می‌کنند؛ Trigger از هر
-- مسیری می‌گذرد، پس هیچ‌کدام عوض نشد.

PERFORM platform.set_actor(v_user, NULL, NULL, 'req-outbox');
INSERT INTO platform.outbox_message (topic, payload)
VALUES ('test.topic', '{}'::jsonb) RETURNING id INTO v_msg;
PERFORM pg_temp.assert_eq('پیام تازه شناسه گرفت',
  (SELECT correlation_id FROM platform.outbox_message WHERE id = v_msg), 'req-outbox');

-- مقدار صریح برنده است: اگر کسی عمداً شناسهٔ دیگری بدهد، Trigger رویش
-- نمی‌نویسد.
INSERT INTO platform.outbox_message (topic, payload, correlation_id)
VALUES ('test.topic', '{}'::jsonb, 'req-explicit') RETURNING id INTO v_msg;
PERFORM pg_temp.assert_eq('مقدار صریح بازنویسی نشد',
  (SELECT correlation_id FROM platform.outbox_message WHERE id = v_msg), 'req-explicit');

-- و بیرون از درخواست، NULL.
PERFORM platform.set_actor(v_user);
INSERT INTO platform.outbox_message (topic, payload)
VALUES ('test.topic', '{}'::jsonb) RETURNING id INTO v_msg;
PERFORM pg_temp.assert_eq('پیام بیرون از درخواست بی‌شناسه',
  (SELECT coalesce(correlation_id, '‹NULL›') FROM platform.outbox_message
    WHERE id = v_msg), '‹NULL›');

RAISE NOTICE E'\n✔ شناسهٔ پیگیری — از درخواست تا دفتر و صف، با پوشش هش';
END $test$;

ROLLBACK;
