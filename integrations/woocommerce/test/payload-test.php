<?php
/**
 * تست منطق افزونه ووکامرس — بدون وردپرس، بدون ووکامرس.
 *
 *   php integrations/woocommerce/test/payload-test.php
 *
 * ── چرا این فایل وجود دارد ──────────────────────────────────────────
 *
 * سه چیز در این افزونه هست که اشتباهشان **بی‌صدا** است:
 *
 * ۱. **تبدیل تومان به ریال.** یک ضربدر ۱۰ که جا بیفتد، همه مبالغ یک
 *    صفر کم می‌گیرند و هیچ خطایی هم رخ نمی‌دهد — فقط دفتر یک‌دهم
 *    فروش را نشان می‌دهد.
 *
 * ۲. **قیمت واحد از مبلغ پرداختی سطر.** اگر از قیمت محصول خوانده
 *    شود، کوپن تخفیف ناپدید می‌شود و دفتر درآمدی می‌نویسد که دریافت
 *    نشده.
 *
 * ۳. **نگاشت درگاه.** یک خط بدشکل در تنظیمات نباید کل ارسال را
 *    بشکند.
 *
 * هیچ‌کدام با «افزونه فعال شد و خطا نداد» معلوم نمی‌شوند. برای همین
 * اینجا با Stub سنجیده می‌شوند، نه روی یک وردپرس واقعی.
 */

declare(strict_types=1);

// ── حداقلِ وردپرس/ووکامرس که این کد لمس می‌کند ──────────────────────

define('ABSPATH', __DIR__);
define('LMC_VERSION', 'test');
define('LMC_ORDER_EVENT', 'lmc_send_order');
define('MINUTE_IN_SECONDS', 60);

$GLOBALS['lmc_test_settings'] = [];
$GLOBALS['lmc_test_actions'] = [];
$GLOBALS['lmc_test_orders'] = [];
$GLOBALS['lmc_test_scheduled'] = [];
$GLOBALS['lmc_test_confirm_allowed'] = false;

function current_user_can(string $capability, ...$args): bool
{
    return $GLOBALS['lmc_test_confirm_allowed'];
}

function get_current_user_id(): int { return 42; }

function add_action(string $hook, $callback): void
{
    $GLOBALS['lmc_test_actions'][$hook] = $callback;
}

function wc_get_order(int $order_id)
{
    return $GLOBALS['lmc_test_orders'][$order_id] ?? false;
}

function wp_next_scheduled(string $hook, array $args)
{
    foreach ($GLOBALS['lmc_test_scheduled'] as $event) {
        if ($event['hook'] === $hook && $event['args'] === $args) {
            return $event['timestamp'];
        }
    }
    return false;
}

function wp_schedule_single_event(int $timestamp, string $hook, array $args): void
{
    $GLOBALS['lmc_test_scheduled'][] = compact('timestamp', 'hook', 'args');
}

function lmc_setting(string $key, $default = '')
{
    return $GLOBALS['lmc_test_settings'][$key] ?? $default;
}

function lmc_log(string $message): void {}

function __(string $text, string $domain = ''): string
{
    return $text;
}

function mb_substr_polyfill(string $s, int $start, int $len): string
{
    return function_exists('mb_substr') ? mb_substr($s, $start, $len) : substr($s, $start, $len);
}

class WP_Error
{
    private string $code;
    private string $message;
    private $data;

    public function __construct(string $code = '', string $message = '', $data = null)
    {
        $this->code    = $code;
        $this->message = $message;
        $this->data    = $data;
    }

    public function get_error_code(): string
    {
        return $this->code;
    }

    public function get_error_message(): string
    {
        return $this->message;
    }

    public function get_error_data()
    {
        return $this->data;
    }
}

function is_wp_error($thing): bool
{
    return $thing instanceof WP_Error;
}

/** فقط چیزی که `build_payload` صدا می‌زند. */
class WC_Order_Item_Product
{
    public string $name;
    public int $qty;
    public string $total;
    private $product;

    public function __construct(string $sku, int $qty, string $total, string $name = 'کالا')
    {
        $this->name    = $name;
        $this->qty     = $qty;
        $this->total   = $total;
        $this->product = $sku === '' ? new LMC_Test_Product('') : new LMC_Test_Product($sku);
    }

    public function get_product()
    {
        return $this->product;
    }

    public function get_quantity(): int
    {
        return $this->qty;
    }

    public function get_total(): string
    {
        return $this->total;
    }

    public function get_name(): string
    {
        return $this->name;
    }
}

class LMC_Test_Product
{
    private string $sku;

    public function __construct(string $sku)
    {
        $this->sku = $sku;
    }

    public function get_sku(): string
    {
        return $this->sku;
    }
}

class WC_Order
{
    public array $items = [];
    public string $total = '0';
    public string $shipping = '0';
    public string $phone = '';
    public string $first = '';
    public string $last = '';
    public string $method = 'zarinpal';
    public string $txn = '';
    public string $customer_note = '';
    public int $id = 1001;
    public string $status = 'processing';
    private array $meta = [];

    public function get_items(): array
    {
        return $this->items;
    }

    public function get_total(): string
    {
        return $this->total;
    }

    public function get_shipping_total(): string
    {
        return $this->shipping;
    }

    public function get_billing_phone(): string
    {
        return $this->phone;
    }

    public function get_billing_first_name(): string
    {
        return $this->first;
    }

    public function get_billing_last_name(): string
    {
        return $this->last;
    }

    public function get_payment_method(): string
    {
        return $this->method;
    }

    public function get_transaction_id(): string
    {
        return $this->txn;
    }

    public function get_customer_note(): string
    {
        return $this->customer_note;
    }

    public function get_id(): int
    {
        return $this->id;
    }

    public function get_order_number(): string
    {
        return (string) $this->id;
    }

    public function has_status($status): bool
    {
        return in_array($this->status, (array) $status, true);
    }

    public function get_meta(string $key)
    {
        return $this->meta[$key] ?? '';
    }

    public function update_meta_data(string $key, $value): void
    {
        $this->meta[$key] = $value;
    }

    public function delete_meta_data(string $key): void
    {
        unset($this->meta[$key]);
    }

    public function add_order_note(string $note): void {}

    public function save(): void {}
}

// افزونه بدون این ثابت‌ها بارگذاری نمی‌شود؛ فایل اصلی را نمی‌خوانیم
// چون به وردپرس واقعی نیاز دارد.
define('LMC_STOCK_EVENT', 'lmc_sync_stock');
define('LMC_INSTORE_EVENT', 'lmc_sync_instore');

require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-client.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-order-sync.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-stock-sync.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-instore.php';

// ── ابزار ادعا ──────────────────────────────────────────────────────

$failed = 0;
$passed = 0;

function assert_eq(string $label, $actual, $expected): void
{
    global $failed, $passed;
    if ($actual === $expected) {
        $passed++;
        printf("  ✓ %s = %s\n", $label, var_export($actual, true));
        return;
    }
    $failed++;
    printf(
        "  ✗ %s\n      انتظار: %s\n      واقعی : %s\n",
        $label,
        var_export($expected, true),
        var_export($actual, true)
    );
}

function set_settings(array $s): void
{
    $GLOBALS['lmc_test_settings'] = array_merge([
        'branch_id'     => 'b-uuid',
        'warehouse_id'  => 'w-uuid',
        'currency_unit' => 'toman',
        'payment_map'   => '',
    ], $s);
}

// ── احراز پرداخت و بازبینی وضعیت ───────────────────────────────────

echo "── احراز پرداخت سفارش ───────────────────────────────────────\n";

LMC_Order_Sync::init();
assert_eq(
    'فقط رویداد موفق پرداخت سفارش را صف می‌کند',
    isset($GLOBALS['lmc_test_actions']['woocommerce_payment_complete']),
    true
);
assert_eq(
    'processing به‌تنهایی hook ارسال نیست',
    isset($GLOBALS['lmc_test_actions']['woocommerce_order_status_processing']),
    false
);

$paid_order = new WC_Order();
$GLOBALS['lmc_test_orders'][$paid_order->id] = $paid_order;
LMC_Order_Sync::payment_complete($paid_order->id);
assert_eq('تأیید پرداخت ثبت می‌شود', $paid_order->get_meta(LMC_Order_Sync::META_PAID), 'yes');
assert_eq('پرداخت موفق یک کار می‌سازد', count($GLOBALS['lmc_test_scheduled']), 1);

// کار صف‌شده بعد از لغو باید پیش از ساخت payload و POST متوقف شود.
$paid_order->status = 'cancelled';
LMC_Order_Sync::send($paid_order->id);
assert_eq('سفارش لغوشده ثبت نمی‌شود', $paid_order->get_meta(LMC_Order_Sync::META_INVOICE), '');
assert_eq('سفارش لغوشده حتی به ساخت بدنه نمی‌رسد', $paid_order->get_meta(LMC_Order_Sync::META_ERROR), '');

$cod_order = new WC_Order();
$cod_order->id = 1002;
$cod_order->method = 'cod';
$GLOBALS['lmc_test_orders'][$cod_order->id] = $cod_order;
LMC_Order_Sync::send($cod_order->id);
assert_eq('پرداخت در محل بدون payment_complete ثبت نمی‌شود', $cod_order->get_meta(LMC_Order_Sync::META_INVOICE), '');
assert_eq('پرداخت در محل حتی به ساخت بدنه نمی‌رسد', $cod_order->get_meta(LMC_Order_Sync::META_ERROR), '');

$legacy_order = new WC_Order();
$legacy_order->id = 1003;
$denied = LMC_Order_Sync::confirm_legacy_payment($legacy_order, 'BANK-123');
assert_eq('تأیید دستی بدون دسترسی رد می‌شود', $denied->get_error_code(), 'payment_confirmation_forbidden');
assert_eq('رد مجوز هیچ نشان پرداختی نمی‌سازد', $legacy_order->get_meta(LMC_Order_Sync::META_PAID), '');
$GLOBALS['lmc_test_confirm_allowed'] = true;
$empty = LMC_Order_Sync::confirm_legacy_payment($legacy_order, ' ');
assert_eq('بدون سند دریافت وجه تأیید نمی‌شود', $empty->get_error_code(), 'payment_confirmation_invalid');
$legacy_order->status = 'cancelled';
$cancelled = LMC_Order_Sync::confirm_legacy_payment($legacy_order, 'BANK-123');
assert_eq('سفارش لغوشده دستی هم ثبت نمی‌شود', $cancelled->get_error_code(), 'payment_confirmation_invalid');
$legacy_order->status = 'completed';
assert_eq('سفارش قدیمی با تأیید صریح بازیابی می‌شود', LMC_Order_Sync::confirm_legacy_payment($legacy_order, 'BANK-123'), true);
assert_eq('مدرک دریافت وجه نگهداری می‌شود', $legacy_order->get_meta('_lmc_payment_evidence')['reference'], 'BANK-123');
assert_eq('عامل تأیید دریافت وجه ثبت می‌شود', $legacy_order->get_meta('_lmc_payment_evidence')['actor'], 42);
assert_eq('تأیید دستی نشان پرداخت را می‌سازد', $legacy_order->get_meta(LMC_Order_Sync::META_PAID), 'yes');
$queued = count($GLOBALS['lmc_test_scheduled']);
LMC_Order_Sync::confirm_legacy_payment($legacy_order, 'BANK-123');
assert_eq('تأیید دوباره صف را تکراری نمی‌کند', count($GLOBALS['lmc_test_scheduled']), $queued);
$GLOBALS['lmc_test_confirm_allowed'] = false;

// ── واحد پول ────────────────────────────────────────────────────────

echo "── تبدیل واحد پول ────────────────────────────────────────────\n";

set_settings(['currency_unit' => 'toman']);
assert_eq('تومان → ریال (×۱۰)', LMC_Order_Sync::to_rial('150000'), 1500000);
assert_eq('تومان با اعشار گرد می‌شود', LMC_Order_Sync::to_rial('150000.4'), 1500004);

set_settings(['currency_unit' => 'rial']);
assert_eq('ریال دست‌نخورده می‌ماند', LMC_Order_Sync::to_rial('1500000'), 1500000);

// ⚠️ خروجی همیشه صحیح است: پول در آن سامانه اعشار ندارد و رشته‌ای با
//    نقطه، همان‌جا روی Regex رد می‌شد.
assert_eq('خروجی همیشه int است', is_int(LMC_Order_Sync::to_rial('1.5')), true);

// ── نگاشت درگاه ─────────────────────────────────────────────────────

echo "\n── نگاشت درگاه پرداخت ────────────────────────────────────────\n";

$map = LMC_Order_Sync::parse_map("zarinpal=gateway\n cod = cash \n\nbadline\n=x\ny=");
assert_eq('خط سالم خوانده شد', $map['zarinpal'] ?? null, 'gateway');
assert_eq('فاصله اضافه نادیده گرفته می‌شود', $map['cod'] ?? null, 'cash');
assert_eq('خط بدون = رد می‌شود', isset($map['badline']), false);
assert_eq('کلید خالی رد می‌شود', isset($map['']), false);
assert_eq('مقدار خالی رد می‌شود', isset($map['y']), false);

set_settings(['payment_map' => "zarinpal=gateway\ncod=cash"]);
$o         = new WC_Order();
$o->method = 'cod';
assert_eq('درگاه نگاشت‌شده', LMC_Order_Sync::map_payment_method($o), 'cash');

$o->method = 'unknown-gateway';
// درگاه ناشناخته نباید سفارش را رد کند: «gateway» یک پیش‌فرض معقول
// است و سفارشِ ثبت‌نشده بدتر از روش پرداختِ تقریبی است.
assert_eq('درگاه ناشناخته → پیش‌فرض', LMC_Order_Sync::map_payment_method($o), 'gateway');

// ── ساخت بدنه ───────────────────────────────────────────────────────

echo "\n── بدنه درخواست ──────────────────────────────────────────────\n";

set_settings([]);
$order        = new WC_Order();
$order->items = [
    // ۲ عدد، مجموع ۲۴۰٬۰۰۰ تومان → واحد ۱۲۰٬۰۰۰ تومان = ۱٬۲۰۰٬۰۰۰ ریال
    new WC_Order_Item_Product('SKU-A', 2, '240000'),
    new WC_Order_Item_Product('SKU-B', 1, '90000'),
];
$order->total    = '360000';
$order->shipping = '30000';
$order->phone    = '09123456789';
$order->first    = 'علی';
$order->last     = 'رضایی';
$order->txn      = 'REF-9';

$payload = LMC_Order_Sync::build_payload($order);
assert_eq('بدنه ساخته شد', is_array($payload), true);
assert_eq('شناسه سفارش، هویت عملیات است', $payload['externalId'], '1001');
assert_eq('قیمت واحد از مبلغ پرداختی سطر', $payload['lines'][0]['unitPrice'], '1200000');
assert_eq('تعداد رشته است', $payload['lines'][0]['qty'], '2');
assert_eq('کرایه جدا از اقلام', $payload['shippingAmount'], '300000');
assert_eq('مبلغ پرداختی', $payload['paidAmount'], '3600000');
assert_eq('موبایل بدون نرمال‌سازی محلی', $payload['customerMobile'], '09123456789');
assert_eq('نام مشتری', $payload['customerName'], 'علی رضایی');
assert_eq('شماره پیگیری', $payload['paymentRef'], 'REF-9');

// ⚠️ هسته این فایل: جمع سطرها به‌علاوه کرایه باید دقیقاً همان مبلغی
//    باشد که از مشتری گرفته‌ایم. اگر نه، دفتر و درگاه دو عدد متفاوت
//    می‌گویند و کسی نمی‌داند کدام درست است.
$sum = 0;
foreach ($payload['lines'] as $line) {
    $sum += ((int) $line['unitPrice']) * ((int) $line['qty']);
}
$sum += (int) $payload['shippingAmount'];
assert_eq('جمع سطرها + کرایه = مبلغ پرداختی', (string) $sum, $payload['paidAmount']);

// ── خطاهای دائمی ────────────────────────────────────────────────────

echo "\n── آنچه باید رد شود ──────────────────────────────────────────\n";

$noSku        = new WC_Order();
$noSku->items = [new WC_Order_Item_Product('', 1, '100000', 'شلوار بی‌کد')];
$err          = LMC_Order_Sync::build_payload($noSku);
assert_eq('کالای بدون SKU رد می‌شود', is_wp_error($err), true);
assert_eq('و دائمی است، نه قابل تلاش دوباره', $err->get_error_data()['kind'], LMC_Client::PERMANENT);

$freebie        = new WC_Order();
$freebie->items = [new WC_Order_Item_Product('SKU-C', 1, '0', 'هدیه')];
$err            = LMC_Order_Sync::build_payload($freebie);
assert_eq('قلم با قیمت صفر رد می‌شود', is_wp_error($err), true);

$empty        = new WC_Order();
$empty->items = [];
$err          = LMC_Order_Sync::build_payload($empty);
assert_eq('سفارش بی‌قلم رد می‌شود', is_wp_error($err), true);

set_settings(['branch_id' => '', 'warehouse_id' => '']);
$err = LMC_Order_Sync::build_payload($order);
assert_eq('بدون شعبه و انبار، اصلاً فرستاده نمی‌شود', is_wp_error($err), true);


// ═══════════════════════════════════════════════════════════════════
echo "\n── قیمتی که به ویترین می‌رود ────────────────────────────────\n";
// ═══════════════════════════════════════════════════════════════════
// عکسِ `to_rial()` و دقیقاً به همان اندازه حساس: غلط بودنش یعنی همه
// قیمت‌های سایت یک صفر کم یا زیاد داشته باشند.

set_settings(['currency_unit' => 'toman']);
assert_eq('ریال به تومان، تقسیم صحیح',
    LMC_Stock_Sync::price_for_site(['price' => '2000000']), '200000');

set_settings(['currency_unit' => 'rial']);
assert_eq('سایت ریالی، همان عدد',
    LMC_Stock_Sync::price_for_site(['price' => '2000000']), '2000000');

set_settings(['currency_unit' => 'toman']);
// **مهم‌ترین ادعای این بخش.** `null` یعنی «قیمت ندارد»، نه «مجانی».
// نوشتن صفر یعنی ویترین کالا را رایگان بفروشد.
assert_eq('قیمت null دست نمی‌خورد',
    LMC_Stock_Sync::price_for_site(['price' => null]), null);
assert_eq('قیمت غایب دست نمی‌خورد',
    LMC_Stock_Sync::price_for_site([]), null);
assert_eq('قیمت خالی دست نمی‌خورد',
    LMC_Stock_Sync::price_for_site(['price' => '']), null);
// خوراک باید رقم صحیح بدهد. هر چیز دیگری یعنی چیزی عوض شده و حدس‌زدن
// بدتر از ننوشتن است.
assert_eq('قیمت اعشاری رد می‌شود',
    LMC_Stock_Sync::price_for_site(['price' => '2000000.5']), null);
assert_eq('قیمت غیرعددی رد می‌شود',
    LMC_Stock_Sync::price_for_site(['price' => 'رایگان']), null);
assert_eq('قیمت منفی رد می‌شود',
    LMC_Stock_Sync::price_for_site(['price' => '-100']), null);
// صفرِ **واقعی** یعنی قیمت صفر ثبت شده — آن با «قیمت ندارد» یکی نیست.
assert_eq('صفر واقعی همان صفر است',
    LMC_Stock_Sync::price_for_site(['price' => '0']), '0');

// ═══════════════════════════════════════════════════════════════════
echo "\n── خرید حضوری: نگهبان حلقه ─────────────────────────────────\n";
// ═══════════════════════════════════════════════════════════════════
// ⚠️ **ادعای مرکزی این افزونه.** سفارشی که از سایت آمده اگر به سایت
//    برگردد، رکورد تازه می‌سازد و چرخه بسته می‌شود. سرور هم ردش
//    می‌کند؛ این نگهبان دوم است چون یکی‌شان روزی برداشته می‌شود.

set_settings(['sync_instore' => 'yes']);
assert_eq('سفارش کانال web وارد نمی‌شود',
    LMC_Instore::import_one([
        'invoiceId' => 'x', 'channel' => 'web',
        'customer'  => ['mobile' => '09121110000'],
    ]), 'skipped');

assert_eq('بدون شماره موبایل وارد نمی‌شود',
    LMC_Instore::import_one([
        'invoiceId' => 'x', 'channel' => 'pos', 'customer' => ['mobile' => ''],
    ]), 'skipped');

assert_eq('بدون شناسه فاکتور وارد نمی‌شود',
    LMC_Instore::import_one([
        'invoiceId' => '', 'channel' => 'pos',
        'customer'  => ['mobile' => '09121110000'],
    ]), 'skipped');

assert_eq('ورودی بی‌شکل وارد نمی‌شود', LMC_Instore::import_one('نه یک آرایه'), 'skipped');

// ═══════════════════════════════════════════════════════════════════
echo "\n── نرمال‌سازی شماره موبایل ─────────────────────────────────\n";
// ═══════════════════════════════════════════════════════════════════
// اگر این با `sales.normalize_mobile` یکی نباشد، مشتری‌ای که یک بار
// آنلاین و یک بار حضوری خرید کند **دو حساب** پیدا می‌کند و سابقه‌اش
// بینشان گم می‌شود.

foreach ([
    '09121110000'    => '09121110000',
    '9121110000'     => '09121110000',
    '989121110000'   => '09121110000',
    '00989121110000' => '09121110000',
    '0912 111 0000'  => '09121110000',
    '0912-111-0000'  => '09121110000',
    '۰۹۱۲۱۱۱۰۰۰۰'    => '09121110000',
    '٠٩١٢١١١٠٠٠٠'    => '09121110000',
] as $raw => $want) {
    assert_eq("شماره «{$raw}»", LMC_Instore::normalize_mobile((string) $raw), $want);
}

// چیزی که موبایل ایرانی نیست، حساب نمی‌سازد.
//
// ⚠️ این عمداً با `sales.normalize_mobile` فرق دارد: آنجا شماره
//    نامعتبر دست‌نخورده برمی‌گردد (فقط یکتایی مشتری مهم است)، اینجا رد
//    می‌شود. حساب کاربری با تلفن ثابت نه ورود دارد و نه بازیابی رمز.
//    آن خرید وارد نمی‌شود و لاگ می‌شود — نه اینکه بی‌صدا گم شود.
foreach (['', '021884', '0912111000', '091211100001', 'سلام'] as $bad) {
    assert_eq("«{$bad}» موبایل نیست", LMC_Instore::normalize_mobile($bad), '');
}

// ═══════════════════════════════════════════════════════════════════
echo "\n── اقلامی که روی صفحه می‌روند ──────────────────────────────\n";
// ═══════════════════════════════════════════════════════════════════
// هرچه از سرور بیاید در متا می‌نشیند و بعد روی صفحه می‌رود، پس به
// شکل مورد انتظار محدود می‌شود — نه اینکه ساختار دلخواه ذخیره شود.

$clean = LMC_Instore::clean_lines([
    ['name' => 'شومیز', 'qty' => '2', 'unitPrice' => '2000000', 'extra' => 'نباید بماند'],
    'نه یک آرایه',
]);
assert_eq('سطر بی‌شکل حذف می‌شود', count($clean), 1);
assert_eq('کلید ناشناخته نگه داشته نمی‌شود', isset($clean[0]['extra']), false);
assert_eq('کلید غایب رشته خالی می‌شود', $clean[0]['sku'], '');
assert_eq('نام می‌ماند', $clean[0]['name'], 'شومیز');
assert_eq('ورودی بی‌شکل، آرایه خالی', LMC_Instore::clean_lines('نه'), []);

// ═══════════════════════════════════════════════════════════════════
echo "\n── مبلغ نمایشی خرید حضوری ──────────────────────────────────\n";
// ═══════════════════════════════════════════════════════════════════

set_settings(['currency_unit' => 'toman']);
assert_eq('ریال ذخیره‌شده، تومان نمایش', LMC_Instore::to_site_amount('2000000'), 200000.0);
set_settings(['currency_unit' => 'rial']);
assert_eq('سایت ریالی، همان عدد', LMC_Instore::to_site_amount('2000000'), 2000000.0);
assert_eq('مبلغ بی‌شکل صفر می‌شود', LMC_Instore::to_site_amount('نه عدد'), 0.0);

// ── خلاصه ───────────────────────────────────────────────────────────

echo "\n";
require __DIR__ . '/helpers/stock-run-case.php';

if ($failed > 0) {
    printf("✗ %d ادعا شکست خورد (%d پاس)\n", $failed, $passed);
    exit(1);
}
printf("✓ همه %d ادعای افزونه ووکامرس پاس شدند\n", $passed);
