-- =====================================================================
-- ۰۳۱ — Outbox قابل مصرف: اجاره، Backoff و نامه مرده
-- =====================================================================
-- جدول `platform.outbox_message` از مهاجرت ۰۰۱ وجود دارد و
-- `finalize_invoice` از همان روز رویش می‌نویسد. آنچه نبود، **مصرف‌کننده**
-- بود: هیچ‌کس آن سطرها را برنمی‌داشت.
--
-- ── چرا یک وضعیت تازه لازم شد ───────────────────────────────────────
--
-- ارسال پیامک یک فراخوان شبکه است و می‌تواند ثانیه‌ها طول بکشد. نگه‌داشتن
-- یک تراکنش باز روی کل آن مدت یعنی قفل‌های طولانی روی جدولی که مسیر
-- فروش هم رویش می‌نویسد.
--
-- پس دو فاز: **برداشتن** (`claim_outbox`) و **بستن**
-- (`complete_outbox` / `fail_outbox`). میان این دو، پیام وضعیت
-- `sending` دارد.
--
-- ── و چرا اجاره، نه قفل ─────────────────────────────────────────────
--
-- Workerی که وسط ارسال بمیرد، پیام را در `sending` جا می‌گذارد. بدون
-- مهلت، آن پیام تا ابد آنجا می‌ماند و هیچ‌کس هم نمی‌فهمد — یک پیامک که
-- هرگز نرفت و هیچ خطایی هم نداد.
--
-- پس `next_attempt_at` مهلت اجاره هم هست: پیامِ `sending` که مهلتش
-- گذشته، دوباره برداشته می‌شود.
--
-- ⚠️ **پیامد مستقیم: تحویل «حداقل یک بار» است، نه «دقیقاً یک بار».**
--    اگر پیامک رفته باشد و Worker پیش از `complete` بمیرد، همان پیامک
--    دوباره می‌رود. این را نمی‌شود در دیتابیس حل کرد — Handler باید
--    Idempotent باشد، و مصرف‌کننده‌ها همین‌طور نوشته شده‌اند.
--
-- ── نامه مرده، نه Retry بی‌پایان ────────────────────────────────────
--
-- شماره موبایل غلط با تلاش صدم هم درست نمی‌شود. پس از سقف تلاش، پیام
-- `dead` می‌شود و در `platform.outbox_dead` دیده می‌شود. صفی که تا ابد
-- تلاش کند، فقط خطای واقعی را زیر هزار خطای تکراری پنهان می‌کند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. وضعیت `sending`
-- ---------------------------------------------------------------------
ALTER TABLE platform.outbox_message
  DROP CONSTRAINT IF EXISTS outbox_message_status_check;

ALTER TABLE platform.outbox_message
  ADD CONSTRAINT outbox_message_status_check
  CHECK (status IN ('pending','sending','sent','failed','dead'));

-- ایندکس قدیمی فقط `pending` را می‌دید. پیامِ `sending` با اجاره
-- منقضی هم باید سریع پیدا شود، وگرنه بازیابی پس از مرگ Worker یک
-- Seq Scan روی کل تاریخچه است.
DROP INDEX IF EXISTS platform.outbox_message_status_next_attempt_at_idx;
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON platform.outbox_message (next_attempt_at, id)
  WHERE status IN ('pending','sending');

-- «چه کسی برش داشت» — برای وقتی دو Worker بالاست و باید فهمید کدام
-- گیر کرده. مجوز نیست، ردیابی است.
ALTER TABLE platform.outbox_message
  ADD COLUMN IF NOT EXISTS claimed_by text;

-- ---------------------------------------------------------------------
-- ۲. برداشتن
-- ---------------------------------------------------------------------
-- `FOR UPDATE SKIP LOCKED` تا دو Worker یک پیام را دو بار برندارند.
-- بدون `SKIP LOCKED`، Worker دوم پشت اولی صف می‌بست و کل هدفِ موازی
-- بودن از دست می‌رفت.
--
-- `p_topics` تهی یعنی «همه موضوع‌ها». وجودش برای روزی است که ارسال
-- پیامک و ساخت PDF دو Worker جدا شوند — امروز یکی است.

CREATE OR REPLACE FUNCTION platform.claim_outbox(
  p_limit   int  DEFAULT 20,
  p_worker  text DEFAULT NULL,
  p_lease_seconds int DEFAULT 120,
  p_topics  text[] DEFAULT NULL
) RETURNS TABLE (
  id       bigint,
  topic    text,
  payload  jsonb,
  attempts int
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  UPDATE platform.outbox_message m
     SET status          = 'sending',
         attempts        = m.attempts + 1,
         claimed_by      = p_worker,
         -- مهلت اجاره. اگر Worker بمیرد، پس از این لحظه پیام دوباره
         -- برداشتنی است.
         next_attempt_at = now() + make_interval(secs => p_lease_seconds)
   WHERE m.id IN (
     SELECT c.id
       FROM platform.outbox_message c
      WHERE c.status IN ('pending','sending')
        AND c.next_attempt_at <= now()
        AND (p_topics IS NULL OR c.topic = ANY(p_topics))
      ORDER BY c.next_attempt_at, c.id
      LIMIT p_limit
        FOR UPDATE SKIP LOCKED
   )
  RETURNING m.id, m.topic, m.payload, m.attempts;
END $$;

COMMENT ON FUNCTION platform.claim_outbox IS
  'برداشتن پیام‌های سررسیدشده با اجاره. تحویل «حداقل یک بار» — Handler باید Idempotent باشد.';

-- ---------------------------------------------------------------------
-- ۳. بستن — موفق
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.complete_outbox(p_id bigint)
RETURNS void LANGUAGE sql AS $$
  UPDATE platform.outbox_message
     SET status = 'sent', sent_at = now(), last_error = NULL
   WHERE id = p_id;
$$;

-- ---------------------------------------------------------------------
-- ۴. بستن — ناموفق، با Backoff نمایی
-- ---------------------------------------------------------------------
-- ۱، ۲، ۴، ۸ … دقیقه، با سقف یک ساعت. سقف لازم است وگرنه تلاش دهم
-- هشت ساعت بعد می‌افتد و پیامک «فاکتور شما ثبت شد» فردا صبح می‌رسد.
--
-- `p_permanent` برای خطایی است که تلاش دوباره حلش نمی‌کند: شماره
-- نامعتبر، اعتبار تمام‌شده. مستقیم `dead` می‌شود.

CREATE OR REPLACE FUNCTION platform.fail_outbox(
  p_id        bigint,
  p_error     text,
  p_max_attempts int DEFAULT 8,
  p_permanent boolean DEFAULT false
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_attempts int;
  v_delay    interval;
  v_status   text;
BEGIN
  SELECT attempts INTO v_attempts
    FROM platform.outbox_message WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'پیام Outbox یافت نشد: %', p_id;
  END IF;

  IF p_permanent OR v_attempts >= p_max_attempts THEN
    v_status := 'dead';
    v_delay  := interval '0';
  ELSE
    v_status := 'pending';
    -- `2 ^ n` در پستگرس double است و make_interval صحیح می‌خواهد.
    -- Cast صریح، نه اتکا به تبدیل ضمنی که وجود ندارد.
    v_delay  := least(
      make_interval(mins => (2 ^ least(v_attempts - 1, 10))::int),
      interval '1 hour'
    );
  END IF;

  UPDATE platform.outbox_message
     SET status          = v_status,
         last_error      = left(p_error, 1000),
         next_attempt_at = now() + v_delay
   WHERE id = p_id;

  RETURN v_status;
END $$;

COMMENT ON FUNCTION platform.fail_outbox IS
  'شکست ارسال: Backoff نمایی تا سقف تلاش، سپس نامه مرده. p_permanent برای خطایی که تلاش دوباره حلش نمی‌کند.';

-- ---------------------------------------------------------------------
-- ۵. نامه مرده — همان نقشی که `unposted_revenue` برای دفتر دارد
-- ---------------------------------------------------------------------
-- زنگ خطر، نه گزارش. اگر این نما خالی نباشد، پیامی هست که هرگز نرفت
-- و کسی هم خبر ندارد.

CREATE OR REPLACE VIEW platform.outbox_dead AS
SELECT id, topic, payload, attempts, last_error, created_at,
       now() - created_at AS age
  FROM platform.outbox_message
 WHERE status = 'dead'
 ORDER BY created_at DESC;

COMMENT ON VIEW platform.outbox_dead IS
  'پیام‌هایی که پس از سقف تلاش نرفتند. خالی‌نبودنش یعنی کسی باید نگاه کند.';

-- ---------------------------------------------------------------------
-- ۶. نشانی عمومی فاکتور
-- ---------------------------------------------------------------------
-- پیامک نمی‌تواند PDF ضمیمه کند. آنچه می‌تواند، یک **لینک** است.
--
-- ⚠️ لینک بدون توکن یعنی هر کسی با شمردن عدد، فاکتور بقیه را می‌بیند.
--    توکن ۲۴ بایت تصادفی است و مثل توکن نشست فقط از مسیر امن ساخته
--    می‌شود. برخلاف نشست، **خودِ توکن** ذخیره می‌شود نه هشش: فاکتور
--    باید از روی لینک پیدا شود و کاربر توکن را در URL می‌آورد؛ هش
--    یعنی جست‌وجوی خطی روی همه فاکتورها.
--
--    این یک معامله آگاهانه است: توکن ۲۴ بایتی حدس‌زدنی نیست، و
--    محتوایش هم فاکتور خودِ مشتری است نه یک راز مالی. توکن نشست
--    قدرت می‌دهد؛ این یکی فقط یک سند را نشان می‌دهد.

ALTER TABLE sales.invoice
  ADD COLUMN IF NOT EXISTS public_token text UNIQUE;

CREATE OR REPLACE FUNCTION sales.ensure_public_token(p_invoice uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_token text;
BEGIN
  SELECT public_token INTO v_token FROM sales.invoice WHERE id = p_invoice;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاکتور یافت نشد';
  END IF;
  IF v_token IS NOT NULL THEN
    RETURN v_token;                    -- Idempotent: لینک عوض نمی‌شود
  END IF;

  v_token := encode(gen_random_bytes(24), 'base64');
  -- base64 در URL معنا عوض می‌کند؛ base64url دستی.
  v_token := replace(replace(rtrim(v_token, '='), '+', '-'), '/', '_');

  UPDATE sales.invoice SET public_token = v_token WHERE id = p_invoice;
  RETURN v_token;
END $$;

COMMENT ON FUNCTION sales.ensure_public_token IS
  'توکن نشانی عمومی فاکتور. Idempotent — لینکی که یک بار پیامک شده، عوض نمی‌شود.';

-- ---------------------------------------------------------------------
-- ۷. هشدار سررسید چک — تولیدکننده، نه مصرف‌کننده
-- ---------------------------------------------------------------------
-- چک برخلاف فاکتور، **رویدادی ندارد که هشدارش را بزند**: هیچ‌کس کاری
-- نمی‌کند، فقط تاریخ نزدیک می‌شود. پس یک کار زمان‌بندی‌شده باید هر روز
-- بپرسد «کدام چک نزدیک است».
--
-- ⚠️ Idempotency اینجا حیاتی است و در **payload** حل شده، نه در کد
--    Worker: کلید `(cheque_id, business_date)` است، پس اجرای دوباره
--    زمان‌بند در همان روز پیام دوم نمی‌سازد. بدون این، هر بار اجرای
--    ساعتی یک پیامک تازه بود — و مالک تا ظهر بیست پیامک یکسان
--    می‌گرفت و بعد همه‌شان را نادیده می‌گرفت.

CREATE OR REPLACE FUNCTION treasury.enqueue_due_cheque_alerts(
  p_today date DEFAULT platform.business_date()
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_count int;
BEGIN
  WITH due AS (
    SELECT d.id, d.number, d.cheque_no, d.direction, d.amount,
           d.due_on, d.days_left, d.urgency, d.party_name
      FROM treasury.cheque_due d
     WHERE d.urgency IN ('due_soon','overdue')
  ), fresh AS (
    SELECT due.* FROM due
     WHERE NOT EXISTS (
       -- همان چک، همان روز کاری → پیام تازه‌ای لازم نیست.
       SELECT 1 FROM platform.outbox_message m
        WHERE m.topic = 'cheque.due'
          AND m.payload->>'cheque_id' = due.id::text
          AND m.payload->>'business_date' = p_today::text
     )
  ), ins AS (
    INSERT INTO platform.outbox_message (topic, payload)
    SELECT 'cheque.due',
           jsonb_build_object(
             'cheque_id',     f.id,
             'business_date', p_today,
             'number',        f.number,
             'cheque_no',     f.cheque_no,
             'direction',     f.direction,
             'amount',        f.amount::text,
             'due_on',        f.due_on,
             'days_left',     f.days_left,
             'urgency',       f.urgency,
             'party_name',    f.party_name)
      FROM fresh f
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END $$;

COMMENT ON FUNCTION treasury.enqueue_due_cheque_alerts IS
  'هشدار چک سررسیدشده و نزدیک. کلید یکتایی (چک، روز کاری) در payload است، پس اجرای دوباره پیام دوم نمی‌سازد.';

COMMIT;
