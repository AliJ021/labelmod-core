-- =====================================================================
-- Label Mod Core — مهاجرت ۰۰۳: اصلاح شکاف‌های بازبینی معماری
-- =====================================================================
-- این مهاجرت هشت نقصِ تأییدشده را می‌بندد. هر کدام ادعای متناظری در
-- db/test/regressions.sql دارد که پیش از این مهاجرت قرمز بود.
--
--   C1  فروش بدون شیفت صندوق هیچ سند حسابداری نمی‌گرفت
--       → مفهوم «دوره ثبت» (posting_batch) از «شیفت صندوق» جدا شد
--   C2  مرجوعی فروش نسیه بدهی مشتری را تسویه نمی‌کرد
--       → تخصیص سه‌مرحله‌ای: بازپرداخت نقدی → بدهی → اعتبار مشتری
--   C3  بازپرداخت نقدی مغایرت کاذب می‌ساخت و دو بار در دفتر می‌نشست
--       → خروج نقد شیفت از خزانه خوانده می‌شود و از نقد مورد انتظار کم
--   C4  سطرهای سند تأییدشده قابل بازنویسی بودند
--       → Trigger تغییرناپذیری روی journal_line
--   C5  لاگ حسابرسی هرگز نوشته نمی‌شد؛ زنجیره هش مسابقه داشت
--       → توابع context و audit + قفل سریال‌ساز زنجیره
--   H1  پرداخت «نامشخص» پول واقعی شمرده می‌شد
--       → حساب واسط مستقل ۱۱۰۶ و leg جداگانه
--   H5  فاکتور روی شیفت بسته نهایی می‌شد
--       → resolve_posting_batch وضعیت دوره را کنترل می‌کند
--   H6  دو قاعده ثبت برای یک مؤلفه، سمت سند را تصادفی می‌کرد
--       → یکتایی (event_type, leg) روی قواعد فعال
--
-- حساب ۱۱۰۶ و قواعد ثبت جدید داده‌اند، نه اسکیما — در db/seed/ هستند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. حسابرسی: زمینه کاربر، تابع ثبت، و سریال‌سازی زنجیره هش (C5)
-- ---------------------------------------------------------------------
-- لایه API پیش از هر عملیات حساس platform.set_actor() را صدا می‌زند.
-- مقدارها با is_local = true ست می‌شوند، پس در پایان تراکنش خودبه‌خود
-- پاک می‌شوند و به درخواست بعدیِ همان اتصال نشت نمی‌کنند.

CREATE OR REPLACE FUNCTION platform.set_actor(
  p_actor uuid, p_ip inet DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('labelmod.actor_id', coalesce(p_actor::text, ''), true);
  PERFORM set_config('labelmod.ip',       coalesce(p_ip::text, ''),    true);
  PERFORM set_config('labelmod.device',   coalesce(p_device, ''),      true);
END $$;

CREATE OR REPLACE FUNCTION platform.current_actor() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('labelmod.actor_id', true);
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
END $$;

-- ثبت حسابرسی بدون کاربر عامل مجاز نیست. اگر جایی این خطا را دیدی،
-- یعنی یک مسیر فراخوانی actor را ست نکرده — همان چیزی که باید بشکند.
CREATE OR REPLACE FUNCTION platform.audit(
  p_action text, p_entity text, p_entity_id text,
  p_after  jsonb DEFAULT NULL,
  p_actor  uuid  DEFAULT NULL,
  p_reason text  DEFAULT NULL,
  p_before jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_actor uuid; v_ip text; v_dev text;
BEGIN
  v_actor := coalesce(p_actor, platform.current_actor());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'ثبت حسابرسی بدون کاربر عامل مجاز نیست (عملیات %). platform.set_actor() فراخوانی نشده است.',
      p_action;
  END IF;
  v_ip  := nullif(current_setting('labelmod.ip', true), '');
  v_dev := nullif(current_setting('labelmod.device', true), '');

  INSERT INTO platform.audit_log
    (actor_id, action, entity, entity_id, before, after, ip, device, reason)
  VALUES
    (v_actor, p_action, p_entity, p_entity_id, p_before, p_after, v_ip::inet, v_dev, p_reason);
END $$;

-- زنجیره هش باید سریال باشد. بدون قفل، دو درج هم‌زمان همان prev_hash را
-- می‌خوانند و زنجیره بی‌صدا دوشاخه می‌شود — یعنی همان چیزی که کل ارزش
-- این جدول رویش بنا شده از بین می‌رود. قفل در سطح تراکنش است و با
-- حجم اسناد این کسب‌وکار هزینه محسوسی ندارد.
CREATE OR REPLACE FUNCTION platform.audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('platform.audit_log')::bigint);

  SELECT hash INTO v_prev FROM platform.audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.hash := encode(digest(
      coalesce(v_prev,'') || NEW.at::text || coalesce(NEW.actor_id::text,'')
      || NEW.action || NEW.entity || coalesce(NEW.entity_id,'')
      || coalesce(NEW.after::text,''), 'sha256'), 'hex');
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- ۲. تغییرناپذیری سطر سند تأییدشده (C4)
-- ---------------------------------------------------------------------
-- تا امروز فقط journal_entry محافظت داشت. سطرها آزاد بودند و Constraint
-- توازن هم اگر هر دو طرف با هم عوض می‌شدند چیزی نمی‌گفت.

CREATE OR REPLACE FUNCTION ledger.protect_posted_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM ledger.journal_entry
   WHERE id = COALESCE(OLD.entry_id, NEW.entry_id);

  -- سند در همین دستور حذف شده (CASCADE از journal_entry) — سطر هم می‌رود
  IF v_status IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  IF v_status IN ('confirmed','final') THEN
    RAISE EXCEPTION
      'سطر سند تأییدشده تغییر نمی‌کند یا حذف نمی‌شود. اصلاح فقط با سند معکوس.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER protect_posted_line_t BEFORE UPDATE OR DELETE ON ledger.journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger.protect_posted_line();

-- سطر سند فقط روی حساب تفصیلیِ قابل ثبت. تست این ادعا از قبل بود،
-- اجبارش نبود — یک سطر روی حساب کل، همه گزارش‌های سلسله‌مراتبی را
-- دوباره‌شماری می‌کند.
CREATE OR REPLACE FUNCTION ledger.assert_postable_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_postable boolean;
BEGIN
  SELECT is_postable INTO v_postable FROM ledger.account WHERE code = NEW.account_code;
  IF NOT coalesce(v_postable, false) THEN
    RAISE EXCEPTION
      'حساب % سند نمی‌پذیرد. فقط حساب تفصیلی با is_postable مجاز است.', NEW.account_code;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assert_postable_account_t BEFORE INSERT ON ledger.journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_postable_account();

-- دوره «در حال بستن» فقط سند دستی و اختتامیه می‌پذیرد، نه سند خودکار فروش
CREATE OR REPLACE FUNCTION ledger.assert_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM ledger.fiscal_year WHERE id = NEW.fiscal_year;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'سال مالی % بسته است و سند جدید نمی‌پذیرد.', NEW.fiscal_year;
  END IF;
  IF v_status = 'closing' AND NEW.kind NOT IN ('manual','closing','opening') THEN
    RAISE EXCEPTION
      'سال مالی % در حال بستن است و فقط سند دستی، افتتاحیه یا اختتامیه می‌پذیرد (نوع درخواستی: %).',
      NEW.fiscal_year, NEW.kind;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- ۳. یک مؤلفه، فقط یک قاعده ثبت فعال (H6)
-- ---------------------------------------------------------------------
-- کلید اصلی (event_type, leg, side) است، پس دو قاعده فعال با سمت متفاوت
-- مجاز بود و post_entry با LIMIT 1 بدون ORDER BY یکی را تصادفی برمی‌داشت.

CREATE UNIQUE INDEX posting_rule_one_active_side
  ON ledger.posting_rule (event_type, leg) WHERE is_active;

-- ---------------------------------------------------------------------
-- ۴. دوره ثبت: جداکردن «تجمیع سند» از «شیفت صندوق» (C1، H5)
-- ---------------------------------------------------------------------
-- سفارش ووکامرس شیفت صندوق ندارد. تا امروز سند فروش فقط در close_shift و
-- فقط برای فاکتورهای همان شیفت زده می‌شد؛ یعنی فروش آنلاین انبار را کم
-- می‌کرد ولی نه درآمدی ثبت می‌شد نه بهای تمام‌شده‌ای، و حساب ۱۳۰۱ دفتر
-- از ارزش واقعی انبار جدا می‌افتاد.
--
-- حالا هر فاکتور در لحظه نهایی‌شدن به یک «دوره ثبت» می‌چسبد:
--   • فاکتور صندوق  → دوره‌ی همان شیفت
--   • فاکتور آنلاین → دوره‌ی (شعبه، کانال، روز)
-- و هیچ فاکتوری بدون دوره نهایی نمی‌شود. sales.unposted_revenue همیشه
-- نشان می‌دهد چه درآمدی هنوز به دفتر نرفته است.

CREATE TABLE ledger.posting_batch (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  branch_id     uuid NOT NULL REFERENCES platform.branch(id),
  kind          text NOT NULL CHECK (kind IN ('shift','channel_day')),
  shift_id      uuid REFERENCES sales.cash_shift(id),
  channel       text,
  business_date date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted')),
  sale_entry_id uuid REFERENCES ledger.journal_entry(id),
  cogs_entry_id uuid REFERENCES ledger.journal_entry(id),
  posted_at     timestamptz,
  posted_by     uuid REFERENCES identity.app_user(id),
  CONSTRAINT batch_scope_shape CHECK (
    (kind = 'shift'       AND shift_id IS NOT NULL AND channel IS NULL) OR
    (kind = 'channel_day' AND shift_id IS NULL     AND channel IS NOT NULL))
);

CREATE UNIQUE INDEX batch_one_per_shift
  ON ledger.posting_batch (shift_id) WHERE kind = 'shift';
CREATE UNIQUE INDEX batch_one_per_channel_day
  ON ledger.posting_batch (branch_id, channel, business_date) WHERE kind = 'channel_day';

ALTER TABLE sales.invoice
  ADD COLUMN posting_batch_id uuid REFERENCES ledger.posting_batch(id);

CREATE INDEX ON sales.invoice (posting_batch_id);
CREATE INDEX ON sales.invoice (shift_id);              -- close_shift کلید جستجویش همین بود

-- مانیتورینگ: هر ردیف اینجا یعنی درآمدی که هنوز به دفتر نرفته.
-- Worker شبانه باید این را صفر نگه دارد و در غیر این صورت هشدار بدهد.
CREATE OR REPLACE VIEW sales.unposted_revenue AS
SELECT i.id AS invoice_id, i.number, i.branch_id, i.channel,
       i.occurred_at, i.payable_amount, i.cogs_amount,
       b.id AS batch_id, b.kind AS batch_kind, b.business_date
  FROM sales.invoice i
  LEFT JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
 WHERE i.status IN ('finalized','paid','partially_returned','returned')
   AND (b.id IS NULL OR b.status <> 'posted');

-- ---------------------------------------------------------------------
-- ۵. مرجوعی: ستون‌های تخصیص و روش بازپرداخت (C2، C3)
-- ---------------------------------------------------------------------

ALTER TABLE sales.sale_return
  ADD COLUMN refund_method       text REFERENCES treasury.payment_method(code),
  ADD COLUMN receivable_applied  platform.money NOT NULL DEFAULT 0,
  ADD COLUMN credit_applied      platform.money NOT NULL DEFAULT 0;

CREATE INDEX ON sales.sale_return (invoice_id);
CREATE INDEX ON sales.sale_return (shift_id);

-- ---------------------------------------------------------------------
-- ۶. حفاظ همزمانی روی دروازه موجودی
-- ---------------------------------------------------------------------
-- تنها تغییر نسبت به ۰۰۲: اگر سطر موجودی پس از ON CONFLICT برنگردد،
-- به‌جای خطای مبهم NOT NULL، علت واقعی گفته می‌شود.

CREATE OR REPLACE FUNCTION inventory.apply_movement(
  p_variation      uuid,
  p_warehouse      uuid,
  p_qty            platform.qty,
  p_kind           text,
  p_ref_type       text     DEFAULT NULL,
  p_ref_id         uuid     DEFAULT NULL,
  p_user           uuid     DEFAULT NULL,
  p_unit_cost      platform.money DEFAULT NULL,
  p_allow_negative boolean  DEFAULT false,
  p_occurred_at    timestamptz DEFAULT NULL,
  p_note           text     DEFAULT NULL,
  p_value_delta    platform.money DEFAULT NULL
) RETURNS inventory.movement_result
LANGUAGE plpgsql AS $$
DECLARE
  v_on_hand  platform.qty;
  v_value    platform.money;
  v_cost     platform.money;
  v_delta    platform.money;
  v_residual platform.money := 0;
  v_new_qty  platform.qty;
  v_id       uuid;
BEGIN
  IF p_qty = 0 THEN
    RAISE EXCEPTION 'حرکت با تعداد صفر مجاز نیست';
  END IF;

  INSERT INTO inventory.stock_balance (variation_id, warehouse_id)
  VALUES (p_variation, p_warehouse)
  ON CONFLICT (variation_id, warehouse_id) DO NOTHING;

  SELECT on_hand, total_value INTO v_on_hand, v_value
    FROM inventory.stock_balance
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'سطر موجودی تنوع % در انبار % در دسترس نیست (تعارض همزمانی). عملیات را دوباره اجرا کنید.',
      p_variation, p_warehouse;
  END IF;

  v_new_qty := v_on_hand + p_qty;

  IF p_qty > 0 THEN
    IF p_unit_cost IS NULL THEN
      RAISE EXCEPTION 'بهای واحد برای ورود کالا اجباری است (تنوع %)', p_variation;
    END IF;
    v_cost  := p_unit_cost;
    v_delta := coalesce(p_value_delta, p_qty * v_cost);

  ELSE
    IF NOT p_allow_negative AND v_new_qty < 0 THEN
      RAISE EXCEPTION
        'موجودی کافی نیست: تنوع %، انبار %، موجود %، درخواست %',
        p_variation, p_warehouse, v_on_hand, abs(p_qty);
    END IF;

    IF p_unit_cost IS NOT NULL THEN
      v_cost := p_unit_cost;
    ELSIF v_on_hand > 0 THEN
      v_cost := round(v_value / v_on_hand);
    ELSE
      v_cost := 0;
    END IF;

    v_delta := coalesce(p_value_delta, p_qty * v_cost);

    IF v_new_qty = 0 AND p_value_delta IS NULL THEN
      v_residual := (-v_value) - v_delta;
      v_delta    := -v_value;
    END IF;
  END IF;

  UPDATE inventory.stock_balance
     SET on_hand     = v_new_qty,
         total_value = v_value + v_delta,
         row_version = row_version + 1,
         updated_at  = now()
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse;

  INSERT INTO inventory.stock_movement
    (variation_id, warehouse_id, qty, unit_cost, value_delta,
     kind, ref_type, ref_id, user_id, occurred_at, note)
  VALUES
    (p_variation, p_warehouse, p_qty, v_cost, v_delta,
     p_kind, p_ref_type, p_ref_id, p_user, coalesce(p_occurred_at, now()), p_note)
  RETURNING id INTO v_id;

  RETURN (v_id, v_cost, v_delta, v_residual)::inventory.movement_result;
END $$;

-- ---------------------------------------------------------------------
-- ۷. تعیین دوره ثبت یک فاکتور (C1، H5)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sales.resolve_posting_batch(p_invoice uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  inv sales.invoice%ROWTYPE;
  v_batch uuid; v_status text; v_shift_status text; v_date date;
BEGIN
  SELECT * INTO inv FROM sales.invoice WHERE id = p_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;

  IF inv.shift_id IS NOT NULL THEN
    SELECT status, opened_at::date INTO v_shift_status, v_date
      FROM sales.cash_shift WHERE id = inv.shift_id;
    IF v_shift_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION
        'شیفت صندوق باز نیست (%). فاکتور روی شیفت بسته نهایی نمی‌شود.', v_shift_status;
    END IF;

    SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
     WHERE kind = 'shift' AND shift_id = inv.shift_id;

    IF v_batch IS NULL THEN
      INSERT INTO ledger.posting_batch (branch_id, kind, shift_id, business_date)
      VALUES (inv.branch_id, 'shift', inv.shift_id, v_date)
      ON CONFLICT DO NOTHING
      RETURNING id, status INTO v_batch, v_status;

      IF v_batch IS NULL THEN            -- نشست دیگری همین لحظه ساختش
        SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
         WHERE kind = 'shift' AND shift_id = inv.shift_id;
      END IF;
    END IF;

  ELSE
    v_date := inv.occurred_at::date;

    SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
     WHERE kind = 'channel_day' AND branch_id = inv.branch_id
       AND channel = inv.channel AND business_date = v_date;

    IF v_batch IS NULL THEN
      INSERT INTO ledger.posting_batch (branch_id, kind, channel, business_date)
      VALUES (inv.branch_id, 'channel_day', inv.channel, v_date)
      ON CONFLICT DO NOTHING
      RETURNING id, status INTO v_batch, v_status;

      IF v_batch IS NULL THEN
        SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
         WHERE kind = 'channel_day' AND branch_id = inv.branch_id
           AND channel = inv.channel AND business_date = v_date;
      END IF;
    END IF;
  END IF;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION
      'دوره ثبت این فاکتور قبلاً بسته شده است. فاکتور با تاریخ دوره بسته نهایی نمی‌شود.';
  END IF;

  RETURN v_batch;
END $$;

-- ---------------------------------------------------------------------
-- ۸. نهایی‌کردن فاکتور (C1، C5، H1، H5)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sales.finalize_invoice(
  p_invoice uuid, p_user uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  inv        sales.invoice%ROWTYPE;
  v_line     record;
  v_mv       inventory.movement_result;
  v_cogs     platform.money := 0;
  v_gross    platform.money := 0;
  v_disc     platform.money := 0;
  v_net      platform.money := 0;
  v_tax      platform.money := 0;
  v_paid     platform.money := 0;
  v_batch    uuid;
  v_fy       smallint;
  v_no       text;
BEGIN
  SELECT * INTO inv FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;

  -- Idempotency: فراخوانی دوباره همان شماره قبلی را برمی‌گرداند
  IF inv.status IN ('finalized','paid','partially_returned','returned') THEN
    RETURN inv.number;
  END IF;
  IF inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'فاکتور باطل‌شده نهایی نمی‌شود';
  END IF;

  -- دوره ثبت پیش از هر اثری تعیین می‌شود: اگر شیفت بسته یا دوره بسته
  -- باشد، باید همین‌جا شکست بخورد، نه بعد از خروج کالا از انبار.
  v_batch := sales.resolve_posting_batch(p_invoice);

  SELECT coalesce(sum(qty * unit_price),0),
         coalesce(sum(discount_amount),0),
         coalesce(sum(net_amount),0),
         coalesce(sum(tax_amount),0)
    INTO v_gross, v_disc, v_net, v_tax
    FROM sales.invoice_line WHERE invoice_id = p_invoice;

  IF v_gross = 0 THEN
    RAISE EXCEPTION 'فاکتور بدون قلم نهایی نمی‌شود';
  END IF;

  FOR v_line IN
    SELECT id, variation_id, qty FROM sales.invoice_line
     WHERE invoice_id = p_invoice ORDER BY line_no
  LOOP
    v_mv := inventory.apply_movement(
      v_line.variation_id, inv.warehouse_id, -v_line.qty,
      'sale', 'invoice', p_invoice, p_user, NULL, false, inv.occurred_at);

    UPDATE sales.invoice_line
       SET unit_cost   = v_mv.unit_cost,
           cogs_amount = abs(v_mv.value_delta)
     WHERE id = v_line.id;

    v_cogs := v_cogs + abs(v_mv.value_delta);
  END LOOP;

  -- پول واقعاً دریافت‌شده. «نامشخص» و «در انتظار» پول نیستند و فاکتور
  -- را پرداخت‌شده نشان نمی‌دهند؛ در سند دوره حساب واسط مستقل می‌گیرند.
  SELECT coalesce(sum(amount),0) INTO v_paid
    FROM treasury.payment
   WHERE invoice_id = p_invoice AND direction = 'in'
     AND status IN ('succeeded','settled','reconciled');

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE inv.occurred_at::date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', inv.occurred_at::date;
  END IF;

  v_no := platform.next_document_no(inv.branch_id, 'invoice', v_fy);

  UPDATE sales.invoice
     SET number           = v_no,
         gross_amount     = v_gross,
         discount_amount  = v_disc,
         net_amount       = v_net,
         tax_amount       = v_tax,
         payable_amount   = v_net + v_tax + inv.shipping_amount,
         paid_amount      = v_paid,
         cogs_amount      = v_cogs,
         posting_batch_id = v_batch,
         status           = 'finalized',
         finalized_at     = now()
   WHERE id = p_invoice;

  PERFORM platform.audit('invoice.finalize', 'invoice', p_invoice::text,
    jsonb_build_object('number', v_no, 'payable', v_net + v_tax + inv.shipping_amount,
                       'paid', v_paid, 'cogs', v_cogs, 'batch', v_batch),
    p_user);

  INSERT INTO platform.outbox_message (topic, payload)
  VALUES ('invoice.finalized',
          jsonb_build_object('invoice_id', p_invoice, 'number', v_no));

  RETURN v_no;
END $$;

-- ---------------------------------------------------------------------
-- ۹. بستن دوره ثبت — سند تجمیعی فروش و بهای تمام‌شده (C1، H1)
-- ---------------------------------------------------------------------
-- جانشین بخش سندزنیِ close_shift. مستقل از اینکه دوره یک شیفت صندوق
-- باشد یا یک روزِ کانال آنلاین.

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
  v_cash     platform.money := 0;
  v_card     platform.money := 0;
  v_transfer platform.money := 0;
  v_unknown  platform.money := 0;
  v_credit   platform.money := 0;
  v_legs     jsonb;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_label    text;
BEGIN
  SELECT * INTO b FROM ledger.posting_batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'دوره ثبت یافت نشد'; END IF;

  -- Idempotent: بستن دوباره همان اسناد قبلی را برمی‌گرداند
  IF b.status = 'posted' THEN
    RETURN QUERY SELECT b.sale_entry_id, b.cogs_entry_id;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM sales.invoice
              WHERE posting_batch_id = p_batch
                AND status IN ('draft','confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'دوره ثبت با فاکتور نهایی‌نشده بسته نمی‌شود';
  END IF;

  -- امتیاز و کارت هدیه هنوز ماژول ندارند. تا آن موقع باید صریح شکست
  -- بخورند، وگرنه بی‌صدا به‌عنوان طلب از مشتری ثبت می‌شوند.
  IF EXISTS (
    SELECT 1 FROM treasury.payment p
      JOIN treasury.payment_method m ON m.code = p.method_code
      JOIN sales.invoice i ON i.id = p.invoice_id
     WHERE i.posting_batch_id = p_batch AND m.kind IN ('points','gift_card')
  ) THEN
    RAISE EXCEPTION
      'پرداخت با امتیاز یا کارت هدیه هنوز پشتیبانی نمی‌شود (ماژول باشگاه مشتریان ساخته نشده).';
  END IF;

  SELECT coalesce(sum(gross_amount),0),    coalesce(sum(discount_amount),0),
         coalesce(sum(tax_amount),0),      coalesce(sum(cogs_amount),0),
         coalesce(sum(shipping_amount),0), coalesce(sum(payable_amount),0)
    INTO v_gross, v_disc, v_tax, v_cogs, v_shipping, v_payable
    FROM sales.invoice
   WHERE posting_batch_id = p_batch
     AND status IN ('finalized','paid','partially_returned','returned');

  SELECT
    coalesce(sum(p.amount) FILTER (
      WHERE m.kind = 'cash'        AND p.status IN ('succeeded','settled','reconciled')), 0),
    coalesce(sum(p.amount) FILTER (
      WHERE m.kind = 'card_reader' AND p.status IN ('succeeded','settled','reconciled')), 0),
    coalesce(sum(p.amount) FILTER (
      WHERE m.kind IN ('transfer','gateway')
        AND p.status IN ('succeeded','settled','reconciled')), 0),
    coalesce(sum(p.amount) FILTER (WHERE p.status IN ('pending','unknown')), 0)
    INTO v_cash, v_card, v_transfer, v_unknown
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
    JOIN sales.invoice i ON i.id = p.invoice_id
   WHERE i.posting_batch_id = p_batch AND p.direction = 'in';

  -- دریافتنی باقی‌مانده است، نه جمع پرداخت‌های نسیه — تنها راهی که سند
  -- در فروش نیمه‌پرداخت هم متوازن می‌ماند.
  v_credit := v_payable - (v_cash + v_card + v_transfer + v_unknown);

  v_label := CASE b.kind
               WHEN 'shift' THEN 'شیفت صندوق ' || to_char(b.business_date, 'YYYY-MM-DD')
               ELSE 'کانال ' || b.channel || ' — ' || to_char(b.business_date, 'YYYY-MM-DD')
             END;

  IF v_gross > 0 THEN
    v_legs := jsonb_build_array(
      jsonb_build_object('leg','cash',              'amount', v_cash),
      jsonb_build_object('leg','card_clearing',     'amount', v_card),
      jsonb_build_object('leg','transfer_clearing', 'amount', v_transfer),
      jsonb_build_object('leg','unknown_clearing',  'amount', v_unknown),
      jsonb_build_object('leg','receivable',        'amount', v_credit),
      jsonb_build_object('leg','discount',          'amount', v_disc),
      jsonb_build_object('leg','sales',             'amount', v_gross),
      jsonb_build_object('leg','shipping',          'amount', v_shipping),
      jsonb_build_object('leg','tax',               'amount', v_tax)
    );

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
                       'cash', v_cash, 'card', v_card, 'transfer', v_transfer,
                       'unknown', v_unknown, 'receivable', v_credit),
    p_user);

  RETURN QUERY SELECT v_sale, v_cogs_e;
END $$;

-- ---------------------------------------------------------------------
-- ۱۰. بستن دوره ثبت کانال آنلاین (C1)
-- ---------------------------------------------------------------------
-- Worker شبانه این را برای هر کانال غیرحضوریِ روز قبل صدا می‌زند.

CREATE OR REPLACE FUNCTION sales.close_channel_day(
  p_branch uuid, p_channel text, p_date date, p_user uuid DEFAULT NULL
) RETURNS TABLE (sale_entry uuid, cogs_entry uuid)
LANGUAGE plpgsql AS $$
DECLARE v_batch uuid;
BEGIN
  SELECT id INTO v_batch FROM ledger.posting_batch
   WHERE kind = 'channel_day' AND branch_id = p_branch
     AND channel = p_channel AND business_date = p_date;

  IF v_batch IS NULL THEN
    RAISE EXCEPTION
      'دوره ثبتی برای کانال «%» در تاریخ % وجود ندارد (هیچ فاکتوری نهایی نشده است).',
      p_channel, p_date;
  END IF;

  RETURN QUERY SELECT r.sale_entry, r.cogs_entry FROM sales.post_batch(v_batch, p_user) r;
END $$;

-- ---------------------------------------------------------------------
-- ۱۱. بستن شیفت — فقط شمارش نقد و مغایرت (C3، C5)
-- ---------------------------------------------------------------------
-- سندزنی به post_batch منتقل شد. تغییر مهم: خروج نقد شیفت (بازپرداخت
-- مرجوعی) از نقد مورد انتظار کم می‌شود. پیش از این، هر بازپرداخت یک
-- کسری کاذب می‌ساخت که به حساب «مغایرت صندوق» می‌رفت — یعنی یک خروج
-- وجه، دو بار در دفتر.

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

  v_date := s.opened_at::date;

  -- شیفتی که هیچ فاکتوری نداشته هم باید دوره بسته‌شده داشته باشد
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

  -- نقد واقعی کشو: ورودی فروش منهای خروجی بازپرداخت
  SELECT coalesce(sum(p.amount) FILTER (WHERE p.direction = 'in'),  0),
         coalesce(sum(p.amount) FILTER (WHERE p.direction = 'out'), 0)
    INTO v_cash_in, v_cash_out
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
   WHERE p.shift_id = p_shift AND m.kind = 'cash'
     AND p.status IN ('succeeded','settled','reconciled');

  v_expected := s.opening_cash + v_cash_in - v_cash_out;
  v_variance := p_counted_cash - v_expected;

  -- مغایرت سند مستقل دارد. مخلوط‌کردنش با سند فروش، «فروش» و
  -- «وجه دریافتی» را در گزارش‌ها به هم می‌ریزد.
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
    jsonb_build_object('opening', s.opening_cash, 'cash_in', v_cash_in,
                       'cash_out', v_cash_out, 'expected', v_expected,
                       'counted', p_counted_cash, 'variance', v_variance),
    p_user, p_note);

  RETURN QUERY SELECT v_sale, v_cogs_e, v_variance;
END $$;

-- ---------------------------------------------------------------------
-- ۱۲. ثبت مرجوعی — تخصیص صحیح بازپرداخت، بدهی و اعتبار (C2، C3، C5)
-- ---------------------------------------------------------------------
-- ارزش کالای برگشتی (خالص + مالیات) به ترتیب زیر تسویه می‌شود:
--   ۱. بازپرداخت نقدی/کارتی — که هرگز از پول واقعاً دریافت‌شده بیشتر نیست
--   ۲. کاهش بدهی باقی‌مانده مشتری بابت همان فاکتور
--   ۳. باقی‌مانده به اعتبار مشتری
-- پیش از این، مرحله ۲ اصلاً وجود نداشت: بدهی دست‌نخورده می‌ماند و کل
-- مبلغ به اعتبار مشتری می‌رفت.

CREATE OR REPLACE FUNCTION sales.post_return(
  p_return uuid, p_user uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r            sales.sale_return%ROWTYPE;
  inv          sales.invoice%ROWTYPE;
  v_line       record;
  v_net        platform.money := 0;
  v_tax        platform.money := 0;
  v_cogs       platform.money := 0;
  v_fy         smallint;
  v_no         text;
  v_remaining  platform.qty;
  v_line_cogs  platform.money;
  v_credit_total   platform.money;
  v_received       platform.money;
  v_refunded_before platform.money;
  v_returned_before platform.money;
  v_refund_paid    platform.money;
  v_outstanding    platform.money;
  v_recv           platform.money;
  v_cust_credit    platform.money;
BEGIN
  SELECT * INTO r FROM sales.sale_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ مرجوعی یافت نشد'; END IF;
  IF r.status = 'posted' THEN RETURN r.number; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'برگ مرجوعی باطل‌شده ثبت نمی‌شود'; END IF;

  SELECT * INTO inv FROM sales.invoice WHERE id = r.invoice_id FOR UPDATE;
  IF inv.status NOT IN ('finalized','paid','partially_returned') THEN
    RAISE EXCEPTION 'فاکتور % در وضعیت قابل مرجوعی نیست (%)', inv.number, inv.status;
  END IF;

  FOR v_line IN
    SELECT rl.id, rl.invoice_line_id, rl.qty, rl.restock, rl.condition,
           il.variation_id, il.unit_cost, il.unit_price, il.qty AS sold_qty,
           il.returned_qty, il.discount_amount, il.tax_amount, il.net_amount,
           il.cogs_amount AS sold_cogs
      FROM sales.sale_return_line rl
      JOIN sales.invoice_line il ON il.id = rl.invoice_line_id
     WHERE rl.return_id = p_return
       FOR UPDATE OF il
  LOOP
    v_remaining := v_line.sold_qty - v_line.returned_qty;
    IF v_line.qty > v_remaining THEN
      RAISE EXCEPTION
        'تعداد مرجوعی بیش از باقی‌مانده سطر است: درخواست %، باقی‌مانده %',
        v_line.qty, v_remaining;
    END IF;

    -- بهای بازگشت نسبتی از بهای همان فروش است، نه میانگین جاری انبار.
    -- برگشت کامل، دقیقاً همان مبلغی را برمی‌گرداند که خارج شده بود.
    IF v_line.qty = v_remaining THEN
      v_line_cogs := v_line.sold_cogs
                     - coalesce((SELECT sum(prl.cogs_amount)
                                   FROM sales.sale_return_line prl
                                   JOIN sales.sale_return pr ON pr.id = prl.return_id
                                  WHERE prl.invoice_line_id = v_line.invoice_line_id
                                    AND pr.status = 'posted'), 0);
    ELSE
      v_line_cogs := round(v_line.sold_cogs * v_line.qty / v_line.sold_qty);
    END IF;

    IF v_line.restock THEN
      PERFORM inventory.apply_movement(
        p_variation   => v_line.variation_id,
        p_warehouse   => CASE WHEN v_line.condition = 'defective'
                              THEN (SELECT id FROM inventory.warehouse
                                     WHERE branch_id = r.branch_id AND kind = 'defective' LIMIT 1)
                              ELSE r.warehouse_id END,
        p_qty         => v_line.qty,
        p_kind        => 'sale_return',
        p_ref_type    => 'sale_return',
        p_ref_id      => p_return,
        p_user        => p_user,
        p_unit_cost   => round(v_line_cogs / v_line.qty),
        p_occurred_at => r.occurred_at,
        p_value_delta => v_line_cogs);
    ELSE
      v_line_cogs := 0;
    END IF;

    UPDATE sales.sale_return_line
       SET unit_price  = v_line.unit_price,
           net_amount  = round(v_line.net_amount * v_line.qty / v_line.sold_qty),
           tax_amount  = round(v_line.tax_amount * v_line.qty / v_line.sold_qty),
           unit_cost   = v_line.unit_cost,
           cogs_amount = v_line_cogs
     WHERE id = v_line.id;

    UPDATE sales.invoice_line
       SET returned_qty = returned_qty + v_line.qty
     WHERE id = v_line.invoice_line_id;
  END LOOP;

  SELECT coalesce(sum(net_amount),0), coalesce(sum(tax_amount),0),
         coalesce(sum(cogs_amount),0)
    INTO v_net, v_tax, v_cogs
    FROM sales.sale_return_line WHERE return_id = p_return;

  v_credit_total := v_net + v_tax;

  -- پول واقعاً دریافت‌شده بابت این فاکتور. «نامشخص» پول نیست.
  SELECT coalesce(sum(amount),0) INTO v_received
    FROM treasury.payment
   WHERE invoice_id = inv.id AND direction = 'in'
     AND status IN ('succeeded','settled','reconciled');

  SELECT coalesce(sum(refund_amount),0),
         coalesce(sum(net_amount + tax_amount),0)
    INTO v_refunded_before, v_returned_before
    FROM sales.sale_return
   WHERE invoice_id = inv.id AND status = 'posted' AND id <> p_return;

  IF r.refund_amount > v_credit_total THEN
    RAISE EXCEPTION
      'بازپرداخت (%) بیش از ارزش کالای مرجوعی (%) است', r.refund_amount, v_credit_total;
  END IF;
  IF r.refund_amount > v_received - v_refunded_before THEN
    RAISE EXCEPTION
      'بازپرداخت (%) بیش از مبلغ دریافت‌شده بابت این فاکتور (%) است. پولی که گرفته نشده، پس داده نمی‌شود.',
      r.refund_amount, v_received - v_refunded_before;
  END IF;

  -- بدهی باقی‌مانده مشتری بابت این فاکتور، پیش از این مرجوعی:
  --   تعهد (مبلغ فاکتور منهای کالای قبلاً برگشتی) منهای تسویه (دریافتی
  --   منهای بازپرداخت‌های قبلی)
  v_outstanding := inv.payable_amount - v_returned_before - v_received + v_refunded_before;
  IF v_outstanding < 0 THEN v_outstanding := 0; END IF;

  v_recv        := least(greatest(v_credit_total - r.refund_amount, 0), v_outstanding);
  v_cust_credit := (v_credit_total - r.refund_amount) - v_recv;

  IF v_cust_credit > 0 AND inv.customer_id IS NULL THEN
    RAISE EXCEPTION
      'فروش ناشناس اعتبار مشتری نمی‌پذیرد. برای مرجوعی این فاکتور، بازپرداخت باید کامل باشد.';
  END IF;

  -- بازپرداخت باید در خزانه هم رد داشته باشد، وگرنه شمارش صندوق و دفتر
  -- از هم جدا می‌افتند.
  SELECT coalesce(sum(amount),0) INTO v_refund_paid
    FROM treasury.payment
   WHERE return_id = p_return AND direction = 'out'
     AND status IN ('succeeded','settled','reconciled');

  IF v_refund_paid = 0 AND r.refund_amount > 0 THEN
    INSERT INTO treasury.payment
      (return_id, shift_id, method_code, direction, amount, status, occurred_at)
    VALUES
      (p_return, r.shift_id, coalesce(r.refund_method, 'cash'), 'out',
       r.refund_amount, 'succeeded', r.occurred_at);
  ELSIF v_refund_paid <> r.refund_amount THEN
    RAISE EXCEPTION
      'مبلغ بازپرداخت (%) با پرداخت‌های ثبت‌شده خزانه (%) نمی‌خواند',
      r.refund_amount, v_refund_paid;
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE r.occurred_at::date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', r.occurred_at::date;
  END IF;

  v_no := platform.next_document_no(r.branch_id, 'sale_return', v_fy);

  UPDATE sales.sale_return
     SET number = v_no, net_amount = v_net, tax_amount = v_tax,
         cogs_amount = v_cogs, receivable_applied = v_recv,
         credit_applied = v_cust_credit, status = 'posted'
   WHERE id = p_return;

  UPDATE sales.invoice
     SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM sales.invoice_line
                             WHERE invoice_id = inv.id AND returned_qty < qty)
           THEN 'returned' ELSE 'partially_returned' END
   WHERE id = inv.id;

  PERFORM ledger.post_entry(
    'sale_return', r.branch_id, r.occurred_at::date,
    'برگشت از فروش ' || v_no || ' — فاکتور ' || inv.number,
    jsonb_build_array(
      jsonb_build_object('leg','sales_return',   'amount', v_net),
      jsonb_build_object('leg','tax',            'amount', v_tax),
      jsonb_build_object('leg','refund_cash',    'amount', r.refund_amount),
      jsonb_build_object('leg','receivable',     'amount', v_recv,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','customer_credit','amount', v_cust_credit,
                         'party_type','customer','party_id', inv.customer_id),
      jsonb_build_object('leg','inventory',      'amount', v_cogs),
      jsonb_build_object('leg','cogs',           'amount', v_cogs)),
    'sale_return', p_return, p_user);

  PERFORM platform.audit('return.post', 'sale_return', p_return::text,
    jsonb_build_object('number', v_no, 'invoice', inv.number,
                       'net', v_net, 'tax', v_tax, 'cogs', v_cogs,
                       'refund', r.refund_amount, 'receivable_applied', v_recv,
                       'credit_applied', v_cust_credit),
    p_user, coalesce(r.reason_note, r.reason_code));

  RETURN v_no;
END $$;

-- ---------------------------------------------------------------------
-- ۱۳. حسابرسی رسید خرید (C5)
-- ---------------------------------------------------------------------
-- تنها تغییر نسبت به ۰۰۲: یک فراخوانی platform.audit در انتها.
-- ناسازگاری total_payable با سند (H4) در مهاجرت ۰۰۴ خزانه اصلاح می‌شود.

CREATE OR REPLACE FUNCTION purchasing.post_receipt(
  p_receipt uuid, p_user uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  r            purchasing.receipt%ROWTYPE;
  v_goods      platform.money := 0;
  v_charges    platform.money := 0;
  v_charge_alloc platform.money;
  v_qty_total  platform.qty := 0;
  v_line       record;
  v_alloc_sum  platform.money := 0;
  v_last_line  uuid;
  v_by_value   platform.money := 0;
  v_by_qty     platform.money := 0;
  v_paid_cash  platform.money := 0;
  v_entry      uuid;
  v_legs       jsonb;
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
         coalesce(sum(amount) FILTER (WHERE paid_from = 'cash'), 0)
    INTO v_by_value, v_by_qty, v_charges, v_paid_cash
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

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
     SET goods_amount   = v_goods,
         charges_amount = v_charges,
         total_payable  = v_goods + r.tax_amount,
         status         = 'posted',
         posted_at      = now()
   WHERE id = p_receipt;

  v_legs := jsonb_build_array(
    jsonb_build_object('leg','inventory','amount', v_goods + v_charges),
    jsonb_build_object('leg','input_tax','amount', r.tax_amount),
    jsonb_build_object('leg','payable',
                       'amount', v_goods + r.tax_amount + (v_charges - v_paid_cash),
                       'party_type','supplier','party_id', r.supplier_id),
    jsonb_build_object('leg','cash','amount', v_paid_cash)
  );

  v_entry := ledger.post_entry(
    'purchase_receipt', r.branch_id, r.occurred_at::date,
    'رسید خرید ' || r.number, v_legs,
    'purchase_receipt', p_receipt, p_user);

  PERFORM platform.audit('purchase.post', 'purchase_receipt', p_receipt::text,
    jsonb_build_object('number', r.number, 'goods', v_goods,
                       'charges', v_charges, 'tax', r.tax_amount, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $$;

COMMIT;
