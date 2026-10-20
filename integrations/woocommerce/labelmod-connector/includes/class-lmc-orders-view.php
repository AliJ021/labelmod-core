<?php
/**
 * سفارش‌های سایت برای منوی مدیر در Core — فقط‌خواندنی و امضاشده.
 *
 * همان نگهبان تشخیص (`LMC_Push_Receiver::verify_request`: HMAC، پنجرهٔ زمانی و Nonce یک‌بارمصرف).
 *
 * ⚠️ فقط از CRUD رسمی ووکامرس (`wc_get_orders` با صفحه‌بندی، `wc_get_order`) خوانده می‌شود، پس روی
 *    HPOS و جدول قدیمی پست یک نتیجه می‌دهد. هیچ SQL روی `wp_posts`، هیچ `limit => -1`: صفحه حداکثر ۵۰
 *    سفارش است و شمارهٔ صفحه سقف دارد.
 * ⚠️ هیچ سفارش، متا، صف یا موجودی‌ای تغییر نمی‌کند؛ `save()` اینجا صدا زده نمی‌شود.
 * ⚠️ دادهٔ شخصی حداقلی: فقط نام صورت‌حساب. تلفن، ایمیل و نشانی در پاسخ نیستند؛ متن خام خطای همگام‌سازی
 *    هم نیست (ممکن است دادهٔ حساس داشته باشد) — فقط «خطا هست».
 * ⚠️ مبلغ به **ریال رشته‌ای** با `LMC_Order_Sync::exact_rial`، همان تبدیل ثبت سفارش. مبلغی که ریالِ
 *    دقیق نشود `null` است، نه عددی گردشده.
 */
if (!defined('ABSPATH')) { exit; }

class LMC_Orders_View
{
    const PER_PAGE_MAX = 50;
    const PAGE_MAX     = 200;
    const ITEMS_MAX    = 100;
    const STATUSES     = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];

    public static function init(): void
    {
        add_action('rest_api_init', function () {
            register_rest_route(LMC_Push_Receiver::NS, '/orders', [
                'methods' => 'POST', 'callback' => [__CLASS__, 'handle'],
                'permission_callback' => [LMC_Push_Receiver::class, 'verify_request'],
            ]);
        });
    }

    public static function handle($request)
    {
        $data = $request->get_json_params();
        $bad = new WP_Error('lmc_bad_orders_query', 'درخواست فهرست سفارش معتبر نیست.', ['status' => 400]);
        if (!is_array($data) || array_diff(array_keys($data), ['page', 'perPage', 'status', 'orderId'])) { return $bad; }
        if (isset($data['orderId'])) {
            if (count($data) !== 1 || !is_int($data['orderId']) || $data['orderId'] <= 0) { return $bad; }
            $order = wc_get_order($data['orderId']);
            if (!$order instanceof WC_Order || $order->get_type() !== 'shop_order') {
                return new WP_Error('lmc_order_not_found', 'سفارش پیدا نشد.', ['status' => 404]);
            }
            return new WP_REST_Response(self::envelope(['order' => self::detail($order)]), 200);
        }
        $page = $data['page'] ?? 1;
        $per  = $data['perPage'] ?? 20;
        $status = $data['status'] ?? null;
        if (!is_int($page) || $page < 1 || $page > self::PAGE_MAX
            || !is_int($per) || $per < 1 || $per > self::PER_PAGE_MAX
            || ($status !== null && !in_array($status, self::STATUSES, true))) {
            return $bad;
        }
        return new WP_REST_Response(self::envelope(self::page($page, $per, $status)), 200);
    }

    /** هویت سایت و دامنه، تا Core پاسخ سایت دیگری را نپذیرد. */
    private static function envelope(array $body): array
    {
        return ['protocol' => 1, 'siteUrl' => untrailingslashit(home_url()),
            'branchId' => (string) lmc_setting('branch_id'), 'warehouseId' => (string) lmc_setting('warehouse_id')] + $body;
    }

    public static function page(int $page, int $per, ?string $status): array
    {
        $args = ['type' => 'shop_order', 'limit' => $per, 'paged' => $page, 'paginate' => true,
            'orderby' => 'date', 'order' => 'DESC'];
        if ($status !== null) { $args['status'] = [$status]; }
        $result = wc_get_orders($args);
        $orders = [];
        foreach ((array) $result->orders as $order) {
            if ($order instanceof WC_Order && $order->get_type() === 'shop_order') { $orders[] = self::summary($order); }
        }
        return ['page' => $page, 'perPage' => $per, 'status' => $status,
            'total' => max(0, (int) $result->total), 'pages' => max(0, (int) $result->max_num_pages), 'orders' => $orders];
    }

    public static function summary(WC_Order $order): array
    {
        $status = (string) $order->get_status();
        $created = $order->get_date_created();
        $count = 0;
        foreach ($order->get_items() as $item) {
            if ($item instanceof WC_Order_Item_Product) { $count += max(0, (int) $item->get_quantity()); }
        }
        $number = (string) $order->get_meta(LMC_Order_Sync::META_NUMBER);
        return [
            'id' => (int) $order->get_id(),
            'number' => self::cut((string) $order->get_order_number(), 40),
            'status' => in_array($status, self::STATUSES, true) ? $status : 'unknown',
            'createdAt' => $created ? gmdate('Y-m-d\TH:i:s\Z', $created->getTimestamp()) : null,
            'totalRial' => self::rial((string) $order->get_total()),
            'itemCount' => $count,
            'customerName' => self::cut(trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()), 100),
            'paymentMethod' => self::cut((string) $order->get_payment_method_title(), 100),
            'core' => [
                'paymentConfirmed' => $order->get_meta(LMC_Order_Sync::META_PAID) === 'yes',
                'recorded' => $order->get_meta(LMC_Order_Sync::META_INVOICE) !== '',
                'invoiceNumber' => $number === '' ? null : self::cut($number, 40),
                'attempts' => max(0, (int) $order->get_meta(LMC_Order_Sync::META_ATTEMPTS)),
                'hasError' => $order->get_meta(LMC_Order_Sync::META_ERROR) !== '',
                'stopped' => $order->get_meta(LMC_Order_Sync::META_STOPPED) !== '',
            ],
        ];
    }

    public static function detail(WC_Order $order): array
    {
        $items = [];
        $truncated = false;
        foreach ($order->get_items() as $item) {
            if (!$item instanceof WC_Order_Item_Product) { continue; }
            if (count($items) >= self::ITEMS_MAX) { $truncated = true; break; }
            $product = $item->get_product();
            $items[] = [
                'name' => self::cut((string) $item->get_name(), 200),
                'sku' => $product ? self::cut((string) $product->get_sku(), 64) : '',
                'quantity' => max(0, (int) $item->get_quantity()),
                'totalRial' => self::rial((string) $item->get_total()),
            ];
        }
        return self::summary($order) + [
            'items' => $items, 'itemsTruncated' => $truncated,
            'shippingRial' => self::rial((string) $order->get_shipping_total()),
            'discountRial' => self::rial((string) $order->get_discount_total()),
        ];
    }

    private static function rial(string $amount): ?string
    {
        $value = LMC_Order_Sync::exact_rial($amount);
        return $value === null ? null : (string) $value;
    }

    private static function cut(string $text, int $max): string
    {
        // نویسهٔ کنترلی به Core نمی‌رود؛ طول بر حسب نویسه، نه بایت (نام فارسی).
        $clean = preg_replace('/[\x00-\x1F\x7F]/u', '', $text);
        $clean = is_string($clean) ? $clean : '';
        return function_exists('mb_substr') ? mb_substr($clean, 0, $max) : substr($clean, 0, $max);
    }
}
