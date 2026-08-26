-- =====================================================================
-- Label Mod Core — مهاجرت ۰۰۱: اسکیمای پایه
-- =====================================================================
-- اصول حاکم بر این فایل:
--   ۱. پول همیشه NUMERIC(18,0) به ریال است. هیچ‌جا float نیست.
--   ۲. موجودی فقط از طریق stock_movement تغییر می‌کند. عدد مستقیم نوشته نمی‌شود.
--   ۳. اسناد نهایی حذف یا بازنویسی نمی‌شوند. اصلاح با سند معکوس.
--   ۴. هر سند حسابداری باید متوازن باشد — با Constraint، نه با اعتماد به کد.
--   ۵. تصمیم‌هایی که هنوز گرفته نشده‌اند (کدینگ، سقف تخفیف، نرخ مالیات)
--      داده‌اند نه کد، تا بعداً بدون مهاجرت قابل تغییر باشند.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA platform;
CREATE SCHEMA identity;
CREATE SCHEMA catalog;
CREATE SCHEMA inventory;
CREATE SCHEMA purchasing;
CREATE SCHEMA sales;
CREATE SCHEMA treasury;
CREATE SCHEMA ledger;

-- ---------------------------------------------------------------------
-- انواع پایه
-- ---------------------------------------------------------------------

-- پول: ریال، عدد صحیح، بدون اعشار. تبدیل به تومان فقط در لایه نمایش.
CREATE DOMAIN platform.money AS NUMERIC(18,0);

-- تعداد: تا سه رقم اعشار برای واحدهای غیرصحیح آینده (متر پارچه و غیره)
CREATE DOMAIN platform.qty AS NUMERIC(14,3);

-- شناسه مرتب بر اساس زمان. UUIDv7 در سطح اپلیکیشن ساخته می‌شود؛
-- این تابع برای seed و تست‌های داخل دیتابیس است.
CREATE OR REPLACE FUNCTION platform.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  b bytea := gen_random_bytes(10);
BEGIN
  RETURN encode(
    set_byte(
      set_byte(
        substring(int8send(ts_ms) from 3 for 6) || b,
        6, (get_byte(b, 0) & 15) | 112),        -- version 7
      8, (get_byte(b, 2) & 63) | 128)           -- variant
  , 'hex')::uuid;
END $$;

-- ---------------------------------------------------------------------
-- platform: تنظیمات، تقویم، شماره‌گذار، حسابرسی، صف
-- ---------------------------------------------------------------------

-- هر تصمیم بازِ سند اینجا می‌نشیند. تغییرش نیازی به Deploy ندارد.
CREATE TABLE platform.setting (
  key            text PRIMARY KEY,
  value          jsonb       NOT NULL,
  description    text        NOT NULL,
  requires_approval boolean  NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

CREATE TABLE platform.branch (
  id        uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

-- تقویم شمسی از پیش پرشده. تمام گزارش‌های مقایسه‌ای به این Join می‌شوند.
CREATE TABLE platform.calendar_day (
  date_g      date PRIMARY KEY,
  jy          smallint NOT NULL,
  jm          smallint NOT NULL,
  jd          smallint NOT NULL,
  j_label     text     NOT NULL,          -- 1405-06-03
  dow         smallint NOT NULL,          -- 0=شنبه … 6=جمعه
  j_week      smallint NOT NULL,
  is_holiday  boolean  NOT NULL DEFAULT false,
  holiday_name text
);
CREATE INDEX ON platform.calendar_day (jy, jm);

-- شماره‌گذاری بدون پرش. قفل در همان تراکنش Commit سند گرفته می‌شود.
CREATE TABLE platform.document_counter (
  branch_id   uuid NOT NULL REFERENCES platform.branch(id),
  doc_type    text NOT NULL,
  fiscal_year smallint NOT NULL,
  prefix      text NOT NULL DEFAULT '',
  last_no     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, doc_type, fiscal_year)
);

CREATE OR REPLACE FUNCTION platform.next_document_no(
  p_branch uuid, p_doc_type text, p_fiscal_year smallint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_no bigint; v_prefix text;
BEGIN
  UPDATE platform.document_counter
     SET last_no = last_no + 1
   WHERE branch_id = p_branch AND doc_type = p_doc_type AND fiscal_year = p_fiscal_year
  RETURNING last_no, prefix INTO v_no, v_prefix;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'شمارنده سند برای (%/%/%) تعریف نشده است',
      p_branch, p_doc_type, p_fiscal_year;
  END IF;

  RETURN v_prefix || lpad(v_no::text, 6, '0');
END $$;

-- حسابرسی: فقط INSERT. زنجیره هش، تا دستکاری بعدی قابل تشخیص باشد.
CREATE TABLE platform.audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          inet,
  device      text,
  reason      text,
  prev_hash   text,
  hash        text
);

CREATE OR REPLACE FUNCTION platform.audit_no_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log فقط قابل درج است و تغییر یا حذف نمی‌پذیرد';
END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.audit_no_change();

CREATE OR REPLACE FUNCTION platform.audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prev text;
BEGIN
  SELECT hash INTO v_prev FROM platform.audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.hash := encode(digest(
      coalesce(v_prev,'') || NEW.at::text || coalesce(NEW.actor_id::text,'')
      || NEW.action || NEW.entity || coalesce(NEW.entity_id,'')
      || coalesce(NEW.after::text,''), 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain_t BEFORE INSERT ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.audit_chain();

-- Inbox: تشخیص رویداد تکراری. پایه Exactly-Once Effect.
CREATE TABLE platform.inbox_message (
  source       text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL,
  result_ref   text,
  PRIMARY KEY (source, event_id)
);

-- Outbox: پیامک، PDF، ارسال وضعیت به ووکامرس — همه بعد از Commit
CREATE TABLE platform.outbox_message (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','dead')),
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  sent_at       timestamptz
);
CREATE INDEX ON platform.outbox_message (status, next_attempt_at)
  WHERE status = 'pending';

-- نگاشت شناسه‌های خارجی. هیچ شناسه خارجی کلید اصلی نیست.
CREATE TABLE platform.external_id_map (
  source      text NOT NULL,              -- 'woocommerce' | 'legacy_acc' | …
  entity_type text NOT NULL,              -- 'variation' | 'customer' | 'order'
  external_id text NOT NULL,
  entity_id   uuid NOT NULL,
  synced_at   timestamptz,
  PRIMARY KEY (source, entity_type, external_id)
);
CREATE INDEX ON platform.external_id_map (entity_type, entity_id);

-- ---------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------

CREATE TABLE identity.app_user (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  username      text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  mobile        text UNIQUE,
  password_hash text,
  pin_hash      text,
  is_active     boolean NOT NULL DEFAULT true,
  totp_secret   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.role (
  code text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE identity.user_role (
  user_id   uuid NOT NULL REFERENCES identity.app_user(id),
  role_code text NOT NULL REFERENCES identity.role(code),
  branch_id uuid REFERENCES platform.branch(id),
  PRIMARY KEY (user_id, role_code)
);

-- ماتریس تأیید: داده است، نه شرط در کد. سقف‌ها بدون Deploy عوض می‌شوند.
CREATE TABLE identity.permission_rule (
  role_code     text NOT NULL REFERENCES identity.role(code),
  operation     text NOT NULL,
  allowed       boolean NOT NULL DEFAULT true,
  max_amount    platform.money,          -- NULL = بی‌سقف
  max_percent   numeric(5,2),            -- برای تخفیف
  needs_approval_from text REFERENCES identity.role(code),
  PRIMARY KEY (role_code, operation)
);

CREATE TABLE identity.approval_request (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  operation    text NOT NULL,
  requested_by uuid NOT NULL REFERENCES identity.app_user(id),
  approved_by  uuid REFERENCES identity.app_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected')),
  reason       text NOT NULL,
  context      jsonb,
  CONSTRAINT self_approval_forbidden CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- ---------------------------------------------------------------------
-- catalog
-- ---------------------------------------------------------------------

CREATE TABLE catalog.brand (
  id   uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  name text NOT NULL UNIQUE
);

CREATE TABLE catalog.category (
  id        uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  parent_id uuid REFERENCES catalog.category(id),
  name      text NOT NULL,
  path      text NOT NULL
);

CREATE TABLE catalog.product (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  code          text NOT NULL UNIQUE,
  name_internal text NOT NULL,            -- نامی که حسابداری و انبار می‌بینند
  name_web      text,                     -- عنوان نمایشی سایت — می‌تواند متفاوت باشد
  brand_id      uuid REFERENCES catalog.brand(id),
  category_id   uuid REFERENCES catalog.category(id),
  season        text,
  collection    text,
  fabric        text,
  fit           text,                     -- جذب، رگولار، استریت، نیم‌بگ، بگ
  origin_country text,
  tax_rate_code text NOT NULL DEFAULT 'standard',  -- نرخ در سطح کالا، نه کلی
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.variation (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  product_id   uuid NOT NULL REFERENCES catalog.product(id),
  color        text,
  size         text,
  sku          text NOT NULL UNIQUE,
  barcode      text UNIQUE,
  qr_token     text UNIQUE,               -- توکن امن، نه خود id
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','preorder','archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, color, size)
);

-- اندازه واقعی هر سایز — سوخت موتور پیشنهاد سایز در فازهای بعد
CREATE TABLE catalog.variation_measure (
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  key          text NOT NULL,             -- waist | inseam | chest | shoulder …
  value_cm     numeric(6,1) NOT NULL,
  PRIMARY KEY (variation_id, key)
);

-- قیمت با تاریخچه. قیمت جاری = آخرین ردیف valid_from که هنوز باطل نشده.
CREATE TABLE catalog.price (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  price_list   text NOT NULL DEFAULT 'default',
  amount       platform.money NOT NULL CHECK (amount >= 0),
  kind         text NOT NULL DEFAULT 'regular'
               CHECK (kind IN ('regular','markdown','promo')),
  reason       text,
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  created_by   uuid REFERENCES identity.app_user(id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX ON catalog.price (variation_id, price_list, valid_from DESC);

-- ---------------------------------------------------------------------
-- inventory
-- ---------------------------------------------------------------------

CREATE TABLE inventory.warehouse (
  id        uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL REFERENCES platform.branch(id),
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  kind      text NOT NULL DEFAULT 'store'
            CHECK (kind IN ('store','stock','defective','transit')),
  is_active boolean NOT NULL DEFAULT true
);

-- مرجع نهایی موجودی. فقط INSERT.
CREATE TABLE inventory.stock_movement (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  variation_id  uuid NOT NULL REFERENCES catalog.variation(id),
  warehouse_id  uuid NOT NULL REFERENCES inventory.warehouse(id),
  qty           platform.qty NOT NULL CHECK (qty <> 0),   -- مثبت ورود، منفی خروج
  unit_cost     platform.money NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  value_delta   platform.money NOT NULL,                  -- اثر روی ارزش موجودی
  kind          text NOT NULL CHECK (kind IN (
                  'opening','purchase_receipt','purchase_return',
                  'sale','sale_return','transfer_in','transfer_out',
                  'count_adjust','defective','lost','correction')),
  ref_type      text,
  ref_id        uuid,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  user_id       uuid REFERENCES identity.app_user(id),
  note          text
);
CREATE INDEX ON inventory.stock_movement (variation_id, warehouse_id, occurred_at);
CREATE INDEX ON inventory.stock_movement (ref_type, ref_id);

CREATE OR REPLACE FUNCTION inventory.movement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'حرکت انبار قابل تغییر یا حذف نیست. اصلاح فقط با حرکت معکوس.';
END $$;
CREATE TRIGGER movement_immutable_t BEFORE UPDATE OR DELETE ON inventory.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inventory.movement_immutable();

-- Projection. مرجع نیست — از حرکت‌ها ساخته می‌شود و شبانه با آن‌ها تطبیق می‌خورد.
-- total_value نگه داشته می‌شود نه avg_cost، تا میانگین موزون بدون رانش بماند.
CREATE TABLE inventory.stock_balance (
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),
  on_hand      platform.qty   NOT NULL DEFAULT 0,
  reserved     platform.qty   NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  total_value  platform.money NOT NULL DEFAULT 0,
  row_version  bigint NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variation_id, warehouse_id),
  CONSTRAINT value_sign_matches_qty CHECK (
    (on_hand = 0 AND total_value = 0) OR (on_hand > 0 AND total_value >= 0) OR on_hand < 0
  )
);

CREATE TABLE inventory.stock_reservation (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),
  qty          platform.qty NOT NULL CHECK (qty > 0),
  source       text NOT NULL,             -- 'pos' | 'woocommerce'
  source_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  released_at  timestamptz
);
CREATE INDEX ON inventory.stock_reservation (variation_id, warehouse_id)
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------
-- purchasing
-- ---------------------------------------------------------------------

CREATE TABLE purchasing.supplier (
  id         uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  mobile     text,
  phone      text,
  address    text,
  national_id text,
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE purchasing.receipt (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number        text NOT NULL,
  branch_id     uuid NOT NULL REFERENCES platform.branch(id),
  supplier_id   uuid NOT NULL REFERENCES purchasing.supplier(id),
  warehouse_id  uuid NOT NULL REFERENCES inventory.warehouse(id),
  supplier_invoice_no text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  goods_amount  platform.money NOT NULL DEFAULT 0,
  charges_amount platform.money NOT NULL DEFAULT 0,
  tax_amount    platform.money NOT NULL DEFAULT 0,
  total_payable platform.money NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','posted','cancelled')),
  posted_at     timestamptz,
  created_by    uuid REFERENCES identity.app_user(id),
  note          text,
  UNIQUE (branch_id, number)
);

CREATE TABLE purchasing.receipt_line (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  receipt_id   uuid NOT NULL REFERENCES purchasing.receipt(id) ON DELETE CASCADE,
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  qty          platform.qty NOT NULL CHECK (qty > 0),
  unit_price   platform.money NOT NULL CHECK (unit_price >= 0),
  line_amount  platform.money NOT NULL,
  charge_alloc platform.money NOT NULL DEFAULT 0,   -- سهم هزینه جانبی
  landed_unit_cost platform.money NOT NULL DEFAULT 0
);

-- هزینه حمل، گمرک، بسته‌بندی — به بهای کالا تخصیص می‌یابد
CREATE TABLE purchasing.receipt_charge (
  id          uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  receipt_id  uuid NOT NULL REFERENCES purchasing.receipt(id) ON DELETE CASCADE,
  charge_type text NOT NULL,              -- freight | customs | packaging | other
  amount      platform.money NOT NULL CHECK (amount >= 0),
  allocation  text NOT NULL DEFAULT 'by_value'
              CHECK (allocation IN ('by_value','by_qty','none')),
  paid_from   text                        -- cash | bank | payable
);

-- ---------------------------------------------------------------------
-- sales
-- ---------------------------------------------------------------------

CREATE TABLE sales.customer (
  id                uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  mobile_normalized text UNIQUE,          -- کلید تطبیق، نه کلید اصلی
  full_name         text,
  email             text,
  birth_date        date,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('pending','active','merged','blocked')),
  merged_into       uuid REFERENCES sales.customer(id),
  credit_limit      platform.money NOT NULL DEFAULT 0,
  due_days          smallint NOT NULL DEFAULT 0,
  consent_sms       boolean NOT NULL DEFAULT false,
  consent_marketing boolean NOT NULL DEFAULT false,
  tags              text[] NOT NULL DEFAULT '{}',
  internal_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sales.normalize_mobile(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    ELSE regexp_replace(
      regexp_replace(translate(p, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'),
                     '[^0-9]', '', 'g'),
      '^(0098|98|0)?9', '09')
  END
$$;

CREATE TABLE sales.cash_shift (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  branch_id    uuid NOT NULL REFERENCES platform.branch(id),
  user_id      uuid NOT NULL REFERENCES identity.app_user(id),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  opening_cash platform.money NOT NULL DEFAULT 0,
  closed_at    timestamptz,
  counted_cash platform.money,
  expected_cash platform.money,
  variance     platform.money,
  variance_note text,
  approved_by  uuid REFERENCES identity.app_user(id),
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','closed','approved'))
);
CREATE UNIQUE INDEX one_open_shift_per_user
  ON sales.cash_shift (branch_id, user_id) WHERE status = 'open';

CREATE TABLE sales.invoice (
  id              uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number          text,                    -- فقط هنگام Commit تخصیص می‌یابد
  branch_id       uuid NOT NULL REFERENCES platform.branch(id),
  warehouse_id    uuid NOT NULL REFERENCES inventory.warehouse(id),
  shift_id        uuid REFERENCES sales.cash_shift(id),
  customer_id     uuid REFERENCES sales.customer(id),
  channel         text NOT NULL DEFAULT 'pos'
                  CHECK (channel IN ('pos','web','phone')),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','confirmed','partially_paid','paid',
                                    'finalized','partially_returned','returned','cancelled')),
  gross_amount    platform.money NOT NULL DEFAULT 0,
  discount_amount platform.money NOT NULL DEFAULT 0,
  net_amount      platform.money NOT NULL DEFAULT 0,
  tax_amount      platform.money NOT NULL DEFAULT 0,
  shipping_amount platform.money NOT NULL DEFAULT 0,
  payable_amount  platform.money NOT NULL DEFAULT 0,
  paid_amount     platform.money NOT NULL DEFAULT 0,
  cogs_amount     platform.money NOT NULL DEFAULT 0,
  -- فیلدهای مالیاتی: از حالا هستند تا افزودن بعدی نیازمند بازسازی داده نباشد
  tax_invoice_uid text,
  tax_memory_id   text,
  tax_pattern     text,
  tax_status      text NOT NULL DEFAULT 'not_applicable'
                  CHECK (tax_status IN ('not_applicable','pending','sent','confirmed','rejected')),
  -- پایه Idempotency و صف دستگاه (فاز ۳)
  client_event_id text UNIQUE,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  finalized_at    timestamptz,
  created_by      uuid REFERENCES identity.app_user(id),
  note            text,
  UNIQUE (branch_id, number)
);
CREATE INDEX ON sales.invoice (customer_id, occurred_at DESC);
CREATE INDEX ON sales.invoice (branch_id, occurred_at DESC);
CREATE INDEX ON sales.invoice (status) WHERE status IN ('draft','confirmed','partially_paid');

CREATE TABLE sales.invoice_line (
  id              uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  invoice_id      uuid NOT NULL REFERENCES sales.invoice(id) ON DELETE CASCADE,
  line_no         smallint NOT NULL,
  variation_id    uuid NOT NULL REFERENCES catalog.variation(id),
  qty             platform.qty NOT NULL CHECK (qty > 0),
  -- Snapshot لحظه فروش. هرگز از قیمت جاری خوانده نمی‌شود.
  unit_price      platform.money NOT NULL CHECK (unit_price >= 0),
  discount_amount platform.money NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount      platform.money NOT NULL DEFAULT 0,
  net_amount      platform.money NOT NULL,
  -- Snapshot بهای تمام‌شده. مرجع محاسبه سود و بهای بازگشت مرجوعی.
  unit_cost       platform.money NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  cogs_amount     platform.money NOT NULL DEFAULT 0,
  returned_qty    platform.qty NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  discount_reason text,
  UNIQUE (invoice_id, line_no),
  CONSTRAINT returned_not_more_than_sold CHECK (returned_qty <= qty)
);
CREATE INDEX ON sales.invoice_line (variation_id);

CREATE TABLE sales.sale_return (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number        text,
  branch_id     uuid NOT NULL REFERENCES platform.branch(id),
  invoice_id    uuid NOT NULL REFERENCES sales.invoice(id),
  warehouse_id  uuid NOT NULL REFERENCES inventory.warehouse(id),
  shift_id      uuid REFERENCES sales.cash_shift(id),
  kind          text NOT NULL DEFAULT 'return'
                CHECK (kind IN ('return','exchange')),
  net_amount    platform.money NOT NULL DEFAULT 0,
  tax_amount    platform.money NOT NULL DEFAULT 0,
  refund_amount platform.money NOT NULL DEFAULT 0,
  cogs_amount   platform.money NOT NULL DEFAULT 0,
  reason_code   text NOT NULL,            -- فهرست بسته، از روز اول اجباری
  reason_note   text,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','posted','cancelled')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES identity.app_user(id),
  approved_by   uuid REFERENCES identity.app_user(id),
  UNIQUE (branch_id, number)
);

CREATE TABLE sales.sale_return_line (
  id              uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  return_id       uuid NOT NULL REFERENCES sales.sale_return(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES sales.invoice_line(id),
  qty             platform.qty NOT NULL CHECK (qty > 0),
  unit_price      platform.money NOT NULL,
  net_amount      platform.money NOT NULL,
  tax_amount      platform.money NOT NULL DEFAULT 0,
  unit_cost       platform.money NOT NULL,   -- از سطر فروش اصلی، نه میانگین جاری
  cogs_amount     platform.money NOT NULL,
  restock         boolean NOT NULL DEFAULT true,
  condition       text NOT NULL DEFAULT 'sellable'
                  CHECK (condition IN ('sellable','defective'))
);

-- ثبت «سایز نداشتیم» — ارزان‌ترین داده با بالاترین ارزش برای خرید فصل بعد
CREATE TABLE sales.lost_sale (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  branch_id    uuid NOT NULL REFERENCES platform.branch(id),
  product_id   uuid REFERENCES catalog.product(id),
  variation_id uuid REFERENCES catalog.variation(id),
  requested_size text,
  requested_color text,
  reason       text NOT NULL DEFAULT 'out_of_stock',
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES identity.app_user(id)
);

-- ---------------------------------------------------------------------
-- treasury
-- ---------------------------------------------------------------------

CREATE TABLE treasury.payment_method (
  code            text PRIMARY KEY,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN
                    ('cash','card_reader','transfer','gateway','credit','points','gift_card')),
  -- حساب واسط: پول کارت‌خوان و درگاه در لحظه فروش وارد بانک نمی‌شود
  clearing_account_code text,
  settlement_days smallint NOT NULL DEFAULT 0,
  fee_percent     numeric(5,3) NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  requires_ref    boolean NOT NULL DEFAULT false
);

CREATE TABLE treasury.payment (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  invoice_id   uuid REFERENCES sales.invoice(id),
  return_id    uuid REFERENCES sales.sale_return(id),
  shift_id     uuid REFERENCES sales.cash_shift(id),
  method_code  text NOT NULL REFERENCES treasury.payment_method(code),
  direction    text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  amount       platform.money NOT NULL CHECK (amount > 0),
  ref_no       text,                       -- شماره پیگیری کارت‌خوان یا درگاه
  status       text NOT NULL DEFAULT 'succeeded'
               CHECK (status IN ('initiated','pending','unknown','succeeded',
                                 'settled','failed','reversed','reconciled')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  fee_amount   platform.money NOT NULL DEFAULT 0,
  note         text,
  CONSTRAINT payment_has_one_parent CHECK (num_nonnulls(invoice_id, return_id) = 1)
);
CREATE INDEX ON treasury.payment (shift_id, method_code);
CREATE INDEX ON treasury.payment (status) WHERE status IN ('unknown','pending');

-- ---------------------------------------------------------------------
-- ledger
-- ---------------------------------------------------------------------

CREATE TABLE ledger.account (
  code       text PRIMARY KEY,
  parent_code text REFERENCES ledger.account(code),
  name       text NOT NULL,
  level      text NOT NULL CHECK (level IN ('kol','moin','tafsili')),
  nature     text NOT NULL CHECK (nature IN ('debit','credit')),
  type       text NOT NULL CHECK (type IN
               ('asset','liability','equity','revenue','expense','contra_revenue')),
  is_postable boolean NOT NULL DEFAULT false,   -- فقط تفصیلی‌ها سند می‌پذیرند
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE ledger.cost_center (
  code text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE ledger.fiscal_year (
  id         smallint PRIMARY KEY,        -- 1405
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  status     text NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','closing','closed')),
  CHECK (ends_on > starts_on)
);

CREATE TABLE ledger.journal_entry (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number       text,
  fiscal_year  smallint NOT NULL REFERENCES ledger.fiscal_year(id),
  branch_id    uuid NOT NULL REFERENCES platform.branch(id),
  entry_date   date NOT NULL,
  kind         text NOT NULL,             -- sale | cogs | purchase | return | settlement | manual | opening
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','temporary','confirmed','final')),
  description  text NOT NULL,
  ref_type     text,
  ref_id       uuid,
  reverses_id  uuid REFERENCES ledger.journal_entry(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES identity.app_user(id),
  UNIQUE (branch_id, fiscal_year, number)
);
CREATE INDEX ON ledger.journal_entry (entry_date);
CREATE INDEX ON ledger.journal_entry (ref_type, ref_id);

CREATE TABLE ledger.journal_line (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  entry_id     uuid NOT NULL REFERENCES ledger.journal_entry(id) ON DELETE CASCADE,
  line_no      smallint NOT NULL,
  account_code text NOT NULL REFERENCES ledger.account(code),
  cost_center  text REFERENCES ledger.cost_center(code),
  party_type   text,                      -- customer | supplier | user
  party_id     uuid,
  debit        platform.money NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       platform.money NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description  text,
  UNIQUE (entry_id, line_no),
  CONSTRAINT one_side_only CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX ON ledger.journal_line (account_code);
CREATE INDEX ON ledger.journal_line (party_type, party_id);

-- توازن سند: با Constraint، نه با اعتماد به کد اپلیکیشن.
-- معوق است تا سطرها بتوانند یکی‌یکی درج شوند و در پایان تراکنش بررسی شود.
CREATE OR REPLACE FUNCTION ledger.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_entry uuid; v_debit platform.money; v_credit platform.money; v_n int;
BEGIN
  v_entry := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT count(*), coalesce(sum(debit),0), coalesce(sum(credit),0)
    INTO v_n, v_debit, v_credit
    FROM ledger.journal_line WHERE entry_id = v_entry;

  IF v_n = 0 THEN RETURN NULL; END IF;   -- سند حذف شده

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'سند % متوازن نیست: بدهکار % ، بستانکار % ، اختلاف %',
      v_entry, v_debit, v_credit, v_debit - v_credit;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entry_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger.journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balanced();

-- سند نهایی بازنویسی یا حذف نمی‌شود
CREATE OR REPLACE FUNCTION ledger.protect_final_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('confirmed','final') THEN
      RAISE EXCEPTION 'سند نهایی حذف نمی‌شود. از سند معکوس استفاده کنید.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'final' AND NEW.status <> 'final' THEN
    RAISE EXCEPTION 'سند نهایی به وضعیت دیگری برنمی‌گردد.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_final_entry_t BEFORE UPDATE OR DELETE ON ledger.journal_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.protect_final_entry();

-- قفل دوره مالی
CREATE OR REPLACE FUNCTION ledger.assert_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM ledger.fiscal_year WHERE id = NEW.fiscal_year;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'سال مالی % بسته است و سند جدید نمی‌پذیرد.', NEW.fiscal_year;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assert_period_open_t BEFORE INSERT OR UPDATE ON ledger.journal_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_period_open();

-- قواعد ثبت: کدینگ حساب داده است، نه کد.
-- تغییر تصمیم حسابدار = UPDATE روی این جدول، نه Deploy.
CREATE TABLE ledger.posting_rule (
  id            serial PRIMARY KEY,
  event_type    text NOT NULL,            -- sale_shift | purchase_receipt | sale_return …
  leg           text NOT NULL,            -- نام مؤلفه مبلغ: net_sales, tax, cash …
  side          text NOT NULL CHECK (side IN ('debit','credit')),
  account_code  text NOT NULL REFERENCES ledger.account(code),
  party_type    text,
  description   text NOT NULL,
  sort_order    smallint NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (event_type, leg, side)
);

COMMIT;
