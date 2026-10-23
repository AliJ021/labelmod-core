<?php
/**
 * «سفارش‌های سایت» (قرارداد ۳) روی ووکامرس واقعی، یک بار با HPOS و یک بار با جدول قدیمی پست.
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
 * - **لنگر هم‌ثانیه (بازبینی ریشه روی 2a4e62e):** سفارشی که در همان ثانیهٔ صفحهٔ اول ساخته شود صفحه‌ها را تکرار
 *   نمی‌کند؛ کنترل منفی همان داده با لنگرِ شامل ثانیهٔ جاری تکرار را نشان می‌دهد.
 * - **ویژگی قلم:** متای عمومی `integration_token` بیرون می‌ماند؛ ویژگی طبقه‌بندیِ تنوعِ حذف‌شده می‌ماند.
 * - **روش ارسال:** فیلتر روی جدول اقلام ووکامرس، شامل `method_id` قدیمی `flat_rate:7`؛ پرسش واقعی با EXPLAIN ثبت می‌شود.
 * - **زباله‌دان، تاریخ تکمیل و تغییر، رهگیری** (افزونهٔ رسمی Shipment Tracking).
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
// لنگر پیش‌فرض خود افزونه (ثانیهٔ پیش)؛ سفارش‌های آزمون در گذشتهٔ نزدیک ساخته می‌شوند.
$view = fn (array $q) => LMC_Orders_View::page($q + ['page' => 1, 'perPage' => 50, 'status' => null, 'search' => null,
    'dateFrom' => null, 'dateTo' => null, 'paymentMethod' => null, 'shippingMethod' => null, 'until' => null],
    LMC_Orders_View::filter_statuses(), LMC_Orders_View::shipping_methods());
$fresh = function (): int { $t = time(); while (time() === $t) { usleep(20000); } return time(); };   // آغاز یک ثانیهٔ تازه

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
// ویژگی طبقه‌بندی (pa_) و ویژگی سفارشی روی تنوعی که بعداً حذف می‌شود.
$attr_id = wc_attribute_taxonomy_id_by_name('ovsize') ?: wc_create_attribute(['name' => 'سایز آزمون', 'slug' => 'ovsize']);
if (!taxonomy_exists('pa_ovsize')) { register_taxonomy('pa_ovsize', ['product'], ['hierarchical' => false]); }
$xl = get_term_by('slug', 'ov-xl', 'pa_ovsize') ?: get_term((int) wp_insert_term('XL آزمون', 'pa_ovsize', ['slug' => 'ov-xl'])['term_id'], 'pa_ovsize');
$tax = new WC_Product_Attribute(); $tax->set_id((int) $attr_id); $tax->set_name('pa_ovsize'); $tax->set_options([(int) $xl->term_id]); $tax->set_variation(true);
$pat = new WC_Product_Attribute(); $pat->set_name('طرح'); $pat->set_options(['راه‌راه']); $pat->set_variation(true);
$parent2 = new WC_Product_Variable(); $parent2->set_name("شلوار {$tag}"); $parent2->set_attributes([$tax, $pat]); $parent2->save();
$gone = new WC_Product_Variation(); $gone->set_parent_id($parent2->get_id()); $gone->set_attributes(['pa_ovsize' => 'ov-xl', sanitize_title('طرح') => 'راه‌راه']);
$gone->set_regular_price('900000'); $gone->save();
$coupon = new WC_Coupon(); $coupon->set_code('ov' . substr($tag, -6)); $coupon->set_amount('100000'); $coupon->set_discount_type('fixed_cart'); $coupon->save();

$ids = [];
foreach ([['processing', 'IRT', 'cod'], ['completed', 'IRR', 'bacs'], ['awaiting-pickup', 'USD', 'bacs']] as $i => [$status, $currency, $gw]) {
    $o = wc_create_order(['status' => $status]);
    $o->set_currency($currency);
    $o->add_product($var, $i + 1);
    if ($i === 0) {
        // متای عمومی یک افزونهٔ دیگر روی همان قلم تنوع؛ نباید «ویژگی» شود.
        $line = current($o->get_items()); $line->add_meta_data('integration_token', 'SENTINEL-' . $tag); $line->save();
        $o->add_product($gone, 1);
        $o->update_meta_data('_wc_shipment_tracking_items', [['tracking_provider' => 'iran-post', 'custom_tracking_provider' => '',
            'tracking_number' => "IR-{$tag}", 'date_shipped' => (string) (time() - 60), 'custom_tracking_link' => "https://tracking.example.invalid/{$tag}"]]);
    }
    $o->set_billing_first_name('مشتری'); $o->set_billing_last_name($tag);
    $o->set_billing_phone('0912000000' . $i); $o->set_billing_email("{$tag}-{$i}@example.invalid");
    $o->set_billing_address_1('نشانی صورت‌حساب مصنوعی'); $o->set_shipping_address_1('نشانی ارسال مصنوعی');
    $o->set_customer_ip_address('203.0.113.77'); $o->set_customer_user_agent('SecretAgent/9');
    $o->set_payment_method($gw); $o->set_payment_method_title($gw === 'cod' ? 'پرداخت در محل' : 'انتقال بانکی');
    $o->set_transaction_id("TX-{$tag}-{$i}");
    $o->set_date_created(time() - 600 + 10 * $i);    // ترتیب زمانی صریح، در گذشتهٔ نزدیک
    $fee = new WC_Order_Item_Fee(); $fee->set_name('بسته‌بندی هدیه'); $fee->set_total('20000'); $o->add_item($fee);
    $ship = new WC_Order_Item_Shipping(); $ship->set_method_title('پست پیشتاز'); $ship->set_total('50000');
    $ship->set_method_id(['flat_rate', 'local_pickup', 'flat_rate:7'][$i]); $o->add_item($ship);   // سومی شکل قدیمی method_id
    $o->calculate_totals();
    if ($i === 0) { $o->apply_coupon($coupon->get_code()); }
    $o->set_date_paid(time()); $o->save();
    $ids[] = $o->get_id();
}
$usd = wc_get_order($ids[2]); $usd->set_total('12.50'); $usd->save();
$main = wc_get_order($ids[0]);
for ($n = 1; $n <= 25; $n++) { $main->add_order_note("یادداشت {$n} <b>{$tag}</b>", $n === 1 ? 1 : 0); }
wc_create_refund(['order_id' => $ids[0], 'amount' => '25000', 'reason' => '<i>استرداد مصنوعی</i>', 'restock_items' => false]);
$created = $ids;                                      // ترتیب ساخت: [flat_rate, local_pickup, flat_rate:7]
// مرحلهٔ ۱: فقط تنوع حذف شد. ووکامرس اکنون کالای مادر را برمی‌گرداند؛ ویژگی‌ها از ویژگی‌های تنوع‌ساز مادر می‌آیند.
$gone->delete(true); wp_cache_flush();
$stage = array_values(array_filter(LMC_Orders_View::detail(wc_get_order($created[0]), 1, 1)['items']['rows'], fn ($r) => str_starts_with($r['name'], 'شلوار')))[0];
check($stage['productExists'] === false && $stage['mapped'] === false && $stage['sku'] === ''
    && array_column($stage['attributes'], 'value') === ['XL آزمون', 'راه‌راه'], "{$mode}: تنوع حذف‌شده، مادر موجود: هر دو ویژگی، کالا «حذف‌شده»");
// مرحلهٔ ۲: مادر هم حذف شد؛ فقط ویژگی طبقه‌بندی منبع دارد.
wc_get_product($parent2->get_id())->delete(true); wp_cache_flush();
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
check($anchor <= time() - 1, "{$mode}: لنگر پیش‌فرض ثانیهٔ جاری را ندارد");
$late = wc_create_order(['status' => 'completed']); $late->save();
$again = $view(['perPage' => 1, 'page' => 201, 'until' => $anchor]);
check($again['orders'][0]['id'] === $deep['orders'][0]['id'] && $again['total'] === $deep['total'], "{$mode}: سفارش پس از لنگر صفحه‌ها را جابه‌جا نکرد");
$fresh();
check(in_array($late->get_id(), array_column($view([])['orders'], 'id'), true), "{$mode}: کنترل: با لنگر تازه دیده می‌شود");

// ── لنگر هم‌ثانیه (بازبینی ریشه روی 2a4e62e) ──
// سه سفارش در ثانیهٔ s0؛ در ثانیهٔ تازهٔ s1 صفحهٔ اول، سپس سفارش چهارم هم در s1. همه باید در s1 بمانند، وگرنه تکرار.
for ($try = 0; $try < 4; $try++) {
    $fresh();
    $trio = [];
    for ($k = 0; $k < 3; $k++) { $t = wc_create_order(['status' => 'processing']); $t->save(); $trio[] = $t->get_id(); }
    $s0 = wc_get_order($trio[0])->get_date_created()->getTimestamp();
    $s1 = $fresh();
    $p1 = $view(['perPage' => 2]);
    $old1 = $view(['perPage' => 2, 'until' => $s1]);             // رفتار 2a4e62e: لنگر شامل ثانیهٔ جاری
    $o4 = wc_create_order(['status' => 'processing']); $o4->save();
    $p2 = $view(['perPage' => 2, 'page' => 2, 'until' => $p1['until']]);
    $old2 = $view(['perPage' => 2, 'page' => 2, 'until' => $s1]);
    $same = wc_get_order($trio[2])->get_date_created()->getTimestamp() === $s0 && $o4->get_date_created()->getTimestamp() === $s1 && time() === $s1;
    if ($same) { break; }
}
check($same, "{$mode}: سه سفارش در یک ثانیه و سفارش چهارم در ثانیهٔ صفحهٔ اول ساخته شد");
check($p1['until'] === $s0 && array_column($p1['orders'], 'id') === [$trio[2], $trio[1]], "{$mode}: صفحهٔ اول تا ثانیهٔ پیش");
check(!array_intersect(array_column($p1['orders'], 'id'), array_column($p2['orders'], 'id')) && $p2['orders'][0]['id'] === $trio[0]
    && !in_array($o4->get_id(), array_column($p2['orders'], 'id'), true), "{$mode}: سفارش هم‌ثانیه صفحه‌ها را تکرار نکرد");
check(array_values(array_intersect(array_column($old1['orders'], 'id'), array_column($old2['orders'], 'id'))) === [$trio[1]],
    "{$mode}: کنترل منفی: لنگر شامل ثانیهٔ جاری همان سفارش را در دو صفحه آورد");

// ── فیلترها و جست‌وجو ──
check(array_column($view(['status' => 'awaiting-pickup'])['orders'], 'id') === [$ids[0]] || in_array($ids[0], array_column($view(['status' => 'awaiting-pickup'])['orders'], 'id'), true)
    && !array_intersect([$ids[1], $ids[2]], array_column($view(['status' => 'awaiting-pickup'])['orders'], 'id')), "{$mode}: فیلتر وضعیت سفارشی");
$cod = array_column($view(['paymentMethod' => 'cod'])['orders'], 'id');
check(in_array($ids[2], $cod, true) && !in_array($ids[0], $cod, true), "{$mode}: فیلتر روش پرداخت");
$today = wp_date('Y-m-d');
$dated = array_column($view(['dateFrom' => $today, 'dateTo' => $today])['orders'], 'id');
check(!array_diff($ids, $dated), "{$mode}: بازهٔ تاریخ امروز (منطقهٔ زمانی سایت)");
check(array_column($view(['dateFrom' => '2001-01-01', 'dateTo' => '2001-01-02'])['orders'], 'id') === [], "{$mode}: بازهٔ تاریخ دور خالی");
foreach (["0912000000" . '1', "{$tag}-2@example.invalid", $tag] as $term) {
    $found = array_column($view(['search' => $term])['orders'], 'id');
    check(in_array($term === $tag ? $ids[0] : ($term === $tag . '-2@example.invalid' ? $ids[0] : $ids[1]), $found, true), "{$mode}: جست‌وجوی «{$term}»");
}
check(array_intersect($ids, array_column($view(['search' => 'هیچ-چیز-' . $tag])['orders'], 'id')) === [], "{$mode}: جست‌وجوی بی نتیجه");
check(in_array($ids[1], array_column($view(['search' => (string) $ids[1]])['orders'], 'id'), true), "{$mode}: جست‌وجوی شناسه");

// ── روش ارسال: شرط روی جدول اقلام، در همان پرسش صفحه‌بندی‌شده؛ پرسش اجراشده با EXPLAIN ثبت می‌شود ──
$sql = null;
$spy_hpos = function ($q) use (&$sql) { $sql = $q; return $q; };
$spy_post = function ($q, $wpq) use (&$sql) { if (in_array('shop_order', (array) $wpq->get('post_type'), true)) { $sql = $q; } return $q; };
add_filter('woocommerce_orders_table_query_sql', $spy_hpos); add_filter('posts_request', $spy_post, 10, 2);
$flat = $view(['shippingMethod' => 'flat_rate']);
remove_filter('woocommerce_orders_table_query_sql', $spy_hpos); remove_filter('posts_request', $spy_post, 10);
$pickup = array_column($view(['shippingMethod' => 'local_pickup'])['orders'], 'id');
$flatIds = array_column($flat['orders'], 'id');
check(in_array($created[0], $flatIds, true) && in_array($created[2], $flatIds, true) && !in_array($created[1], $flatIds, true), "{$mode}: فیلتر flat_rate، شامل شکل قدیمی flat_rate:7");
check(in_array($created[1], $pickup, true) && !array_intersect([$created[0], $created[2]], $pickup), "{$mode}: فیلتر local_pickup");
// شمار کل در برابر یک منبع مستقل: همهٔ صفحه‌ها خوانده و روش ارسال هر سفارش از CRUD خود ووکامرس سنجیده می‌شود.
$all = [];
for ($pg = 1; $pg <= max(1, $flat['pages']); $pg++) {
    foreach ($view(['shippingMethod' => 'flat_rate', 'page' => $pg, 'until' => $flat['until']])['orders'] as $o) { $all[] = $o['id']; }
}
$isFlat = fn ($id) => (bool) array_filter(wc_get_order($id)->get_shipping_methods(), fn ($m) => preg_match('/^flat_rate(:|$)/', $m->get_method_id()));
check(count($all) === $flat['total'] && count(array_unique($all)) === count($all) && !array_filter($all, fn ($id) => !$isFlat($id)),
    "{$mode}: شمار کل فیلترشده ({$flat['total']}) با همهٔ صفحه‌ها یکی است و هر سفارش واقعاً flat_rate دارد");
check(is_string($sql) && str_contains($sql, 'lmc_si.order_item_type') && str_contains($sql, 'LIMIT'), "{$mode}: شرط در همان پرسش صفحه‌بندی‌شدهٔ ووکامرس");
$plan = $wpdb->get_results('EXPLAIN ' . $sql, ARRAY_A);
$keys = [];
foreach ((array) $plan as $row) { if (in_array($row['table'], ['lmc_si', 'lmc_sm'], true)) { $keys[$row['table']] = $row['key']; } }
check(!empty($keys['lmc_si']) && !empty($keys['lmc_sm']), "{$mode}: EXPLAIN: جدول اقلام با ایندکس خوانده می‌شود (" . wp_json_encode($keys) . ')');
$combo = $view(['shippingMethod' => 'flat_rate', 'status' => 'awaiting-pickup'])['orders'];
check(in_array($created[2], array_column($combo, 'id'), true) && !array_filter($combo, fn ($o) => $o['status'] !== 'awaiting-pickup'), "{$mode}: فیلتر ارسال با فیلتر وضعیت ترکیب می‌شود");
$log[] = 'EXPLAIN ' . $mode . ': ' . wp_json_encode(array_map(fn ($r) => array_intersect_key($r, array_flip(['select_type', 'table', 'type', 'key', 'rows'])), (array) $plan), JSON_UNESCAPED_UNICODE);

// ── زباله‌دان ──
$bin = wc_create_order(['status' => 'processing']); $bin->set_date_created(time() - 300); $bin->save();
$binId = $bin->get_id(); $bin->delete(false);         // delete() شناسهٔ شیء را صفر می‌کند، حتی وقتی فقط به زباله‌دان می‌برد
wp_cache_flush();
check(wc_get_order($binId)->get_status() === 'trash', "{$mode}: سفارش واقعاً به زباله‌دان رفت");
check(!in_array($binId, array_column($view([])['orders'], 'id'), true), "{$mode}: زباله‌دان در «همه» نیست");
$binList = $view(['status' => 'trash']);
check(in_array($binId, array_column($binList['orders'], 'id'), true)
    && array_values(array_filter($binList['orders'], fn ($o) => $o['id'] === $binId))[0]['statusLabel'] === 'زباله‌دان', "{$mode}: فیلتر زباله‌دان");

// ── کنترل منفی: انبارهٔ دیگر ──
$other = $mode === 'hpos' ? 'legacy' : 'hpos';
$foreign = get_option("lmc_ov_last_{$other}", []);
if ($foreign) {
    $seen = array_intersect($foreign, array_column($view([])['orders'], 'id'));
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
check($res->get_status() === 200 && $res->get_data()['protocol'] === 3, "{$mode}: REST امضاشده ۲۰۰، قرارداد ۳");
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
$attrs = array_column($d['items']['rows'], 'attributes');
check(!str_contains(wp_json_encode($d, JSON_UNESCAPED_UNICODE), 'SENTINEL') && !str_contains(wp_json_encode($attrs, JSON_UNESCAPED_UNICODE), 'integration_token'),
    "{$mode}: متای عمومی integration_token ویژگی نشد");
$goneRow = array_values(array_filter($d['items']['rows'], fn ($r) => $r['productExists'] === false))[0] ?? null;
check($goneRow !== null && array_column($goneRow['attributes'], 'value') === ['XL آزمون'], "{$mode}: کالا و مادر حذف‌شده: ویژگی pa_ ماند، ویژگی سفارشی منبع ندارد");
check($d['tracking'] === [['provider' => 'iran-post', 'number' => "IR-{$tag}", 'shippedAt' => $d['tracking'][0]['shippedAt'], 'url' => "https://tracking.example.invalid/{$tag}"]]
    && $d['tracking'][0]['shippedAt'] !== null, "{$mode}: رهگیری افزونهٔ رسمی");
check($d['modifiedAt'] !== null && $d['completedAt'] === null, "{$mode}: تاریخ تغییر؛ سفارش در حال انجام تاریخ تکمیل ندارد");
$done = signed(['orderId' => $created[1]])->get_data()['order'];
check($done['status'] === 'completed' && $done['completedAt'] !== null, "{$mode}: تاریخ تکمیل سفارش تکمیل‌شده");
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
check(signed(['status' => 'trash'])->get_status() === 200, "{$mode}: زباله‌دان از راه REST");
check(signed(['page' => 2, 'until' => time()])->get_status() === 400, "{$mode}: لنگر ثانیهٔ جاری از راه REST رد شد");
check(signed(['shippingMethod' => 'teleport'])->get_status() === 400, "{$mode}: روش ارسال ثبت‌نشده رد شد");
check(signed(['orderId' => 999999999])->get_status() === 404, "{$mode}: ناموجود ۴۰۴");

wp_cache_flush();
check($snap() == $before, "{$mode}: خواندن هیچ سفارشی را تغییر نداد");

echo json_encode(['mode' => $mode, 'wc' => WC_VERSION, 'wp' => get_bloginfo('version'), 'checks' => $checks, 'log' => $log], JSON_UNESCAPED_UNICODE), "\n";
