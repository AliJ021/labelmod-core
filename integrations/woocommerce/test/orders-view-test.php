<?php
/**
 * قرارداد «سفارش‌های سایت» در افزونه — فقط‌خواندنی، CRUD رسمی، صفحه‌بندی محدود، دادهٔ شخصی حداقلی.
 *
 * این آزمون محلی است و نصب واقعی نیست. HPOS و جدول پست روی ووکامرس واقعی در
 * `test/real-wc/orders_view.php` سنجیده می‌شوند. اینجا ادعا دربارهٔ خود کلاس است:
 * - فقط از `wc_get_orders` با `paginate` و سقف صفحه می‌خواند.
 * - به `$wpdb` دست نمی‌زند.
 * - هیچ سفارشی را ذخیره نمی‌کند.
 * - تلفن، ایمیل، نشانی و متن خطا را بیرون نمی‌دهد.
 */
declare(strict_types=1);
define('ABSPATH', __DIR__);
$settings = ['branch_id' => '00000000-0000-7000-8000-000000000001', 'warehouse_id' => '00000000-0000-7000-8000-000000000101',
    'currency_unit' => 'toman'];
$routes = []; $queries = [];
function lmc_setting($key, $default = '') { global $settings; return $settings[$key] ?? $default; }
function add_action($hook, $callback) { $callback(); }
function register_rest_route($ns, $path, $args) { global $routes; $routes[$ns . $path] = $args; }
function home_url() { return 'https://shop.example.test/'; }
function untrailingslashit($value) { return rtrim($value, '/'); }
function is_wp_error($value) { return $value instanceof WP_Error; }
class WP_Error {
    private $code; private $message; private $data;
    function __construct($code, $message, $data = []) { $this->code = $code; $this->message = $message; $this->data = $data; }
    function get_error_code() { return $this->code; }
    function get_error_data() { return $this->data; }
}
class WP_REST_Response {
    public $data; public $status;
    function __construct($data, $status) { $this->data = $data; $this->status = $status; }
}
class WC_DateTime { private $ts; function __construct($ts) { $this->ts = $ts; } function getTimestamp() { return $this->ts; } }
class WC_Order_Item_Product {
    function __construct(public string $name, public int $qty, public string $total, public string $sku) {}
    function get_name() { return $this->name; }
    function get_quantity() { return $this->qty; }
    function get_total() { return $this->total; }
    function get_product() { $sku = $this->sku; return new class($sku) { function __construct(private string $s) {} function get_sku() { return $this->s; } }; }
}
class WC_Order_Item_Shipping { function get_quantity() { return 1; } }
class WC_Order {
    public array $meta = []; public array $items = [];
    function __construct(public int $id, public string $status, public string $total, public string $type = 'shop_order') {}
    function get_id() { return $this->id; }
    function get_type() { return $this->type; }
    function get_order_number() { return (string) $this->id; }
    function get_status() { return $this->status; }
    function get_date_created() { return new WC_DateTime(1792500000 + $this->id); }
    function get_total() { return $this->total; }
    function get_shipping_total() { return '50000'; }
    function get_discount_total() { return '0.5'; }
    function get_items() { return $this->items; }
    function get_billing_first_name() { return "علی\x07"; }
    function get_billing_last_name() { return 'رضایی'; }
    function get_billing_phone() { return '09121234567'; }
    function get_billing_email() { return 'secret@example.test'; }
    function get_billing_address_1() { return 'خیابان محرمانه'; }
    function get_payment_method_title() { return 'زرین‌پال'; }
    function get_meta($key) { return $this->meta[$key] ?? ''; }
    function save() { throw new Exception('نمایش سفارش نباید ذخیره کند'); }
    function update_meta_data(...$a) { throw new Exception('نمایش سفارش نباید متا بنویسد'); }
}
$store = [];
for ($i = 1; $i <= 7; $i++) { $store[$i] = new WC_Order($i, $i % 2 ? 'processing' : 'completed', '1200000'); }
$store[3]->total = '1200000.55';                      // کسری از ریال در واحد تومان → null، نه گرد
$store[5]->status = 'checkout-draft';                 // وضعیت ناشناخته → «unknown»، نه جعل
$store[2]->items = [new WC_Order_Item_Product('پیراهن سفید', 2, '800000', 'SKU-1'), new WC_Order_Item_Shipping()];
$store[2]->meta = ['_lmc_payment_complete' => 'yes', '_lmc_invoice_id' => 'uuid', '_lmc_invoice_number' => '۱۴۰۵-۰۰۱۲',
    '_lmc_attempts' => '2', '_lmc_last_error' => 'خطا با 09121234567', '_lmc_order_stopped' => ''];
$store[8] = new WC_Order(8, 'refunded', '1000', 'shop_order_refund');
function wc_get_orders($args) {
    global $store, $queries; $queries[] = $args;
    $all = array_values(array_filter($store, fn ($o) => $o->type === $args['type']
        && (!isset($args['status']) || in_array($o->status, $args['status'], true))));
    usort($all, fn ($a, $b) => $b->id <=> $a->id);
    $slice = array_slice($all, ($args['paged'] - 1) * $args['limit'], $args['limit']);
    return (object) ['orders' => $slice, 'total' => count($all), 'max_num_pages' => (int) ceil(count($all) / $args['limit'])];
}
function wc_get_order($id) { global $store; return $store[$id] ?? false; }
// هر دسترسی به پایگاه داده خطاست: فقط CRUD رسمی، تا HPOS و جدول پست یکسان باشند.
$wpdb = new class { function __call($m, $a) { throw new Exception("SQL مستقیم ممنوع: {$m}"); } function __get($n) { throw new Exception("جدول مستقیم ممنوع: {$n}"); } };

require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-order-sync.php';
class LMC_Push_Receiver { const NS = 'lmc/v1'; static function verify_request() { return true; } }
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-orders-view.php';
$checks = 0;
function check($value, $label) { global $checks; if (!$value) { throw new Exception($label); } $checks++; }
function req(array $body) { return new class($body) { function __construct(private array $b) {} function get_json_params() { return $this->b; } }; }

LMC_Orders_View::init();
check($routes['lmc/v1/orders']['permission_callback'] === [LMC_Push_Receiver::class, 'verify_request'], 'همان نگهبان امضا و nonce');
check($routes['lmc/v1/orders']['methods'] === 'POST', 'بدنهٔ امضاشده، نه query بی‌امضا');

// ── فهرست ──
$r = LMC_Orders_View::handle(req(['page' => 1, 'perPage' => 3]));
check($r instanceof WP_REST_Response && $r->status === 200, 'فهرست');
$d = $r->data;
check($d['siteUrl'] === 'https://shop.example.test' && $d['branchId'] === $settings['branch_id'] && $d['warehouseId'] === $settings['warehouse_id'], 'هویت سایت و دامنه');
check($d['total'] === 7 && $d['pages'] === 3 && count($d['orders']) === 3, 'شمار کل از ووکامرس، نه از صفحه');
check(array_column($d['orders'], 'id') === [7, 6, 5], 'تازه‌ترین اول');
check(count($d['orders']) === 3 && !in_array(8, array_column($d['orders'], 'id'), true), 'استرداد سفارش نیست');
$q = end($queries);
check($q['paginate'] === true && $q['limit'] === 3 && $q['paged'] === 1 && $q['type'] === 'shop_order', 'صفحه‌بندی CRUD رسمی');
check(!isset($q['status']), 'بی فیلتر، وضعیت پیش‌فرض ووکامرس');
foreach ($queries as $q) { check($q['limit'] > 0 && $q['limit'] <= 50, 'هرگز limit=-1 یا بیش از ۵۰'); }
$o5 = $d['orders'][2];
check($o5['status'] === 'unknown', 'وضعیت ناشناخته جعل نمی‌شود');
check($o5['createdAt'] === gmdate('Y-m-d\TH:i:s\Z', 1792500005), 'زمان ISO با Z');
check($o5['totalRial'] === '12000000', 'تومان → ریال رشته‌ای');
check($o5['customerName'] === 'علی رضایی', 'نام صورت‌حساب، بی نویسهٔ کنترلی');

$r = LMC_Orders_View::handle(req(['page' => 2, 'perPage' => 2, 'status' => 'processing']));
check($r->data['total'] === 3 && array_column($r->data['orders'], 'id') === [1], 'فیلتر وضعیت و صفحهٔ دوم');
check(end($queries)['status'] === ['processing'], 'وضعیت به ووکامرس می‌رود');
check(LMC_Orders_View::handle(req(['page' => 9, 'perPage' => 3]))->data['orders'] === [], 'صفحهٔ بیرون از بازه خالی است، نه خطا');
$all = LMC_Orders_View::handle(req([]))->data;
$o3 = array_values(array_filter($all['orders'], fn ($o) => $o['id'] === 3))[0];
check($o3['totalRial'] === null, 'کسری از ریال null است، نه گرد');
check($all['perPage'] === 20 && $all['page'] === 1, 'پیش‌فرض صفحه');

// ── ورودی نامعتبر ──
foreach ([['page' => 0], ['page' => 201], ['perPage' => 51], ['perPage' => -1], ['page' => '1'], ['status' => 'trash'],
          ['status' => 'wc-processing'], ['limit' => -1], ['orderId' => 2, 'page' => 1], ['orderId' => '2'], ['orderId' => 0]] as $bad) {
    $e = LMC_Orders_View::handle(req($bad));
    check(is_wp_error($e) && $e->get_error_data()['status'] === 400, 'رد: ' . json_encode($bad));
}

// ── جزئیات ──
$r = LMC_Orders_View::handle(req(['orderId' => 2]));
$o = $r->data['order'];
check($r->status === 200 && $o['id'] === 2 && $r->data['siteUrl'] === 'https://shop.example.test', 'جزئیات با هویت سایت');
check($o['items'] === [['name' => 'پیراهن سفید', 'sku' => 'SKU-1', 'quantity' => 2, 'totalRial' => '8000000']], 'فقط اقلام کالا، ریال رشته‌ای');
check($o['itemCount'] === 2 && $o['itemsTruncated'] === false, 'شمار کالا بی هزینهٔ ارسال');
check($o['shippingRial'] === '500000' && $o['discountRial'] === '5', 'ارسال و تخفیف به ریال');
check($o['core'] === ['paymentConfirmed' => true, 'recorded' => true, 'invoiceNumber' => '۱۴۰۵-۰۰۱۲', 'attempts' => 2, 'hasError' => true, 'stopped' => false], 'وضعیت Core از متای افزونه');
$json = json_encode($r->data, JSON_UNESCAPED_UNICODE);
foreach (['09121234567', 'secret@example.test', 'خیابان محرمانه', 'خطا با'] as $leak) { check(strpos($json, $leak) === false, "نشت: {$leak}"); }
check(is_wp_error(LMC_Orders_View::handle(req(['orderId' => 8]))) && LMC_Orders_View::handle(req(['orderId' => 8]))->get_error_data()['status'] === 404, 'استرداد سفارش نیست');
check(LMC_Orders_View::handle(req(['orderId' => 99]))->get_error_code() === 'lmc_order_not_found', 'ناموجود ۴۰۴');

$many = new WC_Order(9, 'processing', '1');
for ($i = 0; $i < 120; $i++) { $many->items[] = new WC_Order_Item_Product("قلم {$i}", 1, '1', ''); }
$store[9] = $many;
$o = LMC_Orders_View::handle(req(['orderId' => 9]))->data['order'];
check(count($o['items']) === 100 && $o['itemsTruncated'] === true && $o['itemCount'] === 120, 'سقف اقلام صریح است، نه بی‌صدا');
check(strlen(json_encode(LMC_Orders_View::handle(req(['perPage' => 50]))->data)) < 131072, 'پاسخ فهرست زیر سقف بدنهٔ Core');

echo "OK: {$checks} orders-view assertions\n";
