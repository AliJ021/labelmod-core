-- =====================================================================
-- Label Mod Core — مهاجرت ۰۰۴: خزانه، تسویه و تفکیک روش پرداخت
-- =====================================================================
-- بخش ۱۵.۳ سند («خزانه») تا امروز هیچ جدولی نداشت: نه حساب بانکی، نه
-- صندوق، نه انتقال بین حساب‌ها، نه پرداخت خارج از فاکتور، نه تسویه
-- کارت‌خوان. قاعده ثبت supplier_payment در seed بود ولی هیچ تابعی
-- اجرایش نمی‌کرد.
--
-- این مهاجرت پنج نقص تأییدشده را می‌بندد:
--
--   H2  کارت‌به‌کارت به حساب واسط درگاه می‌رفت. حساب ۱۱۰۵ هرگز استفاده
--       نمی‌شد و payment_method.clearing_account_code پیکربندی مرده بود.
--       → leg به تفکیک kind روش پرداخت؛ ستون مرده حذف شد و نگاشت حساب
--         فقط در ledger.posting_rule ماند.
--   H3  پرداخت با امتیاز و کارت هدیه به‌عنوان طلب از مشتری ثبت می‌شد.
--       ۰۰۳ فعلاً صریح خطا می‌داد. → legهای واقعی روی بدهی ۲۳۰۱ و ۲۳۰۲.
--   H4  بدهی هزینه جانبی خرید به تأمین‌کننده نوشته می‌شد (حتی اگر باربری
--       شخص ثالث بود)، هزینه پرداخت‌شده از بانک به بدهی اضافه می‌شد، و
--       total_payable رسید با سند نمی‌خواند.
--       → ذی‌نفع هزینه، حساب خزانه پرداخت‌کننده، و total_payable هم‌راستا.
--   H7  treasury.payment کلید Idempotency نداشت و قید والد اجازه هیچ
--       دریافت/پرداخت خارج از فاکتور و مرجوعی را نمی‌داد.
--       → client_event_id یکتا + treasury.transaction.
--   H9  سطر دریافتنی سند تجمیعی party_id نداشت: دو فروش نسیه به دو مشتری
--       در یک سطر ۸٬۰۰۰٬۰۰۰ با شخصِ خالی جمع می‌شد، پس «گردش حساب
--       اشخاص» از دفتر قابل ساخت نبود.
--       → سطر دریافتنی و بازخرید امتیاز به تفکیک مشتری.
--
-- ⚠️ داده مرجع (حساب‌ها، قواعد ثبت، حساب‌های خزانه، شمارنده اسناد) در
--    db/seed/ است، نه اینجا. پس از این مهاجرت seed باید دوباره اجرا شود.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. اجازه‌ی کنترل‌شده‌ی تغییر حساب در قاعده ثبت
-- ---------------------------------------------------------------------
-- تا امروز حساب هر مؤلفه کاملاً در posting_rule قفل بود. برای فروش،
-- مالیات و بهای تمام‌شده این درست است. ولی «از کدام حساب بانکی پرداخت
-- شد» یا «به کدام صندوق واریز شد» ذاتاً داده‌ی تراکنش است، نه قاعده.
--
-- به‌جای بازکردن یک در پشتی عمومی، اجازه در سطح خود قاعده داده می‌شود:
-- حسابدار تعیین می‌کند کدام مؤلفه‌ها قابل تغییرند. مؤلفه‌های درآمد و
-- بهای تمام‌شده هرگز قابل تغییر نخواهند بود.

ALTER TABLE ledger.posting_rule
  ADD COLUMN allow_account_override boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN ledger.posting_rule.allow_account_override IS
  'اگر true، تراکنش می‌تواند account_code را در leg تعیین کند (مثلاً کدام حساب بانکی). پیش‌فرض false.';

CREATE OR REPLACE FUNCTION ledger.post_entry(
  p_event_type  text,
  p_branch      uuid,
  p_entry_date  date,
  p_description text,
  p_legs        jsonb,
  p_ref_type    text DEFAULT NULL,
  p_ref_id      uuid DEFAULT NULL,
  p_user        uuid DEFAULT NULL,
  p_status      text DEFAULT 'confirmed'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_entry   uuid;
  v_fy      smallint;
  v_no      text;
  v_line_no smallint := 0;
  v_leg     jsonb;
  v_rule    ledger.posting_rule%ROWTYPE;
  v_amount  platform.money;
  v_account text;
  v_dr      platform.money := 0;
  v_cr      platform.money := 0;
BEGIN
  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE p_entry_date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', p_entry_date;
  END IF;

  v_no := platform.next_document_no(p_branch, 'journal', v_fy);

  INSERT INTO ledger.journal_entry
    (number, fiscal_year, branch_id, entry_date, kind, status,
     description, ref_type, ref_id, created_by)
  VALUES
    (v_no, v_fy, p_branch, p_entry_date, p_event_type, p_status,
     p_description, p_ref_type, p_ref_id, p_user)
  RETURNING id INTO v_entry;

  -- چند مؤلفه هم‌نام مجازند و هر کدام یک سطر می‌شوند. این همان چیزی
  -- است که سطر دریافتنی به تفکیک مشتری و پرداخت از چند حساب را ممکن
  -- می‌کند. یکتایی روی (event_type, leg) قاعده است، نه سطر سند.
  FOR v_leg IN SELECT * FROM jsonb_array_elements(p_legs) LOOP
    v_amount := (v_leg->>'amount')::platform.money;
    CONTINUE WHEN v_amount IS NULL OR v_amount = 0;

    SELECT * INTO v_rule FROM ledger.posting_rule
     WHERE event_type = p_event_type
       AND leg        = v_leg->>'leg'
       AND is_active;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'قاعده ثبت برای رویداد «%» و مؤلفه «%» تعریف نشده است',
        p_event_type, v_leg->>'leg';
    END IF;

    v_account := v_leg->>'account_code';
    IF v_account IS NOT NULL AND v_account <> v_rule.account_code
       AND NOT v_rule.allow_account_override THEN
      RAISE EXCEPTION
        'مؤلفه «%» در رویداد «%» اجازه تغییر حساب ندارد (قاعده: %، درخواستی: %)',
        v_leg->>'leg', p_event_type, v_rule.account_code, v_account;
    END IF;
    v_account := coalesce(v_account, v_rule.account_code);

    -- مبلغ منفی یعنی سمت سند برعکس می‌شود (مثلاً مغایرت منفی صندوق)
    v_line_no := v_line_no + 1;
    INSERT INTO ledger.journal_line
      (entry_id, line_no, account_code, cost_center,
       party_type, party_id, debit, credit, description)
    VALUES
      (v_entry, v_line_no, v_account, v_leg->>'cost_center',
       coalesce(v_leg->>'party_type', v_rule.party_type),
       (v_leg->>'party_id')::uuid,
       CASE WHEN (v_rule.side = 'debit') = (v_amount > 0) THEN abs(v_amount) ELSE 0 END,
       CASE WHEN (v_rule.side = 'debit') = (v_amount > 0) THEN 0 ELSE abs(v_amount) END,
       coalesce(v_leg->>'description', v_rule.description));
  END LOOP;

  IF v_line_no = 0 THEN
    RAISE EXCEPTION 'سند بدون سطر: رویداد % هیچ مبلغ غیرصفری نداشت', p_event_type;
  END IF;

  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO v_dr, v_cr
    FROM ledger.journal_line WHERE entry_id = v_entry;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION
      'سند % متوازن نیست: بدهکار %، بستانکار %، اختلاف %',
      v_no, v_dr, v_cr, v_dr - v_cr;
  END IF;

  RETURN v_entry;
END $$;

-- ---------------------------------------------------------------------
-- ۲. حساب‌های خزانه: صندوق، بانک، کارت‌خوان، درگاه
-- ---------------------------------------------------------------------

CREATE TABLE treasury.account (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('cash_box','bank','card_terminal','gateway')),
  branch_id     uuid REFERENCES platform.branch(id),
  -- حساب دفتر کل متناظر. مانده این حساب باید با مانده خزانه بخواند.
  ledger_account_code text NOT NULL REFERENCES ledger.account(code),
  bank_name     text,
  account_no    text,
  iban          text,
  -- برای کارت‌خوان و درگاه: پول به کدام حساب بانکی و با چه کارمزدی می‌رود
  settlement_account_id uuid REFERENCES treasury.account(id),
  settlement_days smallint NOT NULL DEFAULT 0,
  fee_percent   numeric(5,3) NOT NULL DEFAULT 0 CHECK (fee_percent >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  CONSTRAINT only_terminals_settle CHECK (
    kind IN ('card_terminal','gateway') OR settlement_account_id IS NULL)
);
CREATE INDEX ON treasury.account (branch_id, kind) WHERE is_active;

-- حساب دفترِ یک حساب خزانه باید قابل ثبت باشد، وگرنه خطا در لحظه سند
-- زده می‌شود نه در لحظه تعریف.
CREATE OR REPLACE FUNCTION treasury.assert_postable_ledger_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_postable boolean;
BEGIN
  SELECT is_postable INTO v_postable FROM ledger.account WHERE code = NEW.ledger_account_code;
  IF NOT coalesce(v_postable, false) THEN
    RAISE EXCEPTION
      'حساب دفتر «%» برای حساب خزانه % قابل ثبت نیست', NEW.ledger_account_code, NEW.code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assert_postable_ledger_account_t
  BEFORE INSERT OR UPDATE ON treasury.account
  FOR EACH ROW EXECUTE FUNCTION treasury.assert_postable_ledger_account();

-- ---------------------------------------------------------------------
-- ۳. پرداخت: Idempotency و اتصال به حساب خزانه (H7)
-- ---------------------------------------------------------------------
-- بدون کلید رویداد، Retry افزونه ووکامرس یا دستگاه صندوق یک پرداخت
-- تکراری می‌سازد و مستقیماً مغایرت صندوق تولید می‌کند.

ALTER TABLE treasury.payment
  ADD COLUMN client_event_id text,
  ADD COLUMN account_id      uuid REFERENCES treasury.account(id),
  ADD COLUMN settlement_id   uuid;

CREATE UNIQUE INDEX payment_client_event_unique
  ON treasury.payment (client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX ON treasury.payment (account_id, occurred_at)
  WHERE direction = 'in' AND settlement_id IS NULL;

-- نگاشت حساب دیگر اینجا نیست: تنها مرجع، ledger.posting_rule است.
ALTER TABLE treasury.payment_method DROP COLUMN clearing_account_code;

-- ---------------------------------------------------------------------
-- ۴. تراکنش خزانه: دریافت، پرداخت و انتقال خارج از فاکتور (H7)
-- ---------------------------------------------------------------------
-- پرداخت به تأمین‌کننده، هزینه، آورده نقدی و انتقال بین حساب‌ها هیچ‌کدام
-- فاکتور ندارند. قید payment_has_one_parent اجازه ثبتشان را نمی‌داد.

CREATE TABLE treasury.transaction (
  id              uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number          text,
  branch_id       uuid NOT NULL REFERENCES platform.branch(id),
  purpose         text NOT NULL CHECK (purpose IN
                    ('supplier_payment','customer_receipt','expense','capital','transfer')),
  from_account_id uuid REFERENCES treasury.account(id),
  to_account_id   uuid REFERENCES treasury.account(id),
  party_type      text CHECK (party_type IN ('supplier','customer','user','other')),
  party_id        uuid,
  -- فقط برای purpose='expense': کدام حساب هزینه بدهکار شود
  expense_account_code text REFERENCES ledger.account(code),
  amount          platform.money NOT NULL CHECK (amount > 0),
  -- اگر پول از کشوی یک شیفت باز خارج یا وارد شده، شیفت باید بداند.
  -- بدون این، هر هزینه‌ی نقدی یک مغایرت کاذب می‌سازد — همان الگوی C3.
  shift_id        uuid REFERENCES sales.cash_shift(id),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','posted','cancelled')),
  entry_id        uuid REFERENCES ledger.journal_entry(id),
  client_event_id text UNIQUE,
  ref_no          text,
  note            text,
  created_by      uuid REFERENCES identity.app_user(id),
  UNIQUE (branch_id, number),
  CONSTRAINT transaction_direction_shape CHECK (
    (purpose = 'transfer'
       AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL
       AND from_account_id <> to_account_id) OR
    (purpose IN ('supplier_payment','expense')
       AND from_account_id IS NOT NULL AND to_account_id IS NULL) OR
    (purpose IN ('customer_receipt','capital')
       AND to_account_id IS NOT NULL AND from_account_id IS NULL)),
  CONSTRAINT expense_needs_account CHECK (
    purpose <> 'expense' OR expense_account_code IS NOT NULL),
  CONSTRAINT party_required CHECK (
    purpose NOT IN ('supplier_payment','customer_receipt') OR party_id IS NOT NULL)
);
CREATE INDEX ON treasury.transaction (branch_id, occurred_at DESC);
CREATE INDEX ON treasury.transaction (party_type, party_id);
CREATE INDEX ON treasury.transaction (shift_id) WHERE shift_id IS NOT NULL;

-- هزینه جانبی خرید نمی‌تواند مستقیماً از کشوی صندوق پرداخت شود: رسید
-- خرید به شیفت گره نخورده، پس آن خروج نقد در شمارش صندوق دیده نمی‌شود.
-- مسیر درست: هزینه به‌صورت بدهی بماند و با یک تراکنش خزانه‌ی دارای
-- shift_id پرداخت شود.
CREATE OR REPLACE FUNCTION purchasing.assert_charge_not_from_cash_box() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_kind text; v_code text;
BEGIN
  IF NEW.paid_account_id IS NULL THEN RETURN NEW; END IF;
  SELECT kind, code INTO v_kind, v_code FROM treasury.account WHERE id = NEW.paid_account_id;
  IF v_kind = 'cash_box' THEN
    RAISE EXCEPTION
      'هزینه جانبی از صندوق (%) مستقیماً پرداخت نمی‌شود. آن را بدهی بگذارید و با تراکنش خزانه‌ی متصل به شیفت پرداخت کنید، وگرنه شمارش صندوق مغایرت کاذب می‌دهد.',
      v_code;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION treasury.post_transaction(
  p_tx uuid, p_user uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  t        treasury.transaction%ROWTYPE;
  v_from   text;
  v_to     text;
  v_legs   jsonb;
  v_event  text;
  v_entry  uuid;
  v_fy     smallint;
  v_no     text;
BEGIN
  SELECT * INTO t FROM treasury.transaction WHERE id = p_tx FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'تراکنش خزانه یافت نشد'; END IF;
  IF t.status = 'posted'    THEN RETURN t.entry_id; END IF;      -- Idempotent
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'تراکنش خزانه باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT ledger_account_code INTO v_from FROM treasury.account WHERE id = t.from_account_id;
  SELECT ledger_account_code INTO v_to   FROM treasury.account WHERE id = t.to_account_id;

  IF t.purpose = 'transfer' THEN
    v_event := 'treasury_transfer';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','to_account',  'amount', t.amount, 'account_code', v_to),
      jsonb_build_object('leg','from_account','amount', t.amount, 'account_code', v_from));

  ELSIF t.purpose = 'supplier_payment' THEN
    v_event := 'supplier_payment';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','payable','amount', t.amount,
                         'party_type','supplier','party_id', t.party_id),
      jsonb_build_object('leg','from_account','amount', t.amount, 'account_code', v_from));

  ELSIF t.purpose = 'customer_receipt' THEN
    v_event := 'customer_receipt';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','to_account','amount', t.amount, 'account_code', v_to),
      jsonb_build_object('leg','receivable','amount', t.amount,
                         'party_type','customer','party_id', t.party_id));

  ELSIF t.purpose = 'expense' THEN
    v_event := 'expense_payment';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','expense','amount', t.amount,
                         'account_code', t.expense_account_code,
                         'party_type', t.party_type, 'party_id', t.party_id),
      jsonb_build_object('leg','from_account','amount', t.amount, 'account_code', v_from));

  ELSE  -- capital
    v_event := 'capital_injection';
    v_legs  := jsonb_build_array(
      jsonb_build_object('leg','to_account','amount', t.amount, 'account_code', v_to),
      jsonb_build_object('leg','equity','amount', t.amount));
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE t.occurred_at::date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', t.occurred_at::date;
  END IF;
  v_no := platform.next_document_no(t.branch_id, 'treasury', v_fy);

  v_entry := ledger.post_entry(
    v_event, t.branch_id, t.occurred_at::date,
    'تراکنش خزانه ' || v_no || coalesce(' — ' || t.note, ''),
    v_legs, 'treasury_transaction', p_tx, p_user);

  UPDATE treasury.transaction
     SET number = v_no, status = 'posted', entry_id = v_entry
   WHERE id = p_tx;

  PERFORM platform.audit('treasury.post', 'treasury_transaction', p_tx::text,
    jsonb_build_object('number', v_no, 'purpose', t.purpose,
                       'amount', t.amount, 'entry', v_entry),
    p_user, t.note);

  RETURN v_entry;
END $$;

-- ---------------------------------------------------------------------
-- ۵. تسویه کارت‌خوان و درگاه
-- ---------------------------------------------------------------------
-- حساب‌های «وجوه در راه» (۱۱۰۳، ۱۱۰۴، ۱۱۰۵) تا امروز فقط پر می‌شدند و
-- هیچ مسیری برای بستنشان نبود. قاعده card_settlement در seed وجود داشت
-- ولی تابعی نداشت.
--
-- کارمزد در عمل معلوم نیست تا واریز بانک را ببینی. پس اگر مبلغ واریزشده
-- وارد شود، کارمزد از تفاوت محاسبه می‌شود — همان کاری که حسابدار با
-- صورتحساب PSP می‌کند. اگر وارد نشود، از fee_percent حساب خزانه.

CREATE TABLE treasury.settlement (
  id                uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number            text,
  branch_id         uuid NOT NULL REFERENCES platform.branch(id),
  source_account_id uuid NOT NULL REFERENCES treasury.account(id),
  bank_account_id   uuid NOT NULL REFERENCES treasury.account(id),
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  gross_amount      platform.money NOT NULL DEFAULT 0,
  fee_amount        platform.money NOT NULL DEFAULT 0,
  net_amount        platform.money NOT NULL DEFAULT 0,
  -- آنچه بانک واقعاً واریز کرده. اگر داده شود، کارمزد از آن استنتاج می‌شود.
  bank_reported_amount platform.money,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','posted','cancelled')),
  entry_id          uuid REFERENCES ledger.journal_entry(id),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  note              text,
  created_by        uuid REFERENCES identity.app_user(id),
  UNIQUE (branch_id, number),
  CHECK (period_to >= period_from),
  CONSTRAINT source_is_not_bank CHECK (source_account_id <> bank_account_id)
);

ALTER TABLE treasury.payment
  ADD CONSTRAINT payment_settlement_fk
  FOREIGN KEY (settlement_id) REFERENCES treasury.settlement(id);

CREATE OR REPLACE FUNCTION treasury.post_settlement(
  p_settlement uuid, p_user uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  s        treasury.settlement%ROWTYPE;
  src      treasury.account%ROWTYPE;
  bank     treasury.account%ROWTYPE;
  v_gross  platform.money := 0;
  v_fee    platform.money := 0;
  v_net    platform.money := 0;
  v_count  int := 0;
  v_entry  uuid;
  v_fy     smallint;
  v_no     text;
BEGIN
  SELECT * INTO s FROM treasury.settlement WHERE id = p_settlement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ تسویه یافت نشد'; END IF;
  IF s.status = 'posted'    THEN RETURN s.entry_id; END IF;      -- Idempotent
  IF s.status = 'cancelled' THEN RAISE EXCEPTION 'برگ تسویه باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT * INTO src  FROM treasury.account WHERE id = s.source_account_id;
  SELECT * INTO bank FROM treasury.account WHERE id = s.bank_account_id;

  IF src.kind NOT IN ('card_terminal','gateway') THEN
    RAISE EXCEPTION 'تسویه فقط از کارت‌خوان یا درگاه انجام می‌شود (حساب %: %)', src.code, src.kind;
  END IF;
  IF bank.kind <> 'bank' THEN
    RAISE EXCEPTION 'مقصد تسویه باید حساب بانکی باشد (حساب %: %)', bank.code, bank.kind;
  END IF;

  -- فقط پرداخت‌های موفقِ تسویه‌نشده‌ی همان دستگاه در همان بازه
  SELECT coalesce(sum(amount),0), count(*) INTO v_gross, v_count
    FROM treasury.payment
   WHERE account_id = s.source_account_id
     AND direction = 'in'
     AND status = 'succeeded'
     AND settlement_id IS NULL
     AND occurred_at::date BETWEEN s.period_from AND s.period_to;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'هیچ پرداخت تسویه‌نشده‌ای برای % در بازه % تا % یافت نشد',
      src.code, s.period_from, s.period_to;
  END IF;

  IF s.bank_reported_amount IS NOT NULL THEN
    v_net := s.bank_reported_amount;
    v_fee := v_gross - v_net;
    IF v_fee < 0 THEN
      RAISE EXCEPTION
        'مبلغ واریزشده بانک (%) از جمع تراکنش‌ها (%) بیشتر است. مغایرت باید بررسی شود.',
        s.bank_reported_amount, v_gross;
    END IF;
  ELSE
    v_fee := round(v_gross * src.fee_percent / 100);
    v_net := v_gross - v_fee;
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE s.occurred_at::date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', s.occurred_at::date;
  END IF;
  v_no := platform.next_document_no(s.branch_id, 'settlement', v_fy);

  v_entry := ledger.post_entry(
    'settlement', s.branch_id, s.occurred_at::date,
    'تسویه ' || src.name || ' — ' || v_no,
    jsonb_build_array(
      jsonb_build_object('leg','bank','amount', v_net,   'account_code', bank.ledger_account_code),
      jsonb_build_object('leg','fee', 'amount', v_fee),
      jsonb_build_object('leg','clearing','amount', v_gross, 'account_code', src.ledger_account_code)),
    'treasury_settlement', p_settlement, p_user);

  UPDATE treasury.payment
     SET status = 'settled', settled_at = s.occurred_at, settlement_id = p_settlement
   WHERE account_id = s.source_account_id
     AND direction = 'in'
     AND status = 'succeeded'
     AND settlement_id IS NULL
     AND occurred_at::date BETWEEN s.period_from AND s.period_to;

  UPDATE treasury.settlement
     SET number = v_no, gross_amount = v_gross, fee_amount = v_fee,
         net_amount = v_net, status = 'posted', entry_id = v_entry
   WHERE id = p_settlement;

  PERFORM platform.audit('settlement.post', 'treasury_settlement', p_settlement::text,
    jsonb_build_object('number', v_no, 'source', src.code, 'bank', bank.code,
                       'gross', v_gross, 'fee', v_fee, 'net', v_net, 'payments', v_count),
    p_user, s.note);

  RETURN v_entry;
END $$;

-- مانده هر حساب خزانه از دفتر کل — پایه مغایرت‌گیری بانک و کارت‌خوان
CREATE OR REPLACE VIEW treasury.account_balance AS
SELECT a.id, a.code, a.name, a.kind, a.branch_id,
       a.ledger_account_code,
       coalesce(sum(l.debit - l.credit), 0) AS balance
  FROM treasury.account a
  LEFT JOIN ledger.journal_line l ON l.account_code = a.ledger_account_code
  LEFT JOIN ledger.journal_entry e ON e.id = l.entry_id AND e.status IN ('confirmed','final')
 GROUP BY a.id, a.code, a.name, a.kind, a.branch_id, a.ledger_account_code;

-- ---------------------------------------------------------------------
-- ۶. سند دوره ثبت: تفکیک روش پرداخت و شخصِ بدهکار (H2، H3، H9)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sales.post_batch(
  p_batch uuid, p_user uuid DEFAULT NULL
) RETURNS TABLE (sale_entry uuid, cogs_entry uuid)
LANGUAGE plpgsql AS $$
DECLARE
  b          ledger.posting_batch%ROWTYPE;
  v_gross    platform.money := 0;
  v_disc     platform.money := 0;
  v_tax      platform.money := 0;
  v_cogs     platform.money := 0;
  v_shipping platform.money := 0;
  v_payable  platform.money := 0;
  v_pay_legs  jsonb := '[]'::jsonb;
  v_recv_legs jsonb := '[]'::jsonb;
  v_legs     jsonb;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_label    text;
  v_orphan   int;
BEGIN
  SELECT * INTO b FROM ledger.posting_batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'دوره ثبت یافت نشد'; END IF;

  IF b.status = 'posted' THEN
    RETURN QUERY SELECT b.sale_entry_id, b.cogs_entry_id;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM sales.invoice
              WHERE posting_batch_id = p_batch
                AND status IN ('draft','confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'دوره ثبت با فاکتور نهایی‌نشده بسته نمی‌شود';
  END IF;

  SELECT coalesce(sum(gross_amount),0),    coalesce(sum(discount_amount),0),
         coalesce(sum(tax_amount),0),      coalesce(sum(cogs_amount),0),
         coalesce(sum(shipping_amount),0), coalesce(sum(payable_amount),0)
    INTO v_gross, v_disc, v_tax, v_cogs, v_shipping, v_payable
    FROM sales.invoice
   WHERE posting_batch_id = p_batch
     AND status IN ('finalized','paid','partially_returned','returned');

  -- امتیاز و کارت هدیه بدهی ما به مشتری‌اند؛ بدون شناسه مشتری قابل
  -- کاهش نیستند.
  SELECT count(*) INTO v_orphan
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
    JOIN sales.invoice i ON i.id = p.invoice_id
   WHERE i.posting_batch_id = p_batch AND p.direction = 'in'
     AND m.kind IN ('points','gift_card') AND i.customer_id IS NULL;
  IF v_orphan > 0 THEN
    RAISE EXCEPTION 'پرداخت با امتیاز یا کارت هدیه روی فاکتور بدون مشتری مجاز نیست (% فاکتور)', v_orphan;
  END IF;

  -- مؤلفه‌های پرداخت: مقصد از kind روش پرداخت می‌آید، نه از یک leg کلی.
  -- وضعیت بر نوع اولویت دارد: تراکنش نامشخص هرچه باشد، پول نیست.
  WITH counted AS (
    SELECT i.customer_id,
           CASE
             WHEN p.status IN ('pending','unknown') THEN 'unknown_clearing'
             WHEN m.kind = 'cash'        THEN 'cash'
             WHEN m.kind = 'card_reader' THEN 'card_clearing'
             WHEN m.kind = 'gateway'     THEN 'gateway_clearing'
             WHEN m.kind = 'transfer'    THEN 'p2p_clearing'
             WHEN m.kind = 'points'      THEN 'points_redeem'
             WHEN m.kind = 'gift_card'   THEN 'giftcard_redeem'
           END AS leg,
           p.amount
      FROM treasury.payment p
      JOIN treasury.payment_method m ON m.code = p.method_code
      JOIN sales.invoice i ON i.id = p.invoice_id
     WHERE i.posting_batch_id = p_batch
       AND p.direction = 'in'
       AND m.kind <> 'credit'
       AND p.status IN ('succeeded','settled','reconciled','pending','unknown')
  ), grouped AS (
    SELECT leg,
           CASE WHEN leg IN ('points_redeem','giftcard_redeem') THEN customer_id END AS party,
           sum(amount) AS amt
      FROM counted GROUP BY 1, 2
  )
  SELECT coalesce(jsonb_agg(
           CASE WHEN party IS NOT NULL
                THEN jsonb_build_object('leg', leg, 'amount', amt,
                                        'party_type','customer','party_id', party)
                ELSE jsonb_build_object('leg', leg, 'amount', amt) END), '[]'::jsonb)
    INTO v_pay_legs FROM grouped;

  -- دریافتنی به تفکیک مشتری. سطر تجمیعی بدون شخص، گردش حساب اشخاص را
  -- غیرقابل ساخت می‌کرد.
  WITH per_invoice AS (
    SELECT i.customer_id,
           i.payable_amount - coalesce((
             SELECT sum(p.amount) FROM treasury.payment p
               JOIN treasury.payment_method m ON m.code = p.method_code
              WHERE p.invoice_id = i.id AND p.direction = 'in'
                AND m.kind <> 'credit'
                AND p.status IN ('succeeded','settled','reconciled','pending','unknown')
           ), 0) AS due
      FROM sales.invoice i
     WHERE i.posting_batch_id = p_batch
       AND i.status IN ('finalized','paid','partially_returned','returned')
  ), per_customer AS (
    SELECT customer_id, sum(due) AS amt FROM per_invoice
     GROUP BY customer_id HAVING sum(due) <> 0
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'leg','receivable', 'amount', amt,
           'party_type','customer', 'party_id', customer_id)), '[]'::jsonb),
         count(*) FILTER (WHERE customer_id IS NULL)
    INTO v_recv_legs, v_orphan
    FROM per_customer;

  IF v_orphan > 0 THEN
    RAISE EXCEPTION
      'فروش ناشناس نمی‌تواند نسیه بماند: % فاکتور بدون مشتری، مبلغ پرداخت‌نشده دارد.', v_orphan;
  END IF;

  v_label := CASE b.kind
               WHEN 'shift' THEN 'شیفت صندوق ' || to_char(b.business_date, 'YYYY-MM-DD')
               ELSE 'کانال ' || b.channel || ' — ' || to_char(b.business_date, 'YYYY-MM-DD')
             END;

  IF v_gross > 0 THEN
    v_legs := jsonb_build_array(
                jsonb_build_object('leg','discount','amount', v_disc),
                jsonb_build_object('leg','sales',   'amount', v_gross),
                jsonb_build_object('leg','shipping','amount', v_shipping),
                jsonb_build_object('leg','tax',     'amount', v_tax))
              || v_pay_legs || v_recv_legs;

    v_sale := ledger.post_entry(
      'sale_shift', b.branch_id, b.business_date,
      'فروش — ' || v_label, v_legs, 'posting_batch', p_batch, p_user);
  END IF;

  IF v_cogs > 0 THEN
    v_cogs_e := ledger.post_entry(
      'shift_cogs', b.branch_id, b.business_date,
      'بهای تمام‌شده کالای فروش‌رفته — ' || v_label,
      jsonb_build_array(
        jsonb_build_object('leg','cogs',     'amount', v_cogs),
        jsonb_build_object('leg','inventory','amount', v_cogs)),
      'posting_batch', p_batch, p_user);
  END IF;

  UPDATE ledger.posting_batch
     SET status = 'posted', sale_entry_id = v_sale, cogs_entry_id = v_cogs_e,
         posted_at = now(), posted_by = p_user
   WHERE id = p_batch;

  PERFORM platform.audit('batch.post', 'posting_batch', p_batch::text,
    jsonb_build_object('kind', b.kind, 'date', b.business_date,
                       'gross', v_gross, 'cogs', v_cogs,
                       'payment_legs', v_pay_legs, 'receivable_legs', v_recv_legs),
    p_user);

  RETURN QUERY SELECT v_sale, v_cogs_e;
END $$;

-- ---------------------------------------------------------------------
-- ۶.۵ بستن شیفت: هر خروج و ورود نقدِ غیرفروشی هم شمرده می‌شود
-- ---------------------------------------------------------------------
-- ۰۰۳ فقط پرداخت‌های فاکتور و بازپرداخت مرجوعی را می‌دید. هزینه‌ی نقدی،
-- پرداخت به تأمین‌کننده و برداشت از کشو همان مغایرت کاذب C3 را می‌ساختند.

CREATE OR REPLACE FUNCTION sales.close_shift(
  p_shift uuid, p_counted_cash platform.money, p_user uuid DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS TABLE (sale_entry uuid, cogs_entry uuid, variance platform.money)
LANGUAGE plpgsql AS $$
DECLARE
  s          sales.cash_shift%ROWTYPE;
  v_batch    uuid;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_cash_in  platform.money := 0;
  v_cash_out platform.money := 0;
  v_tx_in    platform.money := 0;
  v_tx_out   platform.money := 0;
  v_expected platform.money;
  v_variance platform.money;
  v_date     date;
BEGIN
  SELECT * INTO s FROM sales.cash_shift WHERE id = p_shift FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'شیفت یافت نشد'; END IF;
  IF s.status <> 'open' THEN RAISE EXCEPTION 'شیفت قبلاً بسته شده است'; END IF;

  IF EXISTS (SELECT 1 FROM sales.invoice
              WHERE shift_id = p_shift
                AND status IN ('draft','confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'شیفت با فاکتور نهایی‌نشده بسته نمی‌شود';
  END IF;

  IF EXISTS (SELECT 1 FROM treasury.transaction
              WHERE shift_id = p_shift AND status = 'draft') THEN
    RAISE EXCEPTION 'شیفت با تراکنش خزانه‌ی ثبت‌نشده بسته نمی‌شود';
  END IF;

  v_date := s.opened_at::date;

  SELECT id INTO v_batch FROM ledger.posting_batch
   WHERE kind = 'shift' AND shift_id = p_shift;
  IF v_batch IS NULL THEN
    INSERT INTO ledger.posting_batch (branch_id, kind, shift_id, business_date)
    VALUES (s.branch_id, 'shift', p_shift, v_date)
    ON CONFLICT DO NOTHING RETURNING id INTO v_batch;
    IF v_batch IS NULL THEN
      SELECT id INTO v_batch FROM ledger.posting_batch
       WHERE kind = 'shift' AND shift_id = p_shift;
    END IF;
  END IF;

  SELECT r.sale_entry, r.cogs_entry INTO v_sale, v_cogs_e
    FROM sales.post_batch(v_batch, p_user) r;

  -- ۱) نقد فروش و بازپرداخت مرجوعی
  SELECT coalesce(sum(p.amount) FILTER (WHERE p.direction = 'in'),  0),
         coalesce(sum(p.amount) FILTER (WHERE p.direction = 'out'), 0)
    INTO v_cash_in, v_cash_out
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
   WHERE p.shift_id = p_shift AND m.kind = 'cash'
     AND p.status IN ('succeeded','settled','reconciled');

  -- ۲) هر حرکت نقد غیرفروشی که به همین شیفت نسبت داده شده
  SELECT coalesce(sum(t.amount) FILTER (WHERE ta.kind = 'cash_box'), 0),
         coalesce(sum(t.amount) FILTER (WHERE fa.kind = 'cash_box'), 0)
    INTO v_tx_in, v_tx_out
    FROM treasury.transaction t
    LEFT JOIN treasury.account ta ON ta.id = t.to_account_id
    LEFT JOIN treasury.account fa ON fa.id = t.from_account_id
   WHERE t.shift_id = p_shift AND t.status = 'posted';

  v_expected := s.opening_cash + v_cash_in + v_tx_in - v_cash_out - v_tx_out;
  v_variance := p_counted_cash - v_expected;

  IF v_variance <> 0 THEN
    PERFORM ledger.post_entry(
      'shift_variance', s.branch_id, v_date,
      'مغایرت صندوق — شیفت ' || to_char(s.opened_at, 'YYYY-MM-DD HH24:MI'),
      jsonb_build_array(
        jsonb_build_object('leg','cash',    'amount', v_variance),
        jsonb_build_object('leg','variance','amount', v_variance)),
      'cash_shift', p_shift, p_user);
  END IF;

  UPDATE sales.cash_shift
     SET closed_at = now(), counted_cash = p_counted_cash,
         expected_cash = v_expected, variance = v_variance,
         variance_note = p_note, status = 'closed'
   WHERE id = p_shift;

  PERFORM platform.audit('shift.close', 'cash_shift', p_shift::text,
    jsonb_build_object('opening', s.opening_cash,
                       'sale_cash_in', v_cash_in, 'refund_cash_out', v_cash_out,
                       'treasury_in', v_tx_in,    'treasury_out', v_tx_out,
                       'expected', v_expected, 'counted', p_counted_cash,
                       'variance', v_variance),
    p_user, p_note);

  RETURN QUERY SELECT v_sale, v_cogs_e, v_variance;
END $$;

-- ---------------------------------------------------------------------
-- ۷. هزینه جانبی خرید: ذی‌نفع واقعی و حساب پرداخت‌کننده (H4)
-- ---------------------------------------------------------------------
-- کرایه حمل معمولاً بدهی به باربری است، نه به تأمین‌کننده کالا. و هزینه‌ای
-- که از بانک پرداخت شده، نه باید بدهی بسازد نه صندوق را بستانکار کند.

ALTER TABLE purchasing.receipt_charge
  ADD COLUMN payee_type text NOT NULL DEFAULT 'supplier'
             CHECK (payee_type IN ('supplier','other')),
  ADD COLUMN payee_name text,
  ADD COLUMN paid_account_id uuid REFERENCES treasury.account(id);

-- paid_from از این پس فقط دو معنا دارد: یا همان لحظه از خزانه پرداخت شد،
-- یا بدهی ماند. اینکه از کدام صندوق/بانک، در paid_account_id است.
UPDATE purchasing.receipt_charge
   SET paid_from = CASE WHEN paid_from IN ('cash','bank') THEN 'treasury'
                        ELSE 'payable' END;
ALTER TABLE purchasing.receipt_charge
  ALTER COLUMN paid_from SET DEFAULT 'payable',
  ADD CONSTRAINT charge_paid_from_valid CHECK (paid_from IN ('treasury','payable')),
  ADD CONSTRAINT charge_treasury_needs_account CHECK (
    paid_from <> 'treasury' OR paid_account_id IS NOT NULL);

CREATE TRIGGER assert_charge_not_from_cash_box_t
  BEFORE INSERT OR UPDATE ON purchasing.receipt_charge
  FOR EACH ROW EXECUTE FUNCTION purchasing.assert_charge_not_from_cash_box();

ALTER TABLE purchasing.receipt
  ADD COLUMN third_party_payable platform.money NOT NULL DEFAULT 0;

COMMENT ON COLUMN purchasing.receipt.total_payable IS
  'بدهی به همین تأمین‌کننده: کالا + مالیات + هزینه جانبیِ خودِ تأمین‌کننده. بدهی به شخص ثالث در third_party_payable.';

CREATE OR REPLACE FUNCTION purchasing.post_receipt(
  p_receipt uuid, p_user uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  r              purchasing.receipt%ROWTYPE;
  v_goods        platform.money := 0;
  v_charges      platform.money := 0;
  v_charge_alloc platform.money;
  v_qty_total    platform.qty := 0;
  v_line         record;
  v_alloc_sum    platform.money := 0;
  v_last_line    uuid;
  v_by_value     platform.money := 0;
  v_by_qty       platform.money := 0;
  v_sup_payable  platform.money := 0;   -- هزینه جانبیِ بدهی به تأمین‌کننده
  v_other_payable platform.money := 0;  -- هزینه جانبیِ بدهی به شخص ثالث
  v_treasury_legs jsonb := '[]'::jsonb;
  v_entry        uuid;
  v_legs         jsonb;
BEGIN
  SELECT * INTO r FROM purchasing.receipt WHERE id = p_receipt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'رسید خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'رسید خرید % قبلاً ثبت شده است', r.number;
  END IF;

  SELECT coalesce(sum(qty * unit_price),0), coalesce(sum(qty),0)
    INTO v_goods, v_qty_total
    FROM purchasing.receipt_line WHERE receipt_id = p_receipt;

  IF v_qty_total = 0 THEN
    RAISE EXCEPTION 'رسید خرید بدون قلم قابل ثبت نیست';
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE allocation = 'by_value'), 0),
         coalesce(sum(amount) FILTER (WHERE allocation = 'by_qty'), 0),
         coalesce(sum(amount), 0),
         coalesce(sum(amount) FILTER (WHERE paid_from = 'payable' AND payee_type = 'supplier'), 0),
         coalesce(sum(amount) FILTER (WHERE paid_from = 'payable' AND payee_type = 'other'), 0)
    INTO v_by_value, v_by_qty, v_charges, v_sup_payable, v_other_payable
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

  -- هزینه‌های پرداخت‌شده از خزانه، به تفکیک حسابِ پرداخت‌کننده
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'leg','from_account', 'amount', amt, 'account_code', acc)), '[]'::jsonb)
    INTO v_treasury_legs
    FROM (SELECT a.ledger_account_code AS acc, sum(c.amount) AS amt
            FROM purchasing.receipt_charge c
            JOIN treasury.account a ON a.id = c.paid_account_id
           WHERE c.receipt_id = p_receipt AND c.paid_from = 'treasury'
           GROUP BY a.ledger_account_code) x;

  -- تخصیص هزینه جانبی. باقی‌مانده گرد کردن به آخرین سطر می‌رود تا جمع
  -- تخصیص دقیقاً برابر کل هزینه باشد.
  FOR v_line IN
    SELECT id, variation_id, qty, unit_price, qty * unit_price AS line_amount
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt ORDER BY id
  LOOP
    v_charge_alloc :=
        round(CASE WHEN v_goods > 0 THEN v_by_value * v_line.line_amount / v_goods ELSE 0 END)
      + round(v_by_qty * v_line.qty / v_qty_total);
    v_alloc_sum := v_alloc_sum + v_charge_alloc;
    v_last_line := v_line.id;

    UPDATE purchasing.receipt_line
       SET line_amount      = v_line.line_amount,
           charge_alloc     = v_charge_alloc,
           landed_unit_cost = round((v_line.line_amount + v_charge_alloc) / v_line.qty)
     WHERE id = v_line.id;
  END LOOP;

  IF v_alloc_sum <> v_charges AND v_last_line IS NOT NULL THEN
    UPDATE purchasing.receipt_line
       SET charge_alloc     = charge_alloc + (v_charges - v_alloc_sum),
           landed_unit_cost = round((line_amount + charge_alloc + (v_charges - v_alloc_sum)) / qty)
     WHERE id = v_last_line;
  END IF;

  FOR v_line IN
    SELECT variation_id, qty, landed_unit_cost
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt
  LOOP
    PERFORM inventory.apply_movement(
      v_line.variation_id, r.warehouse_id, v_line.qty,
      'purchase_receipt', 'purchase_receipt', p_receipt, p_user,
      v_line.landed_unit_cost, false, r.occurred_at);
  END LOOP;

  UPDATE purchasing.receipt
     SET goods_amount        = v_goods,
         charges_amount      = v_charges,
         total_payable       = v_goods + r.tax_amount + v_sup_payable,
         third_party_payable = v_other_payable,
         status              = 'posted',
         posted_at           = now()
   WHERE id = p_receipt;

  v_legs := jsonb_build_array(
              jsonb_build_object('leg','inventory','amount', v_goods + v_charges),
              jsonb_build_object('leg','input_tax','amount', r.tax_amount),
              jsonb_build_object('leg','payable',
                                 'amount', v_goods + r.tax_amount + v_sup_payable,
                                 'party_type','supplier','party_id', r.supplier_id),
              jsonb_build_object('leg','other_payable','amount', v_other_payable))
            || v_treasury_legs;

  v_entry := ledger.post_entry(
    'purchase_receipt', r.branch_id, r.occurred_at::date,
    'رسید خرید ' || r.number, v_legs,
    'purchase_receipt', p_receipt, p_user);

  PERFORM platform.audit('purchase.post', 'purchase_receipt', p_receipt::text,
    jsonb_build_object('number', r.number, 'goods', v_goods, 'charges', v_charges,
                       'tax', r.tax_amount, 'supplier_payable', v_goods + r.tax_amount + v_sup_payable,
                       'third_party_payable', v_other_payable, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $$;

COMMIT;
