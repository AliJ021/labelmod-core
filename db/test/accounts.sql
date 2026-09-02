-- =====================================================================
-- کدینگ حساب چهارسطحی و ویرایش‌پذیر (مهاجرت ۰۱۹)
-- =====================================================================
-- مالک خواست کدینگ همان قابلیت‌های هلو و دشت را داشته باشد و **از صفحه**
-- عوض شود، نه با psql. آنچه اینجا قفل می‌شود، همان چیزهایی است که اگر
-- بشکنند، گزارش مالی بی‌صدا غلط می‌دهد — نه ظاهر صفحه.
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
  v_user uuid;
  v_n      int;
  v_row    ledger.account%ROWTYPE;
  v_acct   ledger.account%ROWTYPE;
  v_posted text;
  v_cust   uuid;
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('acct_test', 'تست کدینگ') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code) VALUES (v_user, 'admin');
PERFORM platform.set_actor(v_user);

INSERT INTO sales.customer (mobile_normalized, full_name)
VALUES ('09120000777','مشتری تست کدینگ') RETURNING id INTO v_cust;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. چهار سطح، و کدها دست‌نخورده ═══';
-- ═══════════════════════════════════════════════════════════════════
-- مهم‌ترین ادعای این مهاجرت: **کد حساب عوض نشده.** اگر شده بود،
-- posting_rule و هر سند موجود می‌شکست.

PERFORM pg_temp.assert_txt('حساب یک‌رقمی گروه شد',
  (SELECT level FROM ledger.account WHERE code = '1'), 'group');
PERFORM pg_temp.assert_txt('حساب دورقمی کل شد',
  (SELECT level FROM ledger.account WHERE code = '11'), 'kol');
PERFORM pg_temp.assert_txt('حساب چهاررقمی معین شد',
  (SELECT level FROM ledger.account WHERE code = '1101'), 'moin');

-- و همان حساب هنوز سند می‌پذیرد
PERFORM pg_temp.assert_txt('صندوق فروشگاه هنوز قابل ثبت است',
  (SELECT is_postable::text FROM ledger.account WHERE code = '1101'), 'true');

-- قواعد ثبت هنوز به حساب‌های موجود اشاره می‌کنند
SELECT count(*) INTO v_n
  FROM ledger.posting_rule r
 WHERE r.account_code IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ledger.account a WHERE a.code = r.account_code);
PERFORM pg_temp.assert_eq('قاعده ثبتِ بی‌حساب', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. سلسله‌مراتب اجبار می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- بدون این، صفحه کدینگ می‌توانست درخت را خراب کند و گزارش‌های
-- سلسله‌مراتبی **دوباره‌شماری** کنند — خطایی که در جمع کل دیده نمی‌شود.

PERFORM pg_temp.assert_raises('معین زیر معین',
  $$INSERT INTO ledger.account (code,parent_code,name,level,nature,type,is_postable)
    VALUES ('110109','1101','غلط','moin','debit','asset',true)$$);

PERFORM pg_temp.assert_raises('کد فرزند با کد والد شروع نمی‌شود',
  $$INSERT INTO ledger.account (code,parent_code,name,level,nature,type,is_postable)
    VALUES ('9999','11','غلط','moin','debit','asset',true)$$);

PERFORM pg_temp.assert_raises('گروه نباید والد داشته باشد',
  $$INSERT INTO ledger.account (code,parent_code,name,level,nature,type,is_postable)
    VALUES ('8','1','غلط','group','debit','asset',false)$$);

PERFORM pg_temp.assert_raises('سطح غیرگروه بدون والد',
  $$INSERT INTO ledger.account (code,parent_code,name,level,nature,type,is_postable)
    VALUES ('88',NULL,'غلط','kol','debit','asset',false)$$);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. سطح تفصیلی — همان چیزی که هلو دارد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- تفصیلی ریزِ شناور زیر معین است: مشتری، تأمین‌کننده، مرکز هزینه.

-- والد باید اول غیرقابل‌ثبت شود، وگرنه جمع دو بار شمرده می‌شود
PERFORM ledger.upsert_account('1201','حساب دریافتنی تجاری — مشتریان',
  'moin','12','debit','asset', false, v_user);

PERFORM ledger.upsert_account('120101','مشتری نمونه',
  'tafsili','1201','debit','asset', true, v_user);

PERFORM pg_temp.assert_txt('تفصیلی ساخته شد',
  (SELECT level FROM ledger.account WHERE code = '120101'), 'tafsili');

PERFORM pg_temp.assert_raises('والدِ قابل‌ثبت نمی‌تواند فرزند بگیرد',
  $$SELECT ledger.upsert_account('130101','غلط','tafsili','1301','debit','asset',true,
      (SELECT id FROM identity.app_user WHERE username='acct_test'))$$);

-- حسابی که فرزند دارد، خودش سند نمی‌پذیرد
PERFORM pg_temp.assert_raises('حسابِ دارای فرزند، قابل ثبت شود',
  $$SELECT ledger.upsert_account('1201','مشتریان','moin','12','debit','asset',true,
      (SELECT id FROM identity.app_user WHERE username='acct_test'))$$);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. ساخت و ویرایش از تابع، با ردّ حسابرسی ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('بدون کاربر عامل',
  $$SELECT ledger.upsert_account('7','تست','group',NULL,'debit','asset',false,NULL)$$);

PERFORM pg_temp.assert_raises('کد غیرعددی',
  $$SELECT ledger.upsert_account('AB','تست','group',NULL,'debit','asset',false,
      (SELECT id FROM identity.app_user WHERE username='acct_test'))$$);

PERFORM pg_temp.assert_raises('نام خالی',
  $$SELECT ledger.upsert_account('7','   ','group',NULL,'debit','asset',false,
      (SELECT id FROM identity.app_user WHERE username='acct_test'))$$);

v_row := ledger.upsert_account('7','گروه آزمایشی','group',NULL,'debit','asset',false, v_user);
PERFORM pg_temp.assert_txt('گروه تازه ساخته شد', v_row.name, 'گروه آزمایشی');

SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'account.create' AND entity_id = '7';
PERFORM pg_temp.assert_eq('ساخت حساب در لاگ حسابرسی', v_n, 1);

-- ویرایش نام، همان سطر را عوض می‌کند نه سطر تازه
PERFORM ledger.upsert_account('7','گروه آزمایشی (ویرایش‌شده)','group',NULL,'debit','asset',false, v_user);
SELECT count(*) INTO v_n FROM ledger.account WHERE code = '7';
PERFORM pg_temp.assert_eq('ویرایش سطر تازه نمی‌سازد', v_n, 1);

SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'account.update' AND entity_id = '7';
PERFORM pg_temp.assert_eq('ویرایش حساب در لاگ حسابرسی', v_n, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. حسابی که سند خورده، ماهیتش قفل می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- عوض‌کردن ماهیت حسابی که سند دارد، **گزارش‌های گذشته** را عوض می‌کند
-- بدون اینکه سندی اصلاح شده باشد. این بدترین نوع خطاست: عدد عوض
-- می‌شود و هیچ ردّی از چرایی‌اش نیست.

-- یک سند **واقعی** از مسیر خودش می‌زنیم تا قفل معنا پیدا کند. حساب را
-- دستی انتخاب نمی‌کنیم: از قاعده ثبت درمی‌آید، پس اگر کدینگ عوض شود
-- تست هم با آن می‌رود.
PERFORM ledger.post_entry('loyalty_grant',
  '00000000-0000-7000-8000-000000000001', now()::date,
  'سند آزمایشی کدینگ',
  jsonb_build_array(
    jsonb_build_object('leg','expense','amount', 1000000),
    jsonb_build_object('leg','liability','amount', 1000000,
                       'party_type','customer','party_id', v_cust)),
  NULL, NULL, v_user);

SELECT account_code INTO v_posted
  FROM ledger.journal_line ORDER BY id DESC LIMIT 1;
PERFORM pg_temp.assert_txt('سندی خورده تا قفل سنجیده شود',
  (v_posted IS NOT NULL)::text, 'true');

SELECT * INTO v_acct FROM ledger.account WHERE code = v_posted;

PERFORM pg_temp.assert_raises('ماهیت حسابِ سندخورده عوض شود',
  format($$SELECT ledger.upsert_account(%L,%L,%L,%L,
            CASE WHEN %L = 'debit' THEN 'credit' ELSE 'debit' END,
            'liability', %L,
            (SELECT id FROM identity.app_user WHERE username='acct_test'))$$,
          v_acct.code, v_acct.name, v_acct.level, v_acct.parent_code,
          v_acct.nature, v_acct.is_postable));

-- ولی تغییر **نام** آزاد است — نام یک برچسب است، نه یک ادعای مالی
PERFORM ledger.upsert_account(v_acct.code, v_acct.name || ' (ویرایش)',
  v_acct.level, v_acct.parent_code, v_acct.nature, v_acct.type,
  v_acct.is_postable, v_user);
PERFORM pg_temp.assert_txt('نام حسابِ سندخورده عوض می‌شود',
  (SELECT name FROM ledger.account WHERE code = v_acct.code),
  v_acct.name || ' (ویرایش)');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. غیرفعال‌کردن به‌جای حذف ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('غیرفعال‌کردن والدِ دارای فرزند فعال',
  $$SELECT ledger.set_account_active('12', false,
      (SELECT id FROM identity.app_user WHERE username='acct_test'))$$);

PERFORM ledger.set_account_active('7', false, v_user);
PERFORM pg_temp.assert_txt('حساب غیرفعال شد',
  (SELECT is_active::text FROM ledger.account WHERE code = '7'), 'false');

SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'account.set_active' AND entity_id = '7';
PERFORM pg_temp.assert_eq('غیرفعال‌سازی در لاگ حسابرسی', v_n, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. درخت برای صفحه ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_txt('گروه فرزند دارد',
  (SELECT has_children::text FROM ledger.account_tree WHERE code = '1'), 'true');
PERFORM pg_temp.assert_txt('حسابی که سند خورده علامت می‌خورد',
  (SELECT has_entries::text FROM ledger.account_tree WHERE code = v_acct.code), 'true');
PERFORM pg_temp.assert_txt('حسابی که سند نخورده، نه',
  (SELECT has_entries::text FROM ledger.account_tree WHERE code = '7'), 'false');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

-- هیچ حسابی نباید هم فرزند داشته باشد هم سند بپذیرد
SELECT count(*) INTO v_n FROM ledger.account a
 WHERE a.is_postable
   AND EXISTS (SELECT 1 FROM ledger.account c WHERE c.parent_code = a.code);
PERFORM pg_temp.assert_eq('حسابِ هم‌فرزنددار هم قابل‌ثبت', v_n, 0);

-- هر حساب غیرگروه باید والد موجود داشته باشد
SELECT count(*) INTO v_n FROM ledger.account a
 WHERE a.level <> 'group'
   AND NOT EXISTS (SELECT 1 FROM ledger.account p WHERE p.code = a.parent_code);
PERFORM pg_temp.assert_eq('حسابِ یتیم', v_n, 0);

RAISE NOTICE E'\n✔ کدینگ حساب — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
