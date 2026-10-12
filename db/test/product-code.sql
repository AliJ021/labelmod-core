-- =====================================================================
-- کد خودکار کالا (مهاجرت ۰۹۴) — یکتا، هم‌الگو، و برنده‌بودنِ کد دستی
-- =====================================================================
-- هم‌زمانی واقعی (چند درخواست موازی) در
-- `apps/api/test/product-pricing.integration.test.ts` سنجیده می‌شود؛ اینجا
-- قرارداد تابع روی یک نشست.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

DO $test$
DECLARE
  a text; b text; c text; n0 bigint; n1 bigint; v_seq bigint; v_user uuid;
  v_last bigint; v_called boolean;
BEGIN
  INSERT INTO identity.app_user (username, full_name) VALUES ('pcode','تست کد کالا') RETURNING id INTO v_user;
  PERFORM platform.set_actor(v_user);
  SELECT count(*) INTO n0 FROM catalog.product;

  RAISE NOTICE E'\n═══ ۱. الگو و یکتایی ═══';
  a := catalog.next_product_code();
  b := catalog.next_product_code();
  PERFORM pg_temp.assert_eq('الگوی LM + پنج رقم', (a ~ '^LM[0-9]{5,}$')::text, 'true');
  PERFORM pg_temp.assert_eq('همان الگوی کد دستی API', (a ~ '^[A-Za-z0-9][A-Za-z0-9-]*$' AND length(a) <= 24)::text, 'true');
  IF a = b THEN RAISE EXCEPTION 'دو فراخوان یک کد دادند: %', a; END IF;
  PERFORM pg_temp.assert_eq('پشت‌هم و صعودی', (substring(b FROM 3)::bigint - substring(a FROM 3)::bigint)::text, '1');

  RAISE NOTICE E'\n═══ ۲. تابع چیزی نمی‌نویسد — هیچ کالا، SKU یا بارکدی ═══';
  SELECT count(*) INTO n1 FROM catalog.product;
  PERFORM pg_temp.assert_eq('بی درج کالا', n1::text, n0::text);

  RAISE NOTICE E'\n═══ ۳. کد دستیِ هم‌نام برنده است (حتی با حروف کوچک) ═══';
  v_seq := substring(b FROM 3)::bigint;
  -- دو عدد بعدی را کسی پیش‌تر دستی گرفته است.
  PERFORM catalog.upsert_product(NULL, 'lm' || lpad((v_seq + 1)::text, 5, '0'), 'کالای دستی ۱');
  PERFORM catalog.upsert_product(NULL, 'LM' || lpad((v_seq + 2)::text, 5, '0'), 'کالای دستی ۲');
  c := catalog.next_product_code();
  PERFORM pg_temp.assert_eq('از دو کد دستی عبور کرد', c, 'LM' || lpad((v_seq + 3)::text, 5, '0'));

  RAISE NOTICE E'\n═══ ۴. کد خودکار واقعاً درج می‌شود و تکرارش رد می‌شود ═══';
  PERFORM catalog.upsert_product(NULL, c, 'کالای خودکار');
  PERFORM pg_temp.assert_eq('درج با کد خودکار', (SELECT name_internal FROM catalog.product WHERE code = c), 'کالای خودکار');
  BEGIN
    PERFORM catalog.upsert_product(NULL, c, 'تکراری');
    RAISE EXCEPTION 'کد تکراری پذیرفته شد';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '  ✓ کد تکراری روی قید یکتایی رد شد';
  END;

  RAISE NOTICE E'\n═══ ۵. پس از ۹۹۹۹۹ رقم ششم، نه کوتاه‌شدن (lpad) ═══';
  -- `setval` تراکنشی نیست و با ROLLBACK برنمی‌گردد؛ پس مقدار پیشین صریح برگردانده می‌شود.
  SELECT last_value, is_called INTO v_last, v_called FROM catalog.product_code_seq;
  PERFORM setval('catalog.product_code_seq', 99999, false);
  a := catalog.next_product_code();
  b := catalog.next_product_code();
  c := catalog.next_product_code();
  PERFORM setval('catalog.product_code_seq', v_last, v_called);
  PERFORM pg_temp.assert_eq('۹۹۹۹۹', a, 'LM99999');
  PERFORM pg_temp.assert_eq('۱۰۰۰۰۰ شش رقمی', b, 'LM100000');
  PERFORM pg_temp.assert_eq('۱۰۰۰۰۱', c, 'LM100001');

  RAISE NOTICE E'\n✔ کد خودکار کالا — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
