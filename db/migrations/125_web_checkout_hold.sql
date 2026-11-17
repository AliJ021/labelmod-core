-- =====================================================================
-- ۱۲۵ — نگه‌داشت موجودی هنگام پرداخت آنلاین (پیش از پرداخت، نه پس از آن)
-- =====================================================================
-- خواستهٔ مالک ۲۰۲۶/۱۱/۱۷: بیشتر کالاها از هر سایز **یک عدد** دارند، پس فروش
-- دوبارهٔ یک قلم باید ناممکن باشد، نه کمیاب.
--
-- ── شکاف ─────────────────────────────────────────────────────────────
-- Push موجودی زیر یک ثانیه است، ولی سرعت این را حل نمی‌کند. سفارش پیش‌پرداخت
-- سایت تا **پس از** پرداخت به Core نمی‌رسید (`payment_complete`). مشتری در
-- صفحهٔ درگاه بانک چند دقیقه می‌ماند و در تمام این مدت Core از سبد او خبر
-- نداشت: صندوق همان تک‌قلم را می‌فروخت، پرداخت آنلاین موفق می‌شد و سفارش در
-- Core با «موجودی کافی نیست» می‌ایستاد — مشتری پول داده و کالا رفته است.
--
-- ── راه‌حل: نگه‌داشت در Core، لحظهٔ ساخت سفارش، پیش از رفتن به درگاه ───
-- `inventory.web_checkout_hold()` همان ساختار رزرو ۰۹۲ را با نوع `checkout` و
-- انقضا (`web.checkout_hold_minutes`، پیش‌فرض ۲۰) می‌سازد. تصمیم «چه کسی قلم
-- آخر را می‌برد» در **یک** جا و زیر قفل سطر موجودی گرفته می‌شود:
--   • صندوق پس از نگه‌داشت نمی‌تواند بفروشد: سهم در `reserved` است و Trigger
--     ۰۹۲ (`guard_reserved_stock`) هر خروج دیگری را رد می‌کند.
--   • مشتری آنلاین دوم همان قلم را نمی‌تواند نگه دارد: پاسخ `unavailable` و
--     افزونه پرداخت را پیش از رفتن به بانک متوقف می‌کند.
--   • اگر صندوق اول فروخته باشد، نگه‌داشت `unavailable` می‌گیرد — قبل از پرداخت.
--
-- ── عدد سایت عوض نمی‌شود ─────────────────────────────────────────────
-- نگه‌داشت در `checkout_held` هم شمرده می‌شود و عدد سایت
-- `on_hand − reserved + checkout_held` است (Push و خوراک هر دو؛ «یک تعریف»).
-- اگر نگه‌داشت عدد سایت را صفر می‌کرد، خود همان مشتری در «پرداخت دوباره»
-- (صفحهٔ order-pay ووکامرس) با «موجودی کافی نیست» رد می‌شد، و کسر خودِ
-- ووکامرس هنگام پرداخت عدد را منفی می‌کرد. مشتری دوم سایت را خود نگه‌داشت
-- می‌گیرد، نه عدد ویترین.
--
-- ⚠️ **همیشه اول قفل سطر موجودی، بعد «ادعای» سطر رزرو با UPDATE شرطی.** سه
--    مسیر سطر نگه‌داشت را آزاد می‌کنند (پرداخت/لغو همان سفارش، انقضا هنگام
--    نگه‌داشت سفارش دیگر، جاروی دقیقه‌ای). بی `… WHERE released_at IS NULL`
--    زیر قفل، دو مسیر هم‌زمان یک سطر را دو بار از `reserved` کم می‌کردند.
-- ⚠️ نگه‌داشت منقضی تعهد نیست: سفارشی که پس از انقضا پرداخت شود مثل سفارش
--    بی‌رزرو ثبت می‌شود و اگر قلم در این فاصله فروخته شده باشد، همان خطای
--    موجودی پیشین را می‌گیرد. مهلت برای همین قابل تنظیم است.
-- ⚠️ نگه‌داشت Push نمی‌سازد: محتوای سایت عوض نشده است. واترمارک (Trigger ۰۹۷ روی
--    هر تغییر reserved) جلو می‌رود؛ یکنواخت است و محتوای هر نسخه درست می‌ماند.
--
-- آزمون: `db/test/web-checkout-hold.sql`.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── ۱. ساختار ────────────────────────────────────────────────────────
-- ستون با پیش‌فرض ثابت فقط فراداده است و جدول را بازنویسی نمی‌کند.
ALTER TABLE inventory.stock_balance
  ADD COLUMN checkout_held platform.qty NOT NULL DEFAULT 0;
-- دو مرحله‌ای (قاعدهٔ FND-R60-05): VALIDATE فقط SHARE UPDATE EXCLUSIVE می‌گیرد.
ALTER TABLE inventory.stock_balance
  ADD CONSTRAINT checkout_held_within_reserved
  CHECK (checkout_held >= 0 AND checkout_held <= reserved) NOT VALID;
ALTER TABLE inventory.stock_balance VALIDATE CONSTRAINT checkout_held_within_reserved;

COMMENT ON COLUMN inventory.stock_balance.checkout_held IS
  'بخشی از reserved که نگه‌داشت پرداخت آنلاین است (۱۲۵)؛ صندوق نمی‌فروشدش ولی از عدد سایت کم نمی‌شود';

ALTER TABLE inventory.web_order_reservation
  ADD COLUMN kind text NOT NULL DEFAULT 'cod',
  ADD COLUMN expires_at timestamptz;
ALTER TABLE inventory.web_order_reservation
  ADD CONSTRAINT web_order_reservation_kind CHECK (kind IN ('cod','checkout')) NOT VALID;
ALTER TABLE inventory.web_order_reservation VALIDATE CONSTRAINT web_order_reservation_kind;

CREATE INDEX web_order_reservation_checkout_due
  ON inventory.web_order_reservation (expires_at)
  WHERE kind = 'checkout' AND status = 'reserved';
CREATE INDEX stock_reservation_checkout_open
  ON inventory.stock_reservation (variation_id, warehouse_id, expires_at)
  WHERE source = 'woo_checkout' AND released_at IS NULL;

INSERT INTO platform.setting(key, value, description, requires_approval, kind, label, group_key,
                             options, min_value, max_value, unit, help, sort_order, permission, is_editable)
VALUES ('web.checkout_hold_minutes', '20'::jsonb,
  'مدت نگه‌داشت کالای سبد خرید سایت هنگام پرداخت آنلاین.', false,
  'int', 'مهلت نگه‌داشت کالا هنگام پرداخت آنلاین', 'web', NULL, 5, 120, 'دقیقه',
  'از لحظهٔ ثبت سفارش در سایت تا پایان این مهلت، صندوق همان قلم را نمی‌فروشد و مشتری دیگری هم نمی‌تواند آن را بخرد. اگر پرداخت در این مهلت تمام نشود، کالا خودبه‌خود آزاد می‌شود. کوتاه‌تر از زمان صفحهٔ بانک نگذارید؛ پرداختی که پس از مهلت تمام شود دیگر تضمین موجودی ندارد.',
  63, 'settings.manage', true)
ON CONFLICT (key) DO NOTHING;

-- ── ۲. عدد سایت: یک تعریف ────────────────────────────────────────────
-- همان بدنهٔ ۰۹۷؛ فقط فرمول عدد.
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
  v_rev bigint;
  v_qty platform.qty;
  v_active boolean;
BEGIN
  IF NOT platform.setting_bool('web.push_enabled', false) THEN RETURN; END IF;
  IF p_warehouse IS DISTINCT FROM platform.web_warehouse_id() THEN RETURN; END IF;

  SELECT sku, status = 'active' INTO v_sku, v_active FROM catalog.variation WHERE id = p_variation;
  -- عدد و واترمارک از **یک** خواندن. نگه‌داشت پرداخت آنلاین (۱۲۵) از عدد سایت کم
  -- نمی‌شود؛ همان فرمول خوراک `/web/stock`.
  SELECT CASE WHEN v_active
              THEN greatest(0, coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) + coalesce(b.checkout_held, 0))
              ELSE 0 END,
         b.row_version
    INTO v_qty, v_rev
    FROM inventory.stock_balance b
   WHERE b.variation_id = p_variation AND b.warehouse_id = p_warehouse;

  PERFORM platform.enqueue_web_push(
    'web.stock_push',
    jsonb_build_object(
      'variationId', p_variation::text,
      'sku',         v_sku,
      'onHand',      trim_scale(coalesce(v_qty, 0)),
      'warehouseId', p_warehouse::text,
      'active',      coalesce(v_active, false),
      'stockRev',    coalesce(v_rev, 0)::text,
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ));
END $$;
REVOKE ALL ON FUNCTION inventory.push_web_stock(uuid, uuid) FROM PUBLIC;

-- ── ۳. آزادکردن یک سطر رزرو سایت — تنها مسیر ───────────────────────
-- فراخوان باید سطر موجودی را **پیش‌تر** قفل کرده باشد (ترتیب: موجودی، بعد رزرو).
-- UPDATE شرطی سطر را «ادعا» می‌کند؛ اگر مسیر دیگری زودتر آزادش کرده، هیچ نمی‌کند.
CREATE FUNCTION inventory.release_web_reservation_line(p_line uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, inventory, platform, catalog
AS $$
DECLARE r inventory.stock_reservation%ROWTYPE;
BEGIN
  UPDATE inventory.stock_reservation SET released_at = now()
   WHERE id = p_line AND released_at IS NULL AND source IN ('woocommerce','woo_checkout')
   RETURNING * INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE inventory.stock_balance
     SET reserved = reserved - r.qty,
         checkout_held = checkout_held - CASE WHEN r.source = 'woo_checkout' THEN r.qty ELSE 0 END,
         updated_at = now()
   WHERE variation_id = r.variation_id AND warehouse_id = r.warehouse_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION inventory.release_web_reservation_line(uuid) FROM PUBLIC;

-- ── ۴. رزرو سفارش سایت (۰۹۲) با شناخت نگه‌داشت پرداخت ──────────────
-- تفاوت‌ها با ۰۹۲:
--   • نگه‌داشتِ آزادشده (منقضی یا پرداخت‌نشده) پایانی نیست: `lock`/`consume` مثل سفارش
--     بی‌رزرو ادامه می‌دهند و `reserve` (پرداخت در محل) از نو رزرو می‌کند.
--   • `reserve` روی نگه‌داشت فعال همان سهم را به رزرو پرداخت در محل تبدیل می‌کند (بی انقضا،
--     و از این لحظه از عدد سایت کم می‌شود — همان اثر رزرو تازهٔ ۰۹۲).
--   • `consume` نگه‌داشت پرداخت آنلاین «تحویل» نمی‌خواهد؛ پول گرفته شده است.
--   • آزادسازی از `release_web_reservation_line` می‌گذرد (قفل موجودی، بعد ادعای سطر).
CREATE OR REPLACE FUNCTION inventory.web_order_reserve(
  p_actor uuid, p_external text, p_branch uuid, p_warehouse uuid,
  p_lines jsonb, p_action text, p_delivered boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, inventory, platform, identity, catalog AS $$
DECLARE
  v_order inventory.web_order_reservation%ROWTYPE;
  v_lines jsonb;
  v_line record;
  v_available numeric;
  v_status text;
  v_existing boolean;
  v_stale_hold boolean := false;
BEGIN
  IF p_action NOT IN ('reserve','release','consume','lock') OR p_action IS NULL
      OR p_external IS NULL OR length(btrim(p_external)) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'درخواست رزرو سفارش معتبر نیست';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory.warehouse WHERE id=p_warehouse AND branch_id=p_branch)
    OR NOT EXISTS (SELECT 1 FROM identity.user_role WHERE user_id=p_actor AND (branch_id IS NULL OR branch_id=p_branch)) THEN
    RAISE EXCEPTION 'شعبه یا انبار رزرو مجاز نیست';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.can(p_actor,'sale.create',NULL,NULL,false) WHERE verdict='allow') THEN
    RAISE EXCEPTION 'مجوز ثبت سفارش برای رزرو لازم است';
  END IF;
  PERFORM platform.set_actor(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('web-order:' || p_actor::text || ':' || p_external, 0));
  SELECT * INTO v_order FROM inventory.web_order_reservation
    WHERE actor_id=p_actor AND external_id=p_external FOR UPDATE;
  v_existing := FOUND;
  IF v_existing AND (v_order.branch_id<>p_branch OR v_order.warehouse_id<>p_warehouse) THEN
    RAISE EXCEPTION 'شعبه و انبار سفارش رزروشده قابل تغییر نیست';
  END IF;
  v_stale_hold := v_existing AND v_order.kind = 'checkout' AND v_order.status = 'released'
                  AND p_action IN ('consume','lock','reserve');

  -- رسیدِ وضعیت نهایی به فعال ماندن کالا وابسته نیست؛ لغوِ دیررس هم اثر مالی ندارد.
  IF v_existing AND v_order.status IN ('released','consumed') AND NOT v_stale_hold THEN
    IF p_action IN ('consume','lock') THEN
      RAISE EXCEPTION 'این سفارش پیش‌تر لغو یا نهایی شده است';
    END IF;
    RETURN jsonb_build_object('reservationId',v_order.id,'status',v_order.status,'replayed',true);
  END IF;

  IF p_action <> 'release' THEN
    IF p_action='reserve' AND NOT EXISTS (SELECT 1 FROM inventory.warehouse
        WHERE id=p_warehouse AND is_active AND kind IN ('store','stock','outlet')) THEN
      RAISE EXCEPTION 'رزرو فقط از انبار فعال و قابل‌فروش مجاز است';
    END IF;
    IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'سفارش باید بین یک تا دویست قلم داشته باشد';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
      WHERE coalesce(l->>'qty','') !~ '^[0-9]+(\.[0-9]{1,3})?$'
        OR coalesce(l->>'sku','')='') THEN
      RAISE EXCEPTION 'شناسه کالا یا تعداد رزرو معتبر نیست';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
      LEFT JOIN catalog.variation v ON v.sku=l->>'sku'
      LEFT JOIN catalog.product p ON p.id=v.product_id
      WHERE v.id IS NULL OR v.status<>'active' OR p.status<>'active' OR (l->>'qty')::numeric<=0) THEN
      RAISE EXCEPTION 'کالای رزرو یافت نشد، غیرفعال است یا تعداد مثبت نیست';
    END IF;
    -- اقلام تکراری و ترتیب متفاوت همان سبد به یک نمایش قطعی تبدیل می‌شوند.
    SELECT jsonb_agg(jsonb_build_object('variationId',id,'qty',qty) ORDER BY id) INTO v_lines
    FROM (SELECT v.id,sum((l->>'qty')::numeric)::platform.qty qty
      FROM jsonb_array_elements(p_lines) l JOIN catalog.variation v ON v.sku=l->>'sku' GROUP BY v.id) x;
    -- نگه‌داشت پرداخت آنلاین تعهد ثبت سفارش نیست: سفارش پرداخت‌شده‌ای که اقلامش با نگه‌داشت
    -- فرق کند (ویرایش مدیر پیش از پرداخت) رد نمی‌شود؛ نگه‌داشت آزاد و سفارش بی‌رزرو ثبت می‌شود.
    IF v_existing AND v_order.status<>'released' AND v_order.lines<>v_lines
       AND NOT (v_order.kind='checkout' AND p_action IN ('lock','consume')) THEN
      RAISE EXCEPTION 'اقلام سفارش با رزرو قبلی متفاوت است؛ ابتدا سفارش قبلی را لغو کنید';
    END IF;
  ELSE
    v_lines := '[]'::jsonb;
  END IF;

  -- پیش از ساخت اقلام و اولین حسابرسی قیمت، فقط قفل می‌گیریم؛ نه رزرو و نه حسابرسی.
  IF p_action='lock' THEN
    PERFORM 1 FROM inventory.stock_balance b
      JOIN jsonb_to_recordset(v_lines) AS l("variationId" uuid,qty numeric) ON l."variationId"=b.variation_id
      WHERE b.warehouse_id=p_warehouse ORDER BY b.variation_id FOR UPDATE OF b;
    RETURN jsonb_build_object('status','locked');
  END IF;

  -- سفارش‌های قطعی پیش از نصب ۰۹۲ نیز دوباره رزرو نمی‌شوند.
  IF NOT v_existing AND p_action<>'consume' AND EXISTS (
    SELECT 1 FROM platform.inbox_message WHERE source='api.web.order'
      AND event_id='woo-order:' || p_external AND result_ref IS NOT NULL
      AND payload->>'actorId'=p_actor::text
  ) THEN
    INSERT INTO inventory.web_order_reservation(actor_id,external_id,branch_id,warehouse_id,lines,status)
      VALUES(p_actor,p_external,p_branch,p_warehouse,v_lines,'consumed') RETURNING * INTO v_order;
    RETURN jsonb_build_object('reservationId',v_order.id,'status','consumed','replayed',true);
  END IF;

  IF v_existing AND p_action='reserve' AND v_order.kind='cod' THEN
    RETURN jsonb_build_object('reservationId',v_order.id,'status',v_order.status,'replayed',true);
  END IF;
  IF v_existing AND p_action='consume' AND v_order.kind='cod' AND NOT coalesce(p_delivered,false) THEN
    RAISE EXCEPTION 'خروج سفارش پرداخت در محل فقط پس از تأیید تحویل مجاز است';
  END IF;
  v_status := CASE p_action WHEN 'reserve' THEN 'reserved' WHEN 'release' THEN 'released' ELSE 'consumed' END;
  IF NOT v_existing THEN
    INSERT INTO inventory.web_order_reservation(actor_id,external_id,branch_id,warehouse_id,lines,status)
      VALUES(p_actor,p_external,p_branch,p_warehouse,v_lines,v_status) RETURNING * INTO v_order;
  END IF;

  IF p_action='reserve' AND v_existing AND v_order.kind='checkout' AND v_order.status='reserved' THEN
    -- نگه‌داشت فعال → رزرو پرداخت در محل: همان سهم، بی انقضا؛ از حالا از عدد سایت کم می‌شود.
    FOR v_line IN SELECT * FROM inventory.stock_reservation
      WHERE source='woo_checkout' AND source_ref=v_order.id::text AND released_at IS NULL ORDER BY variation_id LOOP
      PERFORM 1 FROM inventory.stock_balance WHERE variation_id=v_line.variation_id AND warehouse_id=p_warehouse FOR UPDATE;
      UPDATE inventory.stock_reservation SET source='woocommerce', expires_at='infinity'
        WHERE id=v_line.id AND released_at IS NULL AND source='woo_checkout';
      IF FOUND THEN
        UPDATE inventory.stock_balance
           SET checkout_held=checkout_held-v_line.qty,row_version=row_version+1,updated_at=now()
         WHERE variation_id=v_line.variation_id AND warehouse_id=p_warehouse;
        PERFORM inventory.push_web_stock(v_line.variation_id,p_warehouse);
      END IF;
    END LOOP;
    -- اگر سطری در این فاصله منقضی و آزاد شده بود، بقیهٔ سبد عیناً رزرو تازه می‌گیرد.
    FOR v_line IN SELECT * FROM jsonb_to_recordset(v_lines) AS l("variationId" uuid,qty numeric)
      WHERE NOT EXISTS (SELECT 1 FROM inventory.stock_reservation sr
        WHERE sr.source='woocommerce' AND sr.source_ref=v_order.id::text AND sr.released_at IS NULL
          AND sr.variation_id=l."variationId")
      ORDER BY "variationId" LOOP
      SELECT on_hand-reserved INTO v_available FROM inventory.stock_balance
        WHERE variation_id=v_line."variationId" AND warehouse_id=p_warehouse FOR UPDATE;
      IF NOT FOUND OR v_available<v_line.qty THEN
        RAISE EXCEPTION 'موجودی قابل‌فروش برای رزرو کالا کافی نیست: %',v_line."variationId";
      END IF;
      UPDATE inventory.stock_balance SET reserved=reserved+v_line.qty,row_version=row_version+1,updated_at=now()
        WHERE variation_id=v_line."variationId" AND warehouse_id=p_warehouse;
      INSERT INTO inventory.stock_reservation(variation_id,warehouse_id,qty,source,source_ref,expires_at)
        VALUES(v_line."variationId",p_warehouse,v_line.qty,'woocommerce',v_order.id::text,'infinity');
      PERFORM inventory.push_web_stock(v_line."variationId",p_warehouse);
    END LOOP;
    UPDATE inventory.web_order_reservation SET kind='cod',status='reserved',expires_at=NULL,updated_at=now()
      WHERE id=v_order.id;
  ELSIF p_action='reserve' THEN
    FOR v_line IN SELECT * FROM jsonb_to_recordset(v_lines) AS l("variationId" uuid,qty numeric) ORDER BY "variationId" LOOP
      SELECT on_hand-reserved INTO v_available FROM inventory.stock_balance
        WHERE variation_id=v_line."variationId" AND warehouse_id=p_warehouse FOR UPDATE;
      IF NOT FOUND OR v_available<v_line.qty THEN
        RAISE EXCEPTION 'موجودی قابل‌فروش برای رزرو کالا کافی نیست: %',v_line."variationId";
      END IF;
      UPDATE inventory.stock_balance SET reserved=reserved+v_line.qty,row_version=row_version+1,updated_at=now()
        WHERE variation_id=v_line."variationId" AND warehouse_id=p_warehouse;
      INSERT INTO inventory.stock_reservation(variation_id,warehouse_id,qty,source,source_ref,expires_at)
        VALUES(v_line."variationId",p_warehouse,v_line.qty,'woocommerce',v_order.id::text,'infinity');
      PERFORM inventory.push_web_stock(v_line."variationId",p_warehouse);
    END LOOP;
    IF v_existing THEN   -- نگه‌داشتِ منقضیِ همین سفارش، حالا رزرو پرداخت در محل
      UPDATE inventory.web_order_reservation SET kind='cod',status='reserved',lines=v_lines,expires_at=NULL,updated_at=now()
        WHERE id=v_order.id;
    END IF;
  ELSIF v_existing THEN
    FOR v_line IN SELECT * FROM inventory.stock_reservation
      WHERE source IN ('woocommerce','woo_checkout') AND source_ref=v_order.id::text AND released_at IS NULL
      ORDER BY variation_id LOOP
      PERFORM 1 FROM inventory.stock_balance WHERE variation_id=v_line.variation_id AND warehouse_id=p_warehouse FOR UPDATE;
      IF inventory.release_web_reservation_line(v_line.id) THEN
        UPDATE inventory.stock_balance SET row_version=row_version+1
          WHERE variation_id=v_line.variation_id AND warehouse_id=p_warehouse;
        PERFORM inventory.push_web_stock(v_line.variation_id,p_warehouse);
      END IF;
    END LOOP;
    UPDATE inventory.web_order_reservation SET status=v_status,updated_at=now() WHERE id=v_order.id;
  END IF;
  PERFORM platform.audit('web_order.' || p_action,'web_order_reservation',v_order.id::text,
    jsonb_build_object('status',v_status,'externalId',p_external,'branchId',p_branch,'kind',v_order.kind),p_actor);
  INSERT INTO platform.inbox_message(source,event_id,payload,result_ref)
    VALUES('api.web.reservation.' || p_action,p_actor::text || ':' || p_external,
      jsonb_build_object('branchId',p_branch,'warehouseId',p_warehouse,'lines',v_lines),v_order.id::text)
    ON CONFLICT (source,event_id) DO NOTHING;
  RETURN jsonb_build_object('reservationId',v_order.id,'status',v_status,'replayed',false);
END $$;
REVOKE EXECUTE ON FUNCTION inventory.web_order_reserve(uuid,text,uuid,uuid,jsonb,text,boolean) FROM PUBLIC;

-- ── ۵. نگه‌داشت پرداخت آنلاین ────────────────────────────────────────
-- پاسخ:
--   held        نگه داشته شد (یا تمدید شد) تا `expiresAt`.
--   unavailable هیچ‌چیز نگه داشته نشد؛ `unavailable` اقلام کم را می‌گوید و
--               `heldByCheckout` یعنی کمبود از پرداختِ در جریانِ مشتری دیگر است.
--   reserved    سفارش پرداخت در محل همین شناسه پیش‌تر رزرو شده؛ کاری لازم نیست.
--   consumed    سفارش پیش‌تر در Core ثبت شده است.
CREATE FUNCTION inventory.web_checkout_hold(
  p_actor uuid, p_external text, p_branch uuid, p_warehouse uuid, p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, inventory, platform, identity, catalog AS $$
DECLARE
  v_order    inventory.web_order_reservation%ROWTYPE;
  v_existing boolean;
  v_lines    jsonb;
  v_minutes  int := greatest(5, least(120, coalesce(platform.setting_int('web.checkout_hold_minutes', 20), 20)));
  v_expires  timestamptz;
  v_var      record;
  v_b        inventory.stock_balance%ROWTYPE;
  v_want     numeric;
  v_short    jsonb := '[]'::jsonb;
  v_others   numeric;
BEGIN
  IF p_external IS NULL OR length(btrim(p_external)) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'درخواست نگه‌داشت سفارش معتبر نیست';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory.warehouse WHERE id=p_warehouse AND branch_id=p_branch
                   AND is_active AND kind IN ('store','stock','outlet'))
    OR NOT EXISTS (SELECT 1 FROM identity.user_role WHERE user_id=p_actor AND (branch_id IS NULL OR branch_id=p_branch)) THEN
    RAISE EXCEPTION 'شعبه یا انبار نگه‌داشت مجاز نیست';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.can(p_actor,'sale.create',NULL,NULL,false) WHERE verdict='allow') THEN
    RAISE EXCEPTION 'مجوز ثبت سفارش برای نگه‌داشت لازم است';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'سفارش باید بین یک تا دویست قلم داشته باشد';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE coalesce(l->>'qty','') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR coalesce(l->>'sku','')='') THEN
    RAISE EXCEPTION 'شناسه کالا یا تعداد نگه‌داشت معتبر نیست';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN catalog.variation v ON v.sku=l->>'sku'
    LEFT JOIN catalog.product p ON p.id=v.product_id
    WHERE v.id IS NULL OR v.status<>'active' OR p.status<>'active' OR (l->>'qty')::numeric<=0) THEN
    RAISE EXCEPTION 'کالای سفارش یافت نشد، غیرفعال است یا تعداد مثبت نیست';
  END IF;

  PERFORM platform.set_actor(p_actor);
  -- همان کلید ۰۹۲: نگه‌داشت، رزرو، لغو و ثبت یک سفارش هرگز هم‌زمان نیستند.
  PERFORM pg_advisory_xact_lock(hashtextextended('web-order:' || p_actor::text || ':' || p_external, 0));
  SELECT * INTO v_order FROM inventory.web_order_reservation
    WHERE actor_id=p_actor AND external_id=p_external FOR UPDATE;
  v_existing := FOUND;
  IF v_existing AND (v_order.branch_id<>p_branch OR v_order.warehouse_id<>p_warehouse) THEN
    RAISE EXCEPTION 'شعبه و انبار سفارش قابل تغییر نیست';
  END IF;
  IF v_existing AND v_order.status = 'consumed' THEN
    RETURN jsonb_build_object('reservationId',v_order.id,'status','consumed');
  END IF;
  IF v_existing AND v_order.kind = 'cod' THEN
    IF v_order.status = 'reserved' THEN
      RETURN jsonb_build_object('reservationId',v_order.id,'status','reserved');
    END IF;
    RAISE EXCEPTION 'این سفارش پیش‌تر لغو شده است؛ سفارش تازه ثبت کنید';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('variationId',id,'sku',sku,'qty',qty) ORDER BY id) INTO v_lines
    FROM (SELECT v.id, v.sku, sum((l->>'qty')::numeric)::platform.qty qty
            FROM jsonb_array_elements(p_lines) l JOIN catalog.variation v ON v.sku=l->>'sku'
           GROUP BY v.id, v.sku) x;
  v_expires := now() + make_interval(mins => v_minutes);

  -- زیرتراکنش: اگر حتی یک قلم کم باشد، هیچ تغییری (حتی آزادسازی‌های همین دور) نمی‌ماند.
  BEGIN
    -- همهٔ کالاهای درگیر — سبد تازه و نگه‌داشت فعلی همین سفارش — به ترتیب شناسه قفل می‌شوند.
    FOR v_var IN
      SELECT DISTINCT x.variation_id FROM (
        SELECT (e->>'variationId')::uuid AS variation_id FROM jsonb_array_elements(v_lines) e
        UNION
        SELECT sr.variation_id FROM inventory.stock_reservation sr
         WHERE v_existing AND sr.source='woo_checkout' AND sr.source_ref=v_order.id::text AND sr.released_at IS NULL
      ) x ORDER BY x.variation_id
    LOOP
      SELECT * INTO v_b FROM inventory.stock_balance
       WHERE variation_id=v_var.variation_id AND warehouse_id=p_warehouse FOR UPDATE;
      -- نگه‌داشت‌های منقضیِ همین کالا (هر سفارشی) و نگه‌داشت قبلی همین سفارش آزاد می‌شوند.
      PERFORM inventory.release_web_reservation_line(sr.id)
         FROM inventory.stock_reservation sr
        WHERE sr.variation_id=v_var.variation_id AND sr.warehouse_id=p_warehouse
          AND sr.source='woo_checkout' AND sr.released_at IS NULL
          AND (sr.expires_at <= now() OR (v_existing AND sr.source_ref=v_order.id::text));
      SELECT coalesce(sum((e->>'qty')::numeric), 0) INTO v_want
        FROM jsonb_array_elements(v_lines) e WHERE (e->>'variationId')::uuid = v_var.variation_id;
      CONTINUE WHEN v_want = 0;
      SELECT * INTO v_b FROM inventory.stock_balance
       WHERE variation_id=v_var.variation_id AND warehouse_id=p_warehouse;
      IF NOT FOUND OR v_b.on_hand - v_b.reserved < v_want THEN
        v_others := CASE WHEN FOUND THEN v_b.checkout_held ELSE 0 END;
        v_short := v_short || jsonb_build_object(
          'sku', (SELECT sku FROM catalog.variation WHERE id = v_var.variation_id),
          'available', trim_scale(greatest(0, coalesce(v_b.on_hand, 0) - coalesce(v_b.reserved, 0)))::text,
          'heldByCheckout', FOUND AND v_b.on_hand - v_b.reserved + v_others >= v_want);
        CONTINUE;
      END IF;
      UPDATE inventory.stock_balance
         SET reserved = reserved + v_want, checkout_held = checkout_held + v_want, updated_at = now()
       WHERE variation_id=v_var.variation_id AND warehouse_id=p_warehouse;
    END LOOP;
    IF jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'LMC01', MESSAGE = 'unavailable';
    END IF;
  EXCEPTION WHEN SQLSTATE 'LMC01' THEN
    RETURN jsonb_build_object('status','unavailable','unavailable',v_short);
  END;

  IF v_existing THEN
    UPDATE inventory.web_order_reservation
       SET kind='checkout', status='reserved', lines=(SELECT jsonb_agg(e - 'sku' ORDER BY o) FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(e, o)),
           expires_at=v_expires, updated_at=now()
     WHERE id=v_order.id;
  ELSE
    INSERT INTO inventory.web_order_reservation(actor_id,external_id,branch_id,warehouse_id,lines,status,kind,expires_at)
    VALUES (p_actor,p_external,p_branch,p_warehouse,
            (SELECT jsonb_agg(e - 'sku' ORDER BY o) FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(e, o)),'reserved','checkout',v_expires)
    RETURNING * INTO v_order;
  END IF;
  INSERT INTO inventory.stock_reservation(variation_id,warehouse_id,qty,source,source_ref,expires_at)
  SELECT (e->>'variationId')::uuid, p_warehouse, (e->>'qty')::numeric, 'woo_checkout', v_order.id::text, v_expires
    FROM jsonb_array_elements(v_lines) e;
  PERFORM platform.audit('web_order.hold','web_order_reservation',v_order.id::text,
    jsonb_build_object('externalId',p_external,'branchId',p_branch,'expiresAt',v_expires,
                       'lines',(SELECT jsonb_agg(e - 'variationId') FROM jsonb_array_elements(v_lines) e)),p_actor);
  RETURN jsonb_build_object('reservationId',v_order.id,'status','held',
    'expiresAt', to_char(v_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $$;
REVOKE EXECUTE ON FUNCTION inventory.web_checkout_hold(uuid,text,uuid,uuid,jsonb) FROM PUBLIC;

-- ── ۶. جاروی نگه‌داشت‌های منقضی (Worker، دقیقه‌ای) ──────────────────
-- ترتیب قفل همان: سطر موجودی به ترتیب کالا، بعد ادعای سطر رزرو. سطر سفارش با
-- SKIP LOCKED: سفارشی که همین حالا ثبت یا لغو می‌شود، خودش وضعیتش را می‌نویسد.
CREATE FUNCTION inventory.expire_checkout_holds(p_actor uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, inventory, platform, identity, catalog AS $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN SELECT id, variation_id, warehouse_id FROM inventory.stock_reservation
            WHERE source='woo_checkout' AND released_at IS NULL AND expires_at <= now()
            ORDER BY variation_id, warehouse_id LOOP
    PERFORM 1 FROM inventory.stock_balance
      WHERE variation_id=r.variation_id AND warehouse_id=r.warehouse_id FOR UPDATE;
    IF inventory.release_web_reservation_line(r.id) THEN n := n + 1; END IF;
  END LOOP;
  FOR r IN SELECT w.id, w.external_id FROM inventory.web_order_reservation w
            WHERE w.kind='checkout' AND w.status='reserved' AND w.expires_at <= now()
              AND NOT EXISTS (SELECT 1 FROM inventory.stock_reservation sr
                               WHERE sr.source='woo_checkout' AND sr.source_ref=w.id::text AND sr.released_at IS NULL)
            FOR UPDATE SKIP LOCKED LOOP
    UPDATE inventory.web_order_reservation SET status='released', updated_at=now() WHERE id=r.id;
    IF p_actor IS NOT NULL THEN
      PERFORM platform.set_actor(p_actor);
      PERFORM platform.audit('web_order.hold_expired','web_order_reservation',r.id::text,
        jsonb_build_object('externalId',r.external_id),p_actor);
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION inventory.expire_checkout_holds(uuid) FROM PUBLIC;

COMMENT ON FUNCTION inventory.web_checkout_hold(uuid,text,uuid,uuid,jsonb) IS
  'نگه‌داشت موجودی سبد سایت پیش از رفتن به درگاه (۱۲۵)؛ unavailable یعنی پرداخت نباید شروع شود';
COMMENT ON FUNCTION inventory.expire_checkout_holds(uuid) IS
  'آزادکردن نگه‌داشت‌های پرداخت آنلاینِ منقضی؛ Worker هر دقیقه';

COMMIT;
