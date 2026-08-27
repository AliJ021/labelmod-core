-- =====================================================================
-- ۰۰۵ — چک دریافتی و پرداختی
-- =====================================================================
-- تنها بخش خزانه که تا امروز جدول نداشت. بدون آن، چکی که مشتری می‌دهد
-- یا چکی که به تأمین‌کننده می‌دهیم هیچ ردی در سیستم ندارد و مانده
-- «حساب دریافتنی» و «حساب پرداختنی» واقعیت را نشان نمی‌دهد.
--
-- چرا چک یک ماژول جداست و نه یک روش پرداخت:
--   چک در لحظه دریافت پول نیست — یک وعده است. مسیرش چند مرحله دارد و
--   هر مرحله سند خودش را می‌زند: دریافت، واگذاری، وصول، برگشت، خرج.
--   اگر مثل نقد رفتار می‌کرد، درآمدی که هنوز وصول نشده نقد شمرده می‌شد.
--
-- ⚠️ دامنه این مهاجرت: چکِ سندِ مستقل — دریافت از مشتری بابت بدهی، و
--    پرداخت به تأمین‌کننده. «چک به‌عنوان روش پرداخت داخل فاکتور فروش»
--    عمداً اینجا نیست: نیازمند تغییر sales.post_batch و tender است و
--    رفتار هسته فروش را عوض می‌کند. آن یک تصمیم جداگانه است.
--
-- حساب‌های تازه (در db/seed/010_accounts.sql):
--   ۱۵۰۱ اسناد دریافتنی — چک نزد ما
--   ۱۵۰۲ اسناد دریافتنی — چک در جریان وصول
--   ۱۵۰۳ اسناد دریافتنی — چک برگشتی
--   ۲۴۰۱ اسناد پرداختنی — چک صادرشده
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. برگه چک
-- ---------------------------------------------------------------------
-- یک سطر به‌ازای هر برگه فیزیکی. مبلغ و سررسید روی برگه نوشته شده و
-- تغییر نمی‌کنند؛ آنچه حرکت می‌کند وضعیت است و هر حرکت در
-- treasury.cheque_event ثبت می‌شود.

CREATE TABLE treasury.cheque (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number        text,                       -- شماره سند داخلی، در اولین ثبت
  direction     text NOT NULL CHECK (direction IN ('received','issued')),
  branch_id     uuid NOT NULL REFERENCES platform.branch(id),

  -- مشخصات روی برگه ------------------------------------------------
  cheque_no     text NOT NULL,              -- شماره چک
  sayad_id      text,                       -- شناسه صیادی ۱۶ رقمی
  bank_name     text NOT NULL,
  bank_branch   text,
  account_no    text,
  drawer_name   text,                       -- صادرکننده (چک دریافتی)
  amount        platform.money NOT NULL CHECK (amount > 0),
  issued_on     date NOT NULL,
  due_on        date NOT NULL,

  -- طرف حساب --------------------------------------------------------
  -- بدون شخص، گردش حساب چک از دفتر ساختنی نیست — همان قاعده H9.
  -- چک دریافتی بدهی مشتری را تسویه می‌کند و چک پرداختی بدهی به
  -- تأمین‌کننده را؛ پس شخصِ بی‌پرونده اینجا جا ندارد.
  party_type    text NOT NULL CHECK (party_type IN ('customer','supplier')),
  party_id      uuid NOT NULL,

  -- حساب بانکی خودمان که چک پرداختی از آن صادر شده
  bank_account_id    uuid REFERENCES treasury.account(id),
  -- حساب بانکی که چک دریافتی به آن واگذار شده
  deposit_account_id uuid REFERENCES treasury.account(id),

  status        text NOT NULL DEFAULT 'draft' CHECK (status IN (
                  'draft',                  -- ثبت شده، هنوز سند نخورده
                  'in_hand',                -- دریافتی، نزد ما
                  'deposited',              -- دریافتی، در جریان وصول
                  'endorsed',               -- دریافتی، خرج‌شده به تأمین‌کننده
                  'issued',                 -- پرداختی، نزد دارنده
                  'cleared',                -- وصول یا پاس شد
                  'bounced',                -- برگشت خورد
                  'settled',                -- چک برگشتی به بدهی عادی منتقل شد
                  'cancelled')),

  client_event_id text UNIQUE,
  note          text,
  created_by    uuid REFERENCES identity.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (branch_id, number),
  -- یک برگه چک دوبار ثبت نشود. شماره چک تنها در دامنه یک بانک یکتاست.
  UNIQUE (direction, bank_name, cheque_no),

  CONSTRAINT cheque_due_after_issue CHECK (due_on >= issued_on),
  -- سمت چک و نوع شخص باید بخوانند، وگرنه سند به حساب غلط می‌نشیند
  CONSTRAINT cheque_party_matches_direction CHECK (
    (direction = 'received' AND party_type = 'customer') OR
    (direction = 'issued'   AND party_type = 'supplier')),
  -- چک پرداختی از حساب بانکی خودمان صادر می‌شود و طرفش تأمین‌کننده است
  CONSTRAINT issued_needs_bank_account CHECK (
    direction <> 'issued' OR bank_account_id IS NOT NULL)
);

CREATE INDEX ON treasury.cheque (branch_id, due_on) WHERE status IN
  ('in_hand','deposited','issued');
CREATE INDEX ON treasury.cheque (party_type, party_id);
CREATE INDEX ON treasury.cheque (status, direction);

COMMENT ON TABLE treasury.cheque IS
  'برگه چک دریافتی و پرداختی. مبلغ و سررسید تغییرناپذیرند؛ وضعیت فقط با treasury.post_cheque_event حرکت می‌کند.';

-- مبلغ، سررسید و شماره چک پس از اولین سند تغییر نمی‌کنند. اگر مبلغ
-- عوض شود، سندی که زده شده دیگر با برگه نمی‌خواند و مغایرت بی‌صدا
-- می‌ماند — همان الگویی که در C4 برای سطر سند بسته شد.
CREATE OR REPLACE FUNCTION treasury.protect_posted_cheque() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.amount    IS DISTINCT FROM OLD.amount
  OR NEW.due_on    IS DISTINCT FROM OLD.due_on
  OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
  OR NEW.cheque_no IS DISTINCT FROM OLD.cheque_no
  OR NEW.direction IS DISTINCT FROM OLD.direction THEN
    RAISE EXCEPTION
      'چک % سند خورده است؛ مبلغ، تاریخ و شماره آن تغییر نمی‌کند. اصلاح فقط با ابطال و ثبت برگه جدید.',
      OLD.cheque_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_posted_cheque_t BEFORE UPDATE ON treasury.cheque
  FOR EACH ROW EXECUTE FUNCTION treasury.protect_posted_cheque();

-- ---------------------------------------------------------------------
-- ۲. رویدادهای چک — تغییرناپذیر، مثل حرکت انبار
-- ---------------------------------------------------------------------
-- وضعیت جاری چک یک Projection است؛ مرجع، همین زنجیره رویداد است.

CREATE TABLE treasury.cheque_event (
  id          uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  cheque_id   uuid NOT NULL REFERENCES treasury.cheque(id),
  seq         smallint NOT NULL,
  action      text NOT NULL CHECK (action IN
                ('receive','deposit','clear','bounce','endorse',
                 'settle','issue','pay','cancel')),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  occurred_on date NOT NULL,
  amount      platform.money NOT NULL,
  entry_id    uuid REFERENCES ledger.journal_entry(id),   -- NULL = رویداد بدون اثر مالی
  account_id  uuid REFERENCES treasury.account(id),
  party_type  text,
  party_id    uuid,
  note        text,
  created_by  uuid REFERENCES identity.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cheque_id, seq)
);
CREATE INDEX ON treasury.cheque_event (cheque_id, seq);

CREATE OR REPLACE FUNCTION treasury.cheque_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'رویداد چک قابل تغییر یا حذف نیست. اصلاح فقط با رویداد بعدی.';
END $$;
CREATE TRIGGER cheque_event_immutable_t BEFORE UPDATE OR DELETE ON treasury.cheque_event
  FOR EACH ROW EXECUTE FUNCTION treasury.cheque_event_immutable();

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۳. تنها دروازه تغییر وضعیت چک
-- ---------------------------------------------------------------------
-- همان الگوی inventory.apply_movement و ledger.post_entry: هیچ‌جا
-- UPDATE مستقیم روی status. هر حرکت اینجا اعتبارسنجی، سند و حسابرسی
-- خودش را می‌گیرد.
--
-- ماشین وضعیت — هر چیزی جز این‌ها خطا می‌دهد:
--
--   دریافتی: draft ──receive──→ in_hand ──deposit──→ deposited
--                                  │                    ├─clear──→ cleared
--                                  │                    └─bounce─→ bounced
--                                  └─endorse─→ endorsed ─bounce──→ bounced
--            bounced ──settle──→ settled        (به بدهی عادی مشتری)
--            draft   ──cancel──→ cancelled      (بدون سند)
--
--   پرداختی: draft ──issue──→ issued ──pay────→ cleared
--                                │    ──bounce─→ bounced   (بدون سند)
--                                └────cancel───→ cancelled
--            draft   ──cancel──→ cancelled      (بدون سند)
--
-- چرا «برگشت چک پرداختی» سند ندارد: بدهی ما سر جایش است. برگشت خوردن
-- چکِ خودمان هیچ مانده‌ای را جابه‌جا نمی‌کند. سند زدن برای رویدادی که
-- اثر مالی ندارد، دفتر را شلوغ و حسابرسی را گمراه می‌کند.

CREATE OR REPLACE FUNCTION treasury.post_cheque_event(
  p_cheque   uuid,
  p_action   text,
  p_user     uuid DEFAULT NULL,
  p_account  uuid DEFAULT NULL,   -- حساب بانکی: واگذاری، وصول، پاس‌شدن
  p_party_id uuid DEFAULT NULL,   -- تأمین‌کننده گیرنده، هنگام خرج‌کردن
  p_on       date DEFAULT NULL,   -- تاریخ رویداد، پیش‌فرض امروز
  p_note     text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  c        treasury.cheque%ROWTYPE;
  acct     treasury.account%ROWTYPE;
  v_to     text;
  v_event  text;
  v_legs   jsonb;
  v_entry  uuid;
  v_fy     smallint;
  v_seq    smallint;
  v_on     date;
  v_endorsee uuid;
  v_allow  boolean;
  v_max_days int;
  v_number text;
BEGIN
  SELECT * INTO c FROM treasury.cheque WHERE id = p_cheque FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'چک یافت نشد'; END IF;

  v_on := coalesce(p_on, current_date);

  -- ---------------- ماشین وضعیت ----------------
  IF c.direction = 'received' THEN
    v_to := CASE
      WHEN p_action = 'receive' AND c.status = 'draft'                      THEN 'in_hand'
      WHEN p_action = 'deposit' AND c.status = 'in_hand'                    THEN 'deposited'
      WHEN p_action = 'clear'   AND c.status = 'deposited'                  THEN 'cleared'
      WHEN p_action = 'bounce'  AND c.status IN ('deposited','endorsed')    THEN 'bounced'
      WHEN p_action = 'endorse' AND c.status = 'in_hand'                    THEN 'endorsed'
      WHEN p_action = 'settle'  AND c.status = 'bounced'                    THEN 'settled'
      WHEN p_action = 'cancel'  AND c.status = 'draft'                      THEN 'cancelled'
    END;
  ELSE  -- issued
    v_to := CASE
      WHEN p_action = 'issue'  AND c.status = 'draft'                       THEN 'issued'
      WHEN p_action = 'pay'    AND c.status = 'issued'                      THEN 'cleared'
      WHEN p_action = 'bounce' AND c.status = 'issued'                      THEN 'bounced'
      WHEN p_action = 'cancel' AND c.status IN ('draft','issued')           THEN 'cancelled'
    END;
  END IF;

  -- Idempotency: تکرار همان عمل روی وضعیتی که قبلاً به آن رسیده،
  -- سند دوم نمی‌سازد. Retry لایه API نباید دفتر را دو بار بزند.
  IF v_to IS NULL THEN
    SELECT entry_id INTO v_entry FROM treasury.cheque_event
     WHERE cheque_id = p_cheque AND action = p_action AND to_status = c.status
     ORDER BY seq DESC LIMIT 1;
    IF FOUND THEN RETURN v_entry; END IF;

    RAISE EXCEPTION
      'عمل «%» روی چک % با وضعیت «%» مجاز نیست', p_action, c.cheque_no, c.status;
  END IF;

  -- ---------------- اعتبارسنجی ورودی ----------------
  IF p_action IN ('deposit','clear','pay') THEN
    -- وصول و پاس‌شدنِ چک پرداختی از حساب بانکی خودِ چک انجام می‌شود
    IF p_action = 'pay' AND p_account IS NULL THEN
      SELECT * INTO acct FROM treasury.account WHERE id = c.bank_account_id;
    ELSIF p_action = 'clear' AND p_account IS NULL THEN
      SELECT * INTO acct FROM treasury.account WHERE id = c.deposit_account_id;
    ELSE
      SELECT * INTO acct FROM treasury.account WHERE id = p_account;
    END IF;

    IF acct.id IS NULL THEN
      RAISE EXCEPTION 'حساب بانکی برای عمل «%» روی چک % تعیین نشده است', p_action, c.cheque_no;
    END IF;
    IF acct.kind <> 'bank' THEN
      RAISE EXCEPTION
        'چک فقط به حساب بانکی می‌نشیند، نه به % (حساب %)', acct.kind, acct.code;
    END IF;
  END IF;

  -- وعده بلند یک ریسک اعتباری است، نه یک جزئیات. سقفش داده است نه کد.
  IF p_action IN ('receive','issue') THEN
    SELECT (value)::int INTO v_max_days FROM platform.setting WHERE key = 'cheque.max_due_days';
    IF v_max_days IS NOT NULL AND (c.due_on - c.issued_on) > v_max_days THEN
      RAISE EXCEPTION
        'وعده چک % برابر % روز است و از سقف % روز می‌گذرد (تنظیم cheque.max_due_days). نیازمند تصمیم صریح مدیر.',
        c.cheque_no, c.due_on - c.issued_on, v_max_days;
    END IF;
  END IF;

  IF p_action = 'endorse' THEN
    SELECT (value)::boolean INTO v_allow FROM platform.setting WHERE key = 'cheque.allow_endorse';
    IF NOT coalesce(v_allow, false) THEN
      RAISE EXCEPTION
        'خرج‌کردن چک دریافتی خاموش است (تنظیم cheque.allow_endorse). این تصمیم حسابدار است، نه کد.';
    END IF;
    IF p_party_id IS NULL THEN
      RAISE EXCEPTION 'خرج‌کردن چک بدون تأمین‌کننده گیرنده ممکن نیست';
    END IF;
    PERFORM 1 FROM purchasing.supplier WHERE id = p_party_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'تأمین‌کننده گیرنده چک یافت نشد'; END IF;
  END IF;

  -- ---------------- ساخت سند ----------------
  v_event := NULL; v_legs := NULL;

  IF c.direction = 'received' THEN
    IF p_action = 'receive' THEN
      v_event := 'cheque_receive';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','cheque_in_hand','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','receivable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'deposit' THEN
      v_event := 'cheque_deposit';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','in_collection','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','cheque_in_hand','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'clear' THEN
      v_event := 'cheque_clear';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','bank','amount', c.amount,
                           'account_code', acct.ledger_account_code),
        jsonb_build_object('leg','in_collection','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'endorse' THEN
      v_event := 'cheque_endorse';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','payable','amount', c.amount,
                           'party_type','supplier','party_id', p_party_id),
        jsonb_build_object('leg','cheque_in_hand','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'bounce' THEN
      v_event := 'cheque_bounce';
      IF c.status = 'deposited' THEN
        -- از جریان وصول برمی‌گردد
        v_legs := jsonb_build_array(
          jsonb_build_object('leg','returned','amount', c.amount,
                             'party_type', c.party_type, 'party_id', c.party_id),
          jsonb_build_object('leg','in_collection','amount', c.amount,
                             'party_type', c.party_type, 'party_id', c.party_id));
      ELSE
        -- خرج‌شده بود و تأمین‌کننده پسش داده: بدهی به او زنده می‌شود
        SELECT party_id INTO v_endorsee FROM treasury.cheque_event
         WHERE cheque_id = p_cheque AND action = 'endorse' ORDER BY seq DESC LIMIT 1;
        IF v_endorsee IS NULL THEN
          RAISE EXCEPTION 'چک خرج‌شده بدون رویداد خرج‌کردن — زنجیره رویداد ناقص است';
        END IF;
        v_legs := jsonb_build_array(
          jsonb_build_object('leg','returned','amount', c.amount,
                             'party_type', c.party_type, 'party_id', c.party_id),
          jsonb_build_object('leg','payable_back','amount', c.amount,
                             'party_type','supplier','party_id', v_endorsee));
      END IF;

    ELSIF p_action = 'settle' THEN
      v_event := 'cheque_bounce_settle';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','receivable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','returned','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));
    END IF;
    -- cancel روی draft: سندی زده نشده که معکوس شود

  ELSE  -- issued
    IF p_action = 'issue' THEN
      v_event := 'cheque_issue';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','cheque_payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'pay' THEN
      v_event := 'cheque_pay';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','cheque_payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','bank','amount', c.amount,
                           'account_code', acct.ledger_account_code));

    ELSIF p_action = 'cancel' AND c.status = 'issued' THEN
      -- ابطال چک صادرشده: بدهی از «اسناد پرداختنی» به «پرداختنی تجاری» برمی‌گردد
      v_event := 'cheque_cancel_issued';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','cheque_payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));
    END IF;
    -- bounce روی چک پرداختی: بدهی جابه‌جا نمی‌شود، پس سند ندارد
  END IF;

  IF v_event IS NOT NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year WHERE v_on BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', v_on;
    END IF;

    v_entry := ledger.post_entry(
      v_event, c.branch_id, v_on,
      'چک ' || c.cheque_no || ' — ' || v_event || coalesce(' — ' || p_note, ''),
      v_legs, 'treasury_cheque', p_cheque, p_user);
  END IF;

  -- ---------------- ثبت رویداد و وضعیت ----------------
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM treasury.cheque_event WHERE cheque_id = p_cheque;

  INSERT INTO treasury.cheque_event
    (cheque_id, seq, action, from_status, to_status, occurred_on, amount,
     entry_id, account_id, party_type, party_id, note, created_by)
  VALUES
    (p_cheque, v_seq, p_action, c.status, v_to, v_on, c.amount,
     v_entry, acct.id,
     CASE WHEN p_action IN ('endorse') THEN 'supplier' ELSE c.party_type END,
     coalesce(p_party_id, c.party_id), p_note, p_user);

  -- شماره سند داخلی در اولین رویدادِ دارای سند تخصیص می‌یابد.
  -- تخصیص صریح است و نه داخل COALESCE: next_document_no یک تابع Volatile
  -- با اثر جانبی است و تکیه بر ترتیب ارزیابی COALESCE می‌تواند شمارنده
  -- را بی‌صدا جلو ببرد — یعنی همان پرش شماره‌ای که قاعده منع کرده.
  v_number := c.number;
  IF v_number IS NULL AND v_entry IS NOT NULL THEN
    v_number := platform.next_document_no(c.branch_id, 'cheque', v_fy);
  END IF;

  UPDATE treasury.cheque
     SET status = v_to,
         number = v_number,
         deposit_account_id = CASE WHEN p_action = 'deposit'
                                   THEN acct.id ELSE deposit_account_id END
   WHERE id = p_cheque;

  PERFORM platform.audit('cheque.' || p_action, 'treasury_cheque', p_cheque::text,
    jsonb_build_object('cheque_no', c.cheque_no, 'direction', c.direction,
                       'amount', c.amount, 'from', c.status, 'to', v_to,
                       'entry', v_entry),
    p_user, p_note);

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION treasury.post_cheque_event IS
  'تنها دروازه تغییر وضعیت چک. هیچ‌جا UPDATE مستقیم روی treasury.cheque.status.';

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------
-- ۴. وضعیت چک نمی‌تواند بدون رویداد جابه‌جا شود
-- ---------------------------------------------------------------------
-- همان الگوی توازن سند: بررسی معوق در پایان تراکنش. اگر کسی — اسکریپت،
-- ابزار مهاجرت یا نسخه بعدی کد — مستقیماً status را UPDATE کند، اینجا
-- گیر می‌افتد. زنجیره رویداد مرجع است؛ status فقط Projection آن.

CREATE OR REPLACE FUNCTION treasury.assert_cheque_status_from_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_last text; v_status text; v_no text;
BEGIN
  SELECT status, cheque_no INTO v_status, v_no FROM treasury.cheque WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;      -- حذف شده، چیزی برای بررسی نیست

  SELECT to_status INTO v_last FROM treasury.cheque_event
   WHERE cheque_id = NEW.id ORDER BY seq DESC LIMIT 1;

  IF v_last IS NULL THEN
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION
        'چک % وضعیت «%» دارد ولی هیچ رویدادی ندارد. وضعیت فقط با treasury.post_cheque_event حرکت می‌کند.',
        v_no, v_status;
    END IF;
  ELSIF v_status <> v_last THEN
    RAISE EXCEPTION
      'وضعیت چک % («%») با آخرین رویدادش («%») نمی‌خواند. UPDATE مستقیم روی status مجاز نیست.',
      v_no, v_status, v_last;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER cheque_status_matches_events
  AFTER INSERT OR UPDATE ON treasury.cheque
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION treasury.assert_cheque_status_from_events();

-- ---------------------------------------------------------------------
-- ۵. تطبیق دفتر با پرونده چک — پایه ادعای پایدار CI
-- ---------------------------------------------------------------------
-- همان کاری که inventory.balance_check برای انبار می‌کند: مانده حساب
-- دفتر باید با جمع برگه‌های باز بخواند. اگر نخواند، یک مسیر سند زده و
-- وضعیت را جابه‌جا نکرده — یا برعکس.
--
-- ۲۴۰۱ بدهی است، پس بستانکار منهای بدهکار.
-- چکِ پرداختیِ برگشتی هنوز بدهی ماست و در ۲۴۰۱ می‌ماند.

CREATE OR REPLACE VIEW treasury.cheque_check AS
WITH led AS (
  SELECT l.account_code,
         sum(l.debit - l.credit)  AS dr_net,
         sum(l.credit - l.debit)  AS cr_net
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE e.status IN ('confirmed','final')
     AND l.account_code IN ('1501','1502','1503','2401')
   GROUP BY l.account_code
), sub AS (
  SELECT '1501' AS account_code, coalesce(sum(amount),0) AS total
    FROM treasury.cheque WHERE direction = 'received' AND status = 'in_hand'
  UNION ALL
  SELECT '1502', coalesce(sum(amount),0)
    FROM treasury.cheque WHERE direction = 'received' AND status = 'deposited'
  UNION ALL
  SELECT '1503', coalesce(sum(amount),0)
    FROM treasury.cheque WHERE direction = 'received' AND status = 'bounced'
  UNION ALL
  SELECT '2401', coalesce(sum(amount),0)
    FROM treasury.cheque WHERE direction = 'issued' AND status IN ('issued','bounced')
)
SELECT s.account_code,
       a.name AS account_name,
       CASE WHEN s.account_code = '2401' THEN coalesce(l.cr_net, 0)
            ELSE coalesce(l.dr_net, 0) END AS ledger_balance,
       s.total AS cheque_total,
       CASE WHEN s.account_code = '2401' THEN coalesce(l.cr_net, 0)
            ELSE coalesce(l.dr_net, 0) END - s.total AS diff
  FROM sub s
  LEFT JOIN led l ON l.account_code = s.account_code
  LEFT JOIN ledger.account a ON a.code = s.account_code;

COMMENT ON VIEW treasury.cheque_check IS
  'تطبیق مانده حساب‌های چک در دفتر با جمع برگه‌های باز. diff باید همیشه صفر باشد.';

-- ---------------------------------------------------------------------
-- ۶. پرونده چک — سررسید و وضعیت
-- ---------------------------------------------------------------------
-- «کدام چک این هفته سررسید می‌شود» سؤال روزمره صندوق و حسابداری است.
-- روزهای هشدار داده است، نه کد: platform.setting['cheque.due_warning_days']

CREATE OR REPLACE VIEW treasury.cheque_due AS
SELECT c.id, c.number, c.direction, c.cheque_no, c.sayad_id, c.bank_name,
       c.amount, c.due_on, c.status, c.party_type, c.party_id,
       coalesce(cu.full_name, sp.name, c.drawer_name) AS party_name,
       c.due_on - current_date AS days_left,
       CASE
         WHEN c.due_on < current_date THEN 'overdue'
         WHEN c.due_on <= current_date
              + ((SELECT value FROM platform.setting
                   WHERE key = 'cheque.due_warning_days')::int) THEN 'due_soon'
         ELSE 'future'
       END AS urgency
  FROM treasury.cheque c
  LEFT JOIN sales.customer      cu ON c.party_type = 'customer' AND cu.id = c.party_id
  LEFT JOIN purchasing.supplier sp ON c.party_type = 'supplier' AND sp.id = c.party_id
 WHERE c.status IN ('in_hand','deposited','issued','endorsed');

-- گردش کامل یک برگه، برای چاپ و پیگیری
CREATE OR REPLACE VIEW treasury.cheque_ledger AS
SELECT c.id AS cheque_id, c.number, c.direction, c.cheque_no, c.amount, c.due_on,
       e.seq, e.action, e.from_status, e.to_status, e.occurred_on,
       e.entry_id, j.number AS entry_no, e.note
  FROM treasury.cheque c
  JOIN treasury.cheque_event e ON e.cheque_id = c.id
  LEFT JOIN ledger.journal_entry j ON j.id = e.entry_id
 ORDER BY c.id, e.seq;

COMMIT;
