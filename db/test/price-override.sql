-- =====================================================================
-- تست قیمت دستی روی سطر فاکتور و اجبار ثبت دلیل
-- =====================================================================
-- دو ادعای مرکزی:
--
-- ۱. **فاکتور یک قیمت نشان می‌دهد.** قیمت دستی در `unit_price`
--    می‌نشیند و جمع فاکتور از همان ساخته می‌شود؛ قیمت فهرست فقط در
--    `list_price` می‌ماند و در هیچ جمعی دخالت نمی‌کند.
--
-- ۲. **کاهش قیمت بی‌دلیل، بالاتر از آستانه، ثبت نمی‌شود** — چه از راه
--    تخفیف، چه از راه قیمت دستی، چه هر دو. تنظیم
--    `discount.require_reason_above_percent` از روز اول در جدول بود و
--    هیچ کدی نمی‌خواندش؛ حالا یک Trigger می‌خواندش.
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
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid;
  v_val platform.money; v_n int;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('po','تست قیمت دستی')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);
INSERT INTO purchasing.supplier (code, name) VALUES ('S-PO','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-PO','شلوار تست')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'آبی','32','PO-32') RETURNING id INTO v_var;
INSERT INTO catalog.price (variation_id, price_list, amount)
  VALUES (v_var, 'default', 1000000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 100, 400000, 40000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-02 09:00+03:30') RETURNING id INTO v_shift;

RAISE NOTICE E'\n═══ ۱. فاکتور یک قیمت نشان می‌دهد ═══';

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 10:00+03:30', v_user) RETURNING id INTO v_inv;

-- قیمت فهرست ۱٬۰۰۰٬۰۰۰ — دستی ۹۵۰٬۰۰۰ (۵٪ زیر آستانه ۱۰٪)
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount, list_price)
VALUES (v_inv, 1, v_var, 2, 950000, 1900000, 1000000) RETURNING id INTO v_line;

PERFORM pg_temp.assert_eq('قیمت روی سطر، همان قیمت دستی است',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 950000);
PERFORM pg_temp.assert_eq('تخفیف صفر می‌ماند — دو قیمت روی فاکتور نمی‌خورد',
  (SELECT discount_amount FROM sales.invoice_line WHERE id = v_line), 0);
PERFORM pg_temp.assert_eq('قیمت فهرست فقط برای حسابرسی نگه داشته می‌شود',
  (SELECT list_price FROM sales.invoice_line WHERE id = v_line), 1000000);
PERFORM pg_temp.assert_eq('مبلغ خالص سطر از قیمت دستی ساخته می‌شود',
  (SELECT net_amount FROM sales.invoice_line WHERE id = v_line), 1900000);

-- «کاهش کل» یک عدد است، صرف‌نظر از راهش
PERFORM pg_temp.assert_eq('کاهش کل — فقط قیمت دستی',
  sales.line_markdown((SELECT l FROM sales.invoice_line l WHERE l.id = v_line)), 100000);

PERFORM sales.finalize_invoice(v_inv, v_user);
PERFORM pg_temp.assert_eq('جمع فاکتور از قیمت دستی ساخته می‌شود',
  (SELECT net_amount FROM sales.invoice WHERE id = v_inv), 1900000);

RAISE NOTICE E'\n═══ ۲. تخفیف و قیمت دستی با هم، در یک عدد ═══';

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 11:00+03:30', v_user) RETURNING id INTO v_inv;

-- فهرست ۱٬۰۰۰٬۰۰۰ × ۱ = ۱٬۰۰۰٬۰۰۰
-- دستی  ۹۵۰٬۰۰۰، به‌علاوه ۳۰٬۰۰۰ تخفیف → مشتری ۹۲۰٬۰۰۰ می‌دهد
-- کاهش کل = ۸۰٬۰۰۰ یعنی ۸٪ — هنوز زیر آستانه ۱۰٪
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, discount_amount, net_amount, list_price)
VALUES (v_inv, 1, v_var, 1, 950000, 30000, 920000, 1000000) RETURNING id INTO v_line;

PERFORM pg_temp.assert_eq('کاهش کل — تخفیف به‌علاوه قیمت دستی',
  sales.line_markdown((SELECT l FROM sales.invoice_line l WHERE l.id = v_line)), 80000);

RAISE NOTICE E'\n═══ ۳. بالاتر از آستانه، دلیل اجباری است ═══';

PERFORM pg_temp.assert_eq('آستانه فعلی',
  platform.setting_num('discount.require_reason_above_percent'), 10);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 12:00+03:30', v_user) RETURNING id INTO v_inv;

-- ۲۰٪ فقط از راه تخفیف
PERFORM pg_temp.assert_raises('تخفیف ۲۰٪ بدون دلیل',
  format($$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
             unit_price, discount_amount, net_amount)
           VALUES (%L, 1, %L, 1, 1000000, 200000, 800000)$$, v_inv, v_var));

-- ۲۰٪ فقط از راه قیمت دستی — همان قاعده، همان خطا. **این همان دری بود
-- که بدون این Trigger باز می‌ماند.**
PERFORM pg_temp.assert_raises('قیمت دستی ۲۰٪ پایین‌تر بدون دلیل',
  format($$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
             unit_price, net_amount, list_price)
           VALUES (%L, 1, %L, 1, 800000, 800000, 1000000)$$, v_inv, v_var));

-- و ترکیبی: ۶٪ قیمت دستی + ۶٪ تخفیف = ۱۲٪. هیچ‌کدام به‌تنهایی از
-- آستانه رد نمی‌شوند، ولی جمعشان می‌شود — و همین دلیل وجود
-- line_markdown است.
PERFORM pg_temp.assert_raises('ترکیب ۶٪ و ۶٪ بدون دلیل',
  format($$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
             unit_price, discount_amount, net_amount, list_price)
           VALUES (%L, 1, %L, 1, 940000, 60000, 880000, 1000000)$$, v_inv, v_var));

-- با دلیل، هر سه می‌نشینند
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount, list_price, price_override_reason)
VALUES (v_inv, 1, v_var, 1, 800000, 800000, 1000000, 'کالای نمایشگاهی');
PERFORM pg_temp.assert_eq('با دلیل تغییر قیمت، می‌نشیند',
  (SELECT count(*) FROM sales.invoice_line WHERE invoice_id = v_inv), 1);

INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, discount_amount, net_amount, discount_reason)
VALUES (v_inv, 2, v_var, 1, 1000000, 200000, 800000, 'تخفیف پرسنلی');
PERFORM pg_temp.assert_eq('با دلیل تخفیف هم می‌نشیند',
  (SELECT count(*) FROM sales.invoice_line WHERE invoice_id = v_inv), 2);

RAISE NOTICE E'\n═══ ۴. آستانه داده است ═══';

-- صفر یعنی هر کاهشی دلیل می‌خواهد
PERFORM platform.set_setting('discount.require_reason_above_percent', '0'::jsonb);
PERFORM pg_temp.assert_raises('با آستانه صفر، حتی ۱٪ هم دلیل می‌خواهد',
  format($$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
             unit_price, net_amount, list_price)
           VALUES (%L, 9, %L, 1, 990000, 990000, 1000000)$$, v_inv, v_var));

-- ۱۰۰ یعنی هیچ‌کدام
PERFORM platform.set_setting('discount.require_reason_above_percent', '100'::jsonb);
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount, list_price)
VALUES (v_inv, 9, v_var, 1, 500000, 500000, 1000000);
PERFORM pg_temp.assert_eq('با آستانه ۱۰۰، ۵۰٪ هم بی‌دلیل می‌نشیند',
  (SELECT count(*) FROM sales.invoice_line WHERE invoice_id = v_inv AND line_no = 9), 1);
PERFORM platform.set_setting('discount.require_reason_above_percent', '10'::jsonb);

RAISE NOTICE E'\n═══ ۵. گران‌تر از فهرست، کاهش نیست ═══';

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 13:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount, list_price)
VALUES (v_inv, 1, v_var, 1, 1500000, 1500000, 1000000) RETURNING id INTO v_line;
PERFORM pg_temp.assert_eq('کاهش کل منفی است، پس دلیلی لازم نیست',
  sales.line_markdown((SELECT l FROM sales.invoice_line l WHERE l.id = v_line)), -500000);

RAISE NOTICE E'\n═══ ۶. نگهبان‌ها ═══';

PERFORM pg_temp.assert_raises('قیمت فهرست صفر',
  format($$INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
             unit_price, net_amount, list_price)
           VALUES (%L, 8, %L, 1, 900000, 900000, 0)$$, v_inv, v_var));

-- سطر عادی، بدون قیمت دستی: list_price باید NULL بماند تا «آیا این
-- سطر دستکاری شده؟» یک تست ساده بماند.
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 2, v_var, 1, 1000000, 1000000);
PERFORM pg_temp.assert_eq('سطر عادی list_price ندارد',
  (SELECT count(*) FROM sales.invoice_line
    WHERE invoice_id = v_inv AND line_no = 2 AND list_price IS NULL), 1);

RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';

SELECT count(*) INTO v_n FROM sales.invoice_line l
  JOIN sales.invoice i ON i.id = l.invoice_id
 WHERE i.status <> 'cancelled' AND l.unit_price <= 0;
PERFORM pg_temp.assert_eq('سطر با قیمت صفر یا منفی', v_n, 0);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

RAISE NOTICE E'\n✔ قیمت دستی — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
