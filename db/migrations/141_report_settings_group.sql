BEGIN;
SET LOCAL lock_timeout='5s';
INSERT INTO platform.setting_group(key,title,subtitle,sort_order)
VALUES('reports','گزارش‌ها','تنظیم سهم کانال‌ها از هزینه‌های مشترک',75)
ON CONFLICT(key) DO NOTHING;
UPDATE platform.setting SET group_key='returns' WHERE key IN ('return.full_review','return.full_review_min');
COMMIT;
