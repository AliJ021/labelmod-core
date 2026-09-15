-- =====================================================================
-- تست Push لحظه‌ای موجودی و قیمت به سایت — مهاجرت ۰۵۷ · ADR-007
-- =====================================================================
-- ادعای مرکزی: **هر مسیری که موجودی را عوض می‌کند پیام می‌سازد، و صف
-- با تعداد حرکت‌ها منفجر نمی‌شود.**
--
-- این پرونده همان فهرست «شرط پذیرش» ADR-007 را می‌راند — آن بخش‌هایش که
-- در SQL معنا دارند:
--
--   • فروش، مرجوعی، رسید خرید، برگشت از خرید، انتقال، انبارگردانی
--   • تجمیع: ۵۰ حرکت → یک سطر معلق
--   • مقدار **مطلق**، نه تفاضل
--   • نسخهٔ صعودی، بدون تکرار
--   • انتقال میان دو انبار غیرسایتی → **هیچ پیامی**
--   • تجدید ارزیابی (تعداد صفر) → موجودی عوض نشده، ولی پیام؟
--   • قیمت: null ≠ صفر
--   • خاموش‌بودن → صف پر نمی‌شود
--
-- ⚠️ و یک **کنترل مثبت** در هر بند شمارشی: بی‌آن، یک `push_web_stock`
--    که همیشه زودهنگام RETURN کند هم «پاس» می‌شد و کل این قابلیت
--    خاموش بود بی‌آنکه یک تست قرمز شود.
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
  RAISE NOTICE '  ✓ % = %', p_label, coalesce(p_actual, '(NULL)');
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

/** شمار سطرهای معلقِ Push برای یک تنوع. */
CREATE OR REPLACE FUNCTION pg_temp.pending(p_topic text, p_var uuid)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM platform.outbox_message
   WHERE topic = p_topic AND status = 'pending'
     AND payload->>'variationId' = p_var::text;
$$;

/** مقدار یک میدان از سطر معلق. */
CREATE OR REPLACE FUNCTION pg_temp.field(p_topic text, p_var uuid, p_key text)
RETURNS text LANGUAGE sql AS $$
  SELECT payload->>p_key FROM platform.outbox_message
   WHERE topic = p_topic AND status = 'pending'
     AND payload->>'variationId' = p_var::text
   ORDER BY id DESC LIMIT 1;
$$;

DO $test$
DECLARE
  BR    uuid := '00000000-0000-7000-8000-000000000001';
  WEB   uuid;               -- انبار سایت
  BACK  uuid;               -- انبار پشتیبان (غیرسایتی)
  OTHER uuid;               -- انبار غیرسایتی دوم
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_var2 uuid;
  v_rcpt uuid; v_tr uuid; v_count uuid; v_pret uuid; v_rline uuid;
  v_inv uuid; v_shift uuid;
  v_n int; v_v1 bigint; v_v2 bigint; v_txt text;
BEGIN

INSERT INTO identity.app_user (username, full_name) VALUES ('wp','تست Push')
  RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

SELECT id INTO WEB FROM inventory.warehouse
 WHERE branch_id = BR AND kind = 'store' AND is_active LIMIT 1;
INSERT INTO inventory.warehouse (branch_id, code, name, kind)
VALUES (BR,'WH-WP-BACK','پشتیبان Push','stock') RETURNING id INTO BACK;
INSERT INTO inventory.warehouse (branch_id, code, name, kind)
VALUES (BR,'WH-WP-OTHER','دوم Push','stock') RETURNING id INTO OTHER;

INSERT INTO purchasing.supplier (code, name) VALUES ('S-WP','تأمین‌کننده Push')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-WP','شومیز Push')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','38','WP-38') RETURNING id INTO v_var;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'آبی','40','WP-40') RETURNING id INTO v_var2;

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. خاموش‌بودن یک شکست نیست — و صف را پر نمی‌کند ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- پیش‌فرض `web.push_enabled` خاموش است. یک رسید خرید کامل نباید حتی یک
-- سطر صف بسازد. اگر می‌ساخت، هر نصب تازه‌ای که هنوز افزونه ندارد صفش
-- را از پیام‌هایی پر می‌کرد که همه به نامهٔ مرده می‌رسند.

DELETE FROM platform.outbox_message;

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WEB, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 100, 500000, 50000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

PERFORM pg_temp.assert_eq('خاموش: رسید خرید هیچ پیامی نساخت',
  (SELECT count(*) FROM platform.outbox_message WHERE topic LIKE 'web.%'), 0);
-- کنترل مثبت همین بند: موجودی واقعاً عوض شد، پس «صفر پیام» از
-- «هیچ اتفاقی نیفتاد» نیامده.
PERFORM pg_temp.assert_eq('کنترل مثبت: موجودی واقعاً ۱۰۰ شد',
  (SELECT on_hand FROM inventory.stock_balance
    WHERE variation_id = v_var AND warehouse_id = WEB), 100);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. روشن‌کردن — و انبارِ سایت ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.set_setting('web.push_enabled', 'true'::jsonb, 'تست', v_user);
PERFORM platform.set_setting('web.stock_warehouse',
  to_jsonb((SELECT code FROM inventory.warehouse WHERE id = WEB)), 'تست', v_user);

PERFORM pg_temp.assert_txt('انبار سایت از تنظیمات پیدا شد',
  platform.web_warehouse_id()::text, WEB::text);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. شش مسیر انبار، هر شش پیام می‌سازند ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- نقطهٔ اتصال `apply_movement()` است، پس ادعا این است که **هیچ مسیری
-- جا نمی‌ماند** — نه اینکه شش مسیر یکی‌یکی وصل شده‌اند.

-- ۳-الف) رسید خرید
DELETE FROM platform.outbox_message;
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WEB, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 20, 500000, 10000000) RETURNING id INTO v_rline;
PERFORM purchasing.post_receipt(v_rcpt, v_user);
PERFORM pg_temp.assert_eq('رسید خرید → یک پیام معلق',
  pg_temp.pending('web.stock_push', v_var), 1);
PERFORM pg_temp.assert_txt('و مقدارش **مطلق** است (۱۰۰+۲۰)',
  pg_temp.field('web.stock_push', v_var, 'onHand'), '120');

-- ۳-ب) برگشت از خرید
DELETE FROM platform.outbox_message;
INSERT INTO purchasing.purchase_return (branch_id, warehouse_id, receipt_id, reason_code, occurred_at)
VALUES (BR, WEB, v_rcpt, 'defect', now())
RETURNING id INTO v_pret;
INSERT INTO purchasing.purchase_return_line (return_id, receipt_line_id, qty)
VALUES (v_pret, v_rline, 5);
PERFORM purchasing.post_purchase_return(v_pret, v_user);
PERFORM pg_temp.assert_eq('برگشت از خرید → یک پیام',
  pg_temp.pending('web.stock_push', v_var), 1);
PERFORM pg_temp.assert_txt('و مقدارش ۱۱۵ است',
  pg_temp.field('web.stock_push', v_var, 'onHand'), '115');

-- ۳-پ) انبارگردانی
DELETE FROM platform.outbox_message;
INSERT INTO inventory.stock_count (branch_id, warehouse_id, created_by)
VALUES (BR, WEB, v_user) RETURNING id INTO v_count;
INSERT INTO inventory.stock_count_line (count_id, variation_id, counted_qty)
VALUES (v_count, v_var, 110);
PERFORM inventory.post_stock_count(v_count, v_user);
PERFORM pg_temp.assert_eq('انبارگردانی → یک پیام',
  pg_temp.pending('web.stock_push', v_var), 1);
PERFORM pg_temp.assert_txt('و مقدارش شمارش واقعی است',
  pg_temp.field('web.stock_push', v_var, 'onHand'), '110');

-- ۳-ت) انتقال از انبار سایت → انبار دیگر: **موجودی سایت کم می‌شود**
DELETE FROM platform.outbox_message;
INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by)
VALUES (BR, WEB, BACK, v_user) RETURNING id INTO v_tr;
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty) VALUES (v_tr, v_var, 10);
PERFORM inventory.post_transfer(v_tr, v_user);
PERFORM pg_temp.assert_eq('انتقال از انبار سایت → یک پیام',
  pg_temp.pending('web.stock_push', v_var), 1);
PERFORM pg_temp.assert_txt('و مقدارش ۱۰۰ است — واقعاً از ویترین کم شد',
  pg_temp.field('web.stock_push', v_var, 'onHand'), '100');

-- ۳-ث) انتقال میان **دو انبار غیرسایتی** → هیچ پیامی
--
-- ⚠️ این بند «نبودِ» یک رفتار را ادعا می‌کند و بی آن، هر انتقال داخلیِ
--    انبار پشتی سایت را بی‌دلیل به‌روز می‌کرد.
DELETE FROM platform.outbox_message;
INSERT INTO inventory.transfer (branch_id, from_warehouse_id, to_warehouse_id, created_by)
VALUES (BR, BACK, OTHER, v_user) RETURNING id INTO v_tr;
INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty) VALUES (v_tr, v_var, 4);
PERFORM inventory.post_transfer(v_tr, v_user);
PERFORM pg_temp.assert_eq('انتقال میان دو انبار غیرسایتی → صفر پیام',
  pg_temp.pending('web.stock_push', v_var), 0);
-- کنترل مثبت: حرکت واقعاً افتاد.
SELECT count(*) INTO v_n FROM inventory.stock_movement
 WHERE variation_id = v_var AND warehouse_id = OTHER;
PERFORM pg_temp.assert_eq('کنترل مثبت: حرکت در انبار دوم واقعاً ثبت شد', v_n, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. تجمیع — ۵۰ حرکت، یک سطر معلق ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- Backpressure اینجا **ساختاری** بسته می‌شود: صف حداکثر به اندازهٔ
-- «تعداد تنوع‌های تغییرکرده» رشد می‌کند، نه «تعداد حرکت‌ها».

DELETE FROM platform.outbox_message;
FOR v_n IN 1..50 LOOP
  PERFORM inventory.apply_movement(v_var, WEB, -1, 'sale', 'test', '00000000-0000-7000-8000-00000000fa11'::uuid, v_user);
END LOOP;

PERFORM pg_temp.assert_eq('۵۰ حرکت → یک سطر معلق',
  pg_temp.pending('web.stock_push', v_var), 1);
PERFORM pg_temp.assert_txt('و سطر معلق **آخرین** وضعیت را دارد',
  pg_temp.field('web.stock_push', v_var, 'onHand'), '50');

-- تنوع دوم سطر خودش را می‌گیرد — تجمیع روی (موضوع، تنوع) است نه سراسری.
INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WEB, now())
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var2, 7, 400000, 2800000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);
PERFORM pg_temp.assert_eq('تنوع دوم سطر جدای خودش را دارد',
  (SELECT count(*) FROM platform.outbox_message
    WHERE topic = 'web.stock_push' AND status = 'pending'), 2);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. سطر در حال ارسال بازنویسی نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ سطری که `sending` شده در دست فرستنده است. اگر Payloadش عوض می‌شد،
--    فرستنده عددی را می‌برد که هرگز ندیده بود — و نسخه‌اش هم عوض
--    می‌شد. آن حالت باید پیام **بعدی** بسازد، نه بازنویسی.

UPDATE platform.outbox_message SET status = 'sending'
 WHERE topic = 'web.stock_push' AND payload->>'variationId' = v_var::text;

PERFORM inventory.apply_movement(v_var, WEB, -3, 'sale', 'test', '00000000-0000-7000-8000-00000000fa11'::uuid, v_user);

PERFORM pg_temp.assert_eq('سطر sending دست‌نخورده ماند',
  (SELECT count(*) FROM platform.outbox_message
    WHERE topic = 'web.stock_push' AND status = 'sending'
      AND payload->>'variationId' = v_var::text
      AND payload->>'onHand' = '50'), 1);
PERFORM pg_temp.assert_eq('و یک سطر معلق **تازه** ساخته شد',
  pg_temp.pending('web.stock_push', v_var), 1);
PERFORM pg_temp.assert_txt('با وضعیت تازه',
  pg_temp.field('web.stock_push', v_var, 'onHand'), '47');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۶. نسخه صعودی است و تکرار نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- نگهبان ترتیب سمت افزونه به همین تکیه می‌کند: دو پیام خارج از ترتیب
-- نباید عدد کهنه را بنشانند.

v_v1 := (pg_temp.field('web.stock_push', v_var, 'version'))::bigint;
PERFORM inventory.apply_movement(v_var, WEB, -1, 'sale', 'test', '00000000-0000-7000-8000-00000000fa11'::uuid, v_user);
v_v2 := (pg_temp.field('web.stock_push', v_var, 'version'))::bigint;
PERFORM pg_temp.assert_eq('نسخه پس از حرکت تازه بزرگ‌تر شد',
  CASE WHEN v_v2 > v_v1 THEN 1 ELSE 0 END, 1);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۷. تجدید ارزیابی — تعداد صفر، ولی ارزش عوض می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ ADR-007 می‌گوید تجدید ارزیابی تعداد را عوض نمی‌کند. ولی **حرکت
--    است**، پس از `apply_movement` می‌گذرد و پیام می‌سازد — با همان
--    عددِ قبلی. این بی‌ضرر است (مقدار مطلق) و اینجا صریح ثبت می‌شود تا
--    کسی بعداً آن را یک باگ نخواند: افزونه عددِ بدون تغییر را
--    نمی‌نویسد.
--
-- تجدید ارزیابی با قید `stock_movement` تعداد صفر می‌خواهد، و
-- `apply_movement` تعداد صفر را رد می‌کند — پس مسیرش رسید خرید در روش
-- «آخرین قیمت خرید» است. اینجا فقط ادعای مقدارِ **بدون تغییر** سنجیده
-- می‌شود.

DELETE FROM platform.outbox_message;
PERFORM pg_temp.assert_raises('حرکت با تعداد صفر از دروازه رد می‌شود',
  format('SELECT inventory.apply_movement(%L, %L, 0, ''sale'')', v_var, WEB));
PERFORM pg_temp.assert_eq('و هیچ پیامی هم نساخت',
  pg_temp.pending('web.stock_push', v_var), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۸. قیمت — و اینکه null هرگز صفر نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════

DELETE FROM platform.outbox_message;
PERFORM catalog.set_price(v_var, 1850000, 'regular', 'تست Push');
PERFORM pg_temp.assert_eq('تغییر قیمت → یک پیام قیمت',
  pg_temp.pending('web.price_push', v_var), 1);
PERFORM pg_temp.assert_txt('و پول **رشته** است، نه عدد',
  pg_temp.field('web.price_push', v_var, 'priceRial'), '1850000');
PERFORM pg_temp.assert_txt('نوع میدان در JSON رشته است',
  jsonb_typeof((SELECT payload->'priceRial' FROM platform.outbox_message
                 WHERE topic='web.price_push' AND status='pending'
                   AND payload->>'variationId' = v_var::text)), 'string');

-- همان قیمت دوباره → سطر تازه‌ای در تاریخچه نیست، پس پیامی هم نیست.
DELETE FROM platform.outbox_message;
PERFORM catalog.set_price(v_var, 1850000, 'regular', 'همان قیمت');
PERFORM pg_temp.assert_eq('همان قیمت دوباره → هیچ پیامی',
  pg_temp.pending('web.price_push', v_var), 0);

-- کالایی که هیچ قیمتی ندارد: `priceRial` باید **null** باشد نه صفر.
DELETE FROM platform.outbox_message;
PERFORM catalog.push_web_price(v_var2);
PERFORM pg_temp.assert_txt('کالای بی‌قیمت → priceRial = null، نه صفر',
  pg_temp.field('web.price_push', v_var2, 'priceRial'), NULL);
PERFORM pg_temp.assert_txt('و نوعش در JSON واقعاً null است',
  jsonb_typeof((SELECT payload->'priceRial' FROM platform.outbox_message
                 WHERE topic='web.price_push' AND status='pending'
                   AND payload->>'variationId' = v_var2::text)), 'null');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۹. پیام بی variationId ساخته نمی‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- ایندکس تجمیع روی `payload->>'variationId'` است. سطری بی آن، هم از
-- تجمیع بیرون می‌ماند و هم افزونه نمی‌داند به کدام کالا بخورد.

PERFORM pg_temp.assert_raises('Payload بی variationId رد می‌شود',
  'SELECT platform.enqueue_web_push(''web.stock_push'', ''{"onHand":1}''::jsonb)');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۰. موجودی سایت با خوراک ۱۵ دقیقه‌ای یکی است ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ مهم‌ترین ادعای این پرونده پس از تجمیع. اگر Push و خوراک دو تعریف
--    داشته باشند، تور ایمنیِ تطبیق هر بار یک واگرایی **کاذب** گزارش
--    می‌کند و خیلی زود کسی دیگر نگاهش نمی‌کند.
--
-- فرمول خوراک: `on_hand - reserved` روی همان انبار.

UPDATE inventory.stock_balance SET reserved = 6
 WHERE variation_id = v_var AND warehouse_id = WEB;
DELETE FROM platform.outbox_message;
PERFORM inventory.apply_movement(v_var, WEB, -1, 'sale', 'test', '00000000-0000-7000-8000-00000000fa11'::uuid, v_user);

-- ⚠️ `trim_scale` در هر دو طرف: `platform.qty` مقیاس ۳ دارد و بی آن
--    این ادعا «40 ≠ 40.000» می‌داد — یک قرمزیِ دروغین دربارهٔ قالب، نه
--    دربارهٔ عدد.
SELECT trim_scale(on_hand - reserved)::text INTO v_txt FROM inventory.stock_balance
 WHERE variation_id = v_var AND warehouse_id = WEB;
PERFORM pg_temp.assert_txt('onHand پیام = on_hand − reserved خوراک',
  pg_temp.field('web.stock_push', v_var, 'onHand'), v_txt);

-- و هرگز منفی نمی‌شود: ویترین «۳− عدد» نشان نمی‌دهد.
UPDATE inventory.stock_balance SET reserved = 9999
 WHERE variation_id = v_var AND warehouse_id = WEB;
PERFORM pg_temp.assert_txt('رزرو بیش از موجودی → صفر، نه منفی',
  trim_scale(inventory.web_stock_qty(v_var, WEB))::text, '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۱. تور ایمنی — پیکربندی ناسازگار دیده می‌شود ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ خطرناک‌ترین حالت این قابلیت: Push **روشن** ولی انبار سایت تعیین
--    نشده. آن‌وقت هیچ پیامی ساخته نمی‌شود و همه‌چیز سالم به‌نظر می‌رسد —
--    صف خالی است، نامهٔ مرده‌ای نیست، و سایت هرگز به‌روز نمی‌شود. یعنی
--    دقیقاً همان «خاموشیِ بی‌صدا» که این مخزن جای دیگر هم گرفته.

PERFORM pg_temp.assert_eq('پیکربندی سالم → بی هشدار',
  CASE WHEN (SELECT misconfigured FROM platform.web_push_health) THEN 1 ELSE 0 END, 0);

PERFORM platform.set_setting('web.stock_warehouse', '""'::jsonb, 'تست', v_user);
PERFORM pg_temp.assert_eq('Push روشن ولی انبار تعیین‌نشده → هشدار',
  CASE WHEN (SELECT misconfigured FROM platform.web_push_health) THEN 1 ELSE 0 END, 1);

-- و در همان حالت، هیچ پیامی هم ساخته نمی‌شود — که همان خطر است.
DELETE FROM platform.outbox_message;
PERFORM inventory.apply_movement(v_var, WEB, -1, 'sale', 'test', '00000000-0000-7000-8000-00000000fa11'::uuid, v_user);
PERFORM pg_temp.assert_eq('و واقعاً هیچ پیامی نمی‌سازد',
  pg_temp.pending('web.stock_push', v_var), 0);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱۲. دروازهٔ صف: موضوع بسته، Payload سنجیده، نسخه از دنباله ═══';
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ یافتهٔ FND-R60-04، لایهٔ دوم. مهاجرت ۰۶۰ `EXECUTE` را از `PUBLIC`
--    گرفت، ولی ACL یک مرز دسترسی است و مرز دسترسی روزی اشتباه تنظیم
--    می‌شود. پس خودِ تابع هم به فراخوانش اعتماد نمی‌کند.
--
-- ⚠️ مهم‌ترینش `version` است: افزونه پیام با نسخهٔ کوچک‌تر‌یا‌مساوی را
--    **دور می‌اندازد**، پس یک `version = 999999999` هر Push بعدیِ آن
--    کالا را تا ابد بی‌صدا می‌بست. حالا مقدار ورودی بازنویسی می‌شود.

PERFORM platform.set_setting('web.stock_warehouse', '"WEB"'::jsonb, 'تست', v_user);

-- موضوع بیرون از فهرست — از جمله `health.alert`، که مسیر خودش را دارد
-- (`platform.enqueue_health_alerts` مستقیم درج می‌کند و DEFINER نیست).
PERFORM pg_temp.assert_raises('موضوع health.alert از این صف ساخته نمی‌شود',
  format('SELECT platform.enqueue_web_push(''health.alert'', ''{"variationId":"%s"}''::jsonb)', v_var));
PERFORM pg_temp.assert_raises('موضوع دلخواه رد می‌شود',
  format('SELECT platform.enqueue_web_push(''sms.invoice'', ''{"variationId":"%s"}''::jsonb)', v_var));

-- شناسهٔ تنوع: نه بی‌شکل، نه ناموجود.
PERFORM pg_temp.assert_raises('variationId بی‌شکل رد می‌شود',
  'SELECT platform.enqueue_web_push(''web.stock_push'', ''{"variationId":"نه-یک-uuid","onHand":1}''::jsonb)');
PERFORM pg_temp.assert_raises('تنوع ناموجود رد می‌شود',
  'SELECT platform.enqueue_web_push(''web.stock_push'',
     ''{"variationId":"11111111-1111-1111-1111-111111111111","onHand":1}''::jsonb)');

-- شکل Payload، به‌ازای هر موضوع.
PERFORM pg_temp.assert_raises('Push موجودی بی onHand عددی رد می‌شود',
  format('SELECT platform.enqueue_web_push(''web.stock_push'', ''{"variationId":"%s"}''::jsonb)', v_var));
PERFORM pg_temp.assert_raises('onHand رشته‌ای رد می‌شود',
  format('SELECT platform.enqueue_web_push(''web.stock_push'', ''{"variationId":"%s","onHand":"7"}''::jsonb)', v_var));
PERFORM pg_temp.assert_raises('onHand منفی رد می‌شود',
  format('SELECT platform.enqueue_web_push(''web.stock_push'', ''{"variationId":"%s","onHand":-1}''::jsonb)', v_var));
PERFORM pg_temp.assert_raises('Push قیمت بی کلید priceRial رد می‌شود',
  format('SELECT platform.enqueue_web_push(''web.price_push'', ''{"variationId":"%s"}''::jsonb)', v_var));
-- ⚠️ پول در JSON **رشته** است. عدد رد می‌شود، چون مبالغ ریالی از دقت
--    `number` جاوااسکریپت بیرون می‌زنند و افزونه همان را می‌خواند.
PERFORM pg_temp.assert_raises('priceRial عددی رد می‌شود',
  format('SELECT platform.enqueue_web_push(''web.price_push'', ''{"variationId":"%s","priceRial":1000}''::jsonb)', v_var));
PERFORM pg_temp.assert_raises('priceRial غیررقمی رد می‌شود',
  format('SELECT platform.enqueue_web_push(''web.price_push'', ''{"variationId":"%s","priceRial":"۱۰۰۰ تومان"}''::jsonb)', v_var));

-- ── کنترل مثبت: Payload درست هنوز قبول می‌شود ───────────────────────
-- بی این بند، یک نگهبانِ بیش از حد سخت‌گیر هم «پاس» می‌شد و کل
-- همگام‌سازی سایت را بی‌صدا می‌بست.
DELETE FROM platform.outbox_message;
PERFORM pg_temp.assert_eq('Payload درستِ موجودی قبول می‌شود',
  CASE WHEN platform.enqueue_web_push('web.stock_push',
         jsonb_build_object('variationId', v_var::text, 'onHand', 5)) IS NULL
       THEN 0 ELSE 1 END, 1);
PERFORM pg_temp.assert_eq('priceRial تهی قبول می‌شود (قیمت ندارد ≠ مجانی)',
  CASE WHEN platform.enqueue_web_push('web.price_push',
         jsonb_build_object('variationId', v_var::text, 'priceRial', NULL)) IS NULL
       THEN 0 ELSE 1 END, 1);

-- ── نسخهٔ ورودی بازنویسی می‌شود ─────────────────────────────────────
DELETE FROM platform.outbox_message;
PERFORM platform.enqueue_web_push('web.stock_push',
  jsonb_build_object('variationId', v_var::text, 'onHand', 5, 'version', 999999999));
PERFORM pg_temp.assert_eq('نسخهٔ تحمیلیِ فراخوان بازنویسی شد',
  CASE WHEN pg_temp.field('web.stock_push', v_var, 'version') = '999999999'
       THEN 1 ELSE 0 END, 0);
-- و مقداری که نشست، از دنباله است: از `last_value` بیشتر نیست.
PERFORM pg_temp.assert_eq('نسخهٔ نشسته از دنبالهٔ web_push_version است',
  CASE WHEN pg_temp.field('web.stock_push', v_var, 'version')::bigint
            <= (SELECT last_value FROM platform.web_push_version)
       THEN 1 ELSE 0 END, 1);

RAISE NOTICE E'\n✓ همه ادعاهای Push سایت پاس شدند';
END $test$;

ROLLBACK;
