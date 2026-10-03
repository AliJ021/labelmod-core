-- =====================================================================
-- ۰۹۰ — مسیر ارتقای نصب‌هایی که نسخهٔ اولیهٔ ۰۶۵ یا ۰۷۰ را اجرا کرده‌اند
-- =====================================================================
--
-- یافته‌های امنیتی FND33 و FND34: «Edited migration prevents the journal
-- guard fix from deploying» و «Editing migration 065 blocks existing
-- database upgrades».
--
-- ۰۶۵ (۱ مهر) و ۰۷۰ (۱ مهر) پس از اجرا ویرایش شدند. `ops/db.sh migrate`
-- هش هر مهاجرت اجراشده را می‌سنجد و به‌درستی روی ویرایش می‌ایستد؛ پس
-- نصبی که نسخهٔ **اولیهٔ** آن‌ها را اجرا کرده بود هرگز به نسخهٔ بعد
-- نمی‌رسید — و ترمیم ۰۷۰ (رد شناسهٔ تراکنشِ تکراری پس از بازیابی بکاپ)
-- هیچ‌وقت رویش نمی‌نشست.
--
-- راه، افزایشی است، نه بازنویسی تاریخ:
--
--   • این مهاجرت تفاوتِ نسخهٔ اولیه و نسخهٔ جاری را دوباره اعمال می‌کند:
--     ستون `creation_xact_started_at` (اگر نیست) و بدنهٔ جاری سه تابع.
--     هیچ مهاجرت بعدی این سه تابع را دوباره تعریف نکرده است، پس بدنهٔ
--     جاری همان تعریف مؤثر است و اینجا برگرداندنش چیزی را عقب نمی‌برد.
--   • روی نصب تازه بی‌اثر است: ستون هست و بدنه‌ها یکسان‌اند.
--   • `ops/db.sh` فقط **همان دو هش تاریخی دقیق** را می‌پذیرد، و فقط چون
--     این فایل وجود دارد. هر ویرایش دیگری همچنان ارتقا را متوقف می‌کند.
--
-- ⚠️ اگر روزی یکی از این سه تابع در مهاجرت تازه‌ای عوض شد، آن مهاجرت
--    بعد از این یکی اجرا می‌شود و برنده است؛ این فایل را ویرایش نکنید.
-- =====================================================================
BEGIN;

-- ── ۰۷۰: ستونی که نسخهٔ اولیه نداشت ─────────────────────────────────
ALTER TABLE ledger.journal_entry ADD COLUMN IF NOT EXISTS creation_xact_started_at timestamptz;

-- ── ۰۷۰: بدنهٔ جاری دو نگهبان سند ───────────────────────────────────
CREATE OR REPLACE FUNCTION ledger.protect_final_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.creation_xact := pg_current_xact_id();
    NEW.creation_xact_started_at := transaction_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('confirmed','final') THEN
      RAISE EXCEPTION 'سند نهایی حذف نمی‌شود. از سند معکوس استفاده کنید.';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.creation_xact IS DISTINCT FROM OLD.creation_xact
     OR NEW.creation_xact_started_at IS DISTINCT FROM OLD.creation_xact_started_at THEN
    RAISE EXCEPTION 'شناسه تراکنش ساخت سند تغییر نمی‌کند.';
  END IF;
  IF OLD.status IN ('confirmed','final') AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (OLD.status = 'confirmed' AND NEW.status = 'final'
            AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')) THEN
      RAISE EXCEPTION 'سند تأییدشده بازنویسی نمی‌شود. از سند معکوس استفاده کنید.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ledger.protect_posted_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_entry record; v_old uuid; v_new uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := OLD.entry_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new := NEW.entry_id; END IF;
  -- هر دو والد هنگام جابه‌جایی سطر کنترل می‌شوند؛ ترتیب قفل ثابت است.
  FOR v_entry IN
    SELECT id, status, creation_xact, creation_xact_started_at FROM ledger.journal_entry
     WHERE id IN (v_old, v_new) ORDER BY id FOR UPDATE
  LOOP
    IF v_entry.status IN ('confirmed','final') AND
       (TG_OP <> 'INSERT' OR v_entry.creation_xact IS DISTINCT FROM pg_current_xact_id()
        OR v_entry.creation_xact_started_at IS DISTINCT FROM transaction_timestamp()) THEN
      RAISE EXCEPTION 'سطر سند تأییدشده تغییر نمی‌کند یا حذف نمی‌شود و سطر تازه نمی‌پذیرد. اصلاح فقط با سند معکوس.';
    END IF;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;

-- ── ۰۶۵: بدنهٔ جاری تطبیق محتوای حسابرسی (سریع‌تر، همان نتیجه) ──────
CREATE OR REPLACE FUNCTION platform.audit_content_matches(
 p_hash text,p_version smallint,p_prev text,p_at timestamptz,p_actor uuid,
 p_action text,p_entity text,p_id text,p_after jsonb,p_before jsonb,p_reason text,p_correlation text
) RETURNS boolean LANGUAGE plpgsql STABLE
SET search_path TO pg_catalog,public SET TimeZone TO 'UTC' AS $$
DECLARE zone text;
BEGIN
 IF p_version NOT IN (1,2,3,4) OR p_hash IS NULL THEN RETURN false; END IF;
 IF p_hash=platform.audit_hash(p_version,p_prev,p_at,p_actor,p_action,p_entity,p_id,p_after,p_before,p_reason,p_correlation) THEN RETURN true; END IF;
 IF p_version=4 THEN RETURN false; END IF;
 -- Most legacy writers used the application zone. Check it before enumerating
 -- historical offsets, so a large existing audit trail remains cheap to verify.
 PERFORM set_config('TimeZone','Asia/Tehran',true);
 IF p_hash=platform.audit_hash(p_version,p_prev,p_at,p_actor,p_action,p_entity,p_id,p_after,p_before,p_reason,p_correlation) THEN RETURN true; END IF;
 -- Legacy formats serialized timestamptz using the writer's session zone.
 -- Try each distinct historical offset, not the reader's current zone. The
 -- instant and every originally hashed field still have to match exactly.
 FOR zone IN SELECT min(name) FROM pg_timezone_names
   GROUP BY (p_at AT TIME ZONE name)-(p_at AT TIME ZONE 'UTC')
 LOOP
   PERFORM set_config('TimeZone',zone,true);
   IF p_hash=platform.audit_hash(p_version,p_prev,p_at,p_actor,p_action,p_entity,p_id,p_after,p_before,p_reason,p_correlation) THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;

COMMIT;
