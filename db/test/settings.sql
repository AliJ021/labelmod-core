-- =====================================================================
-- تست تنظیمات — فراداده، اعتبارسنجی و ردّ حسابرسی
-- =====================================================================
-- ادعای مرکزی: **مقدار یک تنظیم مالی، خودش داده مالی است.**
-- پس همان‌قدر که یک سند نامتوازن نباید ثبت شود، یک نرخ مالیات ۱۲۰
-- درصدی یا یک «شاید» به‌جای «بله/خیر» هم نباید بنشیند.
--
-- پوشش:
--   • هر کلید فراداده کامل دارد (وگرنه صفحه تنظیمات نمی‌تواند بسازدش)
--   • set_setting نوع، گزینه و بازه را می‌سنجد
--   • بدون کاربر عامل، هیچ تغییری ثبت نمی‌شود
--   • هر تغییر یک سطر حسابرسی با مقدار پیش و پس می‌گذارد
--   • کلید قفل‌شده از هیچ مسیری عوض نمی‌شود
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
  BR      uuid := '00000000-0000-7000-8000-000000000001';
  v_admin uuid;
  v_n     int;
  v_row   platform.setting;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('cfg','مدیر تنظیمات')
  RETURNING id INTO v_admin;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_admin,'admin',BR);

RAISE NOTICE E'\n── ۱. فراداده کامل است ──────────────────────────────────';

-- صفحه تنظیمات از همین ستون‌ها ساخته می‌شود. کلیدی که برچسب یا گروه
-- ندارد، در رابط کاربری یا نامرئی می‌شود یا با نام فنی انگلیسی
-- ظاهر می‌شود — هر دو یعنی مالک نمی‌فهمد دارد چه چیزی را عوض می‌کند.
SELECT count(*) INTO v_n FROM platform.setting WHERE label IS NULL;
PERFORM pg_temp.assert_eq('تنظیم بدون برچسب فارسی', v_n, 0);

SELECT count(*) INTO v_n FROM platform.setting WHERE kind = 'json';
PERFORM pg_temp.assert_eq('تنظیم بدون نوع مشخص', v_n, 0);

SELECT count(*) INTO v_n
  FROM platform.setting s
 WHERE NOT EXISTS (SELECT 1 FROM platform.setting_group g WHERE g.key = s.group_key);
PERFORM pg_temp.assert_eq('تنظیم در گروه ناشناخته', v_n, 0);

-- مجوز هر تنظیم باید عملیاتی باشد که دست‌کم یک نقش داشته باشدش،
-- وگرنه آن تنظیم را هیچ‌کس نمی‌تواند عوض کند — یعنی در عمل وجود ندارد.
SELECT count(*) INTO v_n
  FROM (SELECT DISTINCT permission FROM platform.setting WHERE is_editable) p
 WHERE NOT EXISTS (SELECT 1 FROM identity.permission_rule pr
                    WHERE pr.operation = p.permission AND pr.allowed);
PERFORM pg_temp.assert_eq('مجوزی که هیچ نقشی ندارد', v_n, 0);

-- گزینه‌دار بدون گزینه، و مقدار فعلی‌ای که در گزینه‌ها نیست.
-- مقدار فعلی یک تنظیم گزینه‌دار که در گزینه‌های خودش نیست، یعنی
-- فهرستِ رابط کاربری هیچ‌کدام را انتخاب‌شده نشان نمی‌دهد — و اولین
-- ذخیره، مقدار را بی‌سروصدا عوض می‌کند.
SELECT count(*) INTO v_n FROM platform.setting s
 WHERE s.kind = 'choice'
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.options) o
                    WHERE o->>'value' = s.value #>> '{}');
PERFORM pg_temp.assert_eq('گزینه‌دار با مقدار بیرون از گزینه‌ها', v_n, 0);

SELECT count(*) INTO v_n FROM platform.setting s
 WHERE s.kind = 'multichoice'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.value) e
                WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.options) o
                                   WHERE o->>'value' = e));
PERFORM pg_temp.assert_eq('چندگزینه‌ای با عضو بیرون از گزینه‌ها', v_n, 0);

-- مقدار فعلی هر عدد باید داخل بازه‌ای باشد که خودمان اعلام کرده‌ایم.
-- اگر نباشد، اولین باز و بسته‌کردن فرم در رابط کاربری خطا می‌دهد
-- بدون اینکه کاربر چیزی عوض کرده باشد.
SELECT count(*) INTO v_n FROM platform.setting
 WHERE kind IN ('int','percent','money')
   AND ( (min_value IS NOT NULL AND (value #>> '{}')::numeric < min_value)
      OR (max_value IS NOT NULL AND (value #>> '{}')::numeric > max_value) );
PERFORM pg_temp.assert_eq('مقدار فعلی بیرون از بازه اعلام‌شده', v_n, 0);

RAISE NOTICE E'\n── ۲. بدون کاربر عامل، هیچ تغییری ثبت نمی‌شود ────────────';

PERFORM set_config('labelmod.actor_id', '', true);
PERFORM pg_temp.assert_raises('تغییر تنظیم بدون set_actor',
  $$SELECT platform.set_setting('pos.require_customer', 'true'::jsonb)$$);

PERFORM platform.set_actor(v_admin);

RAISE NOTICE E'\n── ۳. نوع مقدار سنجیده می‌شود ────────────────────────────';

PERFORM pg_temp.assert_raises('بله/خیر با متن',
  $$SELECT platform.set_setting('pos.require_customer', '"شاید"'::jsonb)$$);
PERFORM pg_temp.assert_raises('عدد صحیح با اعشار',
  $$SELECT platform.set_setting('cheque.due_warning_days', '7.5'::jsonb)$$);
PERFORM pg_temp.assert_raises('عدد صحیح با متن',
  $$SELECT platform.set_setting('cheque.due_warning_days', '"هفت"'::jsonb)$$);
PERFORM pg_temp.assert_raises('گزینه‌ای بیرون از فهرست',
  $$SELECT platform.set_setting('costing.method', '"fifo"'::jsonb, 'تست')$$);
PERFORM pg_temp.assert_raises('چندگزینه‌ای با عضو ناشناخته',
  $$SELECT platform.set_setting('return.reason_codes', '["دلخواه"]'::jsonb)$$);
PERFORM pg_temp.assert_raises('مقدار تهی',
  $$SELECT platform.set_setting('pos.require_customer', 'null'::jsonb)$$);
PERFORM pg_temp.assert_raises('کلید ناموجود ساخته نمی‌شود',
  $$SELECT platform.set_setting('typo.key.that.does.not.exist', 'true'::jsonb)$$);

RAISE NOTICE E'\n── ۴. بازه سنجیده می‌شود ─────────────────────────────────';

PERFORM pg_temp.assert_raises('نرخ مالیات ۱۲۰ درصد',
  $$SELECT platform.set_setting('tax.default_rate', '120'::jsonb, 'تست')$$);
PERFORM pg_temp.assert_raises('طول رمز زیر حداقل SECURITY.md',
  $$SELECT platform.set_setting('auth.min_password_length', '6'::jsonb, 'تست')$$);
PERFORM pg_temp.assert_raises('PIN سه‌رقمی',
  $$SELECT platform.set_setting('auth.pin_length', '3'::jsonb, 'تست')$$);
PERFORM pg_temp.assert_raises('عمر نشست پرسنل بیش از یک شبانه‌روز',
  $$SELECT platform.set_setting('auth.session_hours_staff', '48'::jsonb, 'تست')$$);

RAISE NOTICE E'\n── ۵. تنظیم قفل‌شده از هیچ مسیری باز نمی‌شود ─────────────';

-- «هیچ Retry خودکاری روی پرداخت نامشخص» یک قاعده غیرقابل مذاکره است،
-- نه یک پیش‌فرض. اگر از مسیر تنظیمات باز می‌شد، قاعده نبود.
PERFORM pg_temp.assert_raises('روشن‌کردن Retry خودکار پرداخت',
  $$SELECT platform.set_setting('payment.unknown_auto_retry', 'true'::jsonb, 'تست')$$);
PERFORM pg_temp.assert_raises('تغییر واحد مبنای ذخیره‌سازی',
  $$SELECT platform.set_setting('currency.base', '"USD"'::jsonb, 'تست')$$);

RAISE NOTICE E'\n── ۶. تنظیم تصویب‌خواه بدون دلیل عوض نمی‌شود ─────────────';

PERFORM pg_temp.assert_raises('تغییر نرخ مالیات بدون دلیل',
  $$SELECT platform.set_setting('tax.default_rate', '9'::jsonb)$$);

RAISE NOTICE E'\n── ۷. تغییر معتبر می‌نشیند و ردّ حسابرسی می‌گذارد ────────';

SELECT count(*) INTO v_n FROM platform.audit_log WHERE action = 'setting.change';
PERFORM pg_temp.assert_eq('سطر حسابرسی پیش از تغییر', v_n, 0);

v_row := platform.set_setting('tax.default_rate', '9'::jsonb, 'ابلاغیه جدید سازمان امور مالیاتی');
PERFORM pg_temp.assert_txt('نرخ مالیات پس از تغییر', v_row.value #>> '{}', '9');
PERFORM pg_temp.assert_txt('کاربر تغییردهنده ثبت شد',
  (v_row.updated_by = v_admin)::text, 'true');

SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'setting.change'
   AND entity_id = 'tax.default_rate'
   AND before -> 'value' = '10'::jsonb
   AND after  -> 'value' = '9'::jsonb
   AND reason = 'ابلاغیه جدید سازمان امور مالیاتی';
PERFORM pg_temp.assert_eq('ردّ حسابرسی با مقدار پیش و پس', v_n, 1);

-- تغییری که چیزی را عوض نمی‌کند، رویدادی نیست.
PERFORM platform.set_setting('tax.default_rate', '9'::jsonb, 'همان مقدار');
SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'setting.change' AND entity_id = 'tax.default_rate';
PERFORM pg_temp.assert_eq('ثبت دوباره همان مقدار، لاگ تازه نمی‌سازد', v_n, 1);

-- روش قیمت تمام‌شده: هر دو گزینه باید پذیرفته شوند.
PERFORM platform.set_setting('costing.method', '"last_purchase"'::jsonb, 'روش رایج فروشگاه');
PERFORM pg_temp.assert_txt('روش قیمت تمام‌شده',
  platform.setting_text('costing.method'), 'last_purchase');
PERFORM platform.set_setting('costing.method', '"moving_weighted_average"'::jsonb, 'بازگشت');

-- سند فروش: هر دو حالت باید انتخاب‌شدنی باشند.
PERFORM platform.set_setting('ledger.sale_posting', '"per_invoice"'::jsonb, 'تست');
PERFORM pg_temp.assert_txt('سند فروش', platform.setting_text('ledger.sale_posting'), 'per_invoice');
PERFORM platform.set_setting('ledger.sale_posting', '"per_shift"'::jsonb, 'بازگشت');

-- سیاست PIN قابل تغییر است، ولی فقط با گزینه‌های شناخته‌شده.
PERFORM platform.set_setting('auth.pin_forbidden_operations',
  '["refund.cash","invoice.cancel","price.change","stock.adjust","period.close",
    "period.reopen","user.manage","journal.manual","return.late","settings.security"]'::jsonb,
  'سخت‌گیرانه‌تر شد');
SELECT count(*) INTO v_n FROM jsonb_array_elements_text(
  platform.setting_json('auth.pin_forbidden_operations'));
PERFORM pg_temp.assert_eq('تعداد عملیات ممنوع با PIN', v_n, 10);

RAISE NOTICE E'\n── ۸. UPDATE مستقیم روی مقدار رد می‌شود ──────────────────';

-- «تنها در ورودی» باید یک قفل باشد، نه یک قرارداد. نقش اپلیکیشن روی
-- این جدول UPDATE دارد؛ بدون این نگهبان، یک باگ یا یک اسکریپت
-- می‌توانست نرخ مالیات را بی‌اعتبارسنجی و بی‌ردّ حسابرسی جابه‌جا کند.
PERFORM pg_temp.assert_raises('UPDATE مستقیم روی مقدار تنظیم',
  $$UPDATE platform.setting SET value = '99'::jsonb WHERE key = 'tax.default_rate'$$);
PERFORM pg_temp.assert_eq('مقدار پس از تلاش ناموفق',
  platform.setting_num('tax.default_rate'), 9);

-- ولی فراداده باید آزاد بماند، وگرنه اجرای دوباره seed می‌شکند.
UPDATE platform.setting SET label = label WHERE key = 'tax.default_rate';
UPDATE platform.setting SET help = 'متن راهنمای تازه' WHERE key = 'tax.default_rate';
PERFORM pg_temp.assert_txt('به‌روزرسانی فراداده بی‌مانع است',
  (SELECT help FROM platform.setting WHERE key = 'tax.default_rate'),
  'متن راهنمای تازه');

RAISE NOTICE E'\n── ۹. خواننده‌های نوع‌دار ────────────────────────────────';

PERFORM pg_temp.assert_eq('setting_int', platform.setting_int('auth.pin_length'), 4);
PERFORM pg_temp.assert_txt('setting_bool',
  platform.setting_bool('tax.enabled')::text, 'false');
PERFORM pg_temp.assert_eq('setting_num روی درصد', platform.setting_num('tax.default_rate'), 9);
PERFORM pg_temp.assert_eq('پیش‌فرض کلید ناموجود', platform.setting_int('no.such.key', 42), 42);

RAISE NOTICE E'\n✔ تنظیمات — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
