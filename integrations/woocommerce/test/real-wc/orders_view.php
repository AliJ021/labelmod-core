<?php
/**
 * «سفارش‌های سایت» (قرارداد ۲) روی ووکامرس واقعی، یک بار با HPOS و یک بار با جدول قدیمی پست.
 *   php orders_view.php <wp-root> hpos|legacy
 * فقط محلی و مصنوعی (همان نصب setup.sh). سفارش‌ها با CRUD خود ووکامرس ساخته می‌شوند.
 *
 * ادعاها:
 * - **محل ذخیره:** سنجیده می‌شود، نه فرض. SQL مستقیم فقط اینجا و فقط برای همین سنجش است؛ افزونه SQL نمی‌زند.
 * - **دو مسیر خواندن:** فهرست، فیلتر، جست‌وجو و جزئیات از `LMC_Orders_View` و از مسیر REST امضاشدهٔ واقعی
 *   برمی‌گردند. ترتیب آرایه‌ای، بازهٔ تاریخ با مهر زمانی، `s` (HPOS) و `wc_order_search` (legacy) روی
 *   خود ووکامرس سنجیده می‌شوند.
 * - **ارز:** ارز هر سفارش (IRT، IRR، USD) و عدد دقیق ذخیره‌شده‌اش حفظ می‌شود.
 * - **صفحه‌بندی:** صفحهٔ ۲۰۱ و بالاتر خوانده می‌شود و لنگر `until` سفارش تازه را بیرون نگه می‌دارد.
 * - **وضعیت سفارشی:** وضعیتی که افزونه‌ای ثبت کرده، با نامک و برچسب خودش دیده و فیلتر می‌شود.
 * - **جزئیات کامل:** ویژگی تنوع، کوپن، کارمزد، ارسال، استرداد، یادداشت‌های صفحه‌بندی‌شده و مدرک پرداخت.
 *   IP و user agent برنمی‌گردند.
 * - **کنترل منفی:** سفارش همگام‌نشدهٔ انبارهٔ دیگر دیده نمی‌شود.
 * - **امنیت:** امضای غلط، Nonce تکراری و `perPage=-1` رد می‌شوند.
 * - **بی‌اثر بر داده:** خواندن هیچ سفارشی را تغییر نمی‌دهد.
 */
[$self, $root, $mode] = array_slice($argv, 0, 3) + [null, null, null];
if (!in_array($mode, ['hpos', 'legacy'], true)) { fwrite(STDERR, "mode: hpos|legacy\n"); exit(2); }
define('LMC_PUSH_SECRET', str_repeat('s', 64));   // مصنوعی، فقط همین نصب محلی
require "$root/wp-load.php";
use Automattic\WooCommerce\Internal\DataStores\Orders\DataSynchronizer;
use Automattic\WooCommerce\Utilities\OrderUtil;

$checks = 0; $log = [];
function check($v, $label) { global $checks, $log; if (!$v) { fwrite(STDERR, "✗ {$label}\n"); exit(1); } $checks++; $log[] = "✓ {$label}"; }

// وضعیت سفارشی، همان‌طور که یک افزونهٔ واقعی ثبتش می‌کند.
register_post_status('wc-awaiting-pickup', ['label' => 'آمادهٔ تحویل حضوری', 'public' => false, 'internal' => false]);
add_filter('wc_order_statuses', fn ($s) => $s + ['wc-awaiting-pickup' => 'آمادهٔ تحویل حضوری']);

// ── انبارهٔ فعال: گزینهٔ خود ووکامرس، بی همگام‌سازی، تا محل واقعی هر سفارش یکتا باشد ──
// ووکامرس جابه‌جایی انبارهٔ فعال را با سفارش همگام‌نشده نمی‌پذیرد (درست است). اینجا عمداً همگام‌نشده
// می‌ماند تا کنترل منفی معنا داشته باشد، پس گزینه مستقیم در جدول گزینه‌ها نوشته می‌شود — فقط در همین
// آزمون مصنوعی. نگهبان روی فیلتر عمومی pre_update_option است و برداشتنش همهٔ گزینه‌ها را دور می‌زد.
global $wpdb;
wc_get_container()->get(DataSynchronizer::class)->create_database_tables();
update_option('woocommerce_custom_orders_table_data_sync_enabled', 'no');
$flag = $mode === 'hpos' ? 'yes' : 'no';
if (!$wpdb->update($wpdb->options, ['option_value' => $flag], ['option_name' => 'woocommerce_custom_orders_table_enabled'])
    && get_option('woocommerce_custom_orders_table_enabled', null) === null) {
    add_option('woocommerce_custom_orders_table_enabled', $flag);
}
wp_cache_flush();
check(OrderUtil::custom_orders_table_usage_is_enabled() === ($mode === 'hpos'), "{$mode}: انبارهٔ فعال همان است که خواسته شد");
update_option('labelmod_connector_settings', array_merge((array) get_option('labelmod_connector_settings', []), ['currency_unit' => 'toman']));
// سفارش‌های آزمون زمان ساخت آینده‌نزدیک دارند (ترتیب صریح)، پس لنگر پیش‌فرض این آزمون یک ساعت جلوتر است.
$view = fn (array $q) => LMC_Orders_View::page($q + ['page' => 1, 'perPage' => 50, 'status' => null, 'search' => null,
    'dateFrom' => null, 'dateTo' => null, 'paymentMethod' => null, 'until' => time() + 3600], LMC_Orders_View::statuses());

// ── بیش از ۲۰۰ صفحه با perPage=1: سفارش‌های پرکنندهٔ کوچک، فقط تا وقتی کم است ──
$filler = function () use ($view) {
    $have = $view(['perPage' => 1])['total'];
    for ($i = $have; $i < 205; $i++) { $o = wc_create_order(['status' => 'completed']); $o->set_total('1'); $o->save(); }
};
$filler();

$tag = 'lmc-' . $mode . '-' . bin2hex(random_bytes(3));
$attr = new WC_Product_Attribute(); $attr->set_name('رنگ'); $attr->set_options(['سفید', 'مشکی']); $attr->set_variation(true); $attr->set_visible(true);
$parent = new WC_Product_Variable(); $parent->set_name("پیراهن {$tag}"); $parent->set_attributes([$attr]); $parent->save();
$var = new WC_Product_Variation(); $var->set_parent_id($parent->get_id()); $var->set_attributes(['رنگ' => 'سفید']);
$var->set_sku('OV-' . $tag); $var->set_regular_price('1200000'); $var->save();
update_post_meta($var->get_id(), '_lmc_variation_id', 'aaaaaaaa-0000-7000-8000-' . substr(bin2hex(random_bytes(6)), 0, 12));
$coupon = new WC_Coupon(); $coupon->set_code('ov' . substr($tag, -6)); $coupon->set_amount('100000'); $coupon->set_discount_type('fixed_cart'); $coupon->save();

$ids = [];
foreach ([['processing', 'IRT', 'cod'], ['completed', 'IRR', 'bacs'], ['awaiting-pickup', 'USD', 'bacs']] as $i => [$status, $currency, $gw]) {
    $o = wc_create_order(['status' => $status]);
    $o->set_currency($currency);
    $o->add_product($var, $i + 1);
    $o->set_billing_first_name('مشتری'); $o->set_billing_last_name($tag);
    $o->set_billing_phone('0912000000' . $i); $o->set_billing_email("{$tag}-{$i}@example.invalid");
    $o->set_billing_address_1('نشانی صورت‌حساب مصنوعی'); $o->set_shipping_address_1('نشانی ارسال مصنوعی');
    $o->set_customer_ip_address('203.0.113.77'); $o->set_customer_user_agent('SecretAgent/9');
    $o->set_payment_method($gw); $o->set_payment_method_title($gw === 'cod' ? 'پرداخت در محل' : 'انتقال بانکی');
    $o->set_transaction_id("TX-{$tag}-{$i}");
    $o->set_date_created(time() + 10 * $i);          // ترتیب زمانی صریح
    $fee = new WC_Order_Item_Fee(); $fee->set_name('بسته‌بندی هدیه'); $fee->set_total('20000'); $o->add_item($fee);
    $ship = new WC_Order_Item_Shipping(); $ship->set_method_title('پست پیشتاز'); $ship->set_total('50000'); $o->add_item($ship);
    $o->calculate_totals();
    if ($i === 0) { $o->apply_coupon($coupon->get_code()); }
    $o->set_date_paid(time()); $o->save();
    $ids[] = $o->get_id();
}
$usd = wc_get_order($ids[2]); $usd->set_total('12.50'); $usd->save();
$main = wc_get_order($ids[0]);
for ($n = 1; $n <= 25; $n++) { $main->add_order_note("یادداشت {$n} <b>{$tag}</b>", $n === 1 ? 1 : 0); }
wc_create_refund(['order_id' => $ids[0], 'amount' => '25000', 'reason' => '<i>استرداد مصنوعی</i>', 'restock_items' => false]);
$ids = array_reverse($ids);                            // تازه‌ترین اول

$in = implode(',', array_map('intval', $ids));
$hposRows = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}wc_orders WHERE id IN ($in) AND type = 'shop_order'");
$postRows = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE ID IN ($in) AND post_type = 'shop_order'");
check($mode === 'hpos' ? ($hposRows === 3 && $postRows === 0) : ($hposRows === 0 && $postRows === 3),
    "{$mode}: سفارش‌ها واقعاً در انبارهٔ فعال‌اند (wc_orders={$hposRows}، posts={$postRows})");

wp_cache_flush();
$snap = fn () => array_map(fn ($id) => [wc_get_order($id)->get_date_modified()?->getTimestamp(), wc_get_order($id)->get_meta_data(), wc_get_order($id)->get_status()], $ids);
$before = $snap();

// ── فهرست، ترتیب، ارز ──
$page = $view([]);
$mine = array_values(array_filter($page['orders'], fn ($o) => in_array($o['id'], $ids, true)));
check(array_column($mine, 'id') === $ids, "{$mode}: هر سه، تازه‌ترین اول (orderby آرایه‌ای)");
check(array_map(fn ($o) => [$o['currency'], $o['total']], $mine) === [['USD', '12.50'], ['IRR', $mine[1]['total']], ['IRT', $mine[2]['total']]]
    && preg_match('/^\d+(\.\d+)?$/', $mine[1]['total']), "{$mode}: ارز هر سفارش و عدد دقیق، بی تبدیل");
check($mine[0]['status'] === 'awaiting-pickup' && $mine[0]['statusLabel'] === 'آمادهٔ تحویل حضوری', "{$mode}: وضعیت سفارشی با برچسب خودش");
check(in_array('awaiting-pickup', array_column($page['statuses'], 'slug'), true), "{$mode}: فهرست وضعیت‌ها شامل وضعیت سفارشی");

// ── صفحهٔ ۲۰۱، لنگر ──
$deep = $view(['perPage' => 1, 'page' => 201]);
check($deep['total'] >= 205 && count($deep['orders']) === 1 && $deep['pages'] >= 205, "{$mode}: صفحهٔ ۲۰۱ با perPage=1 خوانده شد (کل {$deep['total']})");
$anchor = $deep['until'];
$late = wc_create_order(['status' => 'completed']); $late->set_date_created($anchor + 3600); $late->save();
$again = $view(['perPage' => 1, 'page' => 201, 'until' => $anchor]);
check($again['orders'][0]['id'] === $deep['orders'][0]['id'] && $again['total'] === $deep['total'], "{$mode}: سفارش پس از لنگر صفحه‌ها را جابه‌جا نکرد");
check(in_array($late->get_id(), array_column($view(['until' => $anchor + 7200])['orders'], 'id'), true), "{$mode}: کنترل: با لنگر تازه دیده می‌شود");

// ── فیلترها و جست‌وجو ──
check(array_column($view(['status' => 'awaiting-pickup'])['orders'], 'id') === [$ids[0]] || in_array($ids[0], array_column($view(['status' => 'awaiting-pickup'])['orders'], 'id'), true)
    && !array_intersect([$ids[1], $ids[2]], array_column($view(['status' => 'awaiting-pickup'])['orders'], 'id')), "{$mode}: فیلتر وضعیت سفارشی");
$cod = array_column($view(['paymentMethod' => 'cod'])['orders'], 'id');
check(in_array($ids[2], $cod, true) && !in_array($ids[0], $cod, true), "{$mode}: فیلتر روش پرداخت");
$today = wp_date('Y-m-d');
$dated = array_column($view(['dateFrom' => $today, 'dateTo' => $today, 'until' => time() + 3600])['orders'], 'id');
check(!array_diff($ids, $dated), "{$mode}: بازهٔ تاریخ امروز (منطقهٔ زمانی سایت)");
check(array_column($view(['dateFrom' => '2001-01-01', 'dateTo' => '2001-01-02'])['orders'], 'id') === [], "{$mode}: بازهٔ تاریخ دور خالی");
foreach (["0912000000" . '1', "{$tag}-2@example.invalid", $tag] as $term) {
    $found = array_column($view(['search' => $term])['orders'], 'id');
    check(in_array($term === $tag ? $ids[0] : ($term === $tag . '-2@example.invalid' ? $ids[0] : $ids[1]), $found, true), "{$mode}: جست‌وجوی «{$term}»");
}
check(array_intersect($ids, array_column($view(['search' => 'هیچ-چیز-' . $tag])['orders'], 'id')) === [], "{$mode}: جست‌وجوی بی نتیجه");
check(in_array($ids[1], array_column($view(['search' => (string) $ids[1]])['orders'], 'id'), true), "{$mode}: جست‌وجوی شناسه");

// ── کنترل منفی: انبارهٔ دیگر ──
$other = $mode === 'hpos' ? 'legacy' : 'hpos';
$foreign = get_option("lmc_ov_last_{$other}", []);
if ($foreign) {
    $seen = array_intersect($foreign, array_column($view(['until' => time() + 3600])['orders'], 'id'));
    check($seen === [], "{$mode}: کنترل منفی — سفارش‌های همگام‌نشدهٔ انبارهٔ {$other} دیده نمی‌شوند");
}
update_option("lmc_ov_last_{$mode}", $ids);

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
$res = signed(['orderId' => $ids[2]]);
check($res->get_status() === 200 && $res->get_data()['protocol'] === 2, "{$mode}: REST امضاشده ۲۰۰، قرارداد ۲");
$d = $res->get_data()['order'];
check($d['id'] === $ids[2] && $d['currency'] === 'IRT' && $d['billing']['phone'] === '09120000000' && $d['shipping']['address1'] === 'نشانی ارسال مصنوعی', "{$mode}: جزئیات با تماس و نشانی");
$row = $d['items']['rows'][0];
check($row['sku'] === 'OV-' . $tag && $row['quantity'] === 1 && $row['mapped'] === true
    && in_array('سفید', array_column($row['attributes'], 'value'), true), "{$mode}: قلم تنوع با ویژگی و نگاشت");
check($d['fees'][0]['name'] === 'بسته‌بندی هدیه' && $d['shippingLines'][0]['method'] === 'پست پیشتاز', "{$mode}: کارمزد و ارسال");
check(count($d['coupons']) === 1 && $d['coupons'][0]['code'] === $coupon->get_code(), "{$mode}: کوپن");
check(count($d['refunds']) === 1 && $d['refunds'][0]['reason'] === 'استرداد مصنوعی' && (float) $d['totals']['refunded'] === 25000.0, "{$mode}: استرداد");
check($d['payment']['transactionId'] === "TX-{$tag}-0" && $d['payment']['paidAt'] !== null && $d['payment']['methodId'] === 'cod', "{$mode}: مدرک پرداخت");
check(count($d['notes']['rows']) === 20 && $d['notes']['hasMore'] && !str_contains($d['notes']['rows'][0]['content'], '<b>'), "{$mode}: یادداشت صفحهٔ اول بی HTML");
$n2 = signed(['orderId' => $ids[2], 'notesPage' => 2])->get_data()['order']['notes'];
check(count($n2['rows']) >= 5 && !$n2['hasMore'], "{$mode}: یادداشت صفحهٔ دوم (۲۵ یادداشت به‌علاوهٔ یادداشت‌های خود ووکامرس)");
$json = wp_json_encode($res->get_data(), JSON_UNESCAPED_UNICODE);
foreach (['203.0.113.77', 'SecretAgent', '_lmc_variation_id', '_billing'] as $leak) { check(strpos($json, $leak) === false, "{$mode}: بی نشت «{$leak}»"); }
$list = signed(['page' => 201, 'perPage' => 1, 'until' => $anchor]);
check($list->get_status() === 200 && count($list->get_data()['orders']) === 1, "{$mode}: صفحهٔ ۲۰۱ از راه REST");
check(signed(['orderId' => $ids[0]], null, str_repeat('x', 64))->get_status() === 403, "{$mode}: امضای غلط ۴۰۳");
$n = bin2hex(random_bytes(16));
check(signed(['page' => 1], $n)->get_status() === 200, "{$mode}: Nonce تازه");
check(signed(['page' => 1], $n)->get_status() !== 200, "{$mode}: Nonce تکراری رد شد");
check(signed(['page' => 1, 'perPage' => -1])->get_status() === 400, "{$mode}: limit=-1 رد شد");
check(signed(['status' => 'not-registered'])->get_status() === 400, "{$mode}: وضعیت ثبت‌نشده رد شد");
check(signed(['orderId' => 999999999])->get_status() === 404, "{$mode}: ناموجود ۴۰۴");

wp_cache_flush();
check($snap() == $before, "{$mode}: خواندن هیچ سفارشی را تغییر نداد");

echo json_encode(['mode' => $mode, 'wc' => WC_VERSION, 'wp' => get_bloginfo('version'), 'checks' => $checks, 'log' => $log], JSON_UNESCAPED_UNICODE), "\n";
