-- =====================================================================
-- ۰۲۰ — روش سوم قیمت تمام‌شده: FIFO
-- =====================================================================
-- مالک خواست مثل هلو سه روش در تنظیمات باشد. دو روش فعلی
-- (`last_purchase` و `moving_weighted_average`) هر دو روی یک **نرخ
-- جاری** کار می‌کنند: ارزش کل تقسیم بر تعداد. FIFO این‌طور نیست —
-- لازم دارد بداند هر عددِ موجود، با چه نرخی و چه زمانی وارد شده.
--
-- پس این مهاجرت یک چیز تازه می‌آورد که دو روش قبلی لازم نداشتند:
-- **لایه بهای تمام‌شده**.
--
-- ── چرا FIFO مهم است ────────────────────────────────────────────────
--
-- استاندارد حسابداری شماره ۸ ایران میانگین موزون، FIFO و شناسایی ویژه
-- را می‌پذیرد. `last_purchase` — که پیش‌فرض ماست و روش رایج بازار —
-- در آن فهرست **نیست**. تا امروز تنها روش استانداردِ در دسترس، میانگین
-- موزون بود. حالا دوتاست.
--
-- ── قاعده‌ای که این را ساده نگه می‌دارد ─────────────────────────────
--
-- بررسی شد که همه فراخوان‌های `apply_movement` یک الگو دارند:
--
--   ورود  (qty > 0) → نرخ **صریح** می‌دهد (نرخ رسید خرید، یا بهای
--                     همان فروش برای مرجوعی)
--   خروج  (qty < 0) → نرخ `NULL` می‌دهد و می‌گذارد انبار تصمیم بگیرد
--
-- پس FIFO جای تمیزی برای نشستن دارد: هر ورود یک لایه می‌سازد، هر خروج
-- از قدیمی‌ترین لایه‌ها می‌خورد. و چون خروج همیشه ارزشش را از لایه‌ها
-- می‌گیرد، این ثابت برقرار می‌ماند:
--
--   جمع (باقی‌مانده لایه × نرخ لایه)  =  ارزش انبار
--
-- ── تجدید ارزیابی لایه نمی‌سازد ─────────────────────────────────────
--
-- حرکت تجدید ارزیابی تعداد صفر دارد و طبق قاعده پروژه تنها حرکتی است
-- که ارزش را بدون تعداد عوض می‌کند. در FIFO اصلاً پیش نمی‌آید، چون
-- `last_purchase` است که تجدید ارزیابی می‌زند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. لایه بهای تمام‌شده
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory.cost_layer (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  variation_id uuid NOT NULL REFERENCES catalog.variation(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),
  unit_cost    platform.money NOT NULL CHECK (unit_cost >= 0),
  qty_in       platform.qty   NOT NULL CHECK (qty_in > 0),
  qty_left     platform.qty   NOT NULL CHECK (qty_left >= 0),
  occurred_at  timestamptz    NOT NULL,
  movement_id  uuid REFERENCES inventory.stock_movement(id),
  created_at   timestamptz    NOT NULL DEFAULT now(),
  CHECK (qty_left <= qty_in)
);

-- ترتیب FIFO: قدیمی‌ترین اول. `id` به‌عنوان شکننده تساوی می‌آید چون
-- `uuid_v7` خودش زمان‌مرتب است — دو ورود در یک لحظه هم ترتیب قطعی
-- می‌گیرند، وگرنه نتیجه به ترتیب دلخواه پستگرس وابسته می‌شد.
CREATE INDEX IF NOT EXISTS cost_layer_fifo_idx
  ON inventory.cost_layer (variation_id, warehouse_id, occurred_at, id)
  WHERE qty_left > 0;

COMMENT ON TABLE inventory.cost_layer IS
  'لایه بهای تمام‌شده برای روش FIFO. هر ورود یک لایه؛ خروج از قدیمی‌ترین.';

-- ---------------------------------------------------------------------
-- ۲. گزینه سوم در تنظیمات
-- ---------------------------------------------------------------------
-- مقدار **عوض نمی‌شود** — فقط گزینه اضافه می‌شود. پیش‌فرض همان
-- `last_purchase` می‌ماند که تصمیم مالک است.

UPDATE platform.setting
   SET options = '[{"value":"last_purchase","label":"آخرین قیمت خرید"},
                   {"value":"moving_weighted_average","label":"میانگین متحرک موزون"},
                   {"value":"fifo","label":"اولین صادره از اولین وارده (FIFO)"}]'::jsonb,
       help = 'آخرین قیمت خرید (پیش‌فرض): کل موجودی به نرخ آخرین خرید ارزیابی می‌شود — روش رایج بازار. میانگین موزون: میانگین وزنی همه خریدها. FIFO: هر فروش از قدیمی‌ترین خریدِ باقی‌مانده برداشته می‌شود. ⚠️ استاندارد حسابداری شماره ۸ ایران میانگین موزون، FIFO و شناسایی ویژه را می‌پذیرد؛ آخرین قیمت خرید در آن فهرست نیست، پس پیش از اظهارنامه با حسابدار تأیید کنید. جمع سود در طول عمر کالا با هر سه روش یکی است — فقط زمان شناسایی فرق می‌کند.'
 WHERE key = 'costing.method';

-- ---------------------------------------------------------------------
-- ۳. حرکت انبار، با لایه‌ها
-- ---------------------------------------------------------------------
-- کل تابع دوباره تعریف می‌شود (نسخه معتبر همیشه آخرین تعریف است).
-- تفاوت با نسخه ۰۰۳ فقط دو جاست: ساخت لایه در ورود، و مصرف لایه در
-- خروجی که نرخ صریح ندارد.

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
  v_at       timestamptz;
  v_fifo     boolean;
  v_need     platform.qty;
  v_take     platform.qty;
  v_taken    platform.money := 0;
  v_avg      platform.money;
  v_layer    inventory.cost_layer%ROWTYPE;
BEGIN
  IF p_qty = 0 THEN
    RAISE EXCEPTION 'حرکت با تعداد صفر مجاز نیست';
  END IF;

  v_at := coalesce(p_occurred_at, now());

  -- روش **داده** است نه شرط در کد، و یک بار خوانده می‌شود تا در میانه
  -- یک عملیات عوض نشود.
  v_fifo := platform.setting_text('costing.method', 'last_purchase') = 'fifo';

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

    IF v_fifo AND p_unit_cost IS NULL AND p_value_delta IS NULL THEN
      -- ── مصرف لایه‌ها، از قدیمی‌ترین ─────────────────────────────
      --
      -- **کاشت تنبل:** اگر روش وسط عمر کالا به FIFO عوض شده باشد،
      -- موجودی هست ولی لایه نیست. به‌جای یک مهاجرت داده که فقط یک بار
      -- کار می‌کند، همان‌جا یک لایه به نرخ میانگین جاری ساخته می‌شود.
      -- هم مسیر «تازه سوییچ کرد» را می‌گیرد، هم اگر روزی لایه‌ها از
      -- موجودی عقب بیفتند خودش را ترمیم می‌کند.
      IF v_on_hand > 0 AND NOT EXISTS (
           SELECT 1 FROM inventory.cost_layer
            WHERE variation_id = p_variation AND warehouse_id = p_warehouse
              AND qty_left > 0) THEN
        INSERT INTO inventory.cost_layer
          (variation_id, warehouse_id, unit_cost, qty_in, qty_left, occurred_at)
        VALUES
          (p_variation, p_warehouse,
           round(v_value / v_on_hand), v_on_hand, v_on_hand,
           v_at - interval '1 microsecond');
      END IF;

      v_need := -p_qty;

      FOR v_layer IN
        SELECT * FROM inventory.cost_layer
         WHERE variation_id = p_variation AND warehouse_id = p_warehouse
           AND qty_left > 0
         ORDER BY occurred_at, id
         FOR UPDATE
      LOOP
        EXIT WHEN v_need <= 0;
        v_take  := least(v_layer.qty_left, v_need);
        v_taken := v_taken + round(v_take * v_layer.unit_cost);
        UPDATE inventory.cost_layer
           SET qty_left = qty_left - v_take
         WHERE id = v_layer.id;
        v_need := v_need - v_take;
      END LOOP;

      -- کسری لایه فقط وقتی ممکن است که موجودی منفی مجاز باشد. آن‌وقت
      -- نرخ میانگین جاری برداشته می‌شود — همان کاری که پیش از FIFO
      -- می‌شد.
      IF v_need > 0 THEN
        v_avg   := CASE WHEN v_on_hand > 0 THEN round(v_value / v_on_hand) ELSE 0 END;
        v_taken := v_taken + round(v_need * v_avg);
      END IF;

      v_delta := -v_taken;
      v_cost  := round(v_taken / (-p_qty));

    ELSE
      IF p_unit_cost IS NOT NULL THEN
        v_cost := p_unit_cost;
      ELSIF v_on_hand > 0 THEN
        v_cost := round(v_value / v_on_hand);
      ELSE
        v_cost := 0;
      END IF;

      v_delta := coalesce(p_value_delta, p_qty * v_cost);
    END IF;

    -- خالی‌شدن انبار باید ارزش را دقیقاً صفر کند، وگرنه باقی‌ماندهٔ
    -- گرد کردن روی سطری می‌نشیند که تعدادش صفر است — و آن ارزشِ بی‌کالا
    -- در `balance_check` دیده می‌شود.
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
     p_kind, p_ref_type, p_ref_id, p_user, v_at, p_note)
  RETURNING id INTO v_id;

  -- هر ورود یک لایه می‌سازد — حتی وقتی روش FIFO نیست. دلیلش این است
  -- که اگر فردا مالک روش را عوض کند، تاریخچه‌اش از همان روز موجود
  -- باشد و لازم نباشد کل موجودی به یک نرخ میانگین تخت شود.
  IF p_qty > 0 THEN
    INSERT INTO inventory.cost_layer
      (variation_id, warehouse_id, unit_cost, qty_in, qty_left, occurred_at, movement_id)
    VALUES
      (p_variation, p_warehouse, v_cost, p_qty, p_qty, v_at, v_id);
  END IF;

  RETURN (v_id, v_cost, v_delta, v_residual)::inventory.movement_result;
END $$;

-- ---------------------------------------------------------------------
-- ۴. نمای بازبینی — لایه در برابر موجودی
-- ---------------------------------------------------------------------
-- ثابتِ FIFO این است که جمع لایه‌ها با موجودی بخواند. اگر روزی نخواند،
-- باید **دیده شود**، نه اینکه بی‌صدا در سود بنشیند. تست از همین
-- می‌خواند.

CREATE OR REPLACE VIEW inventory.fifo_check AS
SELECT b.variation_id,
       b.warehouse_id,
       b.on_hand,
       b.total_value,
       coalesce(l.layer_qty, 0)   AS layer_qty,
       coalesce(l.layer_value, 0) AS layer_value,
       b.on_hand     - coalesce(l.layer_qty, 0)   AS qty_diff,
       b.total_value - coalesce(l.layer_value, 0) AS value_diff
  FROM inventory.stock_balance b
  LEFT JOIN (
    SELECT variation_id, warehouse_id,
           sum(qty_left)                        AS layer_qty,
           sum(round(qty_left * unit_cost))     AS layer_value
      FROM inventory.cost_layer
     WHERE qty_left > 0
     GROUP BY variation_id, warehouse_id) l
    ON l.variation_id = b.variation_id AND l.warehouse_id = b.warehouse_id;

COMMIT;
