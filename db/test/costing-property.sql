-- =====================================================================
-- خصوصیت هزینه‌یابی: «جمع سود با هر دو روش یکی است»
-- =====================================================================
-- `CLAUDE.md` و ADR-006 این را به‌عنوان یک **واقعیت** اعلام می‌کنند:
--
--   «جمع سود با هر دو روش یکی است؛ فقط زمان شناسایی فرق می‌کند.»
--
-- این یک ادعای **قابل آزمون** است و تا امروز با **یک مثال دستی**
-- سنجیده می‌شد. `db/test/costing.sql` بند ۴ آن مثال است و کارش را
-- می‌کند، ولی دو محدودیت دارد:
--
--   ۱. سمت «میانگین موزون» هرگز **فروشی انجام نمی‌دهد**. سودش با
--      `v_profit_wa := 20 * 500000 - v_val` حساب می‌شود — یعنی یک
--      پیش‌بینی («اگر همه بفروشد»)، نه یک مشاهده.
--   ۲. درآمد در هر دو سمت دستی نوشته می‌شود (`20 * 500000`)، پس
--      مقایسه میان دو **فرمولِ خودِ تست** است، نه میان دو عددِ
--      اندازه‌گیری‌شده. بند ۶ الحاقیه: نتیجهٔ انتظاری را از همان چیزی
--      که تحت آزمون است تولید نکن.
--
-- این پرونده همان ادعا را **اندازه می‌گیرد**:
--
--   • سود از **دفتر** خوانده می‌شود (`pg_temp.profit()`)، نه با حساب
--     دستی و نه از تابع تحت آزمون.
--   • همان سناریو **واقعاً دو بار اجرا می‌شود** — یک بار با هر روش —
--     و هر دو بار کالا تا آخر فروخته و دوره ثبت بسته می‌شود.
--   • ۱۵۰ سناریوی تصادفی و بازتولیدپذیر (`setseed`)، نه یک مثال.
--
-- ⚠️ **بند ۲ کنترل حساسیت است و حذف نمی‌شود.** یک آزمونِ برابری که
--    هرگز نتواند نابرابری را ببیند، سبزِ بی‌معناست. بند ۲ عمداً نیمی
--    از موجودی را نمی‌فروشد و ادعا می‌کند دو روش **باید فرق کنند** —
--    چون آن‌وقت ارزش دفتری باقی‌مانده یکی نیست. این هم‌زمان نیمهٔ دومِ
--    ادعای سند را می‌سنجد: «فقط زمان شناسایی فرق می‌کند».
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

-- مرجع **مستقل** سود: از دفتر. درآمد طبیعتاً بستانکار است و هزینه و
-- تخفیف طبیعتاً بدهکار، پس برای هر سه، سهمِ سود = credit − debit.
CREATE OR REPLACE FUNCTION pg_temp.profit() RETURNS numeric LANGUAGE sql AS $$
  SELECT coalesce(sum(l.credit - l.debit), 0)
    FROM ledger.journal_line l
    JOIN ledger.account a ON a.code = l.account_code
   WHERE a.type IN ('revenue', 'contra_revenue', 'expense');
$$;

DO $t$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  N  int  := 150;
  v_user uuid; v_sup uuid; v_prod uuid;
  v_var uuid; v_rcpt uuid; v_inv uuid; v_shift uuid;
  v_method text; v_p0 numeric; v_delta numeric;
  v_wa numeric; v_lp numeric;
  v_rcount int; v_qty numeric; v_price numeric; v_sale numeric;
  v_total numeric; v_units numeric; v_sell numeric;
  v_bad int := 0; v_same int := 0; v_i int; v_j int; v_m int;
  v_part boolean;
BEGIN
  INSERT INTO identity.app_user (username, full_name)
  VALUES ('prop_cost','خصوصیت هزینه‌یابی') RETURNING id INTO v_user;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
  PERFORM platform.set_actor(v_user);
  INSERT INTO purchasing.supplier (code, name) VALUES ('S-PROP','تأمین خصوصیت')
    RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code, name_internal) VALUES ('P-PROP','کالای خصوصیت')
    RETURNING id INTO v_prod;

  RAISE NOTICE E'\n═══ ۱. فروش کامل: جمع سود دو روش باید یکی باشد ═══';

  FOR v_part IN SELECT * FROM (VALUES (false), (true)) AS x(b) LOOP
  IF v_part THEN
    RAISE NOTICE E'\n═══ ۲. کنترل حساسیت — فروش نیمی: باید فرق کنند ═══';
    N := 12;
  END IF;

  PERFORM setseed(0.4271);
  v_bad := 0; v_same := 0;

  FOR v_i IN 1..N LOOP
    -- پارامترها یک بار قید می‌شوند و برای **هر دو روش** یکی می‌مانند،
    -- وگرنه مقایسه بی‌معناست.
    -- در بند ۲ دست‌کم دو رسید لازم است: با یک نرخ، تجدید ارزیابی‌ای
    -- وجود ندارد و دو روش **عمداً** یکی می‌شوند.
    v_rcount := CASE WHEN v_part THEN 2 + floor(random() * 3)
                     ELSE 1 + floor(random() * 4) END;
    v_sale   := 50000 + floor(random() * 900000);

    FOR v_m IN 1..2 LOOP
      v_method := CASE v_m WHEN 1 THEN 'moving_weighted_average' ELSE 'last_purchase' END;
      PERFORM platform.set_setting('costing.method', to_jsonb(v_method), 'آزمون خصوصیت');

      -- تنوع تازه: لایه‌های بهای سناریوی قبلی دخالت نکنند.
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (v_prod, 'رنگ'||v_part::int||v_i, 'S'||v_m, 'PROP-'||v_part::int||v_i||'-'||v_m)
      RETURNING id INTO v_var;

      v_p0 := pg_temp.profit();
      v_units := 0;

      -- همان توالی خرید برای هر دو روش.
      PERFORM setseed(0.4271 + v_i * 0.0001 + v_part::int * 0.05);
      FOR v_j IN 1..v_rcount LOOP
        v_qty   := 1 + floor(random() * 20);
        v_price := 10000 + floor(random() * 500000);
        INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
        VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH,
                '2026-06-01'::date + v_j)
        RETURNING id INTO v_rcpt;
        INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
        VALUES (v_rcpt, v_var, v_qty, v_price, v_qty * v_price);
        PERFORM purchasing.post_receipt(v_rcpt, v_user);
        v_units := v_units + v_qty;
      END LOOP;

      -- ادعا «جمع سود در طول عمر کالا» است، پس بند ۱ همه را می‌فروشد.
      v_sell  := CASE WHEN v_part THEN greatest(1, floor(v_units / 2)) ELSE v_units END;
      v_total := v_sell * v_sale;

      INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
      VALUES (BR, v_user, 0,
        '2026-06-10 09:00+03:30'::timestamptz + ((v_i*2+v_m) % 200) * interval '1 day')
      RETURNING id INTO v_shift;
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, occurred_at, created_by)
      VALUES (BR, WH, v_shift,
        '2026-06-10 10:00+03:30'::timestamptz + ((v_i*2+v_m) % 200) * interval '1 day', v_user)
      RETURNING id INTO v_inv;
      INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
      VALUES (v_inv, 1, v_var, v_sell, v_sale, v_total);
      INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount)
      VALUES (v_inv, v_shift, 'cash', v_total);
      PERFORM sales.finalize_invoice(v_inv, v_user);
      PERFORM sales.close_shift(v_shift, v_total, v_user, NULL);

      v_delta := pg_temp.profit() - v_p0;
      IF v_m = 1 THEN v_wa := v_delta; ELSE v_lp := v_delta; END IF;
    END LOOP;

    IF v_wa IS DISTINCT FROM v_lp THEN v_bad := v_bad + 1; ELSE v_same := v_same + 1; END IF;
  END LOOP;

  IF NOT v_part THEN
    PERFORM pg_temp.assert_eq(
      format('سناریوهایی که جمع سودشان فرق کرد (از %s فروش کامل)', N), v_bad, 0);
  ELSE
    -- حساسیت: با موجودیِ باقی‌مانده، **هر** سناریو باید فرق کند.
    PERFORM pg_temp.assert_eq(
      format('سناریوهایی که با فروش نیمی یکی ماندند (از %s)', N), v_same, 0);
  END IF;
  END LOOP;

  RAISE NOTICE E'\n✔ خصوصیت هزینه‌یابی — هر دو نیمه ادعا اندازه‌گیری شد';
END $t$;

ROLLBACK;
