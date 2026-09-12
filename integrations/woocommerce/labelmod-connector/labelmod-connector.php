<?php
/**
 * Plugin Name: Label Mod Connector
 * Description: سفارش‌های ووکامرس را به سامانه «لیبل مد» می‌فرستد و موجودی سایت را از انبار همگام می‌کند.
 * Version: 1.0.0
 * Requires PHP: 7.4
 * Requires at least: 6.0
 * License: proprietary
 * Text Domain: labelmod-connector
 *
 * ── این افزونه چه می‌کند و چه نمی‌کند ───────────────────────────────
 *
 * می‌کند:
 *   • سفارشِ **پرداخت‌شده** را به `POST /web/orders` می‌فرستد
 *   • موجودی و قیمت را از `GET /web/stock` می‌گیرد و با کلید اتصال
 *     (`_lmc_variation_id`) روی کالای سایت می‌نشاند — نه با نام و نه
 *     با SKU، چون نام سایت و نام حسابداری عمداً یکی نیستند
 *   • خرید **حضوری** را از `GET /web/instore-purchases` می‌گیرد و در
 *     حساب کاربری مشتری نشان می‌دهد، با برچسب «سفارش حضوری»
 *
 * نمی‌کند، و عمداً:
 *   • **خرید حضوری را `shop_order` نمی‌کند.** ساختن سفارش ووکامرس
 *     برای خریدی که در فروشگاه انجام شده، موجودی را دوباره کم می‌کند،
 *     ایمیل می‌فرستد، در گزارش سایت دوباره شمرده می‌شود، و از همه
 *     بدتر یک **حلقه بازگشتی** می‌سازد چون همان Hookهایی را می‌زند که
 *     این افزونه به آن‌ها گوش می‌دهد. رکورد در نوع پست جدای
 *     `lmc_instore_purchase` می‌نشیند که هیچ Hook ووکامرسی ندارد.
 *   • **سفارش پرداخت‌نشده را نمی‌فرستد.** فاکتور در آن سیستم کالا را
 *     از انبار خارج می‌کند؛ سفارشی که هرگز پرداخت نشود، موجودی را
 *     بی‌دلیل می‌خورد.
 *   • **مرجوعی و بازپرداخت را نمی‌فرستد.** آن مسیر انسان می‌خواهد و
 *     کلید سایت عمداً مجوزش را ندارد.
 *
 * ── قاعده‌ای که کل این افزونه رویش ایستاده ──────────────────────────
 *
 * **ارسال هرگز نباید Checkout را کند یا خراب کند.** اگر سرور لیبل مد
 * پایین باشد، مشتری باید بتواند خریدش را تمام کند. پس ارسال همیشه
 * ناهم‌زمان است (`wp_schedule_single_event`) و شکستش با Backoff دوباره
 * تلاش می‌شود — نه اینکه وسط پرداخت خطا نشان دهد.
 *
 * پیامدش این است که «سفارش ثبت شد» در ووکامرس یعنی سفارش ثبت شد، نه
 * اینکه به لیبل مد رسید. برای همین وضعیت ارسال روی خودِ سفارش دیده
 * می‌شود و صفحه‌ای برای صف ناموفق هست.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('LMC_VERSION', '1.0.0');
define('LMC_PATH', plugin_dir_path(__FILE__));
define('LMC_OPTION', 'labelmod_connector_settings');

/** رویداد Cron برای یک سفارش. */
define('LMC_ORDER_EVENT', 'lmc_send_order');
/** رویداد Cron همگام‌سازی موجودی. */
define('LMC_STOCK_EVENT', 'lmc_sync_stock');
/** رویداد Cron دریافت خرید حضوری. */
define('LMC_INSTORE_EVENT', 'lmc_sync_instore');

require_once LMC_PATH . 'includes/class-lmc-client.php';
require_once LMC_PATH . 'includes/class-lmc-settings.php';
require_once LMC_PATH . 'includes/class-lmc-order-sync.php';
require_once LMC_PATH . 'includes/class-lmc-stock-sync.php';
require_once LMC_PATH . 'includes/class-lmc-instore.php';

/**
 * سازگاری با HPOS را **اعلام** کن.
 *
 * این افزونه از روز اول با HPOS سازگار **است**: مسیر سفارش تمامش از
 * CRUD ووکامرس می‌گذرد (`wc_get_order`، `$order->get_meta()`،
 * `update_meta_data()`، `$order->save()`) و هیچ‌جا `get_post_meta` روی
 * سفارش نمی‌زند. `update_post_meta` فقط روی نوع پستِ خودمان
 * (`lmc_instore_purchase`) است که سفارش نیست و HPOS به آن کاری ندارد.
 *
 * ولی **سازگار بودن و اعلام‌کردنش دو چیزند.** بدون این اعلام، ووکامرس
 * افزونه را در فهرست «ناسازگار» نشان می‌دهد و مالکی که می‌خواهد HPOS را
 * روشن کند، هشدار می‌بیند یا از روشن‌کردنش منع می‌شود — برای
 * ناسازگاری‌ای که وجود ندارد.
 *
 * ⚠️ باید روی `before_woocommerce_init` باشد، نه `plugins_loaded`:
 *    ووکامرس فهرست سازگاری را پیش از آن می‌بندد.
 */
add_action('before_woocommerce_init', function () {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
            'custom_order_tables',
            __FILE__,
            true
        );
    }
});

/**
 * بدون ووکامرس این افزونه بی‌معناست — و با فعال‌ماندنش، خطای مرگبار
 * روی هر بارگذاری صفحه می‌داد.
 */
add_action('plugins_loaded', function () {
    if (!class_exists('WooCommerce')) {
        add_action('admin_notices', function () {
            echo '<div class="notice notice-error"><p>'
               . esc_html__('افزونه «Label Mod Connector» به ووکامرس نیاز دارد و بدون آن کار نمی‌کند.', 'labelmod-connector')
               . '</p></div>';
        });
        return;
    }

    LMC_Settings::init();
    LMC_Order_Sync::init();
    LMC_Stock_Sync::init();
    LMC_Instore::init();
});

/**
 * فعال‌سازی: زمان‌بند موجودی روشن شود.
 *
 * ⚠️ WP-Cron واقعاً زمان‌بند نیست: با بازدید صفحه اجرا می‌شود. روی
 *    سایتی که ساعت‌ها بازدید ندارد، همگام‌سازی موجودی عقب می‌افتد.
 *    راهنمای نصب می‌گوید چطور با cron واقعی سیستم جایگزینش کنید.
 */
register_activation_hook(__FILE__, function () {
    if (!wp_next_scheduled(LMC_STOCK_EVENT)) {
        wp_schedule_event(time() + 60, 'lmc_quarter_hour', LMC_STOCK_EVENT);
    }
    if (!wp_next_scheduled(LMC_INSTORE_EVENT)) {
        wp_schedule_event(time() + 120, 'lmc_quarter_hour', LMC_INSTORE_EVENT);
    }
    // نقطه پایان تازه بدون این، ۴۰۴ می‌دهد — و کسی نمی‌فهمد چرا.
    LMC_Instore::register_post_type();
    LMC_Instore::register_endpoint();
    flush_rewrite_rules();
});

register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook(LMC_STOCK_EVENT);
    wp_clear_scheduled_hook(LMC_INSTORE_EVENT);
    flush_rewrite_rules();
});

add_filter('cron_schedules', function ($schedules) {
    $schedules['lmc_quarter_hour'] = [
        'interval' => 15 * MINUTE_IN_SECONDS,
        'display'  => __('هر ۱۵ دقیقه (لیبل مد)', 'labelmod-connector'),
    ];
    return $schedules;
});

/** تنظیمات ذخیره‌شده، با پیش‌فرض‌ها. */
function lmc_settings(): array
{
    $saved = get_option(LMC_OPTION, []);
    if (!is_array($saved)) {
        $saved = [];
    }
    return array_merge([
        'base_url'      => '',
        'api_key'       => '',
        'branch_id'     => '',
        'warehouse_id'  => '',
        // واحد پول سایت. سامانه لیبل مد **ریال** نگه می‌دارد و ورودی
        // این API هم ریال است؛ اگر سایت به تومان کار کند باید ×۱۰ شود.
        // غلط بودن این یک تنظیم یعنی همه اعداد یک صفر کم یا زیاد
        // داشته باشند، پس در صفحه تنظیمات صریح پرسیده می‌شود.
        'currency_unit' => 'toman',
        'payment_map'   => '',
        'sync_stock'    => 'yes',
        // قیمت پیش‌فرض **خاموش** است: سایتی که کمپین مستقل دارد نباید
        // با نصب افزونه بی‌صدا قیمت‌هایش عوض شود. روشن‌کردنش یک تصمیم
        // آگاهانه است.
        'sync_price'    => 'no',
        'price_list'    => 'default',
        // پل یک‌بارمصرف SKU → متا. پس از یک دور کامل می‌شود خاموشش
        // کرد تا SKU سایت آزادانه عوض شود.
        'link_by_sku'   => 'yes',
        'sync_instore'  => 'yes',
        'debug_log'     => 'no',
    ], $saved);
}

/** یک تنظیم. */
function lmc_setting(string $key, $default = '')
{
    $all = lmc_settings();
    return $all[$key] ?? $default;
}

/**
 * لاگ — فقط وقتی صریح روشن شده باشد.
 *
 * کلید API هرگز اینجا نمی‌نشیند — نه چون پاک می‌شود، بلکه چون
 * `LMC_Client` اصلاً به لاگ نمی‌دهدش: کلید در هدر `Authorization`
 * می‌ماند و لاگ فقط روش، مسیر، کد وضعیت و پیام خطا را می‌نویسد.
 * راهی که راز را **حمل نکند**، از راهی که حملش کند و بعد پاکش کند
 * امن‌تر است — چون پاک‌کردن می‌تواند یک روز جا بیفتد.
 * لاگی که راز را نگه دارد، خودش یک نشت است.
 */
function lmc_log(string $message): void
{
    if (lmc_setting('debug_log') !== 'yes' || !function_exists('wc_get_logger')) {
        return;
    }
    wc_get_logger()->info($message, ['source' => 'labelmod']);
}
