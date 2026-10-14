<?php
/**
 * دفتر کسر محلی و واترمارک مشترک Push/Pull — docs/STOCK-SYNC-PROTOCOL.md.
 *
 *   php integrations/woocommerce/test/stock-ledger-test.php
 *
 * SQL خودِ `LMC_Stock_Ledger` روی SQLite واقعی اجرا می‌شود (نه یک آرایهٔ ساختگی)،
 * پس شرط‌های `ack_rev IS NULL OR ack_rev > rev` همان‌اند که روی MySQL می‌روند.
 * هر سناریو یک «کنترل منفی» دارد: مسیر قدیمی (نشاندن بی واترمارک و بی دفتر،
 * همان کاری که Pull پیش از این می‌کرد) روی همان ورودی عدد غلط می‌دهد؛ پس ادعا
 * چیزی را واقعاً می‌سنجد.
 */

declare(strict_types=1);

define('ABSPATH', __DIR__);
if (!extension_loaded('pdo_sqlite')) {
    fwrite(STDERR, "pdo_sqlite لازم است؛ این آزمون بی آن معنا ندارد و رد نمی‌شود.\n");
    exit(1);
}

function lmc_setting(string $key, $default = '') { return $GLOBALS['settings'][$key] ?? $default; }
function lmc_log(string $m): void { $GLOBALS['logs'][] = $m; }
function __($t, $d = '') { return $t; }
function add_action(...$a): void {}
function get_option($k, $d = false) { return $GLOBALS['options'][$k] ?? $d; }
function update_option($k, $v, $a = null) { $GLOBALS['options'][$k] = $v; return true; }
function delete_option($k) { unset($GLOBALS['options'][$k]); return true; }
function dbDelta($sql) { return []; }
function wp_cache_delete($id, $group) { $GLOBALS['cache_deletes'] = ($GLOBALS['cache_deletes'] ?? 0) + 1; return true; }
function get_post_meta($id, $k, $s = false) { return $GLOBALS['meta'][$id][$k] ?? ''; }
function update_post_meta($id, $k, $v) { $GLOBALS['meta'][$id][$k] = (string) $v; return true; }
function delete_post_meta($id, $k) { unset($GLOBALS['meta'][$id][$k]); return true; }
function get_posts($args) { return [(int) ($GLOBALS['by_variation'][$args['meta_value']] ?? 0)] ?: []; }
function wc_get_product($id) { return isset($GLOBALS['stock'][$id]) ? new Product((int) $id) : false; }
function wp_schedule_single_event(...$a) { $GLOBALS['scheduled'][] = $a; }
function is_wp_error($v) { return $v instanceof WP_Error; }
class WP_Error {
    public function __construct(public $code = '', public $message = '', public $data = []) {}
    public function get_error_message() { return $this->message; }
}

const WH  = '00000000-0000-7000-8000-000000000101';
const WH2 = '00000000-0000-7000-8000-000000000202';
const P   = 42;
$GLOBALS['settings'] = ['sync_stock' => 'yes', 'sync_price' => 'no', 'warehouse_id' => WH];

/** کالای ووکامرس: موجودی در `$GLOBALS['stock']`، مثل `_stock` در دیتابیس. */
class Product
{
    public function __construct(private int $id) {}
    public function get_id() { return $this->id; }
    public function get_stock_managed_by_id() { return $this->id; }
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
    public ?int $pending = null;
    public function save() { if ($this->pending !== null) { $GLOBALS['stock'][$this->id] = $this->pending; } }
}

/** `$wpdb` روی SQLite؛ قفل مشورتی MySQL با یک آرایه تقلید می‌شود (نگه‌داشتهٔ «دیگری» یعنی ۰). */
class SqliteWpdb
{
    public string $prefix = 'wp_';
    public string $last_error = '';
    public PDO $pdo;
    public function __construct(string $file)
    {
        $this->pdo = new PDO('sqlite:' . $file);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS wp_lmc_stock_hold (order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
            qty INTEGER NOT NULL, ack_rev INTEGER NULL, created_at INTEGER NOT NULL, PRIMARY KEY (order_id, product_id))');
    }
    public function prepare($q, ...$a)
    {
        $i = 0;
        return preg_replace_callback('/%[sd]/', function ($m) use (&$i, $a) {
            $v = $a[$i++];
            return $m[0] === '%d' ? (string) (int) $v : $this->pdo->quote((string) $v);
        }, $q);
    }
    public function get_var($q)
    {
        if (preg_match("/GET_LOCK\\('([^']+)', (\\d+)\\)/", $q, $m)) {
            if (($GLOBALS['other_holds'][$m[1]] ?? false) === true) { return '0'; }
            $GLOBALS['locks_taken'][] = $m[1];
            return '1';
        }
        $row = $this->pdo->query($q)->fetch(PDO::FETCH_NUM);
        return $row === false ? null : ($row[0] === null ? null : (string) $row[0]);
    }
    public function query($q)
    {
        if (str_contains($q, 'RELEASE_LOCK')) { return 1; }
        return $this->pdo->exec($q);
    }
}

require __DIR__ . '/../labelmod-connector/includes/class-lmc-push-guard.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-stock-sync.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-stock-ledger.php';

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
    $GLOBALS['other_holds'] = [];
}
function stock(): int { return $GLOBALS['stock'][P]; }
/** کسر محلی ووکامرس: خودش `_stock` را کم می‌کند، بعد Hook ما. */
function woo_order(int $order, int $qty): void
{
    $GLOBALS['stock'][P] -= $qty;
    LMC_Stock_Ledger::on_reduce(new Item($qty), ['product' => new Product(P)], new Order($order));
}
function woo_cancel(int $order, int $qty): void
{
    $GLOBALS['stock'][P] += $qty;
    LMC_Stock_Ledger::on_restore(new Item($qty), 0, 0, new Order($order), new Product(P));
}
function snap(int $avail, int $rev, ?int $version = null, string $wh = WH): array
{
    return LMC_Stock_Ledger::apply_snapshot(P, $avail, $rev, $wh, 0, $version);
}
function ack(int $order, ?int $rev): void
{
    LMC_Stock_Ledger::ack_order(new Order($order), $rev === null ? null : [['sku' => 'SKU-' . P, 'variationId' => 'v', 'stockRev' => (string) $rev]]);
}
class Item {
    public function __construct(public int $qty) {}
    public function get_quantity() { return $this->qty; }
    public function get_product() { return new Product(P); }
}
class Order {
    public function __construct(public int $id) {}
    public function get_id() { return $this->id; }
    public function get_items() { return [new Item(1)]; }
}
/** مسیر پیش از این تغییر: Pull عدد Core را بی واترمارک و بی دفتر می‌نشاند. */
function old_pull(int $avail): int
{
    $p = new Product(P);
    LMC_Stock_Sync::apply_stock($p, $avail);
    $p->save();
    return stock();
}

// ── ۰. نام قفل و نسخه همانِ گیرندهٔ Push است ─────────────────────────
$receiver = file_get_contents(__DIR__ . '/../labelmod-connector/includes/class-lmc-push-receiver.php');
preg_match("/STOCK_VERSION_META = '([^']+)'/", $receiver, $m);
check('VERSION_META همان STOCK_VERSION_META گیرندهٔ Push است', LMC_Stock_Ledger::VERSION_META, $m[1] ?? null);

// ── ۱. Pull کهنه پس از Push تازه ─────────────────────────────────────
fresh();
snap(3, 10, 500);                                 // Push: rev 10، موجودی ۳
$r = snap(5, 8);                                  // Pull ساخته‌شده پیش از آن: rev 8، موجودی ۵
check('۱. Pull کهنه رد شد', $r['stale'] ?? false, true);
check('۱. موجودی همان Push تازه ماند', stock(), 3);
check('۱. کنترل منفی: مسیر قدیم Pull عدد کهنه را می‌نشاند', old_pull(5), 5);

// ── ۲. کسر محلی تأییدنشده و عکس بعدی Core ───────────────────────────
fresh();
snap(5, 10);
woo_order(1001, 1);                               // سفارش سایت: ووکامرس ۵→۴
check('۲. پس از کسر محلی ۴', stock(), 4);
snap(4, 11);                                      // فروش حضوری یک واحد دیگر؛ Core هنوز سفارش را ندیده
check('۲. عکس پیش از ACK واحد فروخته‌شده را برنمی‌گرداند (۴−۱)', stock(), 3);
ack(1001, 12);                                    // Core رزرو کرد؛ عکس ≥۱۲ آن را دارد
check('۲. ACK با واترمارک بالاتر از عکس نشسته هنوز کسر می‌کند', stock(), 3);
snap(3, 12);                                      // Push پس از رزرو
check('۲. عکسِ شامل سفارش: دوبار کم نمی‌شود', stock(), 3);
check('۲. کسر تسویه و حذف شد', LMC_Stock_Ledger::pending(P, 0), 0);
$GLOBALS['stock'][P] = 4;
check('۲. کنترل منفی: مسیر قدیم با عکس پیش از ACK (۴) واحد را برمی‌گرداند', old_pull(4), 4);

// ── ۳. Push کهنه پس از ACK ───────────────────────────────────────────
fresh();
snap(5, 10);
woo_order(1002, 1);
ack(1002, 12);
snap(4, 12, 900);                                 // Push شامل سفارش
$r = snap(5, 11, 899);                            // Push معوق ساخته‌شده پیش از رزرو
check('۳. Push کهنه پس از ACK رد شد', $r['stale'] ?? false, true);
check('۳. واحد فروخته‌شده برنگشت', stock(), 4);

// ── ۴. عکس معوقِ پیش از ACK که پس از ACK می‌رسد ──────────────────────
fresh();
snap(5, 10);
woo_order(1003, 1);
ack(1003, 12);
snap(5, 11);                                      // ساخته‌شده پیش از رزرو، تازه‌تر از عکس نشسته
check('۴. عکس پیش از ACK: کسر هنوز اعمال است (۵−۱)', stock(), 4);
check('۴. کنترل منفی: مسیر قدیم ۵ نشان می‌دهد', old_pull(5), 5);

// ── ۵. ترتیب ACK و Push معکوس: دوبار کم شدن فقط موقت است ─────────────
fresh();
snap(5, 10);
woo_order(1004, 1);
snap(4, 12);                                      // Push شامل سفارش پیش از پردازش ACK
check('۵. پیش از ACK محافظه‌کار: ۴−۱', stock(), 3);
ack(1004, 12);
check('۵. ACK همان لحظه بازمحاسبه می‌کند؛ دوبار کم نمی‌شود', stock(), 4);
ack(1004, 15);
check('۵. تکرار ACK چیزی را عوض نمی‌کند', stock(), 4);

// ── ۶. دو سفارش یک SKU، لغو پیش و پس از ACK ──────────────────────────
fresh();
snap(10, 20);
woo_order(2001, 1);
woo_order(2002, 2);
check('۶. دو کسر محلی', stock(), 7);
woo_cancel(2002, 2);                              // لغو پیش از ACK
check('۶. لغو پیش از ACK: فقط کسر خودش برمی‌گردد', stock(), 9);
ack(2001, 21);
snap(9, 21);
check('۶. ACK و عکس شامل', stock(), 9);
woo_order(2003, 2);
ack(2003, 22);
snap(7, 22);
check('۶. سفارش سوم پس از رزرو Core', stock(), 7);
woo_cancel(2003, 2);                              // لغو پس از ACK؛ Core هنوز آزاد نکرده
check('۶. لغو پس از ACK تا آزادسازی Core بیش از واقع نشان نمی‌دهد', stock(), 7);
snap(9, 23);                                      // آزادسازی رزرو در Core
check('۶. پس از آزادسازی Core', stock(), 9);

// ── ۷. تکرار و ترتیب معکوس پیام‌ها ───────────────────────────────────
fresh();
check('۷. Push نخست نشست', snap(6, 30, 1000)['applied'] ?? null, true);
check('۷. تکرار همان Push دور ریخته شد', snap(6, 30, 1000)['stale'] ?? false, true);
check('۷. Pull هم‌واترمارک دور ریخته شد', snap(6, 30)['stale'] ?? false, true);
check('۷. Push با نسخهٔ تازه ولی واترمارک کهنه رد شد', snap(9, 29, 1001)['stale'] ?? false, true);
check('۷. موجودی ثابت ماند', stock(), 6);

// ── ۸. بازراه‌اندازی و قطعی: کسر پایدار است، بی TTL ─────────────────
fresh();
snap(5, 40);
woo_order(3001, 2);
$GLOBALS['wpdb'] = new SqliteWpdb($db_file);      // پردازهٔ تازه، همان دیتابیس
check('۸. پس از بازراه‌اندازی کسر هنوز هست', LMC_Stock_Ledger::pending(P, 40), 2);
snap(5, 41);                                      // Core هنوز سفارش را ندیده (قطعی)
check('۸. عکس پس از بازراه‌اندازی هنوز کسر می‌کند', stock(), 3);

// ── ۹. قفل مشترک: Push در دست ⇒ Pull منتظر/مشغول، بی نوشتن ─────────
fresh();
snap(5, 50);
$GLOBALS['other_holds'][LMC_Stock_Ledger::lock_name(P)] = true;
$r = snap(1, 51);
check('۹. قفل در دست دیگری: مشغول', $r['busy'] ?? false, true);
check('۹. بی قفل چیزی نوشته نشد', stock(), 5);
check('۹. Push و Pull یک نام قفل دارند', LMC_Stock_Ledger::lock_name(P), LMC_Push_Guard::lock_name(P, '_lmc_stock_version'));

// ── ۱۰. تغییر انبار: واترمارک انبار دیگر مقایسه‌پذیر نیست ───────────
fresh();
snap(5, 60);
check('۱۰. انبار تازه با واترمارک کوچک‌تر پذیرفته شد', snap(2, 3, null, WH2)['applied'] ?? null, true);
check('۱۰. موجودی انبار تازه', stock(), 2);

// ── ۱۱. Core قدیمی (پاسخ بی stock): ACK با واترمارک ۰ ──────────────
fresh();
snap(5, 70);
woo_order(4001, 1);
ack(4001, null);
check('۱۱. ACK بی واترمارک در هر عکس واترمارک‌دار شامل است', stock(), 5);
snap(4, 71);
check('۱۱. و عکس بعدی دوبار کم نمی‌کند', stock(), 4);

// ── ۱۲. بازمحاسبه بی عکس واترمارک‌دار (Core قدیمی) کسر ووکامرس را نگه می‌دارد ──
fresh();
$GLOBALS['stock'][P] = 5;
woo_order(5001, 1);
check('۱۲. بی واترمارک، کسر خودِ ووکامرس می‌ماند', stock(), 4);

@unlink($db_file);
if ($failed > 0) { fwrite(STDERR, "✗ $failed ادعا شکست خورد ($checks پاس)\n"); exit(1); }
echo "✓ همه $checks ادعای دفتر کسر و واترمارک مشترک پاس شدند\n";
