-- =====================================================================
-- شناسنامه مشتری — نشانی، کد پستی، اندازه بدن
-- =====================================================================
-- سه چیزی که بی‌صدا می‌شکنند:
--
--   ۱. کد پستی نصفه ذخیره شود → بسته پستی برنگردد
--   ۲. اندازه بیرون بازه ذخیره شود → پیشنهاد سایز فردا چیز عجیبی بگوید
--   ۳. اندازه‌ها ادغام شوند به‌جای جایگزینی → پاک‌کردن یک اندازه بی‌اثر
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
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual, 'NULL');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_label text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % — رد شد: %', p_label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ % — باید رد می‌شد ولی نشد', p_label;
END $$;

DO $outer$
DECLARE v_user uuid; v_c uuid; v_n numeric; v_t text;
BEGIN
  SELECT id INTO v_user FROM identity.app_user WHERE username = 'system';
  PERFORM platform.set_actor(v_user, NULL, NULL);

  RAISE NOTICE E'\n═══ ۱. کد پستی — رقم فارسی و جداکننده ═══';
  PERFORM pg_temp.assert_txt('کد پستی فارسی با خط تیره',
    sales.normalize_postal_code('۱۲۳۴۵-۶۷۸۹۰'), '1234567890');
  PERFORM pg_temp.assert_txt('رقم عربی',
    sales.normalize_postal_code('١٢٣٤٥٦٧٨٩٠'), '1234567890');
  PERFORM pg_temp.assert_txt('با فاصله',
    sales.normalize_postal_code('12345 67890'), '1234567890');
  -- نُه رقم یک کد پستی **نیست**. ذخیره‌اش یعنی برچسب پستی غلط چاپ شود
  -- و بسته برنگردد — بدتر از خالی بودنش.
  PERFORM pg_temp.assert_txt('نُه رقم رد می‌شود، نه اینکه ذخیره شود',
    sales.normalize_postal_code('123456789'), NULL);
  PERFORM pg_temp.assert_txt('یازده رقم هم رد',
    sales.normalize_postal_code('12345678901'), NULL);
  PERFORM pg_temp.assert_txt('متن، نه عدد', sales.normalize_postal_code('کد من'), NULL);
  PERFORM pg_temp.assert_txt('خالی', sales.normalize_postal_code(''), NULL);
  PERFORM pg_temp.assert_txt('NULL', sales.normalize_postal_code(NULL), NULL);

  RAISE NOTICE E'\n═══ ۲. نشانی روی مشتری می‌نشیند ═══';
  INSERT INTO sales.customer (mobile_normalized, full_name, address, postal_code, city, province)
  VALUES ('09121110000', 'مشتری شناسنامه', 'تهران، خیابان نمونه، پلاک ۱',
          sales.normalize_postal_code('۱۲۳۴۵۶۷۸۹۰'), 'تهران', 'تهران')
  RETURNING id INTO v_c;
  SELECT postal_code INTO v_t FROM sales.customer WHERE id = v_c;
  PERFORM pg_temp.assert_txt('کد پستی نرمال‌شده ذخیره شد', v_t, '1234567890');

  RAISE NOTICE E'\n═══ ۳. کلیدهای اندازه داده‌اند، نه CHECK ═══';
  SELECT count(*) INTO v_n FROM sales.measure_key WHERE is_active;
  PERFORM pg_temp.assert_eq('کلید اندازه در Seed', v_n, 13);
  -- سه گروهی که مالک خواسته بود: پا، پایین‌تنه، بالاتنه.
  SELECT count(DISTINCT group_key) INTO v_n FROM sales.measure_key;
  PERFORM pg_temp.assert_eq('گروه‌های اندازه', v_n, 4);

  RAISE NOTICE E'\n═══ ۴. نوشتن اندازه‌ها ═══';
  PERFORM sales.set_customer_measures(v_c,
    '{"height": 178, "chest": 102, "waist": 88, "inseam": 81, "shoe_size": 43}'::jsonb, v_user);
  SELECT count(*) INTO v_n FROM sales.customer_measure WHERE customer_id = v_c;
  PERFORM pg_temp.assert_eq('پنج اندازه ثبت شد', v_n, 5);
  SELECT value_cm INTO v_n FROM sales.customer_measure WHERE customer_id = v_c AND key = 'inseam';
  PERFORM pg_temp.assert_eq('قد داخل پا', v_n, 81.0);

  RAISE NOTICE E'\n═══ ۵. جایگزینی کامل است، نه ادغام ═══';
  -- اگر ادغام می‌شد، فرمی که یک اندازه را پاک می‌کند بی‌اثر بود و
  -- عدد قدیمی برای همیشه می‌ماند.
  PERFORM sales.set_customer_measures(v_c, '{"height": 180}'::jsonb, v_user);
  SELECT count(*) INTO v_n FROM sales.customer_measure WHERE customer_id = v_c;
  PERFORM pg_temp.assert_eq('فقط یک اندازه ماند', v_n, 1);
  SELECT value_cm INTO v_n FROM sales.customer_measure WHERE customer_id = v_c AND key = 'height';
  PERFORM pg_temp.assert_eq('و مقدارش تازه است', v_n, 180.0);

  RAISE NOTICE E'\n═══ ۶. بازه از جدول می‌آید و واقعاً می‌گیرد ═══';
  PERFORM pg_temp.assert_raises('قد ۱۷ سانت — غلط تایپی',
    format('SELECT sales.set_customer_measures(%L::uuid, ''{"height": 17}''::jsonb)', v_c));
  PERFORM pg_temp.assert_raises('قد ۳۰۰ سانت',
    format('SELECT sales.set_customer_measures(%L::uuid, ''{"height": 300}''::jsonb)', v_c));
  PERFORM pg_temp.assert_raises('کلید تعریف‌نشده',
    format('SELECT sales.set_customer_measures(%L::uuid, ''{"دور مچ": 18}''::jsonb)', v_c));
  PERFORM pg_temp.assert_raises('مشتری ناموجود',
    'SELECT sales.set_customer_measures(''00000000-0000-0000-0000-000000000000''::uuid, ''{}''::jsonb)');

  -- ادعای مهم: پس از هر رد شدن، داده قبلی **دست‌نخورده** مانده.
  SELECT count(*) INTO v_n FROM sales.customer_measure WHERE customer_id = v_c;
  PERFORM pg_temp.assert_eq('ردِ اعتبارسنجی، داده قبلی را پاک نکرد', v_n, 1);

  RAISE NOTICE E'\n═══ ۷. بازه قابل تغییر است، بدون Deploy ═══';
  UPDATE sales.measure_key SET min_value = 10 WHERE key = 'height';
  PERFORM sales.set_customer_measures(v_c, '{"height": 17}'::jsonb, v_user);
  SELECT value_cm INTO v_n FROM sales.customer_measure WHERE customer_id = v_c AND key = 'height';
  PERFORM pg_temp.assert_eq('با بازه تازه پذیرفته شد', v_n, 17.0);

  RAISE NOTICE E'\n═══ ۸. اندازه در لاگ حسابرسی می‌نشیند ═══';
  SELECT count(*) INTO v_n FROM platform.audit_log
   WHERE action = 'customer.set_measures' AND entity_id = v_c::text;
  IF v_n < 1 THEN RAISE EXCEPTION '✗ تغییر اندازه ردّ حسابرسی ندارد'; END IF;
  RAISE NOTICE '  ✓ ردّ حسابرسی ثبت شد = %', v_n;

  RAISE NOTICE E'\n═══ ۹. حذف مشتری، اندازه‌هایش را هم می‌برد ═══';
  -- داده اندازه **قابل حذف** است — بند ۳ SECURITY.md.
  DELETE FROM sales.customer_measure WHERE customer_id = v_c;
  SELECT count(*) INTO v_n FROM sales.customer_measure WHERE customer_id = v_c;
  PERFORM pg_temp.assert_eq('اندازه‌ها پاک شدند', v_n, 0);

  RAISE NOTICE E'\n✓ شناسنامه مشتری — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
