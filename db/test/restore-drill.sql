-- =====================================================================
-- تست تمرین بازیابی — زنگی که نباید با شکست خاموش شود
-- =====================================================================
-- ادعای مرکزی: **تمرینی که شکست خورده، ثابت کرده بکاپ سالم نیست.**
-- شمردنش به‌عنوان «آخرین تمرین» یعنی هشدار را با همان چیزی خاموش کنیم
-- که باید بلندش کند.
--
-- پوشش:
--   • بدون هیچ تمرینی، وضعیت `never` است — نه `ok`
--   • تمرین **ناموفق** وضعیت را `ok` نمی‌کند
--   • تمرین موفق زنگ را خاموش می‌کند
--   • عبور از مهلت دوباره `overdue` می‌شود، و مهلت از تنظیم می‌آید
--   • سابقه تمرین تغییرناپذیر است
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

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
  v_status text;
  v_n      int;
  v_id     uuid;
  v_var    uuid;
BEGIN

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. بدون تمرین، زنگ بلند است ═══';
-- ═══════════════════════════════════════════════════════════════════
-- `never` عمداً از `overdue` جداست: «هرگز آزموده نشده» بدترین حالت
-- است و نباید با «کمی دیر شده» یکی شمرده شود.

-- ⚠️ Trigger تغییرناپذیری عمداً جلوی پاک‌سازی را هم می‌گیرد، پس
--    برای **چیدن صحنه** موقتاً خاموش می‌شود. خودش در بند ۵ سنجیده
--    می‌شود و کل این تست در یک تراکنش Rollback‌شونده است.
ALTER TABLE platform.restore_drill DISABLE TRIGGER restore_drill_no_update;
DELETE FROM platform.restore_drill;

SELECT status INTO v_status FROM platform.restore_drill_status;
PERFORM pg_temp.assert_txt('بدون تمرین، وضعیت never است', v_status, 'never');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. تمرین ناموفق زنگ را خاموش نمی‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- **ادعای مرکزی این پرونده.** اگر تمرین ناموفق هم «آخرین تمرین»
-- شمرده می‌شد، کافی بود اسکریپت هر شب اجرا شود و شکست بخورد تا هیچ‌کس
-- هرگز هشداری نبیند.

v_id := platform.record_restore_drill('bad.dump', false, 0, 123, 'ادعاها شکستند');
SELECT status INTO v_status FROM platform.restore_drill_status;
PERFORM pg_temp.assert_txt('تمرین ناموفق، وضعیت را ok نمی‌کند', v_status, 'never');

-- ولی خودِ تلاش ثبت شده — تا معلوم باشد کسی امتحان کرده و نشده.
SELECT count(*)::int INTO v_n FROM platform.restore_drill;
PERFORM pg_temp.assert_txt('تلاش ناموفق ثبت می‌شود', v_n::text, '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. تمرین موفق زنگ را خاموش می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.record_restore_drill('good.dump', true, 8, 499701, NULL);
SELECT status INTO v_status FROM platform.restore_drill_status;
PERFORM pg_temp.assert_txt('پس از تمرین موفق، وضعیت ok است', v_status, 'ok');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. عبور از مهلت دوباره زنگ می‌زند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- مهلت از **تنظیم** می‌آید، نه از یک عدد در کد. اگر مالک آن را عوض
-- کند، زنگ باید با همان عوض شود.

DELETE FROM platform.restore_drill;
-- یک تمرین موفق، ولی قدیمی‌تر از مهلت.
INSERT INTO platform.restore_drill (drilled_on, backup_file, ok, checks_passed)
VALUES (platform.business_date() - 45, 'old.dump', true, 8);

SELECT status INTO v_status FROM platform.restore_drill_status;
PERFORM pg_temp.assert_txt('۴۵ روز با مهلت ۳۰ روزه: overdue', v_status, 'overdue');

-- حالا مهلت را باز می‌کنیم — همان تمرین باید کافی شود.
-- ⚠️ `set_setting` بدون کاربر عامل رد می‌شود، و آن **درست** است:
--    مقدار یک تنظیم مالی خودش داده مالی است و باید ردّ حسابرسی
--    داشته باشد.
PERFORM platform.set_actor(
  (SELECT id FROM identity.app_user WHERE username = 'system'));
PERFORM platform.set_setting('backup.restore_drill_days', '60'::jsonb, 'تست');
SELECT status INTO v_status FROM platform.restore_drill_status;
PERFORM pg_temp.assert_txt('با مهلت ۶۰ روزه، همان تمرین کافی است', v_status, 'ok');

PERFORM platform.set_setting('backup.restore_drill_days', '30'::jsonb, 'بازگشت');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. سابقه تمرین تغییرناپذیر است ═══';
-- ═══════════════════════════════════════════════════════════════════
-- تاریخچه‌ای که بشود عقب بردش، تاریخچه نیست. همان قاعده لاگ حسابرسی.

ALTER TABLE platform.restore_drill ENABLE TRIGGER restore_drill_no_update;
-- یک سطر ناموفق لازم است تا UPDATE چیزی برای هدف‌گرفتن داشته باشد.
INSERT INTO platform.restore_drill (backup_file, ok, checks_passed)
VALUES ('for-immutability.dump', false, 0);

BEGIN
  UPDATE platform.restore_drill SET ok = true WHERE NOT ok;
  RAISE EXCEPTION 'ویرایش سابقه تمرین باید رد شود';
EXCEPTION WHEN sqlstate 'P0001' THEN
  IF sqlstate = 'P0001' AND SQLERRM LIKE '%تغییرناپذیر%' THEN
    RAISE NOTICE '  ✓ ویرایش سابقه تمرین رد شد';
  ELSE
    RAISE;
  END IF;
END;

BEGIN
  DELETE FROM platform.restore_drill;
  RAISE EXCEPTION 'حذف سابقه تمرین باید رد شود';
EXCEPTION WHEN sqlstate 'P0001' THEN
  IF SQLERRM LIKE '%تغییرناپذیر%' THEN
    RAISE NOTICE '  ✓ حذف سابقه تمرین رد شد';
  ELSE
    RAISE;
  END IF;
END;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. نام فایل اجباری است ═══';
-- ═══════════════════════════════════════════════════════════════════
-- سابقه‌ای که نگوید کدام بکاپ آزموده شده، چیزی را ثابت نمی‌کند.

BEGIN
  PERFORM platform.record_restore_drill('   ', true, 8);
  RAISE EXCEPTION 'تمرین بدون نام فایل باید رد شود';
EXCEPTION WHEN sqlstate 'P0001' THEN
  IF SQLERRM LIKE '%نام فایل%' THEN
    RAISE NOTICE '  ✓ تمرین بدون نام فایل رد شد';
  ELSE
    RAISE;
  END IF;
END;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. آشکارساز مغایرت مانده واقعاً می‌گیرد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- `inventory.balance_check` تنها راه دیدن واگراییِ مانده از حرکت‌هاست،
-- و پنج پرونده تست ادعا می‌کنند خالی است. ولی «خالی است» وقتی ارزش
-- دارد که ثابت شود **می‌توانست خالی نباشد**.
--
-- ⚠️ `stock_balance` تنها جدول مالی است که Trigger تغییرناپذیری
--    **ندارد** — و نمی‌تواند داشته باشد، چون `apply_movement` خودش
--    می‌نویسدش. پس تنها دفاع، همین نما و کسی است که نگاهش کند:
--    `ops/deploy.sh status` روی سیستم زنده و `ops/restore-drill.sh`
--    روی بکاپ.

INSERT INTO catalog.product (code, name_internal)
VALUES ('BCHK', 'کالای آشکارساز') RETURNING id INTO v_id;

INSERT INTO catalog.variation (product_id, color, size, sku)
VALUES (v_id, 'سبز', 'L', 'BCHK-SKU') RETURNING id INTO v_var;

PERFORM platform.set_actor(
  (SELECT id FROM identity.app_user WHERE username = 'system'));
PERFORM inventory.apply_movement(
  v_var, '00000000-0000-7000-8000-000000000101'::uuid, 10, 'purchase_receipt',
  NULL, NULL, (SELECT id FROM identity.app_user WHERE username = 'system'), 500000);

SELECT count(*)::int INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_txt('پس از حرکت سالم، مغایرتی نیست', v_n::text, '0');

-- حالا مانده را دستی خراب می‌کنیم — همان کاری که یک باگ یا یک psql
-- دستی می‌تواند بکند، و دیتابیس جلویش را **نمی‌گیرد**.
UPDATE inventory.stock_balance SET on_hand = on_hand + 7
 WHERE variation_id = v_var;

SELECT count(*)::int INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_txt('مانده دستکاری‌شده دیده می‌شود', v_n::text, '1');

RAISE NOTICE E'\n✔ تمرین بازیابی — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
