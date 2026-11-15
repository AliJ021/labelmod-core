-- =====================================================================
-- تست تسویهٔ خودکار شبانه — مهاجرت ۱۲۱
-- =====================================================================
-- ثابت این پرونده: پس از تسویهٔ خودکار، **حساب واسط کارت‌خوان در دفتر
-- صفر است** و بانک به اندازهٔ خالص، و کارمزد به اندازهٔ نرخ قرارداد ثبت
-- شده است — با عددهایی که دستی نوشته شده‌اند، نه از خود تابع.
--
-- ⚠️ بند ۲ **کنترل منفی** است: پیش از موعد واریز هیچ چیز تسویه نمی‌شود.
--    بی آن، تابعی که همه‌چیز را همان لحظه تسویه کند بندهای بعدی را سبز می‌کرد.
-- ⚠️ بند ۴ بازپرداخت کارتی را می‌سنجد: پذیرنده برگشت را از واریز کم می‌کند و
--    بی کسرش حساب واسط برای همیشه منفی می‌ماند.
-- ⚠️ «امروز» صریح داده می‌شود (`p_today`)، نه از ساعت دیواری.
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

-- ماندهٔ یک حساب دفتر از سندهای قطعی.
CREATE OR REPLACE FUNCTION pg_temp.bal(p_code text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)::text
    FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE l.account_code = p_code AND e.status IN ('confirmed','final');
$$;

DO $test$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  WH   uuid := '00000000-0000-7000-8000-000000000101';
  POS  uuid := '00000000-0000-7000-8000-000000000203';
  GW   uuid := '00000000-0000-7000-8000-000000000204';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_rcpt uuid; v_shift uuid;
  v_inv1 uuid; v_line1 uuid; v_inv2 uuid; v_inv3 uuid; v_ret uuid; v_pos2 uuid;
  v_n int; r record;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('autosettle','تست تسویهٔ خودکار')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

-- کارمزد قراردادی: کارت‌خوان ۱٫۵٪ و واریز فردا، درگاه ۲٪ و واریز دو روز بعد.
PERFORM treasury.set_settlement_terms(POS, 1::smallint, 1.5, 'آزمون تسویهٔ خودکار', v_user);
PERFORM treasury.set_settlement_terms(GW,  2::smallint, 2.0, 'آزمون تسویهٔ خودکار', v_user);

INSERT INTO purchasing.supplier (code, name) VALUES ('S-AST','تأمین‌کننده') RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-AST','کالای تسویه') RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (v_prod,'آبی','M','AST-M') RETURNING id INTO v_var;
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-08-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 20, 500000, 10000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-08-10 09:00+03:30') RETURNING id INTO v_shift;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. پرداخت کارتی و درگاهی بی حساب، پایانه می‌گیرد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- صندوق `accountId` نمی‌فرستد؛ تا مهاجرت ۱۲۱ این پرداخت‌ها هرگز تسویه نمی‌شدند.

-- ۱۰ مرداد: کارت ۲٬۰۰۰٬۰۰۰
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_shift, 'pos', '2026-08-10 10:00+03:30', v_user) RETURNING id INTO v_inv1;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv1, 1, v_var, 2, 1000000, 2000000) RETURNING id INTO v_line1;
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, occurred_at)
VALUES (v_inv1, v_shift, 'card', 2000000, '2026-08-10 10:01+03:30');
PERFORM sales.finalize_invoice(v_inv1, v_user);

-- ۱۱ مرداد: کارت ۱٬۰۰۰٬۰۰۰
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_shift, 'pos', '2026-08-11 10:00+03:30', v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_var, 1, 1000000, 1000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, occurred_at)
VALUES (v_inv2, v_shift, 'card', 1000000, '2026-08-11 10:01+03:30');
PERFORM sales.finalize_invoice(v_inv2, v_user);

-- ۱۰ مرداد: درگاه ۳٬۰۰۰٬۰۰۰
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_shift, 'pos', '2026-08-10 11:00+03:30', v_user) RETURNING id INTO v_inv3;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv3, 1, v_var, 3, 1000000, 3000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, occurred_at)
VALUES (v_inv3, v_shift, 'gateway', 3000000, '2026-08-10 11:01+03:30');
PERFORM sales.finalize_invoice(v_inv3, v_user);

PERFORM pg_temp.assert_eq('پرداخت کارتی به کارت‌خوان شعبه وصل شد',
  (SELECT count(*)::text FROM treasury.payment WHERE invoice_id IN (v_inv1, v_inv2) AND account_id = POS), '2');
PERFORM pg_temp.assert_eq('پرداخت درگاهی به درگاه شعبه وصل شد',
  (SELECT count(*)::text FROM treasury.payment WHERE invoice_id = v_inv3 AND account_id = GW), '1');
PERFORM pg_temp.assert_eq('روش نقد پایانه نمی‌گیرد',
  coalesce(treasury.payment_terminal(BR, 'cash')::text, 'NULL'), 'NULL');

-- ۱۱ مرداد: یکی از دو قلم فاکتور اول با بازپرداخت کارتی برمی‌گردد.
INSERT INTO sales.sale_return (branch_id, invoice_id, warehouse_id, shift_id,
                               reason_code, refund_amount, refund_method, occurred_at, created_by)
VALUES (BR, v_inv1, WH, v_shift, 'changed_mind', 1000000, 'card', '2026-08-11 12:00+03:30', v_user)
RETURNING id INTO v_ret;
INSERT INTO sales.sale_return_line (return_id, invoice_line_id, qty, unit_price, net_amount, unit_cost, cogs_amount)
VALUES (v_ret, v_line1, 1, 0, 0, 0, 0);
PERFORM sales.post_return(v_ret, v_user);
PERFORM pg_temp.assert_eq('بازپرداخت کارتی هم به کارت‌خوان وصل شد',
  (SELECT account_id::text FROM treasury.payment WHERE return_id = v_ret), POS::text);

PERFORM sales.close_shift(v_shift, 0, v_user);
-- دفتر پیش از تسویه: کارت ۳ میلیون − برگشت ۱ میلیون؛ درگاه ۳ میلیون.
PERFORM pg_temp.assert_eq('واسط کارت‌خوان پیش از تسویه', pg_temp.bal('1103'), '2000000');
PERFORM pg_temp.assert_eq('واسط درگاه پیش از تسویه',     pg_temp.bal('1104'), '3000000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. کنترل منفی: پیش از موعد واریز هیچ تسویه‌ای نیست ═══';
-- ═══════════════════════════════════════════════════════════════════
-- «امروز» = ۱۰ مرداد: روز کامل‌شده‌ای نیست.

SELECT count(*) INTO v_n FROM treasury.auto_settle_due(v_user, '2026-08-10') WHERE settlement_id IS NOT NULL;
PERFORM pg_temp.assert_eq('روز جاری تسویه نمی‌شود', v_n::text, '0');
PERFORM pg_temp.assert_eq('واسط کارت‌خوان دست نخورد', pg_temp.bal('1103'), '2000000');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. ۱۱ مرداد: فقط روزی که موعدش رسیده ═══';
-- ═══════════════════════════════════════════════════════════════════
-- کارت‌خوان (یک روز): فروش ۱۰ مرداد = ۲ میلیون. کارمزد ۱٫۵٪ = ۳۰٬۰۰۰.
-- درگاه (دو روز): ۱۰ + ۲ = ۱۲ مرداد؛ هنوز موعدش نیست.

FOR r IN SELECT * FROM treasury.auto_settle_due(v_user, '2026-08-11') LOOP
  RAISE NOTICE '    % % تا % → % %', r.account_code, r.period_from, r.period_to,
    coalesce(r.gross::text, '-'), coalesce(r.skipped, '');
END LOOP;
PERFORM pg_temp.assert_eq('برگ تسویهٔ کارت‌خوان: ناخالص، کارمزد، خالص',
  (SELECT gross_amount || ' ' || fee_amount || ' ' || net_amount || ' ' || period_from || ' ' || period_to
     FROM treasury.settlement WHERE source_account_id = POS),
  '2000000 30000 1970000 2026-08-10 2026-08-10');
PERFORM pg_temp.assert_eq('درگاه پیش از موعد تسویه نشد',
  (SELECT count(*)::text FROM treasury.settlement WHERE source_account_id = GW), '0');
PERFORM pg_temp.assert_eq('تاریخ سند = روز واریز',
  (SELECT e.entry_date::text FROM treasury.settlement s JOIN ledger.journal_entry e ON e.id = s.entry_id
    WHERE s.source_account_id = POS), '2026-08-11');
PERFORM pg_temp.assert_eq('واسط کارت‌خوان: فقط ۱۱ مرداد مانده', pg_temp.bal('1103'), '0');
PERFORM pg_temp.assert_eq('کارمزد در هزینه', pg_temp.bal('6101'), '30000');

-- اجرای دوباره در همان روز اثری ندارد.
SELECT count(*) INTO v_n FROM treasury.auto_settle_due(v_user, '2026-08-11') WHERE settlement_id IS NOT NULL;
PERFORM pg_temp.assert_eq('اجرای دوباره در همان روز برگ تازه نمی‌سازد', v_n::text, '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. برگشت کارتی از جمع کم می‌شود؛ اجرای جاافتاده جبران می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
-- زمان‌بند ۱۲ مرداد اجرا نشد؛ ۱۳ مرداد هر دو پایانه یک‌جا تسویه می‌شوند.
-- کارت‌خوان ۱۱ مرداد: دریافت ۱ میلیون − برگشت ۱ میلیون = صفر → رد، به دورهٔ بعد.
-- درگاه ۱۰ و ۱۱ مرداد: ۳ میلیون؛ کارمزد ۲٪ = ۶۰٬۰۰۰.

FOR r IN SELECT * FROM treasury.auto_settle_due(v_user, '2026-08-13') LOOP
  RAISE NOTICE '    % % تا % → % %', r.account_code, r.period_from, r.period_to,
    coalesce(r.gross::text, '-'), coalesce(r.skipped, '');
END LOOP;
PERFORM pg_temp.assert_eq('جمع خالص صفر رد شد و دلیلش برگشت',
  (SELECT (position('صفر یا منفی' IN skipped) > 0)::text
     FROM treasury.auto_settle_due(v_user, '2026-08-13') WHERE account_code = 'POS-1'), 'true');
PERFORM pg_temp.assert_eq('برگ درگاه: ناخالص، کارمزد، خالص',
  (SELECT gross_amount || ' ' || fee_amount || ' ' || net_amount
     FROM treasury.settlement WHERE source_account_id = GW), '3000000 60000 2940000');
PERFORM pg_temp.assert_eq('واسط درگاه صفر شد', pg_temp.bal('1104'), '0');
PERFORM pg_temp.assert_eq('واسط کارت‌خوان: دریافت و برگشت هم‌دیگر را خنثی کردند', pg_temp.bal('1103'), '0');

-- فروش کارتی تازه در ۱۴ مرداد؛ ۱۵ مرداد همراه با پرداخت‌های ۱۱ مرداد تسویه می‌شود.
INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, '2026-08-14 09:00+03:30') RETURNING id INTO v_shift;
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_shift, 'pos', '2026-08-14 10:00+03:30', v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_var, 4, 1000000, 4000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, occurred_at)
VALUES (v_inv2, v_shift, 'card', 4000000, '2026-08-14 10:01+03:30');
PERFORM sales.finalize_invoice(v_inv2, v_user);
PERFORM sales.close_shift(v_shift, 0, v_user);

PERFORM treasury.auto_settle_due(v_user, '2026-08-15');
PERFORM pg_temp.assert_eq('برگ دوم کارت‌خوان: ۱ − ۱ + ۴ میلیون، کارمزد ۶۰٬۰۰۰',
  (SELECT gross_amount || ' ' || fee_amount || ' ' || period_from || ' ' || period_to
     FROM treasury.settlement WHERE source_account_id = POS AND period_to = '2026-08-14'),
  '4000000 60000 2026-08-11 2026-08-14');
PERFORM pg_temp.assert_eq('همهٔ پرداخت‌های کارتی و برگشت تسویه شدند',
  (SELECT count(*)::text FROM treasury.payment WHERE account_id = POS AND settlement_id IS NULL), '0');
PERFORM pg_temp.assert_eq('واسط کارت‌خوان صفر', pg_temp.bal('1103'), '0');
PERFORM pg_temp.assert_eq('بانک = جمع خالص‌ها',
  pg_temp.bal('1102'), (1970000 + 2940000 + 3940000)::text);
PERFORM pg_temp.assert_eq('کارمزد = جمع کارمزدها', pg_temp.bal('6101'), (30000 + 60000 + 60000)::text);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. پایانهٔ مبهم حدس زده نمی‌شود؛ زنگ می‌خورد ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO treasury.account (code, name, kind, branch_id, ledger_account_code, settlement_account_id, settlement_days)
VALUES ('POS-2', 'کارت‌خوان دوم', 'card_terminal', BR, '1103', '00000000-0000-7000-8000-000000000202', 1)
RETURNING id INTO v_pos2;
PERFORM pg_temp.assert_eq('با دو کارت‌خوان، پایانه تعیین نمی‌شود',
  coalesce(treasury.payment_terminal(BR, 'card')::text, 'NULL'), 'NULL');

-- زنگ با تاریخ امروز کار می‌کند؛ یک پرداخت بی‌پایانهٔ قدیمی می‌سازیم.
INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
VALUES (BR, v_user, 0, now() - interval '10 days') RETURNING id INTO v_shift;
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel, occurred_at, created_by)
VALUES (BR, WH, v_shift, 'pos', now() - interval '10 days', v_user) RETURNING id INTO v_inv2;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv2, 1, v_var, 1, 1000000, 1000000);
INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, occurred_at)
VALUES (v_inv2, v_shift, 'card', 1000000, now() - interval '10 days');
PERFORM sales.finalize_invoice(v_inv2, v_user);
PERFORM pg_temp.assert_eq('پرداخت بی‌پایانه ماند', (SELECT coalesce(account_id::text,'NULL')
  FROM treasury.payment WHERE invoice_id = v_inv2), 'NULL');
PERFORM pg_temp.assert_eq('زنگ پرداخت تسویه‌نشده روشن است',
  (SELECT n::text FROM platform.health_alerts() WHERE code = 'unsettled_terminal'), '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. کلید خاموش: هیچ کاری نمی‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════

UPDATE treasury.account SET is_active = false WHERE id = v_pos2;
UPDATE treasury.payment SET account_id = POS WHERE invoice_id = v_inv2;
PERFORM platform.set_setting('treasury.auto_settlement', 'false', 'آزمون', v_user);
SELECT count(*) INTO v_n FROM treasury.auto_settle_due(v_user, platform.business_date());
PERFORM pg_temp.assert_eq('خاموش: هیچ سطری', v_n::text, '0');
PERFORM pg_temp.assert_eq('خاموش: پرداخت تسویه‌نشده ماند',
  (SELECT count(*)::text FROM treasury.payment WHERE invoice_id = v_inv2 AND settlement_id IS NULL), '1');
PERFORM platform.set_setting('treasury.auto_settlement', 'true', 'آزمون', v_user);
PERFORM treasury.auto_settle_due(v_user, platform.business_date());
PERFORM pg_temp.assert_eq('روشن: تسویه شد و زنگ خاموش شد',
  (SELECT n::text FROM platform.health_alerts() WHERE code = 'unsettled_terminal'), '0');

RAISE NOTICE E'\n✔ تسویهٔ خودکار — پایانه، موعد واریز، کارمزد قراردادی، برگشت کارتی، جبران، ابهام، کلید';
END $test$;

ROLLBACK;
