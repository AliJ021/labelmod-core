-- =====================================================================
-- ۰۰۸ — تنظیمات قابل ویرایش: فراداده، اعتبارسنجی، و یک در ورودی
-- =====================================================================
-- تا امروز `platform.setting` یک جدول کلید/مقدار بود که فقط با psql
-- عوض می‌شد. CLAUDE.md می‌گوید «تصمیم‌های باز داده‌اند نه کد، تا
-- تغییرشان UPDATE باشد نه Deploy» — ولی UPDATE دستی سه مشکل داشت:
--
-- ۱. **هیچ اعتبارسنجی‌ای نبود.** `UPDATE … SET value = '"شاید"'` روی
--    `tax.enabled` می‌نشست و هیچ‌کس تا اولین فاکتور نمی‌فهمید. مقدار
--    یک تنظیم مالی، خودش داده مالی است.
--
-- ۲. **هیچ ردی نمی‌گذاشت.** «چه کسی نرخ مالیات را عوض کرد و کِی؟»
--    پاسخ نداشت. `updated_by` یک ستون بود که هیچ‌کس پرش نمی‌کرد.
--
-- ۳. **قابل ساختن در رابط کاربری نبود.** جدول نمی‌دانست کدام کلید
--    بله/خیر است و کدام درصد؛ پس هر صفحه تنظیماتی ناچار بود فهرست
--    کلیدها را در کد تکرار کند — یعنی همان hardcode که ممنوع است.
--
-- این مهاجرت هر سه را می‌بندد: فراداده در خودِ سطر می‌نشیند،
-- `platform.set_setting()` تنها در ورودی می‌شود، و مجوز هم داده است
-- (ستون `permission`) نه شرطی در کد.
--
-- ⚠️ مهاجرت‌های ۰۰۱ تا ۰۰۷ ویرایش نشدند: روی main نشسته‌اند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. فراداده — کافی برای ساختن صفحه تنظیمات بدون یک خط کد اختصاصی
-- ---------------------------------------------------------------------
-- پیش‌فرض‌ها عمداً **محافظه‌کارانه**‌اند: کلیدی که هنوز فراداده ندارد
-- `kind = 'json'` و `is_editable = false` می‌گیرد و مجوزش سخت‌گیرانه‌ترین
-- است. یعنی افزودن یک کلید تازه بدون فکر، آن را از مسیر API باز
-- نمی‌کند — باید صریح در seed توصیفش کنی.

ALTER TABLE platform.setting
  ADD COLUMN kind        text    NOT NULL DEFAULT 'json',
  ADD COLUMN label       text,
  ADD COLUMN group_key   text    NOT NULL DEFAULT 'other',
  ADD COLUMN options     jsonb,
  ADD COLUMN min_value   numeric,
  ADD COLUMN max_value   numeric,
  ADD COLUMN unit        text,
  ADD COLUMN help        text,
  ADD COLUMN sort_order  int     NOT NULL DEFAULT 900,
  ADD COLUMN permission  text    NOT NULL DEFAULT 'settings.security',
  ADD COLUMN is_editable boolean NOT NULL DEFAULT false;

ALTER TABLE platform.setting
  ADD CONSTRAINT setting_kind_ck CHECK (kind IN
    ('bool','int','money','percent','choice','multichoice','text','json')),
  -- گزینه‌دار بدون گزینه یعنی یک فهرست خالی در رابط کاربری و یک
  -- اعتبارسنجی که همیشه رد می‌کند. جلویش همین‌جا گرفته می‌شود.
  ADD CONSTRAINT setting_options_ck CHECK (
    (kind NOT IN ('choice','multichoice') OR jsonb_typeof(options) = 'array')
    AND (options IS NULL OR jsonb_typeof(options) = 'array')),
  ADD CONSTRAINT setting_range_ck CHECK (
    min_value IS NULL OR max_value IS NULL OR min_value <= max_value);

COMMENT ON COLUMN platform.setting.kind IS
  'نوع مقدار — تعیین‌کننده اعتبارسنجی در set_setting و ویجت در رابط کاربری.';
COMMENT ON COLUMN platform.setting.permission IS
  'عملیاتی که identity.can() برای تغییر این تنظیم می‌سنجد. مجوز داده است، نه شرطی در کد.';
COMMENT ON COLUMN platform.setting.is_editable IS
  'کلید بدون فراداده از مسیر API تغییر نمی‌کند. پیش‌فرض false عمدی است.';

-- ---------------------------------------------------------------------
-- ۲. تنها در ورودی
-- ---------------------------------------------------------------------
-- چهار کار می‌کند و هر چهار اجباری‌اند:
--   • قفل سطر، تا دو تغییر هم‌زمان یکی را بی‌صدا نبلعد
--   • اعتبارسنجی مقدار در برابر kind، options و بازه
--   • ثبت حسابرسی با مقدار پیش و پس
--   • مهر زدن updated_by از کاربر عامل همان تراکنش
--
-- عمداً **کلید تازه نمی‌سازد.** کلید ناموجود خطا می‌دهد، نه INSERT —
-- وگرنه یک غلط تایپی یک تنظیم خیالی می‌ساخت که هیچ کدی نمی‌خواندش و
-- کاربر فکر می‌کرد چیزی را تنظیم کرده است.

CREATE OR REPLACE FUNCTION platform.set_setting(
  p_key    text,
  p_value  jsonb,
  p_reason text DEFAULT NULL,
  p_actor  uuid DEFAULT NULL
) RETURNS platform.setting
LANGUAGE plpgsql AS $$
DECLARE
  s         platform.setting;
  v_actor   uuid;
  v_num     numeric;
  v_text    text;
  v_allowed text[];
  v_el      jsonb;
BEGIN
  v_actor := coalesce(p_actor, platform.current_actor());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'تغییر تنظیمات بدون کاربر عامل مجاز نیست. platform.set_actor() فراخوانی نشده است.';
  END IF;

  SELECT * INTO s FROM platform.setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'تنظیم «%» وجود ندارد. کلید تازه فقط از مسیر مهاجرت و seed ساخته می‌شود.', p_key;
  END IF;

  IF NOT s.is_editable THEN
    RAISE EXCEPTION 'تنظیم «%» از این مسیر قابل تغییر نیست.', p_key;
  END IF;

  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RAISE EXCEPTION 'مقدار تنظیم «%» نمی‌تواند خالی باشد.', p_key;
  END IF;

  -- تنظیمی که تصویب حسابدار یا مشاور می‌خواهد، بی‌دلیل عوض نمی‌شود.
  -- «دلیل» تنها چیزی است که شش ماه بعد توضیح می‌دهد چرا نرخ عوض شد.
  IF s.requires_approval AND coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION
      'تغییر تنظیم «%» نیازمند ثبت دلیل است؛ این تنظیم تصویب مسئول مالی را لازم دارد.', p_key;
  END IF;

  CASE s.kind
    WHEN 'bool' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط بله یا خیر می‌پذیرد.', p_key;
      END IF;

    WHEN 'int' THEN
      IF jsonb_typeof(p_value) <> 'number' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط عدد صحیح می‌پذیرد.', p_key;
      END IF;
      v_num := (p_value #>> '{}')::numeric;
      IF v_num <> trunc(v_num) THEN
        RAISE EXCEPTION 'تنظیم «%» فقط عدد صحیح می‌پذیرد، نه اعشاری.', p_key;
      END IF;

    WHEN 'percent' THEN
      IF jsonb_typeof(p_value) <> 'number' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط عدد می‌پذیرد (درصد).', p_key;
      END IF;
      v_num := (p_value #>> '{}')::numeric;

    -- پول در JSON **رشته** است، نه عدد. قاعده غیرقابل مذاکره پروژه؛
    -- number جاوااسکریپت مبالغ ریالی بزرگ را بی‌صدا گرد می‌کند.
    WHEN 'money' THEN
      IF jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'تنظیم «%» مبلغ ریالی است و باید رشته‌ای از ارقام باشد، بدون اعشار.', p_key;
      END IF;
      v_num := (p_value #>> '{}')::numeric;

    WHEN 'text' THEN
      IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط متن می‌پذیرد.', p_key;
      END IF;

    WHEN 'choice' THEN
      IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'تنظیم «%» باید یکی از گزینه‌های تعریف‌شده باشد.', p_key;
      END IF;
      SELECT array_agg(o->>'value') INTO v_allowed
        FROM jsonb_array_elements(s.options) o;
      v_text := p_value #>> '{}';
      IF NOT (v_text = ANY (v_allowed)) THEN
        RAISE EXCEPTION 'مقدار «%» برای تنظیم «%» مجاز نیست. گزینه‌های مجاز: %',
          v_text, p_key, array_to_string(v_allowed, '، ');
      END IF;

    WHEN 'multichoice' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'تنظیم «%» فهرستی از گزینه‌هاست.', p_key;
      END IF;
      SELECT array_agg(o->>'value') INTO v_allowed
        FROM jsonb_array_elements(s.options) o;
      FOR v_el IN SELECT jsonb_array_elements(p_value) LOOP
        IF jsonb_typeof(v_el) <> 'string' THEN
          RAISE EXCEPTION 'هر عضو تنظیم «%» باید متن باشد.', p_key;
        END IF;
        v_text := v_el #>> '{}';
        IF NOT (v_text = ANY (v_allowed)) THEN
          RAISE EXCEPTION 'مقدار «%» برای تنظیم «%» مجاز نیست. گزینه‌های مجاز: %',
            v_text, p_key, array_to_string(v_allowed, '، ');
        END IF;
      END LOOP;

    ELSE
      NULL;                                    -- json: شکل آزاد
  END CASE;

  IF v_num IS NOT NULL THEN
    IF s.min_value IS NOT NULL AND v_num < s.min_value THEN
      RAISE EXCEPTION 'تنظیم «%» نمی‌تواند کمتر از % باشد.', p_key, s.min_value;
    END IF;
    IF s.max_value IS NOT NULL AND v_num > s.max_value THEN
      RAISE EXCEPTION 'تنظیم «%» نمی‌تواند بیشتر از % باشد.', p_key, s.max_value;
    END IF;
  END IF;

  -- تغییری که چیزی را عوض نمی‌کند، رویدادی نیست. نه لاگ می‌خواهد نه
  -- مهر زمان تازه — وگرنه «آخرین تغییر» با هر بار باز و بسته‌کردن فرم
  -- جابه‌جا می‌شود و معنایش را از دست می‌دهد.
  IF s.value IS NOT DISTINCT FROM p_value THEN
    RETURN s;
  END IF;

  PERFORM platform.audit(
    'setting.change', 'platform_setting', p_key,
    jsonb_build_object('key', p_key, 'value', p_value),
    v_actor, p_reason,
    jsonb_build_object('key', p_key, 'value', s.value));

  -- پرچم فقط برای همین یک UPDATE روشن می‌شود و بلافاصله خاموش:
  -- `is_local = true` یعنی در پایان تراکنش هم خودبه‌خود پاک می‌شود، پس
  -- در Pool اشتراکی به درخواست بعدی نشت نمی‌کند.
  PERFORM set_config('labelmod.setting_write', 'on', true);

  UPDATE platform.setting
     SET value = p_value, updated_at = now(), updated_by = v_actor
   WHERE key = p_key
   RETURNING * INTO s;

  PERFORM set_config('labelmod.setting_write', '', true);

  RETURN s;
END $$;

COMMENT ON FUNCTION platform.set_setting IS
  'تنها مسیر تغییر تنظیمات: قفل سطر، اعتبارسنجی نوع و بازه، ثبت حسابرسی، مهر کاربر عامل.';

-- ---------------------------------------------------------------------
-- ۳. خواننده‌های نوع‌دار
-- ---------------------------------------------------------------------
-- توابع دیتابیس تا امروز هر جا تنظیمی لازم داشتند، خودشان
-- `SELECT (value)::int … coalesce(…, 180)` می‌نوشتند. یعنی پیش‌فرض در
-- چند جا تکرار می‌شد و یک کلید حذف‌شده بی‌صدا به عددی برمی‌گشت که
-- هیچ‌کجا مستند نبود. این سه تابع همان کار را یک‌جا می‌کنند.

CREATE OR REPLACE FUNCTION platform.setting_json(p_key text, p_default jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value FROM platform.setting WHERE key = p_key), p_default);
$$;

CREATE OR REPLACE FUNCTION platform.setting_int(p_key text, p_default int DEFAULT NULL)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::int FROM platform.setting WHERE key = p_key),
                  p_default);
$$;

CREATE OR REPLACE FUNCTION platform.setting_num(p_key text, p_default numeric DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::numeric FROM platform.setting WHERE key = p_key),
                  p_default);
$$;

CREATE OR REPLACE FUNCTION platform.setting_bool(p_key text, p_default boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::boolean FROM platform.setting WHERE key = p_key),
                  p_default);
$$;

CREATE OR REPLACE FUNCTION platform.setting_text(p_key text, p_default text DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value #>> '{}' FROM platform.setting WHERE key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------
-- ۳.۵ شکافی که تست یکپارچه پیدا کرد: PIN و تنظیمات
-- ---------------------------------------------------------------------
-- بند ۱ SECURITY.md می‌گوید PIN هرگز عملیات حساس را مجاز نمی‌کند، و
-- `auth.pin_forbidden_operations` همان فهرست است. ولی تا امروز هیچ
-- عملیات تنظیماتی در آن نبود — چون صفحه تنظیمات وجود نداشت.
--
-- حالا که دارد وجود پیدا می‌کند، بدون این دو سطر یک صندوق‌دار که فقط
-- صفحه را با PIN باز کرده می‌توانست سقف تخفیف یا مهلت مرجوعی را عوض
-- کند — یعنی همان دفاعی که PIN را «عامل دوم نیست» می‌کند، از یک در
-- تازه دور زده می‌شد. تست یکپارچه این را گرفت، نه بازخوانی کد.
--
-- Idempotent و **فقط افزودنی**: اگر مالک عمداً عملیاتی را از فهرست
-- برداشته باشد، این مهاجرت آن را برنمی‌گرداند.

UPDATE platform.setting
   SET value = value || '["settings.manage"]'::jsonb
 WHERE key = 'auth.pin_forbidden_operations' AND NOT (value ? 'settings.manage');

UPDATE platform.setting
   SET value = value || '["settings.security"]'::jsonb
 WHERE key = 'auth.pin_forbidden_operations' AND NOT (value ? 'settings.security');

-- ---------------------------------------------------------------------
-- ۳.۶ دروازه اجباری: مقدار تنظیم فقط از set_setting عوض می‌شود
-- ---------------------------------------------------------------------
-- تا اینجا «تنها در ورودی» یک **قرارداد** بود، نه یک قفل: هر
-- `UPDATE platform.setting SET value = …` هنوز کار می‌کرد و نه
-- اعتبارسنجی می‌شد، نه ردّ حسابرسی می‌گذاشت. نقش اپلیکیشن هم روی این
-- جدول UPDATE دارد (بند ۳ SECURITY.md فقط `audit_log` و
-- `stock_movement` را بسته است).
--
-- همان الگویی که برای وضعیت چک به کار رفت: ستونی که Projection یا
-- خروجی یک تابع است، مستقیم نوشته نمی‌شود.
--
-- **فقط `value` قفل است، نه فراداده.** `db/seed/030_settings.sql`
-- باید بتواند برچسب، گزینه و بازه را با اجرای دوباره تازه کند؛ آن
-- UPDATE مقدار را دست نمی‌زند و از این نگهبان بی‌مانع رد می‌شود.
--
-- مهاجرت‌های بعدی که واقعاً باید یک مقدار را جابه‌جا کنند، پیش از
-- UPDATE پرچم را روشن می‌کنند — درست مثل مسیر پاکسازی
-- `identity.auth_attempt`. یعنی دور زدن ممکن است، ولی **صریح** است و
-- در diff مهاجرت دیده می‌شود.

CREATE OR REPLACE FUNCTION platform.setting_value_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value IS DISTINCT FROM OLD.value
     AND coalesce(current_setting('labelmod.setting_write', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'مقدار تنظیم «%» فقط از platform.set_setting() عوض می‌شود؛ UPDATE مستقیم پذیرفته نیست.',
      OLD.key;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER setting_value_guard BEFORE UPDATE ON platform.setting
  FOR EACH ROW EXECUTE FUNCTION platform.setting_value_guard();

-- ---------------------------------------------------------------------
-- ۴. گروه‌های صفحه تنظیمات
-- ---------------------------------------------------------------------
-- نام و ترتیب گروه‌ها هم داده است، نه یک آرایه در کد React. اگر فردا
-- گروه تازه‌ای لازم شد، یک INSERT است.

CREATE TABLE platform.setting_group (
  key        text PRIMARY KEY,
  title      text NOT NULL,
  subtitle   text,
  sort_order int  NOT NULL DEFAULT 900
);

COMMIT;
