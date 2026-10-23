<?php
/**
 * قرارداد «سفارش‌های سایت» (۳) در افزونه.
 *
 * فقط‌خواندنی، CRUD و جست‌وجوی رسمی، صفحه‌بندی با لنگر تا صفحهٔ ۱۰۰٬۰۰۰، و ارز خود سفارش. این آزمون محلی است
 * و نصب واقعی نیست؛ HPOS و جدول پست روی ووکامرس واقعی در `test/real-wc/orders_view.php` سنجیده می‌شوند.
 *
 * ادعاها دربارهٔ خود کلاس:
 * - فقط از `wc_get_orders`، `wc_order_search` و `wc_get_order_notes` می‌خواند و سفارشی ذخیره نمی‌کند. از `$wpdb` فقط
 *   `prepare`/`esc_like`/نام جدول را برای شرط روش ارسال می‌گیرد و خودش هیچ پرسشی اجرا نمی‌کند.
 * - لنگر ثانیهٔ جاری را بیرون می‌گذارد؛ سفارش هم‌ثانیه دیگر صفحه‌ها را تکرار نمی‌کند (بازبینی ریشه روی 2a4e62e).
 * - ویژگی قلم فقط از کلیدهای تنوع است؛ متای عمومی مثل `integration_token` بیرون می‌ماند.
 * - مبلغ همان عدد ووکامرس با ارز سفارش است. تنظیم سراسری `currency_unit` آن را دستکاری نمی‌کند (بازبینی ریشه روی b363e0a).
 * - صفحهٔ ۲۰۱ و بالاتر خوانده می‌شود. لنگر `until` سفارش تازه را بیرون نگه می‌دارد.
 * - IP، user agent، متای خام و متن خطا برنمی‌گردند.
 */
declare(strict_types=1);
define('ABSPATH', __DIR__);
define('LMC_ORDER_EVENT', 'lmc_send_order');
$settings = ['branch_id' => '00000000-0000-7000-8000-000000000001', 'warehouse_id' => '00000000-0000-7000-8000-000000000101',
    'currency_unit' => 'toman'];
$routes = []; $queries = []; $searches = []; $noteQueries = []; $scheduled = []; $filters = []; $clauses = [];
eval('namespace Automattic\WooCommerce\Utilities; class OrderUtil { public static $on = false; static function custom_orders_table_usage_is_enabled() { return self::$on; } }');
use Automattic\WooCommerce\Utilities\OrderUtil;
function lmc_setting($key, $default = '') { global $settings; return $settings[$key] ?? $default; }
function add_action($hook, $callback) { $callback(); }
function add_filter($hook, $cb, $prio = 10, $args = 1) { global $filters; $filters[$hook][] = $cb; }
function remove_filter($hook, $cb, $prio = 10) { global $filters; $filters[$hook] = array_values(array_filter($filters[$hook] ?? [], fn ($f) => $f !== $cb)); }
function register_rest_route($ns, $path, $args) { global $routes; $routes[$ns . $path] = $args; }
function home_url() { return 'https://shop.example.test/'; }
function untrailingslashit($value) { return rtrim($value, '/'); }
function is_wp_error($value) { return $value instanceof WP_Error; }
function wp_timezone() { return new DateTimeZone('Asia/Tehran'); }
function wp_next_scheduled($hook, $args = []) { global $scheduled; return $scheduled[$hook . json_encode($args)] ?? false; }
function wc_get_order_statuses() { return ['wc-pending' => 'در انتظار پرداخت', 'wc-processing' => 'در حال انجام', 'wc-completed' => 'تکمیل‌شده',
    'wc-awaiting-pickup' => 'آمادهٔ تحویل حضوری', 'wc-bad slug!' => 'نادیده']; }
function wc_get_order_status_name($s) { $all = wc_get_order_statuses(); return $all['wc-' . $s] ?? $s; }
function WC() { return new class { function payment_gateways() { return new class { function payment_gateways() {
    return ['zarinpal' => new class { function get_title() { return 'زرین‌پال'; } }, 'bad id!' => new class { function get_title() { return 'x'; } }]; } }; }
    function shipping() { return new class { function get_shipping_methods() {
        return ['flat_rate' => new class { function get_method_title() { return 'نرخ ثابت'; } },
            'local_pickup' => new class { public $method_title = 'تحویل حضوری'; }, 'bad id!' => new class { function get_method_title() { return 'x'; } }]; } }; } }; }
class WP_Error {
    private $code; private $data;
    function __construct($code, $message, $data = []) { $this->code = $code; $this->data = $data; }
    function get_error_code() { return $this->code; }
    function get_error_data() { return $this->data; }
}
class WP_REST_Response { public $data; public $status; function __construct($data, $status) { $this->data = $data; $this->status = $status; } }
class WC_DateTime { function __construct(private int $ts) {} function getTimestamp() { return $this->ts; } }
class Meta { function __construct(public string $key, public string $display_key, public string $display_value) {} }
class WC_Order_Item_Product {
    function __construct(public int $id, public string $name, public int $qty, public string $total, public string $sku, public bool $mapped = true, public int $variation = 0) {}
    function get_variation_id() { return $this->variation; }
    function get_id() { return $this->id; }
    function get_name() { return $this->name; }
    function get_quantity() { return $this->qty; }
    function get_total() { return $this->total; }
    function get_subtotal() { return (string) ((int) $this->total + 100); }
    function get_subtotal_tax() { return '0'; }
    function get_total_tax() { return '9.5'; }
    // همان چیزی که ووکامرس می‌دهد: هر متای عددی/متنیِ بی «_»، از جمله متای عمومی یک افزونهٔ دیگر.
    function get_formatted_meta_data($p, $all) { return [new Meta('pa_color', 'رنگ', '<p>سفید</p>'), new Meta('size', 'سایز', '42'),
        new Meta('integration_token', 'integration_token', 'SENTINEL-TOKEN-7731'), new Meta('gift_note', 'پیام هدیه', 'تولدت مبارک')]; }
    // GONE: کالا و مادر هر دو حذف شده‌اند. PARENT: فقط تنوع حذف شده و ووکامرس کالای مادرِ متغیر را برمی‌گرداند.
    function get_product() {
        if ($this->sku === 'GONE') { return false; }
        $sku = $this->sku; $mapped = $this->mapped; $variation = $this->variation;
        return new class($sku, $mapped, $variation) { function __construct(private string $s, private bool $m, private int $v) {}
            function get_sku() { return $this->s; } function get_meta($k) { return $this->m ? 'var-uuid' : ''; }
            function is_type($t) { return $this->s === 'PARENT' ? $t === 'variable' : ($t === 'variation' && $this->v > 0); }
            function get_variation_attributes() { return ['attribute_pa_color' => 'white', 'attribute_Size' => '42']; }
            function get_attributes() { return ['pa_color' => new class { function get_variation() { return true; } },
                'size' => new class { function get_variation() { return true; } }, 'material' => new class { function get_variation() { return false; } }]; } };
    }
}
class Line { function __construct(public string $name, public string $total) {}
    function get_name() { return $this->name; } function get_total() { return $this->total; } function get_total_tax() { return '0'; }
    function get_code() { return $this->name; } function get_discount() { return $this->total; } function get_discount_tax() { return '0'; } }
class Refund { function __construct(public int $id) {} function get_id() { return $this->id; } function get_date_created() { return new WC_DateTime(1792600000); }
    function get_amount() { return '25000'; } function get_reason() { return '<b>کالای معیوب</b>'; } }
class WC_Order {
    public array $meta = []; public array $items = []; public array $refunds = []; public int $customer = 0;
    public string $currency = 'IRT'; public int $created;
    function __construct(public int $id, public string $status, public string $total, public string $type = 'shop_order') { $this->created = 1792500000 + intdiv($id, 2); }
    function get_id() { return $this->id; }
    function get_type() { return $this->type; }
    function get_order_number() { return (string) $this->id; }
    function get_status() { return $this->status; }
    function get_date_created() { return new WC_DateTime($this->created); }
    function get_date_paid() { return new WC_DateTime($this->created + 60); }
    function get_date_completed() { return $this->status === 'completed' ? new WC_DateTime($this->created + 3600) : null; }
    function get_date_modified() { return new WC_DateTime($this->created + 7200); }
    function get_total() { return $this->total; }
    function get_currency() { return $this->currency; }
    function get_items($type = 'line_item') { return $type === 'coupon' ? [new Line('SALE10', '1000')] : $this->items; }
    function get_fees() { return [new Line('بسته‌بندی هدیه', '20000')]; }
    function get_shipping_methods() { return [new Line('پست پیشتاز', '50000')]; }
    function get_refunds() { return $this->refunds; }
    function get_customer_id() { return $this->customer; }
    function get_billing_first_name() { return "علی\x07"; }
    function get_billing_last_name() { return 'رضایی'; }
    function get_address($type) { return ['first_name' => 'علی', 'last_name' => 'رضایی', 'company' => '', 'address_1' => "خیابان {$type}",
        'address_2' => '', 'city' => 'تهران', 'state' => 'THR', 'postcode' => '1234567890', 'country' => 'IR', 'phone' => '09121234567',
        'email' => 'ali@example.test']; }
    function get_customer_note() { return 'لطفاً عصر'; }
    function get_customer_ip_address() { return '203.0.113.9'; }
    function get_customer_user_agent() { return 'SecretAgent/1.0'; }
    function get_payment_method() { return 'zarinpal'; }
    function get_payment_method_title() { return 'زرین‌پال'; }
    function get_transaction_id() { return 'A0000123'; }
    function get_subtotal() { return '1200100'; }
    function get_discount_total() { return '1000'; }
    function get_discount_tax() { return '0'; }
    function get_shipping_total() { return '50000'; }
    function get_shipping_tax() { return '0'; }
    function get_total_tax() { return '0'; }
    function get_total_refunded() { return '25000'; }
    function get_meta($key) { return $this->meta[$key] ?? ''; }
    function get_meta_data() { throw new Exception('متای خام خوانده نشود'); }
    function save() { throw new Exception('نمایش سفارش نباید ذخیره کند'); }
    function update_meta_data(...$a) { throw new Exception('نمایش سفارش نباید متا بنویسد'); }
}
$store = [];
for ($i = 1; $i <= 4100; $i++) { $store[$i] = new WC_Order($i, $i % 2 ? 'processing' : 'completed', '1200000'); }
$store[4100]->created = 1792500000 + 5000;            // تازه‌تر از لنگر آزمون
$store[7]->currency = 'IRR'; $store[7]->total = '100';
$store[8]->currency = 'USD'; $store[8]->total = '12.50';
$store[9]->status = 'awaiting-pickup';
$store[2]->items = [new WC_Order_Item_Product(501, 'پیراهن سفید', 2, '800000', 'SKU-1', true, 7001), new WC_Order_Item_Product(502, 'کالای حذف‌شده', 1, '1000', 'GONE', false, 7002),
    new WC_Order_Item_Product(503, 'کالای ساده', 1, '1000', 'SKU-S'), new WC_Order_Item_Product(504, 'تنوع حذف‌شده، مادر موجود', 1, '1000', 'PARENT', true, 0)];
$store[2]->meta = ['_lmc_payment_complete' => 'yes', '_lmc_invoice_id' => 'uuid', '_lmc_invoice_number' => '۱۴۰۵-۰۰۱۲',
    '_lmc_attempts' => '2', '_lmc_last_error' => 'خطا با 09121234567', '_lmc_order_stopped' => '', '_lmc_order_payload' => '{"secret":"raw"}'];
$store[2]->customer = 15;
$store[2]->refunds = [new Refund(9001)];
$store[2]->meta['_wc_shipment_tracking_items'] = [
    ['tracking_provider' => 'iran-post', 'custom_tracking_provider' => '', 'tracking_number' => 'IR123456789', 'date_shipped' => '1792510000',
        'custom_tracking_link' => 'https://tracking.post.ir/?id=IR123456789'],
    ['tracking_provider' => '', 'custom_tracking_provider' => 'پیک <b>محلی</b>', 'tracking_number' => 'P-77', 'date_shipped' => 0,
        'custom_tracking_link' => 'javascript:alert(1)'],
    ['tracking_number' => ''], 'garbage'];
$store[6000] = new WC_Order(6000, 'trash', '1');
$store[6000]->created = 1792499000;
$store[4200] = new WC_Order(4200, 'refunded', '1000', 'shop_order_refund');
function wc_get_orders($args) {
    global $store, $queries; $queries[] = $args;
    [$from, $to] = array_map('intval', explode('...', $args['date_created']));
    $all = array_values(array_filter($store, fn ($o) => $o->type === $args['type']
        // پیش‌فرض ووکامرس: همهٔ وضعیت‌های ثبت‌شده، بی زباله‌دان.
        && (isset($args['status']) ? in_array($o->status, $args['status'], true) : $o->status !== 'trash')
        && (!isset($args['payment_method']) || $args['payment_method'] === 'zarinpal')
        && (!isset($args['post__in']) || in_array($o->id, $args['post__in'], true))
        && (!isset($args['s']) || (string) $o->id === $args['s'] || $args['s'] === 'رضایی')
        && $o->created >= $from && $o->created <= $to));
    // شرط روش ارسال از همان قلاب‌هایی که ووکامرس صدا می‌زند؛ متن SQL ثبت می‌شود و درستی‌اش روی ووکامرس واقعی سنجیده می‌شود.
    global $filters, $clauses;
    foreach ($filters['woocommerce_orders_table_query_clauses'] ?? [] as $f) {
        $clauses[] = ['hpos', $f(['where' => '1=1'], new class { function get_table_name($t) { return "wp_wc_{$t}"; } })['where']];
    }
    foreach ($filters['posts_where'] ?? [] as $f) {
        $clauses[] = ['legacy', $f(' AND 1=1', new class { function get($k) { return ['shop_order']; } })];
        $clauses[] = ['legacy-other', $f(' AND 1=1', new class { function get($k) { return 'post'; } })];
    }
    usort($all, fn ($a, $b) => [$b->created, $b->id] <=> [$a->created, $a->id]);
    $slice = array_slice($all, ($args['paged'] - 1) * $args['limit'], $args['limit']);
    return (object) ['orders' => $slice, 'total' => count($all), 'max_num_pages' => (int) ceil(count($all) / $args['limit'])];
}
function wc_order_search($term) { global $searches; $searches[] = $term; return $term === 'هیچ' ? [] : [2, 3, 2]; }
function wc_get_order($id) { global $store; return $store[$id] ?? false; }
function wc_get_order_notes($args) {
    global $noteQueries; $noteQueries[] = $args;
    $all = [];
    for ($i = 1; $i <= 45; $i++) { $all[] = (object) ['id' => $i, 'date_created' => new WC_DateTime(1792500000 + $i),
        'content' => "<p>یادداشت {$i}</p>", 'customer_note' => $i === 1, 'added_by' => 'system']; }
    return array_slice($all, $args['offset'], $args['limit']);
}
// افزونه هیچ پرسشی اجرا نمی‌کند: فقط prepare/esc_like و نام جدول برای شرط روش ارسال مجازند؛ هر چیز دیگر خطاست.
$wpdb = new class {
    public $prefix = 'wp_'; public $posts = 'wp_posts';
    function prepare($sql, ...$a) { return vsprintf(str_replace('%s', "'%s'", $sql), array_map(fn ($v) => addslashes((string) $v), $a)); }
    function esc_like($t) { return addcslashes($t, '_%\\'); }
    function __call($m, $a) { throw new Exception("SQL مستقیم ممنوع: {$m}"); }
    function __get($n) { throw new Exception("جدول مستقیم ممنوع: {$n}"); }
};

require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-order-sync.php';
class LMC_Push_Receiver { const NS = 'lmc/v1'; static function verify_request() { return true; } }
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-orders-view.php';
$checks = 0;
function check($value, $label) { global $checks; if (!$value) { throw new Exception($label); } $checks++; }
function req(array $body) { return new class($body) { function __construct(private array $b) {} function get_json_params() { return $this->b; } }; }
function rows($r) { return $r->data['orders']; }
$until = 1792500000 + 4000;

LMC_Orders_View::init();
check($routes['lmc/v1/orders']['permission_callback'] === [LMC_Push_Receiver::class, 'verify_request'], 'همان نگهبان امضا و nonce');
check($routes['lmc/v1/orders']['methods'] === 'POST', 'بدنهٔ امضاشده، نه query بی‌امضا');

// ── صفحه‌بندی: فراتر از ۲۰۰ تا ۱۰۰٬۰۰۰، با لنگر ──
$r = LMC_Orders_View::handle(req(['page' => 201, 'perPage' => 20, 'until' => $until]));
check($r instanceof WP_REST_Response && $r->status === 200, 'صفحهٔ ۲۰۱ رد نمی‌شود (بازبینی ریشه)');
$d = $r->data;
check($d['protocol'] === 3 && $d['siteUrl'] === 'https://shop.example.test' && $d['branchId'] === $settings['branch_id'], 'هویت سایت و دامنه');
check($d['total'] === 4099 && $d['pages'] === 205 && count($d['orders']) === 20 && $d['until'] === $until, 'سفارش پس از لنگر بیرون است؛ شمار کل از ووکامرس');
check(LMC_Orders_View::handle(req(['page' => 205, 'perPage' => 20, 'until' => $until]))->data['orders'] !== [], 'صفحهٔ آخر ۲۰۵');
check(count(rows(LMC_Orders_View::handle(req(['page' => 205, 'perPage' => 20, 'until' => $until])))) === 19, 'صفحهٔ آخر ناقص');
$q = end($queries);
check($q['paginate'] === true && $q['limit'] === 20 && $q['paged'] === 205 && $q['type'] === 'shop_order', 'صفحه‌بندی CRUD رسمی');
check($q['orderby'] === ['date' => 'DESC', 'ID' => 'DESC'], 'ترتیب پایدار: تاریخ و شناسه');
check($q['date_created'] === '1...' . $until, 'لنگر به سقف تاریخ می‌رود');
$first = rows(LMC_Orders_View::handle(req(['page' => 1, 'perPage' => 3, 'until' => $until])));
check(array_column($first, 'id') === [4099, 4098, 4097], 'تازه‌ترین اول؛ هم‌زمان‌ها با شناسهٔ نزولی');
$d = LMC_Orders_View::handle(req([]))->data;
check($d['page'] === 1 && $d['perPage'] === 20 && $d['until'] >= time() - 5 && $d['orders'][0]['id'] === 4100, 'پیش‌فرض: صفحهٔ ۱، لنگر اکنون');
foreach ($queries as $q) { check($q['limit'] > 0 && $q['limit'] <= 50, 'هرگز limit=-1 یا بیش از ۵۰'); }

// ── ارز خود سفارش، بی تبدیل (بازبینی ریشه روی b363e0a) ──
$byId = fn ($id) => array_values(array_filter(rows(LMC_Orders_View::handle(req(['page' => 1, 'perPage' => 50, 'until' => 1792500005]))), fn ($o) => $o['id'] === $id))[0];
check($byId(7)['currency'] === 'IRR' && $byId(7)['total'] === '100', 'IRR صد می‌ماند، نه هزار');
check($byId(8)['currency'] === 'USD' && $byId(8)['total'] === '12.50', 'دلار برچسب ریال نمی‌گیرد و دقیق می‌ماند');
check($byId(6)['currency'] === 'IRT' && $byId(6)['total'] === '1200000', 'تومان همان عدد سایت؛ تبدیل با Core');
check($byId(9)['status'] === 'awaiting-pickup' && $byId(9)['statusLabel'] === 'آمادهٔ تحویل حضوری', 'وضعیت سفارشی نام و برچسب خودش را دارد');
check($byId(6)['customerName'] === 'علی رضایی' && $byId(6)['customerType'] === 'guest' && $byId(2)['customerType'] === 'registered', 'مهمان یا عضو');

// ── فیلترها و جست‌وجو ──
$r = LMC_Orders_View::handle(req(['status' => 'awaiting-pickup', 'until' => $until]));
check(array_column(rows($r), 'id') === [9] && end($queries)['status'] === ['awaiting-pickup'], 'فیلتر وضعیت سفارشی ثبت‌شده');
check(array_column($r->data['statuses'], 'slug') === ['pending', 'processing', 'completed', 'awaiting-pickup', 'trash'], 'فهرست وضعیت‌ها از خود سایت، نامک بی‌اعتبار بیرون، زباله‌دان آخر');
check($r->data['paymentMethods'] === [['id' => 'zarinpal', 'title' => 'زرین‌پال']], 'روش‌های پرداخت سایت');
LMC_Orders_View::handle(req(['paymentMethod' => 'zarinpal', 'until' => $until]));
check(end($queries)['payment_method'] === 'zarinpal', 'فیلتر روش پرداخت در ووکامرس');
LMC_Orders_View::handle(req(['dateFrom' => '2026-10-01', 'dateTo' => '2026-10-02', 'until' => 1792600000]));
$tz = new DateTimeZone('Asia/Tehran');
$from = (new DateTimeImmutable('2026-10-01 00:00:00', $tz))->getTimestamp(); $to = (new DateTimeImmutable('2026-10-03 00:00:00', $tz))->getTimestamp() - 1;
check(end($queries)['date_created'] === "{$from}...{$to}", 'بازهٔ تاریخ در منطقهٔ زمانی سایت');
LMC_Orders_View::handle(req(['dateTo' => '2026-12-01', 'until' => $until]));
check(end($queries)['date_created'] === "1...{$until}", 'تاریخ پایان دیرتر از لنگر، لنگر را نمی‌شکند');

OrderUtil::$on = false;
$n = count($queries);
$r = LMC_Orders_View::handle(req(['search' => " رضایی\x07 ", 'until' => $until]));
check(end($searches) === 'رضایی' && end($queries)['post__in'] === [2, 3] && !isset(end($queries)['s']), 'legacy: wc_order_search و post__in، تکراری حذف');
$r = LMC_Orders_View::handle(req(['search' => 'هیچ', 'until' => $until]));
check(rows($r) === [] && $r->data['total'] === 0 && count($queries) === $n + 1, 'legacy: بی نتیجه، بی پرسش اضافه');
check($r->data['filters']['search'] === true && !str_contains(json_encode($r->data, JSON_UNESCAPED_UNICODE), 'هیچ'), 'عبارت جست‌وجو برنمی‌گردد');
OrderUtil::$on = true;
$r = LMC_Orders_View::handle(req(['search' => 'رضایی', 'until' => $until]));
check(end($queries)['s'] === 'رضایی' && !isset(end($queries)['post__in']) && $r->data['total'] === 4099, 'HPOS: پارامتر s در همان پرسش');
OrderUtil::$on = false;

// ── زباله‌دان: فیلتر جدا، بیرون از «همه» (همان پیشخوان ووکامرس) ──
check(!in_array(6000, array_column(rows(LMC_Orders_View::handle(req(['perPage' => 50, 'until' => 1792500000]))), 'id'), true), 'زباله‌دان در «همه» نیست');
$r = LMC_Orders_View::handle(req(['status' => 'trash', 'until' => $until]));
check(array_column(rows($r), 'id') === [6000] && end($queries)['status'] === ['trash'] && rows($r)[0]['statusLabel'] === 'زباله‌دان', 'فیلتر زباله‌دان');
check(end($r->data['statuses']) === ['slug' => 'trash', 'label' => 'زباله‌دان'], 'زباله‌دان گزینهٔ فیلتر است');
check(LMC_Orders_View::handle(req(['orderId' => 6000]))->data['order']['status'] === 'trash', 'جزئیات سفارش زباله‌دان');

// ── روش ارسال: یک شرط آماده‌شده در همان پرسش ووکامرس، فقط برای همان پرسش ──
check($r->data['shippingMethods'] === [['id' => 'flat_rate', 'title' => 'نرخ ثابت'], ['id' => 'local_pickup', 'title' => 'تحویل حضوری']], 'روش‌های ارسال سایت، شناسهٔ بی‌اعتبار بیرون');
$clauses = [];
LMC_Orders_View::handle(req(['until' => $until]));
check($clauses === [] && ($filters['posts_where'] ?? []) === [], 'بی فیلتر روش ارسال، هیچ شرطی افزوده نمی‌شود');
foreach ([false, true] as $hpos) {
    OrderUtil::$on = $hpos; $clauses = [];
    $r = LMC_Orders_View::handle(req(['shippingMethod' => 'local_pickup', 'until' => $until]));
    check($r->data['filters']['shippingMethod'] === 'local_pickup', 'بازتاب فیلتر روش ارسال');
    $want = " AND EXISTS (SELECT 1 FROM wp_woocommerce_order_items lmc_si INNER JOIN wp_woocommerce_order_itemmeta lmc_sm ON lmc_sm.order_item_id = lmc_si.order_item_id"
        . " WHERE lmc_si.order_id = {ID} AND lmc_si.order_item_type = 'shipping' AND lmc_sm.meta_key = 'method_id' AND (lmc_sm.meta_value = 'local_pickup' OR lmc_sm.meta_value LIKE 'local\\\\_pickup:%'))";
    check($clauses[0] === ['hpos', '1=1' . str_replace('{ID}', 'wp_wc_orders.id', $want)], 'HPOS: شرط روی همان پرسش جدول سفارش‌ها');
    check($clauses[1] === ['legacy', ' AND 1=1' . str_replace('{ID}', 'wp_posts.ID', $want)], 'legacy: شرط روی همان WP_Query');
    check($clauses[2] === ['legacy-other', ' AND 1=1'], 'legacy: پرسش غیرسفارشی دست نمی‌خورد');
    check(($filters['woocommerce_orders_table_query_clauses'] ?? []) === [] && ($filters['posts_where'] ?? []) === [], 'قلاب‌ها پس از همان پرسش برداشته شدند');
}
OrderUtil::$on = false;
$w = LMC_Orders_View::shipping_predicate('o.id', "x' OR 1=1 -- %_");
check(str_contains($w, "meta_value = 'x\\' OR 1=1 -- %_'") && str_contains($w, "LIKE 'x\\' OR 1=1 -- \\\\%\\\\_:%'"), 'مقدار روش ارسال آماده‌شده است، نه چسبیده به SQL');

// ── لنگر: ثانیهٔ جاری بیرون است (بازبینی ریشه روی 2a4e62e) ──
// سه سفارش در ثانیهٔ پیش، صفحهٔ اول، بعد سفارش چهارم در ثانیهٔ جاری (همان ثانیهٔ لنگرگیری)؛ صفحهٔ دوم نباید تکرار داشته باشد.
// هر تکرار از صفر شروع می‌شود: سفارش ۵۰۰۴ تکرار قبلی (ثانیهٔ قبل) نباید در صفحهٔ اول تکرار بعدی بنشیند — همین
// باقی‌مانده بود که وقتی تکرار اول از مرز ثانیه رد می‌شد (CI کند)، بند پایین را بی‌دلیل قرمز می‌کرد.
$sameSecond = false;
for ($try = 0; $try < 20; $try++) {
    unset($store[5004]);
    $now = time();
    foreach ([5001, 5002, 5003] as $id) { $store[$id] = new WC_Order($id, 'processing', '1'); $store[$id]->created = $now - 1; }
    $p1 = LMC_Orders_View::handle(req(['perPage' => 2]))->data;
    $store[5004] = new WC_Order(5004, 'processing', '1'); $store[5004]->created = $now;
    $p2r = LMC_Orders_View::handle(req(['page' => 2, 'perPage' => 2, 'until' => $p1['until']]));
    check($p2r instanceof WP_REST_Response, 'لنگری که خود افزونه داده، در صفحهٔ بعد پذیرفته می‌شود');
    $p2 = $p2r->data;
    // کنترل منفی در همان مهار: لنگر شامل ثانیهٔ جاری (رفتار 2a4e62e) همان تکرار را می‌سازد.
    unset($store[5004]);
    $old1 = LMC_Orders_View::page(['page' => 1, 'perPage' => 2, 'status' => null, 'search' => null, 'dateFrom' => null, 'dateTo' => null,
        'paymentMethod' => null, 'until' => $now], []);
    $store[5004] = new WC_Order(5004, 'processing', '1'); $store[5004]->created = $now;
    $old2 = LMC_Orders_View::page(['page' => 2, 'perPage' => 2, 'status' => null, 'search' => null, 'dateFrom' => null, 'dateTo' => null,
        'paymentMethod' => null, 'until' => $now], []);
    if (time() === $now) { $sameSecond = true; break; }
}
check($sameSecond, 'سناریوی لنگر در یک ثانیه جا نشد؛ نتیجهٔ بندهای پایین معنا ندارد');
check($p1['until'] === $now - 1 && array_column($p1['orders'], 'id') === [5003, 5002], 'لنگر پیش‌فرض ثانیهٔ پیش است');
check(array_column($p2['orders'], 'id') === [5001, 4100] && !array_intersect(array_column($p1['orders'], 'id'), array_column($p2['orders'], 'id')), 'سفارش هم‌ثانیه با لنگر صفحه‌ها را تکرار نکرد');
check(array_values(array_intersect(array_column($old1['orders'], 'id'), array_column($old2['orders'], 'id'))) === [5002], 'کنترل منفی: لنگر شامل ثانیهٔ جاری سفارش ۵۰۰۲ را در دو صفحه می‌آورد');
check(is_wp_error(LMC_Orders_View::handle(req(['page' => 2, 'until' => time()]))), 'لنگر ثانیهٔ جاری از بیرون هم پذیرفته نمی‌شود');
foreach ([5001, 5002, 5003, 5004] as $id) { unset($store[$id]); }

foreach ([['page' => 0], ['page' => 100001], ['perPage' => 51], ['perPage' => -1], ['page' => '1'], ['status' => 'wc-trash'],
          ['status' => 'wc-processing'], ['until' => time()], ['until' => time() + 3600], ['shippingMethod' => 'teleport'],
          ['shippingMethod' => 'bad id!'], ['shippingMethod' => ['flat_rate']], ['limit' => -1], ['search' => ''], ['search' => "\x07"], ['search' => str_repeat('ا', 101)],
          ['dateFrom' => '2026-02-30'], ['dateFrom' => '2026-10-05', 'dateTo' => '2026-10-01'], ['dateTo' => '1405-07-01x'],
          ['paymentMethod' => 'bad id!'], ['until' => 0], ['until' => '1'], ['orderId' => 2, 'page' => 1], ['orderId' => '2'],
          ['orderId' => 0], ['orderId' => 2, 'itemsPage' => 0], ['orderId' => 2, 'notesPage' => '2']] as $bad) {
    $e = LMC_Orders_View::handle(req($bad));
    check(is_wp_error($e) && $e->get_error_data()['status'] === 400, 'رد: ' . json_encode($bad, JSON_UNESCAPED_UNICODE));
}

// ── جزئیات کامل ──
$scheduled[LMC_ORDER_EVENT . '[2]'] = 123;
$r = LMC_Orders_View::handle(req(['orderId' => 2]));
$o = $r->data['order'];
check($r->status === 200 && $o['id'] === 2 && $r->data['protocol'] === 3, 'جزئیات با هویت سایت');
check($o['billing']['phone'] === '09121234567' && $o['billing']['email'] === 'ali@example.test' && $o['billing']['address1'] === 'خیابان billing', 'تماس و نشانی صورت‌حساب');
check($o['shipping']['address1'] === 'خیابان shipping' && !isset($o['shipping']['email']), 'نشانی ارسال');
check($o['payment'] === ['methodId' => 'zarinpal', 'method' => 'زرین‌پال', 'transactionId' => 'A0000123', 'paidAt' => gmdate('Y-m-d\TH:i:s\Z', 1792500061)], 'مدرک پرداخت');
check($o['totals'] === ['subtotal' => '1200100', 'discount' => '1000', 'discountTax' => '0', 'shipping' => '50000', 'shippingTax' => '0',
    'tax' => '0', 'total' => '1200000', 'refunded' => '25000'], 'جمع‌ها، دقیق و بی تبدیل');
check($o['items']['total'] === 4 && $o['items']['rows'][0]['attributes'] === [['key' => 'رنگ', 'value' => 'سفید'], ['key' => 'سایز', 'value' => '42']], 'ویژگی تنوع بی HTML');
check($o['items']['rows'][1]['attributes'] === [['key' => 'رنگ', 'value' => 'سفید']], 'کالا و مادر حذف‌شده: ویژگی طبقه‌بندی (pa_) حفظ می‌شود؛ ویژگی سفارشی منبع ندارد');
check($o['items']['rows'][2]['attributes'] === [['key' => 'رنگ', 'value' => 'سفید']], 'قلم بی تنوع: فقط pa_، نه متای عمومی');
check($o['items']['rows'][3]['attributes'] === [['key' => 'رنگ', 'value' => 'سفید'], ['key' => 'سایز', 'value' => '42']]
    && $o['items']['rows'][3]['productExists'] === false && $o['items']['rows'][3]['mapped'] === false && $o['items']['rows'][3]['sku'] === '',
    'فقط تنوع حذف‌شده: ویژگی‌های تنوع‌ساز مادر؛ کالای مادر «موجود» یا «متصل» شمرده نمی‌شود');
check($o['completedAt'] === gmdate('Y-m-d\TH:i:s\Z', $store[2]->created + 3600) && $o['modifiedAt'] === gmdate('Y-m-d\TH:i:s\Z', $store[2]->created + 7200), 'تاریخ تکمیل و آخرین تغییر');
check(LMC_Orders_View::handle(req(['orderId' => 3]))->data['order']['completedAt'] === null, 'سفارش تکمیل‌نشده تاریخ تکمیل ندارد');
check($o['tracking'] === [
    ['provider' => 'iran-post', 'number' => 'IR123456789', 'shippedAt' => gmdate('Y-m-d\TH:i:s\Z', 1792510000), 'url' => 'https://tracking.post.ir/?id=IR123456789'],
    ['provider' => 'پیک محلی', 'number' => 'P-77', 'shippedAt' => null, 'url' => ''],
], 'رهگیری افزونهٔ رسمی؛ پیوند غیر HTTPS دور ریخته شد');
check(LMC_Orders_View::handle(req(['orderId' => 3]))->data['order']['tracking'] === [], 'بی رهگیری، فهرست خالی');
check($o['items']['rows'][0]['subtotal'] === '800100' && $o['items']['rows'][0]['total'] === '800000' && $o['items']['rows'][0]['tax'] === '9.5', 'تخفیف و مالیات سطر');
check($o['items']['rows'][1]['productExists'] === false && $o['items']['rows'][1]['mapped'] === false, 'کالای حذف‌شده صریح است');
check(array_column($o['items']['rows'], 'productExists') === [true, false, true, false], 'وضعیت هر قلم مال خودش است، نه قلم آخر');
check($o['fees'] === [['name' => 'بسته‌بندی هدیه', 'total' => '20000', 'tax' => '0']] && $o['shippingLines'][0]['method'] === 'پست پیشتاز', 'کارمزد و ارسال');
check($o['coupons'] === [['code' => 'SALE10', 'discount' => '1000', 'discountTax' => '0']], 'کوپن');
check($o['refunds'] === [['id' => 9001, 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', 1792600000), 'amount' => '25000', 'reason' => 'کالای معیوب']] && $o['refundsTruncated'] === false, 'استرداد');
check($o['notes']['rows'][0]['content'] === 'یادداشت 1' && $o['notes']['rows'][0]['customerNote'] === true && count($o['notes']['rows']) === 20 && $o['notes']['hasMore'], 'یادداشت‌ها صفحهٔ اول');
check(array_values(array_filter($noteQueries, fn ($q) => $q['order_id'] === 2))[0] === ['order_id' => 2, 'limit' => 21, 'offset' => 0, 'orderby' => 'date_created', 'order' => 'DESC'], 'یادداشت با limit و offset رسمی');
$o3 = LMC_Orders_View::handle(req(['orderId' => 2, 'notesPage' => 3]))->data['order'];
check(count($o3['notes']['rows']) === 5 && !$o3['notes']['hasMore'] && end($noteQueries)['offset'] === 40, 'یادداشت‌ها صفحهٔ آخر');
check($o['core']['queue'] === ['scheduler' => 'wp-cron', 'state' => 'scheduled', 'deferred' => null, 'dead' => null] && $o['core']['missingSku'] === 2 && $o['core']['missingMapping'] === 2 && $o['core']['recorded'] && $o['core']['hasError'], 'وضعیت صف و نگاشت Core');
check($o['customerNote'] === 'لطفاً عصر', 'یادداشت مشتری');
$json = json_encode($r->data, JSON_UNESCAPED_UNICODE);
foreach (['203.0.113.9', 'SecretAgent', '_lmc_order_payload', '"secret"', 'خطا با', '<p>', '<b>', 'SENTINEL-TOKEN', 'integration_token', 'gift_note', 'javascript:'] as $leak) {
    check(strpos($json, $leak) === false, "نشت: {$leak}");
}
check(LMC_Orders_View::handle(req(['orderId' => 4200]))->get_error_data()['status'] === 404, 'استرداد سفارش نیست');
check(LMC_Orders_View::handle(req(['orderId' => 99999]))->get_error_code() === 'lmc_order_not_found', 'ناموجود ۴۰۴');

$many = new WC_Order(9999, 'processing', '1');
for ($i = 0; $i < 120; $i++) { $many->items[] = new WC_Order_Item_Product(1000 + $i, "قلم {$i}", 1, '1', 'S'); }
for ($i = 0; $i < 55; $i++) { $many->refunds[] = new Refund($i); }
$store[9999] = $many;
$p1 = LMC_Orders_View::handle(req(['orderId' => 9999]))->data['order'];
$p5 = LMC_Orders_View::handle(req(['orderId' => 9999, 'itemsPage' => 5]))->data['order'];
$p6 = LMC_Orders_View::handle(req(['orderId' => 9999, 'itemsPage' => 6]))->data['order'];
check(count($p1['items']['rows']) === 25 && $p1['items']['total'] === 120 && $p1['itemCount'] === 120, 'اقلام صفحه‌بندی‌شده، نه بریده');
check(count($p5['items']['rows']) === 20 && $p5['items']['rows'][0]['name'] === 'قلم 100' && $p6['items']['rows'] === [], 'صفحه‌های بعدی اقلام');
check(count($p1['refunds']) === 50 && $p1['refundsTruncated'] === true, 'سقف استرداد صریح است');
check(strlen(json_encode($p1)) < 262144 && strlen(json_encode(LMC_Orders_View::handle(req(['perPage' => 50]))->data)) < 131072, 'پاسخ زیر سقف بدنهٔ Core');

// ── وضعیت صف از LMC_Queue::state، بی تغییر؛ بی آن کلاس، WP-Cron خالی «نمی‌دانم» است نه «نیست» ──
unset($scheduled[LMC_ORDER_EVENT . '[2]']);
check(LMC_Orders_View::handle(req(['orderId' => 2]))->data['order']['core']['queue']['state'] === 'unknown', 'بی LMC_Queue و بی رویداد: unknown');
// eval: اعلان سطح بالای کلاس در PHP پیش از اجرا بالا کشیده می‌شود و ادعای «بی LMC_Queue» بالا را بی‌معنا می‌کرد.
eval('class LMC_Queue { public static array $calls = []; public static function state($hook, $args) { self::$calls[] = [$hook, $args];
    return ["scheduler" => "action-scheduler", "state" => "deferred", "deferred" => "send", "dead" => false]; } }');
$q = LMC_Orders_View::handle(req(['orderId' => 2]))->data['order']['core']['queue'];
check($q === ['scheduler' => 'action-scheduler', 'state' => 'deferred', 'deferred' => 'send', 'dead' => false] && LMC_Queue::$calls === [[LMC_ORDER_EVENT, [2]]],
    'جزئیات همان LMC_Queue::state همان سفارش را برمی‌گرداند');
check(!array_key_exists('scheduled', LMC_Orders_View::handle(req(['orderId' => 2]))->data['order']['core']), 'بولی scheduled حذف شد');

echo "OK: {$checks} orders-view assertions\n";
