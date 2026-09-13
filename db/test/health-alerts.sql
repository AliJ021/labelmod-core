-- =====================================================================
-- تست زنگ خطر سیستم — `platform.health_alerts()` و تولید هشدار
-- =====================================================================
-- بند ۲ مهم‌ترین بند این پرونده است و تنها دلیل نوشتنش:
--
--   «درآمد ثبت‌نشده» در طول روز **درست است**. دوره ثبت امروز باز
--   می‌ماند و کار شبانه دیروز را می‌بندد. زنگی که این را نفهمد، هر روز
--   ظهر به صدا درمی‌آید، مالک بی‌اعتنا می‌شود، و روزی که واقعاً چیزی
--   گیر می‌کند همان پیام را نادیده می‌گیرد.
--
--   پس این بند **هر دو جهت** را می‌سنجد: فاکتور دو روز پیش باید دیده
--   شود و فاکتور امروز نباید. یک ادعای یک‌طرفه (فقط «دیده می‌شود») با
--   یک تابعی که همه را می‌شمارد هم سبز می‌ماند.
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

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_cust uuid;
  v_rcpt uuid; v_inv uuid; v_today date; v_n int; v_codes text[];
BEGIN

INSERT INTO identity.app_user (username, full_name)
VALUES ('health','تست زنگ خطر') RETURNING id INTO v_user;
INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (v_user,'admin',BR);
PERFORM platform.set_actor(v_user);

v_today := platform.business_date();

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۱. هشت زنگ، هر کدام با شدت معلوم ═══';
-- ═══════════════════════════════════════════════════════════════════

SELECT array_agg(code ORDER BY code) INTO v_codes FROM platform.health_alerts();
PERFORM pg_temp.assert_eq('شمار زنگ‌ها', array_length(v_codes,1)::text, '8');

SELECT count(*) INTO v_n FROM platform.health_alerts()
 WHERE severity NOT IN ('critical','warn') OR title = '' OR title IS NULL;
PERFORM pg_temp.assert_eq('زنگ بی‌شدت یا بی‌عنوان', v_n::text, '0');

-- ضد‌پوچی: روی دیتابیس تازه، «تمرین بازیابی» باید **روشن** باشد چون
-- هیچ تمرینی انجام نشده. اگر همهٔ زنگ‌ها همیشه صفر برمی‌گشتند، این
-- پرونده بی‌معنا سبز می‌شد.
PERFORM pg_temp.assert_eq('زنگ تمرین بازیابی روی دیتابیس تازه',
  (SELECT n::text FROM platform.health_alerts() WHERE code='restore_drill'), '1');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۲. درآمد ثبت‌نشده: دیروز آری، امروز نه ═══';
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO purchasing.supplier (code, name) VALUES ('S-HLT','تأمین‌کننده')
  RETURNING id INTO v_sup;
INSERT INTO catalog.product (code, name_internal) VALUES ('P-HLT','پیراهن')
  RETURNING id INTO v_prod;
INSERT INTO catalog.variation (product_id, color, size, sku)
  VALUES (v_prod,'سفید','M','HLT-M') RETURNING id INTO v_var;
INSERT INTO catalog.price (variation_id, price_list, amount)
  VALUES (v_var, 'default', 1000000);
INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
  VALUES ('09121119999','مشتری زنگ', 0) RETURNING id INTO v_cust;

INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
VALUES (platform.next_document_no(BR,'purchase',1405::smallint), BR, v_sup, WH, '2026-06-01')
RETURNING id INTO v_rcpt;
INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
VALUES (v_rcpt, v_var, 50, 400000, 20000000);
PERFORM purchasing.post_receipt(v_rcpt, v_user);

PERFORM pg_temp.assert_eq('درآمد ثبت‌نشده، پیش از هر فروشی',
  (SELECT n::text FROM platform.health_alerts() WHERE code='unposted_revenue'), '0');

-- فروش **امروز**: درآمدش هنوز به دفتر نرفته و این **درست** است.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', v_today::timestamptz + interval '14 hours', v_user)
RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 2, 1000000, 2000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

PERFORM pg_temp.assert_eq('در `sales.unposted_revenue` دیده می‌شود',
  (SELECT count(*)::text FROM sales.unposted_revenue), '1');
PERFORM pg_temp.assert_eq('ولی زنگ **خاموش** است، چون امروز است',
  (SELECT n::text FROM platform.health_alerts() WHERE code='unposted_revenue'), '0');

-- فروش **دو روز پیش** که کار شبانه بسته‌اش نکرده: این یک مشکل است.
INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, customer_id, channel,
                           occurred_at, created_by)
VALUES (BR, WH, NULL, v_cust, 'web', (v_today - 2)::timestamptz + interval '14 hours', v_user)
RETURNING id INTO v_inv;
INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
VALUES (v_inv, 1, v_var, 3, 1000000, 3000000);
PERFORM sales.finalize_invoice(v_inv, v_user);

PERFORM pg_temp.assert_eq('و حالا زنگ روشن می‌شود',
  (SELECT n::text FROM platform.health_alerts() WHERE code='unposted_revenue'), '1');
PERFORM pg_temp.assert_eq('و جزئیاتش تاریخ قدیمی‌ترین را می‌گوید',
  (SELECT detail FROM platform.health_alerts() WHERE code='unposted_revenue'),
  'قدیمی‌ترین: ' || (v_today - 2)::text);

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۳. کلید خاموش یعنی هیچ پیامی ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM pg_temp.assert_eq('پیش‌فرض تنظیم هشدار خاموش است',
  (SELECT value::text FROM platform.setting WHERE key='notify.health_alerts'), 'false');
PERFORM pg_temp.assert_eq('پیام ساخته‌شده با کلید خاموش',
  platform.enqueue_health_alerts()::text, '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۴. روشن: یک پیام به‌ازای هر زنگِ فعالِ انتخاب‌شده ═══';
-- ═══════════════════════════════════════════════════════════════════

PERFORM platform.set_setting('notify.health_alerts', 'true'::jsonb, 'تست');
-- فقط یکی از دو زنگِ فعال انتخاب می‌شود، تا فیلتر هم سنجیده شود:
-- `unposted_revenue` آری، `restore_drill` نه.
PERFORM platform.set_setting('notify.health_alert_codes',
  '["unposted_revenue"]'::jsonb, 'تست فیلتر');

PERFORM pg_temp.assert_eq('پیام‌های ساخته‌شده',
  platform.enqueue_health_alerts()::text, '1');
PERFORM pg_temp.assert_eq('و همان یکی، برای زنگ انتخاب‌شده',
  (SELECT payload->>'code' FROM platform.outbox_message
    WHERE topic='health.alert'), 'unposted_revenue');
PERFORM pg_temp.assert_eq('زنگِ انتخاب‌نشده پیامی نساخت',
  (SELECT count(*)::text FROM platform.outbox_message
    WHERE topic='health.alert' AND payload->>'code'='restore_drill'), '0');

-- ═══════════════════════════════════════════════════════════════════
RAISE NOTICE E'\n═══ ۵. و دو بار در روز پیام دوم نمی‌سازد ═══';
-- ═══════════════════════════════════════════════════════════════════
-- حلقهٔ Worker ساعتی است. بی این، مالک تا شب هشت پیام یکسان می‌گرفت و
-- بعد همه‌شان را نادیده می‌گرفت.

PERFORM pg_temp.assert_eq('اجرای دوباره در همان روز',
  platform.enqueue_health_alerts()::text, '0');
PERFORM pg_temp.assert_eq('روز کاری بعد پیام تازه می‌سازد',
  platform.enqueue_health_alerts(v_today + 1)::text, '1');

RAISE NOTICE E'\n✔ زنگ خطر سیستم — هشت زنگ، تفکیک امروز از دیروز، فیلتر، و Idempotency';
END $test$;

ROLLBACK;
