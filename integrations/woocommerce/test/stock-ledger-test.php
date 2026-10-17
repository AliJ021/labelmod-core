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
 *    `_stock` و دورهٔ واترمارک در جدول‌های SQLite (`wp_postmeta`، `wp_options`) می‌نشینند تا SQL
 *    خودِ دفتر رویشان اجرا شود. تراکنش در SQLite بی‌اثر است (یک اتصال)؛ قفل سطری InnoDB با
 *    زمان‌بند مدل می‌شود: گام `_stock` ووکامرس که درون بازهٔ قفل بیفتد تا پس از Commit صبر
 *    می‌کند. خودِ قفل در `test/real-wc` با پردازه‌های واقعی سنجیده می‌شود.
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
// مسیر مدیریت «رها کردن کسر»: نقش، Nonce و تغییر مسیر.
class Lmc_Test_Exit extends RuntimeException {}
function current_user_can($cap) { return ($GLOBALS['can'] ?? false) && $cap === 'manage_woocommerce'; }
function check_admin_referer($a) { if (($GLOBALS['nonce'] ?? '') !== $a) { throw new Lmc_Test_Exit('nonce'); } return 1; }
function wp_die($m = '') { throw new Lmc_Test_Exit('die: ' . $m); }
function wp_safe_redirect($u) { $GLOBALS['redirect'] = $u; throw new Lmc_Test_Exit('redirect'); }
function add_query_arg($a, $u) { return $u . '?' . http_build_query($a); }
function admin_url($p = '') { return 'https://shop.test/wp-admin/' . $p; }
function esc_html($t) { return htmlspecialchars((string) $t, ENT_QUOTES); }
function sanitize_text_field($t) { return trim(strip_tags((string) $t)); }
function wp_unslash($v) { return $v; }
function wp_get_current_user() { return (object) ['user_login' => 'manager']; }
function add_filter(...$a): void {}
function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['options']) ? $GLOBALS['options'][$k] : $d; }
/** مثل وردپرس: گزینه در جدول هم نوشته می‌شود (دفتر دوره را با SQL از همان‌جا می‌خواند). */
function update_option($k, $v, $a = null)
{
    $GLOBALS['options'][$k] = $v;
    $pdo = $GLOBALS['wpdb']->pdo;
    $pdo->prepare('INSERT OR REPLACE INTO wp_options (option_name, option_value) VALUES (?, ?)')->execute([$k, is_scalar($v) ? (string) $v : serialize($v)]);
    return true;
}
function delete_option($k) { unset($GLOBALS['options'][$k]); $GLOBALS['wpdb']->pdo->prepare('DELETE FROM wp_options WHERE option_name = ?')->execute([$k]); return true; }
function dbDelta($sql) { return []; }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_cache_delete($id, $group = '') { return true; }
/** `_stock` در جدول `wp_postmeta` SQLite؛ null یعنی سطری نیست. */
function stock_of(int $id): ?int
{
    $v = $GLOBALS['wpdb']->pdo->query("SELECT meta_value FROM wp_postmeta WHERE post_id = {$id} AND meta_key = '_stock'")->fetchColumn();
    return $v === false ? null : (int) $v;
}
/** همان UPDATE اتمیک ووکامرس: `meta_value = meta_value ± n`. */
function stock_add(int $id, int $n): void
{
    $GLOBALS['wpdb']->pdo->exec("UPDATE wp_postmeta SET meta_value = meta_value + ({$n}) WHERE post_id = {$id} AND meta_key = '_stock'");
}
function stock_set(int $id, int $v): void
{
    $pdo = $GLOBALS['wpdb']->pdo;
    if (stock_of($id) === null) { $pdo->exec("INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES ({$id}, '_stock', '{$v}')"); }
    else { $pdo->exec("UPDATE wp_postmeta SET meta_value = '{$v}' WHERE post_id = {$id} AND meta_key = '_stock'"); }
}
function get_post_meta($id, $k, $s = false)
{
    if ($k === '_stock') { $v = stock_of((int) $id); return $v === null ? '' : (string) $v; }
    $st = $GLOBALS['wpdb']->pdo->prepare('SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = ? LIMIT 1');
    $st->execute([(int) $id, $k]);
    $v = $st->fetchColumn();
    return $v === false ? '' : (string) $v;
}
function add_post_meta($id, $k, $v, $unique = false)
{
    if ($k === '_stock') { if (stock_of((int) $id) === null) { stock_set((int) $id, (int) $v); } return true; }
    if ($unique && get_post_meta($id, $k) !== '') { return false; }
    return update_post_meta($id, $k, $v);
}
/** WC 11.1.1 `wc_update_product_stock`: `meta_value ± n` اتمیک در دیتابیس. */
function wc_update_product_stock($product, $qty, $op = 'set')
{
    if (!empty($GLOBALS['fail_save'])) { throw new RuntimeException('تغییر موجودی ووکامرس شکست خورد (تزریق آزمون)'); }
    $id = $product->get_id();
    stock_add($id, $op === 'increase' ? (int) $qty : -(int) $qty);
    return stock_of($id);
}
/** نقطه‌های probe دفتر: «درخواست دیگری» یک بار درست در همان مرحله اجرا می‌شود. */
function do_action($hook, ...$a)
{
    if ($hook !== 'lmc_stock_probe') { return; }
    $stage = $a[0];
    if (!empty($GLOBALS['probe'][$stage])) { $f = $GLOBALS['probe'][$stage]; unset($GLOBALS['probe'][$stage]); $f(); }
}
/** متا در جدول `wp_postmeta` (مثل وردپرس)؛ دفتر بخشی از آن را با SQL درون تراکنش می‌نویسد. */
function update_post_meta($id, $k, $v)
{
    if (!empty($GLOBALS['fail_meta'])) { return false; }
    $pdo = $GLOBALS['wpdb']->pdo; $v = is_string($v) ? $v : (string) $v;
    $up = $pdo->prepare('UPDATE wp_postmeta SET meta_value = ? WHERE post_id = ? AND meta_key = ?'); $up->execute([$v, (int) $id, $k]);
    if ($up->rowCount() === 0 && get_post_meta($id, $k) === '') {
        $pdo->prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)')->execute([(int) $id, $k, $v]);
    }
    return true;
}
function delete_post_meta($id, $k) { $GLOBALS['wpdb']->pdo->prepare('DELETE FROM wp_postmeta WHERE post_id = ? AND meta_key = ?')->execute([(int) $id, $k]); return true; }
function delete_post_meta_by_key($k) { $GLOBALS['wpdb']->pdo->prepare('DELETE FROM wp_postmeta WHERE meta_key = ?')->execute([$k]); return true; }
function get_posts($args) { return ($args['meta_value'] ?? '') === VAR_ID ? [P] : []; }
function wc_get_product($id) { return stock_of((int) $id) !== null ? new Product((int) $id) : false; }
function wc_get_order($id)
{
    // نقطهٔ درج interleaving قطعی: یک «درخواست دیگر» درست وسط کار ما اجرا می‌شود.
    if (!empty($GLOBALS['on_get_order'])) { $f = $GLOBALS['on_get_order']; $GLOBALS['on_get_order'] = null; $f(); }
    return $GLOBALS['orders'][(int) $id] ?? false;
}
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

/** کالای ووکامرس؛ `_stock` در `wp_postmeta`. ذخیره می‌تواند عمداً استثنا دهد. */
class Product
{
    public ?int $pending = null;
    public function __construct(private int $id) {}
    public function get_id() { return $this->id; }
    public function get_sku() { return 'SKU-' . $this->id; }
    public function get_manage_stock() { return true; }
    public function set_manage_stock($v) {}
    public function get_stock_quantity() { return stock_of($this->id); }
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
        // interleaving: «درخواست دیگری» درست پیش از نوشتن ما اجرا می‌شود (یک بار).
        if ($this->pending !== null) { stock_set($this->id, $this->pending); }
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
    public int $order = 0;
    public function get_order_id() { return $this->order; }
}
class Order
{
    public array $meta = []; public array $notes = []; public string $status = 'processing'; public int $created = 2000000000;
    public function get_date_created() { return new DateTime('@' . $this->created); }
    /** @param Item[] $items */
    public function __construct(public int $id, public array $items) { foreach ($items as $i) { $i->order = $id; } }
    public function get_id() { return $this->id; }
    /** @var ?callable نقطهٔ درج interleaving: «درخواست دیگری» درست هنگام خواندن اقلام. */
    public $on_items = null;
    public function get_items() { if ($this->on_items) { $f = $this->on_items; $this->on_items = null; $f(); } $o = []; foreach ($this->items as $i) { $o[$i->id] = $i; } return $o; }
    public function get_meta($k) { return $this->meta[$k] ?? ''; }
    public function has_status($s) { return in_array($this->status, (array) $s, true); }
    public function add_order_note($n) { $this->notes[] = $n; }
    public bool $stock_reduced = false;
    public function get_data_store() { $o = $this; return new class($o) { public function __construct(private $o) {} public function get_stock_reduced($id) { return $this->o->stock_reduced; } }; }
}
class Fake_Request { public function __construct(private array $p) {} public function get_json_params() { return $this->p; } }

/** `$wpdb` روی SQLite. قفل MySQL با آرایه تقلید می‌شود؛ شکست SQL با الگو تزریق می‌شود. */
class SqliteWpdb
{
    public string $prefix = 'wp_';
    public string $postmeta = 'wp_postmeta';
    public string $options = 'wp_options';
    public string $last_error = '';
    public PDO $pdo;
    public function __construct(string $file)
    {
        $this->pdo = new PDO('sqlite:' . $file);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_lmc_stock_hold (order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL, qty INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 1, ack_rev INTEGER NULL, ack_wh TEXT NULL,
            ack_epoch INTEGER NULL, ack_at INTEGER NULL, release_after INTEGER NULL, release_epoch INTEGER NULL, created_at INTEGER NOT NULL, PRIMARY KEY (order_id, item_id))');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_lmc_stock_mark (kind TEXT NOT NULL, ref INTEGER NOT NULL, token TEXT NOT NULL,
            at INTEGER NOT NULL, PRIMARY KEY (kind, ref, token))');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_postmeta (meta_id INTEGER PRIMARY KEY, post_id INTEGER, meta_key TEXT, meta_value TEXT)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_options (option_name TEXT PRIMARY KEY, option_value TEXT, autoload TEXT)');
        // جدول‌های اقلام سفارش ووکامرس (با HPOS هم همین‌ها) — فقط برای بازسازی خوانده می‌شوند.
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_woocommerce_order_items (order_item_id INTEGER PRIMARY KEY, order_id INTEGER, order_item_type TEXT)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_woocommerce_order_itemmeta (order_item_id INTEGER, meta_key TEXT, meta_value TEXT)');
    }
    public function suppress_errors($v = true) { return false; }
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
        $this->last_error = '';                                              // مثل wpdb: هر پرسش از نو
        if (str_ends_with(rtrim($q), 'LOCK IN SHARE MODE')) { $GLOBALS['tx'][] = 'epoch-lock'; $q = substr(rtrim($q), 0, -18); }
        if (preg_match("/GET_LOCK\\('([^']+)', (\\d+)\\)/", $q, $m)) {
            return ($GLOBALS['other_holds'][$m[1]] ?? false) === true ? '0' : '1';
        }
        if (str_contains($q, 'information_schema.TABLES')) { return $GLOBALS['engine'] ?? 'InnoDB'; }
        // MariaDB `@@in_transaction`؛ null یعنی MySQL (متغیر نیست).
        if ($q === 'SELECT @@in_transaction') { return array_key_exists('in_tx', $GLOBALS) ? $GLOBALS['in_tx'] : '0'; }
        if ($q === 'SELECT @@autocommit') { return $GLOBALS['autocommit'] ?? '1'; }
        if ($q === 'SELECT @@transaction_read_only') { return '0'; }
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
        $this->last_error = '';
        if ($this->failing($q)) { return null; }
        if (str_ends_with(rtrim($q), 'FOR UPDATE')) { $GLOBALS['tx'][] = 'lock'; $q = substr(rtrim($q), 0, -10); }
        if (str_ends_with(rtrim($q), 'LOCK IN SHARE MODE')) { $GLOBALS['tx'][] = 'epoch-lock'; $q = substr(rtrim($q), 0, -18); }
        return $this->pdo->query($q)->fetchAll(PDO::FETCH_ASSOC);
    }
    public function query($q)
    {
        $this->last_error = '';
        if (str_contains($q, 'RELEASE_LOCK')) { return 1; }
        // MySQL Oracle `@@in_transaction` ندارد؛ `SET TRANSACTION` درون تراکنش در جریان خطای ۱۵۶۸ می‌دهد.
        if (str_starts_with($q, 'SET TRANSACTION ')) {
            $GLOBALS['set_tx_sql'][] = $q;
            $m = $GLOBALS['set_tx'] ?? 'ok';
            if ($m === 'in') { $this->last_error = "ERROR 1568 (25001): Transaction characteristics can't be changed while a transaction is in progress"; return false; }
            if ($m === 'err') { $this->last_error = 'خطای دیگر'; return false; }
            return 0;
        }
        if (in_array($q, ['START TRANSACTION', 'COMMIT', 'ROLLBACK'], true)) {
            // یک اتصال SQLite: تراکنش بی‌اثر است و فقط ترتیبش ثبت می‌شود (قفل سطری در real-wc).
            if ($this->failing($q)) { return false; }
            $GLOBALS['tx'][] = $q; return 1;
        }
        if ($this->failing($q)) { return false; }
        if (str_starts_with($q, 'UPDATE wp_postmeta')) { $GLOBALS['tx'][] = 'write'; }
        if (str_starts_with($q, 'INSERT IGNORE ')) { $q = 'INSERT OR IGNORE ' . substr($q, 14); }
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
    stock_set(P, 0);
    $GLOBALS['tx'] = [];
    $GLOBALS['engine'] = 'InnoDB';
    // سطر دوره را نصب می‌سازد (ensure_epoch_row)؛ نویسنده قفل اشتراکی آن را می‌گیرد.
    $GLOBALS['wpdb']->pdo->exec("INSERT INTO wp_options (option_name, option_value) VALUES ('" . LMC_Stock_Ledger::EPOCH . "', '1')");
    $GLOBALS['in_tx'] = '0';
    $GLOBALS['set_tx'] = 'ok';
    $GLOBALS['autocommit'] = '1';
    $GLOBALS['set_tx_sql'] = [];
    $GLOBALS['meta'] = [];
    $GLOBALS['orders'] = [];
    $GLOBALS['other_holds'] = [];
    $GLOBALS['fail_sql'] = null; $GLOBALS['fail_save'] = false; $GLOBALS['fail_meta'] = false;
    $GLOBALS['options'] = [LMC_Stock_Ledger::SCHEMA_OPTION => 1, LMC_Stock_Ledger::RECONCILE => ['page' => 1, 'done' => true]];
    $GLOBALS['on_get_order'] = null;
    $GLOBALS['probe'] = [];
    $GLOBALS['fake_time_shift'] = 0;
    LMC_Stock_Ledger::new_request();
}
function marks(string $kind): int { return (int) $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM wp_lmc_stock_mark WHERE kind = '{$kind}'"); }
/** سفارش‌های متمایز در عقب‌مانده (هر شکست سطر خودش را دارد). */
function backlog_orders(): array { return array_map('intval', array_column($GLOBALS['wpdb']->get_results("SELECT DISTINCT ref FROM wp_lmc_stock_mark WHERE kind = 'order' ORDER BY ref"), 'ref')); }
/** دو پردازه با وضعیت درخواستِ جدا: وضعیت ایستای دفتر ذخیره و جابه‌جا می‌شود. */
function as_request(string $name, callable $f)
{
    static $saved = [];
    $red = new ReflectionProperty(LMC_Stock_Ledger::class, 'reducing');
    $prev = $red->getValue();
    $red->setValue(null, $saved[$name] ?? []);
    try { return $f(); } finally {
        $saved[$name] = $red->getValue();
        $red->setValue(null, $prev);
    }
}
/** مرگ پردازه (kill -9): وضعیت درخواستش دور ریخته می‌شود و هیچ گام بعدی‌اش اجرا نمی‌شود. */
function crash(string $name): void
{
    as_request($name, static function () { (new ReflectionProperty(LMC_Stock_Ledger::class, 'reducing'))->setValue(null, []); });
}
function stock(): int { return stock_of(P); }
function rev(): ?int { $s = LMC_Stock_Ledger::state(P); return $s ? $s['r'] : null; }

/** wc_reduce_stock_levels: `_stock` کم، بعد `_reduced_stock` و ذخیرهٔ قلم، بعد Hook. */
function woo_order(int $id, array $lines): Order
{
    $items = [];
    foreach ($lines as [$item_id, $qty]) { $items[] = new Item($item_id, P, $qty); }
    $order = $GLOBALS['orders'][$id] ?? new Order($id, $items);
    $GLOBALS['orders'][$id] = $order;
    as_request('woo-' . $id, static function () use ($order, $id) {
        woo_reduce_begin($order);
        foreach ($order->items as $item) { woo_reduce_item($order, $item); }
        woo_reduce_end($order);
    });
    return $order;
}
/** گام‌های جدای wc_reduce_stock_levels (WC 11.1.1) برای interleaving. */
function woo_reduce_begin(Order $order): void { LMC_Stock_Ledger::on_can_reduce(true, $order); }
function woo_reduce_item(Order $order, Item $item, bool $stop_after_decrement = false): void
{
    if ($item->get_meta('_reduced_stock') !== '') { return; }
    LMC_Stock_Ledger::on_item_quantity($item->qty, $order, $item);           // پیش از کسر
    stock_add(P, -$item->qty);                                               // UPDATE اتمیک _stock
    if ($stop_after_decrement) { return; }
    woo_reduce_item_finish($order, $item);
}
function woo_reduce_item_finish(Order $order, Item $item): void
{
    $item->meta['_reduced_stock'] = $item->qty;                              // add_meta_data + save
    LMC_Stock_Ledger::on_item_saved($item->id, $item, $order->id);
    LMC_Stock_Ledger::on_reduce($item, ['product' => $item->get_product(), 'from' => 0, 'to' => 0], $order);
}
function woo_reduce_end(Order $order): void
{
    LMC_Stock_Ledger::on_reduce_done($order);
    $order->stock_reduced = true;                                            // set_stock_reduced پس از حلقه
}
/** wc_increase_stock_levels (لغو). */
function woo_cancel(int $id): void
{
    $order = $GLOBALS['orders'][$id];
    $order->status = 'cancelled';
    foreach ($order->items as $item) {
        $r = (int) $item->get_meta('_reduced_stock');
        if ($r <= 0) { continue; }
        stock_add(P, $r);
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
        stock_add(P, $qty);
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
        $item->qty = $new_qty;
        LMC_Stock_Ledger::on_prevent_adjust(false, $item, $new_qty);           // WC 11.1.1: پیش از تغییر _stock
        stock_add(P, -($new_qty - (int) $item->get_meta('_reduced_stock')));
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
/** ACK با تعداد ارسالیِ هر قلم؛ پیش‌فرض: همان `_reduced_stock` فعلی (درخواستی که همین حالا ساخته شد). */
function ack(int $order, ?int $rev, string $wh = WH, ?array $sent = null, ?int $epoch = null): void
{
    $o = $GLOBALS['orders'][$order];
    if ($sent === null) { $sent = []; foreach ($o->items as $i) { $sent[$i->id] = (int) $i->get_meta('_reduced_stock'); } }
    LMC_Stock_Ledger::ack_order($o, $rev === null ? null : [['sku' => 'SKU-' . P, 'variationId' => VAR_ID, 'stockRev' => (string) $rev]], $wh, $sent, $epoch ?? LMC_Stock_Ledger::epoch());
}
function holds(): int { return (int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold'); }
function holds_unacked(): int { return (int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold WHERE ack_rev IS NULL'); }

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
LMC_Stock_Ledger::ack_order($GLOBALS['orders'][4001], [['sku' => 'SKU-42', 'stockRev' => 'x']], WH, [1 => 1], LMC_Stock_Ledger::epoch());
check('R1. stockRev بدشکل هم اثبات نیست', stock(), 4);

// ── R2. چند قلم از یک کالا در یک سفارش ───────────────────────────────
fresh();
snap(10, 20);
woo_order(5001, [[11, 1], [12, 2]]);
check('R2. هر دو قلم کسر می‌شوند (۱۰−۳)', stock(), 7);
check('R2. دو سطر پایدار، بی عقب‌مانده', [holds(), marks('order')], [2, 0]);
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
stock_set(P, 9);
check('R3. کنترل منفی: کالای بی‌حالت عکس بی واترمارک را می‌نشاند', [LMC_Stock_Ledger::apply_legacy(P, 6, 0)['applied'] ?? null, stock()], [true, 6]);

// ── R4. شکست ذخیره میان مراحل: هیچ کسری پیش از نشستن عکس حذف نمی‌شود ──
fresh();
snap(5, 10);
woo_order(7001, [[31, 1]]);
ack(7001, 11);
$GLOBALS['fail_sql'] = '/^UPDATE wp_postmeta/';                             // نوشتن `_stock` شکست خورد
$r = snap(3, 12);
check('R4. شکست ذخیره دیده شد', isset($r['error']), true);
check('R4. حالت قبلی برگشت (واترمارک ۱۰)', rev(), 10);
check('R4. کسر سر جایش ماند', holds(), 1);
$GLOBALS['fail_sql'] = null;
check('R4. Rollback: تراکنش بی Commit بسته شد', array_slice($GLOBALS['tx'], -1), ['ROLLBACK']);
LMC_Stock_Ledger::recompute(P);
check('R4. بازمحاسبه پس از شکست واحد را برنمی‌گرداند', stock(), 4);
snap(3, 12);
check('R4. تکرار همان عکس پس از رفع: عدد تازهٔ Core', stock(), 3);
// Push: نسخه با شکست جلو نمی‌رود و تکرار همان نسخه اعمال می‌شود.
$GLOBALS['fail_sql'] = '/^UPDATE wp_postmeta/';
$e = wpush(2, 13, 900);
check('R4. Push ناموفق: ۵۰۰ و نسخه جلو نرفت', [$e instanceof WP_Error ? $e->data['status'] : null, get_post_meta(P, LMC_Stock_Ledger::VERSION_META)], [500, '']);
$GLOBALS['fail_sql'] = null;
$r = wpush(2, 13, 900);
check('R4. تکرار همان Push اعمال شد (نسخه با دوره برچسب خورد)', [$r['applied'] ?? null, stock(), get_post_meta(P, LMC_Stock_Ledger::VERSION_META)], [true, 2, '1:900']);
// شکست تازه‌سازی وضعیت ووکامرس **پس از** Commit عدد نشسته را بی‌پشتوانه نمی‌کند: حالت می‌ماند و «دوباره».
$GLOBALS['fail_save'] = true;
$r = wpush(1, 14, 901);
$GLOBALS['fail_save'] = false;
check('R4. شکست پس از Commit: عدد و حالت تازه می‌مانند و «دوباره» گذاشته شد', [$r['applied'] ?? null, stock(), rev(), marks('redo')], [true, 1, 14, 1]);
// مرگ پردازه پس از نوشتن حالت (d=1) و پیش از ذخیرهٔ کالا: بازیابی از حالت پایدار.
fresh();
snap(5, 10);
woo_order(7101, [[32, 1]]);
ack(7101, 11);
update_post_meta(P, LMC_Stock_Ledger::STATE_META, json_encode(['w' => WH, 'r' => 12, 'c' => 3, 'a' => true, 'd' => true]));
LMC_Stock_Ledger::mark('redo', P);
LMC_Stock_Ledger::maintain();
check('R4. بازیابی کالای «کثیف»: عدد عکس نشسته، بی برگشت واحد', [stock(), LMC_Stock_Ledger::state(P)['d']], [3, false]);

// ── R5. شکست ثبت کسر: بسته در شکست، بازیابی‌پذیر ─────────────────────
// (الف) تأیید قلم (`_reduced_stock` → سطر) شکست می‌خورد: سفارش در عقب‌ماندهٔ پایدار.
fresh();
snap(5, 10);
$GLOBALS['fail_sql'] = '/^UPDATE wp_lmc_stock_hold SET product_id = \d+, qty = \d+, confirmed = 1/';
woo_order(8001, [[41, 1]]);
check('R5. کسر ثبت‌نشده: کسر خودِ ووکامرس می‌ماند', stock(), 4);
check('R5. سفارش در عقب‌مانده (سطر پایدار)', (int) $GLOBALS['wpdb']->get_var("SELECT ref FROM wp_lmc_stock_mark WHERE kind = 'order'"), 8001);
LMC_Stock_Ledger::new_request();                                            // درخواست بعدی
$r = snap(5, 11);
check('R5. درخواست بعدی هم تا ثبت کسر عکس نمی‌نشاند', [$r['blocked'] ?? false, stock()], [true, 4]);
$e = wpush(5, 11, 950);
check('R5. Push هم ۵۰۳ (صف دوباره می‌فرستد)', $e instanceof WP_Error ? $e->data['status'] : null, 503);
$GLOBALS['fail_sql'] = null;
snap(5, 11);
check('R5. پس از رفع: عقب‌مانده ثبت و عدد درست', [stock(), marks('order'), rev()], [4, 0, 11]);
// خطای خواندن دفتر هنگام نشاندن: عدد نوشته نمی‌شود.
$GLOBALS['fail_sql'] = '/SUM\(qty\)/';
$r = snap(9, 12);
check('R5. خطای خواندن جمع کسر: نشانده نشد', [isset($r['error']), stock(), rev()], [true, 4, 11]);
$GLOBALS['fail_sql'] = null;
// (ب) هم کسر و هم نشانهٔ عقب‌مانده شکست می‌خورند: خرابی پایدار در wp_options؛ درخواست بعدی
//     هم بسته است و فقط بازنشانی مدیر (پس از تعمیر) باز می‌کند. یافتهٔ root: پیش‌تر شکست
//     update_option فقط log می‌شد و درخواست بعدی واحد را برمی‌گرداند.
fresh();
snap(5, 10);
$GLOBALS['fail_sql'] = '/^(INSERT INTO wp_lmc_stock_mark|UPDATE wp_lmc_stock_hold SET product_id = \d+, qty = \d+, confirmed = 1)/';
woo_order(8101, [[42, 1]]);
check('R5. خرابی پایدار ثبت شد', (int) get_option(LMC_Stock_Ledger::FAULT, 0) > 0, true);
$GLOBALS['fail_sql'] = null;
LMC_Stock_Ledger::new_request();
check('R5. درخواست بعدی با خرابی پایدار عکس نمی‌نشاند', [snap(5, 11)['blocked'] ?? false, stock()], [true, 4]);
LMC_Stock_Ledger::reset_epoch(null); delete_option(LMC_Stock_Ledger::FAULT); // همان کار دکمهٔ بازنشانی
LMC_Stock_Ledger::sync_order_safe($GLOBALS['orders'][8101]);
snap(5, 12);
check('R5. پس از تعمیر و بازنشانی: کسر ثبت و عدد درست', stock(), 4);
// (پ) نیت پیش از کسر ثبت نمی‌شود: خرابی پایدار، چون مرگ پردازه دیگر قابل بازیابی نیست.
fresh();
snap(5, 10);
$GLOBALS['fail_sql'] = '/^INSERT INTO wp_lmc_stock_hold/';
woo_order(8201, [[43, 1]]);
$GLOBALS['fail_sql'] = null;
check('R5. شکست ثبت نیت = خرابی پایدار', [(int) get_option(LMC_Stock_Ledger::FAULT, 0) > 0, snap(5, 11)['blocked'] ?? false, stock()], [true, true, 4]);
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
check('۶. Pull کهنه‌تر از Push نشانده نشد؛ مکان‌نما (با برچسب دوره) جلو رفت (رد قدیمی، نه شکست)', [stock(), get_option(LMC_Stock_Sync::CURSOR_OPTION)], [3, '1:C2']);
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
stock_set(P, 7);
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

// ══ بازبینی root روی a06c3c1 ═════════════════════════════════════════

// ── N1. عقب‌مانده بی lost update: interleaving قطعی میان drain و شکست هم‌زمان ──
fresh();
snap(5, 10);
$GLOBALS['fail_sql'] = '/^UPDATE wp_lmc_stock_hold SET product_id = \d+, qty = \d+, confirmed = 1/';
woo_order(8301, [[44, 1]]);
$GLOBALS['fail_sql'] = null;
check('N1. یک سفارش در عقب‌مانده', backlog_orders(), [8301]);
// درخواست X عقب‌مانده را می‌خواند؛ درست پس از خواندن و پیش از پاک‌کردن، درخواست Y دو شکست
// تازه ثبت می‌کند (سفارشی دیگر، و همان سفارش دوباره).
$GLOBALS['on_get_order'] = static function () {
    $GLOBALS['fail_sql'] = '/^(INSERT INTO wp_lmc_stock_hold|UPDATE wp_lmc_stock_hold SET product_id = \d+, qty = \d+, confirmed = 1)/';
    as_request('Y', static function () {
        $o = new Order(8302, [new Item(45, P, 1)]); $GLOBALS['orders'][8302] = $o;
        stock_add(P, -1); $o->items[0]->meta['_reduced_stock'] = 1;
        LMC_Stock_Ledger::sync_item_safe($o, $o->items[0]);
        LMC_Stock_Ledger::sync_item_safe($GLOBALS['orders'][8301], $GLOBALS['orders'][8301]->items[0]);
    });
    $GLOBALS['fail_sql'] = null;
};
LMC_Stock_Ledger::drain_backlog();
check('N1. نشانه‌های هم‌زمان Y پاک نشدند (فقط tokenهای خوانده‌شدهٔ X رفتند)', backlog_orders(), [8301, 8302]);
$r = snap(5, 11);
check('N1. درخواست بعدی هر دو را ثبت می‌کند و می‌نشاند', [marks('order'), stock(), $r['applied'] ?? null], [0, 3, true]);
// کنترل منفی: همان interleaving با الگوی قبلی (آرایهٔ option: بخوان، تغییر بده، بنویس).
$GLOBALS['options']['old_backlog'] = [8301 => 1];
$read = get_option('old_backlog', []);
$y = get_option('old_backlog', []); $y[8302] = 1; update_option('old_backlog', $y);
unset($read[8301]); update_option('old_backlog', $read);
check('N1. کنترل منفی: الگوی option شکست هم‌زمان را گم می‌کند', array_keys(get_option('old_backlog', [])), []);

// ── N2. نوشتن زیر قفل سطر `_stock` در برابر هر نوشتن هم‌زمان ووکامرس — هر دو جهت ──
// مراحل ما: 0 پیش از نشاندن · 1 «locked» (سطر قفل شد) · 2 «pending_read» (کسرها خوانده شد، پیش از
// نوشتن) · 3 «committed» · 4 پس از نشاندن. گام‌های ووکامرس به ترتیب ثابت WC 11.1.1:
//   کم‌کردن: I نیت (h) ‹ D `_stock−` (s) ‹ F `_reduced_stock` + Hook (h)
//   افزودن (لغو، استرداد، کاهش دستی): S `_stock+` (s) ‹ H برداشتن/کم‌کردن کسر + Hook (h)
// گام s که درون قفل (۱ یا ۲) بیفتد، مثل InnoDB تا Commit صبر می‌کند و گام‌های بعدی همان درخواست هم.
// هر جایگذاری یکنواخت، با مرگ ووکامرس پس از هر پیشوند. «درست» = Core − کسرهای واقعی.
const PH = ['before', 'locked', 'pending_read', 'committed', 'after'];
/** همهٔ جایگذاری‌های یکنواخت $n گام روی ۵ مرحله. */
function placements(int $n, int $from = 0): array
{
    if ($n === 0) { return [[]]; }
    $out = [];
    for ($p = $from; $p < 5; $p++) { foreach (placements($n - 1, $p) as $rest) { $out[] = array_merge([$p], $rest); } }
    return $out;
}
/** بی قفل سطری؛ قفل در اجرا و فقط اگر خودِ کد `FOR UPDATE` زده باشد اعمال می‌شود (run_schedule). */
function effective(array $types, array $place): array
{
    $eff = []; $floor = 0;
    foreach ($place as $k => $p) { $eff[$k] = $floor = max($p, $floor); }
    return $eff;
}
/** آیا تراکنش باز نوشتن ما سطر `_stock` را قفل کرده است؟ (از گزارش shim، نه فرض.) */
function row_locked(): bool
{
    $tx = $GLOBALS['tx'];
    $open = array_keys($tx, 'START TRANSACTION');
    if ($open === []) { return false; }
    $tail = array_slice($tx, end($open));
    return in_array('lock', $tail, true) && !in_array('COMMIT', $tail, true) && !in_array('ROLLBACK', $tail, true);
}
/**
 * سناریوهای ووکامرس. setup پیش از نشاندن ما (عکس 10/10 نشسته)؛ core = عکس تازهٔ ما؛ before/truth
 * = عدد درست پیش و پس از گام s (تغییر واقعی `_stock` ووکامرس)؛ designed = عدد طراحی‌شده (افزایش
 * دستیِ قلم تأییدشده کل قلم را تأییدنشده می‌شمارد: یک واحد کمتر، محافظه‌کار).
 */
function scenario(string $kind): array
{
    switch ($kind) {
        case 'reduce':
            return ['setup' => static function () { $o = new Order(9100, [new Item(91, P, 1)]); $GLOBALS['orders'][9100] = $o; },
                'core' => 9, 'before' => 9, 'truth' => 8, 'designed' => 8, 'types' => ['h', 's', 'h'], 'steps' => [
                static function () { $o = $GLOBALS['orders'][9100]; woo_reduce_begin($o); LMC_Stock_Ledger::on_item_quantity(1, $o, $o->items[0]); },
                static function () { stock_add(P, -1); },
                static function () { $o = $GLOBALS['orders'][9100]; woo_reduce_item_finish($o, $o->items[0]); woo_reduce_end($o); }]];
        case 'adjust_up':
            return ['setup' => static function () { woo_order(9000, [[90, 1]]); ack(9000, 11); snap(9, 11); },
                'core' => 8, 'before' => 8, 'truth' => 6, 'designed' => 5, 'types' => ['h', 's', 'h'], 'steps' => [
                static function () { $it = $GLOBALS['orders'][9000]->items[0]; $it->qty = 3; LMC_Stock_Ledger::on_prevent_adjust(false, $it, 3); },
                static function () { stock_add(P, -2); },
                static function () { $it = $GLOBALS['orders'][9000]->items[0]; $it->meta['_reduced_stock'] = 3; LMC_Stock_Ledger::on_item_saved($it->id, $it, 9000); }]];
        case 'cancel':
            return ['setup' => static function () { woo_order(9200, [[92, 2]]); },
                'core' => 10, 'before' => 8, 'truth' => 10, 'designed' => 10, 'types' => ['s', 'h'], 'steps' => [
                static function () { $GLOBALS['orders'][9200]->status = 'cancelled'; stock_add(P, 2); },
                static function () { $o = $GLOBALS['orders'][9200]; $it = $o->items[0]; unset($it->meta['_reduced_stock']);
                    LMC_Stock_Ledger::on_item_saved($it->id, $it, 9200); LMC_Stock_Ledger::on_restore($it, 0, 0, $o); }]];
        case 'refund':
            return ['setup' => static function () { woo_order(9300, [[93, 2]]); },
                'core' => 10, 'before' => 8, 'truth' => 9, 'designed' => 9, 'types' => ['s', 'h'], 'steps' => [
                static function () { stock_add(P, 1); },
                static function () { $o = $GLOBALS['orders'][9300]; $it = $o->items[0]; $it->meta['_reduced_stock'] = 1;
                    LMC_Stock_Ledger::on_item_saved($it->id, $it, 9300); LMC_Stock_Ledger::on_refund_restock(P, 0, 0, $o); }]];
        case 'adjust_down':
            return ['setup' => static function () { woo_order(9400, [[94, 2]]); },
                'core' => 10, 'before' => 8, 'truth' => 9, 'designed' => 9, 'types' => ['s', 'h'], 'steps' => [
                static function () { $it = $GLOBALS['orders'][9400]->items[0]; $it->qty = 1; LMC_Stock_Ledger::on_prevent_adjust(false, $it, 1); stock_add(P, 1); },
                static function () { $it = $GLOBALS['orders'][9400]->items[0]; $it->meta['_reduced_stock'] = 1; LMC_Stock_Ledger::on_item_saved($it->id, $it, 9400); }]];
    }
    throw new LogicException($kind);
}
/**
 * یک اجرا: گام‌ها (event, k, eff) به ترتیب مرحله؛ مراحل ۱ تا ۳ درون نشاندن ما و زیر قفل نام‌دار ما
 * (Hook ووکامرس قفل نمی‌گیرد و «دوباره» می‌گذارد). برمی‌گرداند [عدد پس از نشاندن، درستِ همان لحظه،
 * عدد پایانی، درستِ پایانی] — «درست» از گام‌های s که واقعاً اجرا شده‌اند.
 */
function truth_at(array $sc, array $done): int
{
    $t = reset($sc)['core'];
    foreach ($sc as $ev => $x) {
        $s_done = false;
        foreach ($done as [$e, $k]) { if ($e === $ev && $x['types'][$k] === 's') { $s_done = true; } }
        $t += ($s_done ? $x['truth'] : $x['before']) - $x['core'];
    }
    return $t;
}
function run_schedule(array $sc, array $runs, int $core, ?string $die = null): array
{
    $by = [];
    foreach ($runs as [$ev, $k, $ph]) { $by[$ph][] = [$ev, $k]; }
    $done = []; $deferred = []; $blocked = [];
    // گام s ووکامرس وقتی سطر را قفل کرده‌ایم مثل InnoDB صبر می‌کند؛ بقیهٔ همان درخواست پشتش.
    $exec = static function (int $ph) use (&$by, &$done, &$deferred, &$blocked, $sc) {
        if ($ph === 3) { $queue = array_merge($deferred, $by[3] ?? []); $deferred = []; $blocked = []; }
        else { $queue = $by[$ph] ?? []; }
        foreach ($queue as [$ev, $k]) {
            if (!empty($blocked[$ev]) || ($sc[$ev]['types'][$k] === 's' && row_locked())) {
                $blocked[$ev] = true; $deferred[] = [$ev, $k]; continue;
            }
            as_request('W' . $ev, $sc[$ev]['steps'][$k]);
            $done[] = [$ev, $k];
        }
    };
    $lock = LMC_Stock_Ledger::lock_name(P);
    $exec(0);
    foreach ([1 => 'locked', 2 => 'pending_read', 3 => 'committed'] as $ph => $stage) {
        $GLOBALS['probe'][$stage] = static function () use ($exec, $ph, $lock) {
            $GLOBALS['other_holds'][$lock] = true; $exec($ph); $GLOBALS['other_holds'][$lock] = false;
        };
    }
    snap($core, 20);
    $GLOBALS['probe'] = [];
    if ($deferred !== []) { $exec(3); }                                      // نوشتن ما پیش از Commit متوقف شد
    $after_write = stock(); $t_write = truth_at($sc, $done);
    $exec(4);
    if ($die !== null) { crash('W' . $die); snap($core, 21); }
    LMC_Stock_Ledger::maintain();
    return [$after_write, $t_write, stock(), truth_at($sc, $done)];
}
$cases = 0; $exact = 0; $over = [];
foreach (['reduce', 'adjust_up', 'cancel', 'refund', 'adjust_down'] as $kind) {
    $n = count(scenario($kind)['types']);
    for ($len = $n; $len >= 1; $len--) {                                    // len < n = مرگ ووکامرس پس از len گام
        foreach (placements($len) as $place) {
            fresh(); snap(10, 10);
            $sc = ['A' => scenario($kind)];
            $sc['A']['setup']();
            $eff = effective(array_slice($sc['A']['types'], 0, $len), $place);
            $runs = [];
            foreach ($eff as $k => $ph) { $runs[] = ['A', $k, $ph]; }
            [$w, $tw, $f, $tf] = run_schedule($sc, $runs, $sc['A']['core'], $len < $n ? 'A' : null);
            $tag = $kind . "[" . implode(',', array_map(static fn ($p) => PH[$p], $place)) . ']' . ($len < $n ? " مرگ پس از $len" : '');
            if ($w > $tw || $f > $tf) { $over[] = "$tag: $w>$tw یا $f>$tf"; }
            if ($len === $n && $f === $sc['A']['designed']) { $exact++; }
            if ($len === $n) { $cases++; }
        }
    }
}
check('N2. هیچ جایگذاری (کم‌کردن و افزودن، با مرگ) بیش از درست نشان نداد', $over, []);
check('N2. جایگذاری‌های کامل سنجیده شد (۳۵×۲ کم‌کردن + ۱۵×۳ افزودن)', $cases, 115);
check('N2. و همهٔ کامل‌ها به عدد طراحی‌شده رسیدند', $exact, 115);

// ── N2-ب. دو رویداد هم‌زمان: لغو یک سفارش و کسر سفارشی دیگر، با هر دو ترتیب درون یک مرحله ──
// همان کلاسی که «بیشینهٔ دو خواندن» را می‌شکند (کسر کامل پیش از قفل، افزودن پس از آن).
$mixed = 0; $mixed_over = []; $mixed_exact = 0;
foreach (placements(2) as $pa) {
    foreach (placements(3) as $pb) {
        foreach (['AB', 'BA'] as $tie) {
            fresh(); snap(10, 10);
            $sc = ['A' => scenario('cancel'), 'B' => scenario('reduce')];
            $sc['A']['setup'](); $sc['B']['setup']();
            $runs = [];
            foreach (['A' => $pa, 'B' => $pb] as $ev => $place) {
                foreach (effective($sc[$ev]['types'], $place) as $k => $ph) { $runs[] = [$ev, $k, $ph]; }
            }
            usort($runs, static fn ($x, $y) => [$x[2], ($tie === 'AB') === ($x[0] === 'A') ? 0 : 1, $x[1]] <=> [$y[2], ($tie === 'AB') === ($y[0] === 'A') ? 0 : 1, $y[1]]);
            [$w, $tw, $f, $tf] = run_schedule($sc, $runs, 10);
            if ($w > $tw || $f > $tf) { $mixed_over[] = implode(',', $pa) . '|' . implode(',', $pb) . " $tie: $w>$tw یا $f>$tf"; }
            if ($f === 9) { $mixed_exact++; }
            $mixed++;
        }
    }
}
check('N2-ب. لغو + کسر هم‌زمان: هیچ ترتیبی بیش از درستِ همان لحظه نشان نداد', $mixed_over, []);
check('N2-ب. ۱۵×۳۵×۲ ترتیب سنجیده شد و همه به ۹ رسیدند', [$mixed, $mixed_exact], [1050, 1050]);

// ── R6. سه بازتولید root روی bbae0d1: ووکامرس افزودن را درست وقتی می‌زند که ما `_stock` را خوانده‌ایم ──
// (نسخهٔ تفاضلی: لغو ۱۲ به‌جای ۱۰، استرداد ۱۰ به‌جای ۹، کاهش دستی ۱۰ به‌جای ۹.)
foreach (['cancel' => 10, 'refund' => 9, 'adjust_down' => 9] as $kind => $want) {
    fresh(); snap(10, 10);
    $sc = ['A' => scenario($kind)];
    $sc['A']['setup']();
    $runs = [];
    foreach (effective($sc['A']['types'], [1, 1]) as $k => $ph) { $runs[] = ['A', $k, $ph]; }
    [$w, $tw, $f] = run_schedule($sc, $runs, 10);
    check("R6. $kind هم‌زمان با قفل ما: هرگز بیش از $want و در پایان دقیق", [$w <= $tw, $tw, $f], [true, $want, $want]);
}
check('R6. نوشتن و انتشار حالت در یک تراکنش: قفل سطر، قفل اشتراکی دوره، `_stock`، حالت، Commit', (static function () {
    fresh(); snap(10, 10); $GLOBALS['tx'] = [];
    snap(9, 20);
    return $GLOBALS['tx'];
})(), ['START TRANSACTION', 'lock', 'epoch-lock', 'write', 'lock', 'write', 'COMMIT']);

// ── N3. مرگ پردازه پس از کم‌کردن `_stock` و پیش از Hook: نیت می‌ماند تا اثبات ──
fresh();
snap(5, 10);
$o = new Order(8501, [new Item(48, P, 1)]); $GLOBALS['orders'][8501] = $o;
as_request('A', static function () use ($o) { woo_reduce_begin($o); woo_reduce_item($o, $o->items[0], true); });
crash('A');
$r = wpush(5, 11, 980);
check('N3. Push پس از مرگ: نشانده و واحد برنگشت (۵−۱)', [is_array($r) ? ($r['applied'] ?? null) : null, stock(), holds()], [true, 4, 1]);
LMC_Stock_Ledger::sync_order_safe($o);
check('N3. همگام‌سازی بی اثبات (پرچم کسر false) نیت را نگه می‌دارد', [holds(), stock()], [1, 4]);
$o->status = 'cancelled';
LMC_Stock_Ledger::on_status_changed(8501);
check('N3. لغو سفارش نیمه‌کسر: نیت حل و عدد Core', [holds(), stock()], [0, 5]);
fresh();
snap(5, 10);
$o = new Order(8502, [new Item(49, P, 1)]); $GLOBALS['orders'][8502] = $o;
as_request('A', static function () use ($o) {
    woo_reduce_begin($o);
    LMC_Stock_Ledger::on_item_quantity(1, $o, $o->items[0]);
    woo_reduce_end($o);
});
check('N3. کسر ناموفق ووکامرس: نیت در پایان حلقه پاک شد', [holds(), stock()], [0, 5]);
// ویرایش دستی که پس از کم‌کردن `_stock` می‌میرد: نیت ۳ می‌ماند (کمتر، نه بیشتر).
fresh();
snap(10, 30);
woo_order(8503, [[50, 1]]);
ack(8503, 31);
snap(9, 31);
$it = $GLOBALS['orders'][8503]->items[0];
as_request('B', static function () use ($it) { $it->qty = 3; LMC_Stock_Ledger::on_prevent_adjust(false, $it, 3); stock_add(P, -2); });
crash('B');
snap(9, 32);
check('N3. ویرایش دستی مرده: تعداد تازه کسر می‌ماند (۹−۳)', stock(), 6);

// ── N6. دوره با خود درخواست یخ می‌زند ─────────────────────────────────
fresh();
snap(10, 70);
woo_order(8801, [[81, 1]]);
$e0 = LMC_Stock_Ledger::epoch();                                            // درخواست رزرو آغاز شد
LMC_Stock_Ledger::reset_epoch(null);                                        // بازنشانی وسط درخواست
pull(['available' => '10', 'stockRev' => '2']);
ack(8801, 71, WH, null, $e0);                                               // پاسخ Core پیشین رسید
pull(['available' => '10', 'stockRev' => '100'], 'C7');
check('N6. ACK درخواست پیش از بازنشانی در دورهٔ تازه تأیید نمی‌کند', stock(), 9);
$GLOBALS['options'][LMC_Stock_Sync::CURSOR_OPTION] = 'C7';
$r = LMC_Stock_Ledger::apply_snapshot(P, 50, true, 500, WH, 0, true, null, $e0);
check('N6. عکس Pull آغازشده پیش از بازنشانی رد شد', [$r['busy'] ?? false, stock()], [true, 9]);
fresh();
snap(10, 70);
update_post_meta(P, LMC_Stock_Ledger::STATE_META, json_encode(['w' => WH, 'r' => 999, 'c' => 50, 'a' => true, 'd' => false, 'e' => 1]));
LMC_Stock_Ledger::reset_epoch(null);
update_post_meta(P, LMC_Stock_Ledger::STATE_META, json_encode(['w' => WH, 'r' => 999, 'c' => 50, 'a' => true, 'd' => false, 'e' => 1])); // نوشتنِ هم‌زمانِ دورهٔ قبل
check('N6. حالتِ نوشته‌شده با دورهٔ قبل حالت نیست', rev(), null);
$r = wpush(50, 1000, 2000);
check('N6. Push کالای بی‌حالت پس از فعال‌شدن: منتظر Pull (۵۰۳)، نه نشاندن خام', $r instanceof WP_Error ? $r->data['status'] : null, 503);
check('N6. نسخهٔ Push دورهٔ قبل پس از بازنشانی اعتبار ندارد', LMC_Stock_Ledger::version(P), 0);

// ── N4. ACK دقیقاً تعداد همان ارسال ──────────────────────────────────
fresh();
snap(10, 30);
woo_order(8601, [[51, 1]]);
woo_admin_adjust(8601, 51, 3);
ack(8601, 31, WH, [51 => 1]);
snap(9, 31);
check('N4. ACK تعداد کمتر، قلم افزایش‌یافته را تأیید نمی‌کند', stock(), 6);
check('N4. علت در یادداشت', (bool) array_filter($GLOBALS['orders'][8601]->notes, static fn ($n) => str_contains($n, 'اثبات')), false);
ack(8601, 32, WH, [51 => 3]);
snap(7, 32);
check('N4. ACK درخواست تازه با همان تعداد ۳', stock(), 7);
fresh();
snap(10, 40);
woo_order(8602, [[52, 3]]);
woo_refund_restock(8602, 52, 1);
ack(8602, 41, WH, [52 => 3]);
snap(7, 41);
check('N4. کاهش پیش از ACK: تأیید معتبر و دوبار کم نمی‌شود', stock(), 7);
fresh();
snap(10, 50);
woo_order(8603, [[53, 1]]);
ack(8603, 51, WH, []);
snap(9, 51);
check('N4. قلم بیرون از درخواست تأیید نمی‌شود', stock(), 8);

// ── N5. بازنشانی: ACKهای پیش از بکاپ فقط با زمان بکاپ منتقل می‌شوند ──
fresh();
snap(10, 60);
woo_order(8701, [[61, 1]]);
woo_order(8702, [[62, 2]]);
ack(8701, 61); ack(8702, 62);
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET ack_at = 1000 WHERE order_id = 8701');
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET ack_at = 3000 WHERE order_id = 8702');
LMC_Stock_Ledger::reset_epoch(2000);
check('N5. بازنشانی حالت کالا را پاک کرد', rev(), null);
pull(['available' => '9', 'stockRev' => '100']);                           // Core بازیابی‌شده جلوتر از واترمارک‌های قدیمی
check('N5. تأیید پیش از بکاپ منتقل، پس از بکاپ بی‌اعتبار (۹−۲)', stock(), 7);
fresh();
snap(10, 60);
woo_order(8703, [[63, 1]]);
ack(8703, 61);
LMC_Stock_Ledger::reset_epoch(null);
pull(['available' => '10', 'stockRev' => '103']);
check('N5. بی زمان بکاپ هیچ تأییدی منتقل نمی‌شود (محافظه‌کار)', stock(), 9);

// ── R7. بی واترمارک پس از فعال‌شدن، حتی پس از بازنشانی: نه Push نه Pull، بی بازگشت بی‌صدا ──
fresh();
snap(5, 10);
woo_order(9701, [[97, 1]]);                                                  // عدد ۴، کسر محلی
LMC_Stock_Ledger::reset_epoch(null);                                        // حالت پاک شد، پروتکل فعال ماند
$r = push(['onHand' => 5, 'version' => 7000]);                               // Push کهنهٔ بی stockRev در راه
check('R7. Push بی واترمارک پس از بازنشانی: ۴۰۹ و عدد دست نخورد', [$r instanceof WP_Error ? $r->data['status'] : null, stock()], [409, 4]);
$GLOBALS['options'][LMC_Stock_Sync::CURSOR_OPTION] = 'C3';
$out = pull(['available' => '5'], 'C4');
check('R7. Pull بی واترمارک پس از بازنشانی: نشانده نشد، مکان‌نما ثابت', [$out['busy'], stock(), get_option(LMC_Stock_Sync::CURSOR_OPTION)], [1, 4, 'C3']);
$out = pull(['available' => '5', 'stockRev' => '3'], 'C4');
check('R7. Pull واترمارک‌دار دورهٔ تازه کالا را دوباره وارد می‌کند (۵−۱)', [stock(), rev()], [4, 3]);
// کنترل منفی: پیش از فعال‌شدن پروتکل رفتار پیشین می‌ماند (R3 هم همین را دارد).
fresh();
check('R7. کنترل منفی: پیش از فعال‌شدن، بی واترمارک نشانده می‌شود', LMC_Stock_Ledger::apply_legacy(P, 6, 0)['applied'] ?? null, true);

// ── R8. بازنشانی وسط نوشتن ما ──────────────────────────────────────────
// (الف) پس از قفل و پیش از خواندن دوره: نوشتن انجام نمی‌شود، Rollback، و «مشغول».
fresh();
snap(10, 10);
woo_order(9801, [[98, 1]]);                                                  // ۹
$GLOBALS['probe']['locked'] = static function () { LMC_Stock_Ledger::reset_epoch(null); };
$r = snap(50, 20);
check('R8. بازنشانی پس از قفل: نشانده نشد، Rollback، حالت معتبری نماند', [$r['busy'] ?? false, stock(), rev(), array_slice($GLOBALS['tx'], -1)], [true, 9, null, ['ROLLBACK']]);
// (ب) پس از خواندن دوره و کسرها و پیش از نوشتن: نوشتن پیش از بازنشانی خطی می‌شود (قفل سطر و قفل
// کالا نویسندهٔ دورهٔ تازه را پشت سر نگه می‌دارند)، ولی حالت و نسخه‌اش در دورهٔ تازه اعتبار ندارند.
fresh();
snap(10, 10);
woo_order(9802, [[99, 1]]);
// در MySQL، UPDATE بازنشانی پشت قفل اشتراکی سطر دوره تا Commit همین نوشتن می‌ماند (real-wc: reset-after-check)؛
// SQLite نمی‌تواند صبر کند، پس همان ترتیب اجباری مدل می‌شود: بازنشانی درست پس از Commit و پیش از پایان نشاندن.
$GLOBALS['probe']['committed'] = static function () { LMC_Stock_Ledger::reset_epoch(null); };
$r = wpush(50, 20, 8000);
check('R8. بازنشانی پس از خواندن: عدد دورهٔ قبل، با کسر (۵۰−۱)', stock(), 49);
check('R8. ولی حالت و نسخهٔ آن نوشتن در دورهٔ تازه اعتبار ندارند', [rev(), LMC_Stock_Ledger::version(P)], [null, 0]);
$r = wpush(40, 21, 10);                                                      // Push دورهٔ تازه با نسخهٔ کوچک‌تر (Core بازیابی‌شده)
check('R8. Push دورهٔ تازه برای کالای بی‌حالت منتظر Pull می‌ماند', $r instanceof WP_Error ? $r->data['status'] : null, 503);
pull(['available' => '40', 'stockRev' => '21']);
$r = wpush(30, 22, 11);
check('R8. پس از Pull، Push دورهٔ تازه با نسخهٔ ۱۱ «قدیمی» شمرده نمی‌شود', [is_array($r) ? ($r['applied'] ?? null) : null, stock()], [true, 29]);
// (ج) بازنشانی میان سنجش دوره در PHP و UPDATE ACK: همان UPDATE رد می‌کند.
fresh();
snap(10, 10);
$o = woo_order(9803, [[100, 1]]);
$e0 = LMC_Stock_Ledger::epoch();
$o->on_items = static function () { LMC_Stock_Ledger::reset_epoch(null); };
ack(9803, 11, WH, null, $e0);
check('R8. ACK هم‌زمان با بازنشانی تأیید نکرد', (int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold WHERE ack_rev IS NOT NULL'), 0);
pull(['available' => '10', 'stockRev' => '30']);
check('R8. و کسرش در دورهٔ تازه می‌ماند (۱۰−۱)', stock(), 9);

// ── R9. کسر گیرکرده دیده و فقط با اثبات زندهٔ Core رها می‌شود ─────────
/** فرم رها کردن همان نسخهٔ نمایش‌داده را می‌فرستد. */
function release_form(array $row, string $reason = 'در Core دیدم'): array
{
    return ['lmc_order' => (string) $row['order_id'], 'lmc_item' => (string) $row['item_id'], 'lmc_qty' => (string) $row['qty'],
        'lmc_confirmed' => (string) $row['confirmed'], 'lmc_created' => (string) $row['created_at'],
        'lmc_ack_rev' => $row['ack_rev'] === null ? '' : (string) $row['ack_rev'],
        'lmc_ack_epoch' => $row['ack_epoch'] === null ? '' : (string) $row['ack_epoch'], 'lmc_reason' => $reason,
        'lmc_epoch' => (string) LMC_Stock_Ledger::epoch()];
}
function release_post(array $post): string
{
    $_POST = $post;
    try { LMC_Stock_Ledger::handle_release(); return 'none'; } catch (Lmc_Test_Exit $e) { return $e->getMessage(); } finally { $_POST = []; }
}
// بازتولید root روی 2a7817b: Core این ۲ واحد را در rev 31 (موجودی ۸) Commit کرده ولی عکس/ACK آن هنوز نرسیده.
fresh();
snap(10, 30);
woo_order(9901, [[101, 2]]);
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET created_at = ' . (time() - 7200));
check('R9. پیش از رها کردن: ۸ با واترمارک نشستهٔ ۳۰', [stock(), rev()], [8, 30]);
$row = LMC_Stock_Ledger::unresolved()[0];
$ok = LMC_Stock_Ledger::release_hold(9901, 101, ['qty' => $row['qty'], 'confirmed' => $row['confirmed'], 'created_at' => $row['created_at'],
    'ack_rev' => $row['ack_rev'], 'ack_epoch' => $row['ack_epoch'], 'epoch' => LMC_Stock_Ledger::epoch()], 'Verified in Core rev31', 'manager');
LMC_Stock_Ledger::recompute(P);
check('R9. root: درخواست ثبت شد ولی هیچ عکسی را تأیید نکرد — عدد ۸ می‌ماند (نه ۱۰)', [$ok, stock()], [true, 8]);
$r = wpush(10, 30, 100);                                                     // عکس کش‌شده/کهنهٔ پیش از Commit
check('R9. عکس کهنه پس از درخواست هم ۱۰ نمی‌نشاند', stock() <= 8, true);
$ra = (int) $GLOBALS['wpdb']->get_var('SELECT release_after FROM wp_lmc_stock_hold WHERE order_id = 9901');
$r = LMC_Stock_Ledger::apply_snapshot(P, 10, true, 31, WH, 0, true, null, LMC_Stock_Ledger::epoch(), $ra - 1);
check('R9. Pull که خواندنش پیش از درخواست آغاز شده تأیید نمی‌کند (۱۰−۲، کسر بی ACK)', [stock(), holds_unacked()], [8, 1]);
$r = LMC_Stock_Ledger::apply_snapshot(P, 8, true, 32, WH, 0, true, null, LMC_Stock_Ledger::epoch(), $ra + 1);
check('R9. Pull زندهٔ پس از درخواست: تأیید با واترمارک همان عکس (۳۲)، عدد ۸', [stock(), (int) $GLOBALS['wpdb']->get_var('SELECT ack_rev FROM wp_lmc_stock_hold')], [8, 32]);
check('R9. و عکس کهنه‌تر از آن (۳۱) کسر را هنوز می‌بیند', LMC_Stock_Ledger::pending(P, 31, WH), 2);
// نیت ویرایش دستی مرده، رها کردن از مسیر مدیریت با خواندن زندهٔ کامل.
fresh();
snap(10, 30);
woo_order(8504, [[54, 1]]);
ack(8504, 31);
snap(9, 31);
$it = $GLOBALS['orders'][8504]->items[0];
as_request('B', static function () use ($it) { $it->qty = 3; LMC_Stock_Ledger::on_prevent_adjust(false, $it, 3); stock_add(P, -2); });
crash('B');                                                                  // ویرایش دستی وسط کار مرد
snap(9, 32);
check('R9. نیت ویرایش دستی بی اثبات: کمتر از واقع (۹−۳)', stock(), 6);
check('R9. پیش از یک ساعت در فهرست رسیدگی نیست', LMC_Stock_Ledger::unresolved(), []);
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET created_at = ' . (time() - 7200));
$u = LMC_Stock_Ledger::unresolved();
check('R9. پس از یک ساعت دیده می‌شود (نیت ویرایش دستی، تعداد ۳)', [count($u), $u[0]['confirmed'] ?? null, $u[0]['qty'] ?? null], [1, 2, 3]);
$form = release_form($u[0]);
$GLOBALS['can'] = false; $GLOBALS['nonce'] = 'lmc_stock_release';
check('R9. بی نقش manage_woocommerce رها نمی‌شود', [str_starts_with(release_post($form), 'die'), (int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold WHERE release_after IS NOT NULL')], [true, 0]);
$GLOBALS['can'] = true; $GLOBALS['nonce'] = 'other';
check('R9. بی Nonce درست رها نمی‌شود', release_post($form), 'nonce');
$GLOBALS['nonce'] = 'lmc_stock_release';
check('R9. بی دلیل رها نمی‌شود', str_starts_with(release_post(['lmc_reason' => ''] + $form), 'die'), true);
check('R9. بی نسخهٔ نمایش‌داده رها نمی‌شود', str_starts_with(release_post(array_diff_key($form, ['lmc_qty' => 1])), 'die'), true);
// فرم کهنه: از وقتی صفحه دیده شد، کسر تازه‌تری روی همان قلم نشسته (۳ → ۴).
$it->qty = 4; LMC_Stock_Ledger::on_prevent_adjust(false, $it, 4);
release_post($form);
check('R9. فرم کهنه کسر تازه‌تر را رها نمی‌کند', [(int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold WHERE release_after IS NOT NULL'), str_contains(urldecode(urldecode($GLOBALS['redirect'])), 'عوض شده')], [0, true]);
$form = release_form(LMC_Stock_Ledger::unresolved()[0]);
// خواندن Core در دسترس نیست: درخواست ثبت می‌شود ولی چیزی رها نمی‌شود.
$GLOBALS['feed'] = new WP_Error('lmc_http', 'Core در دسترس نیست');
$before = stock();
$x = release_post($form);
check('R9. بی خواندن زندهٔ Core کسر می‌ماند (بسته در شکست)', [$x, stock(), holds_unacked()], ['redirect', $before, 1]);
// مدیر در Core دو واحد اضافه را ثبت کرد (Core ۶) و خواندن زنده برقرار شد: Pull بعدی تأیید می‌کند.
$GLOBALS['options'][LMC_Stock_Sync::CURSOR_OPTION] = '';
$x = release_post(release_form(LMC_Stock_Ledger::unresolved()[0]) + []);
$GLOBALS['feed'] = ['items' => [['available' => '6', 'stockRev' => '40', 'variationId' => VAR_ID, 'sku' => 'SKU-42']], 'cursor' => 'C40'];
LMC_Stock_Sync::run();
check('R9. Pull زنده پس از درخواست تأیید کرد: عدد Core (۶)', [stock(), LMC_Stock_Ledger::unresolved()], [6, []]);
check('R9. یادداشت سفارش نام مدیر و دلیل را دارد', (bool) array_filter($GLOBALS['orders'][8504]->notes, static fn ($n) => str_contains($n, 'manager') && str_contains($n, 'در Core دیدم')), true);
woo_refund_restock(8504, 54, 1);                                             // رویداد بعدی همان قلم از همان سطر
snap(7, 41);
check('R9. استرداد بعدی دوبار کم نمی‌کند (Core ۷، کسر رهاشده)', stock(), 7);
$GLOBALS['can'] = false;

// ── R11. درون تراکنش دیگری: نه Commit ضمنی، نه نوشتن ──────────────────
fresh();
snap(10, 10);
woo_order(9911, [[111, 2]]);                                                 // ۸
$GLOBALS['in_tx'] = '1'; $GLOBALS['tx'] = [];
$r = snap(5, 20);
check('R11. نشاندن درون تراکنش فراخواننده: «مشغول»، بی START TRANSACTION', [$r['busy'] ?? false, stock(), in_array('START TRANSACTION', $GLOBALS['tx'], true)], [true, 8, false]);
woo_refund_restock(9911, 111, 1);                                            // Hook ووکامرس درون همان تراکنش
check('R11. Hook درون تراکنش: «دوباره»، بی نوشتن', [marks('redo') > 0, in_array('START TRANSACTION', $GLOBALS['tx'], true)], [true, false]);
// MySQL Oracle: `@@in_transaction` نیست؛ سنجش با `SET TRANSACTION`.
$GLOBALS['in_tx'] = null; $GLOBALS['set_tx'] = 'in'; $GLOBALS['tx'] = [];
$r = snap(5, 21);
check('R11. MySQL درون تراکنش (خطای ۱۵۶۸): نشاندن «مشغول»، بی START TRANSACTION', [$r['busy'] ?? false, in_array('START TRANSACTION', $GLOBALS['tx'], true)], [true, false]);
$GLOBALS['set_tx'] = 'err'; $GLOBALS['tx'] = [];
$r = snap(5, 22);
check('R11. MySQL با سنجش نامعلوم: بسته در شکست («مشغول»)', [$r['busy'] ?? false, in_array('START TRANSACTION', $GLOBALS['tx'], true)], [true, false]);
woo_refund_restock(9911, 111, 1);
check('R11. نامعلوم: در Hook نوشته نمی‌شود', in_array('START TRANSACTION', $GLOBALS['tx'], true), false);
$GLOBALS['in_tx'] = null; $GLOBALS['set_tx'] = 'ok';                         // MySQL، بیرون از تراکنش
LMC_Stock_Ledger::flush_deferred();
check('R11. سنجش MySQL فقط حالت دسترسی خود نشست را می‌گذارد، نه سطح جداسازی', array_unique($GLOBALS['set_tx_sql']), ['SET TRANSACTION READ WRITE']);
check('R11. پایان درخواست: بازمحاسبهٔ موکول‌شده انجام شد', [in_array('START TRANSACTION', $GLOBALS['tx'], true), stock()], [true, 10]);

// ── R11-ب. autocommit=0: هر جمله تراکنش ضمنی باز می‌کند؛ «درون تراکنش»، در هر موتوری ──
fresh();
snap(10, 10);
$GLOBALS['autocommit'] = '0'; $GLOBALS['tx'] = [];
$r = snap(5, 20);
check('R11-ب. autocommit=0: «مشغول»، بی START TRANSACTION، و گزارش علت', [$r['busy'] ?? false, in_array('START TRANSACTION', $GLOBALS['tx'], true), (bool) array_filter($GLOBALS['logs'] ?? [], static fn ($l) => str_contains($l, 'موکول شد'))], [true, false, true]);
$GLOBALS['autocommit'] = '1';
$r = snap(5, 20);
check('R11-ب. درخواست بعدی (Pull/دکمه) همان عکس را می‌نشاند', [$r['applied'] ?? false, stock()], [true, 5]);

// ── R14. بازنشانی پس از سنجش دوره و خواندن کسرها، پیش از UPDATE (مدل root روی c5d9623) ──
// در MySQL قفل اشتراکی سطر دوره UPDATE بازنشانی را تا Commit نوشتن ما نگه می‌دارد (real-wc همین را با دو
// پردازه می‌سنجد)؛ اینجا همان ترتیبِ اجباری مدل می‌شود: نوشتن نسل قبل Commit، بعد بازنشانی.
fresh();
snap(10, 30);
woo_order(9931, [[131, 2]]);                                                 // ۸
ack(9931, 31);
check('R14. عکس کش‌شدهٔ ۳۰ هنوز کسر را می‌بیند', stock(), 8);
$r = snap(10, 32);                                                           // عکس نسل قبل، شامل سفارش
check('R14. نوشتن نسل قبل: ۱۰ (ACK در rev 31)', [$r['applied'] ?? null, stock()], [true, 10]);
LMC_Stock_Ledger::reset_epoch(null);                                         // Core پیش از آن سفارش بازیابی شد
check('R14. پس از بازنشانی عدد بر پایهٔ ACK دورهٔ قبل بالا نمی‌ماند (۱۰−۲)', stock(), 8);
pull(['available' => '10', 'stockRev' => '1']);                              // Pull نسل تازه
check('R14. Pull نسل تازه هم ۸', stock(), 8);
// بازنشانی هرگز عدد را بالا نمی‌برد، حتی با پایهٔ حالتی که نوشتنش هنوز Commit نشده (R8 الف).

// ── R15. مرگ پردازهٔ «بازنشانی» درست پس از Commit دوره (مدل root روی 29df1bb) ──────
// عکس ۱۰ (rev 30)، سفارش ۲، ACK rev 31، عکس نسل قبل ۱۰ (rev 32)، مکان‌نمای قدیمی؛ بازنشانی(null) پس از
// Commit دوره می‌میرد. پیش از اصلاح: درخواست بعدی since=مکان‌نمای قدیمی، خوراک خالی، موجودی ۱۰ (انتظار ۸).
fresh();
snap(10, 30);
woo_order(9951, [[151, 2]]);
ack(9951, 31);
pull(['available' => '10', 'stockRev' => '32'], '2026-10-17T06:00Z');           // مکان‌نمای نسل ۱
check('R15. پیش از بازنشانی: ۱۰ و مکان‌نمای برچسب‌دار', [stock(), get_option(LMC_Stock_Sync::CURSOR_OPTION)], [10, '1:2026-10-17T06:00Z']);
$GLOBALS['probe']['reset_committed'] = static function () { throw new RuntimeException('مرگ پردازهٔ بازنشانی (تزریق آزمون)'); };
$died = false;
try { LMC_Stock_Ledger::reset_epoch(null); } catch (RuntimeException $e) { $died = true; }
$intent = $GLOBALS['wpdb']->get_var("SELECT option_value FROM wp_options WHERE option_name = '" . LMC_Stock_Ledger::RESET_INTENT . "'");
check('R15. پس از مرگ: دوره ۲، نیت پایدار، عدد هنوز ۱۰، مکان‌نمای نسل قبل برای دورهٔ ۲ باطل',
    [$died, LMC_Stock_Ledger::epoch(), $intent, stock(), LMC_Stock_Sync::cursor_for(2)], [true, 2, '{"from":1,"to":2}', 10, '']);
// درخواست بعدی: Core بازیابی‌شده (پیش از سفارش) خوراک افزایشی خالی می‌داد؛ حالا Pull کامل است.
$GLOBALS['feed_queries'] = [];
$GLOBALS['feed'] = ['items' => [], 'cursor' => null];
$out = LMC_Stock_Sync::run();
check('R15. Pull پس از مرگ: بی since، ادامهٔ بازنشانی ۸، نیت پاک، بی خطا',
    [array_key_exists('since', $GLOBALS['feed_queries'][0] ?? []), stock(), (int) $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM wp_options WHERE option_name = '" . LMC_Stock_Ledger::RESET_INTENT . "'"), $out['error']],
    [false, 8, 0, '']);
pull(['available' => '10', 'stockRev' => '1'], 'N1');
check('R15. عکس نسل تازه از Core بازیابی‌شده: ۸ و مکان‌نمای دورهٔ ۲', [stock(), get_option(LMC_Stock_Sync::CURSOR_OPTION)], [8, '2:N1']);

// ادامه شکست می‌خورد ← نیت می‌ماند و دور «خطا» گزارش می‌شود، نه موفقیت بی‌صدا؛ دور بعد کامل می‌کند.
fresh();
snap(10, 30);
woo_order(9952, [[152, 2]]);
ack(9952, 31);
snap(10, 32);
$GLOBALS['probe']['reset_committed'] = static function () { throw new RuntimeException('مرگ'); };
try { LMC_Stock_Ledger::reset_epoch(null); } catch (RuntimeException $e) { }
$GLOBALS['probe']['locked'] = static function () { throw new LMC_Stock_Ledger_Error('قفل نرسید (تزریق آزمون)'); };
$GLOBALS['feed'] = ['items' => [], 'cursor' => null];
$out = LMC_Stock_Sync::run();
check('R15. ادامهٔ ناموفق: نیت می‌ماند، عدد ۱۰، خطای دیدنی',
    [stock(), (int) $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM wp_options WHERE option_name = '" . LMC_Stock_Ledger::RESET_INTENT . "'"), $out['error'] !== ''],
    [10, 1, true]);
$out = LMC_Stock_Sync::run();
check('R15. دور بعد: ادامه کامل، ۸، نیت پاک', [stock(), (int) $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM wp_options WHERE option_name = '" . LMC_Stock_Ledger::RESET_INTENT . "'"), $out['error']], [8, 0, '']);
check('R15. ادامهٔ دوباره بی‌اثر (Idempotent)', [LMC_Stock_Ledger::resume_reset(), stock()], [['pending' => false, 'failed' => 0], 8]);

// Pull نسل قبل که پیش از بازنشانی خواند و مکان‌نمایش را پس از آن نوشت: مکان‌نما باطل است.
fresh();
snap(10, 30);
woo_order(9953, [[153, 2]]);
ack(9953, 31);
$GLOBALS['probe']['locked'] = static function () { LMC_Stock_Ledger::reset_epoch(null); };   // بازنشانی وسط نوشتن Pull
$GLOBALS['feed_queries'] = [];
pull(['available' => '10', 'stockRev' => '32'], 'OLD');
check('R15. Pull نسل قبل پس از بازنشانی: نشانده نشد، مکان‌نما جلو نرفت، ۸', [stock(), LMC_Stock_Sync::cursor_for(2)], [8, '']);
// حتی اگر مکان‌نمای نسل قبل نوشته شده باشد (مثلاً صفحهٔ بی‌کالا)، در دورهٔ تازه خوانده نمی‌شود.
update_option(LMC_Stock_Sync::CURSOR_OPTION, '1:OLD');
$GLOBALS['feed_queries'] = [];
$GLOBALS['feed'] = ['items' => [], 'cursor' => null];
LMC_Stock_Sync::run();
check('R15. مکان‌نمای برچسب دورهٔ ۱ در دورهٔ ۲: Pull کامل', array_key_exists('since', $GLOBALS['feed_queries'][0] ?? []), false);
update_option(LMC_Stock_Sync::CURSOR_OPTION, 'C-legacy');
$GLOBALS['feed_queries'] = [];
LMC_Stock_Sync::run();
check('R15. مکان‌نمای بی برچسب (پیش از ارتقا): یک Pull کامل', array_key_exists('since', $GLOBALS['feed_queries'][0] ?? []), false);
update_option(LMC_Stock_Sync::CURSOR_OPTION, '2:C-ok');
$GLOBALS['feed_queries'] = [];
LMC_Stock_Sync::run();
check('R15. کنترل مثبت: مکان‌نمای همان دوره فرستاده می‌شود', $GLOBALS['feed_queries'][0]['since'] ?? null, 'C-ok');

// ── R16. بازنشانی دوباره پس از مرگ بازنشانی قبلی (بازبینی root روی aa3f966) ─────────
// مدیر پس از مرگ پردازه دوباره «بازنشانی» می‌زند. پایهٔ بازیابی (حالت Commitشدهٔ دورهٔ ۱) نباید با نیت
// تازهٔ ۲→۳ گم شود؛ وگرنه بازمحاسبه کالا را رد می‌کند، نیت پاک می‌شود و Pull خالی ۱۰ را نگه می‌دارد.
function intent_now(): ?string { return $GLOBALS['wpdb']->get_var("SELECT option_value FROM wp_options WHERE option_name = '" . LMC_Stock_Ledger::RESET_INTENT . "'"); }
function r16_base(int $order, int $item): void
{
    fresh();
    snap(10, 30);
    woo_order($order, [[$item, 2]]);
    ack($order, 31);
    snap(10, 32);
    $GLOBALS['probe']['reset_committed'] = static function () { throw new RuntimeException('مرگ پردازهٔ بازنشانی (تزریق آزمون)'); };
    try { LMC_Stock_Ledger::reset_epoch(null); } catch (RuntimeException $e) { }
}
r16_base(9961, 161);
check('R16. پس از مرگ نخست: دوره ۲، نیت ۱→۲، عدد ۱۰', [LMC_Stock_Ledger::epoch(), intent_now(), stock()], [2, '{"from":1,"to":2}', 10]);
LMC_Stock_Ledger::new_request();
LMC_Stock_Ledger::reset_epoch(null);                                         // تلاش دوبارهٔ مدیر، این بار تا پایان
check('R16. بازنشانی دوباره: دوره ۳، پایهٔ دورهٔ ۱ حفظ و بازمحاسبه ۸، نیت پاک', [LMC_Stock_Ledger::epoch(), stock(), intent_now()], [3, 8, null]);
$GLOBALS['feed_queries'] = [];
$GLOBALS['feed'] = ['items' => [], 'cursor' => null];
$out = LMC_Stock_Sync::run();
check('R16. Pull خالی Core بازیابی‌شده پس از آن: ۸، بی since، بی خطا', [stock(), array_key_exists('since', $GLOBALS['feed_queries'][0] ?? []), $out['error']], [8, false, '']);

// بازنشانی دوم پیش از نسل تازه ادامهٔ قبلی را تمام نمی‌کند (قفل کالا نرسید) و خودش هم پس از Commit
// می‌میرد: نیت ادغام‌شده با پایهٔ اصلی (۱→۳)، عدد هنوز ۱۰، و Pull بعدی از حالت دورهٔ ۱ کامل می‌کند.
r16_base(9962, 162);
LMC_Stock_Ledger::new_request();
$GLOBALS['probe']['locked'] = static function () { throw new LMC_Stock_Ledger_Error('قفل نرسید (تزریق آزمون)'); };
$GLOBALS['probe']['reset_committed'] = static function () { throw new RuntimeException('مرگ دوم'); };
try { LMC_Stock_Ledger::reset_epoch(null); } catch (RuntimeException $e) { }
check('R16. دو مرگ پیاپی: نیت با پایهٔ اصلی (۱→۳)، عدد هنوز ۱۰', [LMC_Stock_Ledger::epoch(), intent_now(), stock()], [3, '{"from":1,"to":3}', 10]);
$GLOBALS['feed'] = ['items' => [], 'cursor' => null];
$out = LMC_Stock_Sync::run();
check('R16. Pull بعدی: ۸ و نیت پاک', [stock(), intent_now(), $out['error']], [8, null, '']);

// بازنشانی تازه وسط ادامهٔ بازنشانی قبلی (پردازهٔ دیگر): نوشتن ادامه رد می‌شود، نیت با پایهٔ اصلی می‌ماند.
r16_base(9963, 163);
LMC_Stock_Ledger::new_request();
$GLOBALS['probe']['locked'] = static function () { LMC_Stock_Ledger::new_request(); LMC_Stock_Ledger::reset_epoch(null); };
$r = LMC_Stock_Ledger::resume_reset();
check('R16. ادامه هم‌زمان با بازنشانی تازه: ادامه «ناتمام» و عدد ۸ از بازنشانی تازه', [$r['pending'], LMC_Stock_Ledger::epoch(), stock(), intent_now()], [true, 3, 8, null]);

// پایهٔ قدیمی‌تر از «از» نیت: ادامهٔ نخست کامل شد (۸، نیت پاک، حالت کالا هنوز دورهٔ ۱). سفارش در دورهٔ ۲ پیش
// از بکاپ دوباره تأیید شده بود؛ بازنشانی دوم با زمان بکاپ آن تأیید را منتقل می‌کند، پس Core بازیابی‌شده سفارش را
// دارد و درست ۱۰ است. کالا باید از حالت دورهٔ ۱ با کسرهای دورهٔ ۳ دوباره حساب شود، نه به‌خاطر «از=۲» رد.
r16_base(9965, 165);
LMC_Stock_Ledger::new_request();
LMC_Stock_Ledger::resume_reset();
check('R16. پیش از بازنشانی دوم: نیت پاک، عدد ۸', [intent_now(), stock()], [null, 8]);
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET ack_rev = 33, ack_epoch = 2, ack_at = 1000 WHERE order_id = 9965');
LMC_Stock_Ledger::reset_epoch(2000);                                         // بکاپ پس از آن تأیید
check('R16. بازنشانی با انتقال تأیید: پایهٔ دورهٔ ۱ با کسرهای دورهٔ ۳ (۱۰)، نیت پاک',
    [LMC_Stock_Ledger::epoch(), (int) $GLOBALS['wpdb']->get_var('SELECT ack_epoch FROM wp_lmc_stock_hold WHERE order_id = 9965'), stock(), intent_now()], [3, 3, 10, null]);

// پاک‌کردن نیت شکست می‌خورد (خطای SQL): موفقیت گزارش نمی‌شود.
r16_base(9964, 164);
LMC_Stock_Ledger::new_request();
$GLOBALS['fail_sql'] = '/^DELETE FROM wp_options WHERE option_name = .lmc_stock_reset_pending. AND option_value/';
$r = LMC_Stock_Ledger::resume_reset();
$GLOBALS['fail_sql'] = null;
check('R16. حذف نیت ناموفق: «ناتمام»، نیت می‌ماند', [$r['pending'], intent_now() !== null, stock()], [true, true, 8]);
$r = LMC_Stock_Ledger::resume_reset();
check('R16. دور بعد: پاک و تمام', [$r, intent_now()], [['pending' => false, 'failed' => 0], null]);

// ── R13. درخواست رها کردن به دورهٔ صفحه بسته است، حتی با ack_epoch تهی ──
fresh();
snap(10, 30);
woo_order(9921, [[121, 2]]);
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET created_at = ' . (time() - 7200));
$old_form = release_form(LMC_Stock_Ledger::unresolved()[0]);                 // صفحه پیش از بازنشانی دیده شد
LMC_Stock_Ledger::reset_epoch(null);                                         // Core از بکاپ بازیابی شد
pull(['available' => '10', 'stockRev' => '5']);
$GLOBALS['can'] = true; $GLOBALS['nonce'] = 'lmc_stock_release';
$GLOBALS['feed'] = ['items' => [['available' => '10', 'stockRev' => '6', 'variationId' => VAR_ID, 'sku' => 'SKU-42']], 'cursor' => 'C6'];
release_post($old_form);
check('R13. فرم پیش از بازنشانی پس از آن هیچ درخواستی ثبت نمی‌کند', [(int) $GLOBALS['wpdb']->get_var('SELECT COUNT(*) FROM wp_lmc_stock_hold WHERE release_after IS NOT NULL'), stock(), holds_unacked()], [0, 8, 1]);
// درخواستی که در دورهٔ قبل ثبت شد و هنوز تأیید نشده، با Pull دورهٔ تازه تأیید نمی‌شود.
fresh();
snap(10, 30);
woo_order(9922, [[122, 2]]);
$GLOBALS['wpdb']->pdo->exec('UPDATE wp_lmc_stock_hold SET created_at = ' . (time() - 7200));
$row = LMC_Stock_Ledger::unresolved()[0];
LMC_Stock_Ledger::release_hold(9922, 122, ['qty' => $row['qty'], 'confirmed' => $row['confirmed'], 'created_at' => $row['created_at'],
    'ack_rev' => $row['ack_rev'], 'ack_epoch' => $row['ack_epoch'], 'epoch' => LMC_Stock_Ledger::epoch()], 'در Core دیدم', 'manager');
LMC_Stock_Ledger::reset_epoch(null);
$GLOBALS['feed'] = ['items' => [['available' => '10', 'stockRev' => '7', 'variationId' => VAR_ID, 'sku' => 'SKU-42']], 'cursor' => 'C7'];
LMC_Stock_Sync::run();
check('R13. درخواست دورهٔ قبل در دورهٔ تازه تأیید نمی‌شود (۱۰−۲)', [stock(), holds_unacked()], [8, 1]);
$GLOBALS['can'] = false;

// ── R12. «فعال‌شدن پروتکل» از دیتابیس، نه از Cache درخواست ────────────
fresh();
$GLOBALS['options'][LMC_Stock_Ledger::ACTIVE] = false;                       // درخواستی که پیش‌تر false خوانده
$GLOBALS['wpdb']->pdo->exec("INSERT OR REPLACE INTO wp_options (option_name, option_value) VALUES ('" . LMC_Stock_Ledger::ACTIVE . "', '1')");
stock_set(P, 4);
$r = LMC_Stock_Ledger::apply_legacy(P, 9, 0);
check('R12. فعال‌شدن هم‌زمان در پردازهٔ دیگر: legacy با Cache کهنه رد شد', [$r['rejected'] ?? false, stock()], [true, 4]);

// ── R10. موتور بی تراکنش: نشاندن بسته، نه «کار کند ولی ناامن» ─────────
fresh();
$GLOBALS['engine'] = 'MyISAM';
(new ReflectionProperty(LMC_Stock_Ledger::class, 'transactional'))->setValue(null, null);
$r = snap(5, 10);
check('R10. postmeta غیر InnoDB: نشانده نشد', [$r['blocked'] ?? false, stock()], [true, 0]);
(new ReflectionProperty(LMC_Stock_Ledger::class, 'transactional'))->setValue(null, null);

@unlink($db_file);
if ($failed > 0) { fwrite(STDERR, "✗ $failed ادعا شکست خورد ($checks پاس)\n"); exit(1); }
echo "✓ همه $checks ادعای دفتر کسر و واترمارک مشترک پاس شدند\n";
