-- =====================================================================
-- ۰۴۶ — رجیستری درایور دستگاه: کارت‌خوان، چاپگر، ترازو
-- =====================================================================
--
-- خواسته مالک: «مستندات SDK درایور کارت‌خوان باید از طریق تنظیمات
-- قابل جایگزاری یا تغییر باشد، چون هم ممکن است کارت‌خوان‌ها عوض شوند
-- و هم ممکن است زیادتر شوند.»
--
-- ── چرا رجیستری، و چرا حالا ─────────────────────────────────────────
--
-- CLAUDE.md می‌گوید «Windows Bridge و PC-POS تا دریافت مستندات کتبی
-- SDK از PSP ساخته نمی‌شوند». آن هنوز برقرار است و **کد ارتباط با
-- دستگاه اینجا نوشته نمی‌شود** — چون بدون مستندات، هر کدی حدس است و
-- حدس در مسیر پول یعنی پرداختی که وضعیتش معلوم نیست.
--
-- ولی آنچه **می‌شود** الان ساخت، جایی است که آن مستندات بنشیند:
-- نوع دستگاه، آدرس، پارامترها، و اینکه کدام پایانه از کدام درایور
-- استفاده می‌کند. وقتی SDK رسید، فقط یک Handler اضافه می‌شود — نه
-- یک مهاجرت، نه یک تغییر اسکیما، و نه یک Deploy برای هر کارت‌خوان
-- تازه.
--
-- ⚠️ **راز دستگاه در این جدول نمی‌نشیند.** کلید و رمز API از
--    متغیر محیطی می‌آیند، مثل `SMS_API_KEY`. مقدار هر تنظیم در
--    `audit_log` می‌نشیند و صفحه تنظیمات نشانش می‌دهد؛ راز نباید
--    هیچ‌کدام را ببیند. `config` فقط چیزهای غیرمحرمانه دارد: IP،
--    پورت، شماره ترمینال، نام مدل.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۱. نوع درایور — داده، نه CHECK
-- ---------------------------------------------------------------------
-- هر PSP پروتکل خودش را دارد. افزودن «سامان‌کیش» یا «به‌پرداخت» باید
-- یک `INSERT` باشد، نه یک مهاجرت — دقیقاً همان دلیلی که مالک گفت:
-- «ممکن است زیادتر شوند».

CREATE TABLE IF NOT EXISTS platform.device_driver (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  -- card_terminal | printer | scale | scanner
  device_kind text NOT NULL
              CHECK (device_kind IN ('card_terminal','printer','scale','scanner')),
  -- سازنده یا PSP. فقط برای خواندن آدم، نه منطق.
  vendor      text,
  -- نشانی مستندات SDK. همان چیزی که مالک خواست «قابل جایگزاری باشد».
  sdk_doc_url text,
  -- یادداشت فنی: نسخه پروتکل، محدودیت‌ها، شماره تماس پشتیبانی.
  notes       text,
  /**
   * آیا Handler این درایور در کد پیاده شده؟
   *
   * ⚠️ این ستون **بحرانی** است و پیش‌فرضش `false` است.
   *
   * ثبت یک درایور در جدول یعنی «مستنداتش را داریم»، نه «کار
   * می‌کند». اگر این تفکیک نبود، مالک یک کارت‌خوان تازه ثبت می‌کرد،
   * پایانه را به آن وصل می‌کرد، و اولین پرداخت واقعی در سکوت شکست
   * می‌خورد — یا بدتر، معلق می‌ماند.
   *
   * لایه API اجازه نمی‌دهد پایانه‌ای به درایورِ پیاده‌نشده وصل شود.
   */
  is_implemented boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  smallint NOT NULL DEFAULT 100
);
COMMENT ON TABLE platform.device_driver IS
  'درایورهای شناخته‌شده دستگاه. ثبت یعنی «مستنداتش را داریم»؛ is_implemented یعنی «کد دارد».';


-- ---------------------------------------------------------------------
-- ۲. اتصال یک پایانه به یک درایور
-- ---------------------------------------------------------------------
-- به‌ازای **هر پایانه**، نه یک تنظیم سراسری — همان دلیلی که کارمزد و
-- دوره تسویه هم به‌ازای هر پایانه‌اند: کارت‌خوان فروشگاه و درگاه سایت
-- یک دستگاه نیستند.

ALTER TABLE treasury.account
  ADD COLUMN IF NOT EXISTS driver_code text REFERENCES platform.device_driver(code),
  -- پارامترهای **غیرمحرمانه**: IP، پورت، شماره ترمینال، مدل.
  ADD COLUMN IF NOT EXISTS driver_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN treasury.account.driver_config IS
  'پارامتر غیرمحرمانه دستگاه (IP، پورت، شماره ترمینال). راز اینجا نمی‌نشیند — از متغیر محیطی می‌آید.';

-- فقط پایانه درایور می‌گیرد. صندوق نقدی و حساب بانکی دستگاهی ندارند
-- که به آن وصل شوند.
ALTER TABLE treasury.account DROP CONSTRAINT IF EXISTS only_terminals_have_driver;
ALTER TABLE treasury.account
  ADD CONSTRAINT only_terminals_have_driver CHECK (
    kind IN ('card_terminal','gateway') OR driver_code IS NULL);


-- ---------------------------------------------------------------------
-- ۳. نوشتن — با همان قاعده شرایط تسویه
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION treasury.set_device_driver(
  p_account uuid,
  p_driver  text,
  p_config  jsonb DEFAULT '{}'::jsonb,
  p_reason  text DEFAULT NULL,
  p_user    uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_kind text; v_impl boolean; v_before jsonb;
BEGIN
  SELECT kind, jsonb_build_object('driver_code', driver_code, 'driver_config', driver_config)
    INTO v_kind, v_before
    FROM treasury.account WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'حساب خزانه یافت نشد.'; END IF;
  IF v_kind NOT IN ('card_terminal','gateway') THEN
    RAISE EXCEPTION 'فقط کارت‌خوان و درگاه پرداخت درایور دارند.';
  END IF;

  IF p_driver IS NOT NULL THEN
    SELECT is_implemented INTO v_impl
      FROM platform.device_driver WHERE code = p_driver AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'درایور «%» تعریف نشده یا غیرفعال است.', p_driver;
    END IF;
    -- ⚠️ نگهبان اصلی. بدون این، مالک یک درایور تازه ثبت می‌کرد،
    --    پایانه را به آن وصل می‌کرد، و اولین پرداخت واقعی در سکوت
    --    شکست می‌خورد — یا بدتر، معلق می‌ماند و پول مشتری بلاتکلیف.
    IF NOT v_impl THEN
      RAISE EXCEPTION 'درایور «%» هنوز در نرم‌افزار پیاده نشده است. مستنداتش ثبت شده ولی کدش نوشته نشده.', p_driver;
    END IF;
  END IF;

  -- ⚠️ راز در `driver_config` نمی‌نشیند. این مقدار در `audit_log`
  --    می‌رود و صفحه تنظیمات نشانش می‌دهد.
  IF p_config ?| array['password','secret','api_key','apiKey','token','pin','key'] THEN
    RAISE EXCEPTION 'راز در تنظیمات دستگاه ذخیره نمی‌شود. کلید و رمز از متغیر محیطی می‌آیند.';
  END IF;

  UPDATE treasury.account
     SET driver_code = p_driver, driver_config = coalesce(p_config, '{}'::jsonb)
   WHERE id = p_account;

  PERFORM platform.audit('treasury.set_driver', 'treasury_account', p_account::text,
    jsonb_build_object('driver_code', p_driver, 'driver_config', p_config),
    p_user, p_reason, v_before);
END $$;
COMMENT ON FUNCTION treasury.set_device_driver IS
  'اتصال یک پایانه به یک درایور. درایورِ پیاده‌نشده رد می‌شود، و راز در config نمی‌نشیند.';


-- ---------------------------------------------------------------------
-- ۴. نمای وضعیت
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW treasury.terminal_driver AS
  SELECT a.id            AS account_id,
         a.code          AS account_code,
         a.name          AS account_name,
         a.kind,
         a.branch_id,
         a.driver_code,
         d.label         AS driver_label,
         d.vendor,
         d.sdk_doc_url,
         d.is_implemented,
         a.driver_config
    FROM treasury.account a
    LEFT JOIN platform.device_driver d ON d.code = a.driver_code
   WHERE a.kind IN ('card_terminal','gateway') AND a.is_active;

COMMENT ON VIEW treasury.terminal_driver IS
  'هر پایانه و درایورش. driver_code تهی یعنی هنوز دستگاهی وصل نشده.';
