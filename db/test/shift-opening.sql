-- =====================================================================
-- تست پیوستگی نقد میان دو شیفت — `sales.open_shift()` (مهاجرت ۱۲۰)
-- =====================================================================
-- ثابت این پرونده: نقدی که میان بستن یک شیفت و باز شدن بعدی جابه‌جا
-- شود، **بی‌صدا** گم نمی‌شود. یا اعداد می‌خوانند، یا دلیل و سند مغایرت
-- دارد. تصمیم مالک (۲۰۲۶/۱۱/۱۵): رد نمی‌شود، با دلیل پذیرفته می‌شود.
--
-- ⚠️ بند ۲ **کنترل منفی** است: عدد درست بی دلیل پذیرفته می‌شود و سندی
--    نمی‌زند. بی آن، تابعی که همیشه دلیل بخواهد یا همیشه سند بزند هم
--    بندهای بعدی را سبز می‌کرد و صبح هر روز صندوق را گیر می‌انداخت.
-- ⚠️ بند ۳ ادعا می‌کند پیام خطا عدد مورد انتظار را **نمی‌گوید** (شمارش کور).
-- ⚠️ بند ۴ اثر دفتری را از **خود دفتر** می‌خواند، نه از ستون شیفت.
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
  p_label text, p_sql text, p_like text
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE p_like THEN
      RAISE EXCEPTION E'\n  ✗ %\n      انتظار خطا مثل: %\n      واقعی : %', p_label, p_like, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 90);
    RETURN SQLERRM;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- ماندهٔ حساب صندوق در دفتر، فقط از سندهایی که به یک شیفت ارجاع دارند.
CREATE OR REPLACE FUNCTION pg_temp.cash_of(p_shift uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)::text
    FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE e.ref_type = 'cash_shift' AND e.ref_id = p_shift AND l.account_code = '1101'
$$;

DO $test$
DECLARE
  BR uuid;
  v_user uuid; v_user2 uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid; v_s5 uuid; v_s6 uuid;
  v_msg text;
BEGIN

-- شعبهٔ تازه تا هیچ شیفت دیگری در انتظار اثر نگذارد.
INSERT INTO platform.branch (code, name) VALUES ('SHOPEN', 'شعبهٔ آزمون شیفت') RETURNING id INTO BR;
INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
SELECT BR, doc_type, fiscal_year, 'SO-' || prefix
  FROM platform.document_counter WHERE branch_id = '00000000-0000-7000-8000-000000000001';
INSERT INTO identity.app_user (username, full_name) VALUES ('shopen1', 'صندوق‌دار اول') RETURNING id INTO v_user;
INSERT INTO identity.app_user (username, full_name) VALUES ('shopen2', 'صندوق‌دار دوم') RETURNING id INTO v_user2;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user, 'admin', BR), (v_user2, 'admin', BR);
PERFORM platform.set_actor(v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. اولین شیفت شعبه: انتظاری نیست ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('انتظار پیش از هر شیفت', sales.shift_opening_expected(BR)::text, NULL);
v_s1 := sales.open_shift(BR, v_user, 1000000);
PERFORM pg_temp.assert_eq('شیفت اول بی سنجش باز شد',
  (SELECT coalesce(opening_expected::text, 'NULL') || ' ' || coalesce(opening_variance::text, 'NULL')
     FROM sales.cash_shift WHERE id = v_s1), 'NULL NULL');
PERFORM pg_temp.assert_raises('شیفت دوم همان کاربر',
  format('SELECT sales.open_shift(%L::uuid, %L::uuid, 0)', BR, v_user), '%one_open_shift_per_user%');
PERFORM pg_temp.assert_raises('موجودی منفی',
  format('SELECT sales.open_shift(%L::uuid, %L::uuid, -1)', BR, v_user2), '%منفی%');

PERFORM sales.close_shift(v_s1, 5000000, v_user);
PERFORM pg_temp.assert_eq('انتظار = شمارش پایان شیفت بسته', sales.shift_opening_expected(BR)::text, '5000000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. کنترل منفی: عدد درست، بی دلیل، بی سند ═══';
-- ═══════════════════════════════════════════════════════════════════

v_s2 := sales.open_shift(BR, v_user, 5000000);
PERFORM pg_temp.assert_eq('اختلاف صفر ثبت شد',
  (SELECT opening_expected::text || ' ' || opening_variance::text || ' ' || coalesce(opening_note, 'NULL')
     FROM sales.cash_shift WHERE id = v_s2), '5000000 0 NULL');
PERFORM pg_temp.assert_eq('هیچ سند مغایرتی برای شیفت هم‌خوان نیست',
  (SELECT count(*)::text FROM ledger.journal_entry WHERE ref_type = 'cash_shift' AND ref_id = v_s2), '0');
PERFORM sales.close_shift(v_s2, 5000000, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. اختلاف بی دلیل رد می‌شود — و عدد را لو نمی‌دهد ═══';
-- ═══════════════════════════════════════════════════════════════════

v_msg := pg_temp.assert_raises('۲ میلیون پس از شمارش ۵ میلیون، بی دلیل',
  format('SELECT sales.open_shift(%L::uuid, %L::uuid, 2000000)', BR, v_user), '%نمی‌خواند%دلیل%');
PERFORM pg_temp.assert_eq('پیام عدد مورد انتظار را نمی‌گوید (شمارش کور)',
  (position('5000000' IN v_msg) + position('500000' IN v_msg))::text, '0');
PERFORM pg_temp.assert_raises('دلیل فقط فاصله',
  format('SELECT sales.open_shift(%L::uuid, %L::uuid, 2000000, %L)', BR, v_user, '   '), '%دلیل%');
PERFORM pg_temp.assert_eq('هیچ شیفتی ساخته نشد',
  (SELECT count(*)::text FROM sales.cash_shift WHERE branch_id = BR AND status = 'open'), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. با دلیل پذیرفته می‌شود و دفتر با کشو می‌خواند ═══';
-- ═══════════════════════════════════════════════════════════════════

v_s3 := sales.open_shift(BR, v_user, 2000000, 'مدیر ۳ میلیون برای بانک برداشت');
PERFORM pg_temp.assert_eq('انتظار، اختلاف و دلیل روی شیفت',
  (SELECT opening_expected::text || ' ' || opening_variance::text || ' ' || opening_note
     FROM sales.cash_shift WHERE id = v_s3), '5000000 -3000000 مدیر ۳ میلیون برای بانک برداشت');
PERFORM pg_temp.assert_eq('دفتر: صندوق ۳ میلیون بستانکار شد',
  pg_temp.cash_of(v_s3), '-3000000');
PERFORM pg_temp.assert_eq('دفتر: مغایرت صندوق ۳ میلیون بدهکار شد',
  (SELECT sum(l.debit - l.credit)::text
     FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id = l.entry_id
    WHERE e.ref_type = 'cash_shift' AND e.ref_id = v_s3 AND l.account_code = '4203'), '3000000');
PERFORM pg_temp.assert_eq('سند متوازن',
  (SELECT (sum(l.debit) = sum(l.credit))::text
     FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id = l.entry_id
    WHERE e.ref_type = 'cash_shift' AND e.ref_id = v_s3), 'true');
PERFORM pg_temp.assert_eq('ردّ حسابرسی با هر دو عدد و دلیل',
  (SELECT (after->>'expected') || ' ' || (after->>'variance') || ' ' || reason
     FROM platform.audit_log WHERE action = 'shift.open' AND entity_id = v_s3::text),
  '5000000 -3000000 مدیر ۳ میلیون برای بانک برداشت');

-- بستن همان شیفت با همان ۲ میلیون: مغایرت بستن صفر است، چون انتظار
-- بستن از موجودی اول **همین** شیفت می‌آید.
PERFORM sales.close_shift(v_s3, 2000000, v_user);
PERFORM pg_temp.assert_eq('بستن همان شیفت مغایرت تازه نمی‌سازد',
  (SELECT variance::text FROM sales.cash_shift WHERE id = v_s3), '0');

-- اضافه‌آمدن هم همین است، با سمت‌های برعکس.
v_s4 := sales.open_shift(BR, v_user, 2500000, 'تنخواه از مدیر');
PERFORM pg_temp.assert_eq('اضافه: صندوق بدهکار',
  pg_temp.cash_of(v_s4), '500000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. کشوی دوم: انتظار تعریف‌نشده، سنجش نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('با یک کشوی باز، انتظار NULL است',
  coalesce(sales.shift_opening_expected(BR)::text, 'NULL'), 'NULL');
v_s5 := sales.open_shift(BR, v_user2, 777000);
PERFORM pg_temp.assert_eq('کشوی دوم بی سنجش و بی سند باز شد',
  (SELECT coalesce(opening_expected::text, 'NULL') || ' ' ||
          (SELECT count(*) FROM ledger.journal_entry WHERE ref_type = 'cash_shift' AND ref_id = v_s5)
     FROM sales.cash_shift WHERE id = v_s5), 'NULL 0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. پس از دو کشوی هم‌زمان، شمارش یک کشو انتظار نیست ═══';
-- ═══════════════════════════════════════════════════════════════════
-- یافتهٔ بازبینی مستقل: دو کشو با ۲٫۵ و ۰٫۷۷۷ میلیون بسته شدند؛ شیفت بعد با جمع
-- هر دو باز می‌شود و نباید «اضافه» و سند مغایرت بگیرد. زمان‌ها صریح‌اند چون در
-- یک تراکنش `now()` برای همه یکی است و هم‌پوشانی دیده نمی‌شد.

PERFORM sales.close_shift(v_s4, 2500000, v_user);
PERFORM sales.close_shift(v_s5, 777000, v_user2);
UPDATE sales.cash_shift SET opened_at = now() + interval '1 hour', closed_at = now() + interval '9 hours' WHERE id = v_s4;
UPDATE sales.cash_shift SET opened_at = now() + interval '3 hours', closed_at = now() + interval '8 hours' WHERE id = v_s5;
PERFORM pg_temp.assert_eq('آخرین شیفت بسته هم‌زمان با کشوی دیگر بود: انتظار NULL',
  coalesce(sales.shift_opening_expected(BR)::text, 'NULL'), 'NULL');
v_s6 := sales.open_shift(BR, v_user, 3277000);
PERFORM pg_temp.assert_eq('جمع دو کشو بی سنجش و بی سند مغایرت باز شد',
  (SELECT coalesce(opening_expected::text, 'NULL') || ' ' ||
          (SELECT count(*) FROM ledger.journal_entry WHERE ref_type = 'cash_shift' AND ref_id = v_s6)
     FROM sales.cash_shift WHERE id = v_s6), 'NULL 0');

-- کنترل منفی: شیفت تنها پس از آن دوباره سنجیده می‌شود.
PERFORM sales.close_shift(v_s6, 3277000, v_user);
UPDATE sales.cash_shift SET opened_at = now() + interval '10 hours', closed_at = now() + interval '11 hours' WHERE id = v_s6;
PERFORM pg_temp.assert_eq('شیفت تنها: انتظار همان شمارش است',
  sales.shift_opening_expected(BR)::text, '3277000');

RAISE NOTICE E'\n✔ پیوستگی نقد شیفت‌ها — اولین شیفت، کنترل منفی، شمارش کور، سند مغایرت، کشوی دوم، کشوهای هم‌زمان';
END $test$;

ROLLBACK;
