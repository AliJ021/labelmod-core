-- =====================================================================
-- تست سابقهٔ بکاپ، نسخهٔ بیرونی و پرداخت بلاتکلیف (مهاجرت ۱۲۲)
-- =====================================================================
-- ثابت این پرونده: نبودِ بکاپ تازه، نبودِ نسخهٔ بیرون از سرور، و پرداختی
-- که بلاتکلیف مانده **بی‌صدا** نمی‌مانند.
--
-- ⚠️ بند ۱ ضد‌پوچی است: روی دیتابیس تازه هر دو زنگ بکاپ باید **روشن** باشند.
--    اگر همیشه صفر برمی‌گشتند، بندهای بعدی بی‌معنا سبز می‌شدند.
-- ⚠️ بند ۲ و ۳ کنترل منفی دارند: بکاپ تازه و دانلود تازه زنگشان را خاموش
--    می‌کنند — وگرنه زنگی که هرگز خاموش نشود، فردا کسی نگاهش نمی‌کند.
-- ⚠️ بند ۳ ادعا می‌کند «ساخت» زنگ نسخهٔ بیرونی را خاموش **نمی‌کند**: بکاپ روی
--    همان سرور با دیسک خراب از بین می‌رود.
-- ⚠️ بند ۵ پرداخت تازه (کمتر از یک ساعت) را زنگ نمی‌شمارد: پرداختی که همین
--    حالا در جریان است، بلاتکلیف نیست.
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

CREATE OR REPLACE FUNCTION pg_temp.alert(p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT n::text || ' ' || severity FROM platform.health_alerts() WHERE code = p_code
$$;

DO $test$
DECLARE
  v_user uuid;
  v_inv  uuid;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('bkp_admin', 'مدیر بکاپ') RETURNING id INTO v_user;
PERFORM platform.set_actor(v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. دیتابیس تازه: هیچ بکاپی نیست و هر دو زنگ روشن‌اند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('وضعیت پیش از هر بکاپ',
  (SELECT backup_state || ' ' || offsite_state FROM platform.backup_status), 'never never');
PERFORM pg_temp.assert_eq('زنگ بکاپ تازه', pg_temp.alert('backup_stale'), '1 critical');
PERFORM pg_temp.assert_eq('زنگ نسخهٔ بیرونی', pg_temp.alert('backup_offsite_stale'), '1 warn');
PERFORM pg_temp.assert_eq('جزئیات «هرگز»',
  (SELECT detail FROM platform.health_alerts() WHERE code = 'backup_stale'), 'هیچ بکاپی ثبت نشده');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. بکاپ قدیمی‌تر از مهلت زنگ است؛ بکاپ تازه خاموشش می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- سطر «سه ساعت پیش» را نمی‌شود با تابع ساخت (زمان از ساعت دیتابیس است)، پس
-- اینجا با نقش مالک مستقیم درج می‌شود. نقش برنامه این حق را ندارد (`db-roles.sh`).

PERFORM platform.set_setting('backup.max_age_hours', '2'::jsonb, 'آزمون مهلت');
INSERT INTO platform.backup_event (kind, source, backup_ref, occurred_at)
VALUES ('created', 'scheduler', 'old.dump', clock_timestamp() - interval '3 hours');
PERFORM pg_temp.assert_eq('بکاپ سه‌ساعته با مهلت دوساعته', pg_temp.alert('backup_stale'), '1 critical');
PERFORM pg_temp.assert_eq('جزئیات تاریخ آخرین بکاپ را می‌گوید',
  (SELECT (detail LIKE 'آخرین: 20%')::text FROM platform.health_alerts() WHERE code = 'backup_stale'), 'true');
PERFORM platform.set_setting('backup.max_age_hours', '26'::jsonb, 'آزمون مهلت');
PERFORM pg_temp.assert_eq('همان بکاپ با مهلت ۲۶ ساعته', pg_temp.alert('backup_stale'), '0 critical');

PERFORM platform.set_setting('backup.max_age_hours', '2'::jsonb, 'آزمون مهلت');
PERFORM platform.record_backup_event('created', 'scheduler', 'labelmod-20261115-040000.dump',
  6400000, repeat('a', 64));
PERFORM pg_temp.assert_eq('بکاپ تازه زنگ را خاموش می‌کند', pg_temp.alert('backup_stale'), '0 critical');
PERFORM pg_temp.assert_raises('مهلت زیر حداقل',
  $q$SELECT platform.set_setting('backup.max_age_hours', '1'::jsonb, 'آزمون')$q$, '%کمتر از%');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. ساخت روی همان سرور، نسخهٔ بیرونی نیست ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('زنگ نسخهٔ بیرونی پس از ساخت', pg_temp.alert('backup_offsite_stale'), '1 warn');
INSERT INTO platform.backup_event (kind, source, backup_ref, actor_id, occurred_at)
VALUES ('downloaded', 'manager', 'old-download', v_user, clock_timestamp() - interval '8 days');
PERFORM pg_temp.assert_eq('دانلود هشت‌روزه با مهلت هفت‌روزه', pg_temp.alert('backup_offsite_stale'), '1 warn');
PERFORM platform.record_backup_event('downloaded', 'manager', gen_random_uuid()::text,
  6400000, repeat('b', 64), v_user);
PERFORM pg_temp.assert_eq('دانلود تازه زنگ را خاموش می‌کند', pg_temp.alert('backup_offsite_stale'), '0 warn');
PERFORM pg_temp.assert_eq('و زنگ بکاپ را روشن نمی‌کند', pg_temp.alert('backup_stale'), '0 critical');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. سابقه تغییرناپذیر است و شکل نادرست نمی‌پذیرد ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('ویرایش سابقه',
  $q$UPDATE platform.backup_event SET backup_ref = 'x'$q$, '%تغییرناپذیر%');
PERFORM pg_temp.assert_raises('حذف سابقه',
  $q$DELETE FROM platform.backup_event$q$, '%تغییرناپذیر%');
PERFORM pg_temp.assert_raises('دانلود بی آدم',
  $q$SELECT platform.record_backup_event('downloaded', 'manager', 'x')$q$, '%backup_event%');
PERFORM pg_temp.assert_raises('دانلود از زمان‌بند',
  format($q$SELECT platform.record_backup_event('downloaded', 'scheduler', 'x', NULL, NULL, %L::uuid)$q$, v_user),
  '%backup_event%');
PERFORM pg_temp.assert_raises('نوع ناشناخته',
  $q$SELECT platform.record_backup_event('deleted', 'manager', 'x')$q$, '%backup_event%');
PERFORM pg_temp.assert_raises('مرجع خالی',
  $q$SELECT platform.record_backup_event('created', 'manager', '   ')$q$, '%backup_event%');
PERFORM pg_temp.assert_raises('هش نادرست',
  $q$SELECT platform.record_backup_event('created', 'manager', 'x', 10, 'abc')$q$, '%backup_event%');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. پرداخت بلاتکلیف: یک ساعت مهلت، بعد زنگ ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('بی پرداخت بلاتکلیف', pg_temp.alert('payment_unresolved'), '0 warn');

INSERT INTO sales.invoice (branch_id, warehouse_id, channel, created_by)
VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000101', 'web', v_user)
RETURNING id INTO v_inv;

INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, 'cash', 'in', 100000, 'unknown', clock_timestamp() - interval '10 minutes');
PERFORM pg_temp.assert_eq('نامعلومِ ده‌دقیقه‌ای هنوز زنگ نیست', pg_temp.alert('payment_unresolved'), '0 warn');

INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, 'cash', 'in', 100000, 'pending', clock_timestamp() - interval '2 hours');
PERFORM pg_temp.assert_eq('در انتظارِ دوساعته زنگ است', pg_temp.alert('payment_unresolved'), '1 warn');

INSERT INTO treasury.payment (invoice_id, method_code, direction, amount, status, occurred_at)
VALUES (v_inv, 'cash', 'in', 100000, 'succeeded', clock_timestamp() - interval '2 hours');
PERFORM pg_temp.assert_eq('پرداخت موفق شمرده نمی‌شود', pg_temp.alert('payment_unresolved'), '1 warn');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. گزینهٔ هر زنگ تازه در تنظیم پیام هست ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('گزینه‌های سه زنگ تازه',
  (SELECT count(*)::text FROM platform.setting s, jsonb_array_elements(s.options) o
    WHERE s.key = 'notify.health_alert_codes'
      AND o->>'value' IN ('backup_stale','backup_offsite_stale','payment_unresolved')), '3');

RAISE NOTICE E'\n✔ سابقهٔ بکاپ — ضد‌پوچی، کنترل منفی، نسخهٔ بیرونی، تغییرناپذیری، پرداخت بلاتکلیف';
END $test$;

ROLLBACK;
