-- =====================================================================
-- شناسه شخص در سطر سند باید به کسی اشاره کند که **وجود دارد**
-- =====================================================================
--
-- `party_id` عمداً کلید خارجی ندارد: چندریختی است (مشتری یا
-- تأمین‌کننده) و یک FK به دو جدول اشاره نمی‌کند. ثابت CI هم فقط
-- `party_id IS NULL` را می‌سنجید — یعنی «داشتن» را، نه «درست بودن» را.
--
-- بازتولید پیش از مهاجرت ۰۵۲، از **دروازهٔ مجاز**:
--
--     post_entry با party_id = 00000000-0000-4000-8000-ffffffffffff
--     → سند ساخته شد، سطر دریافتنی ۵٬۰۰۰٬۰۰۰ ریالی
--     → report_party_balances: customer | ‹NULL› | ‹NULL› | 5000000
--
-- یک مانده در گردش حساب اشخاص، بی نام و بی کد تفصیلی و بی کسی که
-- بتوان از او وصول کرد. و هیچ ثابتی نمی‌گرفتش.
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

DO $test$
DECLARE
  BR    uuid := '00000000-0000-7000-8000-000000000001';
  GHOST uuid := '00000000-0000-4000-8000-ffffffffffff';
  u  uuid;
  c  uuid;
  s  uuid;
  e  uuid;
  n  bigint;
BEGIN
RAISE NOTICE E'\n── آماده‌سازی ──────────────────────────────────────────────';

  INSERT INTO identity.app_user (username, full_name, password_hash, is_active)
  VALUES ('party_probe', 'کاربر آزمون شخص', 'x', true) RETURNING id INTO u;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (u, 'admin', BR);
  PERFORM platform.set_actor(u);

  INSERT INTO sales.customer (full_name, mobile_normalized)
  VALUES ('مشتری واقعی آزمون', '09120000001') RETURNING id INTO c;
  INSERT INTO purchasing.supplier (code, name)
  VALUES ('S-PARTY-PROBE', 'تأمین‌کننده واقعی آزمون') RETURNING id INTO s;
  RAISE NOTICE '  ✓ مشتری و تأمین‌کننده واقعی ساخته شدند';

RAISE NOTICE E'\n── ۱. کنترل مثبت: شخص **واقعی** باید بنشیند ────────────────';

  -- ⚠️ اجباری است. بی این بند، یک Trigger که همیشه خطا بدهد هم «پاس»
  --    می‌شد و کل فروش نسیه را می‌شکست.
  e := ledger.post_entry(
    'sale_shift', BR, current_date, 'کنترل مثبت: مشتری واقعی',
    jsonb_build_array(
      jsonb_build_object('leg','receivable','amount',1000000,
                         'party_type','customer','party_id', c),
      jsonb_build_object('leg','sales','amount',1000000)),
    NULL, NULL, u);
  SELECT count(*) INTO n FROM ledger.journal_line
   WHERE entry_id = e AND party_id = c;
  PERFORM pg_temp.assert_eq('سطر با مشتری واقعی نشست', n, 1);

  -- و سطر بی‌شخص (درآمد) هم باید بنشیند
  SELECT count(*) INTO n FROM ledger.journal_line
   WHERE entry_id = e AND party_id IS NULL;
  PERFORM pg_temp.assert_eq('سطر بی‌شخص نشست', n, 1);

RAISE NOTICE E'\n── ۲. مشتری ناموجود باید رد شود ────────────────────────────';

  BEGIN
    PERFORM ledger.post_entry(
      'sale_shift', BR, current_date, 'مشتری ناموجود',
      jsonb_build_array(
        jsonb_build_object('leg','receivable','amount',5000000,
                           'party_type','customer','party_id', GHOST),
        jsonb_build_object('leg','sales','amount',5000000)),
      NULL, NULL, u);
    RAISE EXCEPTION E'\n  ✗ سند با مشتری ناموجود ساخته شد';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%ساخته شد%' THEN RAISE; END IF;
    RAISE NOTICE '  ✓ رد شد → %', left(SQLERRM, 70);
  END;

RAISE NOTICE E'\n── ۳. تأمین‌کننده ناموجود باید رد شود ──────────────────────';

  BEGIN
    PERFORM ledger.post_entry(
      'opening', BR, current_date, 'تأمین‌کننده ناموجود',
      jsonb_build_array(
        jsonb_build_object('leg','payable','amount',3000000,
                           'party_type','supplier','party_id', GHOST),
        jsonb_build_object('leg','cash','amount',3000000)),
      NULL, NULL, u);
    RAISE EXCEPTION E'\n  ✗ سند با تأمین‌کننده ناموجود ساخته شد';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%ساخته شد%' THEN RAISE; END IF;
    RAISE NOTICE '  ✓ رد شد → %', left(SQLERRM, 70);
  END;

RAISE NOTICE E'\n── ۴. درج مستقیم هم رد می‌شود، نه فقط دروازه ───────────────';

  -- Trigger روی جدول است، نه داخل تابع. پس مسیر دومی هم نمی‌تواند
  -- فراموشش کند — همان دلیلی که ADR-001 برای قواعد دیتابیسی می‌آورد.
  BEGIN
    INSERT INTO ledger.journal_line
      (entry_id, line_no, account_code, party_type, party_id, debit, credit)
    VALUES (e, 99, '1201', 'customer', GHOST, 1000, 0);
    RAISE EXCEPTION E'\n  ✗ درج مستقیم با شخص ناموجود پذیرفته شد';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%پذیرفته شد%' THEN RAISE; END IF;
    RAISE NOTICE '  ✓ رد شد → %', left(SQLERRM, 70);
  END;

RAISE NOTICE E'\n── ۵. شناسه بی نوع شخص هم رد می‌شود ───────────────────────';

  -- شناسه‌ای که نوعش را نمی‌دانیم، در هیچ جدولی جست‌وجو نمی‌شود و
  -- گزارش تفصیلی رهایش می‌کند.
  BEGIN
    INSERT INTO ledger.journal_line
      (entry_id, line_no, account_code, party_type, party_id, debit, credit)
    VALUES (e, 98, '1201', NULL, c, 1000, 0);
    RAISE EXCEPTION E'\n  ✗ شناسه بی نوع پذیرفته شد';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%پذیرفته شد%' THEN RAISE; END IF;
    RAISE NOTICE '  ✓ رد شد → %', left(SQLERRM, 70);
  END;

RAISE NOTICE E'\n── ۶. آشکارساز دادهٔ موجود خالی است ────────────────────────';

  SELECT count(*) INTO n FROM ledger.party_check;
  PERFORM pg_temp.assert_eq('سطر سند با شخص ناموجود', n, 0);

RAISE NOTICE E'\n── ۷. و آشکارساز واقعاً می‌گیرد، نه اینکه همیشه خالی باشد ──';

  -- بی این بند، نمایی که همیشه خالی برگرداند هم «پاس» می‌شد — همان
  -- تله‌ای که بند ۶ به‌تنهایی در آن می‌افتاد.
  --
  -- ⚠️ سطر یتیم را با خاموش‌کردن Trigger نمی‌سازیم: در همین تراکنش
  --    قید معوق `entry_balanced` معلق است و `ALTER TABLE` با
  --    «pending trigger events» رد می‌شود. راه واقعی‌تر هم هست —
  --    **حذف خودِ مشتری**. که اتفاقاً یک ریسک واقعی را هم نشان می‌دهد:
  --    `sales.customer` از سطر سند FK نمی‌گیرد، پس حذف یا ادغام یک
  --    مشتری، سطرهای دفترش را یتیم می‌کند.
  DECLARE c2 uuid;
  BEGIN
    INSERT INTO sales.customer (full_name, mobile_normalized)
    VALUES ('مشتری که بعداً حذف می‌شود', '09120000002') RETURNING id INTO c2;

    PERFORM ledger.post_entry(
      'sale_shift', BR, current_date, 'سند مشتریِ درحال‌حذف',
      jsonb_build_array(
        jsonb_build_object('leg','receivable','amount',2000000,
                           'party_type','customer','party_id', c2),
        jsonb_build_object('leg','sales','amount',2000000)),
      NULL, NULL, u);

    SELECT count(*) INTO n FROM ledger.party_check;
    PERFORM pg_temp.assert_eq('پیش از حذف مشتری، آشکارساز خالی', n, 0);

    DELETE FROM sales.customer WHERE id = c2;

    SELECT count(*) INTO n FROM ledger.party_check WHERE problem = 'missing_customer';
    PERFORM pg_temp.assert_eq('پس از حذف مشتری، آشکارساز گرفت', n, 1);
  END;

RAISE NOTICE E'\n═══ شناسه شخص: همه بندها پاس ══════════════════════════════\n';
END $test$;

ROLLBACK;
