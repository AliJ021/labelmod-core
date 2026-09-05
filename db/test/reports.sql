-- =====================================================================
-- گزارش‌ها — هشت پرسشی که مالک هر ماه می‌پرسد
-- =====================================================================
-- ادعای مرکزی این پرونده: **گزارش با دفتر یکی است.**
--
-- یک گزارش مالی که عددش با دفتر فرق کند، بدتر از نبودنش است: مالک
-- تصمیم می‌گیرد و حسابدار بعداً می‌فهمد عدد دیگری درست بوده. پس هر
-- تابع اینجا در برابر همان منبعی سنجیده می‌شود که خودش باید از آن
-- بیاید — نه در برابر عددی که تست حساب کرده.
--
--   report_summary        در برابر  sales.daily_summary
--   report_valuation      در برابر  inventory.stock_balance
--   report_trial_balance  در برابر  ledger.journal_line (توازن)
--   report_account_ledger در برابر  مانده تجمعی خودش
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
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual,'NULL');
END $$;

DO $test$
DECLARE
  BR    uuid := '00000000-0000-7000-8000-000000000001';
  WH    uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_line uuid; v_ret uuid;
  v_day  date;
  r RECORD; s RECORD;
  v_n int; v_num numeric; v_num2 numeric; v_txt text;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('rp','تست گزارش')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-RP','تأمین‌کننده گزارش')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-RP','پیراهن گزارش')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'آبی','L','RP-L') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'قرمز','M','RP-M') RETURNING id INTO v_var2;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var,'default',1000000);
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_var2,'default',600000);

-- بهای ۴۰۰٬۰۰۰ و ۲۰۰٬۰۰۰ — تا سود قابل سنجش باشد.
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 50, 400000, 20000000);
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var2, 30, 200000, 6000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

v_day := platform.business_date();

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 500000, now()) RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. بازه خالی، هیچ سطری ═══';
-- ═══════════════════════════════════════════════════════════════════
-- «هیچ سطر» با «سطر با صفر» فرق دارد: اولی یعنی آن روز فروشی نبوده،
-- دومی یعنی بوده و صفر شده. گزارشی که برای هر روز خالی یک سطر صفر
-- بسازد، ۳۶۵ سطر بی‌معنا می‌دهد.

SELECT count(*) INTO v_n FROM sales.report_summary('2020-01-01','2020-01-31');
PERFORM pg_temp.assert_eq('بازه‌ای که فروشی نداشته، سطر ندارد', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. فروش دوره‌ای — شش عدد که یکی نیستند ═══';
-- ═══════════════════════════════════════════════════════════════════
-- دو واحد آبی به ۱٬۰۰۰٬۰۰۰ با ۲۰۰٬۰۰۰ تخفیف:
--   ناخالص ۲٬۰۰۰٬۰۰۰ · تخفیف ۲۰۰٬۰۰۰ · خالص ۱٬۸۰۰٬۰۰۰
--   بهای تمام‌شده ۸۰۰٬۰۰۰ · سود ۱٬۰۰۰٬۰۰۰

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, now(), v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                unit_price, discount_amount, net_amount, discount_reason)
VALUES (v_inv, 1, v_var, 2, 1000000, 200000, 1800000, 'تخفیف تست')
RETURNING id INTO v_line;
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction,
                              amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', 'in', 1800000, 'succeeded', now());
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT * INTO r FROM sales.report_summary(v_day, v_day, BR);
PERFORM pg_temp.assert_eq('فروش ناخالص', r.gross_amount, 2000000);
PERFORM pg_temp.assert_eq('تخفیف جدا شمرده می‌شود', r.discount_amount, 200000);
PERFORM pg_temp.assert_eq('فروش خالص', r.net_amount, 1800000);
PERFORM pg_temp.assert_eq('بهای تمام‌شده', r.cogs_amount, 800000);
PERFORM pg_temp.assert_eq('سود ناخالص = خالص منهای بها', r.profit_amount, 1000000);
PERFORM pg_temp.assert_eq('یک فاکتور', r.invoice_count, 1);
PERFORM pg_temp.assert_txt('کانال', r.channel, 'pos');

-- **همان عدد که داشبورد نشان می‌دهد.** دو منبع برای یک رقم یعنی
-- روزی یکی‌شان عقب می‌ماند و مالک نمی‌داند کدام درست است.
SELECT * INTO s FROM sales.daily_summary(BR, v_day);
PERFORM pg_temp.assert_eq('گزارش و خلاصه روز یک عدد می‌دهند',
  r.net_amount, s.sales_amount);
PERFORM pg_temp.assert_eq('سود هم همان است', r.profit_amount, s.profit_amount);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. مرجوعی، در روز ثبت خودش ═══';
-- ═══════════════════════════════════════════════════════════════════
-- یک واحد برمی‌گردد: خالص ۹۰۰٬۰۰۰ کم می‌شود و بهایش ۴۰۰٬۰۰۰.

INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method,
                               occurred_at, created_by)
VALUES (BR, v_inv, WH, v_shift, 'size_small', 900000, 'cash', now(), v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty,
                                    unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);

SELECT * INTO r FROM sales.report_summary(v_day, v_day, BR);
PERFORM pg_temp.assert_eq('یک مرجوعی', r.return_count, 1);
PERFORM pg_temp.assert_eq('مبلغ مرجوعی', r.return_amount, 900000);
-- **فروش ناخالص دست نمی‌خورد، ولی سود خالص می‌شود.**
--
-- مرجوعی ستون خودش را دارد چون رویداد جداست با روز و سند خودش؛ اگر
-- از «فروش» کم می‌شد، ستون فروش با سند فروش دفتر یکی درنمی‌آمد.
-- سود اما باید خالص باشد: کالا برگشته و پول رفته.
--
--   درآمد باقی‌مانده  ۱٬۸۰۰٬۰۰۰ − ۹۰۰٬۰۰۰ = ۹۰۰٬۰۰۰
--   بهای باقی‌مانده     ۸۰۰٬۰۰۰ − ۴۰۰٬۰۰۰ = ۴۰۰٬۰۰۰
--   سود                                     ۵۰۰٬۰۰۰
PERFORM pg_temp.assert_eq('فروش ناخالص دست‌نخورده می‌ماند', r.gross_amount, 2000000);
PERFORM pg_temp.assert_eq('بهای تمام‌شده خالص شد', r.cogs_amount, 400000);
PERFORM pg_temp.assert_eq('سود پس از مرجوعی', r.profit_amount, 500000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. سود به تفکیک کالا ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO r FROM sales.report_profit_by_product(v_day, v_day, BR)
 WHERE variation_id = v_var;
PERFORM pg_temp.assert_eq('تعداد فروخته‌شده', r.qty_sold, 2);
PERFORM pg_temp.assert_eq('تعداد برگشتی', r.qty_returned, 1);
PERFORM pg_temp.assert_eq('فروش خالص کالا', r.net_amount, 900000);
PERFORM pg_temp.assert_eq('بهای کالا', r.cogs_amount, 400000);
PERFORM pg_temp.assert_eq('سود کالا', r.profit_amount, 500000);
PERFORM pg_temp.assert_eq('حاشیه روی فروش، نه روی بها', r.margin_percent, 55.6);
PERFORM pg_temp.assert_txt('SKU', r.sku, 'RP-L');

SELECT count(*) INTO v_n FROM sales.report_profit_by_product(v_day, v_day, BR);
PERFORM pg_temp.assert_eq('کالایی که فروش نرفته در گزارش سود نمی‌آید', v_n, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. ارزش‌گذاری موجودی — از stock_balance، نه جمع دوباره ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO r FROM inventory.report_valuation(WH) WHERE variation_id = v_var;
SELECT * INTO s FROM inventory.stock_balance
 WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی همان stock_balance است', r.on_hand, s.on_hand);
PERFORM pg_temp.assert_eq('ارزش هم همان است', r.total_value, s.total_value);
PERFORM pg_temp.assert_eq('۵۰ خرید، ۲ فروش، ۱ برگشت', r.on_hand, 49);
PERFORM pg_temp.assert_eq('بهای واحد مشتق است', r.unit_cost, 400000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. کاردکس — مانده اول دوره و مانده تجمعی ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM inventory.report_movements(v_var, v_day, v_day, WH);
PERFORM pg_temp.assert_eq('سه حرکت: خرید، فروش، برگشت', v_n, 3);

-- **دنباله مانده، نه فقط عدد آخر.** هر سه حرکت در یک تراکنش‌اند و
-- `now()` برای هر سه یکی است، پس «آخرین» با مرتب‌سازی زمانی
-- نامعین می‌شود. خودِ تابع با `(occurred_at, id)` مرتب می‌کند و
-- همان ترتیب است که باید سنجیده شود:
--
--   خرید ۵۰ → ۵۰ · فروش ۲ → ۴۸ · برگشت ۱ → ۴۹
SELECT array_agg(running_qty)::text INTO v_txt
  FROM inventory.report_movements(v_var, v_day, v_day, WH);
PERFORM pg_temp.assert_txt('مانده تجمعی به ترتیب حرکت‌ها',
  v_txt, '{50.000,48.000,49.000}');

SELECT sum(qty) INTO v_num FROM inventory.report_movements(v_var, v_day, v_day, WH);
PERFORM pg_temp.assert_eq('جمع حرکت‌ها = موجودی جاری', v_num,
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WH));

-- مانده اول دوره: بازه‌ای که **بعد از** همه حرکت‌ها شروع شود، سطری
-- ندارد ولی اگر داشت باید از ۴۹ شروع می‌کرد. این را با بازه‌ای
-- می‌سنجیم که فقط حرکت آخر را بگیرد.
SELECT count(*) INTO v_n FROM inventory.report_movements(v_var, v_day + 1, v_day + 30, WH);
PERFORM pg_temp.assert_eq('بازه آینده حرکتی ندارد', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. تراز آزمایشی — سنگ محک هر گزارش مالی ═══';
-- ═══════════════════════════════════════════════════════════════════
-- سند فروش و COGS با بستن شیفت زده می‌شود، نه با نهایی‌سازی فاکتور.

PERFORM sales.close_shift(v_shift, 1400000, v_user);

SELECT sum(debit), sum(credit) INTO v_num, v_num2
  FROM ledger.report_trial_balance(v_day, v_day, BR);
PERFORM pg_temp.assert_eq('جمع بدهکار دوره', v_num, 30100000);
PERFORM pg_temp.assert_eq('جمع بستانکار با بدهکار برابر است', v_num2, v_num);
PERFORM pg_temp.assert_eq('و صفر نیست — وگرنه ادعا بی‌معنا بود',
  (v_num > 0)::int, 1);

-- مانده پایان = مانده اول + گردش. اگر این نشکند، ستون‌ها با هم
-- سازگارند و ترازنامه از همین گزارش ساختنی است.
SELECT count(*) INTO v_n FROM ledger.report_trial_balance(v_day, v_day, BR)
 WHERE closing_balance <> opening_balance + debit - credit;
PERFORM pg_temp.assert_eq('مانده پایان = مانده اول + گردش', v_n, 0);

SELECT count(*) INTO v_n FROM ledger.report_trial_balance(v_day, v_day, BR);
PERFORM pg_temp.assert_eq('حساب‌های درگیر در گزارش هستند', (v_n > 0)::int, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. دفتر یک حساب ═══';
-- ═══════════════════════════════════════════════════════════════════
-- حساب موجودی کالا: خرید بدهکارش می‌کند، فروش بستانکار.

SELECT count(*) INTO v_n FROM ledger.report_account_ledger(
  (SELECT account_code FROM ledger.posting_rule
    WHERE event_type = 'purchase_receipt' AND leg = 'inventory'),
  v_day, v_day, BR);
PERFORM pg_temp.assert_eq('حساب موجودی کالا گردش دارد', (v_n > 0)::int, 1);

SELECT running INTO v_num FROM ledger.report_account_ledger(
  (SELECT account_code FROM ledger.posting_rule
    WHERE event_type = 'purchase_receipt' AND leg = 'inventory'),
  v_day, v_day, BR) ORDER BY entry_date DESC, entry_number DESC LIMIT 1;
SELECT balance INTO r FROM ledger.trial_balance
 WHERE code = (SELECT account_code FROM ledger.posting_rule
                WHERE event_type = 'purchase_receipt' AND leg = 'inventory');
PERFORM pg_temp.assert_eq('مانده تجمعی دفتر با تراز کل یکی است', v_num, r.balance);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۹. مغایرت‌گیری نقد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- کشو: ۵۰۰٬۰۰۰ اول + ۱٬۸۰۰٬۰۰۰ فروش نقدی − ۹۰۰٬۰۰۰ بازپرداخت
--      = ۱٬۴۰۰٬۰۰۰ انتظار. شمرده هم ۱٬۴۰۰٬۰۰۰ → مغایرت صفر.

SELECT * INTO r FROM treasury.report_cash_reconciliation(v_day, v_day, BR)
 WHERE shift_id = v_shift;
PERFORM pg_temp.assert_eq('نقد اول شیفت', r.opening_cash, 500000);
PERFORM pg_temp.assert_eq('فروش نقدی', r.cash_sales, 1800000);
PERFORM pg_temp.assert_eq('بازپرداخت نقدی', r.cash_refunds, 900000);
PERFORM pg_temp.assert_eq('انتظار — همان که close_shift نوشته',
  r.expected_cash, 1400000);
PERFORM pg_temp.assert_eq('شمرده‌شده', r.counted_cash, 1400000);
PERFORM pg_temp.assert_eq('مغایرت صفر', r.variance, 0);
PERFORM pg_temp.assert_txt('شیفت بسته است', r.status, 'closed');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۰. دامنه شعبه و بازه ═══';
-- ═══════════════════════════════════════════════════════════════════
-- `p_branch IS NULL` یعنی «همه شعبه‌ها» — دامنه کاربر کار لایه API
-- است. ولی شعبه‌ای که وجود ندارد باید خالی برگردد، نه همه را.

SELECT count(*) INTO v_n FROM sales.report_summary(v_day, v_day,
  '00000000-0000-7000-8000-0000000009ff'::uuid);
PERFORM pg_temp.assert_eq('شعبه دیگر، هیچ سطری', v_n, 0);

SELECT count(*) INTO v_n FROM sales.report_summary(v_day, v_day, NULL);
PERFORM pg_temp.assert_eq('بدون شعبه یعنی همه', (v_n > 0)::int, 1);

-- بازه شامل هر دو سر است: روزی که فروش داشته، در بازه‌ای که همان روز
-- سرِ آخرش است باید بیاید.
SELECT count(*) INTO v_n FROM sales.report_summary(v_day - 7, v_day, BR);
PERFORM pg_temp.assert_eq('روز آخر بازه هم شمرده می‌شود', v_n, 1);
SELECT count(*) INTO v_n FROM sales.report_summary(v_day, v_day + 7, BR);
PERFORM pg_temp.assert_eq('روز اول بازه هم شمرده می‌شود', v_n, 1);

RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

RAISE NOTICE E'\n✔ گزارش‌ها — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
