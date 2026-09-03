-- =====================================================================
-- تست چرخه حیات کالا و تاریخچه قیمت
-- =====================================================================
-- سه ادعای مرکزی:
--
-- ۱. **قیمت قبلی هرگز پاک نمی‌شود.** تغییر قیمت یعنی بستن سطر باز و
--    درج سطر تازه. UPDATE مبلغ و DELETE سطر، هر دو رد می‌شوند.
--
-- ۲. **فاکتور نهایی‌شده پس از تغییر قیمت تکان نمی‌خورد.** این تنها
--    ادعایی است که اگر بشکند، دفتر دروغ می‌گوید.
--
-- ۳. **قیمت در تاریخ X ساختنی است.** مرز `valid_to`/`valid_from` نه
--    همپوشانی دارد نه شکاف، پس خوانش «در آن لحظه» همیشه دقیقاً یک
--    سطر برمی‌گرداند.
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
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual, '(تهی)');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 74);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_t1 timestamptz; v_t2 timestamptz;
  v_n int; v_amount platform.money; v_txt text;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('pp','تست قیمت')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

RAISE NOTICE E'\n═══ ۱. ساخت و ویرایش کالا ═══';

v_prod := catalog.upsert_product(NULL, 'P-PP', 'شلوار پارچه‌ای رگولار');
PERFORM pg_temp.assert_txt('کالا ساخته شد',
  (SELECT name_internal FROM catalog.product WHERE id = v_prod), 'شلوار پارچه‌ای رگولار');
PERFORM pg_temp.assert_txt('وضعیت پیش‌فرض فعال است',
  (SELECT status FROM catalog.product WHERE id = v_prod), 'active');
PERFORM pg_temp.assert_eq('ساخت کالا در لاگ حسابرسی نشست', (
  SELECT count(*) FROM platform.audit_log
   WHERE action = 'product.create' AND entity_id = v_prod::text), 1);

PERFORM catalog.upsert_product(v_prod, 'P-PP', 'شلوار پارچه‌ای رگولار — اصلاح‌شده',
                               'Regular Trouser');
PERFORM pg_temp.assert_txt('نام داخلی ویرایش شد',
  (SELECT name_internal FROM catalog.product WHERE id = v_prod),
  'شلوار پارچه‌ای رگولار — اصلاح‌شده');
PERFORM pg_temp.assert_txt('نام سایت جدا از نام داخلی است',
  (SELECT name_web FROM catalog.product WHERE id = v_prod), 'Regular Trouser');

PERFORM pg_temp.assert_raises('کد کالا پس از ساخت عوض نمی‌شود',
  format('SELECT catalog.upsert_product(%L, %L, %L)', v_prod, 'P-XX', 'هرچه'));
PERFORM pg_temp.assert_raises('نام خالی رد می‌شود',
  format('SELECT catalog.upsert_product(NULL, %L, %L)', 'P-EMPTY', '   '));
PERFORM pg_temp.assert_raises('کد خالی رد می‌شود',
  format('SELECT catalog.upsert_product(NULL, %L, %L)', '  ', 'نام دارد'));
PERFORM pg_temp.assert_raises('کد تکراری رد می‌شود',
  format('SELECT catalog.upsert_product(NULL, %L, %L)', 'P-PP', 'دوقلو'));

INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سبز لجنی','30','PP-030') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سبز لجنی','32','PP-032') RETURNING id INTO v_var2;

RAISE NOTICE E'\n═══ ۲. اولین قیمت، و تغییرش ═══';

v_p1 := catalog.set_price(v_var, 4380000);
PERFORM pg_temp.assert_eq('قیمت اول ثبت شد',
  (SELECT amount FROM catalog.price WHERE id = v_p1), 4380000);
PERFORM pg_temp.assert_eq('و باز است (valid_to تهی)',
  (SELECT count(*) FROM catalog.price WHERE id = v_p1 AND valid_to IS NULL), 1);
PERFORM pg_temp.assert_eq('نمای قیمت جاری یک سطر می‌دهد',
  (SELECT count(*) FROM catalog.current_price WHERE variation_id = v_var), 1);

-- همان مبلغ دوباره: سطر تازه‌ای ساخته نمی‌شود
PERFORM pg_temp.assert_txt('همان قیمت دوباره، سطر تازه نمی‌سازد',
  catalog.set_price(v_var, 4380000)::text, v_p1::text);
PERFORM pg_temp.assert_eq('هنوز یک سطر تاریخچه',
  (SELECT count(*) FROM catalog.price WHERE variation_id = v_var), 1);

-- حراج فصلی
v_p2 := catalog.set_price(v_var, 3500000, 'markdown', 'حراج پایان فصل');
PERFORM pg_temp.assert_eq('حالا دو سطر تاریخچه',
  (SELECT count(*) FROM catalog.price WHERE variation_id = v_var), 2);
PERFORM pg_temp.assert_eq('سطر قدیم بسته شد',
  (SELECT count(*) FROM catalog.price WHERE id = v_p1 AND valid_to IS NOT NULL), 1);
PERFORM pg_temp.assert_eq('مبلغ سطر قدیم دست نخورد',
  (SELECT amount FROM catalog.price WHERE id = v_p1), 4380000);
PERFORM pg_temp.assert_eq('فقط یک سطر باز مانده',
  (SELECT count(*) FROM catalog.price
    WHERE variation_id = v_var AND valid_to IS NULL), 1);
PERFORM pg_temp.assert_txt('نوعش markdown است',
  (SELECT kind FROM catalog.price WHERE id = v_p2), 'markdown');
PERFORM pg_temp.assert_txt('و دلیلش ثبت شد',
  (SELECT reason FROM catalog.price WHERE id = v_p2), 'حراج پایان فصل');

-- ── مرز زمانی: نه همپوشانی، نه شکاف ────────────────────────────────
SELECT valid_to   INTO v_t1 FROM catalog.price WHERE id = v_p1;
SELECT valid_from INTO v_t2 FROM catalog.price WHERE id = v_p2;
PERFORM pg_temp.assert_eq('پایان قیمت قدیم = شروع قیمت تازه',
  CASE WHEN v_t1 = v_t2 THEN 1 ELSE 0 END, 1);

RAISE NOTICE E'\n═══ ۳. قیمت در تاریخ X — دقیقاً یک سطر ═══';

-- همان کوئری‌ای که invoice.currentPrice می‌زند
PERFORM pg_temp.assert_eq('در لحظه مرز، قیمت تازه برمی‌گردد', (
  SELECT count(*) FROM catalog.price
   WHERE variation_id = v_var AND price_list = 'default'
     AND valid_from <= v_t2 AND (valid_to IS NULL OR valid_to > v_t2)), 1);
PERFORM pg_temp.assert_eq('و مبلغش قیمت حراج است', (
  SELECT amount FROM catalog.price
   WHERE variation_id = v_var AND price_list = 'default'
     AND valid_from <= v_t2 AND (valid_to IS NULL OR valid_to > v_t2)), 3500000);
PERFORM pg_temp.assert_eq('یک میکروثانیه قبل، قیمت قدیم برمی‌گردد', (
  SELECT amount FROM catalog.price
   WHERE variation_id = v_var AND price_list = 'default'
     AND valid_from <= v_t2 - interval '1 microsecond'
     AND (valid_to IS NULL OR valid_to > v_t2 - interval '1 microsecond')), 4380000);

-- دو تغییر پشت‌سرهم در **همین** تراکنش. با now() قید
-- valid_to > valid_from می‌شکست، چون now() زمان شروع تراکنش است.
v_p3 := catalog.set_price(v_var, 3200000, 'markdown', 'حراج عمیق‌تر');
PERFORM pg_temp.assert_eq('دو تغییر در یک تراکنش، بدون شکستن قید',
  (SELECT count(*) FROM catalog.price WHERE variation_id = v_var), 3);
PERFORM pg_temp.assert_eq('هیچ سطری valid_to <= valid_from ندارد', (
  SELECT count(*) FROM catalog.price
   WHERE variation_id = v_var AND valid_to IS NOT NULL AND valid_to <= valid_from), 0);
PERFORM pg_temp.assert_eq('و هنوز فقط یک سطر باز است', (
  SELECT count(*) FROM catalog.price
   WHERE variation_id = v_var AND valid_to IS NULL), 1);

RAISE NOTICE E'\n═══ ۴. تاریخچه تغییرناپذیر است ═══';

PERFORM pg_temp.assert_raises('مبلغ سطر قیمت UPDATE نمی‌شود',
  format('UPDATE catalog.price SET amount = 1 WHERE id = %L', v_p3));
PERFORM pg_temp.assert_raises('valid_from عوض نمی‌شود',
  format('UPDATE catalog.price SET valid_from = now() WHERE id = %L', v_p3));
PERFORM pg_temp.assert_raises('سطر قیمت حذف نمی‌شود',
  format('DELETE FROM catalog.price WHERE id = %L', v_p3));
PERFORM pg_temp.assert_raises('سطر بسته‌شده دیگر باز نمی‌شود',
  format('UPDATE catalog.price SET valid_to = NULL WHERE id = %L', v_p1));
PERFORM pg_temp.assert_raises('سطر بسته‌شده دوباره بسته نمی‌شود',
  format('UPDATE catalog.price SET valid_to = now() WHERE id = %L', v_p1));
PERFORM pg_temp.assert_raises('دو قیمت باز برای یک تنوع ممکن نیست',
  format('INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (%L, %L, 1)',
         v_var, 'default'));
PERFORM pg_temp.assert_raises('قیمت منفی ثبت نمی‌شود',
  format('SELECT catalog.set_price(%L, -1)', v_var));
PERFORM pg_temp.assert_raises('نوع قیمت نامعتبر رد می‌شود',
  format('SELECT catalog.set_price(%L, 100, %L)', v_var, 'الکی'));
PERFORM pg_temp.assert_raises('تنوع ناموجود رد می‌شود',
  format('SELECT catalog.set_price(%L, 100)', '00000000-0000-7000-8000-0000000000ff'));

RAISE NOTICE E'\n═══ ۵. فاکتور نهایی‌شده پس از تغییر قیمت تکان نمی‌خورد ═══';

INSERT INTO purchasing.supplier (code, name) VALUES ('S-PP','تأمین‌کننده تست')
  RETURNING id INTO v_sup;
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 10, 2000000, 20000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-02 09:00+03:30') RETURNING id INTO v_shift;
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 10:00+03:30', v_user) RETURNING id INTO v_inv;

-- قیمت جاری همان لحظه: ۳٬۲۰۰٬۰۰۰
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 3200000, 6400000) RETURNING id INTO v_line;
PERFORM sales.finalize_invoice(v_inv, v_user);

PERFORM pg_temp.assert_eq('فاکتور با قیمت لحظه فروش نهایی شد',
  (SELECT net_amount FROM sales.invoice WHERE id = v_inv), 6400000);

-- حالا قیمت را بالا می‌بریم — فاکتور نباید تکان بخورد
PERFORM catalog.set_price(v_var, 9999000, 'regular', 'قیمت تازه فصل بعد');

PERFORM pg_temp.assert_eq('جمع فاکتور نهایی‌شده عوض نشد',
  (SELECT net_amount FROM sales.invoice WHERE id = v_inv), 6400000);
PERFORM pg_temp.assert_eq('قیمت واحد Snapshot سر جایش ماند',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 3200000);
PERFORM pg_temp.assert_eq('و قیمت جاری واقعاً عوض شده',
  (SELECT amount FROM catalog.current_price WHERE variation_id = v_var), 9999000);
PERFORM pg_temp.assert_eq('سند فروش هم دست نخورد', (
  SELECT count(*) FROM ledger.journal_line jl
    JOIN ledger.journal_entry je ON je.id = jl.entry_id
   WHERE je.id IN (SELECT sale_entry_id FROM ledger.posting_batch
                    WHERE id = (SELECT posting_batch_id FROM sales.invoice WHERE id = v_inv))
     AND jl.debit + jl.credit = 0), 0);

RAISE NOTICE E'\n═══ ۶. اصلاح تنوع فقط پیش از اولین حرکت ═══';

PERFORM pg_temp.assert_raises('تنوعی که حرکت انبار دارد، رنگش عوض نمی‌شود',
  format('SELECT catalog.amend_variation(%L, %L, %L)', v_var, 'آبی', '30'));

-- v_var2 هیچ حرکتی و هیچ فروشی ندارد
PERFORM catalog.amend_variation(v_var2, 'سبز زیتونی', '32');
PERFORM pg_temp.assert_txt('تنوع دست‌نخورده اصلاح می‌شود',
  (SELECT color FROM catalog.variation WHERE id = v_var2), 'سبز زیتونی');
PERFORM pg_temp.assert_eq('و در لاگ حسابرسی نشست', (
  SELECT count(*) FROM platform.audit_log
   WHERE action = 'variation.amend' AND entity_id = v_var2::text), 1);

RAISE NOTICE E'\n═══ ۷. بایگانی کالا ═══';

PERFORM catalog.set_product_status(v_prod, 'archived', 'مدل قدیمی');
PERFORM pg_temp.assert_txt('کالا بایگانی شد',
  (SELECT status FROM catalog.product WHERE id = v_prod), 'archived');
PERFORM pg_temp.assert_eq('تنوع‌هایش هم بایگانی شدند', (
  SELECT count(*) FROM catalog.variation
   WHERE product_id = v_prod AND status <> 'archived'), 0);
PERFORM pg_temp.assert_eq('و کالا حذف نشد — تاریخچه سر جایش است',
  (SELECT count(*) FROM catalog.product WHERE id = v_prod), 1);
PERFORM pg_temp.assert_eq('فاکتور قبلی هنوز به همان تنوع اشاره می‌کند',
  (SELECT count(*) FROM sales.invoice_line WHERE variation_id = v_var), 1);

PERFORM catalog.set_product_status(v_prod, 'active');
PERFORM pg_temp.assert_txt('بازگرداندن کالا کار می‌کند',
  (SELECT status FROM catalog.product WHERE id = v_prod), 'active');
PERFORM pg_temp.assert_eq('ولی تنوع‌ها خودکار باز نمی‌گردند — تصمیم است نه محاسبه', (
  SELECT count(*) FROM catalog.variation
   WHERE product_id = v_prod AND status = 'active'), 0);

PERFORM catalog.set_variation_status(v_var2, 'active');
PERFORM pg_temp.assert_txt('تنوع تک‌به‌تک باز می‌شود',
  (SELECT status FROM catalog.variation WHERE id = v_var2), 'active');
PERFORM pg_temp.assert_raises('وضعیت نامعتبر تنوع رد می‌شود',
  format('SELECT catalog.set_variation_status(%L, %L)', v_var2, 'الکی'));
PERFORM pg_temp.assert_raises('وضعیت نامعتبر کالا رد می‌شود',
  format('SELECT catalog.set_product_status(%L, %L)', v_prod, 'الکی'));

RAISE NOTICE E'\n═══ ۸. بدون کاربر عامل، هیچ‌کدام کار نمی‌کنند ═══';

PERFORM set_config('labelmod.actor_id', '', true);
PERFORM pg_temp.assert_raises('set_price بدون کاربر عامل',
  format('SELECT catalog.set_price(%L, 1000)', v_var));
PERFORM pg_temp.assert_raises('upsert_product بدون کاربر عامل',
  format('SELECT catalog.upsert_product(NULL, %L, %L)', 'P-NOACTOR', 'بی‌عامل'));
PERFORM pg_temp.assert_raises('set_product_status بدون کاربر عامل',
  format('SELECT catalog.set_product_status(%L, %L)', v_prod, 'archived'));
PERFORM pg_temp.assert_raises('amend_variation بدون کاربر عامل',
  format('SELECT catalog.amend_variation(%L, %L, %L)', v_var2, 'قرمز', '32'));
PERFORM platform.set_actor(v_user);

RAISE NOTICE E'\n═══ ۹. ردّ حسابرسی تغییر قیمت ═══';

PERFORM pg_temp.assert_eq('هر تغییر قیمت یک سطر حسابرسی دارد', (
  SELECT count(*) FROM platform.audit_log
   WHERE action = 'price.change' AND entity_id = v_var::text), 4);
PERFORM pg_temp.assert_txt('مقدار پیش و پس هر دو ثبت شده‌اند', (
  SELECT (before->>'amount') || '→' || (after->>'amount')
    FROM platform.audit_log
   WHERE action = 'price.change' AND entity_id = v_var::text
   ORDER BY id DESC LIMIT 1), '3200000→9999000');
PERFORM pg_temp.assert_txt('و دلیلش', (
  SELECT reason FROM platform.audit_log
   WHERE action = 'price.change' AND entity_id = v_var::text
   ORDER BY id DESC LIMIT 1), 'قیمت تازه فصل بعد');

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تست چرخه حیات کالا و قیمت پاس شد      ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
