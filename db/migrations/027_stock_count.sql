-- =====================================================================
-- ۰۲۷ — انبارگردانی
-- =====================================================================
-- شمارش فیزیکی قفسه، و تطبیقش با آنچه سیستم می‌گوید.
--
-- ── قاعده‌ای که کل این فایل رویش بنا شده ────────────────────────────
--
-- **موجودی سیستم در لحظه ثبت خوانده می‌شود، نه هنگام ورود شمارش.**
--
-- انبارگردانی ساعت‌ها طول می‌کشد و فروشگاه در همان ساعت‌ها باز است.
-- اگر عدد سیستم را موقع تایپ کردن سطر Snapshot بگیریم، فروشی که وسط
-- شمارش اتفاق افتاده **دو بار** از موجودی کم می‌شود: یک بار خودِ
-- فروش، یک بار تعدیل انبارگردانی که آن فروش را «کسری» می‌بیند.
--
-- نتیجه‌اش کسری کاذبی است که هیچ‌کس نمی‌تواند توضیحش بدهد، و بدتر:
-- موجودی واقعیِ قفسه هم غلط می‌شود. پس `system_qty` ستونی است که
-- `post_stock_count()` پر می‌کند، نه لایه API.
--
-- ── کالای شمرده‌نشده دست نمی‌خورد ───────────────────────────────────
--
-- فقط سطرهایی که در برگه شمارش هستند تعدیل می‌شوند. کالایی که شمرده
-- نشده، **صفر نمی‌شود**. انبارگردانی جزئی یک کار عادی است (یک قفسه،
-- یک برند) و اگر نبودِ سطر به معنی صفر گرفته شود، اولین شمارش جزئی
-- کل انبار را پاک می‌کند.
--
-- ── سند حسابداری ───────────────────────────────────────────────────
--
-- قاعده `stock_shortage` از روز اول در `posting_rule` بود و هیچ کدی
-- نمی‌خواندش: کسری بدهکار ۵۱۰۳، بستانکار ۱۳۰۱. اضافه‌ی انبار همان
-- سند با **مبلغ منفی** است — `post_entry` خودش دو سطر را برعکس
-- می‌کند. یعنی اضافه، بستانکارِ ۵۱۰۳ می‌شود، نه یک رویداد تازه.
--
-- اگر کسری و اضافه دقیقاً هم را خنثی کنند، سندی ساخته نمی‌شود و
-- درست هم همین است: ارزش کل موجودی عوض نشده. جابه‌جایی میان کالاها
-- در `stock_movement` ثبت شده و از آنجا قابل پیگیری است.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. برگه شمارش
-- ---------------------------------------------------------------------

CREATE TABLE inventory.stock_count (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  -- مثل رسید خرید و فاکتور فروش: شماره در لحظه ثبت تخصیص می‌یابد.
  -- برگه‌ای که باز شده و رها می‌شود نباید شماره بسوزاند.
  number       text,
  branch_id    uuid NOT NULL REFERENCES platform.branch(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'posted', 'cancelled')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  posted_at    timestamptz,
  created_by   uuid REFERENCES identity.app_user(id),
  note         text,
  UNIQUE (branch_id, number)
);

COMMENT ON COLUMN inventory.stock_count.number IS
  'شماره سند. تا لحظه ثبت NULL است — برگه رهاشده شماره نمی‌سوزاند.';

CREATE INDEX stock_count_warehouse_idx
  ON inventory.stock_count (warehouse_id, started_at DESC);

-- ---------------------------------------------------------------------
-- ۲. سطرهای شمارش
-- ---------------------------------------------------------------------

CREATE TABLE inventory.stock_count_line (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  count_id     uuid NOT NULL REFERENCES inventory.stock_count(id) ON DELETE CASCADE,
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  -- شمارش صفر یک شمارش است، نه نبودِ سطر: «این کالا را گشتیم و
  -- هیچ‌کدامش نبود» با «این کالا را نشمردیم» یکی نیست.
  counted_qty  platform.qty NOT NULL CHECK (counted_qty >= 0),

  -- این سه ستون را **فقط** post_stock_count() پر می‌کند، در لحظه ثبت.
  -- تا آن موقع NULL‌اند و همین NULL بودن، ادعای «هنوز تعدیل نشده» است.
  system_qty   platform.qty,
  diff_qty     platform.qty,
  unit_cost    platform.money,
  value_delta  platform.money,

  -- یک کالا، یک سطر. دو سطر برای یک کالا یعنی کدامش شمارش نهایی است؟
  UNIQUE (count_id, variation_id)
);

-- ---------------------------------------------------------------------
-- ۳. ثبت — تطبیق شمارش با موجودی
-- ---------------------------------------------------------------------

CREATE FUNCTION inventory.post_stock_count(
  p_count uuid,
  p_user  uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  c            inventory.stock_count%ROWTYPE;
  v_line       record;
  v_fy         smallint;
  v_system     platform.qty;
  v_value      platform.money;
  v_diff       platform.qty;
  v_cost       platform.money;
  v_res        inventory.movement_result;
  v_total      platform.money := 0;   -- جمع تغییر ارزش (منفی = کسری)
  v_lines      int := 0;
  v_adjusted   int := 0;
  v_entry      uuid;
BEGIN
  SELECT * INTO c FROM inventory.stock_count WHERE id = p_count FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگه انبارگردانی یافت نشد'; END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'برگه انبارگردانی % قبلاً ثبت شده است', coalesce(c.number, '(بی‌شماره)');
  END IF;

  SELECT count(*) INTO v_lines FROM inventory.stock_count_line WHERE count_id = p_count;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'برگه انبارگردانی بدون سطر قابل ثبت نیست';
  END IF;

  -- شماره در همین لحظه، روی سطر قفل‌شده.
  IF c.number IS NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year
     WHERE c.started_at::date BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', c.started_at::date;
    END IF;
    c.number := platform.next_document_no(c.branch_id, 'stock_count', v_fy);
    UPDATE inventory.stock_count SET number = c.number WHERE id = p_count;
  END IF;

  FOR v_line IN
    SELECT id, variation_id, counted_qty
      FROM inventory.stock_count_line WHERE count_id = p_count ORDER BY id
  LOOP
    -- موجودی سیستم **همین حالا** خوانده می‌شود، نه هنگام ورود سطر.
    -- قفل تا پایان تراکنش نگه داشته می‌شود، پس فروشی که هم‌زمان
    -- تلاش کند نمی‌تواند میان خواندن و تعدیل جا بیفتد.
    SELECT on_hand, total_value INTO v_system, v_value
      FROM inventory.stock_balance
     WHERE variation_id = v_line.variation_id AND warehouse_id = c.warehouse_id
       FOR UPDATE;

    IF NOT FOUND THEN
      v_system := 0;
      v_value  := 0;
    END IF;

    v_diff := v_line.counted_qty - v_system;

    IF v_diff = 0 THEN
      UPDATE inventory.stock_count_line
         SET system_qty = v_system, diff_qty = 0, unit_cost = NULL, value_delta = 0
       WHERE id = v_line.id;
      CONTINUE;
    END IF;

    -- بهای واحد برای **اضافه** اجباری است (apply_movement بدون آن
    -- خطا می‌دهد) و باید نرخ همان کالا باشد، نه یک عدد دلخواه:
    -- کالایی که در شمارش پیدا می‌شود همان کالاست، نه خریدی تازه.
    --
    --   موجودی دارد  → میانگین جاری
    --   موجودی ندارد → نرخ آخرین ورودِ همان کالا در همان انبار
    --
    -- اگر هیچ‌کدام نبود، صفر می‌ماند و در سطر دیده می‌شود؛ حدس‌زدن یک
    -- نرخ، ارزش موجودی را با عددی می‌سازد که پشتش هیچ سندی نیست.
    IF v_diff > 0 THEN
      IF v_system > 0 THEN
        v_cost := round(v_value / v_system);
      ELSE
        SELECT unit_cost INTO v_cost
          FROM inventory.stock_movement
         WHERE variation_id = v_line.variation_id
           AND warehouse_id = c.warehouse_id
           AND qty > 0
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1;
        v_cost := coalesce(v_cost, 0);
      END IF;
    ELSE
      -- کسری: نرخ را خودِ apply_movement تعیین می‌کند (میانگین یا
      -- FIFO، بسته به روش). دوباره‌نویسی‌اش اینجا یعنی دو تعریف.
      v_cost := NULL;
    END IF;

    v_res := inventory.apply_movement(
      v_line.variation_id, c.warehouse_id, v_diff,
      'count_adjust', 'stock_count', p_count, p_user,
      v_cost, false, now(),
      'انبارگردانی ' || c.number);

    v_total    := v_total + v_res.value_delta;
    v_adjusted := v_adjusted + 1;

    UPDATE inventory.stock_count_line
       SET system_qty  = v_system,
           diff_qty    = v_diff,
           unit_cost   = v_res.unit_cost,
           value_delta = v_res.value_delta
     WHERE id = v_line.id;
  END LOOP;

  UPDATE inventory.stock_count
     SET status = 'posted', posted_at = now()
   WHERE id = p_count;

  -- سند فقط وقتی ساخته می‌شود که ارزش کل عوض شده باشد. کسری و
  -- اضافه‌ای که هم را خنثی کنند، سند نمی‌خواهند — ولی حرکتشان در
  -- stock_movement هست و از آنجا پیگیری می‌شود.
  IF v_total <> 0 THEN
    v_entry := ledger.post_entry(
      'stock_shortage', c.branch_id, now()::date,
      'انبارگردانی ' || c.number,
      jsonb_build_array(
        jsonb_build_object('leg', 'expense',   'amount', -v_total),
        jsonb_build_object('leg', 'inventory', 'amount', -v_total)),
      'stock_count', p_count, p_user);
  END IF;

  PERFORM platform.audit('stock.count', 'stock_count', p_count::text,
    jsonb_build_object('number', c.number, 'warehouse', c.warehouse_id,
                       'lines', v_lines, 'adjusted', v_adjusted,
                       'value_delta', v_total, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION inventory.post_stock_count IS
  'تطبیق شمارش فیزیکی با موجودی. موجودی سیستم در همین لحظه خوانده می‌شود، نه هنگام ورود سطر.';

COMMIT;
