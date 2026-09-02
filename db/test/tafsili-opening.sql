-- =====================================================================
-- تفصیلی اشخاص و سند افتتاحیه (مهاجرت ۰۲۲)
-- =====================================================================
-- دو قابلیت هلو که کدینگ ما نداشت.
--
-- مهم‌ترین ادعای این فایل درباره چیزی است که **نساختیم**: به‌ازای هر
-- مشتری یک حساب تفصیلی جدا نساختیم، چون آن‌وقت مانده هر مشتری دو
-- منبع پیدا می‌کرد. تفصیلی یک نما روی `party_id` است، و این تست
-- می‌سنجد که جمع تفصیلی‌ها دقیقاً با مانده حساب معین بخواند.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual numeric, p_expected numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(
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
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 78);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  v_user uuid; v_c1 uuid; v_c2 uuid;
  v_n int; v_entry uuid; v_rev uuid;
  v_moin platform.money;
  v_taf  platform.money;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('taf_test','تست تفصیلی') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. هر شخص کد تفصیلی پایدار می‌گیرد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- شماره است نه UUID، چون آدم‌ها با آن حرف می‌زنند.

INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
VALUES ('09120001111','مشتری الف', 0) RETURNING id INTO v_c1;
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
VALUES ('09120002222','مشتری ب', 0) RETURNING id INTO v_c2;

PERFORM pg_temp.assert_txt('مشتری تازه کد تفصیلی می‌گیرد',
  (SELECT (tafsili_no IS NOT NULL)::text FROM sales.customer WHERE id = v_c1), 'true');

PERFORM pg_temp.assert_txt('کد تفصیلی دو مشتری یکی نیست',
  (SELECT (c1.tafsili_no <> c2.tafsili_no)::text
     FROM sales.customer c1, sales.customer c2
    WHERE c1.id = v_c1 AND c2.id = v_c2), 'true');

-- تأمین‌کننده هم از همان دنباله می‌گیرد، پس کد تفصیلی در کل سیستم
-- یکتاست — نه فقط داخل مشتری‌ها.
PERFORM pg_temp.assert_eq('کد تفصیلی تکراری در کل سیستم',
  (SELECT count(*) FROM (
     SELECT tafsili_no FROM sales.customer
     UNION ALL SELECT tafsili_no FROM purchasing.supplier
   ) x GROUP BY tafsili_no HAVING count(*) > 1), NULL);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. سند افتتاحیه — نگهبان‌ها ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بدون کاربر عامل',
  $$SELECT ledger.post_opening_balance(
      '00000000-0000-7000-8000-000000000001'::uuid, 1405::smallint,
      '[{"leg":"cash","amount":100}]'::jsonb, NULL)$$);

PERFORM pg_temp.assert_raises('سند خالی',
  $$SELECT ledger.post_opening_balance(
      '00000000-0000-7000-8000-000000000001'::uuid, 1405::smallint,
      '[]'::jsonb, (SELECT id FROM identity.app_user WHERE username='taf_test'))$$);

PERFORM pg_temp.assert_raises('سال مالی ناشناخته',
  $$SELECT ledger.post_opening_balance(
      '00000000-0000-7000-8000-000000000001'::uuid, 1499::smallint,
      '[{"leg":"cash","amount":100},{"leg":"equity","amount":100}]'::jsonb,
      (SELECT id FROM identity.app_user WHERE username='taf_test'))$$);

PERFORM pg_temp.assert_raises('مؤلفه ناشناخته',
  $$SELECT ledger.post_opening_balance(
      '00000000-0000-7000-8000-000000000001'::uuid, 1405::smallint,
      '[{"leg":"چیز","amount":100},{"leg":"equity","amount":100}]'::jsonb,
      (SELECT id FROM identity.app_user WHERE username='taf_test'))$$);

-- ناتوازنی **پیش از** ثبت گرفته می‌شود، با پیام فارسی — نه با خطای
-- فنی قید معوق دفتر.
PERFORM pg_temp.assert_raises('سند نامتوازن',
  $$SELECT ledger.post_opening_balance(
      '00000000-0000-7000-8000-000000000001'::uuid, 1405::smallint,
      '[{"leg":"cash","amount":500000},{"leg":"equity","amount":400000}]'::jsonb,
      (SELECT id FROM identity.app_user WHERE username='taf_test'))$$);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. افتتاحیه درست، و اصلاحش ═══';
-- ═══════════════════════════════════════════════════════════════════

v_entry := ledger.post_opening_balance(BR, 1405::smallint,
  jsonb_build_array(
    jsonb_build_object('leg','cash',      'amount', 5000000),
    jsonb_build_object('leg','inventory', 'amount', 15000000),
    jsonb_build_object('leg','equity',    'amount', 20000000)),
  v_user);

PERFORM pg_temp.assert_txt('سند افتتاحیه ساخته شد', (v_entry IS NOT NULL)::text, 'true');

PERFORM pg_temp.assert_eq('سند افتتاحیه متوازن است',
  (SELECT sum(debit) - sum(credit) FROM ledger.journal_line WHERE entry_id = v_entry), 0);

SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'ledger.opening' AND entity_id = '1405';
PERFORM pg_temp.assert_eq('افتتاحیه در لاگ حسابرسی', v_n, 1);

-- ── اصلاح: سند حذف نمی‌شود، معکوس می‌شود ────────────────────────
-- اولین بار همیشه غلط وارد می‌شود؛ این واقعیتِ راه‌اندازی است.
v_entry := ledger.post_opening_balance(BR, 1405::smallint,
  jsonb_build_array(
    jsonb_build_object('leg','cash',      'amount', 6000000),
    jsonb_build_object('leg','inventory', 'amount', 15000000),
    jsonb_build_object('leg','equity',    'amount', 21000000)),
  v_user);

SELECT id INTO v_rev FROM ledger.journal_entry WHERE reverses_id IS NOT NULL LIMIT 1;
PERFORM pg_temp.assert_txt('سند معکوس ساخته شد', (v_rev IS NOT NULL)::text, 'true');

PERFORM pg_temp.assert_eq('معکوس، آینه سند اصلی است',
  (SELECT sum(debit) - sum(credit) FROM ledger.journal_line WHERE entry_id = v_rev), 0);

-- اثر خالص: فقط افتتاحیه دوم می‌ماند
PERFORM pg_temp.assert_eq('اثر خالص افتتاحیه = سند دوم',
  (SELECT sum(l.debit) FROM ledger.journal_line l
     JOIN ledger.journal_entry e ON e.id = l.entry_id
    WHERE e.kind = 'opening'
      AND l.account_code = (SELECT account_code FROM ledger.posting_rule
                             WHERE event_type='opening' AND leg='cash'))
  - (SELECT sum(l.credit) FROM ledger.journal_line l
       JOIN ledger.journal_entry e ON e.id = l.entry_id
      WHERE e.kind = 'opening'
        AND l.account_code = (SELECT account_code FROM ledger.posting_rule
                               WHERE event_type='opening' AND leg='cash')),
  6000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. تفصیلی از سند می‌آید، نه از حساب جدا ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ادعای مرکزی. اگر روزی کسی به‌ازای هر مشتری یک `ledger.account`
-- بسازد، مانده دو منبع پیدا می‌کند و این ادعا می‌شکند.

PERFORM ledger.post_entry('loyalty_grant', BR, now()::date,
  'امتیاز مشتری الف',
  jsonb_build_array(
    jsonb_build_object('leg','expense','amount', 300000),
    jsonb_build_object('leg','liability','amount', 300000,
                       'party_type','customer','party_id', v_c1)),
  NULL, NULL, v_user);

PERFORM ledger.post_entry('loyalty_grant', BR, now()::date,
  'امتیاز مشتری ب',
  jsonb_build_array(
    jsonb_build_object('leg','expense','amount', 200000),
    jsonb_build_object('leg','liability','amount', 200000,
                       'party_type','customer','party_id', v_c2)),
  NULL, NULL, v_user);

PERFORM pg_temp.assert_eq('دو تفصیلی زیر همان معین دیده می‌شوند',
  (SELECT count(*) FROM ledger.party_tafsili WHERE party_type = 'customer'), 2);

-- جمع تفصیلی‌ها باید **دقیقاً** با مانده معین بخواند. این همان چیزی
-- است که با حساب تفصیلیِ جدا دیر یا زود می‌شکست.
SELECT sum(balance) INTO v_taf FROM ledger.party_tafsili t
 WHERE t.parent_code = (SELECT account_code FROM ledger.journal_line
                         WHERE party_id = v_c1 LIMIT 1);

SELECT CASE WHEN a.nature = 'debit'
            THEN sum(l.debit) - sum(l.credit)
            ELSE sum(l.credit) - sum(l.debit) END
  INTO v_moin
  FROM ledger.journal_line l
  JOIN ledger.account a ON a.code = l.account_code
 WHERE l.account_code = (SELECT account_code FROM ledger.journal_line
                          WHERE party_id = v_c1 LIMIT 1)
 GROUP BY a.nature;

PERFORM pg_temp.assert_eq('جمع تفصیلی = مانده معین', v_taf, v_moin);

-- کد نمایشی همان شکلی است که آدم‌ها می‌نویسند: معین + کد تفصیلی
PERFORM pg_temp.assert_txt('کد نمایشی تفصیلی ساخته می‌شود',
  (SELECT (code LIKE '%-%')::text FROM ledger.party_tafsili
    WHERE party_id = v_c1), 'true');

PERFORM pg_temp.assert_txt('نام شخص در تفصیلی می‌آید',
  (SELECT party_name FROM ledger.party_tafsili WHERE party_id = v_c1), 'مشتری الف');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

-- هیچ حساب تفصیلیِ **جدا** برای اشخاص ساخته نشده باشد. اگر روزی کسی
-- بسازد، مانده دو منبع پیدا می‌کند و این ادعا هشدار می‌دهد.
SELECT count(*) INTO v_n FROM ledger.account
 WHERE level = 'tafsili' AND code LIKE '1201%';
PERFORM pg_temp.assert_eq('حساب تفصیلیِ جدا برای مشتری', v_n, 0);

RAISE NOTICE E'\n✔ تفصیلی و افتتاحیه — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
