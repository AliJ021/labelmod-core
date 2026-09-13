-- =====================================================================
-- ۰۵۲ — `party_id` باید به شخصی اشاره کند که **وجود دارد**
-- =====================================================================
--
-- ── چه چیزی خراب بود ────────────────────────────────────────────────
--
-- `CLAUDE.md` قاعده را دارد: «هر سطر دریافتنی، امتیاز و بدهی
-- تأمین‌کننده `party_id` دارد. بدون آن گردش حساب اشخاص از دفتر ساختنی
-- نیست.» و ثابت CI هم همین را می‌سنجد:
--
--     party_type IN ('customer','supplier')  AND  party_id IS NULL   → خطا
--
-- ولی «داشتن» با «درست بودن» یکی نیست. `party_id` عمداً **کلید خارجی
-- ندارد** — چون چندریختی است (مشتری یا تأمین‌کننده) و یک FK نمی‌تواند
-- به دو جدول اشاره کند. نتیجه: هیچ‌چیز نمی‌سنجید که آن شناسه واقعاً
-- کسی باشد.
--
-- بازتولید، از **دروازهٔ مجاز** (`ledger.post_entry`) نه با درج مستقیم:
--
--     party_id = '00000000-0000-4000-8000-ffffffffffff'  (هیچ مشتری‌ای نیست)
--     → سند ساخته شد: 01a09b46-ae8e-76a0-a342-5f12b1804863
--     → سطر دریافتنی ۵٬۰۰۰٬۰۰۰ ریالی، متعلق به هیچ‌کس
--
--     ledger.report_party_balances('customer'):
--       party_type | name   | code   | balance
--       customer   | ‹NULL› | ‹NULL› | 5000000
--
-- یعنی یک مانده در **گزارش گردش حساب اشخاص** که نه نامی دارد، نه کد
-- تفصیلی، نه کسی که بتوان از او وصول کرد. و هیچ ثابتی نمی‌گرفتش: ثابت
-- CI `party_id IS NULL` را می‌سنجد و این سطر `party_id` **دارد**.
--
-- ── چرا Trigger و نه اصلاح `post_entry` ─────────────────────────────
--
-- Trigger روی `journal_line` از **هر** مسیری می‌گذرد — دروازه، درج
-- مستقیم، مهاجرت داده، سند دستی. اصلاح فقط `post_entry` یعنی اگر روزی
-- مسیر دومی ساخته شود، این قاعده را نمی‌داند. و همان فلسفهٔ ADR-001
-- است: «یک باگ در لایه اپلیکیشن نباید بتواند دفتر را خراب کند.»
--
-- ⚠️ `party_type = 'other'` (باربری، شخص حقیقی بی‌پرونده) جدولی ندارد و
--    مستثناست — همان استثنایی که ثابت CI هم دارد.
-- =====================================================================

CREATE OR REPLACE FUNCTION ledger.assert_party_exists() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.party_type = 'customer' THEN
    IF NOT EXISTS (SELECT 1 FROM sales.customer WHERE id = NEW.party_id) THEN
      RAISE EXCEPTION
        'سطر سند به مشتری ناموجود اشاره می‌کند (شناسه %). گردش حساب اشخاص از چنین سطری ساختنی نیست.',
        NEW.party_id;
    END IF;
  ELSIF NEW.party_type = 'supplier' THEN
    IF NOT EXISTS (SELECT 1 FROM purchasing.supplier WHERE id = NEW.party_id) THEN
      RAISE EXCEPTION
        'سطر سند به تأمین‌کننده ناموجود اشاره می‌کند (شناسه %).',
        NEW.party_id;
    END IF;
  ELSIF NEW.party_type IS NULL THEN
    -- شناسه بی نوع، بی‌معناست: نمی‌شود فهمید در کدام جدول بگردیم، و
    -- گزارش تفصیلی هم رهایش می‌کند.
    RAISE EXCEPTION
      'سطر سند شناسه شخص دارد ولی نوع شخص ندارد (شناسه %).', NEW.party_id;
  END IF;
  -- 'other' و هر نوع تازه‌ای که جدول ندارد: عبور.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS party_exists_t ON ledger.journal_line;
CREATE TRIGGER party_exists_t BEFORE INSERT ON ledger.journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_party_exists();

-- ---------------------------------------------------------------------
-- آشکارساز برای دادهٔ **موجود**
-- ---------------------------------------------------------------------
-- Trigger فقط درج‌های تازه را می‌گیرد. اگر روی یک دیتابیس قدیمی‌تر چنین
-- سطری از قبل باشد، این نما پیدایش می‌کند. سه نگاه‌کننده: ثابت‌های CI،
-- `ops/deploy.sh status`، و `ops/restore-drill.sh`.
CREATE OR REPLACE VIEW ledger.party_check AS
SELECT l.entry_id, l.line_no, l.account_code, l.party_type, l.party_id,
       l.debit, l.credit,
       CASE
         WHEN l.party_type IS NULL                      THEN 'no_party_type'
         WHEN l.party_type = 'customer'                 THEN 'missing_customer'
         WHEN l.party_type = 'supplier'                 THEN 'missing_supplier'
         ELSE 'unknown_party_type'
       END AS problem
  FROM ledger.journal_line l
 WHERE l.party_id IS NOT NULL
   AND (
     l.party_type IS NULL
     OR (l.party_type = 'customer'
         AND NOT EXISTS (SELECT 1 FROM sales.customer c WHERE c.id = l.party_id))
     OR (l.party_type = 'supplier'
         AND NOT EXISTS (SELECT 1 FROM purchasing.supplier s WHERE s.id = l.party_id))
   );

COMMENT ON VIEW ledger.party_check IS
  'سطر سند با شناسه شخصی که وجود ندارد — مانده‌ای در گردش اشخاص که مالک ندارد. باید خالی باشد.';
