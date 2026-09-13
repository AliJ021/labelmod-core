-- =====================================================================
-- ۰۵۵ — هشدار بیرونی: زنگ خطری که کسی نبیندش، زنگ نیست
-- =====================================================================
-- سیستم هشت زنگ خطر دارد و همه‌شان کار می‌کنند. مشکل جای دیگری بود:
-- **همه‌شان فقط وقتی دیده می‌شوند که کسی دستی `ops/deploy.sh status` را
-- بزند.** یعنی درآمدی که به دفتر نرفته، تا روزی که یک آدم یادش بیفتد
-- فرمانی را اجرا کند، ندیده می‌ماند.
--
-- همان اشتباهی که `backup.restore_drill_days` داشت: تنظیمی که وجود
-- داشت و هیچ‌جا خوانده نمی‌شد. سند وعدهٔ هشدار می‌داد و کد هشداری
-- نمی‌ساخت.
--
-- ── چرا یک تابع و نه هشت کوئری در کد ───────────────────────────────
--
-- سه مصرف‌کننده دارد: صفحهٔ «سلامت سیستم»، تولیدکنندهٔ هشدار، و
-- `ops/deploy.sh status`. هشت کوئری در سه جا یعنی هر بار که زنگ تازه‌ای
-- اضافه شود، دو جا عقب می‌مانند — و عقب‌ماندنشان **بی‌صدا**ست، چون
-- نبودِ یک هشدار شبیه «همه‌چیز خوب است» به نظر می‌رسد.
--
-- ⚠️ **«درآمد ثبت‌نشده» در طول روز درست است و هشدار نیست.** دوره ثبت
--    امروز باز می‌ماند و کار شبانه دیروز را می‌بندد. پس این زنگ فقط
--    دوره‌های **روزهای گذشته** را می‌شمارد. بی این تفکیک، هشدار هر روز
--    ظهر می‌رفت، مالک بی‌اعتنا می‌شد، و روزی که واقعاً چیزی گیر می‌کرد
--    همان پیام را نادیده می‌گرفت.
--
-- ⚠️ و **کد هر زنگ داده است، نه متن**: `notify.health_alert_codes`
--    همین کدها را انتخاب می‌کند. یک تست ادعا می‌کند فهرست گزینه‌های آن
--    تنظیم **دقیقاً** برابر کدهای این تابع است، وگرنه زنگ تازه‌ای
--    اضافه می‌شد که هیچ‌کس نمی‌توانست خاموش یا روشنش کند.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION platform.health_alerts()
RETURNS TABLE (
  code     text,
  severity text,
  title    text,
  n        bigint,
  detail   text
) LANGUAGE sql STABLE AS $$
  -- درآمدی که به دفتر نرفته — فقط روزهای گذشته.
  SELECT 'unposted_revenue', 'critical', 'درآمد ثبت‌نشده در دفتر',
         count(*)::bigint,
         'قدیمی‌ترین: ' || coalesce(min(business_date)::text, '—')
    FROM sales.unposted_revenue
   WHERE business_date < platform.business_date()

  UNION ALL
  -- پیامی که هرگز نرفت.
  SELECT 'outbox_dead', 'warn', 'پیام‌های نرفته',
         count(*)::bigint,
         coalesce(string_agg(DISTINCT topic, '، '), '—')
    FROM platform.outbox_dead

  UNION ALL
  -- مانده انبار با جمع حرکت‌ها نمی‌خواند.
  SELECT 'stock_mismatch', 'critical', 'مغایرت مانده انبار با حرکت‌ها',
         count(*)::bigint, '—'
    FROM inventory.balance_check
   WHERE qty_diff <> 0 OR value_diff <> 0

  UNION ALL
  -- حساب موجودی کالا در دفتر با ارزش واقعی انبار نمی‌خواند.
  SELECT 'ledger_divergence', 'critical', 'واگرایی دفتر با ارزش انبار',
         count(*)::bigint,
         coalesce(max(to_char(diff, 'FM999999999999999')), '—')
    FROM inventory.ledger_check
   WHERE diff <> 0

  UNION ALL
  -- سطر سندی که به شخص ناموجود اشاره می‌کند.
  SELECT 'party_orphan', 'critical', 'سطر سند با شخص ناموجود',
         count(*)::bigint,
         coalesce(string_agg(DISTINCT problem, '، '), '—')
    FROM ledger.party_check

  UNION ALL
  -- دست‌کاری یا گسست در زنجیره حسابرسی.
  SELECT 'audit_tamper', 'critical', 'دست‌کاری در دفتر حسابرسی',
         count(*)::bigint,
         coalesce(string_agg(DISTINCT problem, '، '), '—')
    FROM platform.audit_check

  UNION ALL
  -- تمرین بازیابی عقب افتاده. اینجا «تعداد» معنا ندارد، پس ۰ یا ۱.
  SELECT 'restore_drill', 'warn', 'تمرین بازیابی بکاپ',
         (SELECT count(*)::bigint FROM platform.restore_drill_status
           WHERE status IN ('never','overdue')),
         (SELECT coalesce(status, '—') FROM platform.restore_drill_status)

  UNION ALL
  -- چک سررسیدشده یا نزدیک.
  SELECT 'cheque_due', 'warn', 'چک سررسیدشده یا نزدیک',
         count(*)::bigint,
         coalesce(min(due_on)::text, '—')
    FROM treasury.cheque_due
   WHERE urgency <> 'future'
$$;

COMMENT ON FUNCTION platform.health_alerts IS
  'هشت زنگ خطر سیستم در یک جا. سه مصرف‌کننده: صفحه سلامت، تولیدکننده هشدار، و deploy.sh status. «درآمد ثبت‌نشده» فقط روزهای گذشته را می‌شمارد — امروز باز بودنش درست است.';

-- ---------------------------------------------------------------------
-- تولیدکنندهٔ پیام
-- ---------------------------------------------------------------------
-- ⚠️ Idempotency مثل هشدار چک در **payload** حل شده، نه در Worker:
--    کلید `(code, business_date)`. بی این، حلقهٔ ساعتی Worker هر ساعت
--    یک پیامک تازه می‌ساخت و مالک تا شب هشت پیام یکسان می‌گرفت — و
--    بعد همه‌شان را نادیده می‌گرفت. هشداری که نادیده گرفته شود، بدتر
--    از هشدار نداشتن است.

CREATE OR REPLACE FUNCTION platform.enqueue_health_alerts(
  p_today date DEFAULT platform.business_date()
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_codes jsonb;
BEGIN
  -- کلید اصلی خاموش → هیچ پیامی ساخته نمی‌شود. ساختن و بعد بستنشان با
  -- «خاموش است» هم کار می‌کرد، ولی صف را بی‌دلیل پر می‌کرد.
  IF NOT coalesce((SELECT value FROM platform.setting
                    WHERE key = 'notify.health_alerts')::text::boolean, false) THEN
    RETURN 0;
  END IF;

  SELECT coalesce(value, '[]'::jsonb) INTO v_codes
    FROM platform.setting WHERE key = 'notify.health_alert_codes';

  WITH live AS (
    SELECT a.* FROM platform.health_alerts() a
     WHERE a.n > 0
       AND v_codes ? a.code
  ), fresh AS (
    SELECT live.* FROM live
     WHERE NOT EXISTS (
       SELECT 1 FROM platform.outbox_message m
        WHERE m.topic = 'health.alert'
          AND m.payload->>'code' = live.code
          AND m.payload->>'business_date' = p_today::text
     )
  ), ins AS (
    INSERT INTO platform.outbox_message (topic, payload)
    SELECT 'health.alert',
           jsonb_build_object(
             'code',          f.code,
             'business_date', p_today,
             'severity',      f.severity,
             'title',         f.title,
             'count',         f.n,
             'detail',        f.detail)
      FROM fresh f
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END $$;

COMMENT ON FUNCTION platform.enqueue_health_alerts IS
  'یک پیام هشدار به‌ازای هر زنگِ روشن، حداکثر یک بار در هر روز کاری. کلید یکتایی (کد زنگ، روز کاری) در payload است. کلید خاموش یعنی هیچ پیامی.';

COMMIT;
