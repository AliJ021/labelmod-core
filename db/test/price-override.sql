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

-- This snapshot/stock scenario is a paid sale, not anonymous credit.
INSERT INTO treasury.payment (invoice_id,shift_id,method_code,amount,status)
SELECT i.id,i.shift_id,'cash',sum(l.net_amount+l.tax_amount),'succeeded'
  FROM sales.invoice i JOIN sales.invoice_line l ON l.invoice_id=i.id
 WHERE i.id=v_inv GROUP BY i.id;
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

RAISE NOTICE E'\n═══ ۷. set_line_price — قیمت دستی روی سطری که در سبد است ═══';

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 14:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 1000000, 2000000) RETURNING id INTO v_line;

-- ۹۵۰٬۰۰۰ یعنی ۵٪ کاهش — زیر آستانه ۱۰٪، پس دلیل لازم نیست.
PERFORM sales.set_line_price(v_inv, v_line, 950000);
PERFORM pg_temp.assert_eq('قیمت تازه روی سطر می‌نشیند',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 950000);
PERFORM pg_temp.assert_eq('قیمت فهرست Snapshot می‌شود',
  (SELECT list_price FROM sales.invoice_line WHERE id = v_line), 1000000);
PERFORM pg_temp.assert_eq('مبلغ سطر از قیمت تازه ساخته می‌شود',
  (SELECT net_amount FROM sales.invoice_line WHERE id = v_line), 1900000);
PERFORM pg_temp.assert_eq('جمع فاکتور همان لحظه تازه می‌شود',
  (SELECT net_amount FROM sales.invoice WHERE id = v_inv), 1900000);

-- تغییر دوم: Snapshot اول **دست نمی‌خورد**. اگر هر بار قیمت جاری سطر
-- را فهرست می‌گرفت، تایپ اشتباه ۹۵۰ و اصلاحش به ۹۲۰، کاهش واقعی
-- نسبت به ۱٬۰۰۰٬۰۰۰ را از دست می‌داد و سقف تخفیف سوراخ می‌شد.
PERFORM sales.set_line_price(v_inv, v_line, 920000);
PERFORM pg_temp.assert_eq('قیمت فهرست پس از تغییر دوم همان اولی است',
  (SELECT list_price FROM sales.invoice_line WHERE id = v_line), 1000000);
PERFORM pg_temp.assert_eq('کاهش کل از فهرست اصلی سنجیده می‌شود',
  sales.line_markdown((SELECT l FROM sales.invoice_line l WHERE l.id = v_line)), 160000);

-- دلیل تازه جای قبلی را می‌گیرد، ولی دلیل خالی پاکش نمی‌کند.
PERFORM sales.set_line_price(v_inv, v_line, 930000, 'کالای نمایشگاهی');
PERFORM pg_temp.assert_eq('دلیل ثبت می‌شود',
  (SELECT count(*) FROM sales.invoice_line
    WHERE id = v_line AND price_override_reason = 'کالای نمایشگاهی'), 1);
PERFORM sales.set_line_price(v_inv, v_line, 940000);
PERFORM pg_temp.assert_eq('دلیل خالی، دلیل قبلی را پاک نمی‌کند',
  (SELECT count(*) FROM sales.invoice_line
    WHERE id = v_line AND price_override_reason = 'کالای نمایشگاهی'), 1);

-- برگشت به قیمت فهرست: سطر دوباره «دست‌نخورده» می‌شود.
PERFORM sales.set_line_price(v_inv, v_line, 1000000);
PERFORM pg_temp.assert_eq('برگشت به فهرست، Snapshot را پاک می‌کند',
  (SELECT count(*) FROM sales.invoice_line
    WHERE id = v_line AND list_price IS NULL AND price_override_reason IS NULL), 1);
PERFORM pg_temp.assert_eq('و مبلغ سطر به قیمت فهرست برمی‌گردد',
  (SELECT net_amount FROM sales.invoice_line WHERE id = v_line), 2000000);

RAISE NOTICE E'\n═══ ۸. set_line_price — نگهبان‌ها ═══';

PERFORM pg_temp.assert_raises('قیمت صفر',
  format($$SELECT sales.set_line_price(%L, %L, 0)$$, v_inv, v_line));
PERFORM pg_temp.assert_raises('قیمت منفی',
  format($$SELECT sales.set_line_price(%L, %L, -1000)$$, v_inv, v_line));
PERFORM pg_temp.assert_raises('سطری که در این فاکتور نیست',
  format($$SELECT sales.set_line_price(%L, %L, 900000)$$,
         v_inv, '00000000-0000-7000-8000-0000000009ff'::uuid));

-- کاهش ۲۰٪ بدون دلیل: Trigger مهاجرت ۰۱۰ روی این UPDATE هم اجرا
-- می‌شود. این تابع دور نمی‌زندش.
PERFORM pg_temp.assert_raises('کاهش ۲۰٪ بدون دلیل از این مسیر هم رد می‌شود',
  format($$SELECT sales.set_line_price(%L, %L, 800000)$$, v_inv, v_line));
PERFORM sales.set_line_price(v_inv, v_line, 800000, 'مدیر تأیید کرد');
PERFORM pg_temp.assert_eq('با دلیل، همان کاهش می‌نشیند',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 800000);

-- تخفیفی که با قیمت قبلی مجاز بود، با قیمت پایین‌تر از مبلغ قلم
-- بیشتر می‌شود. سطر نباید منفی شود.
PERFORM sales.set_line_price(v_inv, v_line, 1000000);
PERFORM sales.set_line_discount(v_inv, v_line, 1500000, 'تخفیف بزرگ');
PERFORM pg_temp.assert_raises('قیمتی که تخفیف ثبت‌شده را از مبلغ قلم بیشتر کند',
  format($$SELECT sales.set_line_price(%L, %L, 700000, 'دلیل')$$, v_inv, v_line));
PERFORM pg_temp.assert_eq('و سطر دست‌نخورده می‌ماند',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 1000000);
PERFORM sales.set_line_discount(v_inv, v_line, 0);

-- ردّ حسابرسی: هر تغییر قیمت یک سطر در `audit_log` می‌گذارد، با
-- مقدار پیش و پس. سطر عادی سبد چنین ردی نمی‌سازد.
SELECT count(*) INTO v_n FROM platform.audit_log
 WHERE action = 'sale.price_override' AND entity = 'invoice_line'
   AND entity_id = v_line::text;
PERFORM pg_temp.assert_eq('هر تغییر قیمت یک ردّ حسابرسی دارد', v_n, 7);
PERFORM pg_temp.assert_eq('ردّ حسابرسی مقدار پیش و پس دارد',
  (SELECT count(*) FROM platform.audit_log
    WHERE entity_id = v_line::text AND action = 'sale.price_override'
      AND before ? 'unitPrice' AND after ? 'unitPrice'), 7);

-- فاکتور نهایی‌شده سبد ندارد.
-- This snapshot/stock scenario is a paid sale, not anonymous credit.
INSERT INTO treasury.payment (invoice_id,shift_id,method_code,amount,status)
SELECT i.id,i.shift_id,'cash',sum(l.net_amount+l.tax_amount),'succeeded'
  FROM sales.invoice i JOIN sales.invoice_line l ON l.invoice_id=i.id
 WHERE i.id=v_inv GROUP BY i.id;
PERFORM sales.finalize_invoice(v_inv, v_user);
PERFORM pg_temp.assert_raises('فاکتور نهایی‌شده قیمت عوض نمی‌کند',
  format($$SELECT sales.set_line_price(%L, %L, 900000, 'دلیل')$$, v_inv, v_line));

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
