-- =====================================================================
-- ۰۴۰ — تمرین بازیابی: از یک ادعا در سند، به یک رکورد در دیتابیس
-- =====================================================================
--
-- ## مشکل
--
-- بند ۴ `docs/SECURITY.md` می‌گوید «تمرین Restore ماهانه **اجباری**
-- است» و اضافه می‌کند «تنظیم `backup.restore_drill_days` عبور از مهلت
-- را هشدار می‌دهد».
--
-- آن تنظیم از روز اول در `platform.setting` بود — و **هیچ‌جا خوانده
-- نمی‌شد**. نه نمایی، نه توابعی، نه هشداری. یعنی سند چیزی را وعده
-- می‌داد که کد انجامش نمی‌داد: بدترین حالت یک تنظیم، چون کسی که سند
-- را خوانده فکر می‌کند محافظت دارد.
--
-- همان کلاسی که CLAUDE.md درباره‌اش نوشته: «اگر README عقب بماند،
-- **غلط** می‌شود نه فقط قدیمی».
--
-- ## این مهاجرت چه می‌کند
--
-- ۱. `platform.restore_drill` — هر تمرین یک سطر، **فقط درج‌شدنی**.
--    ویرایش و حذفش رد می‌شود، مثل لاگ حسابرسی: تاریخچه‌ای که بشود
--    عقب بردش، تاریخچه نیست.
--
-- ۲. `platform.restore_drill_status` — یک نما که می‌گوید آخرین تمرین
--    کی بوده و آیا از مهلت گذشته. `ops/deploy.sh status` نشانش
--    می‌دهد، پس زنگ خطر **دیده می‌شود**؛ زنگی که کسی نبیند زنگ نیست.
--
-- ۳. `platform.record_restore_drill()` — تنها راه ثبت. اسکریپت
--    `ops/restore-drill.sh` پس از یک بازیابی **واقعی** صدایش می‌زند.
--
-- ⚠️ ثبت تمرین، تمرین **نیست**. این جدول فقط می‌گوید کسی ادعا کرده
--    که بازیابی را آزموده. ارزش واقعی از اسکریپت می‌آید که دامپ را
--    در یک دیتابیس یک‌بارمصرف بازیابی می‌کند و همان ادعاهای مالی را
--    رویش می‌راند — سند نامتوازن، موجودی منفی، و زنجیره حسابرسی.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS platform.restore_drill (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  -- تاریخ کاری، نه تاریخ سرور. (مهاجرت ۰۳۹)
  drilled_on    date NOT NULL DEFAULT platform.business_date(),
  -- نام فایلی که بازیابی شد — تا بشود فهمید کدام بکاپ آزموده شده.
  backup_file   text NOT NULL,
  -- اندازه فایل: بکاپی که ناگهان یک‌دهم شود، خودش یک هشدار است.
  backup_bytes  bigint,
  -- چند ادعا روی داده بازیابی‌شده پاس شد.
  checks_passed int  NOT NULL DEFAULT 0,
  ok            boolean NOT NULL,
  note          text,
  performed_by  uuid REFERENCES identity.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restore_drill_drilled_on_idx
  ON platform.restore_drill (drilled_on DESC);

COMMENT ON TABLE platform.restore_drill IS
  'هر تمرین بازیابی یک سطر. فقط درج‌شدنی — تاریخچه‌ای که بشود عقب بردش، تاریخچه نیست.';

-- ---------------------------------------------------------------------
-- تغییرناپذیری — همان قاعده لاگ حسابرسی
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform.restore_drill_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'سابقه تمرین بازیابی تغییرناپذیر است';
END $$;

DROP TRIGGER IF EXISTS restore_drill_no_update ON platform.restore_drill;
CREATE TRIGGER restore_drill_no_update
  BEFORE UPDATE OR DELETE ON platform.restore_drill
  FOR EACH ROW EXECUTE FUNCTION platform.restore_drill_immutable();

-- ---------------------------------------------------------------------
-- ثبت یک تمرین
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform.record_restore_drill(
  p_backup_file  text,
  p_ok           boolean,
  p_checks       int     DEFAULT 0,
  p_bytes        bigint  DEFAULT NULL,
  p_note         text    DEFAULT NULL,
  p_user         uuid    DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF coalesce(btrim(p_backup_file), '') = '' THEN
    RAISE EXCEPTION 'نام فایل بکاپ لازم است';
  END IF;

  INSERT INTO platform.restore_drill
    (backup_file, ok, checks_passed, backup_bytes, note, performed_by)
  VALUES (p_backup_file, p_ok, p_checks, p_bytes, p_note, p_user)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION platform.record_restore_drill IS
  'ثبت یک تمرین بازیابی. تنها راه نوشتن در platform.restore_drill.';

-- ---------------------------------------------------------------------
-- زنگ خطر
-- ---------------------------------------------------------------------
-- ⚠️ فقط تمرین **موفق** حساب می‌شود. تمرینی که شکست خورده، ثابت کرده
--    بکاپ سالم **نیست** — شمردنش به‌عنوان «آخرین تمرین» یعنی هشدار
--    را با همان چیزی خاموش کنیم که باید بلندش کند.

CREATE OR REPLACE VIEW platform.restore_drill_status AS
SELECT
  (SELECT max(drilled_on) FROM platform.restore_drill WHERE ok) AS last_ok_drill,
  (SELECT max(drilled_on) FROM platform.restore_drill)          AS last_attempt,
  platform.setting_int('backup.restore_drill_days', 30)         AS allowed_days,
  platform.business_date()
    - (SELECT max(drilled_on) FROM platform.restore_drill WHERE ok) AS days_since,
  CASE
    -- هرگز تمرین نشده: بدترین حالت، و باید بلندتر از «دیر شده» باشد.
    WHEN (SELECT max(drilled_on) FROM platform.restore_drill WHERE ok) IS NULL
      THEN 'never'
    WHEN platform.business_date()
         - (SELECT max(drilled_on) FROM platform.restore_drill WHERE ok)
         > platform.setting_int('backup.restore_drill_days', 30)
      THEN 'overdue'
    ELSE 'ok'
  END AS status;

COMMENT ON VIEW platform.restore_drill_status IS
  'آیا تمرین بازیابی از مهلت گذشته؟ فقط تمرین موفق شمرده می‌شود. never بدتر از overdue است.';

COMMIT;
