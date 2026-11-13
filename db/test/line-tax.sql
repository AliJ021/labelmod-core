-- =====================================================================
-- تست مالیات سطر پس از تخفیف و قیمت دستی — مهاجرت ۱۱۸
-- =====================================================================
-- ثابت این پرونده یک جمله است:
--
--     پس از **هر** تغییر سطر،  tax_amount = sales.line_tax(کالا، net_amount)
--
-- تا مهاجرت ۱۱۸ این ثابت فقط در لحظهٔ **درج** برقرار بود. تخفیف و قیمت
-- دستی خالص را عوض می‌کردند و مالیات کهنه می‌ماند — و فاکتور بی‌خطا
-- نهایی می‌شد، چون سند متوازن است.
--
-- ⚠️ بند ۱ **کنترل منفی** است: با مالیات خاموش همه‌چیز باید صفر بماند.
--    بی آن، تابعی که همیشه ۱۰٪ بنویسد هم بندهای بعدی را سبز می‌کرد.
-- ⚠️ عددها دستی نوشته شده‌اند (نه با فراخوان `line_tax` در انتظار): ادعایی
--    که هر دو طرفش از یک تابع بیاید فقط سازگاری تابع با خودش را می‌سنجد.
--    بند ۶ جدا می‌پرسد که ثابت بالا روی **همهٔ** سطرهای این پرونده برقرار است.
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

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_exempt_prod uuid; v_exempt uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid; v_line2 uuid; v_free uuid;
  v_fy smallint;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('linetax','تست مالیات سطر')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-LT','تأمین‌کننده') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-LT','مانتو تست') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'مشکی','M','LT-M') RETURNING id INTO v_var;
INSERT INTO catalog.product (code, name_internal, tax_rate_code) VALUES ('P-LTX','کالای معاف','exempt')
  RETURNING id INTO v_exempt_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_exempt_prod,'سفید','M','LTX-M') RETURNING id INTO v_exempt;

SELECT id INTO v_fy FROM ledger.fiscal_year
 WHERE platform.business_date() BETWEEN starts_on AND ends_on;
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',v_fy), BR, v_sup, WH, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 50, 400000, 20000000), (v_rcpt, v_exempt, 50, 400000, 20000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash) VALUES (BR, v_user, 0)
  RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. کنترل منفی: مالیات خاموش، همه‌چیز صفر می‌ماند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('پیش‌فرض: مالیات خاموش',
  platform.setting_bool('tax.enabled')::text, 'false');

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, created_by)
VALUES (BR, WH, v_shift, v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount, tax_amount)
VALUES (v_inv, 1, v_var, 1, 1000000, 1000000, sales.line_tax(v_var, 1000000)) RETURNING id INTO v_free;

PERFORM sales.set_line_discount(v_inv, v_free, 50000::platform.money, NULL);
PERFORM sales.set_line_price(v_inv, v_free, 980000::platform.money, 'قیمت توافقی');
PERFORM pg_temp.assert_eq('خاموش: خالص پس از قیمت و تخفیف',
  (SELECT net_amount::text FROM sales.invoice_line WHERE id = v_free), '930000');
PERFORM pg_temp.assert_eq('خاموش: مالیات سطر صفر',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_free), '0');
PERFORM pg_temp.assert_eq('خاموش: قابل پرداخت همان خالص',
  (SELECT payable_amount::text FROM sales.invoice WHERE id = v_inv), '930000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. مالیات روشن: تخفیف، مالیات را هم کم می‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.set_setting('tax.enabled', 'true', 'آزمون مالیات سطر', v_user);
PERFORM platform.set_setting('tax.default_rate', '10', 'آزمون مالیات سطر', v_user);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, created_by)
VALUES (BR, WH, v_shift, v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount, tax_amount)
VALUES (v_inv, 1, v_var, 1, 1000000, 1000000, sales.line_tax(v_var, 1000000)) RETURNING id INTO v_line;
PERFORM pg_temp.assert_eq('درج: مالیات ۱۰٪ یک میلیون',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line), '100000');

-- همان سناریوی یافتهٔ LM-01: پیش از ۱۱۸ اینجا ۱۰۰٬۰۰۰ می‌ماند.
PERFORM sales.set_line_discount(v_inv, v_line, 500000::platform.money, 'حراج آخر فصل');
PERFORM pg_temp.assert_eq('تخفیف ۵۰۰٬۰۰۰: خالص',
  (SELECT net_amount::text FROM sales.invoice_line WHERE id = v_line), '500000');
PERFORM pg_temp.assert_eq('تخفیف ۵۰۰٬۰۰۰: مالیات از خالص تازه (نه ۱۰۰٬۰۰۰ کهنه)',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line), '50000');
PERFORM pg_temp.assert_eq('جمع فاکتور: خالص + مالیات',
  (SELECT payable_amount::text FROM sales.invoice WHERE id = v_inv), '550000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. قیمت دستی پس از تخفیف ═══';
-- ═══════════════════════════════════════════════════════════════════
-- ادامهٔ همان یافته: قیمت ۶۰۰٬۰۰۰ با تخفیف ۵۰۰٬۰۰۰ → خالص ۱۰۰٬۰۰۰.
-- پیش از ۱۱۸ مالیات ۱۰۰٬۰۰۰ می‌ماند، یعنی ۱۰۰٪ خالص.

PERFORM sales.set_line_price(v_inv, v_line, 600000::platform.money, 'قیمت توافقی');
PERFORM pg_temp.assert_eq('قیمت ۶۰۰٬۰۰۰: خالص',
  (SELECT net_amount::text FROM sales.invoice_line WHERE id = v_line), '100000');
PERFORM pg_temp.assert_eq('قیمت ۶۰۰٬۰۰۰: مالیات',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line), '10000');

-- ترتیب برعکس و برگشت: تخفیف صفر، سپس برگشت به قیمت فهرست.
PERFORM sales.set_line_discount(v_inv, v_line, 0::platform.money, NULL);
PERFORM pg_temp.assert_eq('تخفیف صفر با قیمت ۶۰۰٬۰۰۰: مالیات',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line), '60000');
PERFORM sales.set_line_price(v_inv, v_line, 1000000::platform.money, NULL);
PERFORM pg_temp.assert_eq('برگشت به قیمت فهرست: مالیات مثل روز اول',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line), '100000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. گرد کردن و کالای معاف ═══';
-- ═══════════════════════════════════════════════════════════════════

-- خالص ۹۹۹٬۹۹۵ → ۱۰٪ = ۹۹٬۹۹۹٫۵ → گرد به ۱۰۰٬۰۰۰ (round صریح، نه برش).
PERFORM sales.set_line_discount(v_inv, v_line, 5::platform.money, NULL);
PERFORM pg_temp.assert_eq('گرد کردن نیم‌ریال',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line), '100000');

INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount, tax_amount)
VALUES (v_inv, 2, v_exempt, 2, 300000, 600000, sales.line_tax(v_exempt, 600000)) RETURNING id INTO v_line2;
PERFORM sales.set_line_discount(v_inv, v_line2, 100000::platform.money, 'حراج آخر فصل');
PERFORM sales.set_line_price(v_inv, v_line2, 280000::platform.money, 'قیمت توافقی');
PERFORM pg_temp.assert_eq('کالای معاف: خالص عوض می‌شود',
  (SELECT net_amount::text FROM sales.invoice_line WHERE id = v_line2), '460000');
PERFORM pg_temp.assert_eq('کالای معاف: مالیات صفر می‌ماند',
  (SELECT tax_amount::text FROM sales.invoice_line WHERE id = v_line2), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. فاکتور نهایی‌شده همان مالیات را دارد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- سطر ۱: خالص ۹۹۹٬۹۹۵ + مالیات ۱۰۰٬۰۰۰ · سطر ۲: خالص ۴۶۰٬۰۰۰، معاف.

INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, status)
VALUES (v_inv, v_shift, 'cash', 1559995, 'succeeded');
PERFORM sales.finalize_invoice(v_inv, v_user);
PERFORM pg_temp.assert_eq('فاکتور نهایی: مالیات',
  (SELECT tax_amount::text FROM sales.invoice WHERE id = v_inv), '100000');
PERFORM pg_temp.assert_eq('فاکتور نهایی: قابل پرداخت',
  (SELECT payable_amount::text FROM sales.invoice WHERE id = v_inv), '1559995');
PERFORM pg_temp.assert_eq('فاکتور نهایی: دریافتی برابر قابل پرداخت (بی مانده، بی باقی پول)',
  (SELECT paid_amount::text FROM sales.invoice WHERE id = v_inv), '1559995');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. ثابت: مالیات هر سطر = line_tax(خالص همان سطر) ═══';
-- ═══════════════════════════════════════════════════════════════════
-- سطر بند ۱ عمداً بیرون است: آن سطر با مالیات **خاموش** ویرایش شد.

PERFORM pg_temp.assert_eq('سطری که مالیاتش با خالصش نمی‌خواند',
  (SELECT count(*)::text FROM sales.invoice_line l
    WHERE l.invoice_id = v_inv
      AND l.tax_amount <> sales.line_tax(l.variation_id, l.net_amount)), '0');
PERFORM pg_temp.assert_eq('ضد‌پوچی: ثابت روی سطر مالیات‌دار سنجیده شد',
  (SELECT count(*)::text FROM sales.invoice_line l
    WHERE l.invoice_id = v_inv AND l.tax_amount > 0), '1');

RAISE NOTICE E'\n✔ مالیات سطر — کنترل منفی، تخفیف، قیمت دستی، گرد کردن، معاف، و فاکتور نهایی';
END $test$;

ROLLBACK;
