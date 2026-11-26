BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE platform.melipayamak_credential
  ADD COLUMN digest_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN digest_pattern integer CHECK (digest_pattern > 0),
  ADD COLUMN digest_copy text NOT NULL DEFAULT E'گزارش فروش لیبل مد\nحضوری {حضوری}\nسایت {سایت}\nاینستاگرام {اینستاگرام}\nجمع {جمع} تومان';

CREATE TABLE platform.manager_digest (
  report_date date PRIMARY KEY,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','accepted','unknown')),
  rendered text, provider_ref text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- شروع مهلت یک بار هنگام نصب ثبت می‌شود. لینک‌های قدیمی نیاز به بازنویسی ندارند.
CREATE TABLE platform.receipt_link_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  introduced_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.receipt_link_policy DEFAULT VALUES;
INSERT INTO platform.setting(key,value,description,kind,label,group_key,min_value,max_value,unit,help,sort_order,permission,is_editable)
VALUES ('receipt.link_days','30','مهلت مشاهده با لینک فاکتور','int','مهلت لینک رسید','notify',0,365,'روز','برای لینک‌های قدیمی از روز نصب و برای لینک تازه از زمان صدور محاسبه می‌شود.',76,'settings.security',true),
       ('notify.accounting_web_receipt','false','ارسال رسید سایت از حسابداری','bool','پیامک حسابداری برای خرید سایت','notify',NULL,NULL,NULL,'وقتی افزونهٔ سایت پیام تأیید خرید را می‌فرستد این گزینه را خاموش بگذارید.',77,'settings.manage',true)
ON CONFLICT (key) DO NOTHING;
ALTER TABLE sales.invoice ADD COLUMN public_token_issued_at timestamptz;
CREATE FUNCTION sales.stamp_receipt_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_token IS NOT NULL AND NEW.public_token IS DISTINCT FROM OLD.public_token THEN
    NEW.public_token_issued_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stamp_receipt_token BEFORE UPDATE OF public_token ON sales.invoice
  FOR EACH ROW EXECUTE FUNCTION sales.stamp_receipt_token();

COMMIT;
