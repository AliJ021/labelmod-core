-- =====================================================================
-- فصل، آوتلت، و مقصد کالای مرجوعی
-- =====================================================================
-- ادعای مرکزی: **برگ مرجوعیِ ثبت‌شده مقصدش عوض نمی‌شود.**
--
-- حرکت انبار تغییرناپذیر است. اگر پس از ثبت می‌شد انبار را عوض کرد،
-- موجودی در انباری می‌نشست که حرکتش جای دیگری ثبت شده — یک واگرایی
-- که فقط `inventory.balance_check` می‌گرفت، آن هم اگر کسی نگاهش کند.
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
    RAISE NOTICE '  ✓ % — رد شد: %', p_label, left(SQLERRM, 75); RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ % — باید رد می‌شد ولی نشد', p_label;
END $$;

DO $outer$
DECLARE
  BR uuid; WH uuid; OUT_WH uuid; DEF_WH uuid;
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_rcpt uuid;
  v_shift uuid; v_inv uuid; v_line uuid; v_ret uuid;
  v_n numeric; v_t text; v_legacy uuid;
BEGIN
  SELECT id INTO BR FROM platform.branch WHERE code='MAIN';
  SELECT id INTO WH FROM inventory.warehouse WHERE code='STORE';
  SELECT id INTO OUT_WH FROM inventory.warehouse WHERE code='OUTLET';
  SELECT id INTO DEF_WH FROM inventory.warehouse WHERE code='DEFECT';
  SELECT id INTO v_user FROM identity.app_user WHERE username='system';
  PERFORM platform.set_actor(v_user, NULL, NULL);

  RAISE NOTICE E'\n═══ ۱. فصل داده است، نه متن آزاد ═══';
  SELECT count(*) INTO v_n FROM catalog.season WHERE is_active;
  PERFORM pg_temp.assert_eq('فصل‌های Seed', v_n, 7);
  SELECT count(*) INTO v_n FROM catalog.season WHERE climate='cold';
  PERFORM pg_temp.assert_eq('فصل سرد', v_n, 3);
  SELECT count(*) INTO v_n FROM catalog.season WHERE climate='warm';
  PERFORM pg_temp.assert_eq('فصل گرم', v_n, 3);
  -- چهارفصل نه گرم است نه سرد. مجبورکردنش به یکی، گزارش «کالای فصل
  -- سرد» را با زیرپوش پر می‌کرد.
  SELECT count(*) INTO v_n FROM catalog.season WHERE climate='all';
  PERFORM pg_temp.assert_eq('چهارفصل، گروه خودش را دارد', v_n, 1);

  INSERT INTO catalog.product (code, name_internal, season)
  VALUES ('P-SO','پالتو زمستانی','winter') RETURNING id INTO v_prod;
  SELECT season INTO v_t FROM catalog.product WHERE id=v_prod;
  PERFORM pg_temp.assert_txt('فصل روی کالا نشست', v_t, 'winter');

  PERFORM pg_temp.assert_raises('فصل تعریف‌نشده رد می‌شود',
    $q$INSERT INTO catalog.product (code, name_internal, season)
       VALUES ('P-BAD','کالای بد','پاييز')$q$);

  -- ⚠️ NULL باید بماند: کالاهای موجود فصل ندارند و یک FK فوری، کل
  --    مهاجرت را می‌شکست.
  INSERT INTO catalog.product (code, name_internal, season)
  VALUES ('P-LEGACY','کالای قدیمی', NULL) RETURNING id INTO v_legacy;
  RAISE NOTICE '  ✓ کالای بدون فصل پذیرفته می‌شود';

  -- مقدار قدیمیِ متن‌آزاد را مستقیم می‌نشانیم (مثل داده امروز، پیش
  -- از این مهاجرت) و Trigger را دور می‌زنیم تا وضعیت واقعی ساخته شود.
  ALTER TABLE catalog.product DISABLE TRIGGER product_season_check;
  UPDATE catalog.product SET season = 'پاییز ۱۴۰۵' WHERE id = v_legacy;
  ALTER TABLE catalog.product ENABLE TRIGGER product_season_check;

  -- ⚠️ حالا اصلاح **نام** همان کالا باید کار کند.
  --
  -- اگر Trigger مقدار دست‌نخورده را هم می‌سنجید، انباردار که فقط
  -- می‌خواست غلط تایپی نام را درست کند خطای «فصل تعریف نشده»
  -- می‌گرفت — بی‌آنکه بفهمد ربطش چیست.
  UPDATE catalog.product SET name_internal = 'کالای قدیمی — اصلاح‌شده'
   WHERE id = v_legacy;
  SELECT season INTO v_t FROM catalog.product WHERE id = v_legacy;
  PERFORM pg_temp.assert_txt('فصل قدیمی دست‌نخورده ماند', v_t, 'پاییز ۱۴۰۵');

  -- ولی عوض‌کردنش به یک مقدار نامعتبرِ **تازه** همچنان رد می‌شود.
  PERFORM pg_temp.assert_raises('فصل تازهٔ نامعتبر رد می‌شود',
    format($q$UPDATE catalog.product SET season='زمستون' WHERE id=%L::uuid$q$, v_legacy));

  RAISE NOTICE E'\n═══ ۲. آوتلت یک انبار است ═══';
  SELECT kind INTO v_t FROM inventory.warehouse WHERE code='OUTLET';
  PERFORM pg_temp.assert_txt('نوع انبار آوتلت', v_t, 'outlet');
  PERFORM pg_temp.assert_raises('نوع انبار ناشناخته رد می‌شود',
    $q$UPDATE inventory.warehouse SET kind='حراجی' WHERE code='OUTLET'$q$);

  RAISE NOTICE E'\n═══ ۳. یک فروش، برای ساخت مرجوعی ═══';
  INSERT INTO purchasing.supplier (code,name) VALUES ('S-SO','تأمین آوتلت') RETURNING id INTO v_sup;
  INSERT INTO catalog.variation (product_id,color,size,sku)
  VALUES (v_prod,'مشکی','L','SO-L') RETURNING id INTO v_var;
  INSERT INTO catalog.price (variation_id,price_list,amount) VALUES (v_var,'default',2000000);
  INSERT INTO purchasing.receipt (number,branch_id,supplier_id,warehouse_id,occurred_at)
  VALUES (platform.next_document_no(BR,'purchase',1405::smallint),BR,v_sup,WH,now())
  RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id,variation_id,qty,unit_price,line_amount)
  VALUES (v_rcpt,v_var,10,800000,8000000);
  PERFORM purchasing.post_receipt(v_rcpt,v_user);

  INSERT INTO sales.cash_shift (branch_id,user_id,opening_cash,opened_at)
  VALUES (BR,v_user,0,now()) RETURNING id INTO v_shift;
  INSERT INTO sales.invoice (branch_id,warehouse_id,shift_id,occurred_at,created_by)
  VALUES (BR,WH,v_shift,now(),v_user) RETURNING id INTO v_inv;
  INSERT INTO sales.invoice_line (invoice_id,line_no,variation_id,qty,unit_price,net_amount)
  VALUES (v_inv,1,v_var,2,2000000,4000000) RETURNING id INTO v_line;
  PERFORM sales.refresh_invoice_totals(v_inv);
  INSERT INTO treasury.payment (invoice_id,shift_id,method_code,direction,amount,status,occurred_at)
  VALUES (v_inv,v_shift,'cash','in',4000000,'succeeded',now());
  PERFORM sales.finalize_invoice(v_inv,v_user);

  RAISE NOTICE E'\n═══ ۴. مقصد پیش‌فرض، انبار همان فاکتور است ═══';
  INSERT INTO sales.sale_return (branch_id,invoice_id,warehouse_id,shift_id,reason_code,refund_amount,refund_method,occurred_at,created_by)
  VALUES (BR,v_inv,WH,v_shift,'size_small',2000000,'cash',now(),v_user) RETURNING id INTO v_ret;
  SELECT w.code INTO v_t FROM sales.sale_return r
    JOIN inventory.warehouse w ON w.id=r.warehouse_id WHERE r.id=v_ret;
  PERFORM pg_temp.assert_txt('پیش‌فرض قفسه فروشگاه', v_t, 'STORE');

  RAISE NOTICE E'\n═══ ۵. مقصد را می‌شود به آوتلت برد ═══';
  PERFORM sales.set_return_warehouse(v_ret, OUT_WH, v_user);
  SELECT w.code INTO v_t FROM sales.sale_return r
    JOIN inventory.warehouse w ON w.id=r.warehouse_id WHERE r.id=v_ret;
  PERFORM pg_temp.assert_txt('مقصد آوتلت شد', v_t, 'OUTLET');

  SELECT count(*) INTO v_n FROM platform.audit_log
   WHERE action='return.set_warehouse' AND entity_id=v_ret::text;
  PERFORM pg_temp.assert_eq('ردّ حسابرسی دارد', v_n, 1);

  RAISE NOTICE E'\n═══ ۶. سنجش‌هایی که نگذارند کالا گم شود ═══';
  -- ⚠️ انبار «در راه» واقعاً ساخته می‌شود، وگرنه ادعا با پیام «یافت
  -- نشد» سبز می‌شد و شاخه‌ای که باید بسنجد اصلاً اجرا نمی‌شد.
  INSERT INTO inventory.warehouse (branch_id, code, name, kind)
  VALUES (BR, 'TRANSIT-T', 'در راه — تست', 'transit');
  PERFORM pg_temp.assert_raises('انبار در راه مقصد مرجوعی نیست',
    format($q$SELECT sales.set_return_warehouse(%L::uuid,
      (SELECT id FROM inventory.warehouse WHERE code='TRANSIT-T'))$q$, v_ret));
  PERFORM pg_temp.assert_raises('انبار ناموجود',
    format($q$SELECT sales.set_return_warehouse(%L::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid)$q$, v_ret));
  PERFORM pg_temp.assert_raises('برگ ناموجود',
    format($q$SELECT sales.set_return_warehouse(
      '00000000-0000-0000-0000-000000000000'::uuid, %L::uuid)$q$, OUT_WH));

  RAISE NOTICE E'\n═══ ۷. کالای سالم واقعاً به آوتلت می‌رود ═══';
  -- بها از **سطر فروش اصلی** می‌آید، نه میانگین جاری انبار — همان
  -- قاعده‌ای که کل مرجوعی برایش وجود دارد.
  INSERT INTO sales.sale_return_line
    (return_id,invoice_line_id,qty,unit_price,net_amount,unit_cost,cogs_amount,condition)
  SELECT v_ret, v_line, 1, 2000000, 2000000, l.unit_cost, l.unit_cost, 'sellable'
    FROM sales.invoice_line l WHERE l.id = v_line;
  PERFORM sales.post_return(v_ret,v_user);

  SELECT on_hand INTO v_n FROM inventory.stock_balance
   WHERE variation_id=v_var AND warehouse_id=OUT_WH;
  PERFORM pg_temp.assert_eq('یک عدد در آوتلت نشست', v_n, 1);

  -- و در قفسه ننشسته: ۱۰ خرید منهای ۲ فروش = ۸، بدون برگشت.
  SELECT on_hand INTO v_n FROM inventory.stock_balance
   WHERE variation_id=v_var AND warehouse_id=WH;
  PERFORM pg_temp.assert_eq('قفسه دست‌نخورده ماند', v_n, 8);

  RAISE NOTICE E'\n═══ ۸. برگه ثبت‌شده مقصدش عوض نمی‌شود ═══';
  -- مهم‌ترین ادعای این پرونده. حرکت انبار تغییرناپذیر است؛ عوض‌کردن
  -- انبار پس از ثبت یعنی موجودی جایی بنشیند که حرکتش جای دیگری ثبت
  -- شده — واگرایی‌ای که فقط balance_check می‌گیرد.
  PERFORM pg_temp.assert_raises('پس از ثبت، مقصد قفل است',
    format($q$SELECT sales.set_return_warehouse(%L::uuid, %L::uuid)$q$, v_ret, WH));

  RAISE NOTICE E'\n═══ ۹. نمای آوتلت از stock_balance می‌آید ═══';
  SELECT qty INTO v_n FROM inventory.outlet_stock WHERE variation_id=v_var;
  PERFORM pg_temp.assert_eq('نما همان عدد موجودی را می‌دهد', v_n, 1);
  SELECT climate INTO v_t FROM inventory.outlet_stock WHERE variation_id=v_var;
  PERFORM pg_temp.assert_txt('و اقلیم فصل را هم', v_t, 'cold');
  SELECT unit_cost INTO v_n FROM inventory.outlet_stock WHERE variation_id=v_var;
  -- بها از همان فروش برمی‌گردد، نه میانگین جاری.
  PERFORM pg_temp.assert_eq('بهای واحد از همان فروش', v_n, 800000);

  RAISE NOTICE E'\n✓ فصل، آوتلت و مقصد مرجوعی — همه ادعاها پاس شدند';
END $outer$;

ROLLBACK;
