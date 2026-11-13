-- =====================================================================
-- تست ایندکس‌های پرداخت — مهاجرت ۱۱۹
-- =====================================================================
-- وجود یک ایندکس چیزی را ثابت نمی‌کند اگر برنامه‌ریز نتواند برای کوئری
-- واقعی از آن استفاده کند (ایندکس جزئی با محمولی که کوئری ایجابش نمی‌کند،
-- همین‌طور بی‌صدا بی‌مصرف می‌ماند). پس دو ادعا:
--
--   ۱. هر دو ایندکس در کاتالوگ هستند، معتبرند و جزئی‌اند.
--   ۲. برای همان شکلِ کوئری که `finalize_invoice` و `post_return` دارند
--      (`WHERE invoice_id = …` و `WHERE return_id = …`) برنامه‌ریز **می‌تواند**
--      از آن‌ها استفاده کند.
--
-- ⚠️ `enable_seqscan = off` فقط می‌پرسد «آیا این ایندکس قابل استفاده است؟»؛
--    روی جدول خالیِ آزمون، برنامه‌ریز بی آن همیشه Seq Scan را ارزان‌تر می‌بیند.
--    ادعای عملکرد نیست — آن با دادهٔ حجیم سنجیده می‌شود.
-- ⚠️ بند ۳ **کنترل منفی** است: کوئری روی ستونی که ایندکس ندارد باید حتی با
--    همان تنظیم Seq Scan بماند، وگرنه بند ۲ همیشه سبز می‌شد.
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

CREATE OR REPLACE FUNCTION pg_temp.plan_of(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_line text; v_plan text := '';
BEGIN
  FOR v_line IN EXECUTE 'EXPLAIN ' || p_sql LOOP
    v_plan := v_plan || v_line || E'\n';
  END LOOP;
  RETURN v_plan;
END $$;

DO $test$
DECLARE v_plan text;
BEGIN

RAISE NOTICE E'\n═══ ۱. ایندکس‌ها در کاتالوگ ═══';

PERFORM pg_temp.assert_eq('ایندکس معتبر و جزئی روی invoice_id',
  (SELECT count(*)::text FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'treasury.payment'::regclass
      AND c.relname = 'payment_invoice_id_idx'
      AND i.indisvalid AND i.indpred IS NOT NULL
      AND pg_get_indexdef(i.indexrelid) LIKE '%(invoice_id)%'), '1');
PERFORM pg_temp.assert_eq('ایندکس معتبر و جزئی روی return_id',
  (SELECT count(*)::text FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'treasury.payment'::regclass
      AND c.relname = 'payment_return_id_idx'
      AND i.indisvalid AND i.indpred IS NOT NULL
      AND pg_get_indexdef(i.indexrelid) LIKE '%(return_id)%'), '1');

RAISE NOTICE E'\n═══ ۲. برنامه‌ریز می‌تواند از آن‌ها استفاده کند ═══';

SET LOCAL enable_seqscan = off;

v_plan := pg_temp.plan_of($q$SELECT sum(amount) FROM treasury.payment
  WHERE invoice_id = '00000000-0000-7000-8000-00000000aaaa' AND direction = 'in'$q$);
PERFORM pg_temp.assert_eq('پرداخت‌های یک فاکتور از ایندکس می‌آید',
  (position('payment_invoice_id_idx' IN v_plan) > 0)::text, 'true');

v_plan := pg_temp.plan_of($q$SELECT sum(amount) FROM treasury.payment
  WHERE return_id = '00000000-0000-7000-8000-00000000bbbb'$q$);
PERFORM pg_temp.assert_eq('پرداخت‌های یک مرجوعی از ایندکس می‌آید',
  (position('payment_return_id_idx' IN v_plan) > 0)::text, 'true');

RAISE NOTICE E'\n═══ ۳. کنترل منفی: ستون بی‌ایندکس Seq Scan می‌ماند ═══';

v_plan := pg_temp.plan_of($q$SELECT sum(amount) FROM treasury.payment WHERE note = 'x'$q$);
PERFORM pg_temp.assert_eq('کوئری روی note هیچ‌کدام از دو ایندکس تازه را نمی‌گیرد',
  (position('payment_invoice_id_idx' IN v_plan) + position('payment_return_id_idx' IN v_plan))::text, '0');

RAISE NOTICE E'\n✔ ایندکس‌های پرداخت — کاتالوگ، قابل‌استفاده‌بودن، و کنترل منفی';
END $test$;

ROLLBACK;
