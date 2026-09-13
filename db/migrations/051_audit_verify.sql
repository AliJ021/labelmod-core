-- =====================================================================
-- ۰۵۱ — زنجیره هش حسابرسی: بازمحاسبه، و پوشاندن «before» و «reason»
-- =====================================================================
--
-- ── چه چیزی خراب بود ────────────────────────────────────────────────
--
-- بند ۳ SECURITY.md وعده می‌دهد: «لاگ حسابرسی فقط درج‌شدنی با زنجیره
-- هش ✅ اعمال‌شده»، و برای مهاجمی که دسترسی کامل DB دارد راه‌حل
-- «لنگر انداختن» را می‌دهد: «هر شب هش آخرین رکورد audit_log در فایل
-- بکاپ ذخیره شود. بازنویسی تاریخچه آن‌وقت نیازمند دستکاری بکاپ‌های
-- خارج از سرور هم هست.»
--
-- دو شکاف اندازه‌گیری شد، نه حدس زده:
--
-- **۱. هیچ‌جای سیستم هش را بازمحاسبه نمی‌کرد.** هر دو نگهبان موجود —
--    ادعای CI و بند ۶ `ops/restore-drill.sh` — فقط این را می‌سنجیدند:
--
--        prev_hash هر سطر = hash سطر پیشین
--
--    که **پیوند**ها را می‌سنجد، نه **محتوا** را. با خاموش‌کردن Trigger
--    و عوض‌کردن `after` یک سطر:
--
--        نگهبان CI              → ۰ گسست
--        نگهبان restore-drill   → ۰ گسست
--        بازمحاسبهٔ واقعی هش    → ۱ سطر دست‌کاری‌شده
--
--    یعنی زنجیره فقط درج و حذف سطر را می‌گرفت. تغییر محتوای هر سطر
--    **بی‌صدا** از هر سه نگاه‌کننده رد می‌شد.
--
-- **۲. هش «before» و «reason» را نمی‌پوشاند.** پس حتی با بازمحاسبه،
--    دقیقاً همان دو میدانی که یک فرد درون‌سازمانی جعل می‌کند بیرون از
--    پوشش بودند: «مقدار قبلی چه بود» و «به چه دلیل عوض شد».
--
--        پیش از این مهاجرت، رکورد جعلی زیر هر سه نگاه‌کننده را رد می‌کرد:
--        setting.change · return.window_hours
--          before 999999 · after 72 · reason «تأیید مدیر مالی (جعلی)»
--
--    و لنگرِ شب هم می‌خواند — پس تطبیق با بکاپ خارج از سرور هم چیزی
--    نمی‌گفت. یعنی آن وعده برای این دو میدان **برقرار نبود**.
--
-- ── اصلاح ───────────────────────────────────────────────────────────
--
-- الف) `platform.audit_hash()` — **تنها تعریف** فرمول هش. Trigger و
--      بازبین هر دو از آن می‌خوانند، پس دو نسخه نمی‌شود.
-- ب)  `hash_version` — سطرهای قبلی نسخه ۱ می‌مانند و سطرهای تازه نسخه
--      ۲ می‌گیرند که `before` و `reason` را هم می‌پوشاند. بی این ستون،
--      بازبین نمی‌توانست بداند کدام فرمول را روی کدام سطر بزند و هر
--      سطر تاریخی «دست‌کاری‌شده» گزارش می‌شد.
-- پ)  `platform.audit_check` — نمای واحدی که **هم** گسست پیوند و
--      **هم** ناهم‌خوانی محتوا را برمی‌گرداند. سه مصرف‌کننده دارد:
--      ثابت‌های CI، `ops/deploy.sh status`، و `ops/restore-drill.sh`.
--
-- ⚠️ تغییر خودِ فرمول نسخه ۱ ممکن نبود: هش سطرهای موجود با آن فرمول
--    محاسبه شده و بازنویسی‌شان یعنی همان «بازسازی زنجیره» که این
--    مکانیزم برای گرفتنش هست.
-- =====================================================================

ALTER TABLE platform.audit_log
  ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN platform.audit_log.hash_version IS
  'نسخه فرمول هش: ۱ = بدون before و reason (تاریخی)، ۲ = با آن‌ها.';

-- ---------------------------------------------------------------------
-- الف) تنها تعریف فرمول هش
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.audit_hash(
  p_version   smallint,
  p_prev_hash text,
  p_at        timestamptz,
  p_actor_id  uuid,
  p_action    text,
  p_entity    text,
  p_entity_id text,
  p_after     jsonb,
  p_before    jsonb,
  p_reason    text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT encode(digest(
    CASE
      -- نسخه ۱: همان فرمول تاریخی. دست‌نخورده می‌ماند، وگرنه هر سطر
      -- قبلی «دست‌کاری‌شده» گزارش می‌شد.
      WHEN p_version = 1 THEN
        coalesce(p_prev_hash, '') || p_at::text || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '')
      -- نسخه ۲: به‌علاوهٔ «مقدار قبلی» و «دلیل» — همان دو میدانی که
      -- بی‌آن‌ها، جعلِ «قبلاً چه بود و چرا عوض شد» دیده نمی‌شد.
      ELSE
        coalesce(p_prev_hash, '') || p_at::text || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '') || E'\x1f'
        || coalesce(p_before::text, '') || E'\x1f'
        || coalesce(p_reason, '')
    END, 'sha256'), 'hex');
$$;

-- ⚠️ جداکنندهٔ `\x1f` (Unit Separator) اتفاقی نیست: بی آن،
--    (before='{"a":1}', reason='x') و (before='{"a":1}x', reason='')
--    یک رشته می‌ساختند و یکی به‌جای دیگری جا می‌زد.

-- ---------------------------------------------------------------------
-- Trigger درج — حالا از همان تابع می‌خواند و نسخه را مهر می‌زند
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prev text;
BEGIN
  -- زنجیره باید سریال باشد. بدون قفل، دو درج هم‌زمان همان prev_hash را
  -- می‌خوانند و زنجیره بی‌صدا دوشاخه می‌شود (مهاجرت ۰۰۳).
  PERFORM pg_advisory_xact_lock(hashtext('platform.audit_log')::bigint);

  SELECT hash INTO v_prev FROM platform.audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.hash_version := 2;
  NEW.hash := platform.audit_hash(
    2::smallint, v_prev, NEW.at, NEW.actor_id, NEW.action,
    NEW.entity, NEW.entity_id, NEW.after, NEW.before, NEW.reason);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- پ) نمای بازبینی — پیوند **و** محتوا
-- ---------------------------------------------------------------------
-- خالی‌بودنش یعنی دفتر حسابرسی دست‌نخورده است. هر سطر برگشتی یک
-- دست‌کاری است، و `problem` می‌گوید کدام نوع:
--
--   broken_link     سطری درج یا حذف شده (prev_hash با سطر پیشین نمی‌خواند)
--   content_changed محتوای سطر عوض شده (هش با بازمحاسبه نمی‌خواند)
--
CREATE OR REPLACE VIEW platform.audit_check AS
WITH chained AS (
  SELECT a.id, a.at, a.actor_id, a.action, a.entity, a.entity_id,
         a.after, a.before, a.reason, a.prev_hash, a.hash, a.hash_version,
         lag(a.hash) OVER (ORDER BY a.id) AS expected_prev
    FROM platform.audit_log a
)
SELECT c.id, c.at, c.action, c.entity, c.entity_id, c.actor_id,
       CASE
         WHEN c.prev_hash IS DISTINCT FROM c.expected_prev THEN 'broken_link'
         ELSE 'content_changed'
       END AS problem,
       c.hash_version
  FROM chained c
 WHERE c.prev_hash IS DISTINCT FROM c.expected_prev
    OR c.hash IS DISTINCT FROM platform.audit_hash(
         c.hash_version, c.prev_hash, c.at, c.actor_id, c.action,
         c.entity, c.entity_id, c.after, c.before, c.reason);

COMMENT ON VIEW platform.audit_check IS
  'دست‌کاری در دفتر حسابرسی — هم گسست پیوند، هم تغییر محتوا. باید خالی باشد.';
