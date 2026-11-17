-- =====================================================================
-- ۱۱۷ — بازکردن سال مالی بعد، شمارنده‌های سندش، و زنگ «سال بعد تعریف نشده»
-- =====================================================================
-- یافتهٔ ممیزی LM-03 (۲۰۲۶/۱۱/۱۲): Seed فقط سال ۱۴۰۵ را می‌سازد
-- (۲۰۲۶/۰۳/۲۱ تا ۲۰۲۷/۰۳/۲۰) و هیچ مسیری سال بعد را نمی‌ساخت. از اول
-- فروردین ۱۴۰۶ هر `ledger.post_entry` با «سال مالی برای تاریخ … تعریف
-- نشده است» رد می‌شد — یعنی فروش، مرجوعی، رسید خرید و خزانه با هم.
--
-- ⚠️ **یک سطر در `ledger.fiscal_year` کافی نیست.** `post_entry` و ده تابع
--    دیگر از `platform.next_document_no(شعبه، نوع، سال)` شماره می‌گیرند و
--    آن تابع بی سطر شمارندهٔ همان سال خطا می‌دهد. پس «یک INSERT با psql»
--    که راه اضطراری به نظر می‌رسید، خطای اول را با خطای دوم عوض می‌کرد:
--    «شمارنده سند برای (…/journal/1406) تعریف نشده است». این تابع هر دو
--    را در یک تراکنش می‌سازد.
--
-- ── آنچه این مهاجرت **نمی‌کند** ────────────────────────────────────
--   • اختتام سال قبل و سند بستن حساب‌های موقت. آن یک تصمیم حسابداری است
--     و هنوز ساخته نشده (`docs/JOURNAL-GUARDS.md`). سال قبل «باز» می‌ماند
--     تا اسناد معوقش ثبت شوند؛ بستنش مسیر خودش را خواهد داشت.
--   • خودش سال ۱۴۰۶ را نمی‌سازد. بازکردن سال یک عمل آگاهانه با ردّ
--     حسابرسی است، نه اثر جانبی یک مهاجرت.
--
-- ── نگهبان‌ها ──────────────────────────────────────────────────────
--   • شناسهٔ سال دقیقاً سال قبل + ۱ و شروعش دقیقاً فردای پایان سال قبل:
--     `post_entry` سال را با `BETWEEN` پیدا می‌کند و جدول قید عدم‌هم‌پوشانی
--     ندارد؛ شکاف یعنی روزِ بی‌سال و هم‌پوشانی یعنی دو سال برای یک روز.
--   • طول ۳۶۵ یا ۳۶۶ روز. تاریخ را فراخوان می‌دهد (سال شمسی کبیسه دارد و
--     اینجا تقویم جلالی حساب نمی‌شود)، ولی غلط تایپی یک‌ماهه رد می‌شود.
--   • فقط **یک** سال جلوتر: تا آخرین سال تعریف‌شده شروع نشده، سال بعدش
--     باز نمی‌شود. تاریخ سند را بعضی مسیرها از کلاینت می‌گیرند و هر سال
--     بازِ آینده، دامنهٔ تاریخ‌گذاری اشتباه را بزرگ‌تر می‌کند.
--   • قفل مشورتی پیش از هر خواندن — همان دلیل `post_opening_balance`.
--
-- ── پیشوند شمارنده ─────────────────────────────────────────────────
-- شمارنده‌های سال قبل برای هر (شعبه، نوع سند) کپی می‌شوند و شماره از صفر
-- شروع می‌شود. پیشوند باید عوض شود، وگرنه `J-1405-000001` دوباره ساخته
-- می‌شد و قیدهای یکتای شماره (مثلاً `transaction_branch_id_number_key`)
-- می‌شکستند: شمارهٔ سال قبل در پیشوند با سال تازه جایگزین می‌شود، و اگر
-- پیشوندی سال را نداشت، سال تازه به انتهایش افزوده می‌شود.
--
-- ── زنگ ────────────────────────────────────────────────────────────
-- `fiscal_year_ending` از ۶۰ روز مانده به آخرین روز تعریف‌شده روشن
-- می‌شود (warn) و اگر امروز اصلاً سال نداشته باشد critical است. منطقش در
-- `ledger.fiscal_year_runway(تاریخ)` است تا آزمون با تاریخ صریح بسنجدش،
-- نه با ساعت دیواری.
-- =====================================================================

BEGIN;

-- ── ۱. بازکردن سال بعد ──────────────────────────────────────────────
CREATE FUNCTION ledger.open_fiscal_year(p_year smallint, p_starts_on date, p_ends_on date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_last     ledger.fiscal_year%ROWTYPE;
  v_days     int;
  v_counters int;
BEGIN
  IF platform.current_actor() IS NULL THEN
    RAISE EXCEPTION 'بازکردن سال مالی بدون کاربر عامل مجاز نیست. platform.set_actor() فراخوانی نشده است.';
  END IF;
  IF p_year IS NULL OR p_starts_on IS NULL OR p_ends_on IS NULL THEN
    RAISE EXCEPTION 'شماره سال، تاریخ شروع و تاریخ پایان هر سه لازم‌اند.';
  END IF;

  -- قفل پیش از هر خواندن: دو فراخوان هم‌زمان نباید هر دو «سال آخر» را
  -- یکسان ببینند.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger.open_fiscal_year', 0));

  SELECT * INTO v_last FROM ledger.fiscal_year ORDER BY ends_on DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'هیچ سال مالی‌ای تعریف نشده است؛ سال اول را داده مرجع نصب می‌سازد.';
  END IF;

  IF p_year <> v_last.id + 1 THEN
    RAISE EXCEPTION 'سال مالی بعدی باید % باشد، نه %.', v_last.id + 1, p_year;
  END IF;
  IF p_starts_on <> v_last.ends_on + 1 THEN
    RAISE EXCEPTION 'سال % باید از % شروع شود (فردای پایان سال %)، نه از %.',
      p_year, v_last.ends_on + 1, v_last.id, p_starts_on;
  END IF;
  v_days := p_ends_on - p_starts_on + 1;
  IF v_days NOT IN (365, 366) THEN
    RAISE EXCEPTION 'طول سال مالی باید ۳۶۵ یا ۳۶۶ روز باشد؛ از % تا % می‌شود % روز.',
      p_starts_on, p_ends_on, v_days;
  END IF;
  IF platform.business_date() < v_last.starts_on THEN
    RAISE EXCEPTION 'سال % هنوز شروع نشده است؛ پیش از آن سال % باز نمی‌شود.', v_last.id, p_year;
  END IF;

  INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status)
  VALUES (p_year, p_starts_on, p_ends_on, 'open');

  INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
  SELECT c.branch_id, c.doc_type, p_year,
         CASE WHEN position(v_last.id::text IN c.prefix) > 0
              THEN replace(c.prefix, v_last.id::text, p_year::text)
              ELSE c.prefix || p_year::text || '-' END
    FROM platform.document_counter c
   WHERE c.fiscal_year = v_last.id
  ON CONFLICT (branch_id, doc_type, fiscal_year) DO NOTHING;
  GET DIAGNOSTICS v_counters = ROW_COUNT;

  PERFORM platform.audit('ledger.fiscal_year.open', 'fiscal_year', p_year::text,
    jsonb_build_object('starts_on', p_starts_on, 'ends_on', p_ends_on,
                       'previous_year', v_last.id, 'counters', v_counters));
END $$;

COMMENT ON FUNCTION ledger.open_fiscal_year(smallint, date, date) IS
  'سال مالی بعد و شمارنده‌های سندش را می‌سازد. اختتام سال قبل را انجام نمی‌دهد.';

-- ── ۲. چند روز تا پایان آخرین سال تعریف‌شده مانده ───────────────────
CREATE FUNCTION ledger.fiscal_year_runway(p_today date, p_lead_days int DEFAULT 60)
RETURNS TABLE (n bigint, severity text, detail text)
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN y.last_end IS NULL OR y.last_end - p_today < p_lead_days THEN 1 ELSE 0 END::bigint,
         CASE WHEN y.today_covered THEN 'warn' ELSE 'critical' END,
         coalesce('آخرین روز تعریف‌شده: ' || y.last_end::text, 'هیچ سال مالی‌ای تعریف نشده')
    FROM (SELECT max(ends_on) AS last_end,
                 coalesce(bool_or(p_today BETWEEN starts_on AND ends_on), false) AS today_covered
            FROM ledger.fiscal_year) y
$$;

-- ── ۳. زنگ نهم ─────────────────────────────────────────────────────
-- بدنهٔ هشت زنگ قبلی دست‌نخورده از مهاجرت ۰۵۵ آمده است؛ فقط بند آخر تازه است.
CREATE OR REPLACE FUNCTION platform.health_alerts()
RETURNS TABLE (code text, severity text, title text, n bigint, detail text)
LANGUAGE sql
STABLE
AS $$
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

  UNION ALL
  -- سال مالی بعد تعریف نشده: روز بعد از آخرین روز، هیچ سندی ثبت نمی‌شود.
  SELECT 'fiscal_year_ending', r.severity, 'سال مالی بعد تعریف نشده است', r.n, r.detail
    FROM ledger.fiscal_year_runway(platform.business_date()) r
$$;

-- ── ۴. گزینهٔ زنگ تازه در تنظیم اعلان ───────────────────────────────
-- فقط **گزینه** افزوده می‌شود؛ انتخاب فعلی مالک دست نمی‌خورد (همان الگوی ۰۷۱).
-- روی نصب تازه این سطر هنوز نیست و Seed خودش گزینه را دارد.
UPDATE platform.setting
   SET options = coalesce(options, '[]'::jsonb)
       || '[{"value":"fiscal_year_ending","label":"سال مالی بعد تعریف نشده"}]'::jsonb
 WHERE key = 'notify.health_alert_codes'
   AND NOT coalesce(options, '[]'::jsonb) @> '[{"value":"fiscal_year_ending"}]'::jsonb;

COMMIT;
