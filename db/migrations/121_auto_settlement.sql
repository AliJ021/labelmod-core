-- =====================================================================
-- ۱۲۱ — تسویهٔ خودکار شبانهٔ کارت‌خوان و درگاه با کارمزد قراردادی
-- =====================================================================
-- یافتهٔ ممیزی LM-02، تصمیم مالک ۲۰۲۶/۱۱/۱۵. حسابدار به صورت‌حساب بانک
-- دسترسی ندارد، پس تسویه با «مبلغ اعلامی بانک» به کار نمی‌آید. به‌جایش هر
-- شب سیستم فروش کارتی و درگاهی روزهای گذشته را با کارمزد قراردادی همان
-- پایانه (`fee_percent`، صفحهٔ «پایانه‌ها») از حساب واسط به بانک می‌برد.
--
-- تا امروز `treasury.post_settlement` فقط در آزمون صدا زده می‌شد: پرداخت
-- کارتی صندوق بی `account_id` ثبت می‌شد و فروش کارتی برای همیشه در حساب
-- واسط (۱۱۰۳/۱۱۰۴) می‌ماند؛ بانک در دفتر کمتر از واقع و کارمزد ثبت‌نشده.
--
-- ── چهار تکه ───────────────────────────────────────────────────────
-- ۱. `treasury.payment_terminal(شعبه، روش)`: تنها پایانهٔ فعال شعبه که حساب
--    دفترش همان حساب واسط قاعدهٔ فروش آن روش است. صفر یا بیش از یکی = NULL؛
--    حدس زده نمی‌شود و زنگ تازه آن را نشان می‌دهد.
-- ۲. Trigger روی `treasury.payment` که `account_id` تهیِ پرداخت کارتی و
--    درگاهی (دریافت و بازپرداخت) را از همان تابع پر می‌کند — از هر مسیری:
--    صندوق، سفارش سایت، مرجوعی. مقدار صریح (اسنپ‌پی، دیجی‌پی) دست نمی‌خورد.
-- ۳. `treasury.post_settlement` حالا بازپرداخت همان پایانه را از جمع کم
--    می‌کند؛ جمع خالص صفر یا منفی رد می‌شود و به دورهٔ بعد می‌ماند.
-- ۴. `treasury.auto_settle_due(کاربر، امروز)`: برای هر پایانهٔ فعال با بانک
--    تسویه، همهٔ پرداخت‌های تسویه‌نشدهٔ روزهای کامل‌شده‌ای که موعد واریزشان
--    رسیده (روز + `settlement_days` ≤ امروز) را در **یک** برگ تسویه می‌زند.
--    تاریخ سند = روز واریز آخرین روز. اجرای جاافتاده شب بعد جبران می‌شود.
--    هر پایانه در زیرتراکنش خودش؛ شکست یکی بقیه را نمی‌شکند و دلیلش برمی‌گردد.
--
-- ⚠️ **کم‌واریزی پذیرنده کشف نمی‌شود.** این تسویه فرض می‌کند پذیرنده طبق
--    قرارداد واریز کرده است. مقایسه با واریز واقعی بانک نیست.
-- ⚠️ کارمزد روی جمع **خالص** (دریافت منهای برگشت) حساب می‌شود.
-- ⚠️ کارمزد صفر (پیش‌فرض Seed) یعنی هیچ هزینه‌ای ثبت نمی‌شود؛ صفحهٔ
--    تنظیمات از قبل برای کارمزد صفر هشدار می‌دهد.
-- ⚠️ پایانهٔ مشترک میان شعبه‌ها (`branch_id` تهی) خودکار تسویه نمی‌شود: برگ
--    تسویه شعبه می‌خواهد و تقسیم حدس زده نمی‌شود.
--
-- ⚠️ **پیش‌فرض خاموش** (بازبینی مستقل ۲۰۲۶/۱۱/۱۷). روشن‌کردنش تصمیم مالک است و فقط
--    پس از واردکردن کارمزد و دورهٔ تسویهٔ قرارداد در «پایانه‌ها»: اولین اجرا همهٔ
--    پرداخت‌های موفقِ تسویه‌نشدهٔ گذشته را هم با کارمزد **همان لحظه** تسویه می‌کند و
--    برگ تسویه قطعی است. اگر حسابدار پیش‌تر انتقال دستی از حساب واسط به بانک زده،
--    پیش از روشن‌کردن هماهنگ شود؛ وگرنه آن مبلغ دو بار به بانک می‌رود.
-- ⚠️ حساب واسط اسنپ‌پی و دیجی‌پی (`payment.*_account_id`) پایانهٔ درگاه سایت شمرده
--    نمی‌شود؛ وگرنه با پیکربندی آن‌ها درگاه سایت «چند پایانه» می‌شد و هرگز پر نمی‌شد.
-- ⚠️ پرکردن پایانهٔ گذشته فقط پرداخت **موفق** را می‌گیرد؛ در انتظار و نامعلوم دست
--    نمی‌خورند (و Trigger قیدهای فاکتورشان را بی‌دلیل دوباره نمی‌سنجد).
--
-- کلید: `treasury.auto_settlement` (پیش‌فرض خاموش). زنگ: `unsettled_terminal`.
-- آزمون: `db/test/auto-settle.sql`.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

INSERT INTO platform.setting(key, value, description, requires_approval, kind, label, group_key,
                             help, sort_order, permission, is_editable)
VALUES ('treasury.auto_settlement', 'false'::jsonb,
  'تسویهٔ خودکار شبانهٔ کارت‌خوان و درگاه با کارمزد قراردادی.', false,
  'bool', 'تسویهٔ خودکار کارت‌خوان و درگاه', 'treasury',
  'هر شب فروش کارتی و درگاهی روزهایی که موعد واریزشان رسیده، با کارمزد قراردادی همان پایانه (صفحهٔ «پایانه‌ها») از حساب «وجوه در راه» به بانک منتقل می‌شود. فرض می‌کند پذیرنده طبق قرارداد واریز کرده؛ کم‌واریزی را کشف نمی‌کند. خاموش‌کردنش یعنی فروش کارتی در حساب واسط می‌ماند و زنگ «تسویه‌نشده» می‌خورد. پیش از روشن‌کردن کارمزد قرارداد را در «پایانه‌ها» وارد کنید؛ اولین اجرا فروش کارتی تسویه‌نشدهٔ گذشته را هم تسویه می‌کند. اگر حسابدار انتقال دستی از حساب واسط به بانک زده، پیش از روشن‌کردن هماهنگ کنید.',
  30, 'settings.security', true)
ON CONFLICT (key) DO NOTHING;

-- ── ۱. پایانهٔ یک پرداخت ────────────────────────────────────────────
CREATE FUNCTION treasury.payment_terminal(p_branch uuid, p_method text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(a.id::text)::uuid END
    FROM treasury.payment_method m
    JOIN ledger.posting_rule pr
      ON pr.event_type = 'sale_shift' AND pr.side = 'debit' AND pr.is_active
     AND pr.leg = CASE m.kind WHEN 'card_reader' THEN 'card_clearing' WHEN 'gateway' THEN 'gateway_clearing' END
    JOIN treasury.account a
      ON a.is_active
     AND a.kind = CASE m.kind WHEN 'card_reader' THEN 'card_terminal' WHEN 'gateway' THEN 'gateway' END
     AND a.ledger_account_code = pr.account_code
     AND (a.branch_id = p_branch OR a.branch_id IS NULL)
     AND a.id::text NOT IN (coalesce(platform.setting_text('payment.snappay_account_id', ''), ''),
                            coalesce(platform.setting_text('payment.digipay_account_id', ''), ''))
   WHERE m.code = p_method
$$;

COMMENT ON FUNCTION treasury.payment_terminal(uuid, text) IS
  'تنها پایانهٔ فعال شعبه برای روش کارت‌خوان/درگاه؛ صفر یا چند پایانه = NULL';

-- ── ۲. پرکردن پایانه هنگام ثبت پرداخت ───────────────────────────────
CREATE FUNCTION treasury.payment_fill_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_branch uuid;
BEGIN
  IF NEW.account_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM treasury.payment_method m
                  WHERE m.code = NEW.method_code AND m.kind IN ('card_reader','gateway')) THEN
    RETURN NEW;
  END IF;
  SELECT coalesce((SELECT branch_id FROM sales.invoice WHERE id = NEW.invoice_id),
                  (SELECT branch_id FROM sales.sale_return WHERE id = NEW.return_id))
    INTO v_branch;
  NEW.account_id := treasury.payment_terminal(v_branch, NEW.method_code);
  RETURN NEW;
END $$;

-- ⚠️ روی تغییر وضعیت هم: پرداخت کارتیِ در انتظار یا نامعلومِ پیش از این مهاجرت در
--    پرکردن گذشته نیست؛ وقتی بعداً موفق شود، همین‌جا پایانه می‌گیرد. بی این، تا ابد
--    بی‌پایانه می‌ماند و زنگ «تسویه‌نشده» راهی برای خاموش‌شدن نداشت.
CREATE TRIGGER payment_fill_terminal
  BEFORE INSERT OR UPDATE OF status ON treasury.payment
  FOR EACH ROW EXECUTE FUNCTION treasury.payment_fill_terminal();

-- پرداخت‌های موفقِ تسویه‌نشدهٔ موجود هم پایانه می‌گیرند؛ تسویه‌شده، در انتظار و
-- نامعلوم دست نمی‌خورند.
UPDATE treasury.payment p
   SET account_id = treasury.payment_terminal(
         coalesce((SELECT branch_id FROM sales.invoice WHERE id = p.invoice_id),
                  (SELECT branch_id FROM sales.sale_return WHERE id = p.return_id)),
         p.method_code)
  FROM treasury.payment_method m
 WHERE m.code = p.method_code AND m.kind IN ('card_reader','gateway')
   AND p.status = 'succeeded' AND p.account_id IS NULL AND p.settlement_id IS NULL;

-- ── ۳. تسویه با کسر بازپرداخت همان پایانه ──────────────────────────
CREATE OR REPLACE FUNCTION treasury.post_settlement(p_settlement uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  s        treasury.settlement%ROWTYPE;
  src      treasury.account%ROWTYPE;
  bank     treasury.account%ROWTYPE;
  v_gross  platform.money := 0;
  v_in     platform.money := 0;
  v_out    platform.money := 0;
  v_fee    platform.money := 0;
  v_net    platform.money := 0;
  v_count  int := 0;
  v_entry  uuid;
  v_fy     smallint;
  v_no     text;
  v_payments uuid[];
BEGIN
  SELECT * INTO s FROM treasury.settlement WHERE id = p_settlement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ تسویه یافت نشد'; END IF;
  IF s.status = 'posted'    THEN RETURN s.entry_id; END IF;      -- Idempotent
  IF s.status = 'cancelled' THEN RAISE EXCEPTION 'برگ تسویه باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT * INTO src  FROM treasury.account WHERE id = s.source_account_id FOR UPDATE;
  SELECT * INTO bank FROM treasury.account WHERE id = s.bank_account_id;

  IF src.kind NOT IN ('card_terminal','gateway') THEN
    RAISE EXCEPTION 'تسویه فقط از کارت‌خوان یا درگاه انجام می‌شود (حساب %: %)', src.code, src.kind;
  END IF;
  IF bank.kind <> 'bank' THEN
    RAISE EXCEPTION 'مقصد تسویه باید حساب بانکی باشد (حساب %: %)', bank.code, bank.kind;
  END IF;

  SELECT array_agg(id) INTO v_payments FROM (SELECT id FROM treasury.payment
    WHERE account_id=s.source_account_id AND direction IN ('in','out') AND status='succeeded'
      AND settlement_id IS NULL AND platform.business_date(occurred_at) BETWEEN s.period_from AND s.period_to
    ORDER BY id FOR UPDATE) locked;
  -- فقط همان پرداخت‌های قفل‌شده؛ ورود پرداخت تازه میان جمع و UPDATE وارد این سند نمی‌شود.
  -- فقط پرداخت‌های موفقِ تسویه‌نشده‌ی همان دستگاه در همان بازه
  -- مهاجرت ۱۲۱: بازپرداخت کارتی/درگاهی همان پایانه (direction = 'out') از
  -- جمع کم می‌شود. پذیرنده برگشت را از واریز همان دوره کم می‌کند و سند مرجوعی
  -- همان حساب واسط را بستانکار کرده است؛ بی این، بازپرداخت هرگز تسویه نمی‌شد
  -- و حساب واسط کارت‌خوان برای همیشه منفی می‌ماند.
  SELECT coalesce(sum(amount) FILTER (WHERE direction = 'in'), 0),
         coalesce(sum(amount) FILTER (WHERE direction = 'out'), 0),
         count(*)
    INTO v_in, v_out, v_count
    FROM treasury.payment
   WHERE id = ANY(v_payments) AND account_id = s.source_account_id
     AND direction IN ('in','out')
     AND status = 'succeeded'
     AND settlement_id IS NULL
     AND platform.business_date(occurred_at) BETWEEN s.period_from AND s.period_to;
  v_gross := v_in - v_out;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'هیچ پرداخت تسویه‌نشده‌ای برای % در بازه % تا % یافت نشد',
      src.code, s.period_from, s.period_to;
  END IF;
  IF v_gross <= 0 THEN
    RAISE EXCEPTION 'جمع خالص % در بازه % تا % صفر یا منفی است (دریافت %، برگشت %)؛ تسویه به دورهٔ بعد می‌ماند',
      src.code, s.period_from, s.period_to, v_in, v_out;
  END IF;

  IF s.bank_reported_amount IS NOT NULL THEN
    v_net := s.bank_reported_amount;
    v_fee := v_gross - v_net;
    IF v_fee < 0 THEN
      RAISE EXCEPTION
        'مبلغ واریزشده بانک (%) از جمع تراکنش‌ها (%) بیشتر است. مغایرت باید بررسی شود.',
        s.bank_reported_amount, v_gross;
    END IF;
  ELSE
    v_fee := round(v_gross * src.fee_percent / 100);
    v_net := v_gross - v_fee;
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE platform.business_date(s.occurred_at) BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(s.occurred_at);
  END IF;
  v_no := platform.next_document_no(s.branch_id, 'settlement', v_fy);

  v_entry := ledger.post_entry(
    'settlement', s.branch_id, platform.business_date(s.occurred_at),
    'تسویه ' || src.name || ' — ' || v_no,
    jsonb_build_array(
      jsonb_build_object('leg','bank','amount', v_net,   'account_code', bank.ledger_account_code),
      jsonb_build_object('leg','fee', 'amount', v_fee),
      jsonb_build_object('leg','clearing','amount', v_gross, 'account_code', src.ledger_account_code)),
    'treasury_settlement', p_settlement, p_user);

  UPDATE treasury.payment
     SET status = 'settled', settled_at = s.occurred_at, settlement_id = p_settlement
   WHERE id = ANY(v_payments) AND account_id = s.source_account_id
     AND direction IN ('in','out')
     AND status = 'succeeded'
     AND settlement_id IS NULL
     AND platform.business_date(occurred_at) BETWEEN s.period_from AND s.period_to;

  UPDATE treasury.settlement
     SET number = v_no, gross_amount = v_gross, fee_amount = v_fee,
         net_amount = v_net, status = 'posted', entry_id = v_entry
   WHERE id = p_settlement;

  PERFORM platform.audit('settlement.post', 'treasury_settlement', p_settlement::text,
    jsonb_build_object('number', v_no, 'source', src.code, 'bank', bank.code,
                       'gross', v_gross, 'fee', v_fee, 'net', v_net, 'payments', v_count,
                       'received', v_in, 'refunded', v_out),
    p_user, s.note);

  RETURN v_entry;
END $function$;

-- ── ۴. تسویهٔ خودکار ────────────────────────────────────────────────
CREATE FUNCTION treasury.auto_settle_due(p_user uuid, p_today date DEFAULT platform.business_date())
RETURNS TABLE (account_code text, period_from date, period_to date, settlement_id uuid,
               gross platform.money, fee platform.money, net platform.money, skipped text)
LANGUAGE plpgsql
AS $$
DECLARE
  a        treasury.account%ROWTYPE;
  v_cutoff date;
  v_from   date;
  v_id     uuid;
  s        treasury.settlement%ROWTYPE;
BEGIN
  IF p_user IS NULL THEN RAISE EXCEPTION 'تسویهٔ خودکار بدون کاربر عامل مجاز نیست'; END IF;
  IF NOT coalesce((SELECT value::boolean FROM platform.setting WHERE key = 'treasury.auto_settlement'), false) THEN
    RETURN;
  END IF;
  -- دو اجرای هم‌زمان (زمان‌بند و دستی) یک پایانه را دو بار نمی‌سنجند.
  PERFORM pg_advisory_xact_lock(hashtextextended('treasury.auto_settle_due', 0));

  FOR a IN SELECT * FROM treasury.account
            WHERE is_active AND kind IN ('card_terminal','gateway') AND settlement_account_id IS NOT NULL
            ORDER BY code
  LOOP
    account_code := a.code; period_from := NULL; period_to := NULL; settlement_id := NULL;
    gross := NULL; fee := NULL; net := NULL; skipped := NULL;

    IF a.branch_id IS NULL THEN
      skipped := 'پایانهٔ مشترک میان شعبه‌ها خودکار تسویه نمی‌شود';
      RETURN NEXT; CONTINUE;
    END IF;

    -- فقط روزهای کامل‌شده‌ای که موعد واریزشان رسیده.
    v_cutoff := least(p_today - a.settlement_days, p_today - 1);
    SELECT min(platform.business_date(p.occurred_at)) INTO v_from
      FROM treasury.payment p
     WHERE p.account_id = a.id AND p.direction IN ('in','out') AND p.status = 'succeeded'
       AND p.settlement_id IS NULL AND platform.business_date(p.occurred_at) <= v_cutoff;
    IF v_from IS NULL THEN CONTINUE; END IF;   -- چیزی برای تسویه نیست
    period_from := v_from; period_to := v_cutoff;

    BEGIN
      INSERT INTO treasury.settlement
        (branch_id, source_account_id, bank_account_id, period_from, period_to, occurred_at, note, created_by)
      VALUES (a.branch_id, a.id, a.settlement_account_id, v_from, v_cutoff,
              platform.business_day_start(v_cutoff + a.settlement_days),
              'تسویهٔ خودکار با کارمزد قراردادی', p_user)
      RETURNING id INTO v_id;
      PERFORM treasury.post_settlement(v_id, p_user);
      SELECT * INTO s FROM treasury.settlement WHERE id = v_id;
      settlement_id := v_id; gross := s.gross_amount; fee := s.fee_amount; net := s.net_amount;
    EXCEPTION WHEN others THEN
      skipped := SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION treasury.auto_settle_due(uuid, date) IS
  'تسویهٔ خودکار پایانه‌ها با کارمزد قراردادی؛ هر پایانه یک برگ برای همهٔ روزهای سررسیده';

-- ── ۵. زنگ دهم: پرداخت تسویه‌نشده ──────────────────────────────────
CREATE OR REPLACE FUNCTION platform.health_alerts()
 RETURNS TABLE(code text, severity text, title text, n bigint, detail text)
 LANGUAGE sql
 STABLE
AS $function$
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

  UNION ALL
  -- پرداخت کارت‌خوان/درگاه که دو روز پس از موعد تسویه هنوز تسویه نشده: پایانهٔ
  -- تعریف‌نشده یا مبهم، تسویهٔ خودکار خاموش یا ناموفق (مهاجرت ۱۲۱).
  SELECT 'unsettled_terminal', 'warn', 'پرداخت کارتی یا درگاهی تسویه‌نشده',
         count(*)::bigint,
         coalesce('قدیمی‌ترین: ' || min(x.day)::text, '—')
    FROM (SELECT platform.business_date(p.occurred_at) AS day, a.settlement_days AS sd
            FROM treasury.payment p
            JOIN treasury.payment_method m ON m.code = p.method_code
            LEFT JOIN treasury.account a ON a.id = p.account_id
           WHERE m.kind IN ('card_reader','gateway') AND p.status = 'succeeded'
             AND p.settlement_id IS NULL) x
   WHERE x.day < platform.business_date() - coalesce(x.sd, 0) - 2
$function$;

UPDATE platform.setting
   SET options = coalesce(options, '[]'::jsonb)
       || '[{"value":"unsettled_terminal","label":"پرداخت کارتی یا درگاهی تسویه‌نشده"}]'::jsonb
 WHERE key = 'notify.health_alert_codes'
   AND NOT coalesce(options, '[]'::jsonb) @> '[{"value":"unsettled_terminal"}]'::jsonb;

COMMIT;
