<?php
/** تشخیص فقط‌خواندنی؛ سفارش، متا، صف و موجودی تغییر نمی‌کنند. */
if (!defined('ABSPATH')) { exit; }

class LMC_Diagnostics
{
    public static function init(): void
    {
        add_action('rest_api_init', function () {
            register_rest_route(LMC_Push_Receiver::NS, '/diagnostics', [
                'methods' => 'POST', 'callback' => [__CLASS__, 'handle'],
                'permission_callback' => [LMC_Push_Receiver::class, 'verify_request'],
            ]);
        });
    }

    public static function handle($request)
    {
        $data = $request->get_json_params();
        if (!is_array($data) || array_diff(array_keys($data), ['orderId'])
            || (isset($data['orderId']) && (!is_int($data['orderId']) || $data['orderId'] <= 0))) {
            return new WP_Error('lmc_bad_diagnostics', 'ورودی تست اتصال معتبر نیست.', ['status' => 400]);
        }
        return new WP_REST_Response(self::report($data['orderId'] ?? null), 200);
    }

    public static function report(?int $order_id = null): array
    {
        global $wpdb;
        // فقط محصولات؛ سفارش‌های HPOS از CRUD رسمی خوانده می‌شوند.
        $linked = $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(DISTINCT p.ID) FROM {$wpdb->posts} p JOIN {$wpdb->postmeta} m ON m.post_id=p.ID
             WHERE p.post_type IN ('product','product_variation') AND p.post_status <> 'trash'
             AND m.meta_key=%s AND m.meta_value <> ''", '_lmc_variation_id'
        ));
        return [
            'protocol' => 1, 'pluginVersion' => LMC_VERSION,
            'wooVersion' => defined('WC_VERSION') ? WC_VERSION : 'unknown',
            'siteUrl' => untrailingslashit(home_url()),
            'branchId' => (string) lmc_setting('branch_id'), 'warehouseId' => (string) lmc_setting('warehouse_id'),
            'apiKeyConfigured' => lmc_setting('api_key') !== '',
            'stockPolling' => lmc_setting('sync_stock') === 'yes',
            'pricePolling' => lmc_setting('sync_price') === 'yes',
            'cronDisabled' => defined('DISABLE_WP_CRON') && DISABLE_WP_CRON,
            'stockScheduled' => (bool) wp_next_scheduled(LMC_STOCK_EVENT),
            'mapping' => ['linkedProducts' => $linked === null ? null : (int) $linked, 'orderIdentity' => 'sku', 'stockIdentity' => 'variationId'],
            'order' => $order_id === null ? null : self::order_status($order_id),
        ];
    }

    public static function order_status(int $id): array
    {
        $order = wc_get_order($id);
        $out = ['found' => false, 'status' => '', 'paymentConfirmed' => false, 'eligible' => false,
            'recorded' => false, 'scheduled' => false, 'attempts' => 0, 'hasError' => false,
            'missingSku' => 0, 'missingMapping' => 0];
        if (!$order || $order->get_type() !== 'shop_order') { return $out; }
        $out['found'] = true;
        $status = (string) $order->get_status();
        $out['status'] = in_array($status, ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'], true) ? $status : 'unknown';
        $out['paymentConfirmed'] = $order->get_meta(LMC_Order_Sync::META_PAID) === 'yes';
        $out['eligible'] = $out['paymentConfirmed'] && $order->has_status(['processing', 'completed', 'refunded'])
            && (($order->get_payment_method() !== 'cod' && !is_array($order->get_meta('_lmc_reservation_payload'))) || $order->has_status(['completed']));
        $out['recorded'] = $order->get_meta(LMC_Order_Sync::META_INVOICE) !== '';
        $out['scheduled'] = (bool) wp_next_scheduled(LMC_ORDER_EVENT, [$id]);
        $out['attempts'] = max(0, (int) $order->get_meta(LMC_Order_Sync::META_ATTEMPTS));
        // متن خام خطای مقصد ممکن است داده حساس داشته باشد؛ فقط وجود خطا گزارش می‌شود.
        $out['hasError'] = $order->get_meta(LMC_Order_Sync::META_ERROR) !== '';
        foreach ($order->get_items() as $item) {
            if (!$item instanceof WC_Order_Item_Product || $item->get_quantity() <= 0) { continue; }
            $product = $item->get_product();
            if (!$product || $product->get_sku() === '') { $out['missingSku']++; }
            if (!$product || $product->get_meta('_lmc_variation_id') === '') { $out['missingMapping']++; }
        }
        return $out;
    }

    public static function render(): void
    {
        if (!current_user_can('manage_woocommerce')) { return; }
        echo '<hr><h2>تست اتصال فقط‌خواندنی</h2><p>نسخهٔ افزونه: ' . esc_html(LMC_VERSION) . '</p>';
        echo '<p>سفارش با SKU به Core می‌رود؛ موجودی با شناسهٔ ثابت تنوع از Core به سایت می‌آید. تست اتصال سفارش یا موجودی را تغییر نمی‌دهد.</p>';
        echo '<form method="post">';
        wp_nonce_field('lmc_diagnostics');
        echo '<p><label>شمارهٔ داخلی سفارش (اختیاری) <input name="lmc_order_id" inputmode="numeric"></label></p>';
        echo '<p><label>شناسهٔ محصول یا تنوع سایت برای بررسی نگاشت (اختیاری) <input name="lmc_product_id" inputmode="numeric"></label></p>';
        submit_button('تست اتصال', 'secondary', 'lmc_diagnostics', false);
        echo '</form>';
        if (!isset($_POST['lmc_diagnostics'])) { return; }
        check_admin_referer('lmc_diagnostics');
        $order_id = isset($_POST['lmc_order_id']) ? absint($_POST['lmc_order_id']) : 0;
        $product_id = isset($_POST['lmc_product_id']) ? absint($_POST['lmc_product_id']) : 0;
        $query = ['branchId' => (string) lmc_setting('branch_id'), 'warehouseId' => (string) lmc_setting('warehouse_id')];
        if ($product_id) {
            $product = wc_get_product($product_id);
            if (!$product || $product->get_sku() === '') {
                echo '<p role="alert">کالا یافت نشد یا SKU ندارد؛ قرارداد فعلی سفارش به SKU معتبر نیاز دارد.</p>';
                return;
            }
            $query['sku'] = $product->get_sku();
            if ($product->get_meta('_lmc_variation_id') !== '') { $query['variationId'] = $product->get_meta('_lmc_variation_id'); }
        }
        $res = LMC_Client::get('/web/connection', $query);
        if (is_wp_error($res)) {
            $status = (int) ($res->get_error_data()['status'] ?? 0);
            $message = in_array($status, [401, 403], true)
                ? 'احراز هویت یا دسترسی رد شد؛ کلید API، مجوز ثبت فروش و شعبه را بررسی کنید.'
                : ($status === 404 ? 'مسیر تست اتصال پیدا نشد؛ Core باید همراه نسخهٔ جدید افزونه به‌روز شود.'
                : 'اتصال کامل نشد؛ نشانی HTTPS نهایی، گواهی، شبکه و انتخاب شعبه/انبار را بررسی کنید.');
            echo '<p role="alert">' . esc_html($message) . '</p>';
        } elseif (($res['protocol'] ?? null) !== 1 || ($res['authenticated'] ?? false) !== true
            || ($res['branchId'] ?? '') !== $query['branchId'] || ($res['warehouseId'] ?? '') !== $query['warehouseId']) {
            echo '<p role="alert">پاسخ با قرارداد تست اتصال یا شعبه/انبار انتخاب‌شده سازگار نیست.</p>';
        } else {
            echo '<p>احراز هویت، مجوز فروش و شعبه/انبار تأیید شد؛ این نتیجه ثبت سفارش را اثبات نمی‌کند.</p>';
            if (isset($res['mapping'])) {
                $m = $res['mapping'];
                echo '<p>' . esc_html(($m['skuFound'] ?? false) && ($m['active'] ?? false) && ($m['matchesVariation'] ?? null) !== false
                    ? 'SKU فعال در Core پیدا شد؛ تطبیق شناسهٔ اتصال در صورت وجود انجام شد.'
                    : 'SKU ناموجود/غیرفعال است یا به تنوع دیگری اشاره می‌کند؛ پیش از ارسال سفارش نگاشت را اصلاح کنید.') . '</p>';
            }
        }
        $r = self::report($order_id ?: null);
        echo '<p>محصولات دارای شناسهٔ اتصال: ' . esc_html($r['mapping']['linkedProducts'] === null ? 'خواندن شمارش ممکن نشد' : (string) $r['mapping']['linkedProducts']) . '</p>';
        echo '<p>' . esc_html($r['stockScheduled'] ? 'رویداد دوره‌ای موجودی ثبت شده است.' : 'رویداد دوره‌ای موجودی ثبت نشده است؛ فعال‌سازی افزونه را بررسی کنید.') . '</p>';
        if ($r['cronDisabled']) { echo '<p>WP-Cron خاموش است؛ اجرای cron سیستم باید جداگانه بررسی شود.</p>'; }
        if ($r['order'] !== null) {
            $o = $r['order'];
            echo '<p>' . esc_html(!$o['found'] ? 'سفارش یافت نشد.' : ($o['recorded'] ? 'شناسهٔ فاکتور Core روی سفارش ثبت شده است.'
                : (!$o['eligible'] ? 'سفارش آمادهٔ ارسال نیست؛ تأیید پرداخت و وضعیت processing/completed را بررسی کنید.'
                : ($o['scheduled'] ? 'سفارش در انتظار اجرای زمان‌بند است.' : 'سفارش ارسال‌نشده و بدون رویداد زمان‌بندی است؛ گزارش سفارش را بررسی کنید.')))) . '</p>';
            echo '<p>تعداد تلاش: ' . esc_html((string) $o['attempts']) . '؛ اقلام بدون SKU: ' . esc_html((string) $o['missingSku']) . '</p>';
            if ($o['hasError']) { echo '<p>خطای ارسال ثبت شده است؛ یادداشت همان سفارش را بررسی کنید.</p>'; }
        }
    }
}
