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

  RAISE NOTICE E'\n✓ رجیستری درایور — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
