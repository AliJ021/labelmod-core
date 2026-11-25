<?php
/** تشخیص فقط‌خواندنی؛ سفارش، متا، صف و موجودی تغییر نمی‌کنند. */
if (!defined('ABSPATH')) { exit; }

class LMC_Diagnostics
{
    public const DAILY = 'lmc_daily_connection_check';
    public const STATUS = 'lmc_connection_check_status';

    public static function schedule(): void
    {
        if (!wp_next_scheduled(self::DAILY)) {
            wp_schedule_event(time() + 60, 'daily', self::DAILY);
        }
    }

    private static function scope(): string
    {
        $parts = array_map('lmc_setting', ['base_url', 'api_key', 'branch_id', 'warehouse_id']);
        return hash_hmac('sha256', wp_json_encode($parts), wp_salt('auth'));
    }

    public static function status(): array
    {
        $status = get_option(self::STATUS, []);
        return ($status['scope'] ?? null) === self::scope() ? $status : [];
    }

    public static function check(array $query = [])
    {
        $scope = self::scope();
        $query['branchId'] = (string) lmc_setting('branch_id');
        $query['warehouseId'] = (string) lmc_setting('warehouse_id');
        if (!lmc_setting('api_key') || !lmc_setting('base_url') || !$query['branchId'] || !$query['warehouseId']) {
            return new WP_Error('lmc_missing_scope', 'اتصال، شعبه و انبار را انتخاب کنید.');
        }
        $res = LMC_Client::get('/web/connection', $query);
        $ok = is_array($res) && ($res['protocol'] ?? null) === 1 && ($res['authenticated'] ?? false) === true
            && ($res['branchId'] ?? '') === $query['branchId'] && ($res['warehouseId'] ?? '') === $query['warehouseId'];
        if ($scope === self::scope()) {
            update_option(self::STATUS, ['scope' => $scope, 'time' => time(), 'ok' => $ok,
                'discount' => $ok && ($res['features']['explicitLineDiscount'] ?? false) === true], false);
        }
        return $res;
    }

    public static function init(): void
    {
        add_action('init', [__CLASS__, 'schedule']);
        add_action(self::DAILY, [__CLASS__, 'check']);
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
            'pushConfigured' => LMC_Push_Secret::read() !== '',
            'stockPolling' => lmc_setting('sync_stock') === 'yes',
            'pricePolling' => lmc_setting('sync_price') === 'yes',
            'cronDisabled' => defined('DISABLE_WP_CRON') && DISABLE_WP_CRON,
            'stockScheduled' => (bool) wp_next_scheduled(LMC_STOCK_EVENT),
            'queue' => LMC_Queue::health(),
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
        $out['scheduled'] = LMC_Queue::queued(LMC_ORDER_EVENT, [$id]);
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
        echo '<h2>تست اتصال فقط‌خواندنی</h2><p class="description">برای بررسی اتصال، تست را اجرا کنید. برای بررسی یک سفارش یا تنوع، شناسهٔ آن را هم وارد کنید.</p>';
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
            if (!$product) {
                echo '<p role="alert">کالا یا تنوعی با این شناسه در سایت پیدا نشد.</p>';
            } elseif ($product->get_sku() === '') {
                echo '<p role="alert">این کالا SKU ندارد. کد همان تنوع حسابداری را در ووکامرس وارد کنید.</p>';
            } else {
                $query['sku'] = $product->get_sku();
                if ($product->get_meta('_lmc_variation_id') !== '') {
                    $query['variationId'] = $product->get_meta('_lmc_variation_id');
                }
            }
        }
        $res = self::check($query);
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
        echo '<p>' . esc_html($r['queue']['backend'] === 'action-scheduler'
            ? 'صف بحرانی: Action Scheduler، گروه ' . $r['queue']['group'] . '.'
            : 'صف بحرانی: WP-Cron (Action Scheduler در دسترس نیست).') . '</p>';
        if ($r['queue']['deadTasks'] === null) {
            echo '<p>شمار کارهای بحرانی متوقف خوانده نشد.</p>';
        } elseif ($r['queue']['deadTasks'] > 0) {
            echo '<p role="alert">' . esc_html(sprintf('%d کار بحرانی پس از سه شکست غیرمنتظره متوقف شده است (توقف کسب‌وکاری سفارش جداست)؛ سفارش‌ها و Scheduled Actions را بررسی کنید.', $r['queue']['deadTasks'])) . '</p>';
        }
        $deferred = $r['queue']['deferredTasks'] ?? null;
        if ($deferred === null) {
            echo '<p>شمار کارهای معوق صف (منتظر قفل) خوانده نشد.</p>';
        } elseif ($deferred > 0) {
            echo '<p>' . esc_html(sprintf('%d تغییر صف منتظر قفل پایگاه داده است و در دور بعدی اجراکننده انجام می‌شود.', $deferred)) . '</p>';
        }
        $busy = $r['queue']['busyTasks'] ?? null;
        if (is_int($busy) && $busy > 0) {
            // اشغال قفل اجرا خطا نیست؛ اجرای دیگری از همان کار در جریان است (بیش از ۱۵ دقیقه: مرده).
            echo '<p>' . esc_html(sprintf('%d کار پشت اجرای در جریانِ همان کار منتظر است.', $busy)) . '</p>';
        }
        $failed = $r['queue']['failedActions'] ?? null;
        if (is_int($failed) && $failed > 0) {
            // هر سطر failed، از جمله آن‌هایی که دوباره صف شده‌اند؛ شمار کار منطقی نیست.
            echo '<p>' . esc_html(sprintf('%d سطر ناموفق گروه بحرانی در Scheduled Actions نگه داشته شده است (شامل تلاش‌هایی که دوباره صف شده‌اند).', $failed)) . '</p>';
        }
        if ($r['order'] !== null) {
            $o = $r['order'];
            if (!$o['found']) {
                echo '<p>سفارش یافت نشد.</p>';
                return;
            }
            echo '<h3>سفارش <bdi>#' . esc_html((string) $order_id) . '</bdi></h3>';
            echo '<p>وضعیت در سایت: ' . esc_html(wc_get_order_status_name($o['status']))
                . ' · تأیید پرداخت در افزونه: ' . ($o['paymentConfirmed'] ? 'ثبت شده' : 'ثبت نشده') . '</p>';
            if ($o['recorded']) {
                $state = 'شمارهٔ فاکتور حسابداری روی سفارش ثبت شده است.';
            } elseif (!$o['paymentConfirmed']) {
                $state = 'افزونه هنوز تأیید پرداخت را دریافت نکرده است. رسید و یادداشت پرداخت همین سفارش را بررسی کنید.';
            } elseif (!$o['eligible']) {
                $state = 'وضعیت فعلی سفارش برای ارسال مناسب نیست. سفارش رزروی یا پرداخت در محل پس از تکمیل ارسال می‌شود.';
            } else {
                $state = $o['scheduled'] ? 'سفارش در انتظار اجرای زمان‌بند است.' : 'سفارش بدون فاکتور و بدون رویداد زمان‌بندی است. گزارش سفارش را بررسی کنید.';
            }
            echo '<p>' . esc_html($state) . '</p>';
            echo '<p>تعداد تلاش: ' . esc_html((string) $o['attempts']) . '؛ اقلام بدون SKU: ' . esc_html((string) $o['missingSku']) . '</p>';
            if ($o['hasError']) { echo '<p>خطای ارسال ثبت شده است؛ یادداشت همان سفارش را بررسی کنید.</p>'; }
        }
    }
}
