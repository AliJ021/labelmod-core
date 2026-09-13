-- =====================================================================
-- ۰۴۹ — سند افتتاحیه: قفل مسابقه، پشتوانه دیتابیسی، و آشکارساز دفتر↔انبار
-- =====================================================================
-- مهاجرت ۰۲۲ در COMMENT خودش نوشت «یک سند در هر سال — دومی اولی را
-- معکوس می‌کند». آن قاعده درست بود ولی **اجبار نشده بود**: با یک
-- `SELECT … LIMIT 1` بدون قفل خوانده می‌شد و هیچ قیدی پشتش نبود.
--
-- ── چه چیزی واقعاً می‌شکست ───────────────────────────────────────────
--
-- **۱. مسابقه.** دو تراکنش هم‌زمان، هر دو `v_old` را NULL می‌دیدند (چون
--    زیر READ COMMITTED سطر Commit‌نشدهٔ دیگری دیده نمی‌شود)، هر دو سند
--    می‌زدند، و هیچ‌کدام معکوس نمی‌شد. نتیجه در یک بازتولید واقعی:
--
--        account 1101 (نقد)    debit  = 2000000   ← باید 1000000
--        account 3102 (سرمایه) credit = 2000000   ← باید 1000000
--
--    و خودبه‌خود هم درمان نمی‌شد: فراخوان سوم با `LIMIT 1` فقط **یکی**
--    از آن دو را معکوس می‌کرد و مازاد برای همیشه در دفتر می‌ماند.
--
-- **۲. معکوسِ ناقص.** `LIMIT 1` یعنی اگر به هر دلیلی دو سند باز وجود
--    داشت، فقط یکی معکوس می‌شد.
--
-- **۳. سندِ معکوس، خودش `kind = 'opening'` است.** درج معکوس با
--    `SELECT … e.kind …` ساخته می‌شود، پس نوعش را از سند اصلی کپی
--    می‌کند. ولی محمولِ «سند افتتاحیهٔ باز» در ۰۲۲ فقط
--    `NOT EXISTS (… r.reverses_id = e.id)` بود و `reverses_id IS NULL`
--    نداشت — یعنی **خودِ سند معکوس هم یک «سند باز» شمرده می‌شد**.
--
--    اثرش در فراخوان **سوم**: `LIMIT 1` بدون `ORDER BY` می‌توانست
--    سندِ معکوس را برگزیند و آن را معکوس کند. معکوسِ معکوس یعنی مبالغ
--    سند اول **دوباره به دفتر برگردند**. نتیجه نامعین بود — به
--    نقشهٔ اجرای پستگرس بستگی داشت.
--
--    این کلاس در همین مهاجرت بسته شد: هر سه محمول حالا
--    `e.reverses_id IS NULL` دارند و حلقه `ORDER BY created_at` است.
--
-- ── چرا قفل، و چرا قیدِ معوق **کافی نبود** ───────────────────────────
--
-- وسوسه این است که یک `CONSTRAINT TRIGGER` معوق بنویسیم و تمام. ولی
-- قید معوق این مسابقه را **نمی‌گیرد**: هر دو تراکنش در لحظهٔ COMMIT
-- شمارش می‌کنند و هیچ‌کدام سطر Commit‌نشدهٔ دیگری را نمی‌بیند — هر دو
-- «۱» می‌شمارند و هر دو Commit می‌شوند. این همان Write Skew کلاسیک است.
--
-- پس ترتیب دفاع اینجا **برعکس** بقیهٔ پروژه است:
--   قفل مشورتی تراکنشی → مسابقه را می‌بندد (تنها چیزی که می‌تواند)
--   قید معوق          → پشتوانه برای هر مسیر **غیرهم‌زمانِ** دیگر
--
-- قفل با COMMIT یا ROLLBACK آزاد می‌شود، پس نشستِ مرده قفل جا نمی‌گذارد.
--
-- ⚠️ ایندکس یکتای جزئی اینجا **ممکن نیست**: «معکوس‌نشده» یک شرط روی
--    جدول دیگر (وجود سطری با `reverses_id = e.id`) است و محمولِ ایندکس
--    جزئی نمی‌تواند زیرکوئری داشته باشد. `WHERE reverses_id IS NULL` هم
--    جانشین غلطی است — جانشینیِ مجاز (سند ۱، معکوسش، سند ۲) را می‌شکست.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. تابع افتتاحیه — با قفل، و با معکوس‌کردن **همهٔ** سندهای باز
-- ---------------------------------------------------------------------
-- کل تابع دوباره تعریف می‌شود؛ نسخهٔ معتبر همیشه آخرین تعریف است.
-- تنها دو تفاوت با نسخهٔ ۰۲۲: قفل در ابتدا، و حلقه به‌جای `LIMIT 1`.

CREATE OR REPLACE FUNCTION ledger.post_opening_balance(
  p_branch uuid,
  p_year   smallint,
  p_legs   jsonb,
  p_user   uuid
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_year   ledger.fiscal_year%ROWTYPE;
  v_old    uuid;
  v_rev    uuid;
  v_others int;
  v_open   int;
  v_entry  uuid;
  v_debit  platform.money := 0;
  v_credit platform.money := 0;
  v_leg    jsonb;
  v_side   text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'ثبت سند افتتاحیه بدون کاربر عامل مجاز نیست.';
  END IF;
  PERFORM platform.set_actor(p_user);

  -- ── قفل، پیش از هر خواندن ───────────────────────────────────────
  -- هویت این عملیات (شعبه، سال) است. قفل باید **قبل از** خواندن
  -- `v_old` گرفته شود، وگرنه همان مسابقه سر جایش می‌ماند.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ledger.opening:' || p_branch::text || ':' || p_year::text, 0));

  SELECT * INTO v_year FROM ledger.fiscal_year WHERE id = p_year;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'سال مالی % تعریف نشده است.', p_year;
  END IF;
  IF v_year.status <> 'open' THEN
    RAISE EXCEPTION 'سال مالی % باز نیست (وضعیت: %).', p_year, v_year.status;
  END IF;

  IF jsonb_array_length(coalesce(p_legs, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'سند افتتاحیه بدون سطر معنا ندارد.';
  END IF;

  FOR v_leg IN SELECT * FROM jsonb_array_elements(p_legs)
  LOOP
    SELECT side INTO v_side FROM ledger.posting_rule
     WHERE event_type = 'opening' AND leg = (v_leg->>'leg') AND is_active
     LIMIT 1;
    IF v_side IS NULL THEN
      RAISE EXCEPTION 'مؤلفه «%» در قواعد سند افتتاحیه تعریف نشده است.', v_leg->>'leg';
    END IF;
    IF v_side = 'debit'
      THEN v_debit  := v_debit  + (v_leg->>'amount')::platform.money;
      ELSE v_credit := v_credit + (v_leg->>'amount')::platform.money;
    END IF;
  END LOOP;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'سند افتتاحیه متوازن نیست: بدهکار % و بستانکار %. تفاوت % را در «سود و زیان انباشته» بگذارید.',
      v_debit, v_credit, abs(v_debit - v_credit);
  END IF;

  -- ── افتتاحیه دوباره ─────────────────────────────────────────────
  SELECT count(*) INTO v_open FROM ledger.journal_entry e
   WHERE e.kind = 'opening' AND e.branch_id = p_branch
     AND e.fiscal_year = p_year
     AND e.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ledger.journal_entry r WHERE r.reverses_id = e.id);

  IF v_open > 0 THEN
    SELECT count(*) INTO v_others FROM ledger.journal_entry
     WHERE fiscal_year = p_year AND branch_id = p_branch
       AND kind <> 'opening';

    IF v_others > 0 THEN
      RAISE EXCEPTION
        'سند افتتاحیه سال % از قبل هست و % سند دیگر رویش ثبت شده. اصلاحش زمینی را جابه‌جا می‌کند که بقیه رویش ایستاده‌اند.',
        p_year, v_others;
    END IF;

    -- **همهٔ** سندهای باز معکوس می‌شوند، نه فقط اولی. اگر دادهٔ قدیمی
    -- از پیش دو سند باز داشته باشد، همین‌جا جمع می‌شود.
    FOR v_old IN
      SELECT e.id FROM ledger.journal_entry e
       WHERE e.kind = 'opening' AND e.branch_id = p_branch
         AND e.fiscal_year = p_year
         AND e.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ledger.journal_entry r WHERE r.reverses_id = e.id)
       ORDER BY e.created_at
    LOOP
      INSERT INTO ledger.journal_entry
        (number, fiscal_year, branch_id, entry_date, kind, status,
         description, ref_type, ref_id, reverses_id, created_by)
      SELECT platform.next_document_no(p_branch, 'journal', p_year),
             e.fiscal_year, e.branch_id, e.entry_date, e.kind, e.status,
             'معکوس ' || e.description, e.ref_type, e.ref_id, e.id, p_user
        FROM ledger.journal_entry e WHERE e.id = v_old
      RETURNING id INTO v_rev;

      INSERT INTO ledger.journal_line
        (entry_id, line_no, account_code, debit, credit,
         party_type, party_id, description)
      SELECT v_rev, l.line_no, l.account_code, l.credit, l.debit,
             l.party_type, l.party_id, 'معکوس ' || l.description
        FROM ledger.journal_line l WHERE l.entry_id = v_old;
    END LOOP;
  END IF;

  v_entry := ledger.post_entry(
    'opening', p_branch, v_year.starts_on,
    'سند افتتاحیه سال ' || p_year, p_legs,
    'fiscal_year', NULL, p_user);

  PERFORM platform.audit('ledger.opening', 'fiscal_year', p_year::text,
    jsonb_build_object('branch', p_branch, 'entry', v_entry,
                       'replaced_count', v_open, 'debit', v_debit),
    p_user);

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION ledger.post_opening_balance IS
  'سند افتتاحیه: سال باز، توازن، و یک سند باز در هر (شعبه، سال) — با قفل تراکنشی و معکوس‌کردن همه سندهای باز.';

-- ---------------------------------------------------------------------
-- ۲. پشتوانه: بیش از یک سند افتتاحیهٔ باز در هر (شعبه، سال) ممنوع
-- ---------------------------------------------------------------------
-- این قید مسابقه را نمی‌گیرد (توضیحش بالا) و قرار هم نیست بگیرد. کارش
-- بستنِ هر مسیر دیگری است: درج دستی در psql، اسکریپت مهاجرت داده، یا
-- تابعی که فردا نوشته شود و قفل را فراموش کند.
--
-- معوق است چون تابع بالا اول سند تازه را می‌زند و بعد… نه، برعکس:
-- اول معکوس می‌کند بعد سند تازه. ولی در همان تراکنش لحظه‌ای هست که
-- سند معکوس درج شده و سند تازه نه — پس بررسی فوری خطای کاذب می‌داد.

CREATE OR REPLACE FUNCTION ledger.assert_single_open_opening() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM ledger.journal_entry e
   WHERE e.kind = 'opening'
     AND e.branch_id = NEW.branch_id
     AND e.fiscal_year = NEW.fiscal_year
     AND e.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ledger.journal_entry r WHERE r.reverses_id = e.id);

  IF v_n > 1 THEN
    RAISE EXCEPTION
      'سال % شعبه % بیش از یک سند افتتاحیه باز دارد (%). سند افتتاحیه جانشین باید سند قبلی را معکوس کند.',
      NEW.fiscal_year, NEW.branch_id, v_n;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS single_open_opening_t ON ledger.journal_entry;
CREATE CONSTRAINT TRIGGER single_open_opening_t
  AFTER INSERT ON ledger.journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'opening')
  EXECUTE FUNCTION ledger.assert_single_open_opening();

-- ---------------------------------------------------------------------
-- ۳. آشکارساز گمشده: دفتر ↔ ارزش واقعی انبار
-- ---------------------------------------------------------------------
-- بلوک ثابت‌های CI برای چک یک `treasury.cheque_check` دارد که **دفتر را
-- با پروندهٔ چک** تطبیق می‌دهد. برای انبار قرینه‌اش نبود:
-- `inventory.balance_check` فقط `stock_balance` را با `stock_movement`
-- می‌سنجد — هر دو **درون ماژول انبار**. به دفتر کاری ندارد.
--
-- یعنی هیچ‌کس نمی‌پرسید «آیا حساب موجودی کالا با ارزش واقعی انبار
-- می‌خواند؟» — و باگ سند افتتاحیه دقیقاً از همین شکاف رد شد.
--
-- ⚠️ **جمع کل**، نه به‌ازای هر انبار: انتقال بین انبارها ارزش را
--    جابه‌جا می‌کند و سندی نمی‌زند (هر دو طرف همان حساب‌اند)، پس
--    تفکیک انباری هشدار کاذب می‌داد.
--
-- ⚠️ کد حساب از `ledger.posting_rule` خوانده می‌شود، نه hardcode —
--    قاعدهٔ «نگاشت حساب فقط در posting_rule است».

CREATE OR REPLACE VIEW inventory.ledger_check AS
WITH acct AS (
  SELECT DISTINCT account_code FROM ledger.posting_rule
   WHERE leg = 'inventory' AND is_active
),
book AS (
  SELECT coalesce(sum(l.debit - l.credit), 0)::numeric AS value
    FROM ledger.journal_line l
   WHERE l.account_code IN (SELECT account_code FROM acct)
),
real AS (
  SELECT coalesce(sum(total_value), 0)::numeric AS value
    FROM inventory.stock_balance
)
SELECT (SELECT account_code FROM acct ORDER BY account_code LIMIT 1) AS account_code,
       b.value AS ledger_value,
       r.value AS stock_value,
       b.value - r.value AS diff
  FROM book b CROSS JOIN real r;

COMMENT ON VIEW inventory.ledger_check IS
  'مانده حساب موجودی کالا در دفتر در برابر ارزش واقعی stock_balance. diff <> 0 یعنی واگرایی دفتر و انبار.';

COMMIT;
