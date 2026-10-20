-- همان سناریوی probe پایه پس از مهاجرت ۱۰۰. داخل تراکنش و ROLLBACK.
-- تفاوت ناگزیر: اجارهٔ ۰ دیگر پذیرفته نیست (بازهٔ ۳۰ تا ۳۶۰۰)، پس انقضای A
-- با جلوبردن next_attempt_at شبیه‌سازی می‌شود — همان کاری که گذر زمان می‌کند.
\pset footer off
BEGIN;
INSERT INTO platform.outbox_message (topic, payload) VALUES ('probe.lease', '{}'::jsonb);
\echo '-- اجارهٔ ۰ ثانیه رد می‌شود'
SAVEPOINT z;
\set ON_ERROR_STOP 0
SELECT id FROM platform.claim_outbox(1, 'A', 0, ARRAY['probe.lease']);
ROLLBACK TO SAVEPOINT z;
\echo '-- A برمی‌دارد (۱۲۰)، اجاره‌اش می‌گذرد، B دوباره برمی‌دارد'
\set ON_ERROR_STOP 1
SELECT claim_token AS token_a FROM platform.claim_outbox(1, 'A', 120, ARRAY['probe.lease']) \gset
UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second' WHERE topic = 'probe.lease';
SELECT claim_token AS token_b FROM platform.claim_outbox(1, 'B', 120, ARRAY['probe.lease']) \gset
SELECT status, attempts, claimed_by, claim_token = :'token_b' AS owned_by_b FROM platform.outbox_message WHERE topic = 'probe.lease';
\echo '-- نسخهٔ بی‌توکن دیگر وجود ندارد'
SAVEPOINT s0;
\set ON_ERROR_STOP 0
SELECT platform.complete_outbox(id) FROM platform.outbox_message WHERE topic = 'probe.lease';
ROLLBACK TO SAVEPOINT s0;
\set ON_ERROR_STOP 1
\echo '-- A دیررس: complete_outbox(id, token_a)'
SELECT platform.complete_outbox(id, :'token_a') FROM platform.outbox_message WHERE topic = 'probe.lease';
SELECT status, attempts, claimed_by, sent_at IS NOT NULL AS has_sent_at, claim_token = :'token_b' AS owned_by_b FROM platform.outbox_message WHERE topic = 'probe.lease';
\echo '-- A دیررس: fail_outbox(id, token_a, ...)'
SELECT platform.fail_outbox(id, :'token_a', 'شکست دیررس A', 8, false) FROM platform.outbox_message WHERE topic = 'probe.lease';
SELECT status, attempts, claimed_by, last_error, claim_token = :'token_b' AS owned_by_b FROM platform.outbox_message WHERE topic = 'probe.lease';
\echo '-- کنترل مثبت: B می‌بندد'
SELECT platform.complete_outbox(id, :'token_b') FROM platform.outbox_message WHERE topic = 'probe.lease';
SELECT status, claim_token IS NULL AS token_cleared FROM platform.outbox_message WHERE topic = 'probe.lease';
ROLLBACK;
