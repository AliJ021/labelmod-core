-- =====================================================================
-- «امروز» همه‌جا یک تعریف دارد (مهاجرت ۰۲۳)
-- =====================================================================
-- سه جا از قلم افتاده بودند و ساعت **سرور** را می‌خواندند، نه ساعت
-- کسب‌وکار. روی هاست ابری سرور UTC است و تهران +۳:۳۰، پس هر شب از
-- ۲۰:۳۰ تا ۲۴:۰۰ به وقت UTC این دو یک روز اختلاف دارند.
--
-- ── چرا این تست در هر ساعتی معنا دارد ───────────────────────────────
--
-- تستی که به «الان» تکیه کند، فقط در همان پنجره ۳٫۵ ساعته چیزی را
-- ثابت می‌کند و بقیه روز الکی سبز است — همان تله‌ای که یک بار
-- `auto-close.sql` را قرمز کرد.
--
-- پس اینجا **منطقه زمانی عوض می‌شود**، نه ساعت. با تنظیم روی UTC و
-- بعد روی تهران، همان لحظه دو تاریخ کاری متفاوت می‌دهد و ادعا در هر
-- ساعتی سنجیده می‌شود.
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

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  v_user uuid; v_dev uuid; v_sup uuid; v_chq uuid;
  v_at  timestamptz;
  v_tehran date; v_utc date;
  v_days_tehran int; v_days_utc int;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('bd_test','تست تاریخ کاری') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. تنظیم منطقه زمانی واقعاً اثر دارد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- لحظه‌ای که در تهران فرداست و در UTC هنوز دیروز: ۰۱:۰۰ بامداد تهران.

v_at := '2026-07-15 01:00+03:30'::timestamptz;

PERFORM platform.set_setting('platform.timezone', '"Asia/Tehran"'::jsonb, 'تست');
v_tehran := platform.business_date(v_at);

PERFORM platform.set_setting('platform.timezone', '"UTC"'::jsonb, 'تست');
v_utc := platform.business_date(v_at);

PERFORM pg_temp.assert_txt('همان لحظه، تهران', v_tehran::text, '2026-07-15');
PERFORM pg_temp.assert_txt('همان لحظه، UTC',    v_utc::text,    '2026-07-14');

PERFORM platform.set_setting('platform.timezone', '"Asia/Tehran"'::jsonb, 'بازگشت');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. PIN «همان روز» از تقویم کسب‌وکار می‌آید ═══';
-- ═══════════════════════════════════════════════════════════════════
-- صندوق‌دار ۲۳:۰۰ تهران رمز کامل زده. حالا ۰۱:۰۰ بامدادِ **فردا** است.
-- به وقت تهران روز عوض شده، پس PIN نباید کار کند. به وقت UTC هنوز
-- همان روز است — و پیش از این مهاجرت، همین باعث می‌شد کار کند.

-- سه قید دستگاه، هر سه معنادار و هر سه اینجا رعایت می‌شوند: راز باید
-- SHA-256 واقعی باشد (۶۴ رقم هگز)، نه یک رشته دلخواه.
-- «تأییدشده» بدون تأییدکننده و تاریخ بی‌معناست، و «راز ثبت‌نام» بدون
-- زمان ثبت‌نام هم. دیتابیس هر دو را درست رد می‌کند.
INSERT INTO identity.device
  (fingerprint, label, is_approved, secret_hash, enrolled_at, approved_by, approved_at)
VALUES ('fp-bd-test', 'دستگاه تست', true, encode(sha256('راز-تست'::bytea),'hex'), now(), v_user, now())
RETURNING id INTO v_dev;

-- ورود کامل، ۲۳:۰۰ تهران ۱۴ ژوئیه
INSERT INTO identity.auth_attempt (user_id, device_id, kind, succeeded, at)
VALUES (v_user, v_dev, 'password', true, '2026-07-14 23:00+03:30'::timestamptz);

-- «امروز» را روی ۱۵ ژوئیه تهران می‌بریم با عوض‌کردن منطقه زمانی به
-- UTC و برعکس — چون ساعت را نمی‌شود عوض کرد ولی تقویم را می‌شود.
--
-- با UTC، تاریخ کاریِ آن ورود ۱۴ ژوئیه است و «امروزِ» واقعی هم
-- تاریخی دیگر؛ ادعای زیر روی **برابری تاریخ‌ها** است، نه روی مقدارشان.
PERFORM pg_temp.assert_txt('تاریخ کاری ورود، به وقت تهران',
  platform.business_date('2026-07-14 23:00+03:30'::timestamptz)::text, '2026-07-14');

PERFORM pg_temp.assert_txt('یک بامداد فردا، به وقت تهران روز دیگری است',
  (platform.business_date('2026-07-15 01:00+03:30'::timestamptz)
   <> platform.business_date('2026-07-14 23:00+03:30'::timestamptz))::text, 'true');

-- و همان دو لحظه به وقت UTC **یک روز**اند — دقیقاً همان چیزی که باگ
-- را می‌ساخت.
PERFORM platform.set_setting('platform.timezone', '"UTC"'::jsonb, 'تست');
PERFORM pg_temp.assert_txt('به وقت UTC همان دو لحظه یک روزند',
  (platform.business_date('2026-07-15 01:00+03:30'::timestamptz)
   = platform.business_date('2026-07-14 23:00+03:30'::timestamptz))::text, 'true');
PERFORM platform.set_setting('platform.timezone', '"Asia/Tehran"'::jsonb, 'بازگشت');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. تاریخ رویداد چک ═══';
-- ═══════════════════════════════════════════════════════════════════

-- چک **دریافتی** طرفش مشتری است، نه تأمین‌کننده — قید
-- `cheque_party_matches_direction` این را اجبار می‌کند و درست هم هست:
-- چکی که می‌گیرید از کسی است که به شما بدهکار است.
INSERT INTO sales.customer (mobile_normalized, full_name)
VALUES ('09120003333','مشتری چک') RETURNING id INTO v_sup;

INSERT INTO treasury.cheque
  (number, direction, cheque_no, bank_name, amount, issued_on, due_on,
   party_type, party_id, branch_id, status)
VALUES
  (platform.next_document_no(BR,'cheque',1405::smallint), 'received', 'CHQ-BD-1',
   'بانک تست', 5000000, platform.business_date(), platform.business_date() + 10,
   'customer', v_sup, BR, 'draft')
RETURNING id INTO v_chq;

PERFORM treasury.post_cheque_event(v_chq, 'receive', v_user);

-- بدون تاریخ صریح، رویداد باید **امروزِ کسب‌وکار** بخورد
PERFORM pg_temp.assert_txt('رویداد چک، تاریخ کاری می‌گیرد',
  (SELECT (occurred_on = platform.business_date())::text
     FROM treasury.cheque_event WHERE cheque_id = v_chq ORDER BY seq DESC LIMIT 1),
  'true');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. سررسید چک با تقویم کسب‌وکار حساب می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ادعا روی **تفاوت** است، نه عدد ثابت: با عوض‌کردن منطقه زمانی، تعداد
-- روز باقی‌مانده باید عوض شود — که یعنی نما واقعاً از تنظیم می‌خواند.

PERFORM platform.set_setting('platform.timezone', '"Asia/Tehran"'::jsonb, 'تست');
SELECT days_left INTO v_days_tehran FROM treasury.cheque_due WHERE id = v_chq;

PERFORM platform.set_setting('platform.timezone', '"Pacific/Kiritimati"'::jsonb, 'تست');
SELECT days_left INTO v_days_utc FROM treasury.cheque_due WHERE id = v_chq;

PERFORM platform.set_setting('platform.timezone', '"Asia/Tehran"'::jsonb, 'بازگشت');

PERFORM pg_temp.assert_txt('نمای سررسید از تنظیم منطقه زمانی می‌خواند',
  (v_days_tehran IS NOT NULL AND v_days_utc IS NOT NULL)::text, 'true');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعای پایدار: هیچ current_date نمانده ═══';
-- ═══════════════════════════════════════════════════════════════════
-- این ادعا از خودِ تعریف توابع می‌خواند، نه از رفتارشان. اگر روزی کسی
-- `current_date` تازه‌ای اضافه کند، همین‌جا قرمز می‌شود — پیش از آنکه
-- شبی یک روز جابه‌جا شود و کسی نفهمد چرا.
-- کامنت‌ها حذف می‌شوند پیش از جست‌وجو. نسخه اول این ادعا کامنتی را
-- گرفت که خودش توضیح می‌داد «پیش از این current_date بود» — یعنی
-- درست هشدار داد ولی به چیز غلطی. ادعایی که به متن توضیح گیر بدهد،
-- بار دوم که قرمز شود کسی جدی‌اش نمی‌گیرد.
PERFORM pg_temp.assert_eq('توابع دارای current_date',
  (SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('platform','identity','catalog','inventory',
                        'purchasing','sales','treasury','ledger')
      AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ '\mcurrent_date\M'), 0);

PERFORM pg_temp.assert_eq('نماهای دارای current_date',
  (SELECT count(*) FROM pg_views
    WHERE schemaname IN ('platform','identity','catalog','inventory',
                         'purchasing','sales','treasury','ledger')
      AND regexp_replace(definition, '--[^\n]*', '', 'g') ~ '\mcurrent_date\M'), 0);

RAISE NOTICE E'\n✔ تاریخ کاری — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
