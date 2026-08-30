-- =====================================================================
-- ۰۱۲ — شرایط تسویه کارت‌خوان و درگاه: دوره و کارمزد، از مسیر امن
-- =====================================================================
-- مالک گفت: «کارت‌خوان فردای همان روز تسویه می‌کند» و «درصد کارمزد
-- کارت‌خوان را الان نمی‌دانم، این را هم داخل تنظیمات بگذار که بشود
-- تغییر داد.»
--
-- ## چرا این‌ها در `platform.setting` نرفتند
--
-- وسوسه‌اش بود که دو کلید `payment.card_fee_percent` و
-- `payment.card_settlement_days` ساخته شود. ولی این دو عدد **از قبل
-- وجود دارند** و جای درستشان همان‌جاست:
--
--   treasury.account.fee_percent      ← همان چیزی که settle_batch
--   treasury.account.settlement_days     واقعاً می‌خواند (سطر ۴۴۹ در ۰۰۴)
--
-- و **به‌ازای هر پایانه** معنا دارند، نه یکی برای کل سیستم: کارت‌خوان
-- فروشگاه و درگاه سایت معمولاً قرارداد و کارمزد متفاوت دارند. یک کلید
-- سراسری یعنی یکی از این دو همیشه غلط باشد.
--
-- دو منبع حقیقت برای یک نرخ کارمزد، دقیقاً همان چیزی است که شش ماه
-- بعد باعث می‌شود سند تسویه با صورتحساب PSP نخواند و کسی نفهمد چرا.
-- پس ستون‌ها سر جایشان ماندند و **مسیر تغییرشان** ساخته شد.
--
-- ## آنچه ساخته شد
--
-- همان الگوی `platform.set_setting()`: یک در ورودی که اعتبارسنجی
-- می‌کند، ردّ حسابرسی می‌گذارد، و `UPDATE` مستقیم را می‌بندد.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. تنها در ورودی
-- ---------------------------------------------------------------------
-- کارمزد و دوره تسویه، هر دو داده مالی‌اند: کارمزد مستقیم در سند
-- تسویه ضرب می‌شود و دوره تعیین می‌کند پول کی «در راه» حساب شود.
-- عوض‌شدنشان باید همان‌قدر ردیابی‌پذیر باشد که نرخ مالیات.

CREATE OR REPLACE FUNCTION treasury.set_settlement_terms(
  p_account         uuid,
  p_settlement_days smallint,
  p_fee_percent     numeric,
  p_reason          text DEFAULT NULL,
  p_actor           uuid DEFAULT NULL
) RETURNS treasury.account
LANGUAGE plpgsql AS $$
DECLARE
  a       treasury.account;
  v_actor uuid;
BEGIN
  v_actor := coalesce(p_actor, platform.current_actor());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'تغییر شرایط تسویه بدون کاربر عامل مجاز نیست. platform.set_actor() فراخوانی نشده است.';
  END IF;

  SELECT * INTO a FROM treasury.account WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'حساب خزانه % یافت نشد', p_account;
  END IF;

  -- فقط پایانه و درگاه تسویه می‌شوند. صندوق و حساب بانکی دوره تسویه
  -- ندارند و کارمزدشان معنا ندارد؛ قید `only_terminals_settle` هم
  -- همین را می‌گوید.
  IF a.kind NOT IN ('card_terminal','gateway') THEN
    RAISE EXCEPTION
      'حساب «%» از نوع «%» است و شرایط تسویه ندارد. فقط کارت‌خوان و درگاه.',
      a.name, a.kind;
  END IF;

  IF p_settlement_days IS NULL OR p_settlement_days < 0 OR p_settlement_days > 90 THEN
    RAISE EXCEPTION 'دوره تسویه باید بین ۰ و ۹۰ روز باشد (دریافت‌شده: %).', p_settlement_days;
  END IF;

  -- سقف ۱۰٪ سخاوتمندانه است: کارمزد واقعی کارت‌خوان در ایران کسری از
  -- درصد است. عددی مثل ۱۵ تقریباً همیشه یعنی کسی درصد و مبلغ را
  -- اشتباه گرفته — و آن اشتباه مستقیم در سند تسویه ضرب می‌شود.
  IF p_fee_percent IS NULL OR p_fee_percent < 0 OR p_fee_percent > 10 THEN
    RAISE EXCEPTION 'نرخ کارمزد باید بین ۰ و ۱۰ درصد باشد (دریافت‌شده: %).', p_fee_percent;
  END IF;

  IF a.settlement_days = p_settlement_days AND a.fee_percent = p_fee_percent THEN
    RETURN a;                          -- بدون تغییر، بدون لاگ
  END IF;

  PERFORM platform.audit(
    'treasury.settlement_terms', 'treasury_account', a.code,
    jsonb_build_object('settlement_days', p_settlement_days, 'fee_percent', p_fee_percent),
    v_actor, p_reason,
    jsonb_build_object('settlement_days', a.settlement_days, 'fee_percent', a.fee_percent));

  PERFORM set_config('labelmod.settlement_write', 'on', true);
  UPDATE treasury.account
     SET settlement_days = p_settlement_days,
         fee_percent     = p_fee_percent
   WHERE id = p_account
   RETURNING * INTO a;
  PERFORM set_config('labelmod.settlement_write', '', true);

  RETURN a;
END $$;

COMMENT ON FUNCTION treasury.set_settlement_terms IS
  'تنها مسیر تغییر دوره تسویه و نرخ کارمزد: اعتبارسنجی بازه، ردّ حسابرسی، مهر کاربر عامل.';

-- ---------------------------------------------------------------------
-- ۲. دروازه اجباری
-- ---------------------------------------------------------------------
-- همان الگوی `platform.setting_value_guard` و وضعیت چک: عددی که
-- مستقیم در سند مالی ضرب می‌شود، مستقیم نوشته نمی‌شود.
--
-- بقیه ستون‌ها آزادند — نام، شبا، حساب تسویه — چون هیچ‌کدام در
-- محاسبه مبلغ دخالت ندارند.

CREATE OR REPLACE FUNCTION treasury.settlement_terms_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.fee_percent IS DISTINCT FROM OLD.fee_percent
      OR NEW.settlement_days IS DISTINCT FROM OLD.settlement_days)
     AND coalesce(current_setting('labelmod.settlement_write', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'کارمزد و دوره تسویه حساب «%» فقط از treasury.set_settlement_terms() عوض می‌شوند.',
      OLD.code;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_terms_guard BEFORE UPDATE ON treasury.account
  FOR EACH ROW EXECUTE FUNCTION treasury.settlement_terms_guard();

-- ---------------------------------------------------------------------
-- ۳. دیدِ خواندنی برای صفحه تنظیمات
-- ---------------------------------------------------------------------
-- تا رابط کاربری لازم نباشد بداند «کدام نوع حساب تسویه می‌شود».

CREATE OR REPLACE VIEW treasury.settlement_terms AS
  SELECT a.id, a.code, a.name, a.kind,
         a.settlement_days, a.fee_percent, a.is_active,
         b.name AS settles_to
    FROM treasury.account a
    LEFT JOIN treasury.account b ON b.id = a.settlement_account_id
   WHERE a.kind IN ('card_terminal','gateway');

COMMIT;
