-- =====================================================================
-- خرید برای دیگری، و بسته‌بندی هدیه
-- =====================================================================
-- چهار چیزی که بی‌صدا می‌شکنند:
--
--   ۱. گیرنده = خریدار → گزارش، هدیه‌ای می‌شمارد که هدیه نبوده
--   ۲. «گل رز» در ستون کاغذ → برگه چاپی چیز بی‌معنایی می‌گوید
--   ۳. تغییر بسته پس از نهایی‌شدن → آنچه مشتری برد با سیستم فرق کند
--   ۴. گیرنده‌ی جدا از پرونده مشتری → اندازه‌هایش هرگز پیدا نشود
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(p_label text, p_actual numeric, p_expected numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual,'NULL');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(p_label text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  ✓ % — رد شد: %', p_label, left(SQLERRM, 72); RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ % — باید رد می‌شد ولی نشد', p_label;
END $$;

DO $outer$
DECLARE
  BR uuid; WH uuid; v_user uuid; v_sup uuid; v_prod uuid; v_var uuid;
  v_rcpt uuid; v_shift uuid; v_inv uuid; v_buyer uuid; v_recip uuid;
  v_n numeric; v_t text; v_b boolean;
BEGIN
  SELECT id INTO BR FROM platform.branch WHERE code='MAIN';
  SELECT id INTO WH FROM inventory.warehouse WHERE code='STORE';
  SELECT id INTO v_user FROM identity.app_user WHERE username='system';
  PERFORM platform.set_actor(v_user, NULL, NULL);

  RAISE NOTICE E'\n═══ ۱. گزینه‌های هدیه داده‌اند ═══';
  SELECT count(*) INTO v_n FROM sales.gift_option WHERE kind='wrap' AND is_active;
  PERFORM pg_temp.assert_eq('شیوه بسته‌بندی', v_n, 4);
  SELECT count(*) INTO v_n FROM sales.gift_option WHERE kind='color' AND is_active;
  PERFORM pg_temp.assert_eq('رنگ بسته', v_n, 5);
  SELECT count(*) INTO v_n FROM sales.gift_option WHERE kind='flower' AND is_active;
  PERFORM pg_temp.assert_eq('گل همراه', v_n, 3);
  PERFORM pg_temp.assert_raises('دسته ناشناخته رد می‌شود',
    $q$INSERT INTO sales.gift_option (code,kind,label) VALUES ('x','ribbon','روبان')$q$);

  RAISE NOTICE E'\n═══ ۲. یک فاکتور باز ═══';
  INSERT INTO purchasing.supplier (code,name) VALUES ('S-GF','تأمین هدیه') RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code,name_internal) VALUES ('P-GF','شال هدیه') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'کرم','ONE','GF-1') RETURNING id INTO v_var;
  INSERT INTO catalog.price (variation_id,price_list,amount) VALUES (v_var,'default',900000);
  INSERT INTO purchasing.receipt (number,branch_id,supplier_id,warehouse_id,occurred_at)
  VALUES (platform.next_document_no(BR,'purchase',1405::smallint),BR,v_sup,WH,now())
  RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id,variation_id,qty,unit_price,line_amount)
  VALUES (v_rcpt,v_var,20,400000,8000000);
  PERFORM purchasing.post_receipt(v_rcpt,v_user);

  INSERT INTO sales.customer (mobile_normalized, full_name)
  VALUES ('09131110001','خریدار') RETURNING id INTO v_buyer;
  INSERT INTO sales.customer (mobile_normalized, full_name)
  VALUES ('09131110002','گیرنده هدیه') RETURNING id INTO v_recip;

  INSERT INTO sales.cash_shift (branch_id,user_id,opening_cash,opened_at)
  VALUES (BR,v_user,0,now()) RETURNING id INTO v_shift;
  INSERT INTO sales.invoice (branch_id,warehouse_id,shift_id,customer_id,occurred_at,created_by)
  VALUES (BR,WH,v_shift,v_buyer,now(),v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id,line_no,variation_id,qty,unit_price,net_amount)
  VALUES (v_inv,1,v_var,1,900000,900000);
  PERFORM sales.refresh_invoice_totals(v_inv);

  RAISE NOTICE E'\n═══ ۳. گیرنده یک مشتری است، نه چند ستون ═══';
  PERFORM sales.set_invoice_recipient(v_inv, v_recip, v_user);
  SELECT c.full_name INTO v_t FROM sales.invoice i
    JOIN sales.customer c ON c.id = i.recipient_id WHERE i.id = v_inv;
  PERFORM pg_temp.assert_txt('گیرنده ثبت شد', v_t, 'گیرنده هدیه');

  -- ⚠️ چون گیرنده یک مشتری واقعی است، اندازه‌هایش در پرونده خودش
  --    می‌نشیند. با ستون روی فاکتور، این هرگز پیدا نمی‌شد.
  PERFORM sales.set_customer_measures(v_recip, '{"height": 165}'::jsonb, v_user);
  SELECT value_cm INTO v_n FROM sales.customer_measure WHERE customer_id = v_recip;
  PERFORM pg_temp.assert_eq('اندازه گیرنده در پرونده خودش', v_n, 165.0);

  PERFORM pg_temp.assert_raises('گیرنده نمی‌تواند خودِ خریدار باشد',
    format($q$SELECT sales.set_invoice_recipient(%L::uuid, %L::uuid)$q$, v_inv, v_buyer));
  PERFORM pg_temp.assert_raises('گیرنده ناموجود',
    format($q$SELECT sales.set_invoice_recipient(%L::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid)$q$, v_inv));

  -- قید دیتابیس هم مستقل از تابع می‌گیرد — دو لایه دفاع.
  PERFORM pg_temp.assert_raises('قید جدول هم جلوی خودارجاعی را می‌گیرد',
    format($q$UPDATE sales.invoice SET recipient_id = customer_id WHERE id = %L::uuid$q$, v_inv));

  RAISE NOTICE E'\n═══ ۴. بسته‌بندی هدیه ═══';
  PERFORM sales.set_invoice_gift(v_inv, 'wrap_box', 'color_gold', 'flower_rose',
    'تولدت مبارک', true, v_user);
  SELECT wrap_code INTO v_t FROM sales.invoice_gift WHERE invoice_id=v_inv;
  PERFORM pg_temp.assert_txt('شیوه بسته‌بندی', v_t, 'wrap_box');
  SELECT note INTO v_t FROM sales.invoice_gift WHERE invoice_id=v_inv;
  PERFORM pg_temp.assert_txt('یادداشت کارت', v_t, 'تولدت مبارک');
  SELECT hide_prices INTO v_b FROM sales.invoice_gift WHERE invoice_id=v_inv;
  IF NOT v_b THEN RAISE EXCEPTION '✗ پیش‌فرض باید پنهان‌کردن قیمت باشد'; END IF;
  RAISE NOTICE '  ✓ قیمت روی برگه هدیه پیش‌فرض پنهان است';

  RAISE NOTICE E'\n═══ ۵. هر کد باید از دسته درست باشد ═══';
  -- بدون این، «گل رز» در ستون کاغذ می‌نشست و برگه چاپی چیز بی‌معنایی
  -- می‌گفت — بی‌آنکه خطایی بدهد.
  PERFORM pg_temp.assert_raises('گل در ستون کاغذ',
    format($q$SELECT sales.set_invoice_gift(%L::uuid, 'flower_rose')$q$, v_inv));
  PERFORM pg_temp.assert_raises('کاغذ در ستون رنگ',
    format($q$SELECT sales.set_invoice_gift(%L::uuid, NULL, 'wrap_box')$q$, v_inv));
  PERFORM pg_temp.assert_raises('رنگ در ستون گل',
    format($q$SELECT sales.set_invoice_gift(%L::uuid, NULL, NULL, 'color_gold')$q$, v_inv));

  -- و پس از هر رد شدن، مقدار قبلی دست‌نخورده مانده.
  SELECT wrap_code INTO v_t FROM sales.invoice_gift WHERE invoice_id=v_inv;
  PERFORM pg_temp.assert_txt('ردِ اعتبارسنجی، بسته قبلی را خراب نکرد', v_t, 'wrap_box');

  RAISE NOTICE E'\n═══ ۶. جایگزینی، نه سطر دوم ═══';
  PERFORM sales.set_invoice_gift(v_inv, 'wrap_paper', 'color_red', NULL, NULL, false, v_user);
  SELECT count(*) INTO v_n FROM sales.invoice_gift WHERE invoice_id=v_inv;
  PERFORM pg_temp.assert_eq('یک سطر، نه دو', v_n, 1);
  SELECT flower_code INTO v_t FROM sales.invoice_gift WHERE invoice_id=v_inv;
  PERFORM pg_temp.assert_txt('گل برداشته شد', v_t, NULL);

  RAISE NOTICE E'\n═══ ۷. حذف بسته ═══';
  PERFORM sales.clear_invoice_gift(v_inv, v_user);
  SELECT count(*) INTO v_n FROM sales.invoice_gift WHERE invoice_id=v_inv;
  PERFORM pg_temp.assert_eq('فاکتور معمولی سطر هدیه ندارد', v_n, 0);

  RAISE NOTICE E'\n═══ ۸. پس از نهایی‌شدن، هر دو قفل‌اند ═══';
  PERFORM sales.set_invoice_gift(v_inv, 'wrap_box', NULL, NULL, 'کارت', true, v_user);
  INSERT INTO treasury.payment (invoice_id,shift_id,method_code,direction,amount,status,occurred_at)
  VALUES (v_inv,v_shift,'cash','in',900000,'succeeded',now());
  PERFORM sales.finalize_invoice(v_inv,v_user);

  -- برگه هدیه بخشی از همان سند است. تغییرش پس از تحویل یعنی آنچه
  -- مشتری برد با آنچه در سیستم است فرق کند.
  PERFORM pg_temp.assert_raises('بسته‌بندی پس از نهایی‌شدن قفل است',
    format($q$SELECT sales.set_invoice_gift(%L::uuid, 'wrap_bag')$q$, v_inv));
  PERFORM pg_temp.assert_raises('حذف بسته هم قفل است',
    format($q$SELECT sales.clear_invoice_gift(%L::uuid)$q$, v_inv));
  PERFORM pg_temp.assert_raises('گیرنده هم قفل است',
    format($q$SELECT sales.set_invoice_recipient(%L::uuid, NULL)$q$, v_inv));

  RAISE NOTICE E'\n═══ ۹. ردّ حسابرسی ═══';
  SELECT count(*) INTO v_n FROM platform.audit_log
   WHERE action IN ('invoice.set_gift','invoice.clear_gift','invoice.set_recipient')
     AND entity_id = v_inv::text;
  IF v_n < 3 THEN RAISE EXCEPTION '✗ تغییرات هدیه ردّ حسابرسی ندارند: %', v_n; END IF;
  RAISE NOTICE '  ✓ ردّ حسابرسی ثبت شد = %', v_n;

  RAISE NOTICE E'\n✓ خرید برای دیگری و هدیه — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
