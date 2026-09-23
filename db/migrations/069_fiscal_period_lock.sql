-- ثبت سند و تغییر وضعیت سال مالی باید یک ترتیب تراکنشی داشته باشند.
-- FOR KEY SHARE کافی نیست: تغییر status کلید سال را عوض نمی‌کند.
-- FOR SHARE ثبت‌کنندگان مستقل را مسدود نمی‌کند، ولی تغییر وضعیت سال
-- را تا پایان سند منتظر می‌گذارد؛ اگر بستن زودتر شروع شده باشد،
-- ثبت‌کننده پس از انتظار وضعیت تازه را می‌خواند و سند را رد می‌کند.
BEGIN;

CREATE OR REPLACE FUNCTION ledger.assert_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM ledger.fiscal_year
   WHERE id = NEW.fiscal_year FOR SHARE;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'سال مالی % بسته است و سند جدید نمی‌پذیرد.', NEW.fiscal_year;
  END IF;
  IF v_status = 'closing' AND NEW.kind NOT IN ('manual','closing','opening') THEN
    RAISE EXCEPTION
      'سال مالی % در حال بستن است و فقط سند دستی، افتتاحیه یا اختتامیه می‌پذیرد (نوع درخواستی: %).',
      NEW.fiscal_year, NEW.kind;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
