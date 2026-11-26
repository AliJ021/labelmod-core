BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO platform.setting(key,value,description,kind,label,group_key,min_value,max_value,unit,help,sort_order,permission,is_editable)
VALUES
('backup.bale_enabled','false','ارسال بکاپ رمزگذاری‌شده به بله','bool','بکاپ خصوصی بله','backup',NULL,NULL,NULL,'پس از اتصال بات، مقصد خصوصی و کلید عمومی بازیابی روشن کنید.',50,'backup.restore',true),
('backup.bale_hour','0','ساعت ارسال به وقت تهران','int','ساعت بکاپ بله','backup',0,23,'ساعت','برای نیمه‌شب صفر بگذارید.',51,'backup.restore',true),
('backup.bale_minute','0','دقیقهٔ ارسال به وقت تهران','int','دقیقهٔ بکاپ بله','backup',0,59,'دقیقه','اگر سرویس در ساعت انتخابی خاموش باشد، پس از شروع دوباره کار امروز را انجام می‌دهد.',52,'backup.restore',true);

CREATE TABLE platform.bale_backup (
  due_day date PRIMARY KEY,
  state text NOT NULL CHECK(state IN ('preparing','ready','sending','sent','unknown','failed')),
  encrypted_at timestamptz,
  delivered_at timestamptz,
  digest text,
  bytes bigint,
  message_id text,
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
