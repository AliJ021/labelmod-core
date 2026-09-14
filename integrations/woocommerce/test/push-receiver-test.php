<?php
/**
 * تست گیرندهٔ ارسال لحظه‌ای — بدون وردپرس، بدون ووکامرس.
 *
 *   php integrations/woocommerce/test/push-receiver-test.php
 *
 * ── چرا این فایل وجود دارد ──────────────────────────────────────────
 *
 * `class-lmc-push-receiver.php` تنها مسیری است که از بیرون **به داخل**
 * سایت می‌نویسد. چهار چیزش بی‌صدا می‌شکند:
 *
 * ۱. **امضا.** یک `===` به‌جای `hash_equals`، یا امضا روی JSON
 *    بازتولیدشده به‌جای بدنهٔ خام — هر دو «کار می‌کنند».
 * ۲. **پنجرهٔ زمانی و Nonce.** بی هر کدام، یک درخواست ضبط‌شده دوباره
 *    پذیرفته می‌شود و هیچ‌جا خطایی نیست.
 * ۳. **نگهبان ترتیب.** `>` به‌جای `>=` یعنی تحویل تکراری بنویسد.
 * ۴. **صفر و null.** `priceRial = null` اگر صفر تعبیر شود، ویترین کالا
 *    را رایگان می‌فروشد.
 *
 * هیچ‌کدام با «افزونه فعال شد و خطا نداد» معلوم نمی‌شوند.
 */

declare(strict_types=1);

define('ABSPATH', __DIR__);
define('LMC_VERSION', 'test');
define('LMC_PUSH_SECRET', 'کلید-تست-۱۲۳');

function lmc_log(string $message): void {}
function lmc_setting(string $key, $default = '') { return $default; }

// ── حداقلِ وردپرس ───────────────────────────────────────────────────

class WP_Error
{
    public string $code;
    public string $message;
    public array $data;
    public function __construct(string $code = '', string $message = '', array $data = [])
    {
        $this->code = $code;
        $this->message = $message;
        $this->data = $data;
    }
    public function get_error_code(): string { return $this->code; }
    public function status(): int { return (int) ($this->data['status'] ?? 0); }
}

$GLOBALS['lmc_transients'] = [];
function get_transient(string $k) { return $GLOBALS['lmc_transients'][$k] ?? false; }
function set_transient(string $k, $v, int $ttl): bool { $GLOBALS['lmc_transients'][$k] = $v; return true; }

$GLOBALS['lmc_meta'] = [];
function get_post_meta(int $id, string $key, bool $single = false)
{
    return $GLOBALS['lmc_meta'][$id][$key] ?? '';
}
function update_post_meta(int $id, string $key, $value): bool
{
    $GLOBALS['lmc_meta'][$id][$key] = $value;
    return true;
}
function add_action(string $h, $cb, int $p = 10, int $n = 1): void {}
function register_rest_route(string $ns, string $route, array $args): void
{
    $GLOBALS['lmc_routes'][$ns . $route] = $args;
}

/** محصول ساختگی — فقط همان متدهایی که این کد لمس می‌کند. */
class Fake_Product
{
    public bool $manage = false;
    public $qty = null;
    public string $backorders = 'yes';
    public string $status = 'outofstock';
    public string $regular = '';
    public int $saves = 0;

    public function get_manage_stock(): bool { return $this->manage; }
    public function set_manage_stock(bool $v): void { $this->manage = $v; }
    public function get_stock_quantity() { return $this->qty; }
    public function set_stock_quantity($v): void { $this->qty = $v; }
    public function get_backorders(): string { return $this->backorders; }
    public function set_backorders(string $v): void { $this->backorders = $v; }
    public function get_stock_status(): string { return $this->status; }
    public function set_stock_status(string $v): void { $this->status = $v; }
    public function get_regular_price(): string { return $this->regular; }
    public function set_regular_price($v): void { $this->regular = (string) $v; }
    public function save(): void { $this->saves++; }
}

$GLOBALS['lmc_products'] = [];
function wc_get_product(int $id) { return $GLOBALS['lmc_products'][$id] ?? null; }

/** درخواست REST ساختگی — بدنهٔ خام و هدرها، همان چیزی که امضا می‌شود. */
class Fake_Request
{
    private array $headers;
    private string $body;
    public function __construct(array $headers, string $body)
    {
        $this->headers = array_change_key_case($headers, CASE_LOWER);
        $this->body = $body;
    }
    public function get_header(string $n) { return $this->headers[strtolower($n)] ?? ''; }
    public function get_body(): string { return $this->body; }
    public function get_json_params() { return json_decode($this->body, true); }
}

require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-stock-sync.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-receiver.php';

// `find_by_meta` به دیتابیس وردپرس می‌رود؛ اینجا با نگاشت ساده جایگزین
// می‌شود. (کلاس اصلی دست نمی‌خورد — فقط جدول نگاشت تست.)
$GLOBALS['lmc_link'] = [];

// ── چارچوب ادعا ─────────────────────────────────────────────────────

$passed = 0;
$failed = 0;
function ok(string $label, $actual, $expected): void
{
    global $passed, $failed;
    if ($actual === $expected) {
        $passed++;
        echo "  ✓ {$label}\n";
    } else {
        $failed++;
        echo "  ✗ {$label}\n      انتظار: " . var_export($expected, true)
           . "\n      واقعی : " . var_export($actual, true) . "\n";
    }
}

function sign(string $ts, string $nonce, string $body): string
{
    return 'sha256=' . hash_hmac('sha256', $ts . '.' . $nonce . '.' . $body, LMC_PUSH_SECRET);
}

function req(array $payload, ?string $ts = null, ?string $nonce = null, ?string $sig = null): Fake_Request
{
    $body  = json_encode($payload, JSON_UNESCAPED_UNICODE);
    $ts    = $ts ?? (string) time();
    $nonce = $nonce ?? bin2hex(random_bytes(8));
    return new Fake_Request([
        'x-lmc-timestamp' => $ts,
        'x-lmc-nonce'     => $nonce,
        'x-lmc-signature' => $sig ?? sign($ts, $nonce, $body),
    ], $body);
}

// ═══════════════════════════════════════════════════════════════════
echo "\n═══ ۱. امضا ═══\n";
// ═══════════════════════════════════════════════════════════════════

$p = ['variationId' => 'v-1', 'onHand' => 5, 'version' => 10];
ok('امضای درست پذیرفته می‌شود', LMC_Push_Receiver::verify_request(req($p)), true);

$bad = LMC_Push_Receiver::verify_request(req($p, null, null, 'sha256=' . str_repeat('0', 64)));
ok('امضای غلط → ۴۰۳', $bad instanceof WP_Error ? $bad->status() : 0, 403);

// ⚠️ ادعای مرکزی: بدنه **پس از امضا** دست‌کاری شود.
$body = json_encode(['variationId' => 'v-1', 'onHand' => 5, 'version' => 10]);
$ts = (string) time(); $n = bin2hex(random_bytes(8));
$tampered = new Fake_Request([
    'x-lmc-timestamp' => $ts, 'x-lmc-nonce' => $n,
    'x-lmc-signature' => sign($ts, $n, $body),
], json_encode(['variationId' => 'v-1', 'onHand' => 9999, 'version' => 10]));
$r = LMC_Push_Receiver::verify_request($tampered);
ok('بدنهٔ دست‌کاری‌شده → ۴۰۳', $r instanceof WP_Error ? $r->status() : 0, 403);

$r = LMC_Push_Receiver::verify_request(new Fake_Request([], '{}'));
ok('هدر ناقص → ۴۰۱', $r instanceof WP_Error ? $r->status() : 0, 401);

// ═══════════════════════════════════════════════════════════════════
echo "\n═══ ۲. پنجرهٔ زمانی و Nonce ═══\n";
// ═══════════════════════════════════════════════════════════════════

$old = (string) (time() - 400);
$r = LMC_Push_Receiver::verify_request(req($p, $old));
ok('مهر زمانی کهنه (۴۰۰ ثانیه) → ۴۰۱', $r instanceof WP_Error ? $r->status() : 0, 401);

// ⚠️ پنجره **دوطرفه** است — ساعت جلوی فرستنده هم همان‌قدر ممکن است.
$future = (string) (time() + 400);
$r = LMC_Push_Receiver::verify_request(req($p, $future));
ok('مهر زمانی از آینده → ۴۰۱', $r instanceof WP_Error ? $r->status() : 0, 401);

$edge = (string) (time() - 299);
ok('درون پنجره (۲۹۹ ثانیه) پذیرفته می‌شود',
   LMC_Push_Receiver::verify_request(req($p, $edge)), true);

$ts = (string) time(); $n = bin2hex(random_bytes(8));
$once = req($p, $ts, $n);
ok('بار اول پذیرفته می‌شود', LMC_Push_Receiver::verify_request($once), true);
$again = req($p, $ts, $n);
$r = LMC_Push_Receiver::verify_request($again);
ok('همان Nonce دوباره → ۴۰۹ (Replay)', $r instanceof WP_Error ? $r->status() : 0, 409);

// ═══════════════════════════════════════════════════════════════════
echo "\n═══ ۳. نشاندن موجودی — و صفر ═══\n";
// ═══════════════════════════════════════════════════════════════════

$prod = new Fake_Product();
ok('صفر → outofstock', LMC_Stock_Sync::apply_stock($prod, 0), true);
ok('  و وضعیت', $prod->status, 'outofstock');
ok('  و backorders خاموش شد', $prod->backorders, 'no');
ok('  و مدیریت موجودی روشن شد', $prod->manage, true);

$prod2 = new Fake_Product();
LMC_Stock_Sync::apply_stock($prod2, 7);
ok('هفت → instock', $prod2->status, 'instock');
ok('  و تعداد', $prod2->qty, 7);

// بار دوم با همان عدد: **هیچ چیزی عوض نمی‌شود**.
ok('همان عدد دوباره → بدون تغییر', LMC_Stock_Sync::apply_stock($prod2, 7), false);

// ═══════════════════════════════════════════════════════════════════
echo "\n═══ ۴. قیمت — null هرگز صفر نمی‌شود ═══\n";
// ═══════════════════════════════════════════════════════════════════

$prod3 = new Fake_Product();
$prod3->regular = '185000';
ok('priceRial = null → دست نمی‌خورد', LMC_Stock_Sync::apply_price($prod3, null), false);
ok('  و قیمت قبلی سر جایش است', $prod3->regular, '185000');
ok('قیمت تازه نوشته می‌شود', LMC_Stock_Sync::apply_price($prod3, '200000'), true);
ok('  و مقدارش', $prod3->regular, '200000');
ok('همان قیمت دوباره → بدون تغییر', LMC_Stock_Sync::apply_price($prod3, '200000'), false);

// ⚠️ و تبدیل ریال به واحد سایت هم `null` را نگه می‌دارد.
ok('price_for_site(null) = null', LMC_Stock_Sync::price_for_site(['price' => null]), null);

echo "\n";
if ($failed > 0) {
    echo "✗ {$failed} ادعا شکست خورد ({$passed} پاس)\n";
    exit(1);
}
echo "✓ همه {$passed} ادعای گیرندهٔ Push پاس شدند\n";
