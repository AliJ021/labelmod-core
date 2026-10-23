-- =====================================================================
-- ۱۰۲ — سفارش اینستاگرام (نسخهٔ ۱): ورود دستی اپراتور، پرداخت کامل کارت‌به‌کارت پیش از ارسال
-- =====================================================================
-- قرارداد کامل: docs/INSTAGRAM-ORDERS.md. خلاصهٔ آنچه این مهاجرت می‌سازد:
--
-- ── کانال، نه «منبع» ────────────────────────────────────────────────
-- ممیزی main: دورهٔ ثبت فاکتور بی‌شیفت بر (شعبه، کانال، روز) است، post_batch و
-- finalize_invoice به کانال وابسته نیستند و گزارش‌ها بر کانال گروه می‌شوند. پس
-- `instagram` یک مقدار تازهٔ کانال است: درآمدش دورهٔ روزانهٔ خودش را دارد و هرگز
-- به شیفت صندوق یا کانال وب نمی‌رود. ستون «منبع» جدا یعنی هر گزارش دو محور، و
-- جمع‌ها جایی واگرا می‌شدند.
--
-- ── هویت ─────────────────────────────────────────────────────────────
-- شناسه و شمارهٔ سفارش از سرور می‌آیند و با اپراتور عوض نمی‌شوند. هویت عامل یا
-- شناسهٔ خارجی Woo (inventory.web_order_reservation) استفاده نمی‌شود.
--
-- ── رزرو ─────────────────────────────────────────────────────────────
-- همان سازوکار ۰۰۱/۰۹۲: stock_balance.reserved + stock_reservation با
-- source='instagram'. نگهبان guard_reserved_stock و خوراک/Push سایت
-- (`on_hand − reserved`) بی تغییر کار می‌کنند. رزرو Woo دست نمی‌خورد.
--
-- ── نگهبان‌ها در دیتابیس، نه فقط در API ──────────────────────────────
-- فاکتور کانال instagram فقط از مسیر سفارش خودش ساخته، ویرایش، پرداخت و
-- نهایی می‌شود (GUC محلیِ `lmc.instagram_order`). مسیر عمومی /invoices
-- نمی‌تواند پرداخت یا نهایی‌سازی را دور بزند.
--
-- ⚠️ قید کانال دو مرحله‌ای است (FND-R60-05): DROP + ADD NOT VALID اینجا قفل کوتاه
--    می‌گیرند و VALIDATE در مهاجرت جدای ۱۰۳ با SHARE UPDATE EXCLUSIVE اجرا می‌شود؛
--    فروش نمی‌خوابد. جدا بودن فایل یعنی شکستِ VALIDATE نیمی از این مهاجرت را Commit‌شده
--    و ثبت‌نشده جا نمی‌گذارد (ops/db.sh هر فایل را یک واحد ثبت می‌کند).
-- نصب تازه: db/seed/102_instagram_orders.sql (نقش‌ها پس از مهاجرت ساخته می‌شوند).
-- =====================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE sales.invoice DROP CONSTRAINT invoice_channel_check;
ALTER TABLE sales.invoice ADD CONSTRAINT invoice_channel_check
  CHECK (channel IN ('pos','web','phone','instagram')) NOT VALID;

CREATE SEQUENCE sales.instagram_order_no_seq;

CREATE TABLE sales.instagram_order (
  id                   uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  order_no             text NOT NULL UNIQUE
                       DEFAULT 'IG-' || lpad(nextval('sales.instagram_order_no_seq')::text, 6, '0'),
  invoice_id           uuid NOT NULL UNIQUE REFERENCES sales.invoice(id),
  branch_id            uuid NOT NULL REFERENCES platform.branch(id),
  warehouse_id         uuid NOT NULL REFERENCES inventory.warehouse(id),
  customer_id          uuid NOT NULL REFERENCES sales.customer(id),
  -- نام کاربری اختیاری؛ هویت سفارش نیست. «@» و حروف بزرگ پیش از درج برداشته می‌شوند.
  instagram_username   text CHECK (instagram_username ~ '^[a-z0-9._]{1,30}$'),
  ship_address         text NOT NULL DEFAULT '' CHECK (length(ship_address) <= 500),
  ship_method          text NOT NULL DEFAULT '' CHECK (length(ship_method) <= 80),
  receiving_account_id uuid REFERENCES treasury.account(id),
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','reserved','expired','confirming','finalized','cancelled')),
  payment_state        text NOT NULL DEFAULT 'none'
                       CHECK (payment_state IN ('none','claimed','review','confirmed')),
  payment_note         text CHECK (length(payment_note) <= 300),
  shipping_state       text NOT NULL DEFAULT 'not_started'
                       CHECK (shipping_state IN ('not_started','packing','ready','shipped','delivered')),
  tracking_code        text CHECK (length(tracking_code) <= 80),
  -- هر تغییر اقلام، قیمت، تخفیف یا کرایه یک واحد بالا می‌رود؛ تأیید پرداخت نسخهٔ دیده‌شده را می‌آورد.
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reserved_until       timestamptz,
  cancel_reason        text CHECK (length(cancel_reason) <= 300),
  created_by           uuid NOT NULL REFERENCES identity.app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_reserved_has_deadline CHECK (status <> 'reserved' OR reserved_until IS NOT NULL),
  CONSTRAINT instagram_confirmed_is_final CHECK ((payment_state = 'confirmed') = (status = 'finalized')),
  CONSTRAINT instagram_ship_after_final CHECK (shipping_state = 'not_started' OR status = 'finalized')
);
CREATE INDEX ON sales.instagram_order (status, reserved_until);
CREATE INDEX ON sales.instagram_order (customer_id) WHERE status IN ('draft','reserved','expired');
CREATE INDEX ON sales.instagram_order (instagram_username) WHERE status IN ('draft','reserved','expired');

-- تطبیق واریز: یک سطر برای هر سفارش، فقط در تراکنش نهایی‌سازی.
CREATE TABLE sales.instagram_payment (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  order_id      uuid NOT NULL UNIQUE REFERENCES sales.instagram_order(id),
  account_id    uuid NOT NULL REFERENCES treasury.account(id),
  amount        platform.money NOT NULL CHECK (amount > 0),
  ref_no        text NOT NULL CHECK (length(btrim(ref_no)) BETWEEN 1 AND 64),
  ref_key       text NOT NULL,             -- lower(btrim(ref_no)) — یکتایی بی‌توجه به فاصله و حروف
  paid_at       timestamptz NOT NULL,      -- زمان واریز طبق صورت‌حساب بانک، نه زمان ثبت
  paid_date     date NOT NULL,             -- روز کاری همان واریز (platform.business_date)
  order_version integer NOT NULL,
  payment_id    uuid UNIQUE REFERENCES treasury.payment(id),
  verified_by   uuid NOT NULL REFERENCES identity.app_user(id),
  verified_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ref_key, paid_date)
);

-- ─────────────────────────────────────────────────────────────────────
-- نگهبان‌ها
-- ─────────────────────────────────────────────────────────────────────

-- فاکتور کانال instagram فقط با GUC همان سفارش ساخته یا ویرایش می‌شود.
CREATE FUNCTION sales.instagram_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o sales.instagram_order%ROWTYPE;
  v_ctx text := coalesce(current_setting('lmc.instagram_order', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.channel = 'instagram' AND v_ctx <> 'new' THEN
      RAISE EXCEPTION 'فاکتور اینستاگرام فقط از مسیر سفارش اینستاگرام ساخته می‌شود';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.channel = 'instagram') <> (NEW.channel = 'instagram') THEN
    RAISE EXCEPTION 'کانال اینستاگرام فاکتور قابل تغییر نیست';
  END IF;
  IF NEW.channel <> 'instagram' OR OLD.status <> 'draft' THEN RETURN NEW; END IF;

  SELECT * INTO o FROM sales.instagram_order WHERE invoice_id = NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;          -- لحظهٔ ساخت، پیش از درج سطر سفارش
  IF v_ctx <> o.id::text THEN
    RAISE EXCEPTION 'پیش‌نویس سفارش اینستاگرام فقط از صفحهٔ همان سفارش تغییر می‌کند (%)', o.order_no;
  END IF;
  IF NEW.status = 'draft' THEN
    IF o.status NOT IN ('draft','confirming') THEN
      RAISE EXCEPTION 'سفارش % رزرو یا بسته است؛ برای تغییر ابتدا رزرو را برگردانید', o.order_no;
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    IF o.status <> 'cancelled' THEN RAISE EXCEPTION 'لغو فاکتور فقط با لغو سفارش %', o.order_no; END IF;
  ELSIF o.status <> 'confirming' THEN
    RAISE EXCEPTION 'فاکتور سفارش % فقط در تراکنش تأیید واریز نهایی می‌شود', o.order_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instagram_invoice_guard BEFORE INSERT OR UPDATE ON sales.invoice
  FOR EACH ROW EXECUTE FUNCTION sales.instagram_invoice_guard();

-- اقلام: فقط در پیش‌نویس سفارش، تعداد صحیح، و هر تغییر نسخه را بالا می‌برد.
-- پس از نهایی‌سازی (مرجوعی) به این نگهبان نمی‌رسد چون فاکتور دیگر پیش‌نویس نیست.
CREATE FUNCTION sales.instagram_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  inv record;
  o sales.instagram_order%ROWTYPE;
BEGIN
  SELECT channel, status INTO inv FROM sales.invoice WHERE id = v_invoice;
  IF inv.channel IS DISTINCT FROM 'instagram' OR inv.status <> 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO o FROM sales.instagram_order WHERE invoice_id = v_invoice FOR UPDATE;
  IF NOT FOUND OR coalesce(current_setting('lmc.instagram_order', true), '') <> o.id::text THEN
    RAISE EXCEPTION 'اقلام سفارش اینستاگرام فقط از صفحهٔ همان سفارش تغییر می‌کند';
  END IF;
  IF o.status = 'confirming' THEN                 -- Snapshot بها در نهایی‌سازی
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF o.status <> 'draft' THEN
    RAISE EXCEPTION 'سفارش % رزرو یا بسته است؛ برای تغییر اقلام ابتدا رزرو را برگردانید', o.order_no;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.qty <> trunc(NEW.qty) THEN
    RAISE EXCEPTION 'تعداد کالای سفارش اینستاگرام باید عدد صحیح باشد';
  END IF;
  UPDATE sales.instagram_order SET version = version + 1, updated_at = now() WHERE id = o.id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER instagram_line_guard BEFORE INSERT OR UPDATE OR DELETE ON sales.invoice_line
  FOR EACH ROW EXECUTE FUNCTION sales.instagram_line_guard();

-- پول فقط در تراکنش تأیید واریز همان سفارش وارد فاکتور اینستاگرام می‌شود.
CREATE FUNCTION sales.instagram_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o sales.instagram_order%ROWTYPE;
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  SELECT io.* INTO o FROM sales.instagram_order io
    JOIN sales.invoice i ON i.id = io.invoice_id
   WHERE io.invoice_id = NEW.invoice_id AND i.status = 'draft';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF o.status <> 'confirming' OR coalesce(current_setting('lmc.instagram_order', true), '') <> o.id::text THEN
    RAISE EXCEPTION 'دریافت سفارش اینستاگرام فقط با تأیید واریز همان سفارش ثبت می‌شود (%)', o.order_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instagram_payment_guard BEFORE INSERT OR UPDATE OF invoice_id ON treasury.payment
  FOR EACH ROW EXECUTE FUNCTION sales.instagram_payment_guard();

-- وضعیت سفارش فقط از توابع DEFINER همین مهاجرت عوض می‌شود (مالک جدول). نقش برنامه
-- سرآیند (نشانی، روش ارسال، حساب پیش‌فرض، نام کاربری) را می‌نویسد و نسخه را فقط یک واحد
-- جلو می‌برد (Trigger اقلام). با نقش مالک این نگهبان بی‌اثر است — مثل بقیهٔ قفل‌های
-- db-roles؛ اجرای LMC_TEST_DB_ROLE=app آن را می‌سنجد.
CREATE FUNCTION sales.instagram_order_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_owner text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class WHERE oid = TG_RELID;
  IF current_user = v_owner THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.payment_state <> 'none' OR NEW.shipping_state <> 'not_started'
       OR NEW.version <> 1 OR NEW.reserved_until IS NOT NULL THEN
      RAISE EXCEPTION 'سفارش اینستاگرام فقط به‌صورت پیش‌نویس ساخته می‌شود';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.status, NEW.payment_state, NEW.payment_note, NEW.shipping_state, NEW.tracking_code,
      NEW.reserved_until, NEW.cancel_reason, NEW.invoice_id, NEW.branch_id, NEW.warehouse_id,
      NEW.customer_id, NEW.created_by, NEW.order_no)
     IS DISTINCT FROM
     (OLD.status, OLD.payment_state, OLD.payment_note, OLD.shipping_state, OLD.tracking_code,
      OLD.reserved_until, OLD.cancel_reason, OLD.invoice_id, OLD.branch_id, OLD.warehouse_id,
      OLD.customer_id, OLD.created_by, OLD.order_no) THEN
    RAISE EXCEPTION 'وضعیت سفارش اینستاگرام فقط از مسیر رسمی همان عملیات عوض می‌شود';
  END IF;
  IF NEW.version NOT IN (OLD.version, OLD.version + 1) THEN
    RAISE EXCEPTION 'نسخهٔ سفارش فقط یک واحد جلو می‌رود';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instagram_order_state_guard BEFORE INSERT OR UPDATE ON sales.instagram_order
  FOR EACH ROW EXECUTE FUNCTION sales.instagram_order_state_guard();

-- ─────────────────────────────────────────────────────────────────────
-- رزرو و آزادسازی — نویسندگان stock_balance، پس SECURITY DEFINER (write-gate.sql)
-- ─────────────────────────────────────────────────────────────────────

-- کمکی درونی: رزرو باز سفارش را به ترتیب variation_id آزاد می‌کند. قفل سطر موجودی تا
-- پایان تراکنش می‌ماند؛ پس آزادسازیِ هم‌تراکنش با خروج نهایی‌سازی پنجره‌ای برای فروش دیگر ندارد.
CREATE FUNCTION sales.instagram_release_hold(p_order uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, inventory, platform AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM inventory.stock_reservation
            WHERE source = 'instagram' AND source_ref = p_order::text AND released_at IS NULL
            ORDER BY variation_id, warehouse_id LOOP
    PERFORM 1 FROM inventory.stock_balance
      WHERE variation_id = r.variation_id AND warehouse_id = r.warehouse_id FOR UPDATE;
    UPDATE inventory.stock_balance SET reserved = reserved - r.qty, updated_at = now()
      WHERE variation_id = r.variation_id AND warehouse_id = r.warehouse_id;
    UPDATE inventory.stock_reservation SET released_at = now() WHERE id = r.id;
    PERFORM inventory.push_web_stock(r.variation_id, r.warehouse_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- کمکی درونی: رزرو اتمیک اقلام فعلی سفارش. هر کمبود کل تراکنش را برمی‌گرداند.
CREATE FUNCTION sales.instagram_take_hold(p_order uuid, p_until timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, inventory, catalog, platform AS $$
DECLARE o sales.instagram_order%ROWTYPE; r record; v_available numeric;
BEGIN
  SELECT * INTO STRICT o FROM sales.instagram_order WHERE id = p_order;
  IF NOT EXISTS (SELECT 1 FROM sales.invoice_line WHERE invoice_id = o.invoice_id) THEN
    RAISE EXCEPTION 'سفارش بدون قلم رزرو نمی‌شود';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory.warehouse
                  WHERE id = o.warehouse_id AND branch_id = o.branch_id AND is_active
                    AND kind IN ('store','stock','outlet')) THEN
    RAISE EXCEPTION 'رزرو فقط از انبار فعال و قابل‌فروش همان شعبه مجاز است';
  END IF;
  FOR r IN SELECT l.variation_id, sum(l.qty) AS qty
             FROM sales.invoice_line l WHERE l.invoice_id = o.invoice_id
            GROUP BY l.variation_id ORDER BY l.variation_id LOOP
    SELECT on_hand - reserved INTO v_available FROM inventory.stock_balance
      WHERE variation_id = r.variation_id AND warehouse_id = o.warehouse_id FOR UPDATE;
    IF NOT FOUND OR v_available < r.qty THEN
      RAISE EXCEPTION 'موجودی قابل‌فروش کافی نیست: % (درخواست %، قابل‌فروش %)',
        (SELECT sku FROM catalog.variation WHERE id = r.variation_id), r.qty, coalesce(v_available, 0);
    END IF;
    UPDATE inventory.stock_balance SET reserved = reserved + r.qty, updated_at = now()
      WHERE variation_id = r.variation_id AND warehouse_id = o.warehouse_id;
    INSERT INTO inventory.stock_reservation(variation_id, warehouse_id, qty, source, source_ref, expires_at)
      VALUES (r.variation_id, o.warehouse_id, r.qty, 'instagram', o.id::text, p_until);
    PERFORM inventory.push_web_stock(r.variation_id, o.warehouse_id);
  END LOOP;
END $$;

-- سنجش مشترک «این کاربر روی این سفارش این کار را می‌تواند»؛ مسیر API پیش‌تر سنجیده، این پشتوانه است.
CREATE FUNCTION sales.instagram_assert_actor(p_actor uuid, p_branch uuid, p_operation text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.user_role
                  WHERE user_id = p_actor AND (branch_id IS NULL OR branch_id = p_branch)) THEN
    RAISE EXCEPTION 'این سفارش در دامنهٔ شعبهٔ شما نیست';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.can(p_actor, p_operation, NULL, NULL, false) WHERE verdict = 'allow') THEN
    RAISE EXCEPTION 'مجوز «%» لازم است', p_operation;
  END IF;
END $$;

-- رزرو صریح: draft یا expired → reserved. رزرو دوباره Replay است، نه رزرو دوم.
CREATE FUNCTION sales.instagram_reserve(p_order uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, inventory, platform, identity AS $$
DECLARE o sales.instagram_order%ROWTYPE; v_until timestamptz;
BEGIN
  SELECT * INTO o FROM sales.instagram_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش اینستاگرام یافت نشد'; END IF;
  PERFORM sales.instagram_assert_actor(p_actor, o.branch_id, 'instagram.order.manage');
  PERFORM platform.set_actor(p_actor);
  IF o.status = 'reserved' THEN
    RETURN jsonb_build_object('status', o.status, 'reservedUntil', o.reserved_until, 'replayed', true);
  END IF;
  IF o.status NOT IN ('draft','expired') THEN
    RAISE EXCEPTION 'سفارش % در وضعیت «%» رزرو نمی‌شود', o.order_no, o.status;
  END IF;
  v_until := clock_timestamp() + make_interval(hours => platform.setting_int('instagram.reservation_hours', 24));
  PERFORM sales.instagram_take_hold(o.id, v_until);
  UPDATE sales.instagram_order SET status = 'reserved', reserved_until = v_until, updated_at = now()
    WHERE id = o.id;
  PERFORM platform.audit('instagram_order.reserve', 'instagram_order', o.id::text,
    jsonb_build_object('orderNo', o.order_no, 'version', o.version, 'reservedUntil', v_until,
                       'from', o.status), p_actor);
  RETURN jsonb_build_object('status', 'reserved', 'reservedUntil', v_until, 'replayed', false);
END $$;

-- برگرداندن به پیش‌نویس (برای ویرایش) یا لغو. هر دو همان رزرو را آزاد می‌کنند.
CREATE FUNCTION sales.instagram_release(p_order uuid, p_actor uuid, p_to text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, inventory, platform, identity AS $$
DECLARE o sales.instagram_order%ROWTYPE; n integer;
BEGIN
  IF p_to NOT IN ('draft','cancelled') THEN RAISE EXCEPTION 'مقصد آزادسازی معتبر نیست'; END IF;
  SELECT * INTO o FROM sales.instagram_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش اینستاگرام یافت نشد'; END IF;
  PERFORM sales.instagram_assert_actor(p_actor, o.branch_id, 'instagram.order.manage');
  PERFORM platform.set_actor(p_actor);
  IF o.status = p_to THEN
    RETURN jsonb_build_object('status', o.status, 'replayed', true);
  END IF;
  IF o.status NOT IN ('draft','reserved','expired') THEN
    RAISE EXCEPTION 'سفارش % در وضعیت «%» است؛ پس از تأیید واریز فقط مرجوعی رسمی ممکن است',
      o.order_no, o.status;
  END IF;
  IF p_to = 'cancelled' AND length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'لغو سفارش دلیل می‌خواهد';
  END IF;
  -- واریزی که در حال بررسی است با لغو یا ویرایش گم نمی‌شود: اول وضعیت پرداخت روشن شود.
  IF o.payment_state IN ('claimed','review') THEN
    RAISE EXCEPTION 'واریز سفارش % در حال بررسی است؛ ابتدا وضعیت پرداخت را روشن کنید', o.order_no;
  END IF;
  n := sales.instagram_release_hold(o.id);
  UPDATE sales.instagram_order
     SET status = p_to, reserved_until = NULL, updated_at = now(),
         cancel_reason = CASE WHEN p_to = 'cancelled' THEN btrim(p_reason) ELSE cancel_reason END
   WHERE id = o.id;
  IF p_to = 'cancelled' THEN
    PERFORM set_config('lmc.instagram_order', o.id::text, true);
    UPDATE sales.invoice SET status = 'cancelled', note = btrim(p_reason) WHERE id = o.invoice_id AND status = 'draft';
  END IF;
  PERFORM platform.audit('instagram_order.' || CASE p_to WHEN 'draft' THEN 'unreserve' ELSE 'cancel' END,
    'instagram_order', o.id::text,
    jsonb_build_object('orderNo', o.order_no, 'from', o.status, 'releasedLines', n), p_actor,
    nullif(btrim(coalesce(p_reason, '')), ''));
  RETURN jsonb_build_object('status', p_to, 'replayed', false);
END $$;

-- انقضای رزروهای سررسیده — فقط وقتی هیچ واریزی در جریان نیست. اجرا از Worker.
-- SKIP LOCKED: سفارشی که همین لحظه در تأیید واریز قفل است، این دور منقضی نمی‌شود.
CREATE FUNCTION sales.instagram_expire_due(p_actor uuid, p_now timestamptz DEFAULT clock_timestamp())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, inventory, platform AS $$
DECLARE o record; n integer := 0;
BEGIN
  PERFORM platform.set_actor(p_actor);
  FOR o IN SELECT * FROM sales.instagram_order
            WHERE status = 'reserved' AND reserved_until <= p_now AND payment_state = 'none'
            ORDER BY reserved_until FOR UPDATE SKIP LOCKED LOOP
    PERFORM sales.instagram_release_hold(o.id);
    UPDATE sales.instagram_order SET status = 'expired', reserved_until = NULL, updated_at = now()
      WHERE id = o.id;
    PERFORM platform.audit('instagram_order.expire', 'instagram_order', o.id::text,
      jsonb_build_object('orderNo', o.order_no, 'deadline', o.reserved_until), p_actor);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- آغاز تأیید واریز: همهٔ سنجش‌ها زیر قفل سفارش، سپس مصرف همان رزرو و ثبت تطبیق.
-- مرحلهٔ پرداخت و نهایی‌سازی در همان تراکنش از مسیرهای موجود (InvoiceService) می‌آید
-- و instagram_finish_confirm آن را می‌بندد. هر خطا کل تراکنش را برمی‌گرداند.
CREATE FUNCTION sales.instagram_begin_confirm(
  p_order uuid, p_actor uuid, p_version integer, p_account uuid,
  p_amount platform.money, p_ref text, p_paid_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, inventory, treasury, platform, identity AS $$
DECLARE
  o sales.instagram_order%ROWTYPE;
  inv sales.invoice%ROWTYPE;
  v_ref_key text := lower(btrim(coalesce(p_ref, '')));
  v_paid_date date;
  v_prev sales.instagram_payment%ROWTYPE;
BEGIN
  SELECT * INTO o FROM sales.instagram_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش اینستاگرام یافت نشد'; END IF;
  PERFORM sales.instagram_assert_actor(p_actor, o.branch_id, 'instagram.payment.verify');
  PERFORM platform.set_actor(p_actor);

  -- تأیید تکراری همان واریز: همان فاکتور، نه دریافت دوم.
  IF o.status = 'finalized' THEN
    SELECT * INTO v_prev FROM sales.instagram_payment WHERE order_id = o.id;
    IF v_prev.account_id = p_account AND v_prev.ref_key = v_ref_key AND v_prev.amount = p_amount THEN
      RETURN jsonb_build_object('invoiceId', o.invoice_id, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'سفارش % پیش‌تر با واریز دیگری تأیید شده است', o.order_no;
  END IF;
  IF o.status NOT IN ('reserved','expired') THEN
    RAISE EXCEPTION 'سفارش % در وضعیت «%» قابل تأیید واریز نیست', o.order_no, o.status;
  END IF;
  IF p_version IS DISTINCT FROM o.version THEN
    RAISE EXCEPTION 'سفارش % پس از دیدن شما تغییر کرده است (نسخهٔ % به جای %)؛ دوباره بررسی کنید',
      o.order_no, o.version, p_version;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM treasury.account a
                  WHERE a.id = p_account AND a.kind = 'bank' AND a.is_active
                    AND (a.branch_id IS NULL OR a.branch_id = o.branch_id)) THEN
    RAISE EXCEPTION 'حساب مقصد واریز برای این شعبه مجاز نیست';
  END IF;
  IF v_ref_key = '' OR length(v_ref_key) > 64 THEN RAISE EXCEPTION 'شمارهٔ پیگیری واریز لازم است'; END IF;
  IF p_paid_at IS NULL OR p_paid_at > clock_timestamp() + interval '5 minutes'
     OR p_paid_at < o.created_at - interval '1 day' THEN
    RAISE EXCEPTION 'زمان واریز معتبر نیست';
  END IF;
  SELECT * INTO STRICT inv FROM sales.invoice WHERE id = o.invoice_id FOR UPDATE;
  IF p_amount IS DISTINCT FROM inv.payable_amount THEN
    RAISE EXCEPTION 'مبلغ واریز (%) با مبلغ کامل سفارش و کرایه (%) برابر نیست؛ سفارش برای رسیدگی علامت بخورد',
      p_amount, inv.payable_amount;
  END IF;

  -- مرجع بانکی در دامنهٔ (حساب، روز کاری واریز) یکتاست — میان همهٔ دریافت‌ها، نه فقط اینستاگرام.
  v_paid_date := platform.business_date(p_paid_at);
  PERFORM pg_advisory_xact_lock(hashtextextended('instagram-ref:' || p_account::text || ':' || v_ref_key, 0));
  IF EXISTS (SELECT 1 FROM sales.instagram_payment
              WHERE account_id = p_account AND ref_key = v_ref_key AND paid_date = v_paid_date)
     OR EXISTS (SELECT 1 FROM treasury.payment p
                 WHERE p.account_id = p_account AND p.direction = 'in'
                   AND lower(btrim(p.ref_no)) = v_ref_key
                   AND p.status IN ('succeeded','settled','reconciled','pending','unknown')
                   AND platform.business_date(p.occurred_at) = v_paid_date) THEN
    RAISE EXCEPTION 'این شمارهٔ پیگیری در همان حساب و همان روز پیش‌تر ثبت شده است؛ واریز تکراری؟';
  END IF;

  -- پرداخت دیررس پس از انقضا: موجودی دوباره و اتمیک سنجیده می‌شود، نه فروش کور.
  IF o.status = 'expired' THEN
    PERFORM sales.instagram_take_hold(o.id, clock_timestamp());
  END IF;
  PERFORM sales.instagram_release_hold(o.id);

  UPDATE sales.instagram_order SET status = 'confirming', reserved_until = NULL, updated_at = now()
    WHERE id = o.id;
  INSERT INTO sales.instagram_payment(order_id, account_id, amount, ref_no, ref_key, paid_at, paid_date,
                                      order_version, verified_by)
    VALUES (o.id, p_account, p_amount, btrim(p_ref), v_ref_key, p_paid_at, v_paid_date, o.version, p_actor);
  PERFORM set_config('lmc.instagram_order', o.id::text, true);
  RETURN jsonb_build_object('invoiceId', o.invoice_id, 'replayed', false);
END $$;

-- پایان تأیید: پس از پرداخت و نهایی‌سازی در همان تراکنش.
CREATE FUNCTION sales.instagram_finish_confirm(p_order uuid, p_actor uuid, p_payment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, treasury, platform AS $$
DECLARE o sales.instagram_order%ROWTYPE; v_status text;
BEGIN
  SELECT * INTO o FROM sales.instagram_order WHERE id = p_order FOR UPDATE;
  IF o.status <> 'confirming' THEN RAISE EXCEPTION 'تأیید واریز آغاز نشده است'; END IF;
  SELECT status INTO v_status FROM sales.invoice WHERE id = o.invoice_id;
  IF v_status NOT IN ('finalized','paid') THEN
    RAISE EXCEPTION 'فاکتور سفارش % نهایی نشد', o.order_no;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM treasury.payment WHERE id = p_payment AND invoice_id = o.invoice_id) THEN
    RAISE EXCEPTION 'دریافت ثبت‌شده به این سفارش تعلق ندارد';
  END IF;
  UPDATE sales.instagram_payment SET payment_id = p_payment WHERE order_id = o.id;
  UPDATE sales.instagram_order
     SET status = 'finalized', payment_state = 'confirmed', updated_at = now() WHERE id = o.id;
  PERFORM platform.audit('instagram_order.confirm_payment', 'instagram_order', o.id::text,
    (SELECT jsonb_build_object('orderNo', o.order_no, 'invoiceId', o.invoice_id, 'paymentId', p_payment,
                               'accountId', ip.account_id, 'amount', ip.amount, 'ref', ip.ref_no,
                               'paidAt', ip.paid_at, 'version', ip.order_version)
       FROM sales.instagram_payment ip WHERE ip.order_id = o.id), p_actor);
END $$;

-- علامت وضعیت واریز پیش از تأیید: «مشتری می‌گوید واریز کرده» یا «نیازمند رسیدگی»
-- (مبلغ متفاوت، مرجع مشکوک). هر دو جلوی انقضای خودکار را می‌گیرند؛ هیچ‌کدام پول نیست.
CREATE FUNCTION sales.instagram_mark_payment(p_order uuid, p_actor uuid, p_state text, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, platform, identity AS $$
DECLARE o sales.instagram_order%ROWTYPE;
BEGIN
  IF p_state NOT IN ('none','claimed','review') THEN RAISE EXCEPTION 'وضعیت واریز معتبر نیست'; END IF;
  SELECT * INTO o FROM sales.instagram_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش اینستاگرام یافت نشد'; END IF;
  PERFORM sales.instagram_assert_actor(p_actor, o.branch_id, 'instagram.order.manage');
  PERFORM platform.set_actor(p_actor);
  IF o.status NOT IN ('draft','reserved','expired') THEN
    RAISE EXCEPTION 'وضعیت واریز سفارش % دیگر قابل تغییر نیست', o.order_no;
  END IF;
  IF p_state <> 'none' AND length(btrim(coalesce(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'برای علامت واریز، توضیح لازم است (مثلاً مبلغ و زمانی که مشتری گفته)';
  END IF;
  IF o.payment_state = p_state AND o.payment_note IS NOT DISTINCT FROM nullif(btrim(coalesce(p_note, '')), '') THEN
    RETURN jsonb_build_object('paymentState', p_state, 'replayed', true);
  END IF;
  UPDATE sales.instagram_order
     SET payment_state = p_state, payment_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   WHERE id = o.id;
  PERFORM platform.audit('instagram_order.payment_state', 'instagram_order', o.id::text,
    jsonb_build_object('orderNo', o.order_no, 'paymentState', p_state), p_actor,
    nullif(btrim(coalesce(p_note, '')), ''), jsonb_build_object('paymentState', o.payment_state));
  RETURN jsonb_build_object('paymentState', p_state, 'replayed', false);
END $$;

-- ارسال: فقط پس از نهایی‌سازی و فقط رو به جلو. هیچ حرکت انباری نمی‌سازد —
-- کالا در لحظهٔ تأیید واریز از موجودی کسر شده است.
CREATE FUNCTION sales.instagram_set_shipping(p_order uuid, p_actor uuid, p_state text, p_tracking text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, sales, platform, identity AS $$
DECLARE
  o sales.instagram_order%ROWTYPE;
  v_rank constant text[] := ARRAY['not_started','packing','ready','shipped','delivered'];
BEGIN
  IF NOT (p_state = ANY (v_rank)) THEN RAISE EXCEPTION 'وضعیت ارسال معتبر نیست'; END IF;
  SELECT * INTO o FROM sales.instagram_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش اینستاگرام یافت نشد'; END IF;
  PERFORM sales.instagram_assert_actor(p_actor, o.branch_id, 'instagram.order.manage');
  PERFORM platform.set_actor(p_actor);
  IF o.status <> 'finalized' THEN
    RAISE EXCEPTION 'ارسال فقط پس از تأیید واریز و نهایی‌شدن فاکتور ممکن است';
  END IF;
  IF array_position(v_rank, p_state) < array_position(v_rank, o.shipping_state) THEN
    RAISE EXCEPTION 'وضعیت ارسال به عقب برنمی‌گردد (% → %)', o.shipping_state, p_state;
  END IF;
  IF p_state = 'shipped' AND length(btrim(coalesce(p_tracking, o.tracking_code, ''))) = 0 THEN
    RAISE EXCEPTION 'برای «ارسال‌شده» کد رهگیری لازم است';
  END IF;
  IF o.shipping_state = p_state AND (p_tracking IS NULL OR btrim(p_tracking) = coalesce(o.tracking_code, '')) THEN
    RETURN jsonb_build_object('shippingState', p_state, 'replayed', true);
  END IF;
  UPDATE sales.instagram_order
     SET shipping_state = p_state,
         tracking_code = coalesce(nullif(btrim(coalesce(p_tracking, '')), ''), tracking_code),
         updated_at = now()
   WHERE id = o.id;
  PERFORM platform.audit('instagram_order.shipping', 'instagram_order', o.id::text,
    jsonb_build_object('orderNo', o.order_no, 'shippingState', p_state,
                       'tracking', coalesce(nullif(btrim(coalesce(p_tracking, '')), ''), o.tracking_code)),
    p_actor, NULL, jsonb_build_object('shippingState', o.shipping_state));
  RETURN jsonb_build_object('shippingState', p_state, 'replayed', false);
END $$;

-- همهٔ توابع DEFINER بی PUBLIC (write-gate.sql بند ۵). نقش برنامه در ops/db-roles.sh
-- برای ورودی‌های عمومی EXECUTE می‌گیرد؛ دو کمکی درونی از آن هم گرفته می‌شوند.
REVOKE ALL ON FUNCTION sales.instagram_release_hold(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_take_hold(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_reserve(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_release(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_expire_due(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_begin_confirm(uuid, uuid, integer, uuid, platform.money, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_finish_confirm(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_mark_payment(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sales.instagram_set_shipping(uuid, uuid, text, text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────
-- خرید اینستاگرام «خرید حضوری» سایت نیست (۰۷۳). برچسب نادرست در حساب مشتری
-- سایت ساخته نمی‌شود؛ خوراک Pull همان قاعده را در web-routes.ts دارد.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sales.notify_instore_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, platform, sales
AS $$
BEGIN
  IF NEW.finalized_at IS NOT NULL AND OLD.finalized_at IS NULL
     AND NEW.status IN ('finalized', 'paid') AND NEW.channel NOT IN ('web', 'instagram')
     AND platform.setting_bool('web.push_enabled', false)
     AND EXISTS (SELECT 1 FROM sales.customer c
                  WHERE c.id=NEW.customer_id AND c.mobile_normalized IS NOT NULL) THEN
    INSERT INTO platform.outbox_message(topic, payload)
    VALUES ('web.instore_push', jsonb_build_object('invoiceId', NEW.id, 'branchId', NEW.branch_id));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sales.notify_instore_purchase() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────
-- تنظیم و مجوز (نصب موجود؛ نصب تازه از seed هم‌نام)
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO platform.setting AS t
  (key, value, description, requires_approval, kind, label, group_key, options,
   min_value, max_value, unit, help, sort_order, permission, is_editable)
VALUES ('instagram.reservation_hours', '24'::jsonb,
  'مهلت رزرو سفارش اینستاگرام تا تأیید واریز، به ساعت.', false,
  'int', 'مهلت رزرو سفارش اینستاگرام', 'sales', NULL, 1, 168, 'ساعت',
  'پس از این مهلت، رزرو سفارشی که واریزش در جریان نیست آزاد و سفارش «منقضی» می‌شود. سفارشی که واریزش «ادعاشده» یا «نیازمند رسیدگی» است هرگز خودکار آزاد نمی‌شود. واریز دیررس پس از انقضا موجودی را دوباره می‌سنجد.',
  60, 'settings.security', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.permission_rule(role_code, operation, allowed, max_amount, max_percent, needs_approval_from)
SELECT r.code, op, (r.code = 'admin'), NULL, NULL, NULL
  FROM identity.role r
 CROSS JOIN (VALUES ('instagram.order.manage'), ('instagram.payment.verify')) v(op)
 ON CONFLICT (role_code, operation) DO NOTHING;

-- تأیید واریز تصمیم مالی است: نشست بازشده با PIN آن را انجام نمی‌دهد.
DO $pin$
DECLARE v_value jsonb; v_system uuid;
BEGIN
  SELECT value INTO v_value FROM platform.setting WHERE key = 'auth.pin_forbidden_operations' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE platform.setting
     SET options = coalesce(options, '[]'::jsonb)
       || '[{"value":"instagram.payment.verify","label":"تأیید واریز سفارش اینستاگرام"}]'::jsonb
   WHERE key = 'auth.pin_forbidden_operations'
     AND NOT (coalesce(options, '[]'::jsonb) @> '[{"value":"instagram.payment.verify"}]'::jsonb);
  IF v_value ? 'instagram.payment.verify' THEN RETURN; END IF;
  SELECT id INTO STRICT v_system FROM identity.app_user WHERE username = 'system';
  PERFORM platform.set_setting('auth.pin_forbidden_operations',
    v_value || '["instagram.payment.verify"]'::jsonb,
    'مهاجرت ۱۰۲ — تأیید واریز اینستاگرام به ورود کامل نیاز دارد', v_system);
END $pin$;

COMMIT;
