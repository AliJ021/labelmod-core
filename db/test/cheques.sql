-- =====================================================================
-- تست چک دریافتی و پرداختی
-- =====================================================================
-- پوشش: هر پنج مسیر واقعی یک برگه چک (وصول، برگشت، خرج‌کردن، پاس‌شدن،
-- ابطال)، Idempotency، گذارهای غیرمجاز، تغییرناپذیری برگه سنددار و
-- زنجیره رویداد، و تطبیق دفتر با پرونده چک.
--
-- ادعای مرکزی: در هیچ لحظه‌ای مانده حساب‌های چک در دفتر نباید از جمع
-- برگه‌های باز جدا بیفتد — همان چیزی که inventory.balance_check برای
-- انبار می‌کند.
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
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.bal(p_code text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE l.account_code = p_code AND e.status IN ('confirmed','final');
$$;

CREATE OR REPLACE FUNCTION pg_temp.bal_party(p_code text, p_party uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE l.account_code = p_code AND l.party_id = p_party
     AND e.status IN ('confirmed','final');
$$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  CASHBOX uuid := '00000000-0000-7000-8000-000000000201';
  BANK    uuid := '00000000-0000-7000-8000-000000000202';
  v_user uuid; v_cust uuid; v_sup uuid;
  ch1 uuid; ch2 uuid; ch3 uuid; ch4 uuid; ch5 uuid; ch6 uuid;
  v_e1 uuid; v_e2 uuid; v_n int; v_bank_before numeric;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('chq','تست چک')
  RETURNING id INTO v_user;
PERFORM platform.set_actor(v_user);

INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
  VALUES ('09129000001','مشتری چک', 900000000) RETURNING id INTO v_cust;
INSERT INTO purchasing.supplier (code, name) VALUES ('S-CHQ','تأمین‌کننده چک')
  RETURNING id INTO v_sup;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. مسیر عادی چک دریافتی: دریافت ← واگذاری ← وصول ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, sayad_id, bank_name, drawer_name,
   amount, issued_on, due_on, party_type, party_id, created_by)
VALUES ('received', BR, 'CH-001', '1234567890123456', 'ملت', 'مشتری چک',
        5000000, '2026-04-01', '2026-05-01', 'customer', v_cust, v_user)
RETURNING id INTO ch1;

PERFORM pg_temp.assert_txt('وضعیت اولیه برگه',
  (SELECT status FROM treasury.cheque WHERE id = ch1), 'draft');

PERFORM treasury.post_cheque_event(ch1, 'receive', v_user, NULL, NULL, '2026-04-01');

PERFORM pg_temp.assert_eq('پس از دریافت — چک نزد ما (۱۵۰۱)', pg_temp.bal('1501'), 5000000);
PERFORM pg_temp.assert_eq('پس از دریافت — بدهی مشتری (۱۲۰۱)',
  pg_temp.bal_party('1201', v_cust), -5000000);
PERFORM pg_temp.assert_txt('شماره سند داخلی تخصیص یافت',
  left((SELECT number FROM treasury.cheque WHERE id = ch1), 9), 'CHQ-1405-');

PERFORM treasury.post_cheque_event(ch1, 'deposit', v_user, BANK, NULL, '2026-04-28');
PERFORM pg_temp.assert_eq('پس از واگذاری — چک نزد ما', pg_temp.bal('1501'), 0);
PERFORM pg_temp.assert_eq('پس از واگذاری — در جریان وصول (۱۵۰۲)', pg_temp.bal('1502'), 5000000);

v_bank_before := pg_temp.bal('1102');
PERFORM treasury.post_cheque_event(ch1, 'clear', v_user, NULL, NULL, '2026-05-01');
PERFORM pg_temp.assert_eq('پس از وصول — در جریان وصول', pg_temp.bal('1502'), 0);
PERFORM pg_temp.assert_eq('پس از وصول — بانک افزایش یافت',
  pg_temp.bal('1102') - v_bank_before, 5000000);
PERFORM pg_temp.assert_txt('وضعیت نهایی',
  (SELECT status FROM treasury.cheque WHERE id = ch1), 'cleared');
PERFORM pg_temp.assert_eq('تعداد رویداد ثبت‌شده',
  (SELECT count(*) FROM treasury.cheque_event WHERE cheque_id = ch1), 3);

-- بدهی مشتری فقط یک بار تسویه شد، نه دو بار
PERFORM pg_temp.assert_eq('بدهی مشتری پس از وصول',
  pg_temp.bal_party('1201', v_cust), -5000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. برگشت چک و انتقال به بدهی عادی ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, created_by)
VALUES ('received', BR, 'CH-002', 'ملت', 3000000,
        '2026-04-01', '2026-05-01', 'customer', v_cust, v_user)
RETURNING id INTO ch2;

PERFORM treasury.post_cheque_event(ch2, 'receive', v_user, NULL, NULL, '2026-04-01');
PERFORM treasury.post_cheque_event(ch2, 'deposit', v_user, BANK, NULL, '2026-04-28');

v_bank_before := pg_temp.bal('1102');
PERFORM treasury.post_cheque_event(ch2, 'bounce', v_user, NULL, NULL, '2026-05-02', 'کسر موجودی');

PERFORM pg_temp.assert_eq('برگشت — چک برگشتی (۱۵۰۳)', pg_temp.bal('1503'), 3000000);
PERFORM pg_temp.assert_eq('برگشت — در جریان وصول خالی شد', pg_temp.bal('1502'), 0);
PERFORM pg_temp.assert_eq('برگشت — بانک دست‌نخورده ماند',
  pg_temp.bal('1102') - v_bank_before, 0);

-- چک برگشتی تا وقتی در ۱۵۰۳ است، بدهی عادی مشتری نیست
PERFORM pg_temp.assert_eq('پیش از انتقال — بدهی عادی مشتری',
  pg_temp.bal_party('1201', v_cust), -8000000);

PERFORM treasury.post_cheque_event(ch2, 'settle', v_user, NULL, NULL, '2026-05-03');
PERFORM pg_temp.assert_eq('پس از انتقال — چک برگشتی خالی شد', pg_temp.bal('1503'), 0);
PERFORM pg_temp.assert_eq('پس از انتقال — بدهی عادی مشتری برگشت',
  pg_temp.bal_party('1201', v_cust), -5000000);
PERFORM pg_temp.assert_txt('وضعیت',
  (SELECT status FROM treasury.cheque WHERE id = ch2), 'settled');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. خرج‌کردن چک مشتری به تأمین‌کننده، و برگشتش ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, created_by)
VALUES ('received', BR, 'CH-003', 'صادرات', 7000000,
        '2026-04-01', '2026-06-01', 'customer', v_cust, v_user)
RETURNING id INTO ch3;

PERFORM treasury.post_cheque_event(ch3, 'receive', v_user, NULL, NULL, '2026-04-01');
PERFORM treasury.post_cheque_event(ch3, 'endorse', v_user, NULL, v_sup, '2026-04-10');

PERFORM pg_temp.assert_txt('وضعیت پس از خرج‌کردن',
  (SELECT status FROM treasury.cheque WHERE id = ch3), 'endorsed');
PERFORM pg_temp.assert_eq('خرج‌کردن — چک از دست ما خارج شد', pg_temp.bal('1501'), 0);
PERFORM pg_temp.assert_eq('خرج‌کردن — بدهی تأمین‌کننده کم شد',
  pg_temp.bal_party('2101', v_sup), 7000000);

-- تأمین‌کننده چک را پس می‌دهد: بدهی به او زنده می‌شود
PERFORM treasury.post_cheque_event(ch3, 'bounce', v_user, NULL, NULL, '2026-06-02', 'برگشت پس از ظهرنویسی');
PERFORM pg_temp.assert_eq('برگشت پس از خرج — بدهی تأمین‌کننده زنده شد',
  pg_temp.bal_party('2101', v_sup), 0);
PERFORM pg_temp.assert_eq('برگشت پس از خرج — چک برگشتی مشتری', pg_temp.bal('1503'), 7000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. چک پرداختی: صدور ← پاس‌شدن ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, bank_account_id, created_by)
VALUES ('issued', BR, 'CH-101', 'ملت', 9000000,
        '2026-04-01', '2026-05-15', 'supplier', v_sup, BANK, v_user)
RETURNING id INTO ch4;

PERFORM treasury.post_cheque_event(ch4, 'issue', v_user, NULL, NULL, '2026-04-01');
PERFORM pg_temp.assert_eq('صدور — اسناد پرداختنی (۲۴۰۱)', -pg_temp.bal('2401'), 9000000);
PERFORM pg_temp.assert_eq('صدور — بدهی تجاری تأمین‌کننده کم شد',
  pg_temp.bal_party('2101', v_sup), 9000000);

v_bank_before := pg_temp.bal('1102');
PERFORM treasury.post_cheque_event(ch4, 'pay', v_user, NULL, NULL, '2026-05-15');
PERFORM pg_temp.assert_eq('پاس — اسناد پرداختنی صفر شد', pg_temp.bal('2401'), 0);
PERFORM pg_temp.assert_eq('پاس — از بانک برداشت شد',
  pg_temp.bal('1102') - v_bank_before, -9000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. برگشت چک پرداختی سند نمی‌زند، ابطال می‌زند ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, bank_account_id, created_by)
VALUES ('issued', BR, 'CH-102', 'ملت', 4000000,
        '2026-04-01', '2026-05-20', 'supplier', v_sup, BANK, v_user)
RETURNING id INTO ch5;

PERFORM treasury.post_cheque_event(ch5, 'issue', v_user, NULL, NULL, '2026-04-01');
v_e1 := treasury.post_cheque_event(ch5, 'bounce', v_user, NULL, NULL, '2026-05-20');

PERFORM pg_temp.assert_eq('برگشت چک پرداختی — سند نزد', (v_e1 IS NULL)::int, 1);
PERFORM pg_temp.assert_eq('برگشت چک پرداختی — بدهی سر جایش', -pg_temp.bal('2401'), 4000000);
PERFORM pg_temp.assert_txt('وضعیت',
  (SELECT status FROM treasury.cheque WHERE id = ch5), 'bounced');

-- ابطال یک چک صادرشده دیگر: بدهی به پرداختنی تجاری برمی‌گردد
INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, bank_account_id, created_by)
VALUES ('issued', BR, 'CH-103', 'ملت', 2000000,
        '2026-04-01', '2026-05-25', 'supplier', v_sup, BANK, v_user)
RETURNING id INTO ch6;

PERFORM treasury.post_cheque_event(ch6, 'issue',  v_user, NULL, NULL, '2026-04-01');
v_bank_before := pg_temp.bal_party('2101', v_sup);
PERFORM treasury.post_cheque_event(ch6, 'cancel', v_user, NULL, NULL, '2026-04-05');
PERFORM pg_temp.assert_eq('ابطال — اسناد پرداختنی فقط چک برگشتی ماند',
  -pg_temp.bal('2401'), 4000000);
-- ۲۱۰۱ بدهی است: بدهکارشدنش یعنی بدهی کم شده. ابطال چک آن را برمی‌گرداند.
PERFORM pg_temp.assert_eq('ابطال — بدهی تجاری تأمین‌کننده به همان اندازه برگشت',
  v_bank_before - pg_temp.bal_party('2101', v_sup), 2000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. Idempotency و گذارهای غیرمجاز ═══';
-- ═══════════════════════════════════════════════════════════════════

-- تکرار همان عمل روی وضعیتی که قبلاً به آن رسیده، سند دوم نمی‌سازد
SELECT count(*) INTO v_n FROM ledger.journal_entry WHERE ref_id = ch1;
v_e1 := treasury.post_cheque_event(ch1, 'clear', v_user, NULL, NULL, '2026-05-01');
SELECT count(*) INTO v_n FROM ledger.journal_entry WHERE ref_id = ch1 AND v_n = v_n;
PERFORM pg_temp.assert_eq('تکرار «وصول» سند دوم نساخت',
  (SELECT count(*) FROM ledger.journal_entry WHERE ref_id = ch1), 3);
PERFORM pg_temp.assert_eq('تکرار «وصول» رویداد دوم نساخت',
  (SELECT count(*) FROM treasury.cheque_event WHERE cheque_id = ch1), 3);

PERFORM pg_temp.assert_raises('واگذاری چک وصول‌شده',
  format('SELECT treasury.post_cheque_event(%L,''deposit'',%L,%L)', ch1, v_user, BANK));
PERFORM pg_temp.assert_raises('وصول چکی که هنوز واگذار نشده',
  format('SELECT treasury.post_cheque_event(%L,''clear'',%L,%L)', ch3, v_user, BANK));
PERFORM pg_temp.assert_raises('عمل چک دریافتی روی چک پرداختی',
  format('SELECT treasury.post_cheque_event(%L,''deposit'',%L,%L)', ch4, v_user, BANK));
-- تکرار «پاس»، برخلاف یک گذار غیرمجاز، همان سند قبلی را برمی‌گرداند.
-- Retry لایه API نباید نه خطا بدهد نه دفتر را دوباره بزند.
v_e1 := treasury.post_cheque_event(ch4, 'pay', v_user);
v_e2 := treasury.post_cheque_event(ch4, 'pay', v_user);
PERFORM pg_temp.assert_eq('تکرار «پاس» همان سند را برگرداند', (v_e1 = v_e2)::int, 1);
PERFORM pg_temp.assert_eq('تکرار «پاس» رویداد سوم نساخت',
  (SELECT count(*) FROM treasury.cheque_event WHERE cheque_id = ch4), 2);

-- ولی عملی که هرگز روی این وضعیت معنا ندارد، خطا می‌دهد
PERFORM pg_temp.assert_raises('صدور دوباره چک پاس‌شده',
  format('SELECT treasury.post_cheque_event(%L,''issue'',%L)', ch4, v_user));
PERFORM pg_temp.assert_raises('انتقال چکی که برنگشته به بدهی عادی',
  format('SELECT treasury.post_cheque_event(%L,''settle'',%L)', ch1, v_user));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. نگهبان‌ها ═══';
-- ═══════════════════════════════════════════════════════════════════

-- یک چک تازه که واقعاً «نزد ما» است، تا نگهبانِ نوع حساب آزموده شود و
-- نه ماشین وضعیت. اگر با چکی در وضعیت دیگر تست شود، خطا از جای دیگری
-- می‌آید و این ادعا بی‌اثر می‌شود.
INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, created_by)
VALUES ('received', BR, 'CH-004', 'ملت', 1000000,
        '2026-04-01', '2026-06-01', 'customer', v_cust, v_user);
PERFORM treasury.post_cheque_event(
  (SELECT id FROM treasury.cheque WHERE cheque_no='CH-004'), 'receive', v_user);

PERFORM pg_temp.assert_raises('واگذاری چک به صندوق به‌جای بانک',
  format('SELECT treasury.post_cheque_event(%L,''deposit'',%L,%L)',
         (SELECT id FROM treasury.cheque WHERE cheque_no='CH-004'), v_user, CASHBOX));

PERFORM pg_temp.assert_raises('تغییر مبلغ چکی که سند خورده',
  format('UPDATE treasury.cheque SET amount = 1 WHERE id = %L', ch1));

-- قید معوق است و در پایان تراکنش بررسی می‌شود، پس داخل تست باید صریح
-- IMMEDIATE شود؛ وگرنه ادعا در زیرتراکنشِ assert_raises بی‌صدا رد می‌شود.
PERFORM pg_temp.assert_raises('تغییر مستقیم وضعیت بدون رویداد',
  format('UPDATE treasury.cheque SET status = ''cleared'' WHERE id = %L;
          SET CONSTRAINTS treasury.cheque_status_matches_events IMMEDIATE', ch5));

PERFORM pg_temp.assert_raises('تغییر رویداد چک',
  format('UPDATE treasury.cheque_event SET amount = 1 WHERE cheque_id = %L', ch1));

PERFORM pg_temp.assert_raises('حذف رویداد چک',
  format('DELETE FROM treasury.cheque_event WHERE cheque_id = %L', ch1));

PERFORM pg_temp.assert_raises('چک دریافتی با طرف حساب تأمین‌کننده',
  format('INSERT INTO treasury.cheque (direction,branch_id,cheque_no,bank_name,amount,
          issued_on,due_on,party_type,party_id,created_by)
          VALUES (''received'',%L,''CH-BAD'',''ملت'',1000,''2026-04-01'',''2026-05-01'',
                  ''supplier'',%L,%L)', BR, v_sup, v_user));

PERFORM pg_temp.assert_raises('سررسید پیش از تاریخ صدور',
  format('INSERT INTO treasury.cheque (direction,branch_id,cheque_no,bank_name,amount,
          issued_on,due_on,party_type,party_id,created_by)
          VALUES (''received'',%L,''CH-BAD2'',''ملت'',1000,''2026-05-01'',''2026-04-01'',
                  ''customer'',%L,%L)', BR, v_cust, v_user));

PERFORM pg_temp.assert_raises('ثبت دوباره همان برگه چک',
  format('INSERT INTO treasury.cheque (direction,branch_id,cheque_no,bank_name,amount,
          issued_on,due_on,party_type,party_id,created_by)
          VALUES (''received'',%L,''CH-001'',''ملت'',1000,''2026-04-01'',''2026-05-01'',
                  ''customer'',%L,%L)', BR, v_cust, v_user));

PERFORM pg_temp.assert_raises('چک پرداختی بدون حساب بانکی',
  format('INSERT INTO treasury.cheque (direction,branch_id,cheque_no,bank_name,amount,
          issued_on,due_on,party_type,party_id,created_by)
          VALUES (''issued'',%L,''CH-BAD3'',''ملت'',1000,''2026-04-01'',''2026-05-01'',
                  ''supplier'',%L,%L)', BR, v_sup, v_user));

-- سقف وعده: تنظیمی که هیچ‌جا اجرا نشود، بدتر از نبودنش است
INSERT INTO treasury.cheque
  (direction, branch_id, cheque_no, bank_name, amount,
   issued_on, due_on, party_type, party_id, created_by)
VALUES ('received', BR, 'CH-005', 'ملت', 1000000,
        '2026-04-01', '2027-01-01', 'customer', v_cust, v_user);
PERFORM pg_temp.assert_raises('چک با وعده بیش از سقف',
  format('SELECT treasury.post_cheque_event(%L,''receive'',%L)',
         (SELECT id FROM treasury.cheque WHERE cheque_no = 'CH-005'), v_user));

-- و سقف داده است: بالا بردنش همان چک را قابل ثبت می‌کند.
-- از مسیر واقعی عوض می‌شود، نه با UPDATE مستقیم — مقدار تنظیم از
-- مهاجرت ۰۰۸ به بعد فقط از set_setting حرکت می‌کند.
PERFORM platform.set_setting('cheque.max_due_days', '400'::jsonb, 'تست سقف وعده');
PERFORM treasury.post_cheque_event(
  (SELECT id FROM treasury.cheque WHERE cheque_no = 'CH-005'), 'receive', v_user);
PERFORM pg_temp.assert_txt('همان چک پس از بالا بردن سقف',
  (SELECT status FROM treasury.cheque WHERE cheque_no = 'CH-005'), 'in_hand');
PERFORM platform.set_setting('cheque.max_due_days', '180'::jsonb, 'بازگشت به پیش‌فرض');

-- شماره‌گذاری بدون پرش: سه رویداد روی یک چک، فقط یک شماره
PERFORM pg_temp.assert_eq('شمارنده سند = تعداد چک‌های شماره‌دار',
  (SELECT last_no FROM platform.document_counter
    WHERE doc_type = 'cheque' AND branch_id = BR),
  (SELECT count(*) FROM treasury.cheque WHERE number IS NOT NULL));

-- خرج‌کردن یک تصمیم حسابدار است، نه یک ثابت در کد
PERFORM platform.set_setting('cheque.allow_endorse', 'false'::jsonb, 'تست ممنوعیت ظهرنویسی');
PERFORM pg_temp.assert_raises('خرج‌کردن وقتی تنظیم خاموش است',
  format('SELECT treasury.post_cheque_event(%L,''endorse'',%L,NULL,%L)',
         (SELECT id FROM treasury.cheque WHERE cheque_no='CH-004'), v_user, v_sup));
PERFORM platform.set_setting('cheque.allow_endorse', 'true'::jsonb, 'بازگشت به پیش‌فرض');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. حسابرسی و پرونده سررسید ═══';
-- ═══════════════════════════════════════════════════════════════════

-- عدد ثابت اینجا شکننده است. ادعای واقعی این است: هیچ رویداد چکی
-- بدون رد حسابرسی نمی‌ماند، و تکرار Idempotent هم ردیف اضافه نمی‌سازد.
PERFORM pg_temp.assert_eq('هر رویداد چک یک ردیف حسابرسی دارد',
  (SELECT count(*) FROM platform.audit_log WHERE entity = 'treasury_cheque'),
  (SELECT count(*) FROM treasury.cheque_event));

PERFORM pg_temp.assert_raises('رویداد چک بدون کاربر عامل',
  format('SELECT platform.set_actor(NULL);
          SELECT treasury.post_cheque_event(%L,''deposit'',NULL,%L)',
         (SELECT id FROM treasury.cheque WHERE cheque_no = 'CH-004'), BANK));
PERFORM platform.set_actor(v_user);

PERFORM pg_temp.assert_eq('گردش کامل چک اول در نمای پرونده',
  (SELECT count(*) FROM treasury.cheque_ledger WHERE cheque_id = ch1), 3);

-- چک CH-004 در دست ماست و سررسیدش گذشته
PERFORM pg_temp.assert_eq('چک باز در فهرست سررسید',
  (SELECT count(*) FROM treasury.cheque_due WHERE cheque_no = 'CH-004'), 1);
PERFORM pg_temp.assert_eq('چک وصول‌شده در فهرست سررسید نیست',
  (SELECT count(*) FROM treasury.cheque_due WHERE cheque_no = 'CH-001'), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM treasury.cheque_check WHERE diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف دفتر با پرونده چک', v_n, 0);

PERFORM pg_temp.assert_eq('چک نزد ما: دفتر = پرونده',
  pg_temp.bal('1501'),
  (SELECT coalesce(sum(amount),0) FROM treasury.cheque
    WHERE direction='received' AND status='in_hand'));

PERFORM pg_temp.assert_eq('اسناد پرداختنی: دفتر = پرونده',
  -pg_temp.bal('2401'),
  (SELECT coalesce(sum(amount),0) FROM treasury.cheque
    WHERE direction='issued' AND status IN ('issued','bounced')));

SELECT coalesce(sum(debit),0) - coalesce(sum(credit),0) INTO v_n FROM ledger.journal_line;
PERFORM pg_temp.assert_eq('جمع بدهکار − جمع بستانکار', v_n, 0);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

SELECT count(*) INTO v_n FROM ledger.journal_line
 WHERE party_type IN ('customer','supplier') AND party_id IS NULL;
PERFORM pg_temp.assert_eq('سطر سند با نوع شخص ولی بدون شناسه', v_n, 0);

SELECT count(*) INTO v_n FROM treasury.cheque c
 WHERE c.status <> 'draft'
   AND NOT EXISTS (SELECT 1 FROM treasury.cheque_event e WHERE e.cheque_id = c.id);
PERFORM pg_temp.assert_eq('چک با وضعیت غیر draft و بدون رویداد', v_n, 0);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تمام تست‌های چک پاس شدند              ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
