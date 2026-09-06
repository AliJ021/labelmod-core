-- =====================================================================
-- رجیستری درایور دستگاه
-- =====================================================================
-- ادعای مرکزی: **درایورِ پیاده‌نشده به پایانه وصل نمی‌شود.**
--
-- ثبت یک درایور یعنی «مستنداتش را داریم»، نه «کار می‌کند». بدون این
-- تفکیک، مالک یک کارت‌خوان را انتخاب می‌کرد و اولین پرداخت واقعی در
-- سکوت شکست می‌خورد — یا بدتر، معلق می‌ماند و پول مشتری بلاتکلیف.
--
-- ادعای دوم: **راز در تنظیمات دستگاه نمی‌نشیند.** مقدار هر تنظیم در
-- `audit_log` می‌رود و صفحه تنظیمات نشانش می‌دهد.
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(p_label text, p_actual numeric, p_expected numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual,'NULL');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_label text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % — رد شد: %', p_label, left(SQLERRM, 80); RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ % — باید رد می‌شد ولی نشد', p_label;
END $$;

DO $outer$
DECLARE
  v_user uuid; v_pos uuid; v_gw uuid; v_cash uuid;
  v_n numeric; v_t text; v_b boolean;
BEGIN
  SELECT id INTO v_user FROM identity.app_user WHERE username='system';
  PERFORM platform.set_actor(v_user, NULL, NULL);
  SELECT id INTO v_pos  FROM treasury.account WHERE code='POS-1';
  SELECT id INTO v_gw   FROM treasury.account WHERE code='GW-1';
  SELECT id INTO v_cash FROM treasury.account WHERE code='CASH-MAIN';

  RAISE NOTICE E'\n═══ ۱. درایورها ثبت‌اند ولی هیچ‌کدام پیاده نشده ═══';
  SELECT count(*) INTO v_n FROM platform.device_driver WHERE is_active;
  PERFORM pg_temp.assert_eq('درایورهای Seed', v_n, 8);
  -- ⚠️ مهم‌ترین ادعای این پرونده در حال حاضر: مستندات SDK نیامده،
  --    پس هیچ Handlerی نوشته نشده. اگر روزی این عدد بالا رفت، یعنی
  --    کسی واقعاً کدش را نوشته — و آن یک تصمیم آگاهانه است.
  SELECT count(*) INTO v_n FROM platform.device_driver WHERE is_implemented;
  PERFORM pg_temp.assert_eq('هیچ درایوری هنوز پیاده نشده', v_n, 0);
  SELECT count(*) INTO v_n FROM platform.device_driver WHERE device_kind='card_terminal';
  PERFORM pg_temp.assert_eq('کارت‌خوان‌های شناخته‌شده', v_n, 7);

  RAISE NOTICE E'\n═══ ۲. درایورِ پیاده‌نشده وصل نمی‌شود ═══';
  PERFORM pg_temp.assert_raises('درایور بدون کد، رد',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'sep')$q$, v_pos));
  PERFORM pg_temp.assert_raises('درایور تعریف‌نشده، رد',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'unknown_psp')$q$, v_pos));

  RAISE NOTICE E'\n═══ ۳. پس از پیاده‌سازی، وصل می‌شود ═══';
  UPDATE platform.device_driver SET is_implemented = true WHERE code='sep';
  PERFORM treasury.set_device_driver(v_pos, 'sep',
    '{"ip":"192.168.1.50","port":8080,"terminal_no":"12345678"}'::jsonb,
    'نصب کارت‌خوان فروشگاه', v_user);
  SELECT driver_code INTO v_t FROM treasury.account WHERE id=v_pos;
  PERFORM pg_temp.assert_txt('درایور وصل شد', v_t, 'sep');
  SELECT driver_config->>'terminal_no' INTO v_t FROM treasury.account WHERE id=v_pos;
  PERFORM pg_temp.assert_txt('پارامتر غیرمحرمانه ذخیره شد', v_t, '12345678');

  RAISE NOTICE E'\n═══ ۴. راز در تنظیمات دستگاه نمی‌نشیند ═══';
  -- مقدار این ستون در `audit_log` می‌رود و صفحه تنظیمات نشانش
  -- می‌دهد. کلید و رمز از متغیر محیطی می‌آیند، مثل `SMS_API_KEY`.
  PERFORM pg_temp.assert_raises('کلید API رد می‌شود',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'sep', '{"api_key":"secret"}'::jsonb)$q$, v_pos));
  PERFORM pg_temp.assert_raises('رمز رد می‌شود',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'sep', '{"password":"1234"}'::jsonb)$q$, v_pos));
  PERFORM pg_temp.assert_raises('token رد می‌شود',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'sep', '{"token":"abc"}'::jsonb)$q$, v_pos));
  -- و پس از هر رد شدن، تنظیم قبلی دست‌نخورده مانده.
  SELECT driver_config->>'ip' INTO v_t FROM treasury.account WHERE id=v_pos;
  PERFORM pg_temp.assert_txt('ردِ اعتبارسنجی تنظیم قبلی را خراب نکرد', v_t, '192.168.1.50');

  RAISE NOTICE E'\n═══ ۵. فقط پایانه درایور دارد ═══';
  -- صندوق نقدی دستگاهی ندارد که به آن وصل شود.
  PERFORM pg_temp.assert_raises('صندوق نقدی درایور نمی‌گیرد',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'sep')$q$, v_cash));
  PERFORM pg_temp.assert_raises('قید جدول هم همین را می‌گوید',
    format($q$UPDATE treasury.account SET driver_code='sep' WHERE id=%L::uuid$q$, v_cash));

  RAISE NOTICE E'\n═══ ۶. هر پایانه درایور خودش را دارد ═══';
  -- کارت‌خوان فروشگاه و درگاه سایت یک دستگاه نیستند — همان دلیلی که
  -- کارمزد و دوره تسویه هم به‌ازای هر پایانه‌اند.
  SELECT driver_code INTO v_t FROM treasury.account WHERE id=v_gw;
  PERFORM pg_temp.assert_txt('درگاه سایت هنوز درایور ندارد', v_t, NULL);
  UPDATE platform.device_driver SET is_implemented = true WHERE code='parsian';
  PERFORM treasury.set_device_driver(v_gw, 'parsian', '{}'::jsonb, NULL, v_user);
  SELECT driver_code INTO v_t FROM treasury.account WHERE id=v_gw;
  PERFORM pg_temp.assert_txt('و حالا درایور متفاوتی دارد', v_t, 'parsian');
  SELECT driver_code INTO v_t FROM treasury.account WHERE id=v_pos;
  PERFORM pg_temp.assert_txt('کارت‌خوان فروشگاه دست‌نخورده', v_t, 'sep');

  RAISE NOTICE E'\n═══ ۷. برداشتن درایور ═══';
  PERFORM treasury.set_device_driver(v_gw, NULL, '{}'::jsonb, 'قطع موقت', v_user);
  SELECT driver_code INTO v_t FROM treasury.account WHERE id=v_gw;
  PERFORM pg_temp.assert_txt('درایور برداشته شد', v_t, NULL);

  RAISE NOTICE E'\n═══ ۸. نما و ردّ حسابرسی ═══';
  SELECT count(*) INTO v_n FROM treasury.terminal_driver;
  PERFORM pg_temp.assert_eq('نما فقط پایانه‌ها را می‌دهد', v_n, 2);
  SELECT is_implemented INTO v_b FROM treasury.terminal_driver WHERE account_code='POS-1';
  IF NOT v_b THEN RAISE EXCEPTION '✗ نما باید وضعیت پیاده‌سازی را بدهد'; END IF;
  RAISE NOTICE '  ✓ نما وضعیت پیاده‌سازی را نشان می‌دهد';

  SELECT count(*) INTO v_n FROM platform.audit_log WHERE action='treasury.set_driver';
  IF v_n < 3 THEN RAISE EXCEPTION '✗ تغییر درایور ردّ حسابرسی ندارد: %', v_n; END IF;
  RAISE NOTICE '  ✓ ردّ حسابرسی ثبت شد = %', v_n;

  -- ===================================================================
  -- نوشتن در رجیستری — مهاجرت ۰۴۷
  -- ===================================================================
  -- خواسته مالک: «مستندات SDK باید از طریق تنظیمات قابل جایگزاری یا
  -- تغییر باشد، چون هم ممکن است کارت‌خوان‌ها عوض شوند و هم ممکن است
  -- زیادتر شوند.» ۰۴۶ جدولش را ساخت، ۰۴۷ دستگیره‌اش را.

  RAISE NOTICE E'\n═══ ۹. افزودن یک دستگاه تازه ═══';
  PERFORM platform.upsert_device_driver(
    'novinpay', 'پرداخت نوین', 'card_terminal', 'نوین',
    'https://docs.example.com/novinpay', 'پروتکل نسخه ۲.۱', 15::smallint,
    'کارت‌خوان تازه نصب شد', v_user);
  SELECT label INTO v_t FROM platform.device_driver WHERE code='novinpay';
  PERFORM pg_temp.assert_txt('دستگاه تازه ثبت شد', v_t, 'پرداخت نوین');
  -- ⚠️ بحرانی‌ترین ادعای این بخش. اگر `is_implemented` از این مسیر
  --    روشن می‌شد، مالک دستگاهی را که کدش نوشته نشده وصل می‌کرد و
  --    اولین پرداخت واقعی در سکوت شکست می‌خورد.
  SELECT is_implemented INTO v_b FROM platform.device_driver WHERE code='novinpay';
  IF v_b THEN RAISE EXCEPTION '✗ دستگاه تازه نباید «پیاده‌شده» باشد'; END IF;
  RAISE NOTICE '  ✓ دستگاه تازه «فقط ثبت‌شده» است، نه «پیاده‌شده»';
  PERFORM pg_temp.assert_raises('وصل‌کردن دستگاه تازه، رد',
    format($q$SELECT treasury.set_device_driver(%L::uuid, 'novinpay')$q$, v_gw));

  RAISE NOTICE E'\n═══ ۱۰. ویرایش مستندات SDK ═══';
  PERFORM platform.upsert_device_driver(
    'novinpay', 'پرداخت نوین', 'card_terminal', 'نوین',
    'https://docs.example.com/novinpay/v3', 'پروتکل نسخه ۳', 15::smallint,
    'مستندات تازه رسید', v_user);
  SELECT sdk_doc_url INTO v_t FROM platform.device_driver WHERE code='novinpay';
  PERFORM pg_temp.assert_txt('نشانی مستندات عوض شد', v_t,
    'https://docs.example.com/novinpay/v3');
  -- ویرایش هم نباید `is_implemented` را جابه‌جا کند — حتی وقتی از
  -- قبل روشن است. `sep` در بخش ۳ روشن شد.
  PERFORM platform.upsert_device_driver('sep', 'سامان کیش (SEP)', 'card_terminal',
    'سامان کیش', NULL, NULL, 10::smallint, 'تغییر نام', v_user);
  SELECT is_implemented INTO v_b FROM platform.device_driver WHERE code='sep';
  IF NOT v_b THEN RAISE EXCEPTION '✗ ویرایش نباید is_implemented را خاموش کند'; END IF;
  RAISE NOTICE '  ✓ ویرایش، is_implemented را دست نمی‌زند';

  RAISE NOTICE E'\n═══ ۱۱. آنچه رد می‌شود ═══';
  PERFORM pg_temp.assert_raises('کد با فاصله، رد',
    $q$SELECT platform.upsert_device_driver('bad code', 'x', 'card_terminal')$q$);
  PERFORM pg_temp.assert_raises('کد خالی، رد',
    $q$SELECT platform.upsert_device_driver('  ', 'x', 'card_terminal')$q$);
  PERFORM pg_temp.assert_raises('نام خالی، رد',
    $q$SELECT platform.upsert_device_driver('okcode', '   ', 'card_terminal')$q$);
  PERFORM pg_temp.assert_raises('نوع ناشناخته، رد',
    $q$SELECT platform.upsert_device_driver('okcode', 'x', 'robot')$q$);
  -- نشانی مستندات را مالک کلیک می‌کند؛ `https` اجباری است.
  PERFORM pg_temp.assert_raises('نشانی http، رد',
    $q$SELECT platform.upsert_device_driver('okcode','x','card_terminal',NULL,'http://a.example')$q$);
  -- ⚠️ `notes` در `audit_log` می‌نشیند و صفحه تنظیمات نشانش می‌دهد.
  PERFORM pg_temp.assert_raises('راز در یادداشت، رد',
    $q$SELECT platform.upsert_device_driver('okcode','x','card_terminal',NULL,NULL,'api_key: ABC123')$q$);
  PERFORM pg_temp.assert_raises('رمز در یادداشت، رد',
    $q$SELECT platform.upsert_device_driver('okcode','x','card_terminal',NULL,NULL,'password = 1234')$q$);
  -- نویسه جهت‌دهی دوطرفه می‌تواند نام را وارونه نشان دهد بدون اینکه
  -- محتوا عوض شود — روی فهرستی که مالک از رویش انتخاب می‌کند، یعنی
  -- انتخابِ چیزی غیر از آنچه چشم خوانده.
  PERFORM pg_temp.assert_raises('نویسه جهت‌دهی در نام، رد',
    format($q$SELECT platform.upsert_device_driver('okcode', %L, 'card_terminal')$q$,
           'کارت' || chr(8238) || 'خوان'));
  SELECT count(*) INTO v_n FROM platform.device_driver WHERE code='okcode';
  PERFORM pg_temp.assert_eq('هیچ‌کدام از ورودی‌های بد ننشست', v_n, 0);
  IF NOT platform.has_control_chars(chr(8206)) THEN
    RAISE EXCEPTION '✗ آشکارساز نویسه کنترلی باید LRM را بگیرد';
  END IF;
  IF platform.has_control_chars('کارت‌خوان سامان') THEN
    RAISE EXCEPTION '✗ آشکارساز نباید متن سالم را رد کند';
  END IF;
  RAISE NOTICE '  ✓ آشکارساز نویسه کنترلی تفکیک می‌کند، نه اینکه همیشه رد کند';

  RAISE NOTICE E'\n═══ ۱۲. بازنشستگی ═══';
  -- ⚠️ `set_device_driver()` فقط در لحظه اتصال فعال‌بودن را می‌سنجد.
  --    بازنشستگی بی‌صدای درایورِ در استفاده یعنی پایانه‌ای که به چیزی
  --    اشاره می‌کند که در هیچ فهرستی نیست.
  PERFORM pg_temp.assert_raises('بازنشستگی درایورِ در استفاده، رد',
    $q$SELECT platform.set_device_driver_active('sep', false)$q$);
  PERFORM platform.set_device_driver_active('novinpay', false, 'قرارداد لغو شد', v_user);
  SELECT is_active INTO v_b FROM platform.device_driver WHERE code='novinpay';
  IF v_b THEN RAISE EXCEPTION '✗ درایور بازنشسته نشد'; END IF;
  RAISE NOTICE '  ✓ درایور بی‌استفاده بازنشسته شد';
  -- حذف نمی‌شود — سطرش می‌ماند تا بشود برش گرداند و تا ارجاع
  -- `treasury.account.driver_code` نشکند.
  SELECT count(*) INTO v_n FROM platform.device_driver WHERE code='novinpay';
  PERFORM pg_temp.assert_eq('سطر بازنشسته حذف نشد', v_n, 1);
  PERFORM platform.set_device_driver_active('novinpay', true, 'قرارداد برگشت', v_user);
  SELECT is_active INTO v_b FROM platform.device_driver WHERE code='novinpay';
  IF NOT v_b THEN RAISE EXCEPTION '✗ درایور برنگشت'; END IF;
  RAISE NOTICE '  ✓ درایور بازنشسته برگشت';
  PERFORM pg_temp.assert_raises('بازنشستگی درایور ناشناخته، رد',
    $q$SELECT platform.set_device_driver_active('nope', false)$q$);

  SELECT count(*) INTO v_n FROM platform.audit_log
   WHERE action IN ('platform.add_driver','platform.edit_driver','platform.driver_active');
  -- دقیقاً پنج: افزودن novinpay، ویرایش novinpay، ویرایش sep، و دو بار
  -- تغییر وضعیت. ورودی‌های ردشده ردّی نمی‌گذارند چون اصلاً ننشستند.
  PERFORM pg_temp.assert_eq('ردّ حسابرسی رجیستری', v_n, 5);

  RAISE NOTICE E'\n✓ رجیستری درایور — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
