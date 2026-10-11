<?php
/** فرم مستقل کلید Push؛ فقط مدیر سایت و بدون نمایش دوبارهٔ راز. */
if (!defined('ABSPATH')) { exit; }

class LMC_Push_Secret_Settings
{
    public static function init(): void
    {
        add_action('admin_post_lmc_save_push_secret', [__CLASS__, 'save']);
    }

    public static function allowed(): bool
    {
        return current_user_can('manage_options') && current_user_can('manage_woocommerce');
    }

    public static function save(): void
    {
        if (!self::allowed()) { wp_die('دسترسی ندارید.', '', ['response' => 403]); }
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { wp_die('روش درخواست معتبر نیست.', '', ['response' => 405]); }
        check_admin_referer('lmc_save_push_secret');
        $raw = $_POST['push_secret'] ?? '';
        $clear = isset($_POST['clear_push_secret']) && $_POST['clear_push_secret'] === '1';
        $ok = is_string($raw) && LMC_Push_Secret::save(wp_unslash($raw), $clear);
        wp_safe_redirect(add_query_arg('lmc_push_msg', $ok ? 'saved' : 'failed', admin_url('admin.php?page=' . LMC_Settings::PAGE)));
        exit;
    }

    public static function render(): void
    {
        if (!self::allowed()) { return; }
        $status = LMC_Push_Secret::status();
        $labels = [
            'missing' => 'کلید همگام‌سازی لحظه‌ای هنوز تنظیم نشده است.',
            'legacy' => 'کلید قدیمی پیکربندی فعال است؛ کلید تازهٔ این فرم جای آن را می‌گیرد.',
            'saved' => 'کلید همگام‌سازی لحظه‌ای ذخیره شده است.',
            'disabled' => 'همگام‌سازی لحظه‌ای با پاک‌کردن کلید غیرفعال شده است.',
            'unreadable' => 'کلید ذخیره‌شده خوانده نمی‌شود؛ کلیدهای امنیتی وردپرس یا امکان رمزگذاری را بررسی و کلید اتصال را دوباره ثبت کنید.',
        ];
        echo '<hr><h2>همگام‌سازی لحظه‌ای با حسابداری</h2>';
        $msg = $_GET['lmc_push_msg'] ?? '';
        if ($msg === 'saved') { echo '<p role="status">تنظیم کلید ذخیره شد.</p>'; }
        if ($msg === 'failed') { echo '<p role="alert">کلید ذخیره نشد؛ قالب کلید، امکان رمزگذاری و ذخیرهٔ تنظیمات را بررسی کنید. کلید قبلی دست‌نخورده است.</p>'; }
        echo '<p>' . esc_html($labels[$status]) . '</p>';
        if (!LMC_Push_Secret::available()) {
            echo '<p role="alert">ذخیرهٔ کلید تازه به OpenSSL و کلیدهای امنیتی معتبر وردپرس نیاز دارد؛ کلید به صورت ساده ذخیره نمی‌شود.</p>';
        }
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('lmc_save_push_secret');
        echo '<input type="hidden" name="action" value="lmc_save_push_secret">';
        echo '<p><label>کلید همگام‌سازی لحظه‌ای <input type="password" name="push_secret" class="regular-text" dir="ltr" autocomplete="new-password" value="" maxlength="512"></label></p>';
        echo '<p class="description">همان کلید امضای API و Worker حسابداری را وارد کنید؛ با کلید API سفارش‌ها متفاوت است. کلید باید 32 تا 512 نویسهٔ انگلیسی چاپ‌پذیر و بدون فاصله باشد. خالی گذاشتن یعنی حفظ کلید. نیازی به ویرایش فایل هاست نیست.</p>';
        echo '<p><label><input type="checkbox" name="clear_push_secret" value="1"> کلید پاک و دریافت لحظه‌ای غیرفعال شود (کلید قدیمی پیکربندی هم فعال نمی‌شود)</label></p>';
        submit_button('ذخیرهٔ کلید همگام‌سازی', 'secondary');
        echo '</form><p class="description">این کلید دوباره نمایش داده نمی‌شود. تغییر کلیدهای امنیتی وردپرس ممکن است ورود دوبارهٔ آن را لازم کند. همگام‌سازی دوره‌ای همچنان مسیر جبران قطعی است.</p>';
    }
}
