-- =====================================================================
-- ۰۲۲ — تفصیلی اشخاص و مانده افتتاحیه
-- =====================================================================
-- دو قابلیتی که هلو و دشت دارند و کدینگ ما نداشت.
--
-- ── تفصیلی: چرا نما، نه حسابِ واقعی ─────────────────────────────────
--
-- در هلو هر مشتری یک حساب تفصیلی زیر «بدهکاران» است. وسوسه‌اش این بود
-- که ما هم به‌ازای هر مشتری یک سطر در `ledger.account` بسازیم.
--
-- **غلط بود.** این پروژه از روز اول مانده اشخاص را در خودِ سطر سند
-- نگه می‌دارد: `journal_line.party_type` و `party_id`. اگر حساب
-- تفصیلی جدا هم می‌ساختیم، مانده هر مشتری **دو منبع** پیدا می‌کرد و
-- دیر یا زود از هم جدا می‌افتادند — همان دوباره‌شماری که نگهبان درخت
-- حساب جلویش را می‌گیرد، فقط از راه دیگر.
--
-- پس تفصیلی اینجا یک **نما** روی همان داده است: کاربر همان چیزی را
-- می‌بیند که در هلو می‌دید (زیر معین، مشتری‌ها با مانده‌شان)، ولی
-- عدد از یک جا می‌آید.
--
-- تنها چیزی که واقعاً کم بود، **کد تفصیلی پایدار** برای هر شخص است —
-- که هلو دارد و آدم‌ها با آن حرف می‌زنند («مشتری ۱۲۰۱۰۳»).
--
-- ── افتتاحیه: قواعدش از قبل بود، امنیتش نبود ────────────────────────
--
-- `db/seed/020_posting_rules.sql` از اول رویداد `opening` را با شش
-- مؤلفه داشت. یعنی سند افتتاحیه **می‌شد** زد — ولی از psql، و بدون
-- هیچ نگهبانی. این مهاجرت همان را امن و از صفحه در دسترس می‌کند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. کد تفصیلی پایدار برای هر شخص
-- ---------------------------------------------------------------------
-- شماره است نه UUID، چون آدم‌ها با آن حرف می‌زنند و روی کاغذ
-- می‌نویسند. یکتا در هر نوع شخص، و هرگز بازاستفاده نمی‌شود.

CREATE SEQUENCE IF NOT EXISTS ledger.tafsili_no_seq START 1;

ALTER TABLE sales.customer
  ADD COLUMN IF NOT EXISTS tafsili_no integer;

ALTER TABLE purchasing.supplier
  ADD COLUMN IF NOT EXISTS tafsili_no integer;

UPDATE sales.customer
   SET tafsili_no = nextval('ledger.tafsili_no_seq')
 WHERE tafsili_no IS NULL;

UPDATE purchasing.supplier
   SET tafsili_no = nextval('ledger.tafsili_no_seq')
 WHERE tafsili_no IS NULL;

ALTER TABLE sales.customer
  ALTER COLUMN tafsili_no SET DEFAULT nextval('ledger.tafsili_no_seq');
ALTER TABLE purchasing.supplier
  ALTER COLUMN tafsili_no SET DEFAULT nextval('ledger.tafsili_no_seq');

ALTER TABLE sales.customer   ALTER COLUMN tafsili_no SET NOT NULL;
ALTER TABLE purchasing.supplier ALTER COLUMN tafsili_no SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customer_tafsili_no_idx
  ON sales.customer (tafsili_no);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_tafsili_no_idx
  ON purchasing.supplier (tafsili_no);

-- ---------------------------------------------------------------------
-- ۲. نمای تفصیلی اشخاص
-- ---------------------------------------------------------------------
-- همان چیزی که در هلو زیر یک معین دیده می‌شود: فهرست اشخاص با مانده.
-- `parent_code` از خودِ سند می‌آید، نه از یک نگاشت در کد — پس اگر
-- کدینگ عوض شود، این نما با آن می‌رود.

CREATE OR REPLACE VIEW ledger.party_tafsili AS
SELECT l.account_code                        AS parent_code,
       a.name                                AS parent_name,
       l.party_type,
       l.party_id,
       coalesce(c.tafsili_no, s.tafsili_no)  AS tafsili_no,
       -- کد نمایشی، همان شکلی که آدم‌ها می‌نویسند: معین + کد تفصیلی
       l.account_code || '-' ||
         lpad(coalesce(c.tafsili_no, s.tafsili_no)::text, 4, '0') AS code,
       coalesce(c.full_name, s.name)         AS party_name,
       sum(l.debit)                          AS debit,
       sum(l.credit)                         AS credit,
       -- مانده با **ماهیت حساب** معنا پیدا می‌کند: روی حساب بدهکار،
       -- بدهکار منهای بستانکار؛ روی بستانکار برعکس. بدون این، مانده
       -- بستانکاران همیشه منفی نشان داده می‌شد.
       CASE WHEN a.nature = 'debit'
            THEN sum(l.debit) - sum(l.credit)
            ELSE sum(l.credit) - sum(l.debit) END AS balance
  FROM ledger.journal_line l
  JOIN ledger.account a ON a.code = l.account_code
  LEFT JOIN sales.customer      c ON l.party_type = 'customer' AND c.id = l.party_id
  LEFT JOIN purchasing.supplier s ON l.party_type = 'supplier' AND s.id = l.party_id
 WHERE l.party_id IS NOT NULL
 GROUP BY l.account_code, a.name, a.nature, l.party_type, l.party_id,
          c.tafsili_no, s.tafsili_no, c.full_name, s.name;

COMMENT ON VIEW ledger.party_tafsili IS
  'تفصیلی اشخاص — از party_id سند ساخته می‌شود، نه از حساب جداگانه، تا مانده دو منبع پیدا نکند.';

-- ---------------------------------------------------------------------
-- ۳. سند افتتاحیه — امن
-- ---------------------------------------------------------------------
-- مؤلفه‌های مجاز از `posting_rule` می‌آیند (inventory، cash، bank،
-- receivable، payable، equity). این تابع چیزی به آن‌ها اضافه نمی‌کند؛
-- فقط نمی‌گذارد سند افتتاحیه در وضعیت غلط زده شود.

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

  -- توازن **پیش از** ثبت سنجیده می‌شود تا پیام فارسی و قابل فهم بدهد.
  -- بدون این، قید معوق دفتر خطای فنی می‌داد.
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
  -- اولین بار همیشه غلط وارد می‌شود؛ این واقعیتِ راه‌اندازی است. ولی
  -- به‌محض اینکه سند دیگری در آن سال خورده باشد، عوض‌کردن افتتاحیه
  -- یعنی جابه‌جا کردن زمینی که بقیه رویش ایستاده‌اند.
  SELECT e.id INTO v_old FROM ledger.journal_entry e
   WHERE e.kind = 'opening' AND e.branch_id = p_branch
     AND e.fiscal_year = p_year
     AND NOT EXISTS (SELECT 1 FROM ledger.journal_entry r WHERE r.reverses_id = e.id)
   LIMIT 1;

  IF v_old IS NOT NULL THEN
    SELECT count(*) INTO v_others FROM ledger.journal_entry
     WHERE fiscal_year = p_year AND branch_id = p_branch
       AND kind <> 'opening';

    IF v_others > 0 THEN
      RAISE EXCEPTION
        'سند افتتاحیه سال % از قبل هست و % سند دیگر رویش ثبت شده. اصلاحش زمینی را جابه‌جا می‌کند که بقیه رویش ایستاده‌اند.',
        p_year, v_others;
    END IF;

    -- سند حذف نمی‌شود — **معکوس** می‌شود. قاعده پروژه: اصلاح فقط با
    -- سند معکوس، تا ردّ حسابرسی نشکند.
    --
    -- سطرها مستقیم درج می‌شوند و نه از `post_entry`، چون معکوس باید
    -- **دقیقاً** آینه سند اصلی باشد: همان حساب‌ها، همان اشخاص، فقط
    -- بدهکار و بستانکار جابه‌جا. عبور دوباره از قواعد ثبت می‌توانست
    -- حساب دیگری بدهد اگر قاعده‌ای در این فاصله عوض شده باشد.
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
  END IF;

  v_entry := ledger.post_entry(
    'opening', p_branch, v_year.starts_on,
    'سند افتتاحیه سال ' || p_year, p_legs,
    'fiscal_year', NULL, p_user);

  PERFORM platform.audit('ledger.opening', 'fiscal_year', p_year::text,
    jsonb_build_object('branch', p_branch, 'entry', v_entry,
                       'replaced', v_old, 'debit', v_debit),
    p_user);

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION ledger.post_opening_balance IS
  'سند افتتاحیه: سال باز، توازن، و یک سند در هر سال — دومی اولی را معکوس می‌کند.';

COMMIT;
