-- =====================================================================
-- ۰۵۶ — شناسهٔ پیگیری از HTTP تا دفتر حسابرسی و صف پیام
-- =====================================================================
-- FND-018. امروز `correlationId` فقط چهار جا استفاده می‌شود و هر چهار
-- در `http/app.ts`اند: لاگ خطا، هشدار CSRF، و پاسخ خطا به کاربر. یعنی:
--
--     از رسید خطای کاربر → لاگ API          ✔ کار می‌کند
--     از یک مغایرت مالی  → درخواست HTTP     ✘ راهی نیست
--
-- `audit_log` کاربر عامل و زمان و موجودیت را دارد، و لاگ API شناسهٔ
-- درخواست را — ولی **هیچ میدان مشترکی** بین این دو نیست. برای مغایرتی
-- که چند روز بعد در `balance_check` یا `ledger_check` پیدا شود، تنها
-- سرنخ «چه کسی، چه ساعتی» است و باید با چشم در لاگ گشت.
--
-- ── چهار تصمیم طراحی، و چرا ─────────────────────────────────────────
--
-- **۱. GUC، نه پارامتر.** شناسهٔ درخواست خصوصیتِ **درخواست** است نه
-- آرگومان منطق کسب‌وکار — همان استدلال `lib/request-context.ts` برای
-- `ip` و `device` (FND-020). ریختنش در امضای `platform.audit()` یعنی
-- عوض‌کردن هر فراخوانِ آن در همهٔ ماژول‌های مالی، و هر تابع تازه‌ای باز
-- می‌توانست فراموشش کند. حالا `audit()` خودش برمی‌داردش و **هیچ
-- فراخوانی عوض نشد**.
--
-- **۲. `set_actor` خودش پاکش می‌کند.** یک `set_correlation()` جدا
-- خطرناک بود: مسیری که صدایش نزند، شناسهٔ **درخواست قبلی** را روی
-- اتصال Pool‌شده می‌دید — همان کلاس نشتی که `enterWith` داشت و
-- `is_local = true` از آن پرهیز می‌کند. پس پارامتر چهارم همین تابع شد،
-- با پیش‌فرض `NULL`: هر فراخوانِ سه‌آرگومانیِ موجود، GUC را **خالی**
-- می‌کند. نشتی ممکن نیست.
--
-- ⚠️ به همین دلیل `DROP` و `CREATE` شد، نه `CREATE OR REPLACE` با
--    امضای تازه: افزودن پارامتر یک **Overload** می‌ساخت و فراخوان
--    سه‌آرگومانی به نسخهٔ قدیمی می‌رفت که GUC را پاک نمی‌کند. دقیقاً
--    همان نشتی که می‌خواستیم ببندیم.
--
-- **۳. فرمول هش نسخهٔ ۳ می‌شود.** میدان تازه‌ای که بیرون از پوشش هش
-- بماند، همان اشکال FND-017 است: جعلش دیده نمی‌شود. نسخه‌های ۱ و ۲
-- دست‌نخورده می‌مانند، وگرنه هر سطر تاریخی «دست‌کاری‌شده» گزارش می‌شد.
--
-- **۴. صف پیام با Trigger پر می‌شود، نه با پنج اصلاح.** پنج جا در
-- مهاجرت‌های ۰۰۲، ۰۰۳، ۰۳۱، ۰۳۹ و ۰۵۵ در `outbox_message` درج می‌کنند.
-- Trigger از **هر** مسیری می‌گذرد — از جمله مسیر ششمی که فردا ساخته
-- شود و این قاعده را نداند. همان فلسفهٔ مهاجرت ۰۵۲.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. ستون‌ها
-- ---------------------------------------------------------------------
-- ⚠️ سطرهای تاریخی `NULL` می‌مانند و **این درست است**: آن درخواست‌ها
--    شناسه‌ای نداشتند. هش نسخهٔ ۱ و ۲ این میدان را نمی‌پوشاند، پس
--    `audit_check` رویشان چیزی نمی‌گوید.
ALTER TABLE platform.audit_log
  ADD COLUMN IF NOT EXISTS correlation_id text;

ALTER TABLE platform.outbox_message
  ADD COLUMN IF NOT EXISTS correlation_id text;

COMMENT ON COLUMN platform.audit_log.correlation_id IS
  'شناسهٔ درخواست HTTP سازندهٔ این رکورد. بیرون از HTTP (Worker، CLI) NULL است و همین درست است.';
COMMENT ON COLUMN platform.outbox_message.correlation_id IS
  'شناسهٔ درخواستی که این پیام را ساخت — پیوند Worker به درخواست سازنده.';

-- ایندکس برای همان پرسشی که این مهاجرت برایش هست: «این شناسه چه کرد؟»
CREATE INDEX IF NOT EXISTS audit_log_correlation_idx
  ON platform.audit_log (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- ۲. کاربر عامل + شناسهٔ پیگیری، یک تابع
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS platform.set_actor(uuid, inet, text);

CREATE FUNCTION platform.set_actor(
  p_actor       uuid,
  p_ip          inet DEFAULT NULL,
  p_device      text DEFAULT NULL,
  p_correlation text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- `is_local = true` در هر چهار: در Pool اشتراکی به درخواست بعدی نشت
  -- نمی‌کند، و به همین دلیل فقط داخل تراکنش معنا دارد.
  PERFORM set_config('labelmod.actor_id',    coalesce(p_actor::text, ''),   true);
  PERFORM set_config('labelmod.ip',          coalesce(p_ip::text, ''),      true);
  PERFORM set_config('labelmod.device',      coalesce(p_device, ''),        true);
  PERFORM set_config('labelmod.correlation', coalesce(p_correlation, ''),   true);
END $$;

COMMENT ON FUNCTION platform.set_actor IS
  'کاربر عامل و زمینهٔ درخواست، همه با is_local. فراخوان سه‌آرگومانی شناسهٔ پیگیری را **پاک** می‌کند — پس نشتی از درخواست قبلی ممکن نیست.';

-- ---------------------------------------------------------------------
-- ۳. فرمول هش — نسخهٔ ۳
-- ---------------------------------------------------------------------
-- نما و Trigger به تابع وابسته‌اند، پس ترتیب: نما برود، تابع برود،
-- هر دو با شکل تازه برگردند.
DROP VIEW IF EXISTS platform.audit_check;
DROP FUNCTION IF EXISTS platform.audit_hash(
  smallint, text, timestamptz, uuid, text, text, text, jsonb, jsonb, text);

CREATE FUNCTION platform.audit_hash(
  p_version     smallint,
  p_prev_hash   text,
  p_at          timestamptz,
  p_actor_id    uuid,
  p_action      text,
  p_entity      text,
  p_entity_id   text,
  p_after       jsonb,
  p_before      jsonb,
  p_reason      text,
  p_correlation text DEFAULT NULL
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
      WHEN p_version = 2 THEN
        coalesce(p_prev_hash, '') || p_at::text || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '') || E'\x1f'
        || coalesce(p_before::text, '') || E'\x1f'
        || coalesce(p_reason, '')
      -- نسخه ۳: به‌علاوهٔ شناسهٔ پیگیری. بی آن، جعلِ «این تغییر از کدام
      -- درخواست آمد» دیده نمی‌شد — همان اشکال FND-017، یک میدان دیرتر.
      ELSE
        coalesce(p_prev_hash, '') || p_at::text || coalesce(p_actor_id::text, '')
        || p_action || p_entity || coalesce(p_entity_id, '')
        || coalesce(p_after::text, '') || E'\x1f'
        || coalesce(p_before::text, '') || E'\x1f'
        || coalesce(p_reason, '') || E'\x1f'
        || coalesce(p_correlation, '')
    END, 'sha256'), 'hex');
$$;

COMMENT ON FUNCTION platform.audit_hash IS
  'تنها تعریف فرمول هش حسابرسی. سه نسخه: ۱ تاریخی، ۲ با before/reason، ۳ با شناسهٔ پیگیری. نسخه‌های قدیمی هرگز عوض نمی‌شوند.';

-- ⚠️ جداکنندهٔ `\x1f` (Unit Separator) اتفاقی نیست: بی آن،
--    (reason='x', correlation='y') و (reason='xy', correlation='')
--    یک رشته می‌ساختند و یکی به‌جای دیگری جا می‌زد.

-- ---------------------------------------------------------------------
-- ۴. Trigger درج — نسخه ۳ مهر می‌زند
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
  NEW.hash_version := 3;
  NEW.hash := platform.audit_hash(
    3::smallint, v_prev, NEW.at, NEW.actor_id, NEW.action,
    NEW.entity, NEW.entity_id, NEW.after, NEW.before, NEW.reason,
    NEW.correlation_id);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- ۵. نمای بازبینی — همان سه پرسش، با میدان تازه
-- ---------------------------------------------------------------------
CREATE VIEW platform.audit_check AS
WITH chained AS (
  SELECT a.id, a.at, a.actor_id, a.action, a.entity, a.entity_id,
         a.after, a.before, a.reason, a.correlation_id,
         a.prev_hash, a.hash, a.hash_version,
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
         c.entity, c.entity_id, c.after, c.before, c.reason, c.correlation_id);

COMMENT ON VIEW platform.audit_check IS
  'دست‌کاری در دفتر حسابرسی — هم گسست پیوند، هم تغییر محتوا. باید خالی باشد.';

-- ---------------------------------------------------------------------
-- ۶. ثبت حسابرسی — شناسه را خودش برمی‌دارد
-- ---------------------------------------------------------------------
-- امضا **عوض نشد**؛ هیچ فراخوانی در هیچ ماژول مالی دست نخورد.
CREATE OR REPLACE FUNCTION platform.audit(
  p_action    text,
  p_entity    text,
  p_entity_id text,
  p_after     jsonb DEFAULT NULL,
  p_actor     uuid  DEFAULT NULL,
  p_reason    text  DEFAULT NULL,
  p_before    jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_actor uuid; v_ip text; v_dev text; v_corr text;
BEGIN
  v_actor := coalesce(p_actor, platform.current_actor());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'ثبت حسابرسی بدون کاربر عامل مجاز نیست (عملیات %). platform.set_actor() فراخوانی نشده است.',
      p_action;
  END IF;
  v_ip   := nullif(current_setting('labelmod.ip', true), '');
  v_dev  := nullif(current_setting('labelmod.device', true), '');
  v_corr := nullif(current_setting('labelmod.correlation', true), '');

  INSERT INTO platform.audit_log
    (actor_id, action, entity, entity_id, before, after, ip, device, reason,
     correlation_id)
  VALUES
    (v_actor, p_action, p_entity, p_entity_id, p_before, p_after,
     v_ip::inet, v_dev, p_reason, v_corr);
END $$;

COMMENT ON FUNCTION platform.audit IS
  'ثبت حسابرسی. ip و device و correlation_id از زمینهٔ درخواست می‌آیند نه از امضا — پس مسیر تازه نمی‌تواند فراموششان کند.';

-- ---------------------------------------------------------------------
-- ۷. صف پیام — Trigger، نه پنج اصلاح
-- ---------------------------------------------------------------------
-- پنج جا در مهاجرت‌های ۰۰۲، ۰۰۳، ۰۳۱، ۰۳۹ و ۰۵۵ در این جدول درج
-- می‌کنند. Trigger از **هر** مسیری می‌گذرد، از جمله مسیر ششم فردا.
CREATE OR REPLACE FUNCTION platform.outbox_correlation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- مقدار صریح برنده است: اگر روزی کسی پیامی را عمداً به شناسهٔ دیگری
  -- نسبت داد، Trigger رویش نمی‌نویسد.
  IF NEW.correlation_id IS NULL THEN
    NEW.correlation_id := nullif(current_setting('labelmod.correlation', true), '');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS outbox_correlation_t ON platform.outbox_message;
CREATE TRIGGER outbox_correlation_t
  BEFORE INSERT ON platform.outbox_message
  FOR EACH ROW EXECUTE FUNCTION platform.outbox_correlation();

COMMENT ON FUNCTION platform.outbox_correlation IS
  'شناسهٔ پیگیری را از زمینهٔ درخواست روی پیام تازه می‌نشاند. بیرون از HTTP NULL می‌ماند.';

COMMIT;
