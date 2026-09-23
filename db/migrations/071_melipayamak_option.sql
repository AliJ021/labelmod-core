-- فقط گزینهٔ سرویس‌دهنده اضافه می‌شود؛ انتخاب و وضعیت فعال‌بودن عوض نمی‌شود.
BEGIN;
UPDATE platform.setting
   SET options = coalesce(options, '[]'::jsonb) ||
     '[{"value":"melipayamak","label":"ملی‌پیامک (API کلیددار)"}]'::jsonb
 WHERE key = 'notify.sms_provider'
   AND NOT coalesce(options, '[]'::jsonb) @> '[{"value":"melipayamak"}]'::jsonb;
COMMIT;
