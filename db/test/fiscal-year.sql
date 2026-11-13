-- =====================================================================
-- تست بازکردن سال مالی بعد — `ledger.open_fiscal_year()` (مهاجرت ۱۱۷)
-- =====================================================================
-- ادعای مرکزی این پرونده **این نیست** که یک سطر در `ledger.fiscal_year`
-- می‌نشیند؛ آن را یک `INSERT` هم می‌کرد و همان «راه اضطراری» بود که کار
-- نمی‌کرد. ادعا این است که:
--
--   ۱. پیش از بازکردن، سند روز اول سال بعد **رد می‌شود** (کنترل منفی:
--      بی این، بند ۴ با سالی که از قبل بود هم سبز می‌شد).
--   ۲. سطر سال **بدون** شمارنده کافی نیست — بند ۲ همان راه اضطراری را
--      واقعاً می‌رود و خطای دومش را نشان می‌دهد.
--   ۳. پس از بازکردن، سند **واقعاً ثبت می‌شود** و شماره‌اش پیشوند سال تازه
--      را دارد؛ سند سال قبل همچنان شمارهٔ سال خودش را می‌گیرد.
--   ۴. شش راهِ غلط بسته‌اند (شکاف، هم‌پوشانی، طول، شماره، تکرار، دو سال جلوتر).
--   ۵. زنگ با **تاریخ صریح** سنجیده می‌شود، نه با ساعت دیواری.
--
-- ⚠️ سال‌ها از خودِ جدول خوانده می‌شوند، نه ۱۴۰۵/۱۴۰۶ ثابت: این پرونده
--    باید روزی که Seed سال دیگری بسازد هم همین ادعاها را بسنجد.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

-- خطا باید **همان** خطای مورد انتظار باشد، نه هر خطایی: «تابع وجود ندارد»
-- هم یک خطاست و ادعای «رد شد» را بی‌معنا سبز می‌کرد.
CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text, p_like text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE p_like THEN
      RAISE EXCEPTION E'\n  ✗ %\n      انتظار خطا مثل: %\n      واقعی : %', p_label, p_like, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  v_user uuid; v_last ledger.fiscal_year%ROWTYPE;
  v_new smallint; v_start date; v_end date;
  v_entry uuid; v_no text; v_n int; v_prev_counters int;
  v_legs text := $j$jsonb_build_array(
    jsonb_build_object('leg','cash',  'amount', 700000),
    jsonb_build_object('leg','sales', 'amount', 700000))$j$;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('fiscalyear','تست سال مالی') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);

SELECT * INTO v_last FROM ledger.fiscal_year ORDER BY ends_on DESC LIMIT 1;
v_new   := v_last.id + 1;
v_start := v_last.ends_on + 1;
v_end   := v_start + 364;
SELECT count(*) INTO v_prev_counters FROM platform.document_counter WHERE fiscal_year = v_last.id;

-- ضد‌پوچی: اگر سال قبل شمارنده نداشت، «شمارنده‌ها کپی شدند» بی‌معنا سبز می‌شد.
IF v_prev_counters < 5 THEN
  RAISE EXCEPTION 'سال % باید شمارنده‌های Seed را داشته باشد، دیدم %', v_last.id, v_prev_counters;
END IF;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. پیش از بازکردن: سند روز اول سال بعد رد می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بازکردن سال بی کاربر عامل',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new, v_start, v_end),
  '%بدون کاربر عامل%');

PERFORM platform.set_actor(v_user);

PERFORM pg_temp.assert_raises('سند در روزی که سال ندارد',
  format('SELECT ledger.post_entry(%L, %L::uuid, %L::date, %L, %s, NULL, NULL, %L::uuid, %L)',
         'sale_shift', BR, v_start, 'سند آزمون سال بعد', v_legs, v_user, 'final'),
  '%سال مالی برای تاریخ%تعریف نشده%');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. راه اضطراری «فقط یک سطر سال» کار نمی‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- همان INSERT دستی که بی این تابع تنها راه بود. زیرتراکنش برش می‌گرداند.

BEGIN
  INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status)
  VALUES (v_new, v_start, v_end, 'open');
  PERFORM pg_temp.assert_raises('سند با سالِ بی‌شمارنده',
    format('SELECT ledger.post_entry(%L, %L::uuid, %L::date, %L, %s, NULL, NULL, %L::uuid, %L)',
           'sale_shift', BR, v_start, 'سند آزمون سال بعد', v_legs, v_user, 'final'),
    '%شمارنده سند%تعریف نشده%');
  RAISE EXCEPTION 'برگشت آزمایشی' USING ERRCODE = 'LM001';
EXCEPTION WHEN SQLSTATE 'LM001' THEN NULL;
END;
PERFORM pg_temp.assert_eq('سطر دستی برگشت خورد',
  (SELECT count(*)::text FROM ledger.fiscal_year WHERE id = v_new), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. ورودی غلط رد می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('شمارهٔ سال غلط',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new + 1, v_start, v_end),
  '%سال مالی بعدی باید%');
PERFORM pg_temp.assert_raises('شکاف یک‌روزه',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new, v_start + 1, v_end + 1),
  '%باید از%شروع شود%');
PERFORM pg_temp.assert_raises('هم‌پوشانی یک‌روزه',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new, v_start - 1, v_end - 1),
  '%باید از%شروع شود%');
PERFORM pg_temp.assert_raises('سال یازده‌ماهه',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new, v_start, v_end - 30),
  '%۳۶۵ یا ۳۶۶ روز%');
PERFORM pg_temp.assert_raises('تاریخ تهی',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, NULL)', v_new, v_start),
  '%هر سه لازم‌اند%');
PERFORM pg_temp.assert_eq('هیچ‌کدام سالی نساخت',
  (SELECT count(*)::text FROM ledger.fiscal_year WHERE id >= v_new), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. بازکردن درست: سال، شمارنده‌ها، ردّ حسابرسی ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM ledger.open_fiscal_year(v_new, v_start, v_end);

PERFORM pg_temp.assert_eq('سال تازه باز است',
  (SELECT status || ' ' || starts_on || ' ' || ends_on FROM ledger.fiscal_year WHERE id = v_new),
  'open ' || v_start || ' ' || v_end);
PERFORM pg_temp.assert_eq('سال قبل دست نخورد',
  (SELECT status FROM ledger.fiscal_year WHERE id = v_last.id), v_last.status);
PERFORM pg_temp.assert_eq('شمار شمارنده‌های سال تازه = سال قبل',
  (SELECT count(*)::text FROM platform.document_counter WHERE fiscal_year = v_new), v_prev_counters::text);
PERFORM pg_temp.assert_eq('شمارنده‌های تازه از صفر',
  (SELECT coalesce(sum(last_no), 0)::text FROM platform.document_counter WHERE fiscal_year = v_new), '0');
PERFORM pg_temp.assert_eq('پیشوندی که هنوز سال قبل را دارد',
  (SELECT count(*)::text FROM platform.document_counter
    WHERE fiscal_year = v_new AND position(v_last.id::text IN prefix) > 0), '0');
PERFORM pg_temp.assert_eq('پیشوند مشترک میان دو سال',
  (SELECT count(*)::text FROM platform.document_counter a
     JOIN platform.document_counter b
       ON b.branch_id = a.branch_id AND b.doc_type = a.doc_type AND b.prefix = a.prefix
    WHERE a.fiscal_year = v_last.id AND b.fiscal_year = v_new), '0');
PERFORM pg_temp.assert_eq('ردّ حسابرسی با سال قبل و شمار شمارنده‌ها',
  (SELECT (after->>'previous_year') || ' ' || (after->>'counters') || ' ' || actor_id::text
     FROM platform.audit_log
    WHERE action = 'ledger.fiscal_year.open' AND entity_id = v_new::text),
  v_last.id || ' ' || v_prev_counters || ' ' || v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. سند روز اول سال بعد واقعاً ثبت می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

EXECUTE format('SELECT ledger.post_entry(%L, %L::uuid, %L::date, %L, %s, NULL, NULL, %L::uuid, %L)',
               'sale_shift', BR, v_start, 'سند آزمون سال بعد', v_legs, v_user, 'final')
  INTO v_entry;
SELECT number INTO v_no FROM ledger.journal_entry WHERE id = v_entry;
PERFORM pg_temp.assert_eq('سال سند',
  (SELECT fiscal_year::text FROM ledger.journal_entry WHERE id = v_entry), v_new::text);
PERFORM pg_temp.assert_eq('شمارهٔ سند پیشوند سال تازه را دارد',
  (position(v_new::text IN v_no) > 0)::text, 'true');

-- سند آخرین روز سال قبل هنوز شمارهٔ سال خودش را می‌گیرد: دو سال باز کنار هم.
EXECUTE format('SELECT ledger.post_entry(%L, %L::uuid, %L::date, %L, %s, NULL, NULL, %L::uuid, %L)',
               'sale_shift', BR, v_last.ends_on, 'سند معوق سال قبل', v_legs, v_user, 'final')
  INTO v_entry;
SELECT number INTO v_no FROM ledger.journal_entry WHERE id = v_entry;
PERFORM pg_temp.assert_eq('سند معوق در سال قبل می‌نشیند',
  (SELECT fiscal_year::text FROM ledger.journal_entry WHERE id = v_entry), v_last.id::text);
PERFORM pg_temp.assert_eq('و شمارهٔ سال قبل را می‌گیرد',
  (position(v_last.id::text IN v_no) > 0)::text, 'true');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. تکرار و «دو سال جلوتر» بسته‌اند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بازکردن دوبارهٔ همان سال',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new, v_start, v_end),
  '%سال مالی بعدی باید%');
PERFORM pg_temp.assert_raises('سال بعدِ سالی که هنوز شروع نشده',
  format('SELECT ledger.open_fiscal_year(%s::smallint, %L::date, %L::date)', v_new + 1, v_end + 1, v_end + 365),
  '%هنوز شروع نشده%');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. زنگ با تاریخ صریح ═══';
-- ═══════════════════════════════════════════════════════════════════
-- آخرین روز تعریف‌شده حالا `v_end` است.

PERFORM pg_temp.assert_eq('۶۱ روز مانده: خاموش',
  (SELECT n::text FROM ledger.fiscal_year_runway(v_end - 61)), '0');
PERFORM pg_temp.assert_eq('۶۰ روز مانده: خاموش (مرز)',
  (SELECT n::text FROM ledger.fiscal_year_runway(v_end - 60)), '0');
PERFORM pg_temp.assert_eq('۵۹ روز مانده: روشن و warn',
  (SELECT n::text || ' ' || severity FROM ledger.fiscal_year_runway(v_end - 59)), '1 warn');
PERFORM pg_temp.assert_eq('آخرین روز: روشن و warn',
  (SELECT n::text || ' ' || severity FROM ledger.fiscal_year_runway(v_end)), '1 warn');
PERFORM pg_temp.assert_eq('فردای آخرین روز: روشن و critical',
  (SELECT n::text || ' ' || severity FROM ledger.fiscal_year_runway(v_end + 1)), '1 critical');
PERFORM pg_temp.assert_eq('جزئیات آخرین روز را می‌گوید',
  (SELECT (position(v_end::text IN detail) > 0)::text FROM ledger.fiscal_year_runway(v_end)), 'true');

-- زنگ در فهرست واحد هست و عددش همان تابع است — دو تعریف نه.
PERFORM pg_temp.assert_eq('زنگ در platform.health_alerts() همان عدد را می‌دهد',
  (SELECT n::text || ' ' || severity FROM platform.health_alerts() WHERE code = 'fiscal_year_ending'),
  (SELECT n::text || ' ' || severity FROM ledger.fiscal_year_runway(platform.business_date())));

RAISE NOTICE E'\n✔ سال مالی بعد — کنترل منفی، راه اضطراریِ ناکافی، نگهبان‌ها، سند واقعی، و زنگ';
END $test$;

ROLLBACK;
