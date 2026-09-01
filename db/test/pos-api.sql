-- =====================================================================
-- تست تغییر اتمیک تعداد سطر و نگهبان «سبد فقط در Draft»
-- =====================================================================
-- سه ادعای مرکزی:
--
-- ۱. **تغییر تعداد، قیمت را دوباره نمی‌خواند.** Snapshot لحظه فروش
--    دست‌نخورده می‌ماند حتی اگر قیمت فهرست بعد از آن عوض شده باشد.
-- ۲. **جمع فاکتور همیشه برابر جمع سطرهاست** — چون از سطرها بازساخته
--    می‌شود، نه انباشته.
-- ۳. **سطر فاکتور نهایی‌شده تغییر نمی‌کند** — به‌جز `returned_qty`،
--    که تنها راه مرجوعی است. این را کامل با یک چرخه Return می‌سنجیم،
--    نه با یک UPDATE ساختگی.
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
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid; v_line2 uuid;
  v_ret uuid; v_n int;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('pa','تست تعداد سبد')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-PA','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-PA','پیراهن تست')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','PA-M') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','L','PA-L') RETURNING id INTO v_var2;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var, 'default', 1000001);
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var2,'default',  500000);

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 100, 400000, 40000000);
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var2, 50, 200000, 10000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-06-02 09:00+03:30') RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. تغییر تعداد، مبلغ را در SQL بازمی‌سازد ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, '2026-06-02 10:00+03:30', v_user) RETURNING id INTO v_inv;

-- قیمت ۱٬۰۰۰٬۰۰۱ عمداً فرد است: تقسیم صحیح یا گرد کردن در TypeScript
-- اینجا یک ریال اختلاف می‌سازد و جمع فاکتور از جمع سطرها جدا می‌افتد.
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 1, 1000001, 1000001) RETURNING id INTO v_line;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 2, v_var2, 2, 500000, 1000000) RETURNING id INTO v_line2;
PERFORM sales.refresh_invoice_totals(v_inv);

PERFORM pg_temp.assert_eq('جمع اولیه فاکتور',
  (SELECT net_amount FROM sales.invoice WHERE id = v_inv), 2000001);

PERFORM sales.set_line_qty(v_inv, v_line, 3);

PERFORM pg_temp.assert_eq('تعداد سطر عوض شد',
  (SELECT qty FROM sales.invoice_line WHERE id = v_line), 3);
PERFORM pg_temp.assert_eq('مبلغ سطر با round() در SQL',
  (SELECT net_amount FROM sales.invoice_line WHERE id = v_line), 3000003);
PERFORM pg_temp.assert_eq('جمع فاکتور بازساخته شد',
  (SELECT net_amount FROM sales.invoice WHERE id = v_inv), 4000003);
PERFORM pg_temp.assert_eq('جمع فاکتور برابر جمع سطرهاست',
  (SELECT i.net_amount - (SELECT sum(l.net_amount) FROM sales.invoice_line l
                            WHERE l.invoice_id = i.id)
     FROM sales.invoice i WHERE i.id = v_inv), 0);
PERFORM pg_temp.assert_eq('ناخالص فاکتور هم بازساخته شد',
  (SELECT gross_amount FROM sales.invoice WHERE id = v_inv), 4000003);
PERFORM pg_temp.assert_eq('قابل پرداخت = خالص + مالیات + حمل',
  (SELECT payable_amount FROM sales.invoice WHERE id = v_inv), 4000003);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. Snapshot قیمت دست نمی‌خورد ═══';
-- ═══════════════════════════════════════════════════════════════════

-- قیمت فهرست را عوض می‌کنیم. اگر set_line_qty قیمت را دوباره بخواند،
-- ادعای بعدی می‌شکند — و همان چیزی است که حذف و افزودن دوباره
-- بی‌صدا انجام می‌داد.
UPDATE catalog.price SET amount = 9999999 WHERE variation_id = v_var;

PERFORM sales.set_line_qty(v_inv, v_line, 2);

PERFORM pg_temp.assert_eq('قیمت سطر همان قیمت لحظه فروش ماند',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 1000001);
PERFORM pg_temp.assert_eq('مبلغ از همان Snapshot ساخته شد',
  (SELECT net_amount FROM sales.invoice_line WHERE id = v_line), 2000002);

UPDATE catalog.price SET amount = 1000001 WHERE variation_id = v_var;

PERFORM pg_temp.assert_eq('تعداد اعشاری هم پذیرفته می‌شود (دیتابیس واحد فروش را محدود نمی‌کند)',
  (SELECT 1 FROM (SELECT sales.set_line_qty(v_inv, v_line2, 2.5)) x), 1);
PERFORM pg_temp.assert_eq('مبلغ سطر اعشاری',
  (SELECT net_amount FROM sales.invoice_line WHERE id = v_line2), 1250000);
PERFORM sales.set_line_qty(v_inv, v_line2, 2);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. ورودی نامعتبر و دامنه ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_raises('تعداد صفر رد می‌شود — حذف مسیر خودش را دارد',
  format('SELECT sales.set_line_qty(%L,%L,0)', v_inv, v_line));
PERFORM pg_temp.assert_raises('تعداد منفی رد می‌شود',
  format('SELECT sales.set_line_qty(%L,%L,-1)', v_inv, v_line));
PERFORM pg_temp.assert_raises('سطری که در این فاکتور نیست رد می‌شود',
  format('SELECT sales.set_line_qty(%L,%L,1)', v_inv, gen_random_uuid()));
PERFORM pg_temp.assert_raises('فاکتور ناموجود رد می‌شود',
  format('SELECT sales.set_line_qty(%L,%L,1)', gen_random_uuid(), v_line));

-- سطر تخفیف‌دار: مبلغ مطلق تخفیف با تعدادِ آن لحظه معنا دارد
UPDATE sales.invoice_line SET discount_amount = 1000, net_amount = net_amount - 1000
  WHERE id = v_line2;
PERFORM pg_temp.assert_raises('تعداد سطر تخفیف‌دار عوض نمی‌شود',
  format('SELECT sales.set_line_qty(%L,%L,5)', v_inv, v_line2));
UPDATE sales.invoice_line SET discount_amount = 0, net_amount = net_amount + 1000
  WHERE id = v_line2;

-- سطر با قیمت دستی
UPDATE sales.invoice_line SET list_price = 520000 WHERE id = v_line2;
PERFORM pg_temp.assert_raises('تعداد سطر با قیمت دستی عوض نمی‌شود',
  format('SELECT sales.set_line_qty(%L,%L,5)', v_inv, v_line2));
UPDATE sales.invoice_line SET list_price = NULL WHERE id = v_line2;

-- سطر با مالیات ثبت‌شده. امروز هر مسیر درج مالیات را صفر می‌نویسد،
-- پس این حالت فقط دستی ساختنی است — ولی روزی که مالیات روشن شود،
-- تغییر تعداد بدون بازمحاسبه مالیات یک عدد غلط روی فاکتور می‌گذاشت.
UPDATE sales.invoice_line SET tax_amount = 500 WHERE id = v_line2;
PERFORM pg_temp.assert_raises('تعداد سطر مالیات‌دار عوض نمی‌شود',
  format('SELECT sales.set_line_qty(%L,%L,5)', v_inv, v_line2));
UPDATE sales.invoice_line SET tax_amount = 0 WHERE id = v_line2;

PERFORM sales.refresh_invoice_totals(v_inv);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. نهایی‌سازی کامل با نگهبان فعال ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM sales.finalize_invoice(v_inv, v_user);

PERFORM pg_temp.assert_eq('فاکتور نهایی شد',
  (SELECT CASE WHEN status = 'finalized' THEN 1 ELSE 0 END
     FROM sales.invoice WHERE id = v_inv), 1);
PERFORM pg_temp.assert_eq('بهای تمام‌شده روی سطرها نوشته شد',
  (SELECT count(*) FROM sales.invoice_line
     WHERE invoice_id = v_inv AND unit_cost > 0), 2);
PERFORM pg_temp.assert_eq('کالا از انبار خارج شد',
  (SELECT on_hand FROM inventory.stock_balance
     WHERE variation_id = v_var AND warehouse_id = WH), 98);

PERFORM pg_temp.assert_raises('تغییر تعداد پس از نهایی‌سازی رد می‌شود',
  format('SELECT sales.set_line_qty(%L,%L,9)', v_inv, v_line));
PERFORM pg_temp.assert_raises('افزودن قلم به فاکتور نهایی رد می‌شود',
  format('INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
          unit_price, net_amount) VALUES (%L, 9, %L, 1, 100, 100)', v_inv, v_var));
PERFORM pg_temp.assert_raises('حذف قلم از فاکتور نهایی رد می‌شود',
  format('DELETE FROM sales.invoice_line WHERE id = %L', v_line));
PERFORM pg_temp.assert_raises('تغییر قیمت سطر نهایی رد می‌شود',
  format('UPDATE sales.invoice_line SET unit_price = 1 WHERE id = %L', v_line));
PERFORM pg_temp.assert_raises('تغییر تخفیف سطر نهایی رد می‌شود',
  format('UPDATE sales.invoice_line SET discount_amount = 1 WHERE id = %L', v_line));

-- به‌روزرسانی بی‌اثر: هیچ ستونی عوض نمی‌شود، حتی returned_qty. اثری
-- روی پول ندارد، ولی نشانه مسیری است که خیال می‌کند دارد سطر
-- نهایی‌شده را اصلاح می‌کند. عبور دادنش یعنی آن مسیر پیدا نمی‌شود.
PERFORM pg_temp.assert_raises('به‌روزرسانی بی‌اثر روی سطر نهایی رد می‌شود',
  format('UPDATE sales.invoice_line SET returned_qty = returned_qty WHERE id = %L', v_line));

-- TRUNCATE را نگهبان سطری نمی‌بیند. `CASCADE` مسیر واقعی خطر است:
-- بدون نگهبان جداگانه، یک `TRUNCATE sales.invoice CASCADE` سبد همه
-- فاکتورها و حتی پرداخت‌ها را با هم می‌برد.
PERFORM pg_temp.assert_raises('TRUNCATE CASCADE روی سطر فاکتور رد می‌شود',
  'TRUNCATE sales.invoice_line CASCADE');
PERFORM pg_temp.assert_raises('TRUNCATE CASCADE از راه جدول فاکتور هم رد می‌شود',
  'TRUNCATE sales.invoice CASCADE');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. چرخه کامل مرجوعی از نگهبان رد می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- تنها تغییر مجاز پس از نهایی‌سازی. اگر نگهبان زیادی سخت‌گیر بود،
-- اینجا می‌شکست — و مرجوعی کل سیستم می‌مرد.

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, occurred_at, created_by)
VALUES (BR, v_inv, WH, v_shift, 'size_small', 0, '2026-06-02 12:00+03:30', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

PERFORM pg_temp.assert_eq('مقدار مرجوعی روی سطر ثبت شد',
  (SELECT returned_qty FROM sales.invoice_line WHERE id = v_line), 1);
PERFORM pg_temp.assert_eq('قیمت سطر پس از مرجوعی دست‌نخورده ماند',
  (SELECT unit_price FROM sales.invoice_line WHERE id = v_line), 1000001);
PERFORM pg_temp.assert_eq('کالا به انبار برگشت',
  (SELECT on_hand FROM inventory.stock_balance
     WHERE variation_id = v_var AND warehouse_id = WH), 99);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. دفتر همچنان متوازن است ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

RAISE NOTICE E'\n✔ تعداد سبد و نگهبان Draft — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
