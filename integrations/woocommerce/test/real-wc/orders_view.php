<?php
/**
 * «سفارش‌های سایت» روی ووکامرس واقعی، یک بار با HPOS و یک بار با جدول قدیمی پست.
 *   php orders_view.php <wp-root> hpos|legacy
 * فقط محلی و مصنوعی (همان نصب setup.sh). سفارش‌ها با CRUD خود ووکامرس ساخته می‌شوند.
 *
 * ادعاها:
 * - محل ذخیرهٔ واقعی سفارش سنجیده می‌شود، نه فرض. SQL مستقیم فقط اینجا و فقط برای همین سنجش است؛
 *   افزونه SQL نمی‌زند.
 * - همان فهرست و جزئیات از `LMC_Orders_View` و از مسیر REST امضاشدهٔ واقعی برمی‌گردد.
 * - کنترل منفی: سفارشی که در انبارهٔ دیگر ساخته شده و همگام نشده، در فهرست نیست. پس خواندن واقعاً از
 *   انبارهٔ فعال است، نه از هر دو.
 * - امضای غلط و Nonce تکراری رد می‌شوند.
 * - هیچ سفارشی با خواندن تغییر نمی‌کند (date_modified و متا).
 */
[$self, $root, $mode] = array_slice($argv, 0, 3) + [null, null, null];
if (!in_array($mode, ['hpos', 'legacy'], true)) { fwrite(STDERR, "mode: hpos|legacy\n"); exit(2); }
define('LMC_PUSH_SECRET', str_repeat('s', 64));   // مصنوعی، فقط همین نصب محلی
require "$root/wp-load.php";
use Automattic\WooCommerce\Internal\DataStores\Orders\DataSynchronizer;
use Automattic\WooCommerce\Utilities\OrderUtil;

$checks = 0; $log = [];
function check($v, $label) { global $checks, $log; if (!$v) { fwrite(STDERR, "✗ {$label}\n"); exit(1); } $checks++; $log[] = "✓ {$label}"; }

// ── انبارهٔ فعال: گزینهٔ خود ووکامرس، بی همگام‌سازی، تا محل واقعی هر سفارش یکتا باشد ──
wc_get_container()->get(DataSynchronizer::class)->create_database_tables();
update_option('woocommerce_custom_orders_table_data_sync_enabled', 'no');
// ووکامرس جابه‌جایی انبارهٔ فعال را با سفارش همگام‌نشده نمی‌پذیرد (درست است). اینجا عمداً همگام‌نشده
// می‌ماند تا کنترل منفی معنا داشته باشد، پس گزینه مستقیم در جدول گزینه‌ها نوشته می‌شود — فقط در همین
// آزمون مصنوعی. نگهبان روی فیلتر عمومی pre_update_option است و برداشتنش همهٔ گزینه‌ها را دور می‌زد.
global $wpdb;
$flag = $mode === 'hpos' ? 'yes' : 'no';
if (!$wpdb->update($wpdb->options, ['option_value' => $flag], ['option_name' => 'woocommerce_custom_orders_table_enabled'])
    && get_option('woocommerce_custom_orders_table_enabled', null) === null) {
    add_option('woocommerce_custom_orders_table_enabled', $flag);
}
wp_cache_flush();
check(OrderUtil::custom_orders_table_usage_is_enabled() === ($mode === 'hpos'), "{$mode}: انبارهٔ فعال همان است که خواسته شد");
update_option('labelmod_connector_settings', array_merge((array) get_option('labelmod_connector_settings', []), ['currency_unit' => 'toman']));

$tag = 'lmc-' . $mode . '-' . bin2hex(random_bytes(3));
$p = new WC_Product_Simple();
$p->set_name("پیراهن {$tag}"); $p->set_sku('OV-' . $tag); $p->set_regular_price('1200000'); $p->save();
$ids = [];
foreach (['processing', 'completed', 'on-hold'] as $i => $status) {
    $o = wc_create_order(['status' => $status]);
    $o->add_product($p, $i + 1);
    $o->set_billing_first_name('مشتری'); $o->set_billing_last_name($tag);
    $o->set_billing_phone('0912000000' . $i); $o->set_billing_email("{$tag}@example.invalid");
    $o->set_billing_address_1('نشانی مصنوعی محرمانه');
    $o->set_date_created(time() + 10 * $i);          // ترتیب زمانی صریح
    $o->calculate_totals(); $o->save();
    $ids[] = $o->get_id();
}
$ids = array_reverse($ids);                            // تازه‌ترین اول

global $wpdb;
$in = implode(',', array_map('intval', $ids));
$hposRows = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}wc_orders WHERE id IN ($in) AND type = 'shop_order'");
$postRows = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE ID IN ($in) AND post_type = 'shop_order'");
check($mode === 'hpos' ? ($hposRows === 3 && $postRows === 0) : ($hposRows === 0 && $postRows === 3),
    "{$mode}: سفارش‌ها واقعاً در انبارهٔ فعال‌اند (wc_orders={$hposRows}، posts={$postRows})");

$before = array_map(fn ($id) => [wc_get_order($id)->get_date_modified()->getTimestamp(), wc_get_order($id)->get_meta_data()], $ids);

// ── فراخوان مستقیم کلاس ──
$page = LMC_Orders_View::page(1, 50, null);
$mine = array_values(array_filter($page['orders'], fn ($o) => in_array($o['id'], $ids, true)));
check(array_column($mine, 'id') === $ids, "{$mode}: هر سه، تازه‌ترین اول");
check($page['total'] >= 3 && $page['pages'] >= 1, "{$mode}: شمار کل از صفحه‌بندی ووکامرس");
check(array_column($mine, 'status') === ['on-hold', 'completed', 'processing'], "{$mode}: وضعیت‌ها");
check(array_column($mine, 'totalRial') === ['36000000', '24000000', '12000000'], "{$mode}: مبلغ به ریال رشته‌ای (تومان×۱۰)");
check(array_column($mine, 'itemCount') === [3, 2, 1], "{$mode}: شمار کالا");
check($mine[0]['customerName'] === "مشتری {$tag}", "{$mode}: نام صورت‌حساب");

$other = $mode === 'hpos' ? 'legacy' : 'hpos';
$foreign = get_option("lmc_ov_last_{$other}", []);
if ($foreign) {
    $seen = array_intersect($foreign, array_column(LMC_Orders_View::page(1, 50, null)['orders'], 'id'));
    check($seen === [], "{$mode}: کنترل منفی — سفارش‌های همگام‌نشدهٔ انبارهٔ {$other} دیده نمی‌شوند");
}
update_option("lmc_ov_last_{$mode}", $ids);

$filtered = LMC_Orders_View::page(1, 50, 'on-hold');
check(in_array($ids[0], array_column($filtered['orders'], 'id'), true)
    && !array_intersect([$ids[1], $ids[2]], array_column($filtered['orders'], 'id')), "{$mode}: فیلتر وضعیت در خود ووکامرس");

// ── مسیر REST واقعی با امضا ──
function signed(array $body, ?string $nonce = null, string $secret = LMC_PUSH_SECRET) {
    $raw = wp_json_encode($body); $ts = (string) time(); $nonce ??= bin2hex(random_bytes(16));
    $req = new WP_REST_Request('POST', '/lmc/v1/orders');
    $req->set_header('content-type', 'application/json'); $req->set_body($raw);
    $req->set_header('x-lmc-timestamp', $ts); $req->set_header('x-lmc-nonce', $nonce);
    $req->set_header('x-lmc-signature', 'sha256=' . hash_hmac('sha256', "{$ts}.{$nonce}.{$raw}", $secret));
    return rest_do_request($req);
}
do_action('rest_api_init');
$res = signed(['orderId' => $ids[1]]);
check($res->get_status() === 200, "{$mode}: REST امضاشده ۲۰۰");
$d = $res->get_data();
check($d['siteUrl'] === untrailingslashit(home_url()) && $d['order']['id'] === $ids[1], "{$mode}: جزئیات با هویت سایت");
check($d['order']['items'][0]['quantity'] === 2 && $d['order']['items'][0]['sku'] === 'OV-' . $tag
    && $d['order']['items'][0]['totalRial'] === '24000000', "{$mode}: قلم سفارش");
$json = wp_json_encode($d);
foreach (['09120000001', "{$tag}@example.invalid", 'نشانی مصنوعی محرمانه'] as $leak) {
    check(strpos($json, $leak) === false && strpos(json_encode($d, JSON_UNESCAPED_UNICODE), $leak) === false, "{$mode}: بی نشت «{$leak}»");
}
$list = signed(['page' => 1, 'perPage' => 2]);
check($list->get_status() === 200 && count($list->get_data()['orders']) === 2 && $list->get_data()['perPage'] === 2, "{$mode}: فهرست REST با سقف صفحه");
check(signed(['orderId' => $ids[0]], null, str_repeat('x', 64))->get_status() === 403, "{$mode}: امضای غلط ۴۰۳");
$n = bin2hex(random_bytes(16));
check(signed(['page' => 1], $n)->get_status() === 200, "{$mode}: Nonce تازه");
check(signed(['page' => 1], $n)->get_status() !== 200, "{$mode}: Nonce تکراری رد شد");
check(signed(['page' => 1, 'perPage' => -1])->get_status() === 400, "{$mode}: limit=-1 رد شد");
check(signed(['orderId' => 999999999])->get_status() === 404, "{$mode}: ناموجود ۴۰۴");

wp_cache_flush();
$after = array_map(fn ($id) => [wc_get_order($id)->get_date_modified()->getTimestamp(), wc_get_order($id)->get_meta_data()], $ids);
check($after == $before, "{$mode}: خواندن هیچ سفارشی را تغییر نداد");

echo json_encode(['mode' => $mode, 'wc' => WC_VERSION, 'wp' => get_bloginfo('version'), 'checks' => $checks, 'log' => $log], JSON_UNESCAPED_UNICODE), "\n";
