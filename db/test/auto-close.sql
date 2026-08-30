-- =====================================================================
-- تست بستن خودکار دوره کانال آنلاین
-- =====================================================================
-- ادعای مرکزی — و همان سؤالی که مالک پرسید:
--
--   **بستن شبانه، موجودی را دست نمی‌زند.**
--
-- کالا در همان لحظه فروش از انبار خارج می‌شود. آنچه شبانه بسته
-- می‌شود فقط سند حسابداری درآمد و بهای تمام‌شده است. این فایل هر دو
-- را جدا می‌سنجد تا اگر روزی کسی این دو را قاطی کرد، همین‌جا قرمز شود.
--
-- به‌علاوه سه مرز که بی‌آن‌ها این تابع خطرناک است:
--   • دوره **امروز** هرگز بسته نمی‌شود
--   • مهلت پس از نیمه‌شب رعایت می‌شود
--   • دوره مشکل‌دار رد می‌شود، نه اینکه کل اجرا را بشکند
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
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_cust uuid;
  v_rcpt uuid; v_inv uuid; v_inv2 uuid; v_draft uuid;
  v_qty_before platform.qty; v_qty_after platform.qty;
  v_n int; r record;
  v_today date;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('auto','تست بستن خودکار')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);
INSERT INTO purchasing.supplier (code, name) VALUES ('S-AUTO','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-AUTO','پیراهن سایت')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','AUTO-M') RETURNING id INTO v_var;
INSERT INTO catalog.price (variation_id, price_list, amount)
  VALUES (v_var, 'default', 1000000);
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
  VALUES ('09121110000','مشتری سایت', 0) RETURNING id INTO v_cust;

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 50, 400000, 20000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

v_today := now()::date;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. فروش سایت: موجودی **همان لحظه** کم می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- این پاسخ سؤال مالک است: «وقتی الان در سایت سفارش ثبت بشه تا شب از
-- موجودی کم نمیشه؟» — چرا، همان لحظه.

SELECT on_hand INTO v_qty_before
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی پیش از فروش سایت', v_qty_before, 50);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', (v_today - 2)::timestamptz + interval '14 hours', v_user)
RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 3, 1000000, 3000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

SELECT on_hand INTO v_qty_after
  FROM inventory.stock_balance WHERE variation_id = v_var AND warehouse_id = WH;
PERFORM pg_temp.assert_eq('موجودی بلافاصله پس از فروش سایت', v_qty_after, 47);
PERFORM pg_temp.assert_eq('یعنی سه عدد همان لحظه رفت', v_qty_before - v_qty_after, 3);

-- ولی سند حسابداری هنوز زده نشده
SELECT count(*) INTO v_n FROM sales.unposted_revenue WHERE invoice_id = v_inv;
PERFORM pg_temp.assert_eq('درآمد هنوز به دفتر نرفته', v_n, 1);
PERFORM pg_temp.assert_txt('وضعیت دوره پیش از بستن',
  (SELECT status FROM ledger.posting_batch
    WHERE kind='channel_day' AND business_date = v_today - 2), 'open');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. دوره **امروز** هرگز خودکار بسته نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- وگرنه سفارش ساعت ۲۳ در دوره‌ای می‌افتاد که ساعت ۲۲ بسته شده و
-- resolve_posting_batch فاکتور را رد می‌کرد.

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', now(), v_user)
RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_var, 1, 1000000, 1000000);
PERFORM sales.finalize_invoice(v_inv2, v_user);

-- **یک بار** اجرا می‌شود و نتیجه نگه داشته می‌شود. اگر تابع را چند
-- بار صدا بزنیم، هر صدا خودش دوره‌ها را می‌بندد و اجرای بعدی چیزی
-- برای گزارش ندارد — همان چیزی که نسخه اول این تست را گمراه کرد.
CREATE TEMP TABLE run0 AS SELECT * FROM sales.close_due_channel_days(v_user);

PERFORM pg_temp.assert_eq('دوره امروز در فهرست بستن نیست',
  (SELECT count(*) FROM run0 WHERE business_date = v_today), 0);
PERFORM pg_temp.assert_txt('دوره امروز باز مانده',
  (SELECT status FROM ledger.posting_batch
    WHERE kind='channel_day' AND business_date = v_today), 'open');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. دوره روزهای گذشته بسته می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT * INTO r FROM run0 WHERE business_date = v_today - 2;
PERFORM pg_temp.assert_txt('دوره پریروز در نتیجه هست', (r.batch_id IS NOT NULL)::text, 'true');
PERFORM pg_temp.assert_txt('دوره پریروز رد نشد', coalesce(r.skipped, '—'), '—');
PERFORM pg_temp.assert_txt('سند فروش زده شد', (r.sale_entry IS NOT NULL)::text, 'true');
PERFORM pg_temp.assert_txt('سند بهای تمام‌شده زده شد', (r.cogs_entry IS NOT NULL)::text, 'true');

PERFORM pg_temp.assert_txt('وضعیت دوره پس از بستن',
  (SELECT status FROM ledger.posting_batch
    WHERE kind='channel_day' AND business_date = v_today - 2), 'posted');

SELECT count(*) INTO v_n FROM sales.unposted_revenue WHERE invoice_id = v_inv;
PERFORM pg_temp.assert_eq('درآمد دیگر ثبت‌نشده نیست', v_n, 0);

-- و موجودی **عوض نشده**: بستن سند، کالا جابه‌جا نمی‌کند
PERFORM pg_temp.assert_eq('موجودی پس از بستن سند، دست‌نخورده',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WH), 46);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. اجرای دوباره، چیزی را دوباره ثبت نمی‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM sales.close_due_channel_days(v_user);
PERFORM pg_temp.assert_eq('اجرای دوم، دوره‌ای برای بستن ندارد', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. پیش‌نویس مانع بستن نیست ═══';
-- ═══════════════════════════════════════════════════════════════════
-- نسخه اول این تست فرض کرده بود یک پیش‌نویس، دوره را قفل می‌کند. غلط
-- بود: `posting_batch_id` در **نهایی‌سازی** ست می‌شود، نه در ساخت
-- پیش‌نویس. پس سبد نیمه‌کاره اصلاً به دوره نمی‌چسبد و نمی‌تواند
-- بستنش را عقب بیندازد — که رفتار درستی هم هست: سبد رهاشده مشتری
-- نباید سند فروش کل روز را معلق نگه دارد.

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', (v_today - 3)::timestamptz + interval '10 hours', v_user)
RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 1000000, 2000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', (v_today - 3)::timestamptz + interval '11 hours', v_user)
RETURNING id INTO v_draft;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_draft, 1, v_var, 1, 1000000, 1000000);

PERFORM pg_temp.assert_txt('پیش‌نویس به هیچ دوره‌ای نچسبیده',
  (SELECT (posting_batch_id IS NULL)::text FROM sales.invoice WHERE id = v_draft), 'true');

-- کانال تلفنی همان روز، تا ثابت شود چند کانال در یک اجرا بسته می‌شوند
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'phone', (v_today - 3)::timestamptz + interval '12 hours', v_user)
RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_var, 1, 1000000, 1000000);
PERFORM sales.finalize_invoice(v_inv2, v_user);

-- دوره‌ای که همه فاکتورهایش ابطال شده‌اند: سندی برای زدن ندارد و
-- `post_entry` روی «سند بدون سطر» خطا می‌دهد. باید رد شود، نه اینکه
-- کل اجرا را بشکند.
INSERT INTO ledger.posting_batch (branch_id, kind, channel, business_date)
VALUES (BR, 'channel_day', 'web', v_today - 5);

CREATE TEMP TABLE run1 AS SELECT * FROM sales.close_due_channel_days(v_user);

PERFORM pg_temp.assert_eq('کانال web پریروزِ سوم بسته شد',
  (SELECT count(*) FROM run1
    WHERE channel='web' AND business_date = v_today - 3 AND skipped IS NULL), 1);
PERFORM pg_temp.assert_eq('کانال تلفنی همان روز هم بسته شد',
  (SELECT count(*) FROM run1
    WHERE channel='phone' AND business_date = v_today - 3 AND skipped IS NULL), 1);
PERFORM pg_temp.assert_eq('دوره خالی رد شد، نه اینکه اجرا بشکند',
  (SELECT count(*) FROM run1
    WHERE business_date = v_today - 5 AND skipped IS NOT NULL), 1);
PERFORM pg_temp.assert_txt('دلیل رد شدن گفته شد',
  (SELECT skipped FROM run1 WHERE business_date = v_today - 5),
  'فاکتور نهایی‌شده‌ای ندارد');

-- و پیش‌نویس هنوز پیش‌نویس است؛ بستن دوره بهش دست نزده
PERFORM pg_temp.assert_txt('پیش‌نویس دست‌نخورده ماند',
  (SELECT status FROM sales.invoice WHERE id = v_draft), 'draft');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. کلید خاموش، و کاربر عامل ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', (v_today - 4)::timestamptz + interval '9 hours', v_user)
RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 1, 1000000, 1000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

PERFORM platform.set_setting('sales.auto_close_channel_day', 'false'::jsonb, 'تست خاموشی');
PERFORM pg_temp.assert_eq('با کلید خاموش، هیچ دوره‌ای بسته نمی‌شود',
  (SELECT count(*) FROM sales.close_due_channel_days(v_user)), 0);
PERFORM platform.set_setting('sales.auto_close_channel_day', 'true'::jsonb, 'بازگشت');
PERFORM pg_temp.assert_eq('با کلید روشن، دوباره بسته می‌شود',
  (SELECT count(*) FROM sales.close_due_channel_days(v_user) WHERE skipped IS NULL), 1);

PERFORM pg_temp.assert_raises('بستن بدون کاربر عامل',
  'SELECT * FROM sales.close_due_channel_days(NULL)');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف Projection با حرکت‌ها', v_n, 0);

-- تنها درآمد ثبت‌نشده باید همان فاکتور **امروز** باشد
SELECT count(*) INTO v_n FROM sales.unposted_revenue
 WHERE business_date < v_today;
PERFORM pg_temp.assert_eq('درآمد ثبت‌نشده از روزهای گذشته', v_n, 0);

RAISE NOTICE E'\n✔ بستن خودکار — همه ادعاها پاس شدند';
END $test$;

ROLLBACK;
