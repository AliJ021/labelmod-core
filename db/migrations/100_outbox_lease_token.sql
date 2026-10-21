-- =====================================================================
-- ۱۰۰ — توکن اجارهٔ Outbox: بستن پیام فقط با اثبات مالکیت (CAS)
-- =====================================================================
-- تا این مهاجرت `complete_outbox(id)` و `fail_outbox(id, …)` فقط **شناسه**
-- می‌گرفتند. اجاره (۰۳۱) جلوی برداشت هم‌زمان را می‌گرفت، ولی **بستن** هیچ
-- سنجشی نداشت. probe ریشه روی دیتابیس جدا، و همان سناریو در
-- `docs/evidence/2026-10-20-worker-lease-token/core-worker-lease-baseline-probe.log`:
--
--   A برمی‌دارد ← اجارهٔ A می‌گذرد ← B دوباره برمی‌دارد (تلاش ۲، claimed_by=B)
--   A دیررس: complete_outbox(id) ← پیام `sent` شد، درحالی‌که B هنوز می‌فرستد
--   A دیررس: fail_outbox(id, …)  ← پیام `pending` شد و اجارهٔ B بی‌صدا شکست
--
-- یعنی مالکِ کهنه اجارهٔ تازه‌تر را تغییر می‌داد. نتیجهٔ اول: شکستِ واقعیِ
-- B دیگر ثبت نمی‌شود (پیام `sent` است). نتیجهٔ دوم: پیام زیر پای B دوباره
-- برداشتنی می‌شود و Worker سوم هم می‌فرستدش.
--
-- ── چرا `claimed_by` کافی نیست ──────────────────────────────────────
--
-- نام Worker `hostname:pid` است. پس از Restart ظرف، pid می‌تواند تکرار شود
-- و دو اجارهٔ پیاپی همان نام را دارند؛ نام برای ردیابی است، نه اثبات.
-- توکن در **همان UPDATE برداشت** با `gen_random_uuid()` ساخته می‌شود؛
-- Worker نه انتخابش می‌کند و نه می‌تواند عوضش کند. هر برداشت تازه توکن
-- قبلی را باطل می‌کند.
--
-- ── قرارداد تازه ─────────────────────────────────────────────────────
--
--   claim_outbox(limit, worker, lease, topics, exclude) → … + claim_token
--   renew_outbox(id, token, lease)                       → boolean
--   complete_outbox(id, token)                           → boolean
--   fail_outbox(id, token, error, max, permanent, retry_after) → 'pending'|'dead'|'lost'
--
-- `false` / `'lost'` یعنی «اجاره دیگر مال تو نیست» و **هیچ سطری تغییر
-- نکرده است**. پیام مال مالک تازه است؛ تحویل همچنان «حداقل یک بار» است.
--
-- ⚠️ نسخه‌های بی‌توکن **حذف** می‌شوند، نه نگه داشته. یک Overload بی‌توکن
--    همان سوراخ است با نامی دیگر. Workerی که پیش از Restart هنوز نسخهٔ
--    قدیم را دارد، با «function does not exist» شکست می‌خورد؛ پیامش در
--    `sending` می‌ماند و پس از اجاره با توکن دوباره برداشته می‌شود. این
--    همان رفتار «Worker مرد» است و تحویل را گم نمی‌کند. ترتیب امن استقرار:
--    Worker را متوقف کن، مهاجرت، بعد Worker تازه (docs/DEPLOYMENT.md).
--
-- ── اجاره و تمدید محدود ─────────────────────────────────────────────
--
-- Worker پیام‌های یک دسته را پشت سر هم می‌فرستد. ۲۰ پیام × ۱۰ تا ۳۰
-- ثانیه مهلت شبکه بیش از اجارهٔ ۱۲۰ ثانیه است، پس انتهای دسته پیش از
-- نوبتش منقضی می‌شد. حالا Worker **پیش از هر پیام** با همان توکن تمدید
-- می‌کند؛ اگر کس دیگری برداشته باشد، تمدید `false` است و آن پیام فرستاده
-- نمی‌شود. اجاره فقط باید یک پیام را بپوشاند، نه یک دسته.
--
-- بازه‌ها در دیتابیس اجبار می‌شوند، نه فقط در Zod: سقف دسته ۱ تا ۲۰۰ و
-- اجاره ۳۰ تا ۳۶۰۰ ثانیه (همان `WORKER_BATCH` و `WORKER_LEASE_SECONDS`).
-- اجارهٔ صفر یا منفی یعنی پیامی که همان لحظه دوباره برداشتنی است.
--
-- ── تفکیک موضوع‌ها ──────────────────────────────────────────────────
--
-- `p_exclude` اضافه شد تا دو Worker با یک فهرست موضوع را **بی‌همپوشانی و
-- کامل** تقسیم کنند: یکی `topics = W`، دیگری `exclude = W`. تقسیم با
-- مکمل کامل است حتی برای موضوعی که فردا اضافه شود یا اصلاً Handler ندارد.
-- هر دو با هم ابهام است و رد می‌شود. آرایهٔ خالی برای `topics` هم رد
-- می‌شود: Workerی که هیچ‌چیز برنمی‌دارد، بی‌صدا یک خط را یتیم می‌کند.
--
-- ── Retry-After ─────────────────────────────────────────────────────
--
-- `p_retry_after_seconds` (اعتبارسنجی‌شده در Worker، ۰ تا ۸۶۴۰۰) **کفِ واقعی**
-- تأخیر بعدی است و هرگز کوتاه نمی‌شود:
--
--   تأخیر = greatest(least(backoff، ۱ ساعت) × (1 + 0.2 × لرزش)، retry_after)
--
-- سقف یک ساعت فقط مال Backoff نمایی خودِ ماست. Retry-After حکم سرور است؛
-- بریدن ۷۲۰۰ به ۳۶۰۰ یعنی زودتر از اجازهٔ سرور دوباره بزنیم (بازبینی ریشه
-- روی 92dc61c، `core-worker-retry-after-probe-92dc61c.log`). عدد بیرون از بازه
-- رد می‌شود (P0001)، نه اینکه بی‌صدا بریده شود.
--
-- ── لرزش ────────────────────────────────────────────────────────────
--
-- Backoff قطعی یعنی پس از هر قطعی، همهٔ پیام‌های شکسته در **یک لحظه** دوباره
-- برداشته شوند. لرزش ۰ تا ۲۰٪ **فقط رو به بالا** است: هرگز کمتر از Backoff
-- پایه و هرگز زیر Retry-After. در تولید `random()` است؛ آزمون `p_jitter` را
-- صریح می‌دهد تا عدد دقیق سنجیده شود.
--
-- ⚠️ `ADD COLUMN` بی پیش‌فرض فقط فراداده است و جدول را بازنویسی نمی‌کند؛
--    `lock_timeout` صریح است تا مهاجرت پشت یک تراکنش طولانی صف نکشد.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE platform.outbox_message
  ADD COLUMN IF NOT EXISTS claim_token uuid;

COMMENT ON COLUMN platform.outbox_message.claim_token IS
  'توکن اجارهٔ جاری؛ در هر برداشت تازه ساخته و در بستن پاک می‌شود. فقط دارندهٔ همین توکن می‌تواند پیام را ببندد یا تمدید کند.';

-- ---------------------------------------------------------------------
-- ۱. برداشتن — با توکن تازه برای هر سطر
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS platform.claim_outbox(int, text, int, text[]);

CREATE FUNCTION platform.claim_outbox(
  p_limit         int    DEFAULT 20,
  p_worker        text   DEFAULT NULL,
  p_lease_seconds int    DEFAULT 120,
  p_topics        text[] DEFAULT NULL,
  p_exclude       text[] DEFAULT NULL
) RETURNS TABLE (
  id          bigint,
  topic       text,
  payload     jsonb,
  attempts    int,
  claim_token uuid
) LANGUAGE plpgsql AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'اندازهٔ دستهٔ Outbox باید بین ۱ و ۲۰۰ باشد: %', p_limit;
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'مهلت اجارهٔ Outbox باید بین ۳۰ و ۳۶۰۰ ثانیه باشد: %', p_lease_seconds;
  END IF;
  IF p_topics IS NOT NULL AND p_exclude IS NOT NULL THEN
    RAISE EXCEPTION 'فهرست موضوع و فهرست استثنا با هم مبهم است؛ فقط یکی را بدهید';
  END IF;
  IF p_topics IS NOT NULL AND cardinality(p_topics) = 0 THEN
    RAISE EXCEPTION 'فهرست موضوع خالی است؛ این Worker هیچ پیامی برنمی‌دارد';
  END IF;

  RETURN QUERY
  UPDATE platform.outbox_message m
     SET status          = 'sending',
         attempts        = m.attempts + 1,
         claimed_by      = p_worker,
         claim_token     = gen_random_uuid(),
         next_attempt_at = now() + make_interval(secs => p_lease_seconds)
   WHERE m.id IN (
     SELECT c.id
       FROM platform.outbox_message c
      WHERE c.status IN ('pending','sending')
        AND c.next_attempt_at <= now()
        AND (p_topics  IS NULL OR c.topic = ANY(p_topics))
        AND (p_exclude IS NULL OR NOT (c.topic = ANY(p_exclude)))
      ORDER BY c.next_attempt_at, c.id
      LIMIT p_limit
        FOR UPDATE SKIP LOCKED
   )
  RETURNING m.id, m.topic, m.payload, m.attempts, m.claim_token;
END $$;

COMMENT ON FUNCTION platform.claim_outbox(int, text, int, text[], text[]) IS
  'برداشتن پیام‌های سررسیدشده با اجاره و توکن تازه. topics و exclude دو نیمهٔ یک تقسیم کامل‌اند. تحویل «حداقل یک بار» — Handler باید Idempotent باشد.';

-- ---------------------------------------------------------------------
-- ۲. تمدید — فقط با همان توکن
-- ---------------------------------------------------------------------
-- اجارهٔ منقضی‌ای که کسی برنداشته هنوز با همان توکن تمدیدپذیر است: توکن
-- اثبات مالکیت است و برداشت تازه آن را عوض می‌کرد. قفل سطر UPDATE با
-- `FOR UPDATE SKIP LOCKED` برداشت هم‌زمان ترتیب می‌گیرد.
CREATE FUNCTION platform.renew_outbox(
  p_id            bigint,
  p_token         uuid,
  p_lease_seconds int DEFAULT 120
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_n int;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'مهلت اجارهٔ Outbox باید بین ۳۰ و ۳۶۰۰ ثانیه باشد: %', p_lease_seconds;
  END IF;
  UPDATE platform.outbox_message
     SET next_attempt_at = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_id
     AND status = 'sending'
     AND claim_token = p_token;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

COMMENT ON FUNCTION platform.renew_outbox(bigint, uuid, int) IS
  'تمدید اجاره پیش از ارسال هر پیام، فقط برای دارندهٔ توکن جاری. false یعنی پیام مال Worker دیگری است و نباید فرستاده شود.';

-- ---------------------------------------------------------------------
-- ۳. بستن — موفق، با CAS
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS platform.complete_outbox(bigint);

CREATE FUNCTION platform.complete_outbox(p_id bigint, p_token uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE platform.outbox_message
     SET status = 'sent', sent_at = now(), last_error = NULL, claim_token = NULL
   WHERE id = p_id
     AND status = 'sending'
     AND claim_token = p_token;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

COMMENT ON FUNCTION platform.complete_outbox(bigint, uuid) IS
  'پایان موفق فقط برای دارندهٔ توکن جاری. false یعنی اجاره از دست رفته و هیچ سطری تغییر نکرد.';

-- ---------------------------------------------------------------------
-- ۴. بستن — ناموفق، با CAS، Backoff و کفِ Retry-After
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS platform.fail_outbox(bigint, text, int, boolean);

CREATE FUNCTION platform.fail_outbox(
  p_id                  bigint,
  p_token               uuid,
  p_error               text,
  p_max_attempts        int     DEFAULT 8,
  p_permanent           boolean DEFAULT false,
  p_retry_after_seconds int     DEFAULT NULL,
  p_jitter              double precision DEFAULT NULL
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_row    platform.outbox_message;
  v_delay  interval;
  v_status text;
  v_jitter double precision := coalesce(p_jitter, random());
BEGIN
  IF p_retry_after_seconds IS NOT NULL
     AND (p_retry_after_seconds < 0 OR p_retry_after_seconds > 86400) THEN
    RAISE EXCEPTION 'Retry-After باید بین ۰ و ۸۶۴۰۰ ثانیه باشد: %', p_retry_after_seconds;
  END IF;
  IF v_jitter < 0 OR v_jitter > 1 THEN
    RAISE EXCEPTION 'لرزش Backoff باید بین ۰ و ۱ باشد: %', v_jitter;
  END IF;

  SELECT * INTO v_row FROM platform.outbox_message WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'پیام Outbox یافت نشد: %', p_id;
  END IF;
  -- مالکِ کهنه هیچ‌چیز را عوض نمی‌کند: نه وضعیت، نه خطا، نه زمان.
  -- ⚠️ توکن تهی هرگز مالک نیست: سطرِ `sending` برداشته‌شده پیش از ۱۰۰ هم
  --    توکن تهی دارد و `IS DISTINCT FROM` آن دو را «برابر» می‌دید.
  IF p_token IS NULL OR v_row.status <> 'sending'
     OR v_row.claim_token IS DISTINCT FROM p_token THEN
    RETURN 'lost';
  END IF;

  IF p_permanent OR v_row.attempts >= p_max_attempts THEN
    v_status := 'dead';
    v_delay  := interval '0';
  ELSE
    v_status := 'pending';
    -- همان Backoff ۰۳۱: ۱، ۲، ۴ … دقیقه با سقف یک ساعت، سپس لرزش رو به بالا.
    -- Retry-After **بیرون** از سقف می‌نشیند: کفِ واقعی است، نه پیشنهادی که
    -- سقف ما بتواند کوتاهش کند.
    v_delay := greatest(
      least(make_interval(mins => (2 ^ least(v_row.attempts - 1, 10))::int), interval '1 hour')
        * (1 + 0.2 * v_jitter),
      make_interval(secs => coalesce(p_retry_after_seconds, 0))
    );
  END IF;

  UPDATE platform.outbox_message
     SET status          = v_status,
         last_error      = left(p_error, 1000),
         next_attempt_at = now() + v_delay,
         claim_token     = NULL
   WHERE id = p_id;

  RETURN v_status;
END $$;

COMMENT ON FUNCTION platform.fail_outbox(bigint, uuid, text, int, boolean, int, double precision) IS
  'شکست ارسال فقط برای دارندهٔ توکن: Backoff نمایی با سقف یک ساعت و لرزش ۰ تا ۲۰٪ رو به بالا؛ Retry-After سنجیده کفِ واقعی است و کوتاه نمی‌شود. تا سقف تلاش، سپس نامه مرده. «lost» یعنی اجاره از دست رفته و هیچ سطری تغییر نکرد.';

COMMIT;
