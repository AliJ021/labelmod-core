BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE VIEW platform.backup_status AS
WITH latest AS (
 SELECT (SELECT max(occurred_at) FROM platform.backup_event WHERE kind='created') AS local_at,
        (SELECT max(occurred_at) FROM platform.backup_event WHERE kind='downloaded') AS downloaded_at,
        (SELECT max(encrypted_at) FROM platform.bale_backup) AS encrypted_at,
        (SELECT max(delivered_at) FROM platform.bale_backup WHERE state='sent') AS delivered_at
), observed AS (
 SELECT greatest(local_at,encrypted_at) AS created_at, downloaded_at, greatest(downloaded_at,delivered_at) AS offsite_at,
        platform.setting_int('backup.max_age_hours',26) max_hours,platform.setting_int('backup.offsite_days',7) max_days FROM latest
)
SELECT created_at AS last_created_at,downloaded_at AS last_downloaded_at,max_hours AS max_age_hours,max_days AS offsite_days,
 CASE WHEN created_at IS NULL THEN 'never' WHEN created_at<clock_timestamp()-make_interval(hours=>max_hours) THEN 'stale' ELSE 'ok' END AS backup_state,
 CASE WHEN offsite_at IS NULL THEN 'never' WHEN offsite_at<clock_timestamp()-make_interval(days=>max_days) THEN 'stale' ELSE 'ok' END AS offsite_state
FROM observed;
UPDATE platform.setting SET help='دانلود دستی یا تحویل تأییدشدهٔ نسخهٔ رمزگذاری‌شده به بله زمان این هشدار را تازه می‌کند.' WHERE key='backup.offsite_days';
COMMIT;
