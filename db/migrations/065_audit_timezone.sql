BEGIN;
CREATE OR REPLACE FUNCTION platform.audit_hash(
  p_version     smallint,
  p_prev_hash   text,
  p_at          timestamptz,
  p_actor_id    uuid,
  p_action      text,
  p_entity      text,
  p_entity_id   text,
  p_after       jsonb,
  p_before      jsonb,
  p_reason      text,
  p_correlation text DEFAULT NULL
) RETURNS text
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT encode(digest(
    CASE
      -- نسخه ۱: همان فرمول تاریخی. دست‌نخورده می‌ماند، وگرنه هر سطر
      -- قبلی «دست‌کاری‌شده» گزارش می‌شد.
      WHEN p_version = 1 THEN
        coalesce(p_prev_hash, '') || p_at::text || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '')
      -- نسخه ۲: به‌علاوهٔ «مقدار قبلی» و «دلیل» — همان دو میدانی که
      -- بی‌آن‌ها، جعلِ «قبلاً چه بود و چرا عوض شد» دیده نمی‌شد.
      WHEN p_version = 2 THEN
        coalesce(p_prev_hash, '') || p_at::text || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '') || E'\x1f'
        || coalesce(p_before::text, '') || E'\x1f'
        || coalesce(p_reason, '')
      -- نسخه ۳: به‌علاوهٔ شناسهٔ پیگیری. بی آن، جعلِ «این تغییر از کدام
      -- درخواست آمد» دیده نمی‌شد — همان اشکال FND-017، یک میدان دیرتر.
      WHEN p_version IN (3,4) THEN
        coalesce(p_prev_hash, '') || CASE WHEN p_version=4 THEN to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE p_at::text END || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '') || E'\x1f'
        || coalesce(p_before::text, '') || E'\x1f'
        || coalesce(p_reason, '') || E'\x1f'
        || coalesce(p_correlation, '')
    END, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION platform.audit_content_matches(
 p_hash text,p_version smallint,p_prev text,p_at timestamptz,p_actor uuid,
 p_action text,p_entity text,p_id text,p_after jsonb,p_before jsonb,p_reason text,p_correlation text
) RETURNS boolean LANGUAGE plpgsql STABLE
SET search_path TO pg_catalog,public SET TimeZone TO 'UTC' AS $$
DECLARE zone text;
BEGIN
 IF p_version NOT IN (1,2,3,4) OR p_hash IS NULL THEN RETURN false; END IF;
 IF p_hash=platform.audit_hash(p_version,p_prev,p_at,p_actor,p_action,p_entity,p_id,p_after,p_before,p_reason,p_correlation) THEN RETURN true; END IF;
 IF p_version=4 THEN RETURN false; END IF;
 -- Legacy formats serialized timestamptz using the writer's session zone.
 -- Try each distinct historical offset, not the reader's current zone. The
 -- instant and every originally hashed field still have to match exactly.
 FOR zone IN SELECT min(name) FROM pg_timezone_names
   GROUP BY (p_at AT TIME ZONE name)-(p_at AT TIME ZONE 'UTC')
 LOOP
   PERFORM set_config('TimeZone',zone,true);
   IF p_hash=platform.audit_hash(p_version,p_prev,p_at,p_actor,p_action,p_entity,p_id,p_after,p_before,p_reason,p_correlation) THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;
CREATE OR REPLACE FUNCTION platform.audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prev text;
BEGIN
  -- زنجیره باید سریال باشد. بدون قفل، دو درج هم‌زمان همان prev_hash را
  -- می‌خوانند و زنجیره بی‌صدا دوشاخه می‌شود (مهاجرت ۰۰۳).
  PERFORM pg_advisory_xact_lock(hashtext('platform.audit_log')::bigint);

  SELECT hash INTO v_prev FROM platform.audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.hash_version := 4;
  NEW.hash := platform.audit_hash(
    4::smallint, v_prev, NEW.at, NEW.actor_id, NEW.action,
    NEW.entity, NEW.entity_id, NEW.after, NEW.before, NEW.reason,
    NEW.correlation_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE VIEW platform.audit_check AS
WITH chained AS (
  SELECT a.id, a.at, a.actor_id, a.action, a.entity, a.entity_id,
         a.after, a.before, a.reason, a.correlation_id,
         a.prev_hash, a.hash, a.hash_version,
         lag(a.hash) OVER (ORDER BY a.id) AS expected_prev
    FROM platform.audit_log a
)
SELECT c.id, c.at, c.action, c.entity, c.entity_id, c.actor_id,
       CASE
         WHEN c.prev_hash IS DISTINCT FROM c.expected_prev THEN 'broken_link'
         ELSE 'content_changed'
       END AS problem,
       c.hash_version
  FROM chained c
 WHERE c.prev_hash IS DISTINCT FROM c.expected_prev
    OR NOT platform.audit_content_matches(c.hash, c.hash_version, c.prev_hash, c.at,
         c.actor_id, c.action, c.entity, c.entity_id, c.after, c.before, c.reason, c.correlation_id);
COMMIT;
