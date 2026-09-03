-- =====================================================================
-- ۰۲۸ — برگشت از خرید
-- =====================================================================
-- کالایی که از تأمین‌کننده آمده و پس فرستاده می‌شود.
--
-- ── دو مبلغ که یکی نیستند، و اگر یکی گرفته شوند دفتر خراب می‌شود ──
--
-- **بهای فاکتور** آن چیزی است که تأمین‌کننده گرفته: `unit_price` همان
-- سطر رسید. بدهی‌اش دقیقاً به همین اندازه کم می‌شود.
--
-- **ارزش دفتری** آن چیزی است که کالا در انبار ما ارزیده:
-- `landed_unit_cost` — یعنی بهای فاکتور **به‌علاوه سهمش از هزینه حمل**.
--
-- تفاوتشان هزینه حملی است که برای کالایی پرداختیم و پسش فرستادیم.
-- باربری آن را برنمی‌گرداند. این یک **زیان** است و باید سرفصل خودش را
-- بگیرد (۵۱۰۲ تعدیل بهای تمام‌شده)، نه اینکه بی‌صدا در بدهی
-- تأمین‌کننده یا ارزش موجودی گم شود.
--
-- ── چرا بهای همان رسید، نه میانگین جاری ────────────────────────────
--
-- همان قاعده‌ای که برای مرجوعی فروش برقرار است: «مرجوعی با بهای همان
-- فروش برمی‌گردد، نه میانگین جاری انبار.»
--
-- در روش «آخرین قیمت خرید»، هر خرید بعدی کل موجودی را تجدید ارزیابی
-- می‌کند. اگر برگشت از خرید به میانگین جاری خارج شود، کالایی که به
-- نرخ ۱۰۰ آمده بود به نرخ ۱۲۰ برمی‌گردد و ۲۰ واحد ارزش از هوا کم
-- می‌شود. Snapshot سطر رسید این را می‌بندد.
--
-- ── چه چیزی جلوی برگشت را می‌گیرد ──────────────────────────────────
--
--   • بیشتر از آنچه رسید شده برنمی‌گردد (`returned_qty` روی سطر رسید)
--   • رسید ثبت‌نشده برگشت ندارد — چیزی هنوز نیامده که برگردد
--   • موجودی منفی نمی‌شود: کالایی که فروخته شده، پس فرستادنی نیست
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. چقدر از هر سطر رسید تا حالا برگشته
-- ---------------------------------------------------------------------

ALTER TABLE purchasing.receipt_line
  ADD COLUMN returned_qty platform.qty NOT NULL DEFAULT 0
    CHECK (returned_qty >= 0);

ALTER TABLE purchasing.receipt_line
  ADD CONSTRAINT receipt_line_returned_not_more_than_received
  CHECK (returned_qty <= qty);

COMMENT ON COLUMN purchasing.receipt_line.returned_qty IS
  'جمع برگشتی‌های ثبت‌شده از این سطر. فقط post_purchase_return() آن را بالا می‌برد.';

-- ---------------------------------------------------------------------
-- ۲. برگه برگشت
-- ---------------------------------------------------------------------

CREATE TABLE purchasing.purchase_return (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  -- مثل رسید خرید و برگه شمارش: شماره در لحظه ثبت.
  number       text,
  branch_id    uuid NOT NULL REFERENCES platform.branch(id),
  receipt_id   uuid NOT NULL REFERENCES purchasing.receipt(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouse(id),

  -- این چهار مبلغ را فقط post_purchase_return() می‌نویسد.
  goods_amount platform.money NOT NULL DEFAULT 0,  -- بهای فاکتور تأمین‌کننده
  cost_amount  platform.money NOT NULL DEFAULT 0,  -- ارزش دفتری خروجی
  tax_amount   platform.money NOT NULL DEFAULT 0,
  charge_loss  platform.money NOT NULL DEFAULT 0,  -- حملِ برنگشتنی

  reason_code  text NOT NULL,
  reason_note  text,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'posted', 'cancelled')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  posted_at    timestamptz,
  created_by   uuid REFERENCES identity.app_user(id),
  UNIQUE (branch_id, number)
);

CREATE INDEX purchase_return_receipt_idx ON purchasing.purchase_return (receipt_id);

CREATE TABLE purchasing.purchase_return_line (
  id              uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  return_id       uuid NOT NULL REFERENCES purchasing.purchase_return(id) ON DELETE CASCADE,
  -- به **سطر رسید** می‌چسبد، نه به کالا: بهای برگشتی از همان سطر
  -- می‌آید و یک کالا می‌تواند در دو رسید دو نرخ داشته باشد.
  receipt_line_id uuid NOT NULL REFERENCES purchasing.receipt_line(id),
  qty             platform.qty NOT NULL CHECK (qty > 0),

  -- Snapshot در لحظه ثبت. سود و ارزش هرگز از نرخ جاری خوانده نمی‌شوند.
  unit_price      platform.money,
  unit_cost       platform.money,
  goods_amount    platform.money,
  cost_amount     platform.money,

  UNIQUE (return_id, receipt_line_id)
);

-- ---------------------------------------------------------------------
-- ۳. ثبت
-- ---------------------------------------------------------------------

CREATE FUNCTION purchasing.post_purchase_return(
  p_return uuid,
  p_user   uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  r           purchasing.purchase_return%ROWTYPE;
  rc          purchasing.receipt%ROWTYPE;
  v_line      record;
  v_fy        smallint;
  v_goods     platform.money := 0;
  v_cost      platform.money := 0;
  v_tax       platform.money := 0;
  v_line_goods platform.money;
  v_line_cost  platform.money;
  v_receipt_goods platform.money;
  v_entry     uuid;
  v_n         int;
BEGIN
  SELECT * INTO r FROM purchasing.purchase_return WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'برگ برگشت از خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'برگ برگشت % قبلاً ثبت شده است', coalesce(r.number, '(بی‌شماره)');
  END IF;

  SELECT * INTO rc FROM purchasing.receipt WHERE id = r.receipt_id FOR UPDATE;
  IF rc.status <> 'posted' THEN
    RAISE EXCEPTION 'رسید خرید هنوز ثبت نشده — چیزی نیامده که برگردد';
  END IF;

  SELECT count(*) INTO v_n FROM purchasing.purchase_return_line WHERE return_id = p_return;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'برگ برگشت بدون قلم قابل ثبت نیست';
  END IF;

  IF r.number IS NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year
     WHERE r.occurred_at::date BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', r.occurred_at::date;
    END IF;
    r.number := platform.next_document_no(r.branch_id, 'purchase_return', v_fy);
    UPDATE purchasing.purchase_return SET number = r.number WHERE id = p_return;
  END IF;

  -- جمع کالای خودِ رسید — پایه تسهیم مالیات.
  SELECT coalesce(sum(round(qty * unit_price)), 0) INTO v_receipt_goods
    FROM purchasing.receipt_line WHERE receipt_id = r.receipt_id;

  FOR v_line IN
    SELECT prl.id, prl.qty, rl.id AS receipt_line_id, rl.variation_id,
           rl.unit_price, rl.landed_unit_cost, rl.qty AS received_qty, rl.returned_qty
      FROM purchasing.purchase_return_line prl
      JOIN purchasing.receipt_line rl ON rl.id = prl.receipt_line_id
     WHERE prl.return_id = p_return
     ORDER BY prl.id
     FOR UPDATE OF rl
  LOOP
    IF v_line.receipt_line_id IS NULL THEN
      RAISE EXCEPTION 'سطر برگشت به هیچ سطری از رسید نمی‌چسبد';
    END IF;

    IF v_line.returned_qty + v_line.qty > v_line.received_qty THEN
      RAISE EXCEPTION
        'بیشتر از آنچه رسید شده برگشت داده می‌شود: رسیدشده %، قبلاً برگشته %، درخواست %',
        v_line.received_qty, v_line.returned_qty, v_line.qty;
    END IF;

    v_line_goods := round(v_line.qty * v_line.unit_price);
    v_line_cost  := round(v_line.qty * v_line.landed_unit_cost);

    -- ارزش خروجی **صریح** داده می‌شود، نه از میانگین جاری: کالا با
    -- بهای همان رسید برمی‌گردد.
    PERFORM inventory.apply_movement(
      p_variation   => v_line.variation_id,
      p_warehouse   => r.warehouse_id,
      p_qty         => -v_line.qty,
      p_kind        => 'purchase_return',
      p_ref_type    => 'purchase_return',
      p_ref_id      => p_return,
      p_user        => p_user,
      p_unit_cost   => v_line.landed_unit_cost,
      p_occurred_at => r.occurred_at,
      p_note        => 'برگشت از خرید ' || r.number,
      p_value_delta => -v_line_cost);

    UPDATE purchasing.receipt_line
       SET returned_qty = returned_qty + v_line.qty
     WHERE id = v_line.receipt_line_id;

    UPDATE purchasing.purchase_return_line
       SET unit_price   = v_line.unit_price,
           unit_cost    = v_line.landed_unit_cost,
           goods_amount = v_line_goods,
           cost_amount  = v_line_cost
     WHERE id = v_line.id;

    v_goods := v_goods + v_line_goods;
    v_cost  := v_cost  + v_line_cost;
  END LOOP;

  -- مالیات به نسبت بهای کالا برمی‌گردد. با نرخ صفر (پیش‌فرض سیستم)
  -- این عدد صفر است و سطری هم ساخته نمی‌شود.
  v_tax := CASE WHEN v_receipt_goods > 0
                THEN round(rc.tax_amount * v_goods / v_receipt_goods)
                ELSE 0 END;

  UPDATE purchasing.purchase_return
     SET goods_amount = v_goods,
         cost_amount  = v_cost,
         tax_amount   = v_tax,
         charge_loss  = v_cost - v_goods,
         status       = 'posted',
         posted_at    = now()
   WHERE id = p_return;

  v_entry := ledger.post_entry(
    'purchase_return', r.branch_id, r.occurred_at::date,
    'برگشت از خرید ' || r.number,
    jsonb_build_array(
      jsonb_build_object('leg','payable',   'amount', v_goods + v_tax,
                         'party_type','supplier', 'party_id', rc.supplier_id),
      jsonb_build_object('leg','input_tax', 'amount', v_tax),
      jsonb_build_object('leg','inventory', 'amount', v_cost),
      -- هزینه حملِ کالای پس‌فرستاده: پرداختیم و برنمی‌گردد.
      -- علامت‌دار است، پس اگر روزی بهای دفتری کمتر از بهای فاکتور
      -- باشد، همین سطر برعکس می‌شود.
      jsonb_build_object('leg','charge_loss','amount', v_cost - v_goods)),
    'purchase_return', p_return, p_user);

  PERFORM platform.audit('purchase.return', 'purchase_return', p_return::text,
    jsonb_build_object('number', r.number, 'receipt', r.receipt_id,
                       'goods', v_goods, 'cost', v_cost, 'tax', v_tax,
                       'charge_loss', v_cost - v_goods, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION purchasing.post_purchase_return IS
  'برگشت کالا به تأمین‌کننده. کالا با بهای همان رسید خارج می‌شود، نه میانگین جاری.';

COMMIT;
