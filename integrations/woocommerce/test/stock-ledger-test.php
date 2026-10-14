<?php
/**
 * دفتر کسر محلی و واترمارک مشترک Push/Pull — docs/STOCK-SYNC-PROTOCOL.md.
 *
 *   php integrations/woocommerce/test/stock-ledger-test.php
 *
 * SQL خودِ `LMC_Stock_Ledger` روی SQLite واقعی اجرا می‌شود؛ ورودی‌ها از مسیرهای واقعی‌اند:
 * Push از `LMC_Push_Receiver::handle_stock`، Pull از `LMC_Stock_Sync::run`، و رویدادهای
 * ووکامرس همان ترتیب WC 11.1.1 را دارند (اول تغییر `_stock`، بعد `_reduced_stock` و ذخیرهٔ
 * قلم، بعد Hook). بندهای R1 تا R5 همان پنج بازتولید بازبینی root روی head `22924c4`اند.
 *
 * ⚠️ این آزمون ترتیبی است و هم‌زمانی واقعی MySQL را نمی‌سنجد؛ ادعای «هرگز فروش اضافه» از
 *    آن برنمی‌آید. هم‌زمانی با قفل نگه‌داشتهٔ «دیگری» و ترتیب‌های معکوس شبیه‌سازی شده است.
 */

declare(strict_types=1);

define('ABSPATH', __DIR__ . '/');
define('ARRAY_A', 'ARRAY_A');
define('LMC_STOCK_EVENT', 'lmc_stock_event');
if (!extension_loaded('pdo_sqlite')) {
    fwrite(STDERR, "pdo_sqlite لازم است؛ این آزمون بی آن معنا ندارد و رد نمی‌شود.\n");
    exit(1);
}

const WH  = '00000000-0000-7000-8000-000000000101';
const WH2 = '00000000-0000-7000-8000-000000000202';
const P   = 42;
const VAR_ID = 'aaaaaaaa-0000-7000-8000-000000000042';

$GLOBALS['settings'] = ['sync_stock' => 'yes', 'sync_price' => 'no', 'warehouse_id' => WH, 'link_by_sku' => 'no'];
function lmc_setting(string $key, $default = '') { return $GLOBALS['settings'][$key] ?? $default; }
function lmc_log(string $m): void { $GLOBALS['logs'][] = $m; }
function __($t, $d = '') { return $t; }
function esc_html__($t, $d = '') { return $t; }
function add_action(...$a): void {}
function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['options']) ? $GLOBALS['options'][$k] : $d; }
function update_option($k, $v, $a = null) { $GLOBALS['options'][$k] = $v; return true; }
function delete_option($k) { unset($GLOBALS['options'][$k]); return true; }
function dbDelta($sql) { return []; }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_cache_delete($id, $group = '') { return true; }
function get_post_meta($id, $k, $s = false) { return $GLOBALS['meta'][$id][$k] ?? ''; }
function update_post_meta($id, $k, $v) { if (!empty($GLOBALS['fail_meta'])) { return false; } $GLOBALS['meta'][$id][$k] = is_string($v) ? $v : (string) $v; return true; }
function delete_post_meta($id, $k) { unset($GLOBALS['meta'][$id][$k]); return true; }
function get_posts($args) { return ($args['meta_value'] ?? '') === VAR_ID ? [P] : []; }
function wc_get_product($id) { return isset($GLOBALS['stock'][$id]) ? new Product((int) $id) : false; }
function wc_get_order($id) { return $GLOBALS['orders'][(int) $id] ?? false; }
function wc_get_orders($args) {
    $all = array_values($GLOBALS['orders']);
    usort($all, static fn ($a, $b) => $a->id <=> $b->id);
    return array_slice($all, ((int) $args['paged'] - 1) * (int) $args['limit'], (int) $args['limit']);
}
function wp_schedule_single_event(...$a) { $GLOBALS['scheduled'][] = $a; }
function is_wp_error($v) { return $v instanceof WP_Error; }
class WP_Error {
    public function __construct(public $code = '', public $message = '', public $data = []) {}
    public function get_error_message() { return $this->message; }
    public function get_error_code() { return $this->code; }
}

// ثابت‌های مشترک — با پرونده‌های واقعی تطبیق داده می‌شوند (بند ۰).
class LMC_Order_Sync { const META_INVOICE = '_lmc_invoice_id'; const META_ATTEMPTS = '_lmc_attempts'; const META_ERROR = '_lmc_last_error'; const META_PAYLOAD = '_lmc_order_payload'; }
class LMC_Order_Reservation { const STATE = '_lmc_reservation_state'; const PAYLOAD = '_lmc_reservation_payload'; }
class LMC_Client { public static function get($path, $q) { $GLOBALS['feed_queries'][] = $q; return $GLOBALS['feed']; } }

/** کالای ووکامرس؛ `_stock` در `$GLOBALS['stock']`. ذخیره می‌تواند عمداً استثنا دهد. */
class Product
{
    public ?int $pending = null;
    public function __construct(private int $id) {}
    public function get_id() { return $this->id; }
    public function get_sku() { return 'SKU-' . $this->id; }
    public function get_manage_stock() { return true; }
    public function set_manage_stock($v) {}
    public function get_stock_quantity() { return $GLOBALS['stock'][$this->id]; }
    public function set_stock_quantity($v) { $this->pending = (int) $v; }
    public function get_backorders() { return 'no'; }
    public function set_backorders($v) {}
    public function get_stock_status() { return 'instock'; }
    public function set_stock_status($v) {}
    public function get_regular_price() { return '1'; }
    public function set_regular_price($v) {}
    public function save()
    {
        if (!empty($GLOBALS['fail_save'])) { throw new RuntimeException('ذخیرهٔ کالا شکست خورد (تزریق آزمون)'); }
        if ($this->pending !== null) { $GLOBALS['stock'][$this->id] = $this->pending; }
        return $this->id;
    }
}
class Item
{
    public array $meta = [];
    public function __construct(public int $id, public int $product = P, public int $qty = 1) {}
    public function get_id() { return $this->id; }
    public function get_product() { return new Product($this->product); }
    public function get_quantity() { return $this->qty; }
    public function get_meta($k, $single = true) { return $this->meta[$k] ?? ''; }
}
class Order
{
    public array $meta = []; public array $notes = []; public string $status = 'processing'; public int $created = 2000000000;
    public function get_date_created() { return new DateTime('@' . $this->created); }
    /** @param Item[] $items */
    public function __construct(public int $id, public array $items) {}
    public function get_id() { return $this->id; }
    public function get_items() { $o = []; foreach ($this->items as $i) { $o[$i->id] = $i; } return $o; }
    public function get_meta($k) { return $this->meta[$k] ?? ''; }
    public function has_status($s) { return in_array($this->status, (array) $s, true); }
    public function add_order_note($n) { $this->notes[] = $n; }
}
class Fake_Request { public function __construct(private array $p) {} public function get_json_params() { return $this->p; } }

/** `$wpdb` روی SQLite. قفل MySQL با آرایه تقلید می‌شود؛ شکست SQL با الگو تزریق می‌شود. */
class SqliteWpdb
{
    public string $prefix = 'wp_';
    public string $last_error = '';
    public PDO $pdo;
    public function __construct(string $file)
    {
        $this->pdo = new PDO('sqlite:' . $file);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_lmc_stock_hold (order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL, qty INTEGER NOT NULL, ack_rev INTEGER NULL, ack_wh TEXT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY (order_id, item_id))');
    }
    public function prepare($q, ...$a)
    {
        $i = 0;
        return preg_replace_callback('/%[sd]/', function ($m) use (&$i, $a) {
            $v = $a[$i++];
            return $m[0] === '%d' ? (string) (int) $v : $this->pdo->quote((string) $v);
        }, $q);
    }
    private function failing(string $q): bool
    {
        $re = $GLOBALS['fail_sql'] ?? null;
        if ($re !== null && preg_match($re, $q)) { $this->last_error = 'خطای تزریقی آزمون'; return true; }
        return false;
    }
    public function get_var($q)
    {
        if (preg_match("/GET_LOCK\\('([^']+)', (\\d+)\\)/", $q, $m)) {
            return ($GLOBALS['other_holds'][$m[1]] ?? false) === true ? '0' : '1';
        }
        if (preg_match("/^SHOW TABLES LIKE '([^']+)'/", $q, $m)) {
            $r = $this->pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name=" . $this->pdo->quote($m[1]))->fetchColumn();
            return $r === false ? null : (string) $r;
        }
        if ($this->failing($q)) { return null; }
        $row = $this->pdo->query($q)->fetch(PDO::FETCH_NUM);
        return $row === false || $row[0] === null ? null : (string) $row[0];
    }
    public function get_results($q, $o = null)
    {
        if ($this->failing($q)) { return null; }
        return $this->pdo->query($q)->fetchAll(PDO::FETCH_ASSOC);
    }
    public function query($q)
    {
        if (str_contains($q, 'RELEASE_LOCK')) { return 1; }
        if ($this->failing($q)) { return false; }
        try { return $this->pdo->exec($q); } catch (PDOException $e) { $this->last_error = $e->getMessage(); return false; }
    }
}

require __DIR__ . '/../labelmod-connector/includes/class-lmc-push-guard.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-stock-sync.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-stock-ledger.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-push-receiver.php';

$checks = 0; $failed = 0;
function check(string $label, $actual, $expected): void
{
    global $checks, $failed;
    if ($actual === $expected) { $checks++; return; }
    $failed++;
    fwrite(STDERR, "✗ $label: " . var_export($actual, true) . ' ≠ ' . var_export($expected, true) . "\n");
}

$db_file = tempnam(sys_get_temp_dir(), 'lmc-ledger-');
function fresh(): void
{
    global $db_file;
    @unlink($db_file);
    $GLOBALS['wpdb'] = new SqliteWpdb($db_file);
    $GLOBALS['stock'] = [P => 0];
    $GLOBALS['meta'] = [];
    $GLOBALS['orders'] = [];
    $GLOBALS['other_holds'] = [];
    $GLOBALS['fail_sql'] = null; $GLOBALS['fail_save'] = false; $GLOBALS['fail_meta'] = false;
    $GLOBALS['options'] = [LMC_Stock_Ledger::SCHEMA_OPTION => 1, LMC_Stock_Ledger::RECONCILE => ['page' => 1, 'done' => true]];
}
function stock(): int { return $GLOBALS['stock'][P]; }
function rev(): ?int { $s = LMC_Stock_Ledger::state(P); return $s ? $s['r'] : null; }

/** wc_reduce_stock_levels: `_stock` کم، بعد `_reduced_stock` و ذخیرهٔ قلم، بعد Hook. */
function woo_order(int $id, array $lines): Order
{
    $items = [];
    foreach ($lines as [$item_id, $qty]) { $items[] = new Item($item_id, P, $qty); }
    $order = $GLOBALS['orders'][$id] ?? new Order($id, $items);
    $GLOBALS['orders'][$id] = $order;
    foreach ($order->items as $item) {
        if ($item->get_meta('_reduced_stock') !== '') { continue; }
        $GLOBALS['stock'][P] -= $item->qty;
        $item->meta['_reduced_stock'] = $item->qty;
        LMC_Stock_Ledger::on_item_saved($item->id, $item, $id);
        LMC_Stock_Ledger::on_reduce($item, ['product' => $item->get_product(), 'from' => 0, 'to' => 0], $order);
    }
    return $order;
}
/** wc_increase_stock_levels (لغو). */
function woo_cancel(int $id): void
{
    $order = $GLOBALS['orders'][$id];
    $order->status = 'cancelled';
    foreach ($order->items as $item) {
        $r = (int) $item->get_meta('_reduced_stock');
        if ($r <= 0) { continue; }
        $GLOBALS['stock'][P] += $r;
        unset($item->meta['_reduced_stock']);
        LMC_Stock_Ledger::on_item_saved($item->id, $item, $id);
        LMC_Stock_Ledger::on_restore($item, 0, 0, $order);
    }
}
/** wc_restock_refunded_items: `_stock` زیاد، `_reduced_stock` کم، Hook استرداد. */
function woo_refund_restock(int $id, int $item_id, int $qty): void
{
    $order = $GLOBALS['orders'][$id];
    foreach ($order->items as $item) {
        if ($item->id !== $item_id) { continue; }
        $GLOBALS['stock'][P] += $qty;
        $item->meta['_reduced_stock'] = (int) $item->get_meta('_reduced_stock') - $qty;
        LMC_Stock_Ledger::on_item_saved($item->id, $item, $id);
    }
    LMC_Stock_Ledger::on_refund_restock(P, 0, 0, $order);
}
/** wc_maybe_adjust_line_item_product_stock (ویرایش دستی تعداد قلم در مدیریت). */
function woo_admin_adjust(int $id, int $item_id, int $new_qty): void
{
    $order = $GLOBALS['orders'][$id];
    foreach ($order->items as $item) {
        if ($item->id !== $item_id) { continue; }
        $GLOBALS['stock'][P] -= $new_qty - (int) $item->get_meta('_reduced_stock');
        $item->qty = $new_qty;
        $item->meta['_reduced_stock'] = $new_qty;
        LMC_Stock_Ledger::on_item_saved($item->id, $item, $id);
    }
}
function snap(int $avail, int $rev, bool $active = true, string $wh = WH): array
{
    return LMC_Stock_Ledger::apply_snapshot(P, $avail, $active, $rev, $wh, 0, true);
}
function push(array $payload)
{
    return LMC_Push_Receiver::handle_stock(new Fake_Request($payload + ['variationId' => VAR_ID]));
}
function wpush(int $avail, int $rev, int $version, bool $active = true)
{
    return push(['onHand' => $avail, 'version' => $version, 'stockRev' => (string) $rev, 'warehouseId' => WH, 'active' => $active]);
}
/** Pull واقعی: یک سطر خوراک، با مکان‌نما. */
function pull(array $item, string $cursor = 'C1'): array
{
    $GLOBALS['feed'] = ['items' => [$item + ['variationId' => VAR_ID, 'sku' => 'SKU-42']], 'cursor' => $cursor];
    return LMC_Stock_Sync::run();
}
function ack(int $order, ?int $rev, string $wh = WH): void
{
    LMC_Stock_Ledger::ack_order($GLOBALS['orders'][$order], $rev === null ? null : [['sku' => 'SKU-' . P, 'variationId' => VAR_ID, 'stockRev' => (string) $rev]], $wh);
}
function holds(): int { return (int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold'); }

// ── ۰. ثابت‌های مشترک با پرونده‌های واقعی ─────────────────────────────
$src = static fn ($f) => file_get_contents(__DIR__ . '/../labelmod-connector/includes/' . $f);
preg_match("/STOCK_VERSION_META = '([^']+)'/", $src('class-lmc-push-receiver.php'), $m);
check('۰. VERSION_META همان STOCK_VERSION_META گیرنده', LMC_Stock_Ledger::VERSION_META, $m[1] ?? null);
foreach (['META_INVOICE', 'META_ATTEMPTS', 'META_ERROR', 'META_PAYLOAD'] as $c) {
    preg_match("/const $c\\s*=\\s*'([^']+)'/", $src('class-lmc-order-sync.php'), $m);
    check("۰. ثابت $c با کلاس واقعی", constant("LMC_Order_Sync::$c"), $m[1] ?? null);
}
foreach (['STATE', 'PAYLOAD'] as $c) {
    preg_match("/const $c = '([^']+)'/", $src('class-lmc-order-reservation.php'), $m);
    check("۰. ثابت رزرو $c با کلاس واقعی", constant("LMC_Order_Reservation::$c"), $m[1] ?? null);
}

// ── R1. پاسخ بی stock اثبات نیست ─────────────────────────────────────
fresh();
snap(5, 70);
woo_order(4001, [[1, 1]]);
ack(4001, null);
check('R1. ACK بی stock واحد فروخته‌شده را برنمی‌گرداند', stock(), 4);
check('R1. علت در یادداشت سفارش', (bool) array_filter($GLOBALS['orders'][4001]->notes, static fn ($n) => str_contains($n, 'اثبات شمول')), true);
LMC_Stock_Ledger::ack_order($GLOBALS['orders'][4001], [['sku' => 'SKU-42', 'stockRev' => 'x']], WH);
check('R1. stockRev بدشکل هم اثبات نیست', stock(), 4);

// ── R2. چند قلم از یک کالا در یک سفارش ───────────────────────────────
fresh();
snap(10, 20);
woo_order(5001, [[11, 1], [12, 2]]);
check('R2. هر دو قلم کسر می‌شوند (۱۰−۳)', stock(), 7);
check('R2. دو سطر پایدار، بی عقب‌مانده', [holds(), get_option(LMC_Stock_Ledger::BACKLOG, [])], [2, []]);
LMC_Stock_Ledger::on_item_saved(11, $GLOBALS['orders'][5001]->items[0], 5001);
LMC_Stock_Ledger::sync_order_safe($GLOBALS['orders'][5001]);
check('R2. تکرار Hook/همگام‌سازی دوباره‌شماری نمی‌کند', stock(), 7);
snap(10, 21);
check('R2. عکس بعدی پیش از ACK هر دو قلم را نگه می‌دارد', [stock(), rev()], [7, 21]);

// ── R3. عکس بی واترمارک پس از ورود به پروتکل رد می‌شود ───────────────
fresh();
snap(5, 10);
woo_order(6001, [[21, 1]]);
$r = LMC_Stock_Ledger::apply_legacy(P, 5, 0);
check('R3. apply_legacy رد شد', $r['rejected'] ?? false, true);
check('R3. واحد برنگشت و واترمارک نماند پاک', [stock(), rev()], [4, 10]);
$e = push(['onHand' => 5, 'version' => 7000]);
check('R3. Push بی stockRev از گیرندهٔ واقعی: ۴۰۹', $e instanceof WP_Error ? $e->data['status'] : null, 409);
check('R3. نسخهٔ Push رد‌شده جلو نرفت', get_post_meta(P, LMC_Stock_Ledger::VERSION_META), '');
$e = push(['onHand' => 5, 'version' => 7001, 'stockRev' => '1x', 'warehouseId' => WH]);
check('R3. stockRev بدشکل: ۴۰۰', $e instanceof WP_Error ? $e->data['status'] : null, 400);
$GLOBALS['options'][LMC_Stock_Sync::CURSOR_OPTION] = 'C0';
$out = pull(['available' => '5']);
check('R3. Pull بی stockRev: نشانده نشد و دیده شد', [$out['busy'], stock()], [1, 4]);
check('R3. مکان‌نما جلو نرفت', get_option(LMC_Stock_Sync::CURSOR_OPTION), 'C0');
$out = pull(['available' => '5', 'stockRev' => 'abc']);
check('R3. Pull با stockRev بدشکل هم رد و مکان‌نما ثابت', [$out['busy'], get_option(LMC_Stock_Sync::CURSOR_OPTION)], [1, 'C0']);
// کنترل منفی: کالای بیرون از پروتکل همان رفتار پیشین را دارد (پیش از ارتقای Core).
fresh();
$GLOBALS['stock'][P] = 9;
check('R3. کنترل منفی: کالای بی‌حالت عکس بی واترمارک را می‌نشاند', [LMC_Stock_Ledger::apply_legacy(P, 6, 0)['applied'] ?? null, stock()], [true, 6]);

// ── R4. شکست ذخیره میان مراحل: هیچ کسری پیش از نشستن عکس حذف نمی‌شود ──
fresh();
snap(5, 10);
woo_order(7001, [[31, 1]]);
ack(7001, 11);
$GLOBALS['fail_save'] = true;
$r = snap(3, 12);
check('R4. شکست ذخیره دیده شد', isset($r['error']), true);
check('R4. حالت قبلی برگشت (واترمارک ۱۰)', rev(), 10);
check('R4. کسر سر جایش ماند', holds(), 1);
$GLOBALS['fail_save'] = false;
LMC_Stock_Ledger::recompute(P);
check('R4. بازمحاسبه پس از شکست واحد را برنمی‌گرداند', stock(), 4);
snap(3, 12);
check('R4. تکرار همان عکس پس از رفع: عدد تازهٔ Core', stock(), 3);
// Push: نسخه با شکست جلو نمی‌رود و تکرار همان نسخه اعمال می‌شود.
$GLOBALS['fail_save'] = true;
$e = wpush(2, 13, 900);
check('R4. Push ناموفق: ۵۰۰ و نسخه جلو نرفت', [$e instanceof WP_Error ? $e->data['status'] : null, get_post_meta(P, LMC_Stock_Ledger::VERSION_META)], [500, '']);
$GLOBALS['fail_save'] = false;
$r = wpush(2, 13, 900);
check('R4. تکرار همان Push اعمال شد', [$r['applied'] ?? null, stock(), get_post_meta(P, LMC_Stock_Ledger::VERSION_META)], [true, 2, '900']);
// مرگ پردازه پس از نوشتن حالت (d=1) و پیش از ذخیرهٔ کالا: بازیابی از حالت پایدار.
fresh();
snap(5, 10);
woo_order(7101, [[32, 1]]);
ack(7101, 11);
$GLOBALS['meta'][P][LMC_Stock_Ledger::STATE_META] = json_encode(['w' => WH, 'r' => 12, 'c' => 3, 'a' => true, 'd' => true]);
$GLOBALS['options'][LMC_Stock_Ledger::REDO] = [P => 1];
LMC_Stock_Ledger::maintain();
check('R4. بازیابی کالای «کثیف»: عدد عکس نشسته، بی برگشت واحد', [stock(), LMC_Stock_Ledger::state(P)['d']], [3, false]);

// ── R5. شکست ثبت کسر: بسته در شکست، بازیابی‌پذیر ─────────────────────
fresh();
snap(5, 10);
$GLOBALS['fail_sql'] = '/^INSERT INTO wp_lmc_stock_hold/';
woo_order(8001, [[41, 1]]);
check('R5. کسر ثبت‌نشده: کسر خودِ ووکامرس می‌ماند', stock(), 4);
check('R5. سفارش در عقب‌مانده', array_keys(get_option(LMC_Stock_Ledger::BACKLOG, [])), [8001]);
$r = snap(5, 11);
check('R5. تا ثبت کسر، عکس نشانده نمی‌شود', [$r['blocked'] ?? false, stock()], [true, 4]);
$e = wpush(5, 11, 950);
check('R5. Push هم ۵۰۳ (صف دوباره می‌فرستد)', $e instanceof WP_Error ? $e->data['status'] : null, 503);
$GLOBALS['fail_sql'] = null;
snap(5, 11);
check('R5. پس از رفع: عقب‌مانده ثبت و عدد درست', [stock(), get_option(LMC_Stock_Ledger::BACKLOG, [])], [4, []]);
// خطای خواندن دفتر هنگام نشاندن: عدد نوشته نمی‌شود.
$GLOBALS['fail_sql'] = '/SUM\(qty\)/';
$r = snap(9, 12);
check('R5. خطای خواندن جمع کسر: نشانده نشد', [isset($r['error']), stock(), rev()], [true, 4, 11]);
$GLOBALS['fail_sql'] = null;
// اسکیما فقط با جدول واقعی ثبت می‌شود.
fresh();
$GLOBALS['options'] = [];
$GLOBALS['wpdb']->pdo->exec('DROP TABLE wp_lmc_stock_hold');
LMC_Stock_Ledger::install();
check('R5. بی جدول نسخهٔ اسکیما ثبت نمی‌شود', get_option(LMC_Stock_Ledger::SCHEMA_OPTION, 0), 0);
check('R5. و نشاندن بسته است', snap(5, 1)['blocked'] ?? false, true);

// ── ۶. Pull کهنه پس از Push تازه؛ Push کهنه پس از ACK ──────────────────
fresh();
pull(['available' => '3', 'stockRev' => '10']);
check('۶. Pull کالا را وارد پروتکل کرد', rev(), 10);
wpush(3, 12, 500);
$out = pull(['available' => '5', 'stockRev' => '11'], 'C2');
check('۶. Pull کهنه‌تر از Push نشانده نشد؛ مکان‌نما جلو رفت (رد قدیمی، نه شکست)', [stock(), get_option(LMC_Stock_Sync::CURSOR_OPTION)], [3, 'C2']);
woo_order(9001, [[51, 1]]);
ack(9001, 13);
wpush(2, 13, 501);
check('۶. Push شامل سفارش', stock(), 2);
check('۶. Push معوقِ پیش از ACK رد شد', [is_array(wpush(3, 12, 499)) ? (wpush(3, 12, 499)['stale'] ?? null) : null, stock()], [true, 2]);
// کنترل منفی (مسیر پیشین Pull: نشاندن بی واترمارک و بی کسر).
$p = new Product(P); LMC_Stock_Sync::apply_stock($p, 3); $p->save();
check('۶. کنترل منفی: مسیر پیشین عدد کهنه را می‌نشاند', stock(), 3);

// ── ۷. عکس معوقِ پیش از ACK، ترتیب معکوس ACK و Push ───────────────────
fresh();
snap(5, 10);
woo_order(9101, [[61, 1]]);
ack(9101, 12);
snap(5, 11);
check('۷. عکس پیش از ACK کسر را نگه می‌دارد (۵−۱)', stock(), 4);
fresh();
snap(5, 10);
woo_order(9102, [[62, 1]]);
snap(4, 12);
check('۷. عکس شامل، پیش از ACK: موقتاً محافظه‌کار', stock(), 3);
ack(9102, 12);
check('۷. ACK بازمحاسبه می‌کند؛ دوبار کم نمی‌شود', stock(), 4);
ack(9102, 15);
check('۷. تکرار ACK بی‌اثر', stock(), 4);

// ── ۸. دو سفارش، لغو پیش و پس از ACK، حذف سفارش ───────────────────────
fresh();
snap(10, 20);
woo_order(1001, [[71, 1]]);
woo_order(1002, [[72, 2]]);
woo_cancel(1002);
check('۸. لغو پیش از ACK: فقط کسر خودش برمی‌گردد', stock(), 9);
ack(1001, 21);
snap(9, 21);
woo_order(1003, [[73, 2]]);
ack(1003, 22);
snap(7, 22);
woo_cancel(1003);
check('۸. لغو پس از ACK تا آزادسازی Core بیش از واقع نشان نمی‌دهد', stock(), 7);
snap(9, 23);
check('۸. پس از آزادسازی Core', stock(), 9);
woo_order(1004, [[74, 1]]);
LMC_Stock_Ledger::on_order_deleted(1004);
check('۸. حذف سفارش کسرش را برمی‌دارد', stock(), 9);

// ── ۹. استرداد با بازگشت به انبار و ویرایش دستی قلم ───────────────────
fresh();
snap(10, 30);
woo_order(1101, [[81, 3]]);
woo_refund_restock(1101, 81, 1);
check('۹. استرداد تأییدنشده: کسر از ۳ به ۲', stock(), 8);
ack(1101, 31);
snap(8, 31);
woo_refund_restock(1101, 81, 1);
check('۹. استرداد پس از ACK: تا ثبت برگشتی در Core بیش از واقع نشان نمی‌دهد', stock(), 8);
fresh();
snap(10, 40);
woo_order(1201, [[91, 1]]);
ack(1201, 41);
snap(9, 41);
woo_admin_adjust(1201, 91, 3);
check('۹. افزایش دستی قلم تأییدشده: کل قلم دوباره کسر (محافظه‌کار)', stock(), 6);
woo_admin_adjust(1201, 91, 2);
check('۹. کاهش دستی قلم', stock(), 7);

// سفارش تأییدشده پیش از نصب دفتر که بعداً استرداد می‌گیرد: شامل همهٔ عکس‌هاست، نه کسر تازه.
fresh();
$GLOBALS['options'][LMC_Stock_Ledger::SINCE] = 1500000000;
snap(10, 45);
$old = new Order(1250, [new Item(97, P, 3)]);
$old->items[0]->meta['_reduced_stock'] = 3; $old->meta['_lmc_invoice_id'] = 'inv'; $old->created = 1400000000; $old->status = 'completed';
$GLOBALS['orders'][1250] = $old;
woo_refund_restock(1250, 97, 1);
check('۹. استرداد سفارش تأییدشدهٔ پیش از دفتر: دوبار کم نمی‌شود', stock(), 10);
$new = new Order(1251, [new Item(98, P, 2)]);
$new->items[0]->meta['_reduced_stock'] = 2; $new->meta['_lmc_invoice_id'] = 'inv2'; $new->created = 1600000000;
$GLOBALS['orders'][1251] = $new;
LMC_Stock_Ledger::sync_order_safe($new);
check('۹. کنترل منفی: همان وضعیت پس از نصب دفتر استنتاج نمی‌شود (محافظه‌کار)', stock(), 8);

// ── ۱۰. انبار ACK، وضعیت غیرفعال، قفل مشترک، Push برای کالای بی‌حالت ───
fresh();
snap(5, 50);
woo_order(1301, [[95, 1]]);
ack(1301, 51, WH2);
snap(5, 52);
check('۱۰. ACK انبار دیگر اثبات این انبار نیست', stock(), 4);
snap(5, 53, false);
check('۱۰. تنوع غیرفعال صفر', stock(), 0);
snap(5, 54, true);
check('۱۰. فعال‌شدن دوباره با واترمارک تازه', stock(), 4);
$GLOBALS['other_holds'][LMC_Stock_Ledger::lock_name(P)] = true;
$GLOBALS['options'][LMC_Stock_Sync::CURSOR_OPTION] = 'C9';
$out = pull(['available' => '1', 'stockRev' => '60'], 'C10');
check('۱۰. قفل در دست Push: Pull ننوشت و مکان‌نما ثابت ماند', [$out['busy'], stock(), get_option(LMC_Stock_Sync::CURSOR_OPTION)], [1, 4, 'C9']);
check('۱۰. Push هم ۵۰۳', (wpush(1, 61, 980) instanceof WP_Error), true);
$GLOBALS['other_holds'] = [];
check('۱۰. Push و Pull یک نام قفل دارند', LMC_Stock_Ledger::lock_name(P), LMC_Push_Guard::lock_name(P, '_lmc_stock_version'));
fresh();
$GLOBALS['stock'][P] = 7;
$r = wpush(4, 5, 10);
check('۱۰. Push کالای بیرون از پروتکل را وارد نمی‌کند (رفتار پیشین)', [$r['legacy'] ?? null, stock(), rev()], [true, 4, null]);

// ── ۱۱. بازراه‌اندازی: کسر پایدار است، بی TTL ───────────────────────────
fresh();
snap(5, 70);
woo_order(1401, [[96, 2]]);
$GLOBALS['wpdb'] = new SqliteWpdb($db_file);
snap(5, 71);
check('۱۱. پس از بازراه‌اندازی کسر هنوز کم می‌شود', stock(), 3);

// ── ۱۲. آشتی اولیه با نقطهٔ بازگشت ────────────────────────────────────
fresh();
$GLOBALS['options'][LMC_Stock_Ledger::RECONCILE] = ['page' => 1, 'done' => false];
$mk = static function (int $id, string $status, array $meta) {
    $o = new Order($id, [new Item($id * 10, P, 1)]);
    $o->items[0]->meta['_reduced_stock'] = 1;
    $o->status = $status; $o->meta = $meta;
    $GLOBALS['orders'][$id] = $o;
};
$mk(1, 'processing', []);                                         // فعال، تأییدنشده
$mk(2, 'processing', ['_lmc_invoice_id' => 'inv']);                // تأییدشده
$mk(3, 'completed', ['_lmc_last_error' => 'x']);                   // تکمیل‌شدهٔ همگام‌نشده
$mk(4, 'completed', []);                                          // تاریخچهٔ پیش از اتصال
$mk(5, 'on-hold', ['_lmc_reservation_state' => 'reserved']);       // رزروشده
check('۱۲. تا آشتی کامل نشده نشاندن بسته است (صفحهٔ اول)', LMC_Stock_Ledger::reconcile_step(1), false);
check('۱۲. صفحهٔ بعد خالی: کامل', LMC_Stock_Ledger::reconcile_step(1), true);
$ids = array_map('intval', array_column($GLOBALS['wpdb']->get_results('SELECT order_id FROM wp_lmc_stock_hold ORDER BY order_id'), 'order_id'));
check('۱۲. فقط فعال تأییدنشده و تکمیل‌شدهٔ همگام‌نشده کسر گرفتند', $ids, [1, 3]);

// ── ۱۳. جهش‌ها: آزمون حساس است (کنترل منفی کلاس) ─────────────────────
// (اجرا در بیرون: sed روی شرط pending/واترمارک/کسر؛ ر.ک. PR.) این بند فقط شمارنده را چاپ می‌کند.

@unlink($db_file);
if ($failed > 0) { fwrite(STDERR, "✗ $failed ادعا شکست خورد ($checks پاس)\n"); exit(1); }
echo "✓ همه $checks ادعای دفتر کسر و واترمارک مشترک پاس شدند\n";
