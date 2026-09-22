-- =====================================================================
-- تست خزانه، تسویه و تفکیک روش پرداخت
-- =====================================================================
-- پوشش: مقصد مستقل هر روش پرداخت (H2)، امتیاز و کارت هدیه (H3)،
-- Idempotency پرداخت (H7)، دریافتنی به تفکیک مشتری (H9)، احتساب حرکت
-- نقد غیرفروشی در شمارش صندوق (H10)، تسویه کارت‌خوان و بستن حساب واسط،
-- و مرزِ اجازه تغییر حساب در قواعد ثبت.
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
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- مانده یک حساب دفتر، فقط از اسناد تأییدشده
CREATE OR REPLACE FUNCTION pg_temp.bal(p_code text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE l.account_code = p_code AND e.status IN ('confirmed','final');
$$;

-- مانده یک حساب دفتر برای یک شخص مشخص
CREATE OR REPLACE FUNCTION pg_temp.bal_party(p_code text, p_party uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE l.account_code = p_code AND l.party_id = p_party
     AND e.status IN ('confirmed','final');
$$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  CASHBOX uuid := '00000000-0000-7000-8000-000000000201';
  BANK    uuid := '00000000-0000-7000-8000-000000000202';
  POS     uuid := '00000000-0000-7000-8000-000000000203';
  GW      uuid := '00000000-0000-7000-8000-000000000204';
  P2P     uuid := '00000000-0000-7000-8000-000000000205';
  v_user uuid; v_sup uuid; c1 uuid; c2 uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_sh1 uuid; v_sh2 uuid; v_tx uuid; v_stl uuid;
  v_inv uuid; v_n int;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('trez','تست خزانه')
  RETURNING id INTO v_user;
INSERT INTO purchasing.supplier (code, name) VALUES ('S-TRZ','تأمین‌کننده خزانه')
  RETURNING id INTO v_sup;
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
  VALUES ('09121000001','مشتری یک', 900000000) RETURNING id INTO c1;
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
  VALUES ('09121000002','مشتری دو', 900000000) RETURNING id INTO c2;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-TRZ','کالای خزانه')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'خاکستری','L','TRZ-L') RETURNING id INTO v_var;

-- خرید ۲۰ عدد × ۱٬۰۰۰٬۰۰۰ → بدهی تأمین‌کننده ۲۰٬۰۰۰٬۰۰۰
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-07-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 20, 1000000, 20000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. چهار فروش با چهار مسیر پول متفاوت ═══';

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-07-02 09:00+03:30') RETURNING id INTO v_sh1;

-- الف) کارت‌خوان ۲٬۰۰۰٬۰۰۰
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_sh1, c1, 'pos', '2026-07-02 10:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 1000000, 2000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, amount, ref_no, occurred_at)
VALUES (v_inv, v_sh1, 'card', POS, 2000000, 'POS-9001', '2026-07-02 10:01+03:30');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ب) کارت‌به‌کارت ۳٬۰۰۰٬۰۰۰
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_sh1, c2, 'pos', '2026-07-02 11:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 3, 1000000, 3000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, amount, ref_no, occurred_at)
VALUES (v_inv, v_sh1, 'transfer', P2P, 3000000, 'P2P-77', '2026-07-02 11:01+03:30');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ج) نسیه کامل ۴٬۰۰۰٬۰۰۰ برای مشتری یک
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_sh1, c1, 'pos', '2026-07-02 12:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 4, 1000000, 4000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

-- د) نیمه‌نقد: ۵٬۰۰۰٬۰۰۰ با ۱٬۰۰۰٬۰۰۰ نقد برای مشتری دو
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_sh1, c2, 'pos', '2026-07-02 13:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 5, 1000000, 5000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, account_id, amount, occurred_at)
VALUES (v_inv, v_sh1, 'cash', CASHBOX, 1000000, '2026-07-02 13:01+03:30');
PERFORM sales.finalize_invoice(v_inv, v_user);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. انتقال نقد به بانک، داخل همان شیفت (H10) ═══';
-- ۱٬۰۰۰٬۰۰۰ نقدِ فروش به بانک منتقل می‌شود. کشو باید خالی بسته شود،
-- بدون هیچ مغایرتی.

INSERT INTO treasury.transaction
  (branch_id, purpose, from_account_id, to_account_id, amount, shift_id, occurred_at, note, created_by)
VALUES (BR, 'transfer', CASHBOX, BANK, 1000000, v_sh1, '2026-07-02 20:00+03:30',
        'واریز فروش نقدی به بانک', v_user)
RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);

PERFORM sales.close_shift(v_sh1, 0, v_user);

PERFORM pg_temp.assert_eq('نقد مورد انتظار پس از انتقال به بانک',
  (SELECT expected_cash FROM sales.cash_shift WHERE id = v_sh1), 0);
PERFORM pg_temp.assert_eq('مغایرت شیفت',
  (SELECT variance FROM sales.cash_shift WHERE id = v_sh1), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. هر روش پرداخت، حساب واسط خودش (H2) ═══';

PERFORM pg_temp.assert_eq('صندوق ۱۱۰۱ — فروش نقدی منهای انتقال', pg_temp.bal('1101'), 0);
PERFORM pg_temp.assert_eq('بانک ۱۱۰۲ — انتقال دریافتی',          pg_temp.bal('1102'), 1000000);
PERFORM pg_temp.assert_eq('وجوه در راه کارت‌خوان ۱۱۰۳',          pg_temp.bal('1103'), 2000000);
PERFORM pg_temp.assert_eq('وجوه در راه درگاه ۱۱۰۴ — دست‌نخورده', pg_temp.bal('1104'), 0);
PERFORM pg_temp.assert_eq('وجوه در راه کارت‌به‌کارت ۱۱۰۵',       pg_temp.bal('1105'), 3000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. دریافتنی به تفکیک مشتری (H9) ═══';
-- پیش از اصلاح، این دو در یک سطر ۸٬۰۰۰٬۰۰۰ با شخصِ خالی جمع می‌شدند و
-- گردش حساب اشخاص از دفتر قابل ساخت نبود.

PERFORM pg_temp.assert_eq('بدهی مشتری یک',  pg_temp.bal_party('1201', c1), 4000000);
PERFORM pg_temp.assert_eq('بدهی مشتری دو',  pg_temp.bal_party('1201', c2), 4000000);
PERFORM pg_temp.assert_eq('جمع دریافتنی',   pg_temp.bal('1201'), 8000000);

SELECT count(*) INTO v_n FROM ledger.journal_line
 WHERE account_code = '1201' AND party_id IS NULL;
PERFORM pg_temp.assert_eq('سطر دریافتنی بدون شخص', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. پرداخت با امتیاز باشگاه (H3) ═══';
-- ابتدا ۱٬۰۰۰٬۰۰۰ امتیاز به مشتری یک داده می‌شود (بدهی ما به او)،
-- بعد همان را خرج می‌کند. بدهی باید دقیقاً صفر شود، نه اینکه طلب بسازد.

PERFORM ledger.post_entry('loyalty_grant', BR, DATE '2026-07-03',
  'اعطای امتیاز به مشتری یک',
  jsonb_build_array(
    jsonb_build_object('leg','expense','amount', 1000000),
    jsonb_build_object('leg','liability','amount', 1000000,
                       'party_type','customer','party_id', c1)),
  NULL, NULL, v_user);

PERFORM pg_temp.assert_eq('بدهی امتیاز پس از اعطا', pg_temp.bal_party('2301', c1), -1000000);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-07-03 09:00+03:30') RETURNING id INTO v_sh2;

INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_sh2, c1, 'pos', '2026-07-03 10:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 1, 1000000, 1000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, occurred_at)
VALUES (v_inv, v_sh2, 'points', 1000000, '2026-07-03 10:01+03:30');
PERFORM sales.finalize_invoice(v_inv, v_user);
PERFORM sales.close_shift(v_sh2, 0, v_user);

PERFORM pg_temp.assert_eq('بدهی امتیاز پس از استفاده', pg_temp.bal_party('2301', c1), 0);
PERFORM pg_temp.assert_eq('امتیاز طلب کاذب نساخت',     pg_temp.bal('1201'), 8000000);
PERFORM pg_temp.assert_eq('درآمد فروشِ امتیازی ثبت شد', pg_temp.bal('4101'), -15000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. تسویه کارت‌خوان — بستن حساب واسط ═══';
-- بانک ۱٬۹۴۰٬۰۰۰ واریز کرده در برابر ۲٬۰۰۰٬۰۰۰ تراکنش. کارمزد از همین
-- تفاوت استنتاج می‌شود — همان کاری که حسابدار با صورتحساب PSP می‌کند.

INSERT INTO treasury.settlement
  (branch_id, source_account_id, bank_account_id, period_from, period_to,
   bank_reported_amount, occurred_at, note, created_by)
VALUES (BR, POS, BANK, '2026-07-02', '2026-07-02', 1940000,
        '2026-07-04 10:00+03:30', 'تسویه روزانه کارت‌خوان', v_user)
RETURNING id INTO v_stl;
PERFORM treasury.post_settlement(v_stl, v_user);

PERFORM pg_temp.assert_eq('جمع تراکنش‌های تسویه‌شده',
  (SELECT gross_amount FROM treasury.settlement WHERE id = v_stl), 2000000);
PERFORM pg_temp.assert_eq('کارمزد استنتاج‌شده',
  (SELECT fee_amount FROM treasury.settlement WHERE id = v_stl), 60000);
PERFORM pg_temp.assert_eq('حساب واسط کارت‌خوان بسته شد', pg_temp.bal('1103'), 0);
PERFORM pg_temp.assert_eq('بانک پس از تسویه', pg_temp.bal('1102'), 2940000);
PERFORM pg_temp.assert_eq('هزینه کارمزد',     pg_temp.bal('6101'), 60000);

SELECT count(*) INTO v_n FROM treasury.payment
 WHERE settlement_id = v_stl AND status = 'settled';
PERFORM pg_temp.assert_eq('پرداخت‌های علامت‌خورده به‌عنوان تسویه‌شده', v_n, 1);

RAISE NOTICE E'\n  → تسویه دوباره نباید اثر تکراری بسازد';
PERFORM treasury.post_settlement(v_stl, v_user);
PERFORM pg_temp.assert_eq('حساب واسط پس از تسویه دوباره', pg_temp.bal('1103'), 0);
PERFORM pg_temp.assert_eq('بانک پس از تسویه دوباره',      pg_temp.bal('1102'), 2940000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. پرداخت به تأمین‌کننده و دریافت از مشتری ═══';

INSERT INTO treasury.transaction
  (branch_id, purpose, from_account_id, party_type, party_id, amount, occurred_at, created_by)
VALUES (BR, 'supplier_payment', BANK, 'supplier', v_sup, 2000000, '2026-07-05 10:00+03:30', v_user)
RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);

PERFORM pg_temp.assert_eq('بدهی تأمین‌کننده پس از پرداخت',
  pg_temp.bal_party('2101', v_sup), -18000000);
PERFORM pg_temp.assert_eq('بانک پس از پرداخت به تأمین‌کننده', pg_temp.bal('1102'), 940000);

INSERT INTO treasury.transaction
  (branch_id, purpose, to_account_id, party_type, party_id, amount, occurred_at, created_by)
VALUES (BR, 'customer_receipt', BANK, 'customer', c1, 4000000, '2026-07-05 11:00+03:30', v_user)
RETURNING id INTO v_tx;
PERFORM treasury.post_transaction(v_tx, v_user);

PERFORM pg_temp.assert_eq('بدهی مشتری یک پس از دریافت', pg_temp.bal_party('1201', c1), 0);
PERFORM pg_temp.assert_eq('بدهی مشتری دو دست‌نخورده',   pg_temp.bal_party('1201', c2), 4000000);
PERFORM pg_temp.assert_eq('بانک پس از دریافت از مشتری', pg_temp.bal('1102'), 4940000);

RAISE NOTICE E'\n  → ثبت دوباره تراکنش خزانه نباید اثر تکراری بسازد';
PERFORM treasury.post_transaction(v_tx, v_user);
PERFORM pg_temp.assert_eq('بانک پس از ثبت دوباره', pg_temp.bal('1102'), 4940000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. مانده خزانه با دفتر کل می‌خواند ═══';

PERFORM pg_temp.assert_eq('صندوق فروشگاه',
  (SELECT balance FROM treasury.account_balance WHERE code = 'CASH-MAIN'), 0);
PERFORM pg_temp.assert_eq('حساب جاری',
  (SELECT balance FROM treasury.account_balance WHERE code = 'BANK-1'), 4940000);
PERFORM pg_temp.assert_eq('کارت‌خوان',
  (SELECT balance FROM treasury.account_balance WHERE code = 'POS-1'), 0);
PERFORM pg_temp.assert_eq('کارت‌به‌کارت',
  (SELECT balance FROM treasury.account_balance WHERE code = 'P2P-1'), 3000000);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۹. Idempotency پرداخت و تراکنش (H7) ═══';

INSERT INTO sales.invoice (branch_id, warehouse_id, customer_id, channel, occurred_at, created_by)
VALUES (BR, WH, c2, 'web', '2026-07-06 10:00+03:30', v_user) RETURNING id INTO v_inv;
INSERT INTO treasury.payment (invoice_id, method_code, account_id, amount, client_event_id, occurred_at)
VALUES (v_inv, 'gateway', GW, 500000, 'evt-pay-001', '2026-07-06 10:01+03:30');

PERFORM pg_temp.assert_raises('(H7) پرداخت با کلید رویداد تکراری', format(
  $q$INSERT INTO treasury.payment (invoice_id, method_code, account_id, amount, client_event_id)
     VALUES (%L,'gateway','%s',500000,'evt-pay-001')$q$, v_inv, GW));

PERFORM pg_temp.assert_raises('(H7) تراکنش خزانه با کلید رویداد تکراری', format(
  $q$INSERT INTO treasury.transaction (branch_id, purpose, from_account_id, to_account_id,
                                       amount, client_event_id)
     VALUES ('%s','transfer','%s','%s',1000,'evt-trz-dup');
     INSERT INTO treasury.transaction (branch_id, purpose, from_account_id, to_account_id,
                                       amount, client_event_id)
     VALUES ('%s','transfer','%s','%s',1000,'evt-trz-dup')$q$,
  BR, CASHBOX, BANK, BR, CASHBOX, BANK));

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۰. مرز اجازه تغییر حساب در قواعد ثبت ═══';
-- «از کدام حساب بانکی» داده تراکنش است. «فروش به کدام حساب می‌رود»
-- تصمیم حسابدار است و هیچ تراکنشی نباید بتواند عوضش کند.

PERFORM pg_temp.assert_raises('تغییر حساب روی مؤلفه قفل‌شده (فروش)', format(
  $q$SELECT ledger.post_entry('sale_shift','%s',DATE '2026-07-06','تلاش برای تغییر حساب فروش',
       jsonb_build_array(
         jsonb_build_object('leg','sales','amount',1000,'account_code','4202'),
         jsonb_build_object('leg','cash','amount',1000)),
       NULL,NULL,'%s')$q$, BR, v_user));

-- این عدد عمداً قفل است: هر مؤلفه تازه‌ای که اجازه تغییر حساب بگیرد،
-- اینجا قرمز می‌شود و باید آگاهانه تأیید شود. ۱۰ مؤلفه خزانه و خرید،
-- دو مؤلفه بانکیِ چک (وصول و پاس‌شدن)، و یکی که با مهاجرت ۰۲۶ اضافه
-- شد و **آگاهانه تأیید شده است**:
--
--   purchase_receipt / expensed_charge — هزینه جانبیِ خرید که به بهای
--   کالا نمی‌رود. سرفصلش داده است نه کد: حمل حساب خودش را دارد
--   (۶۱۰۲)، بسته‌بندی حساب خودش (۶۱۰۳). قفل‌کردنش روی یک حساب یعنی
--   هزینه بسته‌بندی زیر «حمل و ارسال» گزارش شود.
--
-- در همین رویداد، موجودی کالا، مالیات و بدهی همچنان قفل‌اند —
-- ادعای بعدی همان را می‌سنجد.
PERFORM pg_temp.assert_eq('مؤلفه‌های دارای اجازه تغییر حساب',
  (SELECT count(*) FROM ledger.posting_rule WHERE allow_account_override), 14);

-- و همه‌شان باید حسابِ نقد، بانک، وجوه در راه یا سرفصل هزینه باشند.
-- هیچ حساب درآمد، مالیات یا موجودی کالا در این فهرست نمی‌آید.
PERFORM pg_temp.assert_eq('مؤلفه با اجازه تغییر حساب و خارج از دامنه مجاز',
  (SELECT count(*) FROM ledger.posting_rule r
     JOIN ledger.account a ON a.code = r.account_code
    WHERE r.allow_account_override
      AND a.parent_code NOT IN ('11','61','62')), 0);

SELECT count(*) INTO v_n FROM ledger.posting_rule
 WHERE allow_account_override
   AND account_code IN ('4101','4102','4103','4201','2201','5101','1301');
PERFORM pg_temp.assert_eq('مؤلفه درآمدی یا انبار با اجازه تغییر حساب', v_n, 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ادعاهای پایدار ═══';

SELECT coalesce(sum(debit),0) - coalesce(sum(credit),0) INTO v_n
  FROM ledger.journal_line;
PERFORM pg_temp.assert_eq('جمع بدهکار − جمع بستانکار', v_n, 0);

SELECT count(*) INTO v_n FROM (
  SELECT entry_id FROM ledger.journal_line
   GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
PERFORM pg_temp.assert_eq('اسناد نامتوازن', v_n, 0);

SELECT count(*) INTO v_n FROM inventory.balance_check
 WHERE qty_diff <> 0 OR value_diff <> 0;
PERFORM pg_temp.assert_eq('اختلاف Projection با حرکت‌ها', v_n, 0);

-- مشتری و تأمین‌کننده جدول دارند، پس سطرشان باید شناسه داشته باشد
SELECT count(*) INTO v_n FROM ledger.journal_line
 WHERE party_type IN ('customer','supplier') AND party_id IS NULL;
PERFORM pg_temp.assert_eq('سطر سند با نوع شخص ولی بدون شناسه', v_n, 0);

PERFORM pg_temp.assert_eq('ارزش موجودی: دفتر کل = انبار',
  pg_temp.bal('1301'),
  (SELECT coalesce(sum(total_value),0) FROM inventory.stock_balance));

-- فاکتور آخر بند ۹ عمداً نهایی نشده، پس دوره‌اش هم باز است
SELECT count(*) INTO v_n FROM sales.unposted_revenue;
PERFORM pg_temp.assert_eq('درآمد ثبت‌نشده', v_n, 0);

RAISE NOTICE E'\n╔══════════════════════════════════════════╗';
RAISE NOTICE   '║   تمام تست‌های خزانه پاس شدند           ║';
RAISE NOTICE   '╚══════════════════════════════════════════╝';
END $test$;

ROLLBACK;
