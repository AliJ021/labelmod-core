<?php
/**
 * دابل‌های ذخیره‌سازی و HTTP — **یک پروندهٔ کمکی است، نه یک تست.**
 *
 * `payload-test.php` آن را `require` می‌کند و توابع مشترک (`set_settings`
 * و بقیه) را همان‌جا تعریف کرده. اجرای مستقیم این پرونده یعنی
 * `Call to undefined function set_settings()` و کد خروج ۲۵۵.
 *
 * ⚠️ به همین دلیل از `test/` به `test/helpers/` منتقل شد و نامش دیگر
 *    «test» ندارد: هر کسی که `for f in test/*.php` بزند، دیگر با یک
 *    Fatal روبه‌رو نمی‌شود و گمان نمی‌کند چیزی شکسته است.
 *    `apps/api/test/source-hygiene.test.ts` این را قفل کرده.
 *
 * ⚠️ و نگهبان پایین لازم است چون انتقال به‌تنهایی کافی نیست — کسی
 *    می‌تواند مستقیم همین مسیر را هم اجرا کند.
 */

if (!function_exists('set_settings')) {
    fwrite(STDERR,
        "این پرونده یک کمکی است، نه یک تست — مستقل اجرا نمی‌شود.\n" .
        "  اجرا کنید:  php integrations/woocommerce/test/payload-test.php\n");
    exit(2);
}

class LMC_Stored_Product
{
    public bool $managed = false;
    public ?int $quantity = null;
    public string $status = 'instock';
    public string $price = '1000';
    public string $backorders = 'no';
    public function get_manage_stock() { return $this->managed; }
    public function set_manage_stock($v) { $this->managed = $v; }
    public function get_stock_quantity() { return $this->quantity; }
    public function set_stock_quantity($v) { $this->quantity = $v; }
    public function get_stock_status() { return $this->status; }
    public function set_stock_status($v) { $this->status = $v; }
    public function get_backorders() { return $this->backorders; }
    public function set_backorders($v) { $this->backorders = $v; }
    public function get_regular_price() { return $this->price; }
    public function set_regular_price($v) { $this->price = $v; }
    public function save() { $GLOBALS['stock_saved'] = clone $this; $GLOBALS['stock_saves'] = ($GLOBALS['stock_saves'] ?? 0) + 1; }
}

function get_option($key, $default = false) { return $default; }
function get_posts($args) { return $GLOBALS['stock_found'] ?? [42]; }
function wc_get_product($id) { return clone $GLOBALS['stock_saved']; }
function wp_parse_url($url) { return parse_url($url); }
function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
function wp_safe_remote_request($url, $args) {
    $GLOBALS['stock_requests'] = ($GLOBALS['stock_requests'] ?? 0) + 1;
    $GLOBALS['stock_http_calls'][] = [$url, $args['method']];
    if (str_contains($url, '/web/connection')) { return ['body' => json_encode($GLOBALS['discount_capability'] ?? [])]; }
    if (str_contains($url, '/web/discounted-orders')) { return ['body' => json_encode(['invoiceId' => 'free-invoice', 'number' => 'TEST-1', 'payableAmount' => '0'])]; }
    return ['body' => json_encode(['items' => $GLOBALS['stock_items'] ?? [[
        'variationId' => 'synthetic-stock', 'available' => (string) $GLOBALS['stock_available'], 'price' => null,
    ]]])];
}
function wp_remote_retrieve_response_code($response) { return 200; }
function wp_remote_retrieve_body($response) { return $response['body']; }

set_settings(['sync_stock' => 'yes', 'sync_price' => 'yes',
    'base_url' => 'https://core.example.test', 'api_key' => bin2hex(random_bytes(24))]);

// ⚠️ ستون آخر، سفارش معوق است. با `yes` یا `notify`، ووکامرس در
//    `validate_props()` وضعیت را بازمی‌سازد و موجودی صفر را
//    `onbackorder` می‌کند — `is_in_stock()` درست برمی‌گرداند و ویترین
//    کالای تمام‌شده را می‌فروشد. پس هر سه ستون بالا بی‌اثر می‌شدند.
foreach ([
    ['unmanaged zero stock', false, null, 'instock', 0, 'no'],
    ['managed zero stale status', true, 0, 'instock', 0, 'no'],
    ['positive stock stale status', true, 5, 'outofstock', 5, 'no'],
    ['unmanaged positive stock', false, null, 'instock', 5, 'no'],
    ['backorder yes must be forced off', true, 0, 'onbackorder', 0, 'yes'],
    ['backorder notify must be forced off', true, 0, 'instock', 0, 'notify'],
] as [$label, $managed, $quantity, $status, $available, $backorders]) {
    $p = new LMC_Stored_Product();
    $p->managed = $managed;
    $p->quantity = $quantity;
    $p->status = $status;
    $p->backorders = $backorders;
    $GLOBALS['stock_saved'] = $p;
    $GLOBALS['stock_available'] = $available;
    $result = LMC_Stock_Sync::run();
    $fresh = wc_get_product(42);
    assert_eq("$label persisted management", $fresh->get_manage_stock(), true);
    assert_eq("$label persisted quantity", $fresh->get_stock_quantity(), $available);
    assert_eq("$label persisted status", $fresh->get_stock_status(), $available > 0 ? 'instock' : 'outofstock');
    assert_eq("$label null price preserved", $fresh->get_regular_price(), '1000');
    assert_eq("$label backorders forced off", $fresh->get_backorders(), 'no');
    assert_eq("$label reports update", $result['updated'], 1);
    $saves = $GLOBALS['stock_saves'];
    $replay = LMC_Stock_Sync::run();
    assert_eq("$label replay is unchanged", $replay['updated'], 0);
    assert_eq("$label replay received one", $replay['received'], 1);
    assert_eq("$label replay explicitly unchanged", $replay['unchanged'], 1);
    assert_eq("$label replay does not save", $GLOBALS['stock_saves'], $saves);
}

// «صفر به‌روز شد» در سه حالت متفاوت؛ گزارش باید علت قابل بررسی بدهد.
$requests = $GLOBALS['stock_requests'];
set_settings(['sync_stock' => 'no']);
$disabled = LMC_Stock_Sync::run();
assert_eq('disabled stock has actionable error', str_contains($disabled['error'], 'خاموش'), true);
assert_eq('disabled stock makes no HTTP request', $GLOBALS['stock_requests'], $requests);

set_settings(['sync_stock' => 'yes', 'sync_price' => 'no', 'link_by_sku' => 'no',
    'base_url' => 'https://core.example.test', 'api_key' => bin2hex(random_bytes(24))]);
$GLOBALS['stock_items'] = [];
$empty = LMC_Stock_Sync::run();
assert_eq('empty feed has zero received', $empty['received'], 0);
assert_eq('empty feed explains warehouse balance check', str_contains(LMC_Stock_Sync::manual_summary($empty), 'وجود مانده'), true);
assert_eq('price disabled is explicit', str_contains(LMC_Stock_Sync::manual_summary($empty), 'همگام‌سازی قیمت خاموش'), true);

$GLOBALS['stock_items'] = [['variationId' => 'synthetic-stock', 'sku' => 'synthetic-sku', 'available' => '4', 'price' => null]];
$GLOBALS['stock_found'] = [];
$saves = $GLOBALS['stock_saves'];
$unmapped = LMC_Stock_Sync::run();
assert_eq('unmapped feed received one', $unmapped['received'], 1);
assert_eq('unmapped feed reports skipped', $unmapped['skipped'], 1);
assert_eq('unmapped is not already equal', $unmapped['unchanged'], 0);
assert_eq('unmapped makes no product save', $GLOBALS['stock_saves'], $saves);
assert_eq('unmapped explains SKU check', str_contains(LMC_Stock_Sync::manual_summary($unmapped), 'SKU دقیق'), true);
assert_eq('disabled SKU linking is explicit', str_contains(LMC_Stock_Sync::manual_summary($unmapped), 'اتصال اولیه با SKU خاموش'), true);
$GLOBALS['stock_items'] = [['sku' => 'synthetic-sku']];
$invalid = LMC_Stock_Sync::run();
assert_eq('invalid feed item counted', $invalid['invalid'], 1);
assert_eq('invalid feed item not matched', $invalid['updated'] + $invalid['unchanged'], 0);

// Core قدیمی نباید تخفیف ناشناخته را حذف و قیمت اصلی را ثبت کند.
$cap_payload = ['branchId' => 'b-uuid', 'warehouseId' => 'w-uuid',
    'lines' => [['sku' => 'FREE-SKU', 'qty' => '1', 'unitPrice' => '4500000', 'discountAmount' => '4500000']]];
$GLOBALS['discount_capability'] = ['protocol' => 1, 'authenticated' => true, 'branchId' => 'b-uuid', 'warehouseId' => 'w-uuid'];
assert_eq('Core قدیمی تخفیف را دریافت نمی‌کند', LMC_Order_Sync::check_discount_support($cap_payload)->get_error_code(), 'lmc_discount_api_upgrade');
$GLOBALS['discount_capability']['features'] = ['explicitLineDiscount' => true];
assert_eq('Core سازگار اجازه ارسال می‌دهد', LMC_Order_Sync::check_discount_support($cap_payload), true);
$GLOBALS['discount_capability']['warehouseId'] = 'another-warehouse';
assert_eq('پشتیبانی انبار دیگر پذیرفته نیست', LMC_Order_Sync::check_discount_support($cap_payload)->get_error_code(), 'lmc_discount_api_upgrade');
$requests = $GLOBALS['stock_requests'];
assert_eq('سفارش قدیمی پیش‌نیاز تازه ندارد', LMC_Order_Sync::check_discount_support(['lines' => [['unitPrice' => '1']]]), true);
assert_eq('سفارش قدیمی درخواست اضافه ندارد', $GLOBALS['stock_requests'], $requests);
$blocked_order = new WC_Order();
$blocked_order->id = 2001;
$blocked_order->update_meta_data(LMC_Order_Sync::META_PAID, 'yes');
$blocked_order->update_meta_data(LMC_Order_Sync::META_PAYLOAD, $cap_payload);
$blocked_order->update_meta_data(LMC_Order_Sync::META_LINES, [1 => 1]);
$GLOBALS['lmc_test_orders'][2001] = $blocked_order;
$GLOBALS['stock_http_calls'] = [];
LMC_Order_Sync::send(2001);
assert_eq('ناسازگاری Core پیش از POST مالی متوقف می‌شود', array_column($GLOBALS['stock_http_calls'], 1), ['GET']);
assert_eq('ناسازگاری Core فاکتور موفق وانمود نمی‌شود', $blocked_order->get_meta(LMC_Order_Sync::META_INVOICE), '');
$GLOBALS['discount_capability']['warehouseId'] = 'w-uuid';
$GLOBALS['stock_http_calls'] = [];
// A corrected permanent capability error is reopened by the manual retry path.
LMC_Order_Sync::retry($blocked_order);
assert_eq('ارسال سازگار ابتدا قابلیت و سپس POST دارد', array_column($GLOBALS['stock_http_calls'], 1), ['GET', 'POST']);
assert_eq('تخفیف هرگز به مسیر قدیمی ارسال نمی‌شود', str_ends_with($GLOBALS['stock_http_calls'][1][0], '/web/discounted-orders'), true);
assert_eq('پاسخ مسیر سازگار ثبت می‌شود', $blocked_order->get_meta(LMC_Order_Sync::META_INVOICE), 'free-invoice');
