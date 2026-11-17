<?php
/**
 * نگه‌داشت موجودی پیش از پرداخت (LMC_Checkout_Hold) با کلاینت HTTP جعلی.
 * رفتار Core در db/test/web-checkout-hold.sql و آزمون یکپارچهٔ API سنجیده می‌شود؛ اینجا
 * قرارداد افزونه: چه زمانی پرداخت متوقف می‌شود، چه زمانی **نمی‌شود**، و چه پیامی می‌بیند.
 */
declare(strict_types=1);
define('ABSPATH', __DIR__);
$settings = ['branch_id' => 'b', 'warehouse_id' => 'w'];
$orders = []; $hooks = []; $notices = [];
function lmc_setting($k, $default = '') { global $settings; return $settings[$k] ?? $default; }
function wc_get_order($id) { global $orders; return $orders[$id] ?? false; }
function add_action($hook, $callback, $priority = 10, $args = 1) { global $hooks; $hooks[$hook][] = [$callback, $priority]; }
function wc_add_notice($m, $type) { global $notices; $notices[] = [$type, $m]; }
function is_wp_error($v) { return $v instanceof WP_Error; }
class WP_Error {
    public function __construct(public $code, public $message) {}
    public function get_error_message() { return $this->message; }
}
class WC_Order_Item_Product {
    public function __construct(public $sku = 'SKU-1', public $qty = 1, public $name = 'شلوار مام فیونا - مشکی، S') {}
    public function get_quantity() { return $this->qty; }
    public function get_product() { return $this; }
    public function get_sku() { return $this->sku; }
    public function get_name() { return $this->name; }
}
class WC_Order {
    public $meta = []; public $items; public $notes = [];
    public function __construct(public $id) { $this->items = [new WC_Order_Item_Product()]; }
    public function get_id() { return $this->id; }
    public function get_meta($k) { return $this->meta[$k] ?? ''; }
    public function update_meta_data($k, $v) { $this->meta[$k] = $v; }
    public function get_items() { return $this->items; }
    public function save() {}
    public function add_order_note($n) { $this->notes[] = $n; }
}
class LMC_Order_Reservation { const PAYLOAD = '_lmc_reservation_payload'; }
class LMC_Client {
    public static $calls = []; public static $result = ['status' => 'held', 'expiresAt' => '2026-11-17T10:20:00Z'];
    public static function post($path, $payload, $timeout = 20) {
        self::$calls[] = [$path, $payload, $timeout];
        return self::$result;
    }
}
require __DIR__ . '/../labelmod-connector/includes/class-lmc-checkout-hold.php';

$checks = 0;
function check($ok, $label) { global $checks; if (!$ok) { throw new Exception($label); } $checks++; }
function threw(callable $fn): ?string { try { $fn(); return null; } catch (Exception $e) { return $e->getMessage(); } }

LMC_Checkout_Hold::init();
foreach (['woocommerce_checkout_order_processed', 'woocommerce_store_api_checkout_order_processed',
          'woocommerce_before_pay_action', 'woocommerce_order_status_changed'] as $h) {
    check(isset($hooks[$h]), "رویداد $h متصل است");
}
check($hooks['woocommerce_checkout_order_processed'][0][1] < 10, 'نگه‌داشت پیش از رزرو پرداخت در محل (اولویت ۱۰) اجرا می‌شود');

// ── ۱. نگه داشته شد: پرداخت ادامه می‌یابد ───────────────────────────
$orders[11] = $o = new WC_Order(11);
check(threw(fn () => LMC_Checkout_Hold::classic(11, [], $o)) === null, 'نگه‌داشت موفق پرداخت را متوقف نمی‌کند');
check(LMC_Client::$calls[0] === ['/web/checkout-holds',
    ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => '11', 'lines' => [['sku' => 'SKU-1', 'qty' => '1']]], 5],
    'همان شناسهٔ سفارشِ ثبت در Core، فقط SKU و تعداد، با مهلت کوتاه ۵ ثانیه');
check($o->get_meta(LMC_Checkout_Hold::META_STATE) === 'held' && $o->get_meta(LMC_Checkout_Hold::META_EXPIRES) !== '', 'وضعیت و مهلت روی سفارش');

// ── ۲. فروخته شده: پرداخت پیش از بانک متوقف می‌شود ─────────────────
LMC_Client::$result = ['status' => 'unavailable', 'unavailable' => [['sku' => 'SKU-1', 'available' => '0', 'heldByCheckout' => false]]];
$orders[12] = $o = new WC_Order(12);
$msg = threw(fn () => LMC_Checkout_Hold::classic(12, [], $o));
check($msg !== null && str_contains($msg, 'شلوار مام فیونا') && str_contains($msg, 'فروخته شد'), 'پیام نام کالا و «فروخته شد» را می‌گوید');
check(str_contains($msg, 'مبلغی از حساب شما برداشت نشده'), 'مشتری می‌داند پولی کم نشده');
check($o->get_meta(LMC_Checkout_Hold::META_STATE) === 'unavailable' && count($o->notes) === 1, 'یادداشت سفارش برای مدیر');
check(threw(fn () => LMC_Checkout_Hold::blocks($o)) !== null, 'پرداخت بلوکی هم متوقف می‌شود');
$notices = [];
LMC_Checkout_Hold::pay($o);
check(count($notices) === 1 && $notices[0][0] === 'error', '«پرداخت دوباره» با خطای صفحه متوقف می‌شود (درگاه صدا زده نمی‌شود)');

// ── ۳. در حال پرداخت مشتری دیگر ──────────────────────────────────────
LMC_Client::$result['unavailable'][0]['heldByCheckout'] = true;
$msg = threw(fn () => LMC_Checkout_Hold::classic(12, [], $o));
check($msg !== null && str_contains($msg, 'مشتری دیگری') && !str_contains($msg, 'فروخته شد'), 'پیام «در حال پرداخت مشتری دیگر»، نه «فروخته شد»');

// ── ۴. Core در دسترس نیست: فروش آنلاین نمی‌ایستد ───────────────────
LMC_Client::$result = new WP_Error('lmc_network', 'ارتباط برقرار نشد');
$orders[13] = $o = new WC_Order(13);
check(threw(fn () => LMC_Checkout_Hold::classic(13, [], $o)) === null, 'خطای شبکه پرداخت را متوقف نمی‌کند');
check($o->get_meta(LMC_Checkout_Hold::META_STATE) === 'failed' && str_contains($o->notes[0], 'بدون تضمین موجودی'), 'ولی روی سفارش ثبت می‌شود');
LMC_Client::$result = ['status' => 'chaos'];
$orders[14] = $o = new WC_Order(14);
check(threw(fn () => LMC_Checkout_Hold::classic(14, [], $o)) === null && $o->get_meta(LMC_Checkout_Hold::META_STATE) === 'failed', 'پاسخ ناشناخته هم fail-open و ثبت‌شده');

// ── ۵. رزرو پرداخت در محل یا سفارش ثبت‌شده: کاری لازم نیست ─────────
foreach (['reserved', 'consumed'] as $st) {
    LMC_Client::$result = ['status' => $st];
    $orders[15] = $o = new WC_Order(15);
    check(threw(fn () => LMC_Checkout_Hold::classic(15, [], $o)) === null && $o->notes === [], "وضعیت $st بی‌صدا ادامه می‌دهد");
}

// ── ۶. بی SKU یا بی پیکربندی: هیچ درخواستی ─────────────────────────
$n = count(LMC_Client::$calls);
$orders[16] = $o = new WC_Order(16); $o->items[0]->sku = '';
check(threw(fn () => LMC_Checkout_Hold::classic(16, [], $o)) === null && count(LMC_Client::$calls) === $n, 'قلم بی SKU: نگه‌داشت ناقص فرستاده نمی‌شود');
$settings['warehouse_id'] = '';
$orders[17] = $o = new WC_Order(17);
check(threw(fn () => LMC_Checkout_Hold::classic(17, [], $o)) === null && count(LMC_Client::$calls) === $n, 'اتصال پیکربندی‌نشده: رفتار پیشین');
$settings['warehouse_id'] = 'w';

// ── ۷. لغو آزاد می‌کند؛ پرداخت ناموفق نه ────────────────────────────
LMC_Client::$result = ['status' => 'released'];
$orders[18] = $o = new WC_Order(18); $o->meta[LMC_Checkout_Hold::META_STATE] = 'held';
$n = count(LMC_Client::$calls);
LMC_Checkout_Hold::status_changed(18, 'pending', 'failed');
check(count(LMC_Client::$calls) === $n, 'پرداخت ناموفق نگه‌داشت را آزاد نمی‌کند (مشتری معمولاً دوباره می‌پردازد)');
LMC_Checkout_Hold::status_changed(18, 'failed', 'cancelled');
check(end(LMC_Client::$calls) === ['/web/order-reservations/release', ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => '18'], 5],
    'لغو همان سفارش را آزاد می‌کند');
check($o->get_meta(LMC_Checkout_Hold::META_STATE) === 'released', 'وضعیت آزادشده');
$orders[19] = $o = new WC_Order(19); $o->meta[LMC_Checkout_Hold::META_STATE] = 'held';
$o->meta[LMC_Order_Reservation::PAYLOAD] = ['externalId' => '19'];
$n = count(LMC_Client::$calls);
LMC_Checkout_Hold::status_changed(19, 'processing', 'cancelled');
check(count(LMC_Client::$calls) === $n, 'سفارش پرداخت در محل را رزرو خودش آزاد می‌کند، نه این کلاس');
LMC_Client::$result = new WP_Error('lmc_network', 'قطع');
$orders[20] = $o = new WC_Order(20); $o->meta[LMC_Checkout_Hold::META_STATE] = 'held';
LMC_Checkout_Hold::status_changed(20, 'pending', 'cancelled');
check($o->get_meta(LMC_Checkout_Hold::META_STATE) === 'held' && str_contains(end($o->notes), 'پایان مهلت'), 'شکست آزادسازی: مهلت Core پشتوانه است');

echo "✔ نگه‌داشت پیش از پرداخت — $checks ادعا\n";
