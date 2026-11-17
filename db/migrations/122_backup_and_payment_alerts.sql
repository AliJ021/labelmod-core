-- =====================================================================
-- ۱۲۲ — سابقهٔ بکاپ، نسخهٔ بیرونی، و پرداخت بلاتکلیف
-- =====================================================================
-- یافته‌های ممیزی LM-09 و LM-14 (۲۰۲۶/۱۱/۱۲). تصمیم مالک (۲۰۲۶/۱۱/۱۵):
-- نسخهٔ بیرون از سرور با **دکمهٔ «دانلود بکاپ» در پنل** گرفته می‌شود.
--
-- ── مشکل ──────────────────────────────────────────────────────────
-- دیتابیس نمی‌دانست بکاپی گرفته شده یا نه. زمان‌بند هر شب `pg_dump` می‌زد،
-- ولی اگر شکست می‌خورد یا ظرف در آن ساعت پایین بود (LM-19)، هیچ زنگی
-- نمی‌خورد؛ «تمرین بازیابی» فقط می‌گفت آخرین **تمرین** کی بوده، نه آخرین
-- **بکاپ**. و نسخهٔ بیرونی که SECURITY.md بند ۴ اجباری کرده، هیچ ردی نداشت:
-- اگر مالک سه ماه دانلود نکند، دیسک سرور تنها نسخه است و کسی خبر ندارد.
--
-- ── این مهاجرت ─────────────────────────────────────────────────────
-- ۱. `platform.backup_event` — هر ساخت یا دانلود بکاپ یک سطر، فقط درج‌شدنی
--    (همان قاعدهٔ `restore_drill`). نویسنده‌ها: `ops/db.sh backup` (زمان‌بند)
--    و سرویس مستقل بکاپ (ساخت و دانلود از پنل) — هر دو با نقش **مالک**.
-- ۲. `platform.backup_status` — آخرین ساخت و آخرین دانلود، با مهلت از تنظیم.
-- ۳. سه زنگ تازه در `platform.health_alerts()`:
--      backup_stale         critical  بکاپ تازه‌ای در `backup.max_age_hours` نیست
--      backup_offsite_stale warn      در `backup.offsite_days` کسی بکاپ را دانلود نکرده
--      payment_unresolved   warn      پرداخت «در انتظار/نامعلوم» بیش از یک ساعت مانده
--
-- ⚠️ **دانلود ≠ نگهداری امن.** سطر «دانلود شد» یعنی فایل از سرور بیرون رفت،
--    نه اینکه جایی امن نشست یا بازیابی‌اش آزموده شد. زنگ «تمرین بازیابی»
--    همچنان جداست و این زنگ آن را خاموش نمی‌کند.
-- ⚠️ **ساخت بکاپ ناموفق ثبت نمی‌شود** و زنگ را خاموش نمی‌کند — همان قاعدهٔ
--    تمرین بازیابی: شکست نباید شبیه موفقیت شمرده شود.
-- ⚠️ **پرداخت بلاتکلیف را هیچ‌چیز خودکار حل نمی‌کند** (قاعدهٔ «بی Retry
--    خودکار روی پرداخت نامشخص»). این زنگ فقط می‌گوید صف بررسی انسانی خالی
--    نیست. قصد درگاه (اسنپ‌پی/دیجی‌پی) هم وقتی آخرین رویدادش `unknown` است
--    شمرده می‌شود.
--
-- آزمون: `db/test/backup-status.sql`.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── ۱. سابقه ──────────────────────────────────────────────────────────
CREATE TABLE platform.backup_event (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  kind         text NOT NULL CHECK (kind IN ('created', 'downloaded')),
  -- زمان‌بند شبانه (`ops/db.sh backup`) یا سرویس مستقل بکاپ پنل.
  source       text NOT NULL CHECK (source IN ('scheduler', 'manager')),
  -- نام فایل زمان‌بند یا شناسهٔ بکاپ سرویس مستقل.
  backup_ref   text NOT NULL CHECK (btrim(backup_ref) <> '' AND length(backup_ref) <= 200),
  backup_bytes bigint CHECK (backup_bytes > 0),
  sha256       text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- دانلود همیشه یک آدم دارد؛ ساخت شبانه ندارد.
  actor_id     uuid REFERENCES identity.app_user(id),
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind <> 'downloaded' OR (source = 'manager' AND actor_id IS NOT NULL))
);

CREATE INDEX backup_event_kind_time_idx ON platform.backup_event (kind, occurred_at DESC);

COMMENT ON TABLE platform.backup_event IS
  'هر ساخت یا دانلود بکاپ یک سطر. فقط درج‌شدنی؛ شکست ثبت نمی‌شود و زنگ را خاموش نمی‌کند.';

CREATE FUNCTION platform.backup_event_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'سابقهٔ بکاپ تغییرناپذیر است';
END $$;

CREATE TRIGGER backup_event_no_update
  BEFORE UPDATE OR DELETE ON platform.backup_event
  FOR EACH ROW EXECUTE FUNCTION platform.backup_event_immutable();

-- تنها راه نوشتن. با نقش مالک صدا زده می‌شود (زمان‌بند و سرویس بکاپ)؛
-- `ops/db-roles.sh` آن را از نقش برنامه می‌گیرد تا API نتواند با یک «دانلود»
-- جعلی زنگ نسخهٔ بیرونی را خاموش کند.
CREATE FUNCTION platform.record_backup_event(
  p_kind   text,
  p_source text,
  p_ref    text,
  p_bytes  bigint DEFAULT NULL,
  p_sha256 text   DEFAULT NULL,
  p_actor  uuid   DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO platform.backup_event (kind, source, backup_ref, backup_bytes, sha256, actor_id)
  VALUES (p_kind, p_source, btrim(p_ref), p_bytes, lower(p_sha256), p_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION platform.record_backup_event(text, text, text, bigint, text, uuid) IS
  'ثبت ساخت یا دانلود بکاپ. فقط زمان‌بند و سرویس مستقل بکاپ (نقش مالک) صدایش می‌زنند.';

-- ── ۲. تنظیم‌ها ───────────────────────────────────────────────────────
INSERT INTO platform.setting
  (key, value, description, requires_approval, kind, label, group_key, options,
   min_value, max_value, unit, help, sort_order, permission, is_editable)
VALUES
  ('backup.max_age_hours', '26'::jsonb,
   'اگر در این مدت هیچ بکاپ موفقی ساخته نشده باشد، زنگ «بکاپ تازه نیست» می‌خورد.', false,
   'int', 'حداکثر عمر آخرین بکاپ', 'backup', NULL, 2, 168, 'ساعت',
   'بکاپ شبانه هر ۲۴ ساعت یک بار است؛ ۲۶ ساعت دو ساعت فرصت برای کار کند می‌دهد. شکست بکاپ ثبت نمی‌شود، پس یک شب ناموفق همین زنگ را روشن می‌کند.',
   30, 'settings.manage', true),
  ('backup.offsite_days', '7'::jsonb,
   'اگر در این مدت هیچ بکاپی از پنل دانلود نشده باشد، زنگ «نسخهٔ بیرون از سرور قدیمی است» می‌خورد.', false,
   'int', 'فاصلهٔ دانلود نسخهٔ بیرونی', 'backup', NULL, 1, 90, 'روز',
   'تنها نسخهٔ بیرون از سرور همان است که از «پشتیبان‌گیری و بازیابی» دانلود و جای امنی نگه داشته می‌شود. خرابی دیسک یا باج‌افزار روی سرور، بکاپ‌های همان سرور را هم می‌برد.',
   40, 'settings.manage', true)
ON CONFLICT (key) DO NOTHING;

-- ── ۳. وضعیت ──────────────────────────────────────────────────────────
CREATE VIEW platform.backup_status AS
SELECT
  c.last_created_at,
  d.last_downloaded_at,
  platform.setting_int('backup.max_age_hours', 26) AS max_age_hours,
  platform.setting_int('backup.offsite_days', 7)   AS offsite_days,
  CASE
    WHEN c.last_created_at IS NULL THEN 'never'
    WHEN c.last_created_at < clock_timestamp()
         - make_interval(hours => platform.setting_int('backup.max_age_hours', 26)) THEN 'stale'
    ELSE 'ok'
  END AS backup_state,
  CASE
    WHEN d.last_downloaded_at IS NULL THEN 'never'
    WHEN d.last_downloaded_at < clock_timestamp()
         - make_interval(days => platform.setting_int('backup.offsite_days', 7)) THEN 'stale'
    ELSE 'ok'
  END AS offsite_state
FROM (SELECT max(occurred_at) AS last_created_at    FROM platform.backup_event WHERE kind = 'created')    c,
     (SELECT max(occurred_at) AS last_downloaded_at FROM platform.backup_event WHERE kind = 'downloaded') d;

COMMENT ON VIEW platform.backup_status IS
  'آخرین بکاپ و آخرین دانلود بیرونی، با مهلت از تنظیم‌ها. never بدتر از stale است.';

-- ── ۴. زنگ‌ها ─────────────────────────────────────────────────────────
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

  UNION ALL
  -- بکاپ موفقی در مهلت ساخته نشده (مهاجرت ۱۲۲). «هرگز» هم همین است.
  SELECT 'backup_stale', 'critical', 'بکاپ تازه‌ای ساخته نشده است',
         (s.backup_state <> 'ok')::int::bigint,
         CASE s.backup_state WHEN 'never' THEN 'هیچ بکاپی ثبت نشده'
              ELSE 'آخرین: ' || platform.business_date(s.last_created_at)::text END
    FROM platform.backup_status s

  UNION ALL
  -- نسخهٔ بیرون از سرور: کسی در مهلت بکاپ را از پنل دانلود نکرده (مهاجرت ۱۲۲).
  SELECT 'backup_offsite_stale', 'warn', 'نسخهٔ بیرون از سرور قدیمی است',
         (s.offsite_state <> 'ok')::int::bigint,
         CASE s.offsite_state WHEN 'never' THEN 'هیچ بکاپی دانلود نشده'
              ELSE 'آخرین دانلود: ' || platform.business_date(s.last_downloaded_at)::text END
    FROM platform.backup_status s

  UNION ALL
  -- پرداخت «در انتظار/نامعلوم» که بیش از یک ساعت مانده، به‌علاوهٔ قصد درگاهی
  -- که آخرین رویدادش «نامعلوم» است. هیچ‌کدام خودکار حل نمی‌شوند (مهاجرت ۱۲۲).
  SELECT 'payment_unresolved', 'warn', 'پرداخت بلاتکلیف منتظر بررسی',
         count(*)::bigint,
         coalesce('قدیمی‌ترین: ' || platform.business_date(min(x.at))::text, '—')
    FROM (SELECT p.occurred_at AS at
            FROM treasury.payment p
           WHERE p.status IN ('pending','unknown')
             AND p.occurred_at < clock_timestamp() - interval '1 hour'
          UNION ALL
          SELECT e.created_at
            FROM (SELECT DISTINCT ON (intent_id) intent_id, state, created_at
                    FROM sales.provider_intent_event
                   ORDER BY intent_id, version DESC) e
           WHERE e.state = 'unknown'
             AND e.created_at < clock_timestamp() - interval '1 hour') x
$function$;

UPDATE platform.setting
   SET options = coalesce(options, '[]'::jsonb)
       || '[{"value":"backup_stale","label":"بکاپ تازه‌ای ساخته نشده است"},
            {"value":"backup_offsite_stale","label":"نسخهٔ بیرون از سرور قدیمی است"},
            {"value":"payment_unresolved","label":"پرداخت بلاتکلیف منتظر بررسی"}]'::jsonb
 WHERE key = 'notify.health_alert_codes'
   AND NOT coalesce(options, '[]'::jsonb) @> '[{"value":"backup_stale"}]'::jsonb;

COMMIT;
