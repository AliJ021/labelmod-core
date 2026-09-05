-- =====================================================================
-- ۰۳۶ — انتقال بین انبارها
-- =====================================================================
-- `stock_movement.kind` از روز اول `transfer_in` و `transfer_out` را
-- داشت و هیچ‌چیز آن‌ها را نمی‌نوشت. یعنی جابه‌جایی کالا میان قفسه
-- فروشگاه و انبار پشتیبان — کاری که هر روز اتفاق می‌افتد — یا اصلاً
-- ثبت نمی‌شد، یا با دو «تعدیل» دستی ثبت می‌شد که هیچ‌کس بعداً
-- نمی‌فهمید به هم مربوط بوده‌اند.
--
-- ── انتقال یک رویداد مالی **نیست** ───────────────────────────────
--
-- هر دو انبار به یک حساب موجودی کالا (۱۳۰۱) می‌خورند. سندی که بدهکار
-- و بستانکارش یک حساب باشد، یک سطر بی‌اثر است که فقط دفتر را شلوغ
-- می‌کند. پس این تابع **هیچ سندی نمی‌زند** — درست مثل سفارش خرید که
-- یک تعهد است نه یک رویداد مالی.
--
-- ولی برعکسش هم درست است و مهم‌تر: **ارزش نباید تغییر کند.** اگر
-- خروج از مبدأ به یک نرخ حساب شود و ورود به مقصد به نرخی دیگر، جمع
-- ارزش موجودی از هوا کم یا زیاد می‌شود بی‌آنکه سندی پشتش باشد.
--
-- راه‌حل: `apply_movement` برای خروج، `value_delta` واقعی را
-- برمی‌گرداند (چه از لایه‌های FIFO، چه از میانگین، چه از حالت
-- «انبار خالی شد» که باقی‌مانده گرد کردن را هم صفر می‌کند). همان عدد
-- با علامت مخالف به ورود داده می‌شود. پس:
--
--   جمع ارزش پیش از انتقال  =  جمع ارزش پس از انتقال
--
-- **دقیقاً**، نه تقریباً. تست همین را ادعا می‌کند.
--
-- ── چه چیزی اینجا نیست ───────────────────────────────────────────
--
-- دامنه شعبه. دیتابیس نمی‌داند کدام کاربر به کدام انبار دسترسی دارد؛
-- لایه API باید **هر دو** انبار را بسنجد. انتقالی که فقط مبدأش
-- سنجیده شود، راهی است برای بیرون‌بردن کالا به انباری که کاربر
-- نمی‌بیند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. برگه انتقال
-- ---------------------------------------------------------------------
-- شماره در **لحظه ثبت** تخصیص می‌یابد، نه هنگام ساخت پیش‌نویس — همان
-- قاعده رسید خرید (۰۲۵) و برگه شمارش (۰۲۷). پیش‌نویس رهاشده نباید
-- شماره بسوزاند.

CREATE TABLE inventory.transfer (
  id                uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  number            text UNIQUE,
  branch_id         uuid NOT NULL REFERENCES platform.branch(id),
  from_warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),
  to_warehouse_id   uuid NOT NULL REFERENCES inventory.warehouse(id),
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','posted','cancelled')),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  posted_at         timestamptz,
  note              text,
  created_by        uuid REFERENCES identity.app_user(id),
  posted_by         uuid REFERENCES identity.app_user(id),
  client_event_id   text,
  -- انتقال به خودِ همان انبار یک اشتباه تایپی است، نه یک عملیات.
  CONSTRAINT transfer_distinct_warehouses CHECK (from_warehouse_id <> to_warehouse_id),
  -- برگه ثبت‌شده حتماً شماره و زمان ثبت دارد؛ پیش‌نویس هیچ‌کدام.
  CONSTRAINT transfer_posted_shape CHECK (
    (status = 'posted' AND number IS NOT NULL AND posted_at IS NOT NULL)
    OR (status <> 'posted' AND posted_at IS NULL))
);

COMMENT ON TABLE inventory.transfer IS
  'انتقال کالا بین دو انبار. هیچ سند حسابداری نمی‌زند — هر دو انبار به یک حساب موجودی می‌خورند.';
COMMENT ON COLUMN inventory.transfer.number IS
  'در لحظه ثبت تخصیص می‌یابد، نه هنگام ساخت پیش‌نویس. پیش‌نویس رهاشده شماره نمی‌سوزاند.';

CREATE INDEX ON inventory.transfer (branch_id, occurred_at DESC);
CREATE INDEX ON inventory.transfer (from_warehouse_id);
CREATE INDEX ON inventory.transfer (to_warehouse_id);

-- ---------------------------------------------------------------------
-- ۲. سطر انتقال
-- ---------------------------------------------------------------------
-- `unit_cost` و `value_delta` **پس از ثبت** پر می‌شوند، نه پیش از آن:
-- بهای کالا در لحظه خروج معلوم می‌شود (لایه FIFO یا میانگین جاری)، و
-- نوشتنش پیش از آن یعنی عددی که ممکن است با واقعیت نخواند.

CREATE TABLE inventory.transfer_line (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  transfer_id  uuid NOT NULL REFERENCES inventory.transfer(id) ON DELETE CASCADE,
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  qty          platform.qty NOT NULL CHECK (qty > 0),
  unit_cost    platform.money,
  value_delta  platform.money,
  UNIQUE (transfer_id, variation_id)
);

COMMENT ON COLUMN inventory.transfer_line.unit_cost IS
  'در لحظه ثبت از خروجی apply_movement نوشته می‌شود. تا آن لحظه NULL است.';

-- یک کالا دو بار روی یک برگه یعنی انباردار اشتباه اسکن کرده. قید
-- یکتایی بالا آن را رد می‌کند؛ لایه API تعداد را جمع می‌زند.

-- ---------------------------------------------------------------------
-- ۳. تغییرناپذیری پس از ثبت
-- ---------------------------------------------------------------------
-- حرکت انبار تغییرناپذیر است، پس برگه‌ای که آن حرکت‌ها را ساخته هم
-- نباید عوض شود. اصلاح یعنی یک انتقال معکوس، نه ویرایش.

CREATE OR REPLACE FUNCTION inventory.transfer_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM inventory.transfer
   WHERE id = coalesce(NEW.transfer_id, OLD.transfer_id);
  -- برگه در همین دستور حذف شده (CASCADE) — سطر هم می‌رود.
  IF v_status IS NULL THEN RETURN coalesce(NEW, OLD); END IF;
  IF v_status = 'posted' THEN
    RAISE EXCEPTION
      'برگه انتقال ثبت‌شده تغییر نمی‌کند. برای اصلاح، یک انتقال معکوس ثبت کنید.';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER transfer_line_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON inventory.transfer_line
  FOR EACH ROW EXECUTE FUNCTION inventory.transfer_immutable();

CREATE OR REPLACE FUNCTION inventory.transfer_header_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'برگه انتقال ثبت‌شده حذف نمی‌شود.';
    END IF;
    RETURN OLD;
  END IF;

  -- از `posted` هیچ راهی بیرون نیست — نه به `draft`، نه به
  -- `cancelled`. کالا جابه‌جا شده و حرکتش تغییرناپذیر است.
  IF OLD.status = 'posted' AND NEW.status <> 'posted' THEN
    RAISE EXCEPTION
      'برگه ثبت‌شده باطل نمی‌شود. برای برگرداندن کالا، یک انتقال معکوس ثبت کنید.';
  END IF;

  -- انبار مبدأ و مقصد پس از ثبت عوض نمی‌شوند: حرکت‌ها روی همان دو
  -- انبار نشسته‌اند و عوض‌کردن سرصفحه، برگه را از حرکتش جدا می‌کند.
  IF OLD.status = 'posted'
     AND (NEW.from_warehouse_id <> OLD.from_warehouse_id
          OR NEW.to_warehouse_id <> OLD.to_warehouse_id
          OR NEW.number IS DISTINCT FROM OLD.number) THEN
    RAISE EXCEPTION 'انبار و شماره برگه ثبت‌شده تغییر نمی‌کنند.';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER transfer_header_guard
  BEFORE UPDATE OR DELETE ON inventory.transfer
  FOR EACH ROW EXECUTE FUNCTION inventory.transfer_header_guard();

-- ---------------------------------------------------------------------
-- ۴. ثبت انتقال
-- ---------------------------------------------------------------------
-- کل کار در **یک** تراکنش: یا همه اقلام جابه‌جا می‌شوند یا هیچ‌کدام.
-- انتقال نیمه‌کاره یعنی کالایی که نه در مبدأ است نه در مقصد.

CREATE OR REPLACE FUNCTION inventory.post_transfer(
  p_transfer uuid, p_user uuid DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  t        inventory.transfer%ROWTYPE;
  l        RECORD;
  v_out    inventory.movement_result;
  v_year   smallint;
  v_count  int := 0;
BEGIN
  SELECT * INTO t FROM inventory.transfer WHERE id = p_transfer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'برگه انتقال یافت نشد';
  END IF;
  IF t.status = 'posted' THEN
    RAISE EXCEPTION 'این برگه قبلاً ثبت شده است (شماره %)', t.number;
  END IF;
  IF t.status <> 'draft' THEN
    RAISE EXCEPTION 'برگه در وضعیت «%» ثبت نمی‌شود', t.status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory.transfer_line WHERE transfer_id = p_transfer) THEN
    RAISE EXCEPTION 'برگه انتقال بدون قلم ثبت نمی‌شود';
  END IF;

  PERFORM platform.set_actor(coalesce(p_user, platform.current_actor()));

  FOR l IN
    SELECT * FROM inventory.transfer_line WHERE transfer_id = p_transfer ORDER BY id
  LOOP
    -- خروج از مبدأ: بها را خودِ `apply_movement` تعیین می‌کند — لایه
    -- FIFO یا میانگین جاری همان انبار. موجودی منفی مجاز نیست، پس
    -- انتقال کالایی که نیست، همین‌جا رد می‌شود.
    v_out := inventory.apply_movement(
      l.variation_id, t.from_warehouse_id, -l.qty, 'transfer_out',
      'transfer', p_transfer, p_user);

    -- ورود به مقصد با **همان ارزشی** که از مبدأ خارج شد.
    --
    -- `value_delta` صریح داده می‌شود، نه `qty × unit_cost`: وقتی
    -- انبار مبدأ خالی می‌شود، `apply_movement` باقی‌ماندهٔ گرد کردن را
    -- هم صفر می‌کند و آن‌وقت این دو عدد یکی نیستند. اگر ضرب دوباره
    -- حساب می‌شد، همان چند ریال از جمع ارزش موجودی گم می‌شد.
    PERFORM inventory.apply_movement(
      l.variation_id, t.to_warehouse_id, l.qty, 'transfer_in',
      'transfer', p_transfer, p_user,
      p_unit_cost   => v_out.unit_cost,
      p_value_delta => -v_out.value_delta);

    UPDATE inventory.transfer_line
       SET unit_cost = v_out.unit_cost, value_delta = -v_out.value_delta
     WHERE id = l.id;

    v_count := v_count + 1;
  END LOOP;

  SELECT id INTO v_year FROM ledger.fiscal_year
   WHERE t.occurred_at::date BETWEEN starts_on AND ends_on;
  IF v_year IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', t.occurred_at::date;
  END IF;

  UPDATE inventory.transfer
     SET status    = 'posted',
         number    = platform.next_document_no(t.branch_id, 'transfer', v_year),
         posted_at = now(),
         posted_by = p_user
   WHERE id = p_transfer;

  PERFORM platform.audit('stock.transfer', 'transfer', p_transfer::text,
    jsonb_build_object(
      'from', t.from_warehouse_id, 'to', t.to_warehouse_id,
      'lines', v_count),
    p_user, t.note);

  RETURN v_count;
END $$;

COMMENT ON FUNCTION inventory.post_transfer IS
  'انتقال را در یک تراکنش ثبت می‌کند: خروج از مبدأ، ورود به مقصد با همان ارزش، شماره‌گذاری. هیچ سند حسابداری نمی‌زند.';

-- ---------------------------------------------------------------------
-- ۵. نمای برگه با جمع‌ها
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW inventory.transfer_summary AS
SELECT t.id, t.number, t.branch_id, t.status, t.occurred_at, t.posted_at, t.note,
       t.from_warehouse_id, wf.name AS from_warehouse_name,
       t.to_warehouse_id,   wt.name AS to_warehouse_name,
       u.full_name          AS created_by_name,
       count(l.id)          AS line_count,
       coalesce(sum(l.qty), 0)                    AS total_qty,
       coalesce(sum(l.value_delta), 0)            AS total_value
  FROM inventory.transfer t
  JOIN inventory.warehouse wf ON wf.id = t.from_warehouse_id
  JOIN inventory.warehouse wt ON wt.id = t.to_warehouse_id
  LEFT JOIN identity.app_user u ON u.id = t.created_by
  LEFT JOIN inventory.transfer_line l ON l.transfer_id = t.id
 GROUP BY t.id, wf.name, wt.name, u.full_name;

COMMENT ON VIEW inventory.transfer_summary IS
  'برگه انتقال با نام انبارها و جمع اقلام. ارزش فقط پس از ثبت مقدار دارد.';

COMMIT;
