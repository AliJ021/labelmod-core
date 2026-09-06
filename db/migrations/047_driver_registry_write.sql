-- =====================================================================
-- ۰۴۷ — نوشتن در رجیستری درایور: افزودن، ویرایش مستندات، بازنشستگی
-- =====================================================================
--
-- ── چه چیزی در ۰۴۶ جا ماند ──────────────────────────────────────────
--
-- مهاجرت ۰۴۶ خودش نوشت: «افزودن سامان‌کیش یا به‌پرداخت باید یک
-- INSERT باشد، نه یک مهاجرت — دقیقاً همان دلیلی که مالک گفت: ممکن
-- است زیادتر شوند.»
--
-- ولی راهی برای آن INSERT نساخت. `platform.device_driver` فقط از
-- `db/seed/048_device_drivers.sql` پر می‌شد و `sdk_doc_url` هیچ مسیری
-- برای عوض‌شدن نداشت. یعنی خواسته مالک — «مستندات SDK باید از طریق
-- تنظیمات قابل جایگزاری یا تغییر باشد» — نصفه ماند: جدولش بود،
-- دستگیره‌اش نه. رسیدن یک کارت‌خوان تازه باز هم psql می‌خواست.
--
-- این مهاجرت آن دستگیره است.
--
-- ── آنچه از این مسیر عوض **نمی‌شود** ────────────────────────────────
--
-- `is_implemented` عمداً پارامتر هیچ‌کدام از این توابع نیست.
--
-- آن ستون یک **واقعیت درباره کد این مخزن** است، نه یک تنظیم: یعنی
-- «Handler این درایور نوشته شده». اگر از صفحه تنظیمات روشن می‌شد،
-- دقیقاً همان نگهبانی را که ۰۴۶ ساخت دور می‌زد — مالک درایور تازه را
-- ثبت می‌کرد، `is_implemented` را روشن می‌کرد، پایانه را وصل می‌کرد،
-- و اولین پرداخت واقعی در سکوت شکست می‌خورد. روشن‌شدنش فقط با
-- مهاجرتی که هم‌زمان کدِ Handler را می‌آورد.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۰. نویسه ممنوع — یک تعریف در SQL، مثل `lib/text.ts` در TypeScript
-- ---------------------------------------------------------------------
-- دو دسته، هر دو با پیامد دیدنی:
--   • کنترلی‌های C0/C1 و DEL — در فهرست دیده نمی‌شوند، خروجی را خراب
--     می‌کنند.
--   • نشانه‌های جهت‌دهی دوطرفه — ظاهر متن را **وارونه** نشان می‌دهند
--     بدون اینکه محتوا عوض شود. روی فهرستی که مالک از رویش کارت‌خوان
--     انتخاب می‌کند، یعنی انتخابِ چیزی غیر از آنچه چشم خوانده.
--
-- ⚠️ با `chr()` نوشته شده، نه با خودِ نویسه. یک کنترلی خام در سورس
--    نامرئی است و گیت کل فایل را باینری می‌بیند — همان اتفاقی که یک
--    بار در این مخزن افتاد و ۳۴ مسیر خرید را ماه‌ها بدون Diff از
--    بازبینی رد کرد.
CREATE OR REPLACE FUNCTION platform.has_control_chars(p_text text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_text, '') ~ (
    '[' || chr(1)    || '-' || chr(31)                       -- C0
        || chr(127)  || '-' || chr(159)                      -- DEL + C1
        || chr(8206) || chr(8207)                            -- LRM, RLM
        || chr(8234) || '-' || chr(8238)                     -- LRE..RLO
        || chr(8294) || '-' || chr(8297)                     -- ایزوله‌های جهت
        || ']');
$$;

COMMENT ON FUNCTION platform.has_control_chars IS
  'نویسه کنترلی یا جهت‌دهی دوطرفه دارد؟ همان تعریف apps/api/src/lib/text.ts.';


-- ---------------------------------------------------------------------
-- ۱. افزودن یا ویرایش یک درایور
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.upsert_device_driver(
  p_code        text,
  p_label       text,
  p_kind        text,
  p_vendor      text     DEFAULT NULL,
  p_sdk_doc_url text     DEFAULT NULL,
  p_notes       text     DEFAULT NULL,
  p_sort_order  smallint DEFAULT 100,
  p_reason      text     DEFAULT NULL,
  p_user        uuid     DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_code   text := lower(btrim(coalesce(p_code, '')));
  v_label  text := btrim(coalesce(p_label, ''));
  v_vendor text := nullif(btrim(coalesce(p_vendor, '')), '');
  v_url    text := nullif(btrim(coalesce(p_sdk_doc_url, '')), '');
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
  v_before jsonb;
BEGIN
  IF v_code = '' THEN RAISE EXCEPTION 'کد درایور خالی است.'; END IF;
  IF v_code !~ '^[a-z0-9_-]{2,40}$' THEN
    RAISE EXCEPTION 'کد درایور فقط حرف کوچک انگلیسی، رقم، خط تیره و زیرخط دارد (۲ تا ۴۰ نویسه).';
  END IF;
  IF v_label = '' THEN RAISE EXCEPTION 'نام درایور خالی است.'; END IF;
  IF length(v_label) > 100 THEN RAISE EXCEPTION 'نام درایور بلندتر از ۱۰۰ نویسه است.'; END IF;

  -- نوع دستگاه صریح سنجیده می‌شود، نه با تکیه به CHECK جدول: نقض
  -- CHECK کد ۲۳۵۱۴ می‌دهد و `errors.ts` آن را ۵۰۰ گزارش می‌کند —
  -- دفاعی که شبیه خرابی سرور دیده شود، در عمل خاموش است.
  IF p_kind NOT IN ('card_terminal','printer','scale','scanner') THEN
    RAISE EXCEPTION 'نوع دستگاه «%» شناخته نیست. یکی از: کارت‌خوان، چاپگر، ترازو، اسکنر.', p_kind;
  END IF;

  IF platform.has_control_chars(v_label) OR platform.has_control_chars(v_vendor)
  OR platform.has_control_chars(v_notes) OR platform.has_control_chars(v_url) THEN
    RAISE EXCEPTION 'متن شامل نویسه کنترلی است.';
  END IF;

  -- نشانی مستندات را مالک کلیک می‌کند. `https` اجباری است، به همان
  -- دلیل `notify.webhook_url`.
  IF v_url IS NOT NULL AND v_url !~ '^https://' THEN
    RAISE EXCEPTION 'نشانی مستندات باید با https:// شروع شود.';
  END IF;
  IF v_url IS NOT NULL AND length(v_url) > 500 THEN
    RAISE EXCEPTION 'نشانی مستندات بلندتر از ۵۰۰ نویسه است.';
  END IF;
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'یادداشت فنی بلندتر از ۲۰۰۰ نویسه است.';
  END IF;

  -- ⚠️ `notes` و `sdk_doc_url` هر دو در `audit_log` می‌نشینند و صفحه
  --    تنظیمات نشانشان می‌دهد. راز — کلید API، رمز پایانه، توکن —
  --    اینجا نمی‌نشیند؛ از متغیر محیطی می‌آید مثل `SMS_API_KEY`.
  --    این سنجش هر رازی را نمی‌گیرد، ولی همان شکلی را می‌گیرد که آدم
  --    از روی مستندات PSP کپی می‌کند.
  IF coalesce(v_notes,'') || ' ' || coalesce(v_url,'')
     ~* '(api[_ -]?key|secret|password|passwd|access[_ -]?token|bearer)[[:space:]]*[:=]' THEN
    RAISE EXCEPTION 'راز در رجیستری درایور ذخیره نمی‌شود. کلید و رمز از متغیر محیطی می‌آیند.';
  END IF;

  SELECT to_jsonb(d) INTO v_before FROM platform.device_driver d WHERE d.code = v_code;

  IF v_before IS NULL THEN
    -- ⚠️ `is_implemented` ست نمی‌شود — پیش‌فرض `false` می‌ماند.
    INSERT INTO platform.device_driver
      (code, label, device_kind, vendor, sdk_doc_url, notes, sort_order)
    VALUES
      (v_code, v_label, p_kind, v_vendor, v_url, v_notes,
       coalesce(p_sort_order, 100::smallint));
  ELSE
    -- ⚠️ `is_implemented` و `is_active` دست‌نخورده می‌مانند: اولی از
    --    این مسیر عوض نمی‌شود، دومی تابع خودش را دارد.
    UPDATE platform.device_driver
       SET label       = v_label,
           device_kind = p_kind,
           vendor      = v_vendor,
           sdk_doc_url = v_url,
           notes       = v_notes,
           sort_order  = coalesce(p_sort_order, sort_order)
     WHERE code = v_code;
  END IF;

  PERFORM platform.audit(
    CASE WHEN v_before IS NULL THEN 'platform.add_driver' ELSE 'platform.edit_driver' END,
    'device_driver', v_code,
    (SELECT to_jsonb(d) FROM platform.device_driver d WHERE d.code = v_code),
    p_user, p_reason, v_before);
END $$;

COMMENT ON FUNCTION platform.upsert_device_driver IS
  'افزودن یا ویرایش یک درایور و مستندات SDK آن. is_implemented از این مسیر عوض نمی‌شود.';


-- ---------------------------------------------------------------------
-- ۲. بازنشستگی و بازگرداندن
-- ---------------------------------------------------------------------
-- حذف نمی‌شود: `treasury.account.driver_code` به آن ارجاع دارد و
-- `audit_log` تاریخچه‌اش را نگه داشته. بازنشستگی یعنی از فهرست
-- انتخاب بیرون می‌رود.
CREATE OR REPLACE FUNCTION platform.set_device_driver_active(
  p_code   text,
  p_active boolean,
  p_reason text DEFAULT NULL,
  p_user   uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_code text := lower(btrim(coalesce(p_code, ''))); v_was boolean; v_used int;
BEGIN
  SELECT is_active INTO v_was FROM platform.device_driver WHERE code = v_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'درایور «%» تعریف نشده است.', p_code; END IF;
  IF v_was IS NOT DISTINCT FROM p_active THEN RETURN; END IF;

  -- ⚠️ نگهبان اصلی این تابع.
  --
  -- `treasury.set_device_driver()` فقط **در لحظه اتصال** می‌سنجد که
  -- درایور فعال است. اگر بشود درایوری را که یک پایانه به آن وصل است
  -- بی‌صدا غیرفعال کرد، آن پایانه به درایوری اشاره می‌کند که دیگر در
  -- هیچ فهرستی نیست و هیچ‌کس دوباره نمی‌بیندش. اول پایانه را جدا
  -- کنید، بعد درایور را بازنشسته.
  IF NOT p_active THEN
    SELECT count(*) INTO v_used FROM treasury.account WHERE driver_code = v_code;
    IF v_used > 0 THEN
      RAISE EXCEPTION 'این درایور روی % پایانه فعال است. اول پایانه‌ها را از آن جدا کنید.', v_used;
    END IF;
  END IF;

  UPDATE platform.device_driver SET is_active = p_active WHERE code = v_code;

  PERFORM platform.audit('platform.driver_active', 'device_driver', v_code,
    jsonb_build_object('is_active', p_active),
    p_user, p_reason, jsonb_build_object('is_active', v_was));
END $$;

COMMENT ON FUNCTION platform.set_device_driver_active IS
  'بازنشستگی یا بازگرداندن یک درایور. درایورِ در استفاده بازنشسته نمی‌شود.';
