-- =====================================================================
-- «اثر ثبت‌نشده» روی طلب مشتری (مهاجرت ۱۱۲)
-- =====================================================================
-- ادعای مرکزی: پیش از بستن دوره، `sales.unposted_receivable()` برای هر
-- مشتری دقیقاً همان مبلغی را می‌دهد که `sales.post_batch` (از راه
-- `close_shift`) در سطر طلب همان مشتری می‌نشاند؛ و پس از بستن، چیزی برای
-- آن دوره نمی‌ماند.
--
-- سناریو:
--   مشتری الف  فاکتور ۳٬۰۰۰٬۰۰۰ با ۱٬۰۰۰٬۰۰۰ نقد       → +۲٬۰۰۰٬۰۰۰
--              فاکتور ۱٬۰۰۰٬۰۰۰ تماماً نسیه            → +۱٬۰۰۰٬۰۰۰
--   مشتری ب    فاکتور ۵۰۰٬۰۰۰ تماماً نقد               → صفر، سطری ندارد
--   ناشناس     فاکتور نقدی                            → هرگز طلب نمی‌سازد
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

DO $test$
DECLARE
  BR      uuid := '00000000-0000-7000-8000-000000000001';
  WH      uuid := '00000000-0000-7000-8000-000000000101';
  CASHBOX uuid := '00000000-0000-7000-8000-000000000201';
  D       date := '2026-09-18';
  v_user uuid; v_sup uuid; v_prod uuid; v_a uuid; v_rcpt uuid; v_shift uuid;
  c_a uuid; c_b uuid; v_inv uuid; v_entry uuid; v_posted numeric; v_preview numeric;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('urv','تست اثر ثبت‌نشده') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-URV','تأمین‌کننده') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-URV','کالای تست') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'مشکی','M','URV-A') RETURNING id INTO v_a;
INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (v_a,'default',500000);
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, platform.business_day_start(D) + interval '8 hours')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount) VALUES (v_rcpt, v_a, 50, 200000, 10000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.customer (full_name, credit_limit) VALUES ('مشتری الف آزمون', 10000000) RETURNING id INTO c_a;
INSERT INTO sales.customer (full_name, credit_limit) VALUES ('مشتری ب آزمون', 10000000) RETURNING id INTO c_b;

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, platform.business_day_start(D) + interval '8 hours 30 minutes') RETURNING id INTO v_shift;

-- الف: ۳٬۰۰۰٬۰۰۰ با ۱٬۰۰۰٬۰۰۰ نقد.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, c_a, platform.business_day_start(D) + interval '9 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_inv, 1, v_a, 6, 500000, 3000000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', CASHBOX, 'in', 1000000, 'succeeded', platform.business_day_start(D) + interval '9 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- الف: ۱٬۰۰۰٬۰۰۰ تماماً نسیه.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, c_a, platform.business_day_start(D) + interval '10 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_inv, 1, v_a, 2, 500000, 1000000);
PERFORM sales.refresh_invoice_totals(v_inv);
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ب: ۵۰۰٬۰۰۰ تماماً نقد.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, c_b, platform.business_day_start(D) + interval '11 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_inv, 1, v_a, 1, 500000, 500000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', CASHBOX, 'in', 500000, 'succeeded', platform.business_day_start(D) + interval '11 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ناشناس نقدی.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
VALUES (BR, WH, v_shift, platform.business_day_start(D) + interval '12 hours', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount) VALUES (v_inv, 1, v_a, 1, 500000, 500000);
PERFORM sales.refresh_invoice_totals(v_inv);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, direction, amount, status, occurred_at)
VALUES (v_inv, v_shift, 'cash', CASHBOX, 'in', 500000, 'succeeded', platform.business_day_start(D) + interval '12 hours 1 minute');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. پیش از بستن دوره ═══';
-- ═══════════════════════════════════════════════════════════════════
SELECT amount INTO v_preview FROM sales.unposted_receivable() WHERE branch_id = BR AND customer_id = c_a;
PERFORM pg_temp.assert_eq('الف: نسیهٔ دو فاکتور', v_preview, 3000000);
PERFORM pg_temp.assert_eq('الف: دو فاکتور', (SELECT invoice_count FROM sales.unposted_receivable() WHERE branch_id = BR AND customer_id = c_a), 2);
PERFORM pg_temp.assert_eq('ب: تسویه‌شده سطری ندارد', (SELECT count(*) FROM sales.unposted_receivable() WHERE customer_id = c_b), 0);
PERFORM pg_temp.assert_eq('هیچ سطری بی‌مشتری نیست', (SELECT count(*) FROM sales.unposted_receivable() WHERE customer_id IS NULL), 0);
PERFORM pg_temp.assert_eq('طلب ثبت‌شدهٔ الف هنوز صفر است (در دفتر نیست)',
  (SELECT coalesce(sum(l.debit - l.credit), 0) FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id = l.entry_id
    WHERE l.party_type = 'customer' AND l.party_id = c_a AND e.status IN ('confirmed', 'final')), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. بستن دوره: همان عدد در سطر طلب سند ═══';
-- ═══════════════════════════════════════════════════════════════════
PERFORM sales.close_shift(v_shift, 2000000, v_user);
SELECT b.sale_entry_id INTO v_entry FROM ledger.posting_batch b WHERE b.shift_id = v_shift;
SELECT coalesce(sum(l.debit - l.credit), 0) INTO v_posted FROM ledger.journal_line l
 WHERE l.entry_id = v_entry AND l.party_type = 'customer' AND l.party_id = c_a;
PERFORM pg_temp.assert_eq('سطر طلب الف در سند فروش = پیش‌نمایش', v_posted, v_preview);
PERFORM pg_temp.assert_eq('پس از بستن، چیزی ثبت‌نشده نمی‌ماند',
  (SELECT count(*) FROM sales.unposted_receivable() WHERE customer_id IN (c_a, c_b)), 0);
PERFORM pg_temp.assert_eq('و طلب ثبت‌شدهٔ الف همان عدد شد',
  (SELECT coalesce(sum(l.debit - l.credit), 0) FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id = l.entry_id
    WHERE l.party_type = 'customer' AND l.party_id = c_a AND e.status IN ('confirmed', 'final')), v_preview);

END $test$;

ROLLBACK;
