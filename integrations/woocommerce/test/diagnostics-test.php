<?php
/** قرارداد تشخیص محلی؛ این آزمون نصب واقعی وردپرس یا سفارش TEST نیست. */
declare(strict_types=1);
define('ABSPATH', __DIR__);
define('LMC_VERSION', '1.2.0');
define('WC_VERSION', '10.0.0');
define('LMC_STOCK_EVENT', 'lmc_sync_stock');
define('LMC_ORDER_EVENT', 'lmc_send_order');
$settings = ['base_url' => 'https://core.example.test', 'api_key' => 'secret-test-token',
    'branch_id' => '', 'warehouse_id' => '', 'sync_stock' => 'yes'];
$calls = []; $logs = []; $routes = []; $events = []; $response = ['code' => 200, 'body' => '{}'];
function lmc_setting($key, $default = '') { global $settings; return $settings[$key] ?? $default; }
function __($text, $domain = '') { return $text; }
function wp_parse_url($url) { return parse_url($url); }
function wp_json_encode($body, $flags = 0) { return json_encode($body, $flags); }
function wp_safe_remote_request($url, $args) { global $calls, $response; $calls[] = [$url, $args]; return $response; }
function wp_remote_retrieve_response_code($res) { return $res['code']; }
function wp_remote_retrieve_body($res) { return $res['body']; }
function lmc_log($message) { global $logs; $logs[] = $message; }
function is_wp_error($value) { return $value instanceof WP_Error; }
function home_url() { return 'https://shop.example.test'; }
function untrailingslashit($value) { return rtrim($value, '/'); }
function add_action($hook, $callback) { $callback(); }
function register_rest_route($ns, $path, $args) { global $routes; $routes[$ns . $path] = $args; }
function wp_next_scheduled($hook, $args = []) { global $events; return $events[$hook . json_encode($args)] ?? false; }
function wc_get_order($id) { global $order; return $id === 42 ? $order : false; }
class WP_Error {
    private $code; private $message; private $data;
    function __construct($code, $message, $data = []) { $this->code = $code; $this->message = $message; $this->data = $data; }
    function get_error_code() { return $this->code; }
    function get_error_message() { return $this->message; }
    function get_error_data() { return $this->data; }
}
class WP_REST_Response {
    public $data; public $status;
    function __construct($data, $status) { $this->data = $data; $this->status = $status; }
}
class WC_Order_Item_Product {
    function get_quantity() { return 1; }
    function get_product() { return new class {
        function get_sku() { return ''; }
        function get_meta($key) { return ''; }
    }; }
}
$order = new class {
    public $meta = []; public $status = 'processing';
    function get_type() { return 'shop_order'; }
    function get_status() { return $this->status; }
    function get_payment_method() { return 'bacs'; }
    function get_meta($key) { return $this->meta[$key] ?? ''; }
    function has_status($values) { return in_array($this->status, $values, true); }
    function get_items() { return [new WC_Order_Item_Product()]; }
    function save() { throw new Exception('تشخیص نباید سفارش را ذخیره کند'); }
};
$wpdb = new class {
    public $posts = 'wp_posts'; public $postmeta = 'wp_postmeta';
    function prepare($query, ...$args) { return $query; }
    function get_var($query) { if (strpos($query, 'SELECT COUNT') !== 0) { throw new Exception('فقط خواندن'); } return 3; }
};
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-client.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-order-sync.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-receiver.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-diagnostics.php';
$checks = 0;
function check($value, $label) { global $checks; if (!$value) { throw new Exception($label); } $checks++; }

LMC_Diagnostics::init();
check($routes['lmc/v1/diagnostics']['permission_callback'] === [LMC_Push_Receiver::class, 'verify_request'], 'امضا و nonce همان نگهبان تولیدی');
$before = json_encode(get_object_vars($order));
for ($i = 0; $i < 2; $i++) {
    $r = LMC_Diagnostics::report(42);
    check($r['order']['eligible'] === false, 'processing بدون تأیید پرداخت آمادهٔ ارسال نیست');
    check($r['order']['missingSku'] === 1, 'SKU مفقود');
    check($r['order']['missingMapping'] === 1, 'نگاشت مفقود');
    check($r['mapping']['orderIdentity'] === 'sku', 'قرارداد فعلی سفارش');
    check(strpos(json_encode($r), $settings['api_key']) === false, 'نبود راز در گزارش');
}
check(json_encode(get_object_vars($order)) === $before, 'تکرار تشخیص سفارش را تغییر نمی‌دهد');
$order->meta[LMC_Order_Sync::META_PAID] = 'yes';
$order->meta[LMC_Order_Sync::META_ERROR] = 'خطا با راز secret-test-token';
$order->meta[LMC_Order_Sync::META_ATTEMPTS] = 2;
$events[LMC_ORDER_EVENT . '[42]'] = 123;
$r = LMC_Diagnostics::report(42);
check($r['order']['eligible'] && $r['order']['scheduled'] && $r['order']['hasError'], 'آمادگی، صف و شکست معلوم‌اند');
check(strpos(json_encode($r), 'secret-test-token') === false, 'متن خام خطا گزارش نمی‌شود');
$order->status = 'cancelled';
check(!LMC_Diagnostics::report(42)['order']['eligible'], 'سفارش لغوشده آماده نیست');
check(!LMC_Diagnostics::report(99)['order']['found'], 'سفارش ناموجود جعل نمی‌شود');

$request = new class { function get_json_params() { return ['orderId' => '42']; } };
check(is_wp_error(LMC_Diagnostics::handle($request)), 'ورودی نامعتبر رد می‌شود');
LMC_Client::get('/web/connection', ['branchId' => 'sample']);
check(count($calls) === 1 && $calls[0][1]['method'] === 'GET', 'تست افزونه فقط خواندن است');
check($calls[0][1]['redirection'] === 0, 'راز روی تغییر مسیر ارسال نمی‌شود');
check($calls[0][1]['headers']['Authorization'] === 'Bearer secret-test-token', 'کلید در هدر');
check(strpos($calls[0][0], 'secret-test-token') === false, 'کلید در URL نیست');
foreach (['http://core.example.test', 'https://user:pass@core.example.test', 'https://core.example.test?key=secret', 'https://core.example.test#secret'] as $url) {
    $settings['base_url'] = $url;
    check(is_wp_error(LMC_Client::get('/web/connection')), 'مقصد ناامن رد شد');
}
check(count($calls) === 1, 'مقصد نامعتبر درخواست نمی‌سازد');
$settings['base_url'] = 'https://core.example.test';
$response = new WP_Error('network', 'secret-test-token');
$err = LMC_Client::get('/web/connection');
check(LMC_Client::is_retryable($err), 'قطع شبکه قابل تلاش مجدد است');
check(strpos($err->get_error_message() . implode('', $logs), 'secret-test-token') === false, 'خطای شبکه و لاگ بدون راز');
$response = ['code' => 302, 'body' => ''];
$err = LMC_Client::get('/web/connection');
check(!LMC_Client::is_retryable($err), 'redirect شکست دائمی است');
echo "OK: {$checks} diagnostics assertions\n";
