-- probe پایه (main پیش از ۱۰۰): آیا مالکِ کهنهٔ اجاره می‌تواند اجارهٔ تازه‌تر را تغییر دهد؟
-- همان سناریوی ریشه، داخل یک تراکنش و ROLLBACK. هیچ دادهٔ واقعی لمس نمی‌شود.
\set ON_ERROR_STOP 1
\pset footer off
BEGIN;
INSERT INTO platform.outbox_message (topic, payload) VALUES ('probe.lease', '{}'::jsonb);
\echo '-- A برمی‌دارد، اجاره ۰ ثانیه (یعنی همین الان منقضی)'
SELECT id, attempts FROM platform.claim_outbox(1, 'A', 0, ARRAY['probe.lease']);
\echo '-- B دوباره برمی‌دارد، اجاره ۱۲۰'
SELECT id, attempts FROM platform.claim_outbox(1, 'B', 120, ARRAY['probe.lease']);
SELECT status, attempts, claimed_by FROM platform.outbox_message WHERE topic = 'probe.lease';
SAVEPOINT s;
\echo '-- A دیررس: complete_outbox(id)'
SELECT platform.complete_outbox(id) FROM platform.outbox_message WHERE topic = 'probe.lease';
SELECT status, attempts, claimed_by, sent_at IS NOT NULL AS has_sent_at FROM platform.outbox_message WHERE topic = 'probe.lease';
ROLLBACK TO SAVEPOINT s;
\echo '-- A دیررس (جدا): fail_outbox(id, ...)'
SELECT platform.fail_outbox(id, 'شکست دیررس A', 8, false) FROM platform.outbox_message WHERE topic = 'probe.lease';
SELECT status, attempts, claimed_by, last_error FROM platform.outbox_message WHERE topic = 'probe.lease';
ROLLBACK;
