-- =====================================================================
-- تست نگاشت حساب — `ledger.set_posting_rule()`
-- =====================================================================
-- ادعای مرکزی این پرونده **این نیست** که تابع یک ستون را عوض می‌کند؛
-- آن را یک `UPDATE` هم می‌کرد. ادعا این است که:
--
--   ۱. تغییر نگاشت **واقعاً اثر می‌گذارد** — سند بعدی روی حساب تازه
--      می‌نشیند. بند ۶ بدون این، فقط یک ستون را می‌سنجید.
--   ۲. شش راهِ غلط بسته‌اند، از جمله یکی که هیچ خطایی نمی‌داد و
--      ترازنامه را بی‌صدا غلط می‌کرد: نگاشت درآمد به حساب دارایی.
--   ۳. ردّ حسابرسی **مقدار پیش و پس** دارد — وگرنه «چه کسی درآمد را
--      به حساب دیگری برد» جواب ندارد.
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

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  v_user uuid; v_n int; v_code text; v_entry uuid; v_rows int;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('maprule','تست نگاشت حساب') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. نما — صفحه از همین می‌خواند ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM ledger.posting_rule_overview;
IF v_n < 50 THEN
  RAISE EXCEPTION 'نمای نگاشت باید همهٔ قواعد Seed را نشان دهد، دیدم %', v_n;
END IF;
RAISE NOTICE '  ✓ شمار قواعد در نما = %', v_n;

-- ضد‌پوچی: نما باید **JOIN شده** باشد، نه فقط جدول خام. اگر نام حساب
-- تهی برگردد، صفحه فهرستی از کد بی‌معنا نشان می‌دهد.
SELECT count(*) INTO v_n FROM ledger.posting_rule_overview
 WHERE account_name IS NULL OR account_type IS NULL;
PERFORM pg_temp.assert_eq('سطرهای نما بدون نام یا نوع حساب', v_n::text, '0');

PERFORM pg_temp.assert_eq('حساب فعلی «فروش کالا»',
  (SELECT account_code FROM ledger.posting_rule_overview
    WHERE event_type='sale_shift' AND leg='sales'), '4101');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. شش راه غلط ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بدون دلیل',
  $$SELECT ledger.set_posting_rule('sale_shift','sales','credit','4202','',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);

PERFORM pg_temp.assert_raises('قاعده‌ای که وجود ندارد',
  $$SELECT ledger.set_posting_rule('sale_shift','no_such_leg','credit','4202','دلیل',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);

PERFORM pg_temp.assert_raises('حسابی که در کدینگ نیست',
  $$SELECT ledger.set_posting_rule('sale_shift','sales','credit','9999','دلیل',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);

PERFORM pg_temp.assert_raises('همان حساب فعلی',
  $$SELECT ledger.set_posting_rule('sale_shift','sales','credit','4101','دلیل',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);

-- حساب سطح میانی: FK رضایت می‌دهد و اولین فروشِ بعدی رد می‌شود.
PERFORM pg_temp.assert_raises('حساب غیرقابل ثبت (سطح میانی)',
  $$SELECT ledger.set_posting_rule('sale_shift','sales','credit','41','دلیل',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);

-- و مهم‌ترینش: نوع حساب. ۴۱۰۲ کاهندهٔ درآمد است نه درآمد.
PERFORM pg_temp.assert_raises('نوع حساب متفاوت (contra_revenue به‌جای revenue)',
  $$SELECT ledger.set_posting_rule('sale_shift','sales','credit','4102','دلیل',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. حساب غیرفعال هم رد می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

UPDATE ledger.account SET is_active = false WHERE code = '4202';
PERFORM pg_temp.assert_raises('حساب غیرفعال',
  $$SELECT ledger.set_posting_rule('sale_shift','sales','credit','4202','دلیل',
      (SELECT id FROM identity.app_user WHERE username='maprule'))$$);
UPDATE ledger.account SET is_active = true WHERE code = '4202';

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. تغییر مجاز ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM ledger.set_posting_rule('sale_shift','sales','credit','4202',
  'تصمیم حسابدار: فروش کالا به سرفصل دیگری منتقل شد', v_user);

PERFORM pg_temp.assert_eq('حساب تازهٔ «فروش کالا»',
  (SELECT account_code FROM ledger.posting_rule_overview
    WHERE event_type='sale_shift' AND leg='sales'), '4202');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. ردّ حسابرسی با مقدار پیش و پس ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'ledger.set_posting_rule'
   AND before->>'account_code' = '4101'
   AND after->>'account_code'  = '4202'
   AND reason LIKE 'تصمیم حسابدار%';
PERFORM pg_temp.assert_eq('سطر حسابرسی با پیش ۴۱۰۱ و پس ۴۲۰۲', v_n::text, '1');

-- و زنجیرهٔ هش باید سالم بماند — مهاجرت ۰۵۱.
SELECT count(*) INTO v_n FROM platform.audit_check;
PERFORM pg_temp.assert_eq('گسست یا دست‌کاری در زنجیره حسابرسی', v_n::text, '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. و مهم‌ترین بند: تغییر واقعاً اثر می‌گذارد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ادعای ستون به‌تنهایی هیچ‌چیز را اثبات نمی‌کند: ممکن بود `post_entry`
-- کد حساب را جای دیگری hardcode کرده باشد. پس یک سند **واقعی** از
-- دروازهٔ مجاز زده می‌شود و پرسیده می‌شود روی کدام حساب نشست.

SELECT ledger.post_entry(
  'sale_shift', BR, platform.business_date(), 'سند آزمون نگاشت',
  jsonb_build_array(
    jsonb_build_object('leg','cash',  'amount', 500000),
    jsonb_build_object('leg','sales', 'amount', 500000)),
  NULL, NULL, v_user, 'final') INTO v_entry;

SELECT account_code INTO v_code FROM ledger.journal_line
 WHERE entry_id = v_entry AND credit > 0;
PERFORM pg_temp.assert_eq('حسابی که سند تازه روی آن نشست', v_code, '4202');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. و سند قبلی بازنویسی نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- تغییر نگاشت تاریخ را عوض نمی‌کند. این را صریح می‌سنجیم چون اگر روزی
-- کسی «برای یکدست‌شدن» سندهای قبلی را UPDATE کند، دفتر تغییرناپذیر
-- نیست. اول برمی‌گردانیم به ۴۱۰۱ و سند تازه می‌زنیم، بعد ادعا می‌کنیم
-- سندِ ۴۲۰۲ دست‌نخورده مانده.

PERFORM ledger.set_posting_rule('sale_shift','sales','credit','4101',
  'بازگشت به سرفصل قبلی', v_user);

SELECT count(*) INTO v_rows FROM ledger.journal_line
 WHERE entry_id = v_entry AND account_code = '4202' AND credit = 500000;
PERFORM pg_temp.assert_eq('سطر سند قبلی روی ۴۲۰۲ دست‌نخورده', v_rows::text, '1');

RAISE NOTICE E'\n✔ نگاشت حساب — نما، شش رد، اثر واقعی، و تاریخِ دست‌نخورده';
END $test$;

ROLLBACK;
