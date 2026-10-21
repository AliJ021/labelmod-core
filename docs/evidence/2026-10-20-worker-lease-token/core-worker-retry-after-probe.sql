-- Retry-After بالای یک ساعت: آیا کف واقعی است یا به یک ساعت بریده می‌شود؟ (بازبینی ریشه روی 92dc61c)
-- فقط امضای شش‌پارامتری که هر دو head دارند؛ لرزش پیش‌فرض. داخل تراکنش و ROLLBACK.
\pset footer off
BEGIN;
INSERT INTO platform.outbox_message (topic, payload)
SELECT 'probe.ra', jsonb_build_object('ra', ra) FROM unnest(ARRAY[3601, 7200, 86400]) ra;
SELECT count(*) AS claimed FROM platform.claim_outbox(10, 'w', 120, ARRAY['probe.ra']);
SELECT payload->>'ra' AS requested_minimum_seconds,
       platform.fail_outbox(id, claim_token, 'x', 8, false, (payload->>'ra')::int) AS status
  FROM platform.outbox_message WHERE topic = 'probe.ra' ORDER BY id;
SELECT payload->>'ra' AS requested_minimum_seconds,
       round(extract(epoch FROM next_attempt_at - now()))::int AS actual_delay_seconds,
       extract(epoch FROM next_attempt_at - now()) >= (payload->>'ra')::int AS honors_retry_after
  FROM platform.outbox_message WHERE topic = 'probe.ra' ORDER BY id;
ROLLBACK;
