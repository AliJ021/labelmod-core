-- رزرو سفارش پرداخت در محل: بدون فروش، دریافت وجه یا حرکت فیزیکی.
BEGIN;

CREATE TABLE inventory.web_order_reservation (
  id uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  actor_id uuid NOT NULL REFERENCES identity.app_user(id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  branch_id uuid NOT NULL REFERENCES platform.branch(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),
  lines jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','released','consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,external_id)
);

-- همهٔ مسیرهای خروج، حتی SQL مستقیم نهایی‌سازی، سهم سفارش‌های رزروشده را حفظ می‌کنند.
-- رزروِ خود سفارش پیش از خروج و در همان تراکنش آزاد می‌شود.
CREATE FUNCTION inventory.guard_reserved_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reserved > 0 AND NEW.on_hand < OLD.on_hand AND NEW.on_hand < NEW.reserved THEN
    RAISE EXCEPTION 'موجودی قابل‌فروش کافی نیست؛ بخشی از کالا برای سفارش سایت رزرو شده است';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_balance_reserved_guard BEFORE UPDATE OF on_hand ON inventory.stock_balance
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_reserved_stock();

-- هویت سفارش و قفل آن مستقل از Inbox است: لغو قبل از رسیدن رزرو هم یک رد پای پایدار دارد.
-- تاریخ انقضا عمداً infinity است؛ تنها لغو صریح یا خروج قطعی رزرو را آزاد می‌کند.
CREATE FUNCTION inventory.web_order_reserve(
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

  -- رسیدِ وضعیت نهایی به فعال ماندن کالا وابسته نیست؛ لغوِ دیررس هم اثر مالی ندارد.
  IF v_existing AND v_order.status IN ('released','consumed') THEN
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
    IF v_existing AND v_order.status<>'released' AND v_order.lines<>v_lines THEN
      RAISE EXCEPTION 'اقلام سفارش با رزرو قبلی متفاوت است؛ ابتدا سفارش قبلی را لغو کنید';
    END IF;
  ELSE
    v_lines := '[]'::jsonb;
  END IF;

  -- پیش از ساخت اقلام و اولین حسابرسی قیمت، فقط قفل می‌گیریم؛ نه رزرو و نه حسابرسی.
  -- ترتیب همه مسیرهای سفارش: هویت سفارش، تمام سطرهای موجودی مرتب، سپس حسابرسی.
  -- قفل زودهنگام حسابرسی، Snapshot قیمت هم‌زمان را مسدود می‌کند؛ قفل دیرهنگام
  -- موجودی هم با لغو/رزرو سفارش دیگر وارونگی قفل می‌سازد.
  IF p_action='lock' THEN
    PERFORM 1 FROM inventory.stock_balance b
      JOIN jsonb_to_recordset(v_lines) AS l("variationId" uuid,qty numeric) ON l."variationId"=b.variation_id
      WHERE b.warehouse_id=p_warehouse ORDER BY b.variation_id FOR UPDATE OF b;
    RETURN jsonb_build_object('status','locked');
  END IF;

  -- سفارش‌های قطعی پیش از نصب این مهاجرت نیز دوباره رزرو نمی‌شوند.
  IF NOT v_existing AND p_action<>'consume' AND EXISTS (
    SELECT 1 FROM platform.inbox_message WHERE source='api.web.order'
      AND event_id='woo-order:' || p_external AND result_ref IS NOT NULL
      AND payload->>'actorId'=p_actor::text
  ) THEN
    INSERT INTO inventory.web_order_reservation(actor_id,external_id,branch_id,warehouse_id,lines,status)
      VALUES(p_actor,p_external,p_branch,p_warehouse,v_lines,'consumed') RETURNING * INTO v_order;
    RETURN jsonb_build_object('reservationId',v_order.id,'status','consumed','replayed',true);
  END IF;

  IF v_existing AND p_action='reserve' THEN
    RETURN jsonb_build_object('reservationId',v_order.id,'status',v_order.status,'replayed',true);
  END IF;
  IF v_existing AND p_action='consume' AND NOT coalesce(p_delivered,false) THEN
    RAISE EXCEPTION 'خروج سفارش پرداخت در محل فقط پس از تأیید تحویل مجاز است';
  END IF;
  v_status := CASE p_action WHEN 'reserve' THEN 'reserved' WHEN 'release' THEN 'released' ELSE 'consumed' END;
  IF NOT v_existing THEN
    INSERT INTO inventory.web_order_reservation(actor_id,external_id,branch_id,warehouse_id,lines,status)
      VALUES(p_actor,p_external,p_branch,p_warehouse,v_lines,v_status) RETURNING * INTO v_order;
  END IF;

  IF p_action='reserve' THEN
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
  ELSIF v_existing THEN
    FOR v_line IN SELECT * FROM inventory.stock_reservation
      WHERE source='woocommerce' AND source_ref=v_order.id::text AND released_at IS NULL ORDER BY variation_id LOOP
      PERFORM 1 FROM inventory.stock_balance WHERE variation_id=v_line.variation_id AND warehouse_id=p_warehouse FOR UPDATE;
      UPDATE inventory.stock_balance SET reserved=reserved-v_line.qty,row_version=row_version+1,updated_at=now()
        WHERE variation_id=v_line.variation_id AND warehouse_id=p_warehouse;
      UPDATE inventory.stock_reservation SET released_at=now() WHERE id=v_line.id;
      PERFORM inventory.push_web_stock(v_line.variation_id,p_warehouse);
    END LOOP;
    UPDATE inventory.web_order_reservation SET status=v_status,updated_at=now() WHERE id=v_order.id;
  END IF;
  PERFORM platform.audit('web_order.' || p_action,'web_order_reservation',v_order.id::text,
    jsonb_build_object('status',v_status,'externalId',p_external,'branchId',p_branch),p_actor);
  INSERT INTO platform.inbox_message(source,event_id,payload,result_ref)
    VALUES('api.web.reservation.' || p_action,p_actor::text || ':' || p_external,
      jsonb_build_object('branchId',p_branch,'warehouseId',p_warehouse,'lines',v_lines),v_order.id::text)
    ON CONFLICT (source,event_id) DO NOTHING;
  RETURN jsonb_build_object('reservationId',v_order.id,'status',v_status,'replayed',false);
END $$;

COMMIT;
