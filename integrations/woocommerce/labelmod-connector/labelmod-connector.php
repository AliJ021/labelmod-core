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
 *   • موجودی را از `GET /web/stock` می‌گیرد و روی SKU می‌نشاند
 *
 * نمی‌کند، و عمداً:
 *   • **قیمت را به سایت نمی‌نویسد.** قیمت سایت می‌تواند از قیمت
 *     فروشگاه فرق کند (کمپین، ارسال رایگان) و همگام‌سازی خودکارش
 *     تصمیمی است که مالک باید بگیرد، نه چیزی که بی‌صدا اتفاق بیفتد.
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

require_once LMC_PATH . 'includes/class-lmc-client.php';
require_once LMC_PATH . 'includes/class-lmc-settings.php';
require_once LMC_PATH . 'includes/class-lmc-order-sync.php';
require_once LMC_PATH . 'includes/class-lmc-stock-sync.php';

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
});

register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook(LMC_STOCK_EVENT);
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
 * کلید API هرگز اینجا نمی‌نشیند؛ `LMC_Client` پیش از لاگ‌کردن پاکش
 * می‌کند. لاگی که راز را نگه دارد، خودش یک نشت است.
 */
function lmc_log(string $message): void
{
    if (lmc_setting('debug_log') !== 'yes' || !function_exists('wc_get_logger')) {
        return;
    }
    wc_get_logger()->info($message, ['source' => 'labelmod']);
}
