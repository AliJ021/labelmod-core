-- =====================================================================
-- ۰۱۹ — کدینگ حساب چهارسطحی و ویرایش‌پذیر
-- =====================================================================
-- مالک خواست کدینگ حساب همان قابلیت‌های هلو و دشت را داشته باشد. آن
-- نرم‌افزارها کدینگ **چهارسطحی** دارند — گروه ← کل ← معین ← تفصیلی —
-- و مال ما سه‌سطحی بود.
--
-- ── چرا این مهاجرت ارزان است ────────────────────────────────────────
--
-- **کد حساب‌ها عوض نمی‌شوند، فقط برچسب سطحشان.** `1101` همان `1101`
-- می‌ماند. یعنی `ledger.posting_rule`، `treasury.account` و هر سطر
-- سندی که تا امروز خورده، دست‌نخورده‌اند.
--
-- و بررسی شد که هیچ تابعی روی `level` شرط نمی‌گذارد: نگهبان ثبت سند
-- (`assert_postable_account`) روی `is_postable` است، نه روی سطح. پس
-- تغییر نام سطح رفتار مالی را عوض نمی‌کند.
--
-- نگاشت از روی **طول کد** انجام می‌شود، چون کدینگ فعلی همین ساختار را
-- دارد: یک‌رقمی گروه، دورقمی کل، چهاررقمی معین.
--
--   '1'    دارایی‌های جاری      →  group   (بود kol)
--   '11'   موجودی نقد و بانک    →  kol     (بود moin)
--   '1101' صندوق فروشگاه        →  moin    (بود tafsili)
--
-- سطح **تفصیلی** از این پس معنای واقعی‌اش را می‌گیرد: ریزِ شناور زیر
-- معین — مشتری، تأمین‌کننده، مرکز هزینه. الان خالی است و صفحه کدینگ
-- می‌تواند پرش کند.
--
-- ── چرا حالا و نه بعد ───────────────────────────────────────────────
--
-- هنوز سند واقعی ثبت نشده. بعد از ورود داده، تغییر ساختار کدینگ یعنی
-- دست‌زدن به دفتری که اظهارنامه از رویش ساخته می‌شود.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. سطح تازه
-- ---------------------------------------------------------------------

ALTER TABLE ledger.account DROP CONSTRAINT IF EXISTS account_level_check;

ALTER TABLE ledger.account
  ADD CONSTRAINT account_level_check
  CHECK (level IN ('group','kol','moin','tafsili'));

-- ترتیب عمدی است: از عمیق به کم‌عمق. اگر از بالا شروع می‌شد، سطر
-- چهاررقمی پیش از آنکه به `moin` برسد لحظه‌ای با والد `kol` ناسازگار
-- می‌ماند.
UPDATE ledger.account SET level = 'moin'  WHERE length(code) = 4 AND level = 'tafsili';
UPDATE ledger.account SET level = 'kol'   WHERE length(code) = 2 AND level = 'moin';
UPDATE ledger.account SET level = 'group' WHERE length(code) = 1 AND level = 'kol';

-- ---------------------------------------------------------------------
-- ۲. سلسله‌مراتب اجبار می‌شود، نه توصیه
-- ---------------------------------------------------------------------
-- بدون این، صفحه کدینگ می‌توانست یک معین را زیر یک معین دیگر ببرد و
-- گزارش‌های سلسله‌مراتبی بی‌صدا دوباره‌شماری کنند.
--
-- قاعده کد: کد فرزند باید با کد والد **شروع شود** و بلندتر باشد. این
-- از طول ثابت انعطاف‌پذیرتر است (کسی که ۹۹ حساب کل دارد به کد دورقمی
-- محدود نمی‌ماند) ولی همان چیزی را تضمین می‌کند که گزارش لازم دارد.

CREATE OR REPLACE FUNCTION ledger.assert_account_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent  ledger.account%ROWTYPE;
  v_expect  text;
BEGIN
  IF NEW.level = 'group' THEN
    IF NEW.parent_code IS NOT NULL THEN
      RAISE EXCEPTION 'حساب گروه والد ندارد (کد %).', NEW.code;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_code IS NULL THEN
    RAISE EXCEPTION 'حساب % از سطح «%» باید والد داشته باشد.', NEW.code, NEW.level;
  END IF;

  SELECT * INTO v_parent FROM ledger.account WHERE code = NEW.parent_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'حساب والد % یافت نشد.', NEW.parent_code;
  END IF;

  v_expect := CASE NEW.level
                WHEN 'kol'     THEN 'group'
                WHEN 'moin'    THEN 'kol'
                WHEN 'tafsili' THEN 'moin'
              END;

  IF v_parent.level <> v_expect THEN
    RAISE EXCEPTION
      'والد حساب «%» باید از سطح «%» باشد، ولی «%» از سطح «%» است.',
      NEW.level, v_expect, v_parent.code, v_parent.level;
  END IF;

  IF left(NEW.code, length(v_parent.code)) <> v_parent.code THEN
    RAISE EXCEPTION
      'کد حساب % باید با کد والدش (%) شروع شود.', NEW.code, v_parent.code;
  END IF;

  IF length(NEW.code) <= length(v_parent.code) THEN
    RAISE EXCEPTION
      'کد حساب % باید بلندتر از کد والدش (%) باشد.', NEW.code, v_parent.code;
  END IF;

  -- حسابی که فرزند دارد سند نمی‌پذیرد، وگرنه جمعِ سلسله‌مراتب دوباره
  -- شمرده می‌شود: یک بار روی خودش، یک بار روی فرزندانش.
  IF NEW.is_postable AND EXISTS (
       SELECT 1 FROM ledger.account WHERE parent_code = NEW.code) THEN
    RAISE EXCEPTION
      'حساب % فرزند دارد، پس نمی‌تواند سند بپذیرد.', NEW.code;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS assert_account_tree_t ON ledger.account;
CREATE TRIGGER assert_account_tree_t
  BEFORE INSERT OR UPDATE ON ledger.account
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_account_tree();

-- والد هم نباید بعداً قابل‌ثبت بماند: افزودن فرزند به حسابی که سند
-- می‌پذیرد، همان دوباره‌شماری را از راه دیگر می‌سازد.
CREATE OR REPLACE FUNCTION ledger.assert_parent_not_postable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_postable boolean;
BEGIN
  IF NEW.parent_code IS NULL THEN RETURN NEW; END IF;
  SELECT is_postable INTO v_postable FROM ledger.account WHERE code = NEW.parent_code;
  IF coalesce(v_postable, false) THEN
    RAISE EXCEPTION
      'حساب والد % سند می‌پذیرد؛ اول آن را غیرقابل‌ثبت کنید تا بتواند فرزند بگیرد.',
      NEW.parent_code;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS assert_parent_not_postable_t ON ledger.account;
CREATE TRIGGER assert_parent_not_postable_t
  BEFORE INSERT OR UPDATE ON ledger.account
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_parent_not_postable();

-- ---------------------------------------------------------------------
-- ۳. پیام نگهبان ثبت سند، با واقعیت تازه می‌خواند
-- ---------------------------------------------------------------------
-- پیش از این می‌گفت «فقط حساب تفصیلی». حالا حساب‌های قابل ثبت **معین**
-- هستند و تفصیلی یک سطح ریزتر است. پیامی که غلط باشد، بدتر از پیامی
-- است که نباشد — کاربر دنبال چیزی می‌گردد که وجود ندارد.

CREATE OR REPLACE FUNCTION ledger.assert_postable_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_postable boolean;
BEGIN
  SELECT is_postable INTO v_postable FROM ledger.account WHERE code = NEW.account_code;
  IF NOT coalesce(v_postable, false) THEN
    RAISE EXCEPTION
      'حساب % سند نمی‌پذیرد. فقط حسابی که «قابل ثبت» علامت خورده و فرزند ندارد مجاز است.',
      NEW.account_code;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- ۴. ساخت و ویرایش حساب — از صفحه، نه از psql
-- ---------------------------------------------------------------------
-- چرا تابع و نه `INSERT` مستقیم از API: قاعده پروژه می‌گوید عملیات
-- مالی ردّ حسابرسی می‌خواهد و کاربر عامل. یک `INSERT` خام هیچ‌کدام را
-- نمی‌دهد.

CREATE OR REPLACE FUNCTION ledger.upsert_account(
  p_code        text,
  p_name        text,
  p_level       text,
  p_parent      text,
  p_nature      text,
  p_type        text,
  p_is_postable boolean,
  p_user        uuid
) RETURNS ledger.account
LANGUAGE plpgsql AS $$
DECLARE
  v_old ledger.account%ROWTYPE;
  v_new ledger.account%ROWTYPE;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل برای تغییر کدینگ حساب اجباری است.';
  END IF;
  PERFORM platform.set_actor(p_user);

  IF coalesce(btrim(p_code), '') = '' THEN
    RAISE EXCEPTION 'کد حساب نمی‌تواند خالی باشد.';
  END IF;
  IF p_code !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'کد حساب فقط رقم می‌پذیرد (دریافت‌شده: %).', p_code;
  END IF;
  IF coalesce(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'نام حساب نمی‌تواند خالی باشد.';
  END IF;

  SELECT * INTO v_old FROM ledger.account WHERE code = p_code;

  -- تغییر ماهیت یا نوع حسابی که سند خورده، گزارش‌های گذشته را عوض
  -- می‌کند بدون اینکه سندی اصلاح شده باشد. جلویش گرفته می‌شود.
  IF FOUND AND (v_old.nature <> p_nature OR v_old.type <> p_type)
     AND EXISTS (SELECT 1 FROM ledger.journal_line WHERE account_code = p_code) THEN
    RAISE EXCEPTION
      'حساب % سند خورده است؛ ماهیت و نوعش دیگر عوض نمی‌شود. حساب تازه بسازید.',
      p_code;
  END IF;

  INSERT INTO ledger.account
    (code, parent_code, name, level, nature, type, is_postable)
  VALUES
    (p_code, p_parent, btrim(p_name), p_level, p_nature, p_type, coalesce(p_is_postable, false))
  ON CONFLICT (code) DO UPDATE
    SET parent_code = EXCLUDED.parent_code,
        name        = EXCLUDED.name,
        level       = EXCLUDED.level,
        nature      = EXCLUDED.nature,
        type        = EXCLUDED.type,
        is_postable = EXCLUDED.is_postable
  RETURNING * INTO v_new;

  PERFORM platform.audit(
    CASE WHEN v_old.code IS NULL THEN 'account.create' ELSE 'account.update' END,
    'ledger_account', p_code,
    jsonb_build_object(
      'before', CASE WHEN v_old.code IS NULL THEN NULL ELSE to_jsonb(v_old) END,
      'after',  to_jsonb(v_new)),
    p_user);

  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------
-- ۵. غیرفعال‌کردن — به‌جای حذف
-- ---------------------------------------------------------------------
-- حساب حذف نمی‌شود. اگر سند خورده باشد، حذفش دفتر را می‌شکند؛ و اگر
-- نخورده باشد هم فردا کسی دنبال کدش می‌گردد و نمی‌فهمد چه شد.
-- هلو هم همین کار را می‌کند.

CREATE OR REPLACE FUNCTION ledger.set_account_active(
  p_code   text,
  p_active boolean,
  p_user   uuid
) RETURNS ledger.account
LANGUAGE plpgsql AS $$
DECLARE v_row ledger.account%ROWTYPE;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل اجباری است.';
  END IF;
  PERFORM platform.set_actor(p_user);

  SELECT * INTO v_row FROM ledger.account WHERE code = p_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'حساب % یافت نشد.', p_code;
  END IF;

  -- غیرفعال‌کردن والدِ حسابِ فعال، شاخه را بی‌صدا از گزارش می‌اندازد.
  IF NOT p_active AND EXISTS (
       SELECT 1 FROM ledger.account WHERE parent_code = p_code AND is_active) THEN
    RAISE EXCEPTION
      'حساب % فرزند فعال دارد؛ اول آن‌ها را غیرفعال کنید.', p_code;
  END IF;

  UPDATE ledger.account SET is_active = p_active WHERE code = p_code
  RETURNING * INTO v_row;

  PERFORM platform.audit('account.set_active', 'ledger_account', p_code,
    jsonb_build_object('is_active', p_active), p_user);

  RETURN v_row;
END $$;

-- ---------------------------------------------------------------------
-- ۶. درخت حساب با جمع سند — برای صفحه
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW ledger.account_tree AS
SELECT a.code,
       a.parent_code,
       a.name,
       a.level,
       a.nature,
       a.type,
       a.is_postable,
       a.is_active,
       length(a.code)                                    AS depth,
       EXISTS (SELECT 1 FROM ledger.account c
                WHERE c.parent_code = a.code)            AS has_children,
       -- «سند خورده یا نه» تعیین می‌کند صفحه اجازه چه تغییری بدهد.
       EXISTS (SELECT 1 FROM ledger.journal_line l
                WHERE l.account_code = a.code)           AS has_entries
  FROM ledger.account a;

COMMIT;
