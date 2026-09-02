-- =====================================================================
-- تست کلاینت ماشینی (کلید API) — مهاجرت ۰۳۰
-- =====================================================================
-- ادعای مرکزی: **کلید یک راه دور زدن مجوز نیست.**
--
-- افزونه ووکامرس نمی‌تواند وارد شود (کاربر پشتی `is_active = false`
-- است)، ولی هرچه می‌کند از همان `identity.can()` می‌گذرد که صندوق از
-- آن می‌گذرد. اگر روزی کسی برای کلید API یک مسیر مجوز جدا بسازد، این
-- فایل قرمز می‌شود.
--
-- و سه چیز دیگر که بی‌صدا می‌شکنند:
--   • کلید باطل‌شده باید هیچ سطری برنگرداند — نه سطری با پرچم خاموش.
--   • `last_used_at` باید در همان رفت‌وبرگشت نوشته شود، وگرنه هرگز.
--   • هش باید ۶۴ رقم هگز باشد؛ ذخیره خودِ کلید باید غیرممکن باشد.
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

-- هش کلید، همان کاری که `auth/api-key.ts` می‌کند: SHA-256 هگز.
CREATE OR REPLACE FUNCTION pg_temp.keyhash(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(p_key, 'sha256'), 'hex')
$$;

\echo '── کلاینت ماشینی ─────────────────────────────────────────────'

-- کاربر پشتی: دقیقاً مثل چیزی که `cli/create-api-client.ts` می‌سازد —
-- بدون رمز، بدون PIN، غیرفعال.
INSERT INTO identity.app_user (id, username, full_name, password_hash, pin_hash, is_active)
VALUES ('00000000-0000-7000-8000-0000000000c1', 'api:test-site:aaa', 'سایت آزمایشی',
        NULL, NULL, false);

INSERT INTO identity.user_role (user_id, role_code, branch_id)
VALUES ('00000000-0000-7000-8000-0000000000c1', 'web', NULL);

INSERT INTO identity.api_client (id, name, user_id, key_hash, created_by)
VALUES ('00000000-0000-7000-8000-0000000000c2', 'سایت آزمایشی',
        '00000000-0000-7000-8000-0000000000c1',
        pg_temp.keyhash('lmk_test_key'),
        '00000000-0000-7000-8000-0000000000f1');

SELECT pg_temp.assert_eq(
  'کلید معتبر → یک سطر',
  (SELECT count(*) FROM identity.api_client_from_key(pg_temp.keyhash('lmk_test_key'))),
  1);

SELECT pg_temp.assert_txt(
  'کاربر پشتی درست برگشت',
  (SELECT user_id::text FROM identity.api_client_from_key(pg_temp.keyhash('lmk_test_key'))),
  '00000000-0000-7000-8000-0000000000c1');

-- ⚠️ هسته این فایل: کلید غلط هیچ سطری نمی‌دهد. اگر روزی این تابع
--    «سطر با پرچم نامعتبر» برگرداند، لایه API که فقط `rows[0]` را
--    می‌بیند، هر کلیدی را قبول می‌کرد.
SELECT pg_temp.assert_eq(
  'کلید ناشناخته → هیچ سطری',
  (SELECT count(*) FROM identity.api_client_from_key(pg_temp.keyhash('lmk_wrong'))),
  0);

-- `last_used_at` باید همان لحظه نوشته شده باشد. تابع آن را در همان
-- UPDATE ... RETURNING می‌نویسد؛ اگر کسی روزی به SELECT ساده تبدیلش
-- کند، این ادعا قرمز می‌شود.
SELECT pg_temp.assert_eq(
  'زمان استفاده ثبت شد',
  (SELECT count(*) FROM identity.api_client
    WHERE id = '00000000-0000-7000-8000-0000000000c2' AND last_used_at IS NOT NULL),
  1);

-- باطل‌کردن = یک UPDATE. نه حذف سطر (تاریخچه بماند)، نه چرخاندن کلید.
UPDATE identity.api_client SET is_active = false
 WHERE id = '00000000-0000-7000-8000-0000000000c2';

SELECT pg_temp.assert_eq(
  'کلید باطل‌شده → هیچ سطری',
  (SELECT count(*) FROM identity.api_client_from_key(pg_temp.keyhash('lmk_test_key'))),
  0);

UPDATE identity.api_client SET is_active = true
 WHERE id = '00000000-0000-7000-8000-0000000000c2';

-- ذخیره خودِ کلید باید غیرممکن باشد — قید هگز جلویش را می‌گیرد. این
-- تنها چیزی است که میان «هش شد» و «یادمان رفت هش کنیم» فرق می‌گذارد.
SELECT pg_temp.assert_raises(
  'ذخیره کلید خام رد می‌شود',
  $$INSERT INTO identity.api_client (name, user_id, key_hash, created_by)
    VALUES ('بد', '00000000-0000-7000-8000-0000000000c1', 'lmk_plain_key',
            '00000000-0000-7000-8000-0000000000f1')$$);

SELECT pg_temp.assert_raises(
  'کلید تکراری رد می‌شود',
  $$INSERT INTO identity.api_client (name, user_id, key_hash, created_by)
    VALUES ('دوم', '00000000-0000-7000-8000-0000000000c1',
            encode(digest('lmk_test_key', 'sha256'), 'hex'),
            '00000000-0000-7000-8000-0000000000f1')$$);

\echo '── مجوز نقش سایت ─────────────────────────────────────────────'

-- ادعای مرکزی این فایل: کلید API هیچ قدرت تازه‌ای نمی‌دهد. همان
-- `identity.can()` روی کاربر پشتی حاکم است.
SELECT pg_temp.assert_txt(
  'سایت می‌تواند فاکتور بسازد',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'sale.create', NULL, NULL, false)),
  'allow');

SELECT pg_temp.assert_txt(
  'سایت می‌تواند قیمت بفرستد',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'sale.price_override', NULL, NULL, false)),
  'allow');

-- ⚠️ سقف کاهش بی‌سقف است و این یک **تصمیم** است، نه فراموشی: پول را
--    درگاه قبلاً گرفته. اگر مالک روزی سقف بگذارد، این ادعا قرمز
--    می‌شود و همان‌جا معلوم است که رفتار عوض شده.
SELECT pg_temp.assert_txt(
  'کاهش ۹۰٪ سایت مجاز است (کمپین)',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'sale.discount', NULL, 90.00, false)),
  'allow');

-- و آنچه عمداً بسته است. کلیدی که لو برود نباید بتواند پول برگرداند.
SELECT pg_temp.assert_txt(
  'سایت نمی‌تواند بازپرداخت نقدی بزند',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'refund.cash', NULL, NULL, false)),
  'deny');

SELECT pg_temp.assert_txt(
  'سایت نمی‌تواند فاکتور را ابطال کند',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'invoice.cancel', NULL, NULL, false)),
  'deny');

SELECT pg_temp.assert_txt(
  'سایت نمی‌تواند موجودی را اصلاح کند',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'stock.adjust', NULL, NULL, false)),
  'deny');

SELECT pg_temp.assert_txt(
  'سایت نمی‌تواند تنظیمات را عوض کند',
  (SELECT verdict::text FROM identity.can('00000000-0000-7000-8000-0000000000c1',
                                    'settings.manage', NULL, NULL, false)),
  'deny');

-- کاربر پشتی هرگز نمی‌تواند از مسیر رمز وارد شود. سه شرط، و هر سه
-- لازم‌اند — `is_active` تنها چیزی است که مسیر ورود می‌سنجد، ولی
-- نبودِ رمز و PIN یعنی حتی اگر روزی کسی سهواً فعالش کند، راهی نیست.
SELECT pg_temp.assert_eq(
  'کاربر پشتی: بدون رمز، بدون PIN، غیرفعال',
  (SELECT count(*) FROM identity.app_user
    WHERE id = '00000000-0000-7000-8000-0000000000c1'
      AND password_hash IS NULL AND pin_hash IS NULL AND NOT is_active),
  1);

\echo '✓ کلاینت ماشینی — همه ادعاها'

ROLLBACK;
