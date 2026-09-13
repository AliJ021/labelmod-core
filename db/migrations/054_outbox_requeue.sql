-- =====================================================================
-- ۰۵۴ — اجرای مجدد کنترل‌شدهٔ نامهٔ مرده
-- =====================================================================
-- معیار پذیرش ۱۱ سند: «صف خطادار قابل مشاهده **و اجرای مجدد
-- کنترل‌شده**». نیمهٔ اولش از مهاجرت ۰۳۱ بود — `platform.outbox_dead`
-- زنگ خطر است و `ops/deploy.sh status` نشانش می‌دهد.
--
-- نیمهٔ دومش نبود. تنها راه زنده‌کردن یک پیامِ مرده این بود:
--
--   UPDATE platform.outbox_message SET status='pending' WHERE id=…;
--
-- و آن `UPDATE` سه مشکل داشت:
--
--   ۱. **هیچ ردّ حسابرسی نداشت.** پیامکی که دوباره به مشتری می‌رفت،
--      هیچ‌کس نمی‌دانست چه کسی و چرا فرستادش.
--   ۲. **بی‌اثر بود.** `attempts` روی سقف مانده بود، پس اولین شکستِ
--      بعدی `fail_outbox` را به `attempts >= max` می‌رساند و پیام
--      **همان لحظه** دوباره مرده می‌شد. یعنی «اجرای مجدد»ی که یک بار
--      هم تلاش نمی‌کرد.
--   ۳. **روی هر وضعیتی می‌نشست.** روی یک پیامِ `sent`، همان پیامک را
--      دوباره می‌فرستاد.
--
-- ── چرا یکی‌یکی و نه دسته‌ای ─────────────────────────────────────────
--
-- هر پیام دلیل مرگ خودش را دارد: یکی شمارهٔ غلط بود، یکی قطعی شبکه.
-- «همه را دوباره بفرست» یعنی شمارهٔ غلط هم دوباره تلاش کند و دلیلِ
-- ثبت‌شده برای همه یکی باشد. صف مرده در یک فروشگاه چند سطر است، نه
-- چند هزار.
--
-- ⚠️ **`last_error` پاک می‌شود و در `audit_log` می‌نشیند.** نگه‌داشتنش
--    روی سطر یعنی پیامی که بعداً موفق شد، تا ابد یک خطای قدیمی روی
--    خودش دارد. زنجیرهٔ حسابرسی تغییرناپذیر است و جای درستِ تاریخ
--    همان است.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION platform.requeue_dead_letter(
  p_id     bigint,
  p_reason text,
  p_user   uuid
) RETURNS platform.outbox_message LANGUAGE plpgsql AS $$
DECLARE
  v_msg platform.outbox_message;
  -- ⚠️ جدا نگه داشته می‌شود چون `RETURNING * INTO v_msg` سطر تازه را
  --    رویش می‌نویسد و «چرا مرده بود» از دست می‌رفت.
  v_died  text;
  v_tries int;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'اجرای مجدد پیام بدون ثبت دلیل ممکن نیست';
  END IF;

  -- قفل سطر: Worker ممکن است همین لحظه در حال برداشتن صف باشد.
  SELECT * INTO v_msg FROM platform.outbox_message
   WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'پیام Outbox با شناسه % وجود ندارد', p_id;
  END IF;

  -- فقط نامهٔ مرده. روی `sent` یعنی ارسال دوباره به مشتری، و روی
  -- `pending`/`sending` یعنی دست‌کاری در صفی که دارد کار می‌کند.
  IF v_msg.status <> 'dead' THEN
    RAISE EXCEPTION
      'فقط پیامِ مرده اجرای مجدد می‌شود؛ وضعیت این پیام % است', v_msg.status;
  END IF;

  v_died  := v_msg.last_error;
  v_tries := v_msg.attempts;

  UPDATE platform.outbox_message
     SET status          = 'pending',
         -- بی این صفرکردن، اولین شکستِ بعدی همان لحظه پیام را دوباره
         -- می‌کشت: `fail_outbox` روی `attempts >= max_attempts`.
         attempts        = 0,
         last_error      = NULL,
         claimed_by      = NULL,
         next_attempt_at = now()
   WHERE id = p_id
   RETURNING * INTO v_msg;

  PERFORM platform.audit(
    'outbox.requeue',
    'outbox_message',
    p_id::text,
    jsonb_build_object('status', 'pending', 'attempts', 0, 'topic', v_msg.topic),
    p_user,
    p_reason,
    -- «چرا مرده بود» تنها اطلاعی است که با این کار از سطر پاک می‌شود،
    -- پس همین‌جا نگه داشته می‌شود.
    jsonb_build_object('status', 'dead',
                       'attempts', v_tries,
                       'last_error', v_died));

  RETURN v_msg;
END $$;

COMMENT ON FUNCTION platform.requeue_dead_letter IS
  'زنده‌کردن یک نامهٔ مرده: فقط از وضعیت dead، با دلیل اجباری، و با صفرکردن attempts — وگرنه اولین شکست بعدی همان لحظه دوباره می‌کشتش.';

COMMIT;
