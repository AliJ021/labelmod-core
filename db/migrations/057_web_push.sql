-- ۰۵۷ — همگام‌سازی لحظه‌ای موجودی و قیمت با سایت (ADR-007)
--
-- ── آنچه این مهاجرت می‌سازد ─────────────────────────────────────────
--
-- تا امروز افزونه هر ۱۵ دقیقه خوراک موجودی را **می‌کشید**. پیامدش یک
-- عدد بود نه یک حس: پس از فروش آخرین قلم، سایت تا ۱۵ دقیقه همان کالا
-- را موجود نشان می‌داد و می‌فروخت.
--
-- حالا Core **می‌فرستد**، با همان صف Outbox که از روز اول هست. هیچ
-- زیرساخت تازه‌ای لازم نیست: یک `topic`، یک ایندکس یکتای جزئی برای
-- تجمیع، و درج در **همان تراکنشِ** حرکت انبار.
--
-- ⚠️ نقطهٔ اتصال `inventory.apply_movement()` است، نه مسیرهای فروش و
--    خرید. `CLAUDE.md` می‌گوید «موجودی فقط از apply_movement تغییر
--    می‌کند» — پس هر مسیری که موجودی را عوض می‌کند خودبه‌خود پوشش
--    می‌گیرد و هیچ‌کدام جا نمی‌ماند: فروش، مرجوعی، رسید خرید، برگشت از
--    خرید، انتقال، انبارگردانی، بایگانی.

-- ── ۱. تجمیع: برای هر (تنوع، موضوع) حداکثر یک سطر معلق ─────────────
--
-- ۵۰ قلم در یک دقیقه نباید ۵۰ درخواست بسازد.
--
-- ⚠️ شرط `status = 'pending'` اجباری است: سطری که `sending` شده در حال
--    رفتن است و Payloadش نباید زیر پای فرستنده عوض شود. آن حالت پیام
--    **بعدی** می‌سازد.
--
-- ⚠️ و Backpressure اینجا **ساختاری** بسته می‌شود نه با یک عدد: صف
--    حداکثر به اندازهٔ «تعداد تنوع‌های تغییرکرده» رشد می‌کند، نه به
--    اندازهٔ «تعداد حرکت‌ها».
CREATE UNIQUE INDEX IF NOT EXISTS outbox_pending_entity_idx
  ON platform.outbox_message (topic, (payload->>'variationId'))
  WHERE status = 'pending' AND payload ? 'variationId';

-- ── ۲. درج با تجمیع ────────────────────────────────────────────────
--
-- ⚠️ بازنویسی سطر معلق **فقط چون Payload مقدار مطلق دارد** بی‌خطر است.
--    با «−۱» یک تحویل گم‌شده موجودی سایت را برای همیشه خراب می‌کرد؛ با
--    «الان ۷ است» هم تکرار بی‌ضرر است و هم گم‌شدن با پیام بعدی جبران
--    می‌شود. این مهم‌ترین قید کل طراحی است.
CREATE OR REPLACE FUNCTION platform.enqueue_web_push(
  p_topic   text,
  p_payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, platform
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_payload->>'variationId' IS NULL THEN
    RAISE EXCEPTION 'پیام Push بدون variationId ساخته نمی‌شود.';
  END IF;

  INSERT INTO platform.outbox_message (topic, payload)
  VALUES (p_topic, p_payload)
  ON CONFLICT (topic, (payload->>'variationId'))
    WHERE status = 'pending' AND payload ? 'variationId'
  DO UPDATE SET
        payload         = EXCLUDED.payload,
        -- تلاش‌های شکست‌خوردهٔ قبلیِ همین موجودیت نباید Backoff پیام
        -- تازه را عقب بیندازند: این یک وضعیت **تازه** است.
        attempts        = 0,
        next_attempt_at = now(),
        last_error      = NULL
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION platform.enqueue_web_push(text, jsonb) IS
  'صف Push سایت با تجمیع — یک سطر معلق به‌ازای هر (موضوع، تنوع).';

-- ── ۳. موجودیِ قابل فروشِ سایت ─────────────────────────────────────
--
-- ⚠️ **این عدد باید دقیقاً همان چیزی باشد که `GET /web/stock` می‌دهد.**
--    اگر Push و خوراک ۱۵ دقیقه‌ای دو تعریف داشته باشند، تور ایمنیِ
--    تطبیق (بند ۷ ADR-007) هر بار یک واگرایی **کاذب** گزارش می‌کند و
--    خیلی زود کسی دیگر نگاهش نمی‌کند.
--
--    پس همان فرمول: `on_hand - reserved` روی همان یک انبار.
--
-- ⚠️ **انحراف صریح از ADR-007 بند ۲:** آن سند «جمع همهٔ انبارهای قابل
--    فروش سایت» را نوشته بود. چنین مفهومی در اسکیما **وجود ندارد** —
--    نه ستون `web_sellable`ی هست و نه خوراک فعلی چندانباره است؛
--    `/web/stock` یک `warehouseId` می‌گیرد و افزونه یکی را پیکربندی
--    می‌کند. ساختن یک مفهوم تازه فقط برای Push یعنی دو تعریف از
--    «موجودی سایت»، و همان واگرایی کاذب بالا. اگر روزی چند انبار لازم
--    شد، هر دو مسیر با هم عوض می‌شوند.
--
-- ⚠️ نتیجهٔ جانبی و **درست**: انتقال میان دو انبارِ غیرسایتی هیچ پیامی
--    نمی‌سازد، و انتقال از انبار سایت به انبار دیگر **می‌سازد** — چون
--    واقعاً موجودیِ قابل فروش سایت را کم کرده است.
CREATE OR REPLACE FUNCTION inventory.web_stock_qty(
  p_variation uuid,
  p_warehouse uuid
) RETURNS platform.qty
LANGUAGE sql
STABLE
AS $$
  SELECT greatest(0, coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))
    FROM inventory.stock_balance b
   WHERE b.variation_id = p_variation
     AND b.warehouse_id = p_warehouse;
$$;

-- انبارِ سایت، از تنظیمات. رشتهٔ خالی یعنی «تعیین نشده».
CREATE OR REPLACE FUNCTION platform.web_warehouse_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT w.id
    FROM inventory.warehouse w
   WHERE w.code = nullif(platform.setting_text('web.stock_warehouse', ''), '')
   LIMIT 1;
$$;

-- ── ۴. نسخه: یک **دنباله**، نه شناسهٔ سطر ──────────────────────────
--
-- ⚠️ **تصحیح ADR-007 بند ۴.** آن سند نوشته بود
--    «`version` = `stock_movement.id` (شمارندهٔ صعودی و تکرارنشدنی
--    دیتابیس)». این دربارهٔ اسکیمای همین مخزن **غلط** است:
--    `stock_movement.id` و `catalog.price.id` هر دو `uuid` هستند نه
--    `bigint`. UUIDv7 از نظر زمانی مرتب است ولی یک عدد قابل مقایسه در
--    PHP نیست، و تبدیلش به عدد یا ترتیب را از بین می‌برد یا سرریز
--    می‌کند.
--
--    پس یک دنبالهٔ واقعی. `nextval` **غیرتراکنشی** است — یعنی حتی اگر
--    فروش Rollback شود عدد مصرف می‌شود و هرگز تکرار نمی‌گردد. برای یک
--    شمارندهٔ نسخه دقیقاً همین لازم است.
--
-- ⚠️ و چرا ساعت به‌کار نمی‌آید: `occurred_at` **قابل تعیین از بیرون**
--    است (`p_occurred_at`), پس یک حرکتِ عقب‌تاریخ می‌توانست نسخه‌ای
--    کوچک‌تر از حرکت بعدی بسازد و پیام درست را دور بیندازد.
CREATE SEQUENCE IF NOT EXISTS platform.web_push_version AS bigint START 1;

COMMENT ON SEQUENCE platform.web_push_version IS
  'نسخهٔ صعودی پیام‌های Push سایت — نگهبان ترتیب سمت افزونه.';

-- ── ۵. Push موجودی ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory.push_web_stock(
  p_variation uuid,
  p_warehouse uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, inventory, platform, catalog
AS $$
DECLARE
  v_sku text;
BEGIN
  -- خاموش‌بودن یک شکست نیست — و اینجا اصلاً پیامی ساخته نمی‌شود، پس
  -- صف با چیزی که قرار نبود برود پر نمی‌شود.
  IF NOT platform.setting_bool('web.push_enabled', false) THEN RETURN; END IF;
  IF p_warehouse IS DISTINCT FROM platform.web_warehouse_id() THEN RETURN; END IF;

  SELECT sku INTO v_sku FROM catalog.variation WHERE id = p_variation;

  PERFORM platform.enqueue_web_push(
    'web.stock_push',
    jsonb_build_object(
      'variationId', p_variation::text,
      'sku',         v_sku,
      -- ⚠️ عدد است نه رشته: این **پول نیست**، تعداد است. قاعدهٔ «پول در
      --    JSON رشته است» اینجا اعمال نمی‌شود و اعمالش فقط سمت افزونه
      --    یک تبدیل بی‌دلیل می‌ساخت.
      --
      -- ⚠️ `trim_scale` اجباری است: `platform.qty` مقیاس ۳ دارد، پس بی
      --    آن هر پیام `120.000` می‌برد. ووکامرس آن را در `_stock`
      --    می‌نشاند و ویترین «۱۲۰٫۰۰۰ عدد» نشان می‌دهد. تعداد کسری
      --    (پارچه به متر) دست‌نخورده می‌ماند: `2.500` → `2.5`.
      'onHand',      trim_scale(inventory.web_stock_qty(p_variation, p_warehouse)),
      'version',     nextval('platform.web_push_version'),
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ));
END $$;

-- ── ۶. Push قیمت ───────────────────────────────────────────────────
--
-- ⚠️ `null` یعنی «قیمت ندارد»، **نه مجانی**. نوشتن صفر یعنی ویترین
--    کالا را رایگان بفروشد. این قید از قبل در خوراک بود و Push آن را
--    از «هر ۱۵ دقیقه» به «همیشه» می‌برد.
CREATE OR REPLACE FUNCTION catalog.push_web_price(
  p_variation uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, catalog, platform
AS $$
DECLARE
  v_sku    text;
  v_amount platform.money;
  v_list   text := platform.setting_text('web.price_list', 'default');
BEGIN
  IF NOT platform.setting_bool('web.push_enabled', false) THEN RETURN; END IF;

  SELECT sku INTO v_sku FROM catalog.variation WHERE id = p_variation;

  SELECT amount INTO v_amount
    FROM catalog.price
   WHERE variation_id = p_variation
     AND price_list   = v_list
     AND valid_to IS NULL
   LIMIT 1;

  PERFORM platform.enqueue_web_push(
    'web.price_push',
    jsonb_build_object(
      'variationId', p_variation::text,
      'sku',         v_sku,
      -- پول: **رشته**، هرگز number. و NULL همان NULL می‌ماند.
      'priceRial',   CASE WHEN v_amount IS NULL THEN NULL ELSE v_amount::text END,
      'version',     nextval('platform.web_push_version'),
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ));
END $$;

-- ── ۷. apply_movement با Push ──────────────────────────────────────
--
-- بازتعریف کامل با `CREATE OR REPLACE`؛ نسخهٔ معتبر هر تابع آخرین
-- تعریف آن است. تنها تفاوت با نسخهٔ ۰۵۰، فراخوان `push_web_stock`
-- درست پیش از RETURN است.

CREATE OR REPLACE FUNCTION inventory.apply_movement(p_variation uuid, p_warehouse uuid, p_qty platform.qty, p_kind text, p_ref_type text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_user uuid DEFAULT NULL::uuid, p_unit_cost platform.money DEFAULT NULL::numeric, p_allow_negative boolean DEFAULT false, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text, p_value_delta platform.money DEFAULT NULL::numeric)
 RETURNS inventory.movement_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'inventory', 'platform', 'catalog', 'identity', 'ledger'
AS $function$
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

  -- ── Push لحظه‌ای به سایت (ADR-007) ─────────────────────────────
  --
  -- ⚠️ **داخل همان تراکنش** — الگوی Transactional Outbox. اگر فروش
  --    Rollback شود، پیام هم نمی‌رود؛ و اگر Commit شود، پیام قطعاً در
  --    صف است. یک `fetch` داخل تراکنش هیچ‌کدام را نمی‌داد و بودجهٔ
  --    ۱۰۰ms صندوق را هم می‌شکست (بند «چرا نه HTTP همگام» ADR-007).
  --
  -- ⚠️ نسخه از دنبالهٔ `platform.web_push_version` می‌آید، نه از شناسهٔ
  --    حرکت (که `uuid` است، نه شمارنده — تصحیح ADR-007 بند ۴). افزونه
  --    پیام با نسخهٔ مساوی یا قدیمی‌تر را دور می‌اندازد، پس دو پیام
  --    خارج از ترتیب عدد کهنه را نمی‌نشانند.
  --
  -- ⚠️ `push_web_stock` خودش خاموش‌بودن و «انبارِ سایت نیست» را
  --    می‌سنجد و بی‌صدا برمی‌گردد. اینجا شرط نوشتن یعنی دو تعریف.
  PERFORM inventory.push_web_stock(p_variation, p_warehouse);

  RETURN (v_id, v_cost, v_delta, v_residual)::inventory.movement_result;
END $function$;

-- ── ۸. set_price با Push ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION catalog.set_price(p_variation_id uuid, p_amount platform.money, p_kind text DEFAULT 'regular'::text, p_reason text DEFAULT NULL::text, p_price_list text DEFAULT 'default'::text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_actor uuid := platform.current_actor();
  v_open  catalog.price;
  v_at    timestamptz;
  v_new   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'کاربر عامل ست نشده است (platform.set_actor).';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'قیمت منفی ثبت نمی‌شود.';
  END IF;
  IF p_kind NOT IN ('regular', 'markdown', 'promo') THEN
    RAISE EXCEPTION 'نوع قیمت نامعتبر: %', p_kind;
  END IF;

  PERFORM 1 FROM catalog.variation WHERE id = p_variation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'تنوع یافت نشد: %', p_variation_id;
  END IF;

  SELECT * INTO v_open FROM catalog.price
   WHERE variation_id = p_variation_id
     AND price_list   = p_price_list
     AND valid_to IS NULL
   FOR UPDATE;

  -- همان قیمت دوباره = هیچ اتفاقی. یک سطر تاریخچه بدون تغییر مبلغ،
  -- فقط گزارش را شلوغ می‌کند.
  IF FOUND AND v_open.amount = p_amount AND v_open.kind = p_kind THEN
    RETURN v_open.id;
  END IF;

  v_at := clock_timestamp();
  IF FOUND AND v_at <= v_open.valid_from THEN
    v_at := v_open.valid_from + interval '1 microsecond';
  END IF;

  IF FOUND THEN
    UPDATE catalog.price SET valid_to = v_at WHERE id = v_open.id;
  END IF;

  INSERT INTO catalog.price (
    variation_id, price_list, amount, kind, reason, valid_from, created_by)
  VALUES (
    p_variation_id, p_price_list, p_amount, p_kind, p_reason, v_at, v_actor)
  RETURNING id INTO v_new;

  PERFORM platform.audit(
    'price.change', 'catalog.variation', p_variation_id::text,
    jsonb_build_object('amount', p_amount::text, 'kind', p_kind,
                       'price_list', p_price_list, 'valid_from', v_at),
    v_actor, p_reason,
    CASE WHEN v_open.id IS NULL THEN NULL
         ELSE jsonb_build_object('amount', v_open.amount::text,
                                 'kind', v_open.kind) END);
  -- ── Push لحظه‌ای قیمت به سایت (ADR-007) ────────────────────────
  --
  -- ⚠️ اینجا و نه در مسیرهای API: `catalog.set_price()` **تنها راه
  --    مجاز** تغییر قیمت است (یک Trigger روی `catalog.price` هر چیز
  --    دیگری را رد می‌کند)، پس هیچ مسیری جا نمی‌ماند.
  --
  -- ⚠️ و بالاتر یک `RETURN` زودهنگام هست: «همان قیمت دوباره» سطر تازه
  --    نمی‌سازد و به اینجا نمی‌رسد — پس Push هم نمی‌شود. درست است:
  --    چیزی عوض نشده که به سایت خبر داده شود.
  PERFORM catalog.push_web_price(p_variation_id);

  RETURN v_new;
END $function$;

-- ── ۹. تور ایمنیِ تطبیق — بند ۷ ADR-007 ────────────────────────────
--
-- Push می‌تواند شکست بخورد (سایت پایین، افزونه غیرفعال، نامهٔ مرده) و
-- کسی هم ممکن است مستقیم در پیشخان سایت موجودی را دست بزند. فقط یک
-- تطبیق دوره‌ای این واگرایی را کشف می‌کند.
--
-- ⚠️ چرخهٔ ۱۵ دقیقه‌ای **حذف نمی‌شود**؛ نقشش از «مکانیزم اصلی» به «تور
--    ایمنی» عوض می‌شود.
--
-- ⚠️ و این نما **گزارش می‌دهد، بی‌صدا درست نمی‌کند.** تصحیح خودکارِ
--    بی‌صدا یعنی علت هرگز پیدا نشود — و علت‌ها همان چیزی‌اند که اهمیت
--    دارند: یک افزونهٔ غیرفعال، یک کلید عوض‌شده، یک دست بردن دستی.
CREATE OR REPLACE VIEW platform.web_push_health AS
WITH cfg AS (
  SELECT platform.setting_bool('web.push_enabled', false)  AS enabled,
         platform.setting_int('web.reconcile_minutes', 15) AS minutes,
         platform.web_warehouse_id()                       AS wh
)
SELECT
  cfg.enabled,
  cfg.minutes,
  cfg.wh AS warehouse_id,
  -- پیام‌هایی که هنوز نرفته‌اند و از مهلت تطبیق گذشته‌اند: یعنی Push
  -- عملاً کار نمی‌کند.
  (SELECT count(*) FROM platform.outbox_message m
    WHERE m.topic LIKE 'web.%' AND m.status IN ('pending','sending')
      AND m.created_at < now() - make_interval(mins => cfg.minutes))::bigint
    AS stale_pending,
  (SELECT count(*) FROM platform.outbox_message m
    WHERE m.topic LIKE 'web.%' AND m.status = 'dead')::bigint
    AS dead,
  -- ⚠️ پیکربندی ناسازگار: Push روشن ولی انبار سایت تعیین نشده. آن‌وقت
  --    هیچ پیامی ساخته نمی‌شود و **همه‌چیز سالم به‌نظر می‌رسد** — صف
  --    خالی است، نامهٔ مرده‌ای نیست، و سایت هرگز به‌روز نمی‌شود.
  (cfg.enabled AND cfg.wh IS NULL) AS misconfigured
FROM cfg;

COMMENT ON VIEW platform.web_push_health IS
  'سلامت ارسال لحظه‌ای سایت — معوق‌های کهنه، نامهٔ مرده، و پیکربندی ناسازگار.';
