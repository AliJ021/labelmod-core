<?php
/** رمزگذاری واقعی و نگهبان فرم مدیر، بدون وردپرس؛ هیچ راز واقعی در آزمون نیست. */
declare(strict_types=1);
define('ABSPATH', __DIR__);
define('LMC_PUSH_SECRET', 'legacy-test-secret-do-not-use-live');
$no_salts = ($argv[1] ?? '') === 'no-salts';
$no_crypto = ($argv[1] ?? '') === 'no-crypto';
if (!$no_salts) {
    define('AUTH_KEY', 'test-auth-key-only-11111111111111111111111111111111');
    define('AUTH_SALT', 'test-auth-salt-only-222222222222222222222222222222');
}
$options = []; $writes = []; $write_fail = false; $caps = ['manage_options' => true, 'manage_woocommerce' => true];
$nonce_ok = true; $nonces = []; $hooks = []; $claims = [];
function get_option($key, $default = false) { global $options; return array_key_exists($key, $options) ? $options[$key] : $default; }
function update_option($key, $value, $autoload = null) { global $options, $writes, $write_fail; $writes[] = [$key, $value, $autoload]; if ($write_fail) { return false; } $options[$key] = $value; return true; }
function delete_option($key) { global $options, $blog, $deleted; $deleted[] = [$blog ?? 1, $key]; unset($options[$key]); }
function current_user_can($cap) { global $caps; return $caps[$cap] ?? false; }
function wp_die($message, $title = '', $args = []) { throw new RuntimeException('denied:' . ($args['response'] ?? 0)); }
function check_admin_referer($name) { global $nonce_ok, $nonces; $nonces[] = $name; if (!$nonce_ok) { throw new RuntimeException('nonce'); } }
function wp_unslash($value) { return stripslashes($value); }
function admin_url($path) { return 'https://store.example.test/wp-admin/' . $path; }
function add_query_arg($key, $value, $url) { return $url . '&' . $key . '=' . rawurlencode($value); }
class Redirected extends RuntimeException {}
function wp_safe_redirect($url) { throw new Redirected($url); }
function esc_html($value) { return htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); }
function esc_url($value) { return esc_html($value); }
function wp_nonce_field($name) { echo '<input type="hidden" name="_wpnonce" value="test-nonce">'; }
function submit_button($label, $kind = '') { echo '<button>' . esc_html($label) . '</button>'; }
function add_action($hook, $callback) { global $hooks; $hooks[$hook] = $callback; }
class LMC_Settings { const PAGE = 'labelmod-connector'; }
class WP_Error {
    public $code; public $data;
    function __construct($code, $message, $data) { $this->code = $code; $this->data = $data; }
}
class LMC_Push_Guard {
    static function claim_nonce($nonce) { global $claims; if (isset($claims[$nonce])) { return 'replay'; } $claims[$nonce] = true; return 'new'; }
}
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-secret.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-secret-settings.php';
require_once __DIR__ . '/../labelmod-connector/includes/class-lmc-push-receiver.php';
$checks = 0;
function check($ok, $why) { global $checks; if (!$ok) { throw new RuntimeException($why); } $checks++; }
$secret = 'fresh-test-only-' . str_repeat('abc123', 8);
check(LMC_Push_Secret::read() === LMC_PUSH_SECRET, 'نبود گزینه: سازگاری ثابت');
check(LMC_Push_Secret::status() === 'legacy', 'وضعیت قدیمی');
if ($no_salts || $no_crypto) {
    check(!LMC_Push_Secret::available(), 'بی کلید رمزگذاری یا OpenSSL، آماده نیست');
    check(!LMC_Push_Secret::save($secret) && count($writes) === 0, 'هرگز ذخیره ساده یا تولید کلید دیتابیسی');
    $options[LMC_Push_Secret::OPTION] = ['version' => 1, 'iv' => base64_encode(str_repeat('x', 12)), 'tag' => base64_encode(str_repeat('x', 16)), 'ciphertext' => base64_encode($secret)];
    check(LMC_Push_Secret::read() === '', 'گزینه ذخیره‌شده بدون امکان رمزگشایی به ثابت قدیمی برنمی‌گردد');
    check(LMC_Push_Secret::save('', true) && LMC_Push_Secret::read() === '', 'غیرفعال‌کردن بی OpenSSL هم ممکن است');
    echo "$checks checks (missing crypto prerequisites) passed\n";
    exit;
}
check(LMC_Push_Secret::available(), 'OpenSSL/GCM آزمون باید موجود باشد');
check(LMC_Push_Secret::save($secret), 'ذخیره رمز‌شده');
$envelope = $options[LMC_Push_Secret::OPTION];
check(strpos(json_encode($envelope), $secret) === false, 'متن راز در گزینه نیست');
check($writes[0][2] === false, 'autoload خاموش');
check(LMC_Push_Secret::read() === $secret && LMC_Push_Secret::status() === 'saved', 'رمزگشایی و اولویت بر ثابت');
check(LMC_Push_Secret::save($secret) && $envelope['iv'] !== $options[LMC_Push_Secret::OPTION]['iv'], 'nonce رمزگذاری برای هر نوشتن تازه است');
$envelope = $options[LMC_Push_Secret::OPTION];
$count = count($writes);
check(LMC_Push_Secret::save('') && $options[LMC_Push_Secret::OPTION] === $envelope && count($writes) === $count, 'خالی نه پاک می‌کند نه بازنویسی');
foreach (['short', str_repeat('x', 513), str_repeat('x', 32) . "\n", str_repeat('x', 32) . ' ', str_repeat('x', 32) . "\0"] as $bad) {
    check(!LMC_Push_Secret::save($bad) && $options[LMC_Push_Secret::OPTION] === $envelope, 'ورودی نامعتبر کلید را عوض نکرد');
}
foreach ([false, [], ['version' => 2], ['version' => 1, 'iv' => []], array_merge($envelope, ['tag' => base64_encode(str_repeat('x', 16))]), array_merge($envelope, ['ciphertext' => '!invalid!'])] as $bad) {
    $options[LMC_Push_Secret::OPTION] = $bad;
    check(LMC_Push_Secret::read() === '' && LMC_Push_Secret::status() === 'unreadable', 'خرابی هرگز ثابت قدیمی را فعال نمی‌کند');
}
// ciphertext با کلید قبلی: نمونهٔ واقعی تغییر AUTH_KEY/AUTH_SALT، نه mock رمزگشایی.
$iv = random_bytes(12); $tag = '';
$cipher = openssl_encrypt($secret, 'aes-256-gcm', random_bytes(32), OPENSSL_RAW_DATA, $iv, $tag, LMC_Push_Secret::CONTEXT, 16);
$options[LMC_Push_Secret::OPTION] = ['version' => 1, 'iv' => base64_encode($iv), 'tag' => base64_encode($tag), 'ciphertext' => base64_encode($cipher)];
check(LMC_Push_Secret::read() === '', 'کلید وردپرس عوض‌شده: رد امن');
$options[LMC_Push_Secret::OPTION] = $envelope;
$write_fail = true;
check(!LMC_Push_Secret::save($secret . 'new') && LMC_Push_Secret::read() === $secret, 'شکست نوشتن: نه موفقیت کاذب نه حذف قدیمی');
$write_fail = false;

function signed_request($secret) {
    $ts = (string) time(); $nonce = bin2hex(random_bytes(16)); $body = '{"probe":true}';
    return new class($ts, $nonce, $body, $secret) {
        private $headers; private $body;
        function __construct($ts, $nonce, $body, $secret) { $this->body = $body; $this->headers = ['x-lmc-timestamp' => $ts, 'x-lmc-nonce' => $nonce, 'x-lmc-signature' => 'sha256=' . hash_hmac('sha256', "$ts.$nonce.$body", $secret)]; }
        function get_header($name) { return $this->headers[$name] ?? ''; }
        function get_body() { return $this->body; }
    };
}
$request = signed_request($secret);
check(LMC_Push_Receiver::verify_request($request) === true, 'گیرنده تولیدی با کلید ذخیره‌شده امضا را می‌پذیرد');
check(LMC_Push_Receiver::verify_request($request)->code === 'lmc_replay', 'مسیر nonce همچنان اجباری');
check(LMC_Push_Receiver::verify_request(signed_request(LMC_PUSH_SECRET))->code === 'lmc_bad_signature', 'ثابت قبلی پس از override رد می‌شود');
check(LMC_Push_Secret::save('', true) && LMC_Push_Secret::status() === 'disabled', 'پاک‌کردن صریح');
check(LMC_Push_Receiver::verify_request(signed_request(LMC_PUSH_SECRET))->code === 'lmc_no_secret', 'clear ثابت قدیمی را فعال نکرد');
check(LMC_Push_Secret::save('') && LMC_Push_Secret::read() === '', 'خالی پس از clear هم غیرفعال می‌ماند');
check(LMC_Push_Secret::save($secret), 'ثبت تازه پس از clear');

$_SERVER['REQUEST_METHOD'] = 'POST';
$_POST = ['push_secret' => $secret];
foreach (['manage_options', 'manage_woocommerce'] as $cap) {
    $caps[$cap] = false; $before = count($writes);
    try { LMC_Push_Secret_Settings::save(); check(false, 'نبود مجوز پذیرفته شد'); } catch (RuntimeException $e) { check($e->getMessage() === 'denied:403', 'مجوز رد شد'); }
    check(count($writes) === $before, 'بی مجوز هیچ نوشتنی نیست');
    ob_start(); LMC_Push_Secret_Settings::render(); check(ob_get_clean() === '', 'فرم بی مجوز نمایش ندارد');
    $caps[$cap] = true;
}
$nonce_ok = false; $before = count($writes);
try { LMC_Push_Secret_Settings::save(); check(false, 'nonce نامعتبر پذیرفته شد'); } catch (RuntimeException $e) { check($e->getMessage() === 'nonce', 'nonce رد شد'); }
check(count($writes) === $before, 'بی nonce نوشتنی نیست'); $nonce_ok = true;
$_SERVER['REQUEST_METHOD'] = 'GET';
try { LMC_Push_Secret_Settings::save(); check(false, 'GET پذیرفته شد'); } catch (RuntimeException $e) { check($e->getMessage() === 'denied:405', 'فقط POST'); }
$_SERVER['REQUEST_METHOD'] = 'POST';
foreach ([['push_secret' => [$secret]], ['push_secret' => 'short'], ['push_secret' => $secret], ['push_secret' => ''], ['push_secret' => '', 'clear_push_secret' => '1']] as $form) {
    $_POST = $form;
    try { LMC_Push_Secret_Settings::save(); check(false, 'هدایت لازم است'); } catch (Redirected $e) {
        $expected = is_string($form['push_secret']) && $form['push_secret'] !== 'short' ? 'saved' : 'failed';
        check(strpos($e->getMessage(), 'lmc_push_msg=' . $expected) !== false, 'وضعیت هدایت درست است');
        check(strpos($e->getMessage(), $secret) === false, 'هدایت راز ندارد');
    }
}
check(in_array('lmc_save_push_secret', $nonces, true), 'nonce مستقل فرم');
LMC_Push_Secret::save($secret);
foreach ([$secret . "\0", ' ' . $secret, $secret . "\n"] as $invalid) {
    $before = $options[LMC_Push_Secret::OPTION]; $write_count = count($writes);
    $_POST = ['push_secret' => addslashes($invalid)];
    try { LMC_Push_Secret_Settings::save(); check(false, 'هدایت لازم است'); } catch (Redirected $e) {
        check(strpos($e->getMessage(), 'lmc_push_msg=failed') !== false, 'handler ورودی را با trim معتبر نمی‌کند');
    }
    check(count($writes) === $write_count && $options[LMC_Push_Secret::OPTION] === $before, 'کنترل/فاصله کلید قبلی را تغییر نمی‌دهد');
}
// شبیه‌سازی wp_magic_quotes برای حفظ دقیق نویسه‌های مجاز دارای backslash/quote.
$quoted_secret = $secret . "\\'\"";
$_POST = ['push_secret' => addslashes($quoted_secret)];
try { LMC_Push_Secret_Settings::save(); } catch (Redirected $e) {}
check(LMC_Push_Secret::read() === $quoted_secret, 'unslash فقط escaping وردپرس را برمی‌گرداند');
LMC_Push_Secret::save($secret);
$_GET = ['lmc_push_msg' => $secret];
ob_start(); LMC_Push_Secret_Settings::render(); $html = ob_get_clean();
check(strpos($html, $secret) === false && strpos($html, $options[LMC_Push_Secret::OPTION]['ciphertext']) === false, 'HTML نه راز دارد نه ciphertext نه پیام دلخواه');
check(strpos($html, 'name="push_secret"') !== false && strpos($html, 'autocomplete="new-password" value=""') !== false, 'فیلد همیشه خالی');
LMC_Push_Secret_Settings::init();
check(isset($hooks['admin_post_lmc_save_push_secret']) && !isset($hooks['admin_post_nopriv_lmc_save_push_secret']), 'فقط مسیر مدیر احرازشده');

define('WP_UNINSTALL_PLUGIN', 'test');
$multisite = false; $blog = 1; $deleted = []; $site_queries = [];
function is_multisite() { global $multisite; return $multisite; }
function get_sites($args) { global $site_queries; $site_queries[] = $args; return array_slice(range(1, 101), $args['offset'], $args['number']); }
function switch_to_blog($id) { global $blog; $blog = $id; }
function restore_current_blog() { global $blog; $blog = 1; }
$options['retained-financial-history'] = 'keep';
require __DIR__ . '/../labelmod-connector/uninstall.php';
check(!array_key_exists(LMC_Push_Secret::OPTION, $options) && $options['retained-financial-history'] === 'keep', 'حذف فقط راز جدید؛ تاریخچه حفظ شد');
$multisite = true; $deleted = [];
require __DIR__ . '/../labelmod-connector/uninstall.php';
check(count($deleted) === 101 && $deleted[100] === [101, LMC_Push_Secret::OPTION], 'حذف راز در همه سایت‌ها با صفحه‌بندی');
check(count($site_queries) === 2 && $blog === 1 && $options['retained-financial-history'] === 'keep', 'شبکه: بازگشت سایت و حفظ دیگر تنظیمات');
echo "$checks checks passed\n";
