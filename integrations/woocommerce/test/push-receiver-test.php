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
$GLOBALS['lmc_test_settings'] = ['sync_stock' => 'yes', 'sync_price' => 'yes'];
function lmc_setting(string $key, $default = '') { return $GLOBALS['lmc_test_settings'][$key] ?? $default; }

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

$GLOBALS['lmc_options'] = [];
function get_option(string $k, $default = false) { return $GLOBALS['lmc_options'][$k] ?? $default; }
function update_option(string $k, $v, $autoload = null): bool { $GLOBALS['lmc_options'][$k] = $v; return true; }
function dbDelta(string $sql): array { $GLOBALS['lmc_ddl'][] = $sql; return []; }

/**
 * `$wpdb` ساختگی — فقط همان چهار چیزی که `LMC_Push_Guard` لمس می‌کند.
 *
 * ⚠️ این کلاس **رفتار** MySQL را تقلید می‌کند، نه فقط امضایش: درج
 *    تکراری روی کلید اصلی «۰ سطر + خطای Duplicate» می‌دهد، و
 *    `GET_LOCK` دوباره روی نامی که گرفته شده `0` برمی‌گرداند. ادعاهای
 *    بند ۹ و ۱۰ بی این رفتار چیزی ثابت نمی‌کردند.
 */
class Fake_Wpdb
{
    public string $prefix = 'wp_';
    public string $last_error = '';
    /** Nonceهای ثبت‌شده — نقش جدول با کلید اصلی. */
    public array $nonces = [];
    /** قفل‌های گرفته‌شده. */
    public array $locks = [];
    /** خطای تحمیلی برای درج Nonce: رشتهٔ خطا، یا null. */
    public ?string $force_insert_error = null;
    /** قفل‌هایی که **نباید** گرفته شوند — تقلید Worker دیگر. */
    public array $deny_locks = [];
    /** تابعی که در لحظهٔ گرفتن قفل اجرا می‌شود — برای اثبات «زیر قفل». */
    public $on_acquire = null;
    public array $queries = [];

    public function get_charset_collate(): string { return ''; }

    public function prepare(string $sql, ...$args): string
    {
        // ترتیب جانشینی همان ترتیب آرگومان‌ها است؛ برای این تست کافی.
        $out = '';
        $i = 0;
        $len = strlen($sql);
        for ($k = 0; $k < $len; $k++) {
            if ($sql[$k] === '%' && $k + 1 < $len && ($sql[$k + 1] === 's' || $sql[$k + 1] === 'd')) {
                $v = $args[$i++] ?? '';
                $out .= $sql[$k + 1] === 'd' ? (string) (int) $v : "'" . $v . "'";
                $k++;
                continue;
            }
            $out .= $sql[$k];
        }
        return $out;
    }

    public function query(string $sql)
    {
        $this->queries[] = $sql;

        if (stripos($sql, 'INSERT INTO') === 0 && strpos($sql, 'lmc_push_nonce') !== false) {
            if ($this->force_insert_error !== null) {
                $this->last_error = $this->force_insert_error;
                return false;
            }
            preg_match("/VALUES \\('([^']*)'/", $sql, $m);
            $nonce = $m[1] ?? '';
            if (isset($this->nonces[$nonce])) {
                // همان چیزی که MySQL می‌دهد.
                $this->last_error = "Duplicate entry '{$nonce}' for key 'PRIMARY'";
                return false;
            }
            $this->nonces[$nonce] = time();
            $this->last_error = '';
            return 1;
        }

        if (stripos($sql, 'RELEASE_LOCK') !== false) {
            preg_match("/RELEASE_LOCK\\('([^']*)'/", $sql, $m);
            unset($this->locks[$m[1] ?? '']);
            return 1;
        }

        // DELETE پاک‌سازی و هر چیز دیگر
        return 0;
    }

    public function get_var(string $sql)
    {
        $this->queries[] = $sql;
        if (stripos($sql, 'GET_LOCK') !== false) {
            preg_match("/GET_LOCK\\('([^']*)'/", $sql, $m);
            $name = $m[1] ?? '';
            if (in_array($name, $this->deny_locks, true) || isset($this->locks[$name])) {
                return '0';
            }
            $this->locks[$name] = true;
            if (is_callable($this->on_acquire)) {
                ($this->on_acquire)($name);
            }
            return '1';
        }
        return null;
    }
}

$GLOBALS['wpdb'] = new Fake_Wpdb();

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
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-guard.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-receiver.php';

// `find_by_meta` به دیتابیس وردپرس می‌رود؛ اینجا `get_posts` با همان
// نگاشت جایگزین می‌شود. (کلاس اصلی دست نمی‌خورد و همان مسیر واقعی
// اجرا می‌شود — فقط منبع پاسخ عوض شده.)
$GLOBALS['lmc_link'] = [];
function get_posts(array $args): array
{
    $want = (string) ($args['meta_value'] ?? '');
    $id   = $GLOBALS['lmc_link'][$want] ?? 0;
    return $id === 0 ? [] : [$id];
}

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

// ═══════════════════════════════════════════════════════════════════
echo "\n═══ ۵. Nonce اتمیک است و fail-open نمی‌دهد (FND-R60-03) ═══\n";
// ═══════════════════════════════════════════════════════════════════
//
// ⚠️ نسخهٔ قبلی `get_transient()` و بعد `set_transient()` بود — دو عمل
//    جدا با یک پنجرهٔ باز وسطش. و روی نصب پیش‌فرض وردپرس Object Cache
//    درون‌حافظه‌ای و تک‌درخواستی است، پس آن نگهبان **بین دو درخواست
//    اصلاً وجود نداشت**. حالا یک `INSERT` روی کلید اصلی.

$wpdb = $GLOBALS['wpdb'];

$n1 = bin2hex(random_bytes(8));
ok('Nonce تازه ثبت می‌شود', LMC_Push_Guard::claim_nonce($n1), 'new');
// همان Nonce دوباره: خطای کلید یکتا، نه یک «خواندنِ قبلی».
ok('همان Nonce → replay', LMC_Push_Guard::claim_nonce($n1), 'replay');

// ⚠️ **کنترل منفی و مهم‌ترین بند این بخش:** اگر جدول نباشد یا دیتابیس
//    خطا بدهد، نتیجه «نمی‌دانم» است — و «نمی‌دانم» اجازه نیست.
$wpdb->force_insert_error = "Table 'wp_lmc_push_nonce' doesn't exist";
ok('خطای دیتابیس → unavailable، نه new',
   LMC_Push_Guard::claim_nonce(bin2hex(random_bytes(8))), 'unavailable');

// و در همان حالت، خودِ درخواست باید **رد** شود (۵۰۳)، نه پذیرفته.
$r = LMC_Push_Receiver::verify_request(req($p));
ok('و درخواست fail-closed می‌شود → ۵۰۳', $r instanceof WP_Error ? $r->status() : 0, 503);
$wpdb->force_insert_error = null;

// کنترل مثبت: با دیتابیس سالم، همان درخواست پذیرفته می‌شود. بی این،
// یک «همیشه ۵۰۳ بده» هم از بند بالا رد می‌شد و کل Push را می‌بست.
ok('با دیتابیس سالم، درخواست درست پذیرفته می‌شود',
   LMC_Push_Receiver::verify_request(req($p)), true);

// ═══════════════════════════════════════════════════════════════════
echo "\n═══ ۶. نسخه زیر قفل خوانده می‌شود (FND-R60-01) ═══\n";
// ═══════════════════════════════════════════════════════════════════
//
// ⚠️ نسخهٔ قبلی نسخه را در `resolve()` می‌خواند — **بیرون** از هر قفلی —
//    و `update_post_meta()` تازه پس از `save()` اجرا می‌شد. دو Worker
//    هم‌زمان (که `loop.ts` صریح پیش‌بینی‌اش کرده) هر دو `stored` قدیمی
//    را می‌دیدند و ترتیب اعمال به بخت واگذار می‌شد.

$GLOBALS['lmc_products'][77] = new Fake_Product();
$GLOBALS['lmc_link']['v-77'] = 77;
$lock77 = LMC_Push_Guard::lock_name(77, LMC_Push_Receiver::STOCK_VERSION_META);

// ── ۶.۱ قفل پیش از خواندن نسخه گرفته می‌شود ────────────────────────
//
// ⚠️ **این ادعا همان اصلاح است، نه یک جزئیات.** نسخهٔ ذخیره‌شده را در
//    لحظهٔ *گرفتن قفل* بالا می‌بریم. اگر کد نسخه را بیرون از قفل بخواند،
//    مقدار قدیمی (۰) را دیده و پیام را **اعمال** می‌کند. اگر زیر قفل
//    بخواند، مقدار تازه (۵۰) را می‌بیند و ردش می‌کند.
$wpdb->on_acquire = static function (string $name) use ($lock77) {
    if ($name === $lock77) {
        update_post_meta(77, LMC_Push_Receiver::PRICE_VERSION_META, 0); // بی‌اثر
        update_post_meta(77, LMC_Push_Receiver::STOCK_VERSION_META, 50);
    }
};
$out = LMC_Push_Receiver::handle_stock(req(['variationId' => 'v-77', 'onHand' => 9999, 'version' => 30]));
$wpdb->on_acquire = null;
ok('نسخه‌ای که هنگام قفل جلو رفته دیده می‌شود → اعمال نمی‌شود',
   is_array($out) ? $out['applied'] : 'خطا', false);
ok('  و موجودی دست‌نخورده ماند', $GLOBALS['lmc_products'][77]->qty, null);
ok('  و نسخهٔ ذخیره‌شده عقب نرفت',
   (int) get_post_meta(77, LMC_Push_Receiver::STOCK_VERSION_META, true), 50);

// ── ۶.۲ قفل گرفته‌نشده → ۵۰۳، و هیچ نوشتنی ─────────────────────────
$wpdb->deny_locks = [$lock77];
$busy = LMC_Push_Receiver::handle_stock(req(['variationId' => 'v-77', 'onHand' => 1, 'version' => 999]));
$wpdb->deny_locks = [];
ok('قفل در دست Worker دیگر → ۵۰۳ (موقت، نه دائمی)',
   $busy instanceof WP_Error ? $busy->status() : 0, 503);
ok('  و نسخه جلو نرفت',
   (int) get_post_meta(77, LMC_Push_Receiver::STOCK_VERSION_META, true), 50);

// ── ۶.۳ نسخهٔ تازه واقعاً اعمال می‌شود (کنترل مثبت) ────────────────
// بی این بند، یک «همیشه رد کن» هم از دو بند بالا رد می‌شد.
$out = LMC_Push_Receiver::handle_stock(req(['variationId' => 'v-77', 'onHand' => 12, 'version' => 51]));
ok('نسخهٔ جلوتر اعمال می‌شود', is_array($out) ? $out['applied'] : 'خطا', true);
ok('  و موجودی نوشته شد', $GLOBALS['lmc_products'][77]->qty, 12);
ok('  و نسخه ثبت شد',
   (int) get_post_meta(77, LMC_Push_Receiver::STOCK_VERSION_META, true), 51);

// ── ۶.۴ قفل در هر مسیری آزاد می‌شود ───────────────────────────────
ok('قفل پس از پایان کار آزاد است', isset($wpdb->locks[$lock77]), false);

// ⚠️ و حتی وقتی `save()` استثنا بدهد: بی `finally`، قفل تا پایان
//    درخواست PHP روی اتصال می‌ماند و کالا قابل نوشتن نیست.
class Exploding_Product extends Fake_Product
{
    public function save(): void { throw new RuntimeException('ذخیره نشد'); }
}
$GLOBALS['lmc_products'][78] = new Exploding_Product();
$GLOBALS['lmc_link']['v-78'] = 78;
$lock78 = LMC_Push_Guard::lock_name(78, LMC_Push_Receiver::STOCK_VERSION_META);
$threw = false;
try {
    LMC_Push_Receiver::handle_stock(req(['variationId' => 'v-78', 'onHand' => 3, 'version' => 5]));
} catch (RuntimeException $e) {
    $threw = true;
}
ok('استثنای save بالا می‌رود (پیام دوباره تلاش می‌شود)', $threw, true);
ok('  و قفل باز هم آزاد شد', isset($wpdb->locks[$lock78]), false);
// ⚠️ و نسخه **جلو نرفت**: جابه‌جا کردن `update_post_meta()` به قبل از
//    `save()` دقیقاً همین را می‌شکست.
ok('  و نسخه جلو نرفت',
   (int) get_post_meta(78, LMC_Push_Receiver::STOCK_VERSION_META, true), 0);

// ── ۶.۵ دو مسیر، دو قفل ───────────────────────────────────────────
// موجودی و قیمت همان کالا نباید هم‌دیگر را مسدود کنند.
ok('قفل موجودی و قفل قیمت یکی نیستند',
   LMC_Push_Guard::lock_name(77, LMC_Push_Receiver::STOCK_VERSION_META)
     === LMC_Push_Guard::lock_name(77, LMC_Push_Receiver::PRICE_VERSION_META), false);
// و نام قفل از محدودیت ۶۴ بایتی MySQL بیرون نمی‌زند.
ok('نام قفل ≤ ۶۴ بایت', strlen(LMC_Push_Guard::lock_name(999999999, '_lmc_stock_version')) <= 64, true);

$GLOBALS['lmc_test_settings']['sync_price'] = 'no';
$before_version = get_post_meta(77, LMC_Push_Receiver::PRICE_VERSION_META, true);
$disabled = LMC_Push_Receiver::handle_price(req(['variationId' => 'v-77', 'priceRial' => '240000', 'version' => 999]));
ok('گزینه خاموش مانع Push قیمت است', $disabled['applied'], false);
ok('Push خاموش نسخه را جلو نمی‌برد', get_post_meta(77, LMC_Push_Receiver::PRICE_VERSION_META, true), $before_version);
$GLOBALS['lmc_test_settings']['sync_stock'] = 'no';
$disabled = LMC_Push_Receiver::handle_stock(req(['variationId' => 'v-77', 'onHand' => 999, 'version' => 999]));
ok('گزینه خاموش مانع Push موجودی است', $disabled['applied'], false);


// دریافت هدفمند تاریخچه: مرز HTTP ساختگی است؛ گیرنده و امضا کد واقعی‌اند.
class WP_REST_Response {
    public function __construct(public array $data, public int $status = 200) {}
}
class LMC_Client {
    public static $response;
    public static array $calls = [];
    public static function get($path, $query) { self::$calls[] = [$path, $query]; return self::$response; }
}
class LMC_Instore {
    public static array $calls = [];
    public static string $result = 'created';
    public static function import_one($item) { self::$calls[] = $item; return self::$result; }
}
function is_wp_error($v) { return $v instanceof WP_Error; }
$notice = ['invoiceId' => '00000000-0000-7000-8000-000000000321', 'branchId' => '00000000-0000-7000-8000-000000000001'];
$GLOBALS['lmc_test_settings']['sync_instore'] = 'yes';
$GLOBALS['lmc_test_settings']['branch_id'] = $notice['branchId'];
$purchase = ['invoiceId' => $notice['invoiceId'], 'channel' => 'pos', 'customer' => ['mobile' => '09121119988'], 'lines' => []];
$valid_response = ['branchId' => $notice['branchId'], 'items' => [$purchase]];
LMC_Client::$response = $valid_response;
$signed = req($notice);
ok('اعلان تاریخچه امضای معتبر دارد', LMC_Push_Receiver::verify_request($signed), true);
$out = LMC_Push_Receiver::handle_instore($signed);
ok('تاریخچه به importer مشترک تحویل شد', LMC_Instore::$calls, [$purchase]);
ok('فقط فاکتور و شعبه همان اعلان خوانده می‌شود', LMC_Client::$calls, [['/web/instore-purchases', ['branchId' => $notice['branchId'], 'invoiceId' => $notice['invoiceId'], 'limit' => 1]]]);
ok('پاسخ موفق، اطلاعات مشتری ندارد', $out->data, ['ok' => true, 'result' => 'created']);
$replay = LMC_Push_Receiver::verify_request($signed);
ok('بازپخش امضای تاریخچه رد می‌شود', $replay instanceof WP_Error ? $replay->status() : 0, 409);
$malicious = req($notice + ['customer' => ['mobile' => '09120000000']]);
$out = LMC_Push_Receiver::handle_instore($malicious);
ok('تزریق اطلاعات مشتری در اعلان رد می‌شود', $out instanceof WP_Error ? $out->status() : 0, 400);
ok('اعلان نامعتبر import نمی‌کند', count(LMC_Instore::$calls), 1);
$GLOBALS['lmc_test_settings']['sync_instore'] = 'no';
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('خاموشی تاریخچه رعایت می‌شود', $out->data['skipped'], 'disabled');
ok('خاموشی درخواست Core نمی‌سازد', count(LMC_Client::$calls), 1);
$GLOBALS['lmc_test_settings']['sync_instore'] = 'yes';
$GLOBALS['lmc_test_settings']['branch_id'] = '';
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('شعبه تنظیم نشده قابل retry است', $out instanceof WP_Error ? $out->status() : 0, 503);
$GLOBALS['lmc_test_settings']['branch_id'] = '00000000-0000-7000-8000-000000000002';
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('اعلان شعبه دیگر پذیرفته و مصرف نمی‌شود', $out->data['skipped'], 'other_branch');
ok('شعبه دیگر داده درخواست نمی‌کند', count(LMC_Client::$calls), 1);
$GLOBALS['lmc_test_settings']['branch_id'] = $notice['branchId'];
LMC_Client::$response = new WP_Error('unavailable', 'private upstream error');
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('قطعی Core قابل retry است', $out instanceof WP_Error ? $out->status() : 0, 503);
ok('جزئیات خصوصی خطای Core افشا نمی‌شود', strpos($out->message, 'private') === false, true);
foreach ([null, ['items' => []], ['branchId' => $notice['branchId'], 'items' => [$purchase, $purchase]], ['branchId' => 'other', 'items' => []], ['branchId' => $notice['branchId'], 'items' => [array_merge($purchase, ['invoiceId' => 'other'])]], ['branchId' => $notice['branchId'], 'items' => [array_merge($purchase, ['channel' => 'web'])]]] as $response) {
    LMC_Client::$response = $response;
    $out = LMC_Push_Receiver::handle_instore(req($notice));
    ok('پاسخ ناقص/ناسازگار Core رد می‌شود', $out instanceof WP_Error ? $out->status() : 0, 502);
}
ok('پاسخ‌های معیوب import نکردند', count(LMC_Instore::$calls), 1);
LMC_Client::$response = ['branchId' => $notice['branchId'], 'items' => []];
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('فاکتور خارج از دامنه بدون import رد می‌شود', $out->data['skipped'], 'not_eligible');
LMC_Client::$response = $valid_response;
LMC_Instore::$result = 'retry';
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('قفل یا خطای ذخیره، موفق گزارش نمی‌شود', $out instanceof WP_Error ? $out->status() : 0, 503);
LMC_Instore::$result = 'skipped';
$out = LMC_Push_Receiver::handle_instore(req($notice));
ok('فاکتور قبلاً ذخیره‌شده دوباره وارد نمی‌شود', $out->data, ['ok' => true, 'result' => 'skipped']);

echo "\n";
if ($failed > 0) {
    echo "✗ {$failed} ادعا شکست خورد ({$passed} پاس)\n";
    exit(1);
}
echo "✓ همه {$passed} ادعای گیرندهٔ Push پاس شدند\n";
