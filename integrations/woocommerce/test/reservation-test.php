<?php
/** چرخه رزرو COD با کلاینت HTTP جعلی؛ آزمون Core و نصب واقعی جدا هستند. */
declare(strict_types=1);
define('ABSPATH', __DIR__);
define('MINUTE_IN_SECONDS', 60);
define('LMC_ORDER_EVENT', 'lmc_send_order');
$settings = ['branch_id' => 'b', 'warehouse_id' => 'w', 'payment_map' => 'cod=cash'];
$orders = []; $scheduled = []; $hooks = [];
function lmc_setting($k, $default = '') { global $settings; return $settings[$k] ?? $default; }
function wc_get_order($id) { global $orders; return $orders[$id] ?? false; }
function add_action($hook, $callback) { global $hooks; $hooks[$hook][] = $callback; }
function wp_next_scheduled($hook, $args) { global $scheduled; return $scheduled[$hook . ':' . $args[0]] ?? false; }
function wp_schedule_single_event($at, $hook, $args) { global $scheduled; $scheduled[$hook . ':' . $args[0]] = $at; }
function is_wp_error($v) { return $v instanceof WP_Error; }
function __($text, $domain = '') { return $text; }
function lmc_log($text) {}
class WP_Error {
    public function __construct(public $code, public $message) {}
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
}
class WC_Order_Item_Product {
    public function __construct(public $sku = 'SKU-1', public $qty = 2, public $original = 1) {}
    public function get_quantity() { return $this->qty; }
    public function get_product() { return $this; }
    public function get_sku() { return $this->sku; }
    public function get_meta($key) { return $this->original; }
}
class WC_Order {
    public $method = 'cod'; public $status = 'processing'; public $meta = []; public $items; public $notes = []; public $total = '2';
    public function __construct(public $id) { $this->items = [new WC_Order_Item_Product()]; }
    public function get_id() { return $this->id; }
    public function get_total() { return $this->total; }
    public function get_payment_method() { return $this->method; }
    public function has_status($s) { return in_array($this->status, (array) $s, true); }
    public function get_meta($k) { return $this->meta[$k] ?? ''; }
    public function update_meta_data($k, $v) { $this->meta[$k] = $v; }
    public function delete_meta_data($k) { unset($this->meta[$k]); }
    public function get_items() { return $this->items; }
    public function save() {}
    public function add_order_note($n) { $this->notes[] = $n; }
}
class WC_Order_Refund extends WC_Order {
    public $parent; public $amount = '2';
    public function get_parent_id() { return $this->parent; }
    public function get_amount() { return $this->amount; }
    public function get_shipping_total() { return '0'; }
}
class LMC_Client {
    const PERMANENT = 'permanent';
    public static $calls = []; public static $result = ['status' => 'reserved'];
    public static $connection = ['protocol' => 1, 'authenticated' => true, 'branchId' => 'b', 'warehouseId' => 'w', 'features' => ['codReservations' => true]];
    public static function get($path, $q) { return self::$connection; }
    public static function post($path, $payload) { self::$calls[] = [$path, $payload]; return self::$result; }
    public static function is_retryable($e) { return $e->code === 'network'; }
}
require __DIR__ . '/../labelmod-connector/includes/class-lmc-order-sync.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-order-reservation.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-refund-sync.php';
$checks = 0;
function check($ok, $label) { global $checks; if (!$ok) { throw new Exception($label); } $checks++; }
function run_reservation($id) { global $scheduled; unset($scheduled[LMC_Order_Reservation::EVENT . ':' . $id]); LMC_Order_Reservation::send($id); }
LMC_Order_Reservation::init();
check(isset($hooks['woocommerce_order_status_changed']), 'رویداد تغییر وضعیت متصل است');
$orders[1] = $order = new WC_Order(1);
LMC_Order_Reservation::changed(1);
check(count($scheduled) === 1 && count(LMC_Client::$calls) === 0, 'رزرو ناهم‌زمان است');
LMC_Order_Reservation::changed(1);
check(count($scheduled) === 1, 'رویداد تکراری صف دوباره ندارد');
$settings['warehouse_id'] = 'other';
run_reservation(1);
check(LMC_Client::$calls[0] === ['/web/order-reservations', ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => '1', 'lines' => [['sku' => 'SKU-1', 'qty' => '2']]]], 'رزرو فقط SKU و تعداد با هویت ثابت انبار می‌فرستد');
check($order->get_meta(LMC_Order_Sync::META_PAID) === '' && $order->get_meta(LMC_Order_Sync::META_INVOICE) === '', 'رزرو هیچ مدرک دریافت وجه یا فاکتور نمی‌سازد');
check($order->get_meta(LMC_Order_Reservation::STATE) === 'reserved', 'وضعیت رزرو ذخیره می‌شود');
$order->status = 'cancelled'; $order->items = [];
LMC_Order_Reservation::changed(1); LMC_Client::$result = ['status' => 'released']; run_reservation(1);
check(LMC_Client::$calls[1] === ['/web/order-reservations/release', ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => '1']], 'لغو حتی با اقلام حذف‌شده همان رزرو را آزاد می‌کند');
check($order->get_meta(LMC_Order_Reservation::STATE) === 'released', 'آزادسازی ثبت شد');
$settings['warehouse_id'] = 'w';
$orders[2] = $unpaid = new WC_Order(2);
LMC_Order_Sync::send(2);
check(count(LMC_Client::$calls) === 2, 'COD پرداخت‌نشده فاکتور نمی‌سازد');
$unpaid->meta[LMC_Order_Sync::META_PAID] = 'yes';
LMC_Order_Sync::send(2);
check(count(LMC_Client::$calls) === 2, 'دریافت وجه بدون تحویل COD فاکتور نمی‌سازد');
// بدنه ثابت، دو شرط مستقل و endpoint واقعی ارسال سفارش.
$unpaid->status = 'completed';
$unpaid->meta[LMC_Order_Sync::META_PAYLOAD] = ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => '2', 'lines' => [['sku' => 'SKU-1', 'qty' => '2', 'unitPrice' => '10']], 'paymentRef' => 'RECEIPT-2', 'paymentMethod' => 'cash'];
$unpaid->meta[LMC_Order_Sync::META_LINES] = [1 => 1];
// با API قدیمی پیش از POST متوقف می‌شود؛ حتی اگر تأیید مالی موجود باشد.
LMC_Client::$connection['features']['codReservations'] = false;
check(is_wp_error(LMC_Order_Sync::check_discount_support(['branchId' => 'b', 'warehouseId' => 'w', 'lines' => [], 'codDelivered' => true])), 'API قدیمی اجازه خروج COD نمی‌گیرد');
$orders[3] = new WC_Order(3);
LMC_Order_Reservation::changed(3); run_reservation(3);
check(count(LMC_Client::$calls) === 2 && $orders[3]->get_meta(LMC_Order_Reservation::ERROR) !== '', 'API قدیمی پیش از POST رزرو متوقف می‌شود');
check(!wp_next_scheduled(LMC_Order_Reservation::EVENT, [3]), 'خطای قابلیت retry خودکار ندارد');
LMC_Client::$connection['features']['codReservations'] = true;
LMC_Client::$result = new WP_Error('network', 'قطع شبکه');
LMC_Order_Reservation::retry($orders[3]); run_reservation(3);
check((int) $orders[3]->get_meta(LMC_Order_Reservation::ATTEMPTS) === 1 && (bool) wp_next_scheduled(LMC_Order_Reservation::EVENT, [3]), 'خطای شبکه تلاش محدود دارد');
for ($i = 1; $i < LMC_Order_Sync::MAX_ATTEMPTS; $i++) { run_reservation(3); }
check(!wp_next_scheduled(LMC_Order_Reservation::EVENT, [3]), 'پس از سقف تلاش، صف متوقف می‌شود');
LMC_Order_Reservation::changed(3);
check(!wp_next_scheduled(LMC_Order_Reservation::EVENT, [3]), 'تغییر وضعیت تکراری توقف را دور نمی‌زند');
$orders[3]->status = 'cancelled';
LMC_Order_Reservation::changed(3);
check((bool) wp_next_scheduled(LMC_Order_Reservation::EVENT, [3]), 'لغو پس از پاسخ نامعلوم رزرو برای آزادسازی صف می‌شود');
LMC_Client::$result = ['status' => 'consumed']; run_reservation(3);
check($orders[3]->get_meta(LMC_Order_Reservation::STATE) === 'consumed', 'لغو دیرهنگام خروج قبلی را برنمی‌گرداند');
$orders[4] = new WC_Order(4); $orders[4]->method = 'bacs'; LMC_Order_Reservation::changed(4);
check(!wp_next_scheduled(LMC_Order_Reservation::EVENT, [4]), 'حواله پرداخت‌نشده COD تلقی نمی‌شود');
$orders[5] = new WC_Order(5); $orders[5]->items[0]->sku = ''; LMC_Order_Reservation::changed(5);
check($orders[5]->get_meta(LMC_Order_Reservation::ERROR) !== '' && !wp_next_scheduled(LMC_Order_Reservation::EVENT, [5]), 'SKU خالی پیش از صف رد می‌شود');
$settings['payment_map'] = '';
$before_calls = count(LMC_Client::$calls);
LMC_Order_Sync::send(2);
check(count(LMC_Client::$calls) === $before_calls && $unpaid->get_meta(LMC_Order_Sync::META_ERROR) !== '', 'COD بدون نگاشت روش دریافت به‌اشتباه درگاه حساب نمی‌شود');
$settings['payment_map'] = 'cod=cash';
$unpaid->meta[LMC_Order_Sync::META_PAYLOAD]['paymentMethod'] = 'gateway';
LMC_Order_Sync::send(2);
check(count(LMC_Client::$calls) === $before_calls, 'نگاشت جدید snapshot پرداخت قبلی را بازنویسی نمی‌کند');
$unpaid->meta[LMC_Order_Sync::META_PAYLOAD]['paymentMethod'] = 'cash';
LMC_Client::$result = ['invoiceId' => 'invoice-2', 'number' => 'F-2'];
LMC_Order_Sync::send(2);
$sent = LMC_Client::$calls[count(LMC_Client::$calls) - 1];
check($sent[0] === '/web/orders' && $sent[1]['codDelivered'] === true && $sent[1]['paymentRef'] === 'RECEIPT-2', 'COD فقط با تحویل و مدرک قبلی پرداخت نهایی می‌شود');
check($unpaid->get_meta(LMC_Order_Sync::META_INVOICE) === 'invoice-2', 'فاکتور پاسخ قطعی ذخیره شد');
$before_calls = count(LMC_Client::$calls);
LMC_Order_Sync::send(2); LMC_Order_Reservation::changed(2);
check(count(LMC_Client::$calls) === $before_calls && !wp_next_scheduled(LMC_Order_Reservation::EVENT, [2]), 'فاکتور نهایی نه ارسال و نه رزرو دوباره می‌شود');

// تحویل سپس مرجوعی، پیش از اجرای Cron یا هنگام قطعی Core: ابتدا سند اصلی، سپس مرجوعی.
foreach (['full', 'partial', 'free'] as $i => $kind) {
    $id = 20 + $i;
    $orders[$id] = $cod = new WC_Order($id);
    $cod->items = [1 => new WC_Order_Item_Product()];
    $cod->total = $kind === 'free' ? '0' : '2';
    LMC_Order_Reservation::changed($id);
    LMC_Client::$result = ['status' => 'reserved']; run_reservation($id);
    $cod->status = 'completed';
    LMC_Order_Sync::resume_confirmed_order($id);
    check($cod->get_meta(LMC_Order_Sync::META_DELIVERED) === 'yes' && $cod->get_meta(LMC_Order_Sync::META_PAID) === '', "$kind: تحویل دریافت وجه را جعل نمی‌کند");
    $calls = count(LMC_Client::$calls);
    LMC_Order_Sync::send($id);
    check(count(LMC_Client::$calls) === $calls, "$kind: تحویل بدون شاهد پرداخت ارسال نمی‌شود");
    LMC_Order_Sync::payment_complete($id);
    $line = ['sku' => 'SKU-1', 'qty' => '2', 'unitPrice' => '1'];
    if ($kind === 'free') { $line['discountAmount'] = '2'; }
    $cod->meta[LMC_Order_Sync::META_PAYLOAD] = ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => (string) $id,
        'lines' => [$line], 'paymentMethod' => 'cash', 'paymentRef' => "RECEIPT-$id", 'paidAmount' => $cod->total];
    $cod->meta[LMC_Order_Sync::META_LINES] = [1 => 1];
    if ($kind !== 'partial') { $cod->status = 'refunded'; }
    LMC_Order_Sync::resume_confirmed_order($id);
    $orders[$id + 100] = $refund = new WC_Order_Refund($id + 100);
    $refund->parent = $id;
    $refund->amount = $kind === 'free' ? '0' : ($kind === 'partial' ? '1' : '2');
    $refund->items = [1 => new WC_Order_Item_Product('SKU-1', $kind === 'partial' ? -1 : -2)];
    LMC_Refund_Sync::created($id + 100, ['restock_items' => true]);
    $frozen = $refund->get_meta(LMC_Refund_Sync::PAYLOAD);
    LMC_Refund_Sync::send($id + 100);
    check(count(LMC_Client::$calls) === $calls, "$kind: مرجوعی پیش از رسیدن سند اصلی اثر ندارد");
    LMC_Client::$connection['features']['explicitLineDiscount'] = true;
    LMC_Client::$result = ['invoiceId' => "invoice-$id", 'number' => "F-$id"];
    LMC_Order_Sync::send($id);
    $sent = LMC_Client::$calls[count(LMC_Client::$calls) - 1];
    check(count(LMC_Client::$calls) === $calls + 1 && $cod->get_meta(LMC_Order_Sync::META_INVOICE) === "invoice-$id", "$kind: سند اصلی پس از مرجوعی نیز می‌رسد");
    check($sent[1]['codDelivered'] === true && $sent[1]['paidAmount'] === $cod->total && $sent[1]['lines'] === [$line], "$kind: هویت اقلام و مبلغ وصول اصلی حفظ می‌شود");
    check($sent[0] === ($kind === 'free' ? '/web/discounted-orders' : '/web/orders'), "$kind: مسیر تخفیف کامل صحیح است");
    LMC_Client::$result = ['requestId' => "review-$id", 'status' => 'pending'];
    LMC_Refund_Sync::send($id + 100);
    check($refund->get_meta(LMC_Refund_Sync::STATUS) === 'pending' && $refund->get_meta(LMC_Refund_Sync::DONE) === '', "$kind: تأیید دستی مرجوعی همچنان لازم است");
    LMC_Client::$result = ['returnId' => "return-$id", 'number' => "R-$id", 'status' => 'posted'];
    LMC_Refund_Sync::send($id + 100);
    check(LMC_Client::$calls[count(LMC_Client::$calls) - 1] === ['/web/refunds', $frozen], "$kind: مرجوعی همان مبلغ و تعداد اصلی را نگه می‌دارد");
    $calls = count(LMC_Client::$calls);
    LMC_Order_Sync::send($id); LMC_Refund_Sync::send($id + 100);
    check(count(LMC_Client::$calls) === $calls, "$kind: سند و مرجوعی قطعی تکرار نمی‌شوند");
}
$orders[30] = $unverified = new WC_Order(30);
$unverified->status = 'refunded'; $unverified->meta[LMC_Order_Sync::META_PAID] = 'yes';
$calls = count(LMC_Client::$calls);
LMC_Order_Sync::resume_confirmed_order(30); LMC_Order_Sync::send(30);
check(count(LMC_Client::$calls) === $calls && $unverified->get_meta(LMC_Order_Sync::META_DELIVERED) === '', 'مرجوعی و پرداخت به‌تنهایی تحویل COD را اثبات نمی‌کنند');
$orders[31] = $paidFirst = new WC_Order(31);
LMC_Order_Sync::payment_complete(31);
LMC_Order_Sync::resume_confirmed_order(31);
check($paidFirst->get_meta(LMC_Order_Sync::META_DELIVERED) === '', 'وصول پیش از تحویل، شاهد تحویل نمی‌سازد');
$paidFirst->status = 'completed';
LMC_Order_Sync::resume_confirmed_order(31);
check($paidFirst->get_meta(LMC_Order_Sync::META_DELIVERED) === 'yes', 'تحویل پس از وصول نیز جداگانه ثبت می‌شود');
$paidFirst->meta[LMC_Order_Sync::META_PAYLOAD] = ['branchId' => 'b', 'warehouseId' => 'w', 'externalId' => '31',
    'lines' => [['sku' => 'SKU-1', 'qty' => '2', 'unitPrice' => '1']], 'paymentMethod' => 'cash', 'paymentRef' => 'RECEIPT-31'];
$paidFirst->meta[LMC_Order_Sync::META_LINES] = [1 => 1];
$paidFirst->status = 'refunded';
LMC_Client::$result = ['invoiceId' => 'invoice-31', 'number' => 'F-31'];
LMC_Order_Sync::send(31);
check($paidFirst->get_meta(LMC_Order_Sync::META_INVOICE) === 'invoice-31', 'مرجوعی بین تحویل و Cron در ترتیب وصول-سپس-تحویل نیز بازیابی می‌شود');
$orders[32] = $unpaidRefund = new WC_Order(32);
$unpaidRefund->status = 'completed'; LMC_Order_Sync::resume_confirmed_order(32);
$unpaidRefund->status = 'refunded';
$calls = count(LMC_Client::$calls);
LMC_Order_Sync::resume_confirmed_order(32); LMC_Order_Sync::send(32);
check(count(LMC_Client::$calls) === $calls && $unpaidRefund->get_meta(LMC_Order_Sync::META_PAID) === '', 'مرجوعی پس از تحویل بدون وصول، فروش مالی نمی‌سازد');
printf("✓ %d بررسی رزرو پرداخت در محل موفق بود\n", $checks);
