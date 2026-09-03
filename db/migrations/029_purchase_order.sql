-- =====================================================================
-- ۰۲۹ — سفارش خرید
-- =====================================================================
-- ── قاعده‌ای که این فایل رویش بنا شده ───────────────────────────────
--
--   **سفارش خرید یک تعهد است، نه یک رویداد مالی.**
--
-- هیچ سندی نمی‌زند، هیچ حرکت انباری نمی‌سازد، و هیچ بدهی‌ای ثبت
-- نمی‌کند. تا وقتی کالا نیامده، نه دارایی‌ای اضافه شده نه بدهی‌ای.
--
-- این را عمداً صریح می‌نویسیم چون خطای رایجی است: سیستمی که سفارش را
-- در دفتر می‌نشاند، ترازنامه‌ای می‌سازد که کالای نرسیده را دارایی
-- می‌بیند. تست `db/test/purchase-order.sql` همین را ادعا می‌کند —
-- «هیچ سندی و هیچ حرکتی».
--
-- ── «چقدرش رسیده» ستون نیست، محاسبه است ─────────────────────────────
--
-- وسوسه اول یک ستون `received_qty` روی سطر سفارش بود که
-- `post_receipt()` بالایش ببرد. رد شد، به دو دلیل:
--
--   ۱. `post_receipt` را دوباره بازنویسی می‌کرد — تابعی که تخصیص هزینه
--      حمل، تجدید ارزیابی و سند خرید در آن است. هر بازنویسی‌اش یک
--      فرصت تازه برای شکستن چیزی است که کار می‌کند.
--   ۲. یک ستون مشتق، جایی است که داده از خودش جدا می‌افتد. برگشت از
--      خرید هم رویش اثر دارد و آن‌وقت دو تابع باید یک ستون را
--      هم‌زمان درست نگه دارند.
--
-- به‌جایش نمای `purchasing.order_progress` از خودِ رسیدها می‌خواند —
-- و **برگشتی را کم می‌کند**: کالایی که آمده و پس رفته، سفارش را
-- برآورده نکرده.
--
-- ── بیش‌تحویل بسته نمی‌شود ──────────────────────────────────────────
--
-- تأمین‌کننده گاهی بیشتر از سفارش می‌فرستد. بستنش یعنی انباردار
-- نتواند محموله واقعی را ثبت کند و کالای در قفسه در سیستم نباشد —
-- بدتر از خودِ بیش‌تحویل. پس مجاز است و در نما دیده می‌شود.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. سفارش
-- ---------------------------------------------------------------------

CREATE TABLE purchasing.purchase_order (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  -- مثل بقیه اسناد: شماره در لحظه‌ای که سفارش واقعاً برای
  -- تأمین‌کننده فرستاده می‌شود، نه هنگام ساخت پیش‌نویس.
  number       text,
  branch_id    uuid NOT NULL REFERENCES platform.branch(id),
  supplier_id  uuid NOT NULL REFERENCES purchasing.supplier(id),
  -- انبار مقصد پیشنهادی. رسید می‌تواند انبار دیگری بگیرد؛ این فقط
  -- پیش‌فرض است، نه قید.
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),

  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'sent', 'closed', 'cancelled')),
  expected_at  date,
  note         text,
  created_by   uuid REFERENCES identity.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  closed_at    timestamptz,
  -- «چرا بستیم» — سفارشی که نیمه‌کاره بسته می‌شود سؤال می‌سازد.
  close_reason text,
  UNIQUE (branch_id, number)
);

CREATE INDEX purchase_order_supplier_idx
  ON purchasing.purchase_order (supplier_id, created_at DESC);

CREATE TABLE purchasing.purchase_order_line (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  order_id     uuid NOT NULL REFERENCES purchasing.purchase_order(id) ON DELETE CASCADE,
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  qty          platform.qty NOT NULL CHECK (qty > 0),
  -- قیمت **توافقی** سفارش. رسید می‌تواند قیمت دیگری داشته باشد و
  -- همان رسید است که بها را تعیین می‌کند؛ این عدد فقط برای مقایسه
  -- است — «چقدر توافق کرده بودیم و چقدر آمد».
  unit_price   platform.money NOT NULL CHECK (unit_price >= 0),
  UNIQUE (order_id, variation_id)
);

-- ---------------------------------------------------------------------
-- ۲. اتصال رسید به سفارش
-- ---------------------------------------------------------------------

ALTER TABLE purchasing.receipt
  ADD COLUMN order_id uuid REFERENCES purchasing.purchase_order(id);

ALTER TABLE purchasing.receipt_line
  ADD COLUMN order_line_id uuid REFERENCES purchasing.purchase_order_line(id);

COMMENT ON COLUMN purchasing.receipt.order_id IS
  'سفارشی که این رسید بابتش آمده. تهی یعنی خرید بدون سفارش — کار عادی است.';

CREATE INDEX receipt_line_order_line_idx
  ON purchasing.receipt_line (order_line_id) WHERE order_line_id IS NOT NULL;

/*
 * سطر رسید فقط به سطری از **همان** سفارش می‌چسبد.
 *
 * بدون این، یک `order_line_id` از سفارش دیگری می‌توانست آن سفارش را
 * «رسیده» نشان بدهد در حالی که کالایش هرگز نیامده. کلید خارجی این را
 * نمی‌گیرد — سطر واقعاً وجود دارد، فقط مال سفارش دیگری است.
 */
CREATE FUNCTION purchasing.assert_order_line_matches()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_receipt_order uuid; v_line_order uuid;
BEGIN
  IF NEW.order_line_id IS NULL THEN RETURN NEW; END IF;

  SELECT order_id INTO v_receipt_order
    FROM purchasing.receipt WHERE id = NEW.receipt_id;
  SELECT order_id INTO v_line_order
    FROM purchasing.purchase_order_line WHERE id = NEW.order_line_id;

  IF v_receipt_order IS NULL THEN
    RAISE EXCEPTION 'این رسید به هیچ سفارشی وصل نیست، پس سطرش هم نمی‌تواند.';
  END IF;
  IF v_receipt_order <> v_line_order THEN
    RAISE EXCEPTION 'سطر رسید به سفارش دیگری اشاره می‌کند.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assert_order_line_matches_t
  BEFORE INSERT OR UPDATE OF order_line_id ON purchasing.receipt_line
  FOR EACH ROW EXECUTE FUNCTION purchasing.assert_order_line_matches();

-- ---------------------------------------------------------------------
-- ۳. «چقدرش رسیده» — محاسبه، نه ستون
-- ---------------------------------------------------------------------

CREATE VIEW purchasing.order_progress AS
SELECT
  pol.id                AS order_line_id,
  pol.order_id,
  pol.variation_id,
  pol.qty               AS ordered_qty,
  pol.unit_price        AS ordered_unit_price,
  -- برگشتی کم می‌شود: کالایی که آمده و پس رفته، سفارش را برآورده
  -- نکرده.
  --
  -- ⚠️ هر سه ستون صریح `platform.qty` می‌شوند. بدون Cast، سطری که
  -- هیچ رسیدی ندارد «0» می‌دهد و سطری که دارد «0.000» — و کلاینت
  -- دو رشته متفاوت برای یک عدد می‌بیند.
  coalesce(recv.qty, 0)::platform.qty AS received_qty,
  greatest(pol.qty - coalesce(recv.qty, 0), 0)::platform.qty AS remaining_qty,
  -- بیش‌تحویل بسته نیست، ولی دیده می‌شود.
  greatest(coalesce(recv.qty, 0) - pol.qty, 0)::platform.qty AS over_qty
FROM purchasing.purchase_order_line pol
LEFT JOIN LATERAL (
  SELECT coalesce(sum(rl.qty - rl.returned_qty), 0) AS qty
    FROM purchasing.receipt_line rl
    JOIN purchasing.receipt r ON r.id = rl.receipt_id
   WHERE rl.order_line_id = pol.id
     AND r.status = 'posted'
) recv ON true;

COMMENT ON VIEW purchasing.order_progress IS
  'پیشرفت هر سطر سفارش، از خودِ رسیدهای ثبت‌شده. برگشتی کم می‌شود.';

-- ---------------------------------------------------------------------
-- ۴. فرستادن سفارش — تنها جایی که شماره تخصیص می‌یابد
-- ---------------------------------------------------------------------

CREATE FUNCTION purchasing.send_purchase_order(
  p_order uuid,
  p_user  uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  o    purchasing.purchase_order%ROWTYPE;
  v_fy smallint;
  v_n  int;
BEGIN
  SELECT * INTO o FROM purchasing.purchase_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش خرید یافت نشد'; END IF;
  IF o.status <> 'draft' THEN
    RAISE EXCEPTION 'سفارش % قبلاً فرستاده شده است', coalesce(o.number, '(بی‌شماره)');
  END IF;

  SELECT count(*) INTO v_n FROM purchasing.purchase_order_line WHERE order_id = p_order;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'سفارش بدون قلم فرستادنی نیست';
  END IF;

  SELECT id INTO v_fy FROM ledger.fiscal_year
   WHERE o.created_at::date BETWEEN starts_on AND ends_on;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', o.created_at::date;
  END IF;

  o.number := platform.next_document_no(o.branch_id, 'purchase_order', v_fy);

  UPDATE purchasing.purchase_order
     SET number = o.number, status = 'sent', sent_at = now()
   WHERE id = p_order;

  -- ⚠️ هیچ `ledger.post_entry()` و هیچ `apply_movement()` اینجا نیست،
  --    و نباید باشد. سفارش یک تعهد است، نه یک رویداد مالی.
  PERFORM platform.audit('purchase.order_sent', 'purchase_order', p_order::text,
    jsonb_build_object('number', o.number, 'supplier', o.supplier_id, 'lines', v_n),
    p_user);

  RETURN o.number;
END $$;

-- ---------------------------------------------------------------------
-- ۵. بستن سفارش
-- ---------------------------------------------------------------------
-- بستن یک **تصمیم انسانی** است، نه نتیجه یک محاسبه: تأمین‌کننده گفته
-- بقیه‌اش نمی‌آید، یا فصل عوض شده. اگر خودکار با «همه رسید» بسته
-- می‌شد، سفارشِ نیمه‌رسیده تا ابد باز می‌ماند و فهرست سفارش‌های باز
-- بی‌فایده می‌شد.

CREATE FUNCTION purchasing.close_purchase_order(
  p_order  uuid,
  p_reason text DEFAULT NULL,
  p_user   uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  o          purchasing.purchase_order%ROWTYPE;
  v_pending  platform.qty;
BEGIN
  SELECT * INTO o FROM purchasing.purchase_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سفارش خرید یافت نشد'; END IF;
  IF o.status NOT IN ('draft', 'sent') THEN
    RAISE EXCEPTION 'سفارش % قبلاً بسته یا باطل شده است', coalesce(o.number, '(بی‌شماره)');
  END IF;

  SELECT coalesce(sum(remaining_qty), 0) INTO v_pending
    FROM purchasing.order_progress WHERE order_id = p_order;

  -- بستن سفارشی که هنوز کالا دارد، دلیل می‌خواهد. بدون آن، فهرست
  -- سفارش‌های بسته سؤالی می‌شود که کسی نمی‌تواند جوابش را بدهد.
  IF v_pending > 0 AND coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION
      'این سفارش هنوز % قلم نرسیده دارد. بستنش دلیل می‌خواهد.', v_pending;
  END IF;

  UPDATE purchasing.purchase_order
     SET status       = CASE WHEN o.status = 'draft' THEN 'cancelled' ELSE 'closed' END,
         closed_at    = now(),
         close_reason = p_reason
   WHERE id = p_order;

  PERFORM platform.audit('purchase.order_closed', 'purchase_order', p_order::text,
    jsonb_build_object('number', o.number, 'pending', v_pending, 'reason', p_reason),
    p_user);
END $$;

COMMIT;
