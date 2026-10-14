-- ۰۹۷ — واترمارک موجودی سایت: یک شمارندهٔ قابل‌مقایسه برای Push، Pull و تأیید سفارش.
--
-- ── مسئله ───────────────────────────────────────────────────────────
--
-- Push نسخه داشت (دنبالهٔ سراسری platform.web_push_version) ولی خوراک ۱۵ دقیقه‌ای
-- (Pull) هیچ نسخه‌ای نداشت؛ پس افزونه نمی‌توانست بفهمد عددِ Pull از Push تازه‌تر
-- است یا کهنه‌تر. و پاسخ رزرو/ثبت سفارش فقط «موفق شد» می‌گفت، نه «از کدام حالت
-- انبار به بعد این سفارش در عدد دیده می‌شود». بی آن، کسر محلی ووکامرس یا دوبار
-- کم می‌شد یا با یک عکس کهنه برمی‌گشت. docs/STOCK-SYNC-PROTOCOL.md.
--
-- ── واترمارک = inventory.stock_balance.row_version ───────────────────
--
-- هر نوشتنِ on_hand/reserved یک سطر (تنوع، انبار) را زیر قفل سطر عوض می‌کند، پس
-- row_version برای همان سطر به ترتیب Commit یکنواخت است. ولی چند نویسندهٔ قدیمی
-- آن را بالا نمی‌بردند؛ این Trigger آن را برای **هر** تغییر موجودی یا رزرو اجبار
-- می‌کند — از هر مسیری، حتی نویسنده‌ای که فردا نوشته شود. نویسنده‌ای که خودش +۱
-- می‌زند هم دقیقاً یک واحد جلو می‌رود، نه دو.
--
-- ⚠️ هیچ دادهٔ موجودی بازنویسی نمی‌شود؛ فقط یک Trigger و بازتعریف push_web_stock.
-- ⚠️ CREATE TRIGGER قفل SHARE ROW EXCLUSIVE کوتاهی روی stock_balance می‌گیرد؛
--    lock_timeout صریح است تا مهاجرت پشت یک تراکنش طولانی صف نکشد و فروش را نخواباند.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION inventory.bump_stock_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.on_hand IS DISTINCT FROM OLD.on_hand OR NEW.reserved IS DISTINCT FROM OLD.reserved THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION inventory.bump_stock_row_version() IS
  'واترمارک سایت: هر تغییر on_hand/reserved دقیقاً یک واحد row_version را جلو می‌برد (مهاجرت ۰۹۷).';

CREATE TRIGGER stock_balance_bump_row_version
  BEFORE UPDATE ON inventory.stock_balance
  FOR EACH ROW EXECUTE FUNCTION inventory.bump_stock_row_version();

-- Push همان واترمارک را می‌برد. نسخهٔ سراسری `version` (برای تکرار/ترتیب پیام) دست
-- نمی‌خورد؛ `stockRev` می‌گوید این عدد «حالت سطر در کدام نقطه» است و با Pull و پاسخ
-- رزرو قابل مقایسه است. push_web_stock پس از UPDATE همان تراکنش صدا زده می‌شود، پس
-- row_version خوانده‌شده همان حالتِ onHand همین پیام است.
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
BEGIN
  IF NOT platform.setting_bool('web.push_enabled', false) THEN RETURN; END IF;
  IF p_warehouse IS DISTINCT FROM platform.web_warehouse_id() THEN RETURN; END IF;

  SELECT sku INTO v_sku FROM catalog.variation WHERE id = p_variation;
  -- عدد و واترمارک از **یک** خواندن، تا عکسِ ناسازگار ساخته نشود.
  SELECT greatest(0, coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)), b.row_version
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
      'stockRev',    coalesce(v_rev, 0)::text,
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ));
END $$;
REVOKE ALL ON FUNCTION inventory.push_web_stock(uuid, uuid) FROM PUBLIC;

COMMIT;
