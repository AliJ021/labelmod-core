<?php
/**
 * سفارش‌های سایت برای منوی مدیر در Core — فقط‌خواندنی و امضاشده (قرارداد ۳).
 *
 * همان نگهبان تشخیص (`LMC_Push_Receiver::verify_request`: HMAC، پنجرهٔ زمانی و Nonce یک‌بارمصرف).
 *
 * ⚠️ فقط از CRUD و جست‌وجوی رسمی ووکامرس خوانده می‌شود، پس روی HPOS و جدول قدیمی پست یک نتیجه می‌دهد:
 *    - فهرست: `wc_get_orders` صفحه‌بندی‌شده.
 *    - جست‌وجو: روی HPOS پارامتر `s` و روی legacy `wc_order_search()`؛ هر دو همان جست‌وجوی پیشخوان
 *      ووکامرس‌اند: شناسه، نام، ایمیل، تلفن، نشانی و نام قلم.
 *    - جزئیات: `wc_get_order` و `wc_get_order_notes`.
 *    هیچ `limit => -1` نیست و افزونه خودش هیچ پرسشی اجرا نمی‌کند. تنها SQL، شرط آماده‌شده (`prepare`) فیلتر
 *    روش ارسال است که به **همان** پرسش صفحه‌بندی‌شدهٔ ووکامرس افزوده می‌شود (HPOS:
 *    `woocommerce_orders_table_query_clauses`؛ legacy: `posts_where`) و فقط جدول اقلام سفارش را می‌خواند —
 *    جدولی که در هر دو انباره یکی است. پس هیچ سفارشی در PHP پیمایش نمی‌شود.
 * ⚠️ **هزینهٔ هر درخواست محدود است.** صفحه حداکثر ۵۰ سفارش و شمارهٔ صفحه حداکثر ۱۰۰٬۰۰۰ است (با ۲۰تایی Core،
 *    ۲ میلیون سفارش تازه‌تر در دسترس صفحه‌بندی؛ قدیمی‌تر از آن با فیلتر تاریخ). ترتیب: تاریخ نزولی، سپس شناسه نزولی.
 *    صفحه‌ها تصویر لحظه‌ای (snapshot) نیستند؛ لنگر فقط سفارش تازه را بیرون نگه می‌دارد (مرز صریح پایین).
 * ⚠️ **لنگر `until` ثانیهٔ جاری را بیرون می‌گذارد** (بازبینی ریشه روی 2a4e62e). لنگر پیش‌فرض `time() - 1`
 *    است و لنگرِ ثانیهٔ جاری یا آینده رد می‌شود؛ با `<=` و لنگر `time()`، سفارشی که در همان ثانیه ساخته
 *    می‌شد صفحه‌ها را جابه‌جا می‌کرد و یک سفارش در دو صفحه تکرار می‌شد.
 *    **مرز صریح:** لنگر فقط در برابر سفارشی پایدار است که زمان ساختش زمان واقعی درج باشد. سفارشی که با
 *    تاریخ گذشته درج شود (ثبت دستی، واردات، درج کُند پس از تعیین تاریخ)، سفارشی که تاریخ ساختش ویرایش
 *    شود، یا سفارشی که میان دو صفحه وضعیتش با فیلتر وضعیت جور یا ناجور شود (از جمله رفتن به زباله‌دان)
 *    می‌تواند صفحه‌های بعدی را جابه‌جا کند: یک ردیف ممکن است تکرار یا جا بیفتد. «به‌روزرسانی» لنگر تازه
 *    می‌گیرد.
 * ⚠️ **مبلغ همان عدد ذخیره‌شدهٔ ووکامرس است، با ارز خودِ سفارش** (`get_currency()`)، رشتهٔ اعشاری دقیق.
 *    تبدیل به ریال اینجا انجام **نمی‌شود**؛ Core فقط برای کد ارز شناخته‌شده تبدیل می‌کند. تنظیم سراسری
 *    `currency_unit` ارز سفارش‌های تاریخی را نمی‌داند و برای این نمایش به کار نمی‌رود.
 * ⚠️ هیچ سفارش، متا، صف یا موجودی‌ای تغییر نمی‌کند؛ `save()` اینجا صدا زده نمی‌شود.
 * ⚠️ دادهٔ برگشتی همان است که مدیر در پیشخوان ووکامرس می‌بیند: تماس و نشانی، اقلام، کارمزد، ارسال،
 *    کوپن، استرداد، یادداشت، مدرک پرداخت، تاریخ تکمیل و آخرین تغییر، و کد رهگیری افزونهٔ رسمی
 *    «WooCommerce Shipment Tracking». **متای خام، کلید، توکن، IP و user agent برنمی‌گردند**؛ متن
 *    خام خطای همگام‌سازی هم برنمی‌گردد (فقط «خطا هست»).
 * ⚠️ **ویژگی قلم فقط از فهرست مجاز است، نه از هر متای عمومی** (بازبینی ریشه روی 2a4e62e).
 *    `get_formatted_meta_data()` همهٔ متای عددی/متنی قلم را برمی‌گرداند و پیشوند «_» تنها فیلتر آن است؛
 *    کلید عمومی افزونه‌ای مثل `integration_token` بی‌صدا «ویژگی» می‌شد. حالا فقط این کلیدها می‌آیند:
 *    کلید طبقه‌بندی ویژگی (`pa_…`، فضای نام خود ووکامرس، که برای کالای حذف‌شده هم می‌ماند)، و ویژگی سفارشی
 *    تنوعِ هنوز موجود یا — اگر فقط تنوع حذف شده — ویژگی‌های تنوع‌ساز کالای مادر. اگر مادر هم حذف شده باشد،
 *    ویژگی سفارشی منبع قابل‌اعتمادی ندارد و فهرست نمی‌شود؛ نام قلم خلاصهٔ مقدارهای خود ووکامرس را نگه می‌دارد.
 * ⚠️ پس از حذف تنوع، ووکامرس `get_variation_id()` را صفر و `get_product()` را **کالای مادر** برمی‌گرداند؛
 *    قلم سفارش هرگز خودِ کالای متغیر نیست، پس این حالت «کالا حذف شده» است، نه «موجود».
 */
if (!defined('ABSPATH')) { exit; }

class LMC_Orders_View
{
    const PROTOCOL       = 3;
    const PER_PAGE_MAX   = 50;
    const PAGE_MAX       = 100000;
    const ITEMS_PER_PAGE = 25;
    const NOTES_PER_PAGE = 20;
    const REFUNDS_MAX    = 50;
    const ATTRS_MAX      = 20;
    const TRACKING_MAX   = 20;
    const TRASH_LABEL    = 'زباله‌دان';
    const LIST_KEYS      = ['page', 'perPage', 'status', 'search', 'dateFrom', 'dateTo', 'paymentMethod', 'shippingMethod', 'until'];
    const DETAIL_KEYS    = ['orderId', 'itemsPage', 'notesPage'];

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
        $d = $request->get_json_params();
        $bad = new WP_Error('lmc_bad_orders_query', 'درخواست سفارش‌های سایت معتبر نیست.', ['status' => 400]);
        if (!is_array($d)) { return $bad; }
        if (array_key_exists('orderId', $d)) {
            if (array_diff(array_keys($d), self::DETAIL_KEYS) || !self::int_in($d['orderId'], 1, PHP_INT_MAX)
                || !self::int_in($d['itemsPage'] ?? 1, 1, 10000) || !self::int_in($d['notesPage'] ?? 1, 1, 10000)) {
                return $bad;
            }
            $order = wc_get_order($d['orderId']);
            if (!$order instanceof WC_Order || $order->get_type() !== 'shop_order') {
                return new WP_Error('lmc_order_not_found', 'سفارش پیدا نشد.', ['status' => 404]);
            }
            return new WP_REST_Response(self::envelope(['order' => self::detail($order, $d['itemsPage'] ?? 1, $d['notesPage'] ?? 1)]), 200);
        }
        if (array_diff(array_keys($d), self::LIST_KEYS)) { return $bad; }
        $q = [
            'page' => $d['page'] ?? 1, 'perPage' => $d['perPage'] ?? 20, 'status' => $d['status'] ?? null,
            'search' => $d['search'] ?? null, 'dateFrom' => $d['dateFrom'] ?? null, 'dateTo' => $d['dateTo'] ?? null,
            'paymentMethod' => $d['paymentMethod'] ?? null, 'shippingMethod' => $d['shippingMethod'] ?? null,
            'until' => $d['until'] ?? null,
        ];
        $statuses = self::filter_statuses();
        $shipping = self::shipping_methods();
        if (!self::int_in($q['page'], 1, self::PAGE_MAX) || !self::int_in($q['perPage'], 1, self::PER_PAGE_MAX)
            || ($q['status'] !== null && (!is_string($q['status']) || !isset($statuses[$q['status']])))
            || ($q['search'] !== null && (!is_string($q['search']) || self::clean_search($q['search']) === null))
            || ($q['dateFrom'] !== null && self::day($q['dateFrom'], false) === null)
            || ($q['dateTo'] !== null && self::day($q['dateTo'], true) === null)
            || ($q['dateFrom'] !== null && $q['dateTo'] !== null && $q['dateFrom'] > $q['dateTo'])
            || ($q['paymentMethod'] !== null && (!is_string($q['paymentMethod']) || !preg_match('/^[A-Za-z0-9_-]{1,100}$/', $q['paymentMethod'])))
            || ($q['shippingMethod'] !== null && (!is_string($q['shippingMethod']) || !isset($shipping[$q['shippingMethod']])))
            // لنگر ثانیهٔ جاری یا آینده نمی‌پذیرد: سفارش همان ثانیه هنوز می‌تواند ساخته شود.
            || ($q['until'] !== null && !self::int_in($q['until'], 1, time() - 1))) {
            return $bad;
        }
        return new WP_REST_Response(self::envelope(self::page($q, $statuses, $shipping)), 200);
    }

    /** هویت سایت و دامنه، تا Core پاسخ سایت دیگری را نپذیرد. */
    private static function envelope(array $body): array
    {
        return ['protocol' => self::PROTOCOL, 'siteUrl' => untrailingslashit(home_url()),
            'branchId' => (string) lmc_setting('branch_id'), 'warehouseId' => (string) lmc_setting('warehouse_id')] + $body;
    }

    /** وضعیت‌های ثبت‌شده در همین سایت، از جمله وضعیت‌های سفارشی افزونه‌ها؛ نامک بی پیشوند `wc-`. */
    public static function statuses(): array
    {
        $out = [];
        foreach ((array) wc_get_order_statuses() as $key => $label) {
            $slug = preg_replace('/^wc-/', '', (string) $key);
            if (preg_match('/^[a-z0-9_-]{1,40}$/', $slug)) { $out[$slug] = self::cut((string) $label, 100); }
        }
        return $out;
    }

    /** وضعیت‌های فیلتر: وضعیت‌های سایت به‌علاوهٔ زباله‌دان. «همه» زباله‌دان را ندارد، مثل پیشخوان ووکامرس. */
    public static function filter_statuses(): array
    {
        return self::statuses() + ['trash' => self::TRASH_LABEL];
    }

    /** روش‌های ارسال ثبت‌شده در سایت، با شناسهٔ نوع (`flat_rate`، `local_pickup`، …). */
    public static function shipping_methods(): array
    {
        $out = [];
        $methods = function_exists('WC') && WC()->shipping() ? WC()->shipping()->get_shipping_methods() : [];
        foreach ((array) $methods as $id => $method) {
            if (is_string($id) && preg_match('/^[A-Za-z0-9_-]{1,100}$/', $id)) {
                $title = method_exists($method, 'get_method_title') ? $method->get_method_title() : ($method->method_title ?? $id);
                $out[$id] = self::cut(self::text((string) $title), 100);
            }
        }
        return $out;
    }

    /**
     * شرط «این سفارش سطر ارسالی با این روش دارد»، آماده‌شده با `prepare` و فقط روی جدول اقلام سفارش (در HPOS و
     * legacy یکی است). `method_id` قدیمی (پیش از ووکامرس ۳٫۴) شکل `flat_rate:3` داشت و هم‌ارز است.
     */
    public static function shipping_predicate(string $order_id_column, string $method): string
    {
        global $wpdb;
        $items = $wpdb->prefix . 'woocommerce_order_items';
        $meta = $wpdb->prefix . 'woocommerce_order_itemmeta';
        return ' AND EXISTS (SELECT 1 FROM ' . $items . ' lmc_si INNER JOIN ' . $meta . ' lmc_sm ON lmc_sm.order_item_id = lmc_si.order_item_id'
            . ' WHERE lmc_si.order_id = ' . $order_id_column . " AND lmc_si.order_item_type = 'shipping' AND lmc_sm.meta_key = 'method_id'"
            . $wpdb->prepare(' AND (lmc_sm.meta_value = %s OR lmc_sm.meta_value LIKE %s))', $method, $wpdb->esc_like($method) . ':%');
    }

    private static function payment_methods(): array
    {
        $out = [];
        $gateways = function_exists('WC') && WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : [];
        foreach ((array) $gateways as $id => $gateway) {
            if (is_string($id) && preg_match('/^[A-Za-z0-9_-]{1,100}$/', $id)) {
                $out[] = ['id' => $id, 'title' => self::cut((string) $gateway->get_title(), 100)];
            }
        }
        return $out;
    }

    public static function page(array $q, array $statuses, array $shipping = []): array
    {
        // ثانیهٔ جاری بیرون است؛ سفارشی که هنوز در این ثانیه ساخته می‌شود صفحه‌ها را جابه‌جا نمی‌کند.
        $until = $q['until'] ?? (time() - 1);
        $from = $q['dateFrom'] !== null ? self::day($q['dateFrom'], false) : 1;
        $to = min($until, $q['dateTo'] !== null ? self::day($q['dateTo'], true) : $until);
        $base = ['page' => $q['page'], 'perPage' => $q['perPage'], 'until' => $until,
            'filters' => ['status' => $q['status'], 'search' => $q['search'] !== null, 'dateFrom' => $q['dateFrom'],
                'dateTo' => $q['dateTo'], 'paymentMethod' => $q['paymentMethod'], 'shippingMethod' => $q['shippingMethod'] ?? null],
            'statuses' => array_map(fn ($slug, $label) => ['slug' => $slug, 'label' => $label], array_keys($statuses), $statuses),
            'paymentMethods' => self::payment_methods(),
            'shippingMethods' => array_map(fn ($id, $title) => ['id' => $id, 'title' => $title], array_keys($shipping), $shipping)];
        $empty = $base + ['total' => 0, 'pages' => 0, 'orders' => []];
        if ($from > $to) { return $empty; }

        $args = ['type' => 'shop_order', 'limit' => $q['perPage'], 'paged' => $q['page'], 'paginate' => true,
            'orderby' => ['date' => 'DESC', 'ID' => 'DESC'], 'date_created' => $from . '...' . $to];
        if ($q['status'] !== null) { $args['status'] = [$q['status']]; }
        if ($q['paymentMethod'] !== null) { $args['payment_method'] = $q['paymentMethod']; }
        if ($q['search'] !== null) {
            $term = self::clean_search($q['search']);
            if (self::hpos()) {
                $args['s'] = $term;
            } else {
                // جست‌وجوی رسمی جدول پست؛ شناسه‌ها به همان پرسش صفحه‌بندی‌شده می‌روند.
                $ids = array_values(array_unique(array_map('intval', (array) wc_order_search($term))));
                if ($ids === []) { return $empty; }
                $args['post__in'] = $ids;
            }
        }
        $method = $q['shippingMethod'] ?? null;
        $hpos_clause = function ($clauses, $query) use ($method) {
            $clauses['where'] = ($clauses['where'] ?? '') . self::shipping_predicate($query->get_table_name('orders') . '.id', $method);
            return $clauses;
        };
        $post_where = function ($where, $query) use ($method) {
            global $wpdb;
            return in_array('shop_order', (array) $query->get('post_type'), true) ? $where . self::shipping_predicate($wpdb->posts . '.ID', $method) : $where;
        };
        if ($method !== null) {
            add_filter('woocommerce_orders_table_query_clauses', $hpos_clause, 10, 2);
            add_filter('posts_where', $post_where, 10, 2);
        }
        try {
            $result = wc_get_orders($args);
        } finally {
            // فقط همین پرسش؛ پرسش‌های دیگر همان درخواست شرط را نمی‌گیرند.
            if ($method !== null) {
                remove_filter('woocommerce_orders_table_query_clauses', $hpos_clause, 10);
                remove_filter('posts_where', $post_where, 10);
            }
        }
        $orders = [];
        foreach ((array) $result->orders as $order) {
            if ($order instanceof WC_Order && $order->get_type() === 'shop_order') { $orders[] = self::summary($order); }
        }
        return $base + ['total' => max(0, (int) $result->total), 'pages' => max(0, (int) $result->max_num_pages), 'orders' => $orders];
    }

    public static function summary(WC_Order $order): array
    {
        $status = (string) $order->get_status();
        $count = 0;
        foreach ($order->get_items() as $item) {
            if ($item instanceof WC_Order_Item_Product) { $count += max(0, (int) $item->get_quantity()); }
        }
        $number = (string) $order->get_meta(LMC_Order_Sync::META_NUMBER);
        $slug = preg_match('/^[a-z0-9_-]{1,40}$/', $status) ? $status : 'unknown';
        return [
            'id' => (int) $order->get_id(),
            'number' => self::cut((string) $order->get_order_number(), 40),
            'status' => $slug,
            'statusLabel' => self::cut($status === 'trash' ? self::TRASH_LABEL : (string) wc_get_order_status_name($status), 100),
            'createdAt' => self::iso($order->get_date_created()),
            'currency' => self::currency($order),
            'total' => self::dec($order->get_total()),
            'itemCount' => $count,
            'customerName' => self::cut(trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()), 100),
            'customerType' => (int) $order->get_customer_id() > 0 ? 'registered' : 'guest',
            'paymentMethodId' => self::cut((string) $order->get_payment_method(), 100),
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

    public static function detail(WC_Order $order, int $items_page, int $notes_page): array
    {
        $all = [];
        $missing_sku = 0; $missing_map = 0;
        foreach ($order->get_items() as $item) {
            if (!$item instanceof WC_Order_Item_Product) { continue; }
            $product = $item->get_product();
            // مادرِ متغیر یعنی تنوع حذف شده؛ SKU و نگاشت مال تنوع‌اند، نه مادر.
            $live = $product && !(method_exists($product, 'is_type') && $product->is_type('variable')) ? $product : null;
            $sku = $live ? (string) $live->get_sku() : '';
            $mapped = $live ? (string) $live->get_meta('_lmc_variation_id') !== '' : false;
            if ($sku === '') { $missing_sku++; }
            if (!$mapped) { $missing_map++; }
            $all[] = [$item, $product, $live, $sku, $mapped];
        }
        $rows = [];
        foreach (array_slice($all, ($items_page - 1) * self::ITEMS_PER_PAGE, self::ITEMS_PER_PAGE) as [$item, $product, $live, $sku, $mapped]) {
            $rows[] = [
                'id' => (int) $item->get_id(), 'name' => self::cut((string) $item->get_name(), 200),
                'sku' => self::cut($sku, 64), 'quantity' => max(0, (int) $item->get_quantity()), 'attributes' => self::attributes($item, $product),
                'subtotal' => self::dec($item->get_subtotal()), 'subtotalTax' => self::dec($item->get_subtotal_tax()),
                'total' => self::dec($item->get_total()), 'tax' => self::dec($item->get_total_tax()),
                'productExists' => (bool) $live, 'mapped' => $mapped,
            ];
        }
        $refunds = [];
        foreach (array_slice((array) $order->get_refunds(), 0, self::REFUNDS_MAX) as $refund) {
            $refunds[] = ['id' => (int) $refund->get_id(), 'createdAt' => self::iso($refund->get_date_created()),
                'amount' => self::dec($refund->get_amount()), 'reason' => self::cut(self::text((string) $refund->get_reason()), 500)];
        }
        $note_rows = function_exists('wc_get_order_notes') ? (array) wc_get_order_notes([
            'order_id' => $order->get_id(), 'limit' => self::NOTES_PER_PAGE + 1,
            'offset' => ($notes_page - 1) * self::NOTES_PER_PAGE, 'orderby' => 'date_created', 'order' => 'DESC',
        ]) : [];
        $notes = [];
        foreach (array_slice($note_rows, 0, self::NOTES_PER_PAGE) as $note) {
            $notes[] = ['id' => (int) $note->id, 'createdAt' => self::iso($note->date_created ?? null),
                'content' => self::cut(self::text((string) $note->content), 1000), 'customerNote' => (bool) $note->customer_note,
                'addedBy' => self::cut((string) ($note->added_by ?? ''), 100)];
        }
        $summary = self::summary($order);
        $summary['core'] += [
            // وضعیت صف همان کار، شامل تصمیم معوق ماندگار و ثبت مرده؛ `queued()` نشان معوق را نمی‌دید (بازبینی ریشه روی 4b0046a).
            'queue' => self::queue_state((int) $order->get_id()),
            'missingSku' => $missing_sku, 'missingMapping' => $missing_map,
        ];
        return $summary + [
            'billing' => self::address($order->get_address('billing'), true),
            'shipping' => self::address($order->get_address('shipping'), false),
            'customerNote' => self::cut(self::text((string) $order->get_customer_note()), 1000),
            'completedAt' => self::iso($order->get_date_completed()),
            'modifiedAt' => self::iso($order->get_date_modified()),
            'tracking' => self::tracking($order),
            'payment' => [
                'methodId' => self::cut((string) $order->get_payment_method(), 100),
                'method' => self::cut((string) $order->get_payment_method_title(), 100),
                'transactionId' => self::cut((string) $order->get_transaction_id(), 100),
                'paidAt' => self::iso($order->get_date_paid()),
            ],
            'totals' => [
                'subtotal' => self::dec($order->get_subtotal()), 'discount' => self::dec($order->get_discount_total()),
                'discountTax' => self::dec($order->get_discount_tax()), 'shipping' => self::dec($order->get_shipping_total()),
                'shippingTax' => self::dec($order->get_shipping_tax()), 'tax' => self::dec($order->get_total_tax()),
                'total' => self::dec($order->get_total()), 'refunded' => self::dec($order->get_total_refunded()),
            ],
            'items' => ['page' => $items_page, 'perPage' => self::ITEMS_PER_PAGE, 'total' => count($all), 'rows' => $rows],
            'fees' => array_values(array_map(fn ($f) => ['name' => self::cut((string) $f->get_name(), 200),
                'total' => self::dec($f->get_total()), 'tax' => self::dec($f->get_total_tax())], (array) $order->get_fees())),
            'shippingLines' => array_values(array_map(fn ($s) => ['method' => self::cut((string) $s->get_name(), 200),
                'total' => self::dec($s->get_total()), 'tax' => self::dec($s->get_total_tax())], (array) $order->get_shipping_methods())),
            'coupons' => array_values(array_map(fn ($c) => ['code' => self::cut((string) $c->get_code(), 100),
                'discount' => self::dec($c->get_discount()), 'discountTax' => self::dec($c->get_discount_tax())], (array) $order->get_items('coupon'))),
            'refunds' => $refunds, 'refundsTruncated' => count((array) $order->get_refunds()) > self::REFUNDS_MAX,
            'notes' => ['page' => $notes_page, 'perPage' => self::NOTES_PER_PAGE, 'hasMore' => count($note_rows) > self::NOTES_PER_PAGE, 'rows' => $notes],
        ];
    }

    /** فقط خواندن؛ بی LMC_Queue (نصب ناقص) فقط WP-Cron دیده می‌شود و بقیه «نمی‌دانم» است، نه «نیست». */
    private static function queue_state(int $order_id): array
    {
        if (class_exists('LMC_Queue') && method_exists('LMC_Queue', 'state')) {
            return LMC_Queue::state(LMC_ORDER_EVENT, [$order_id]);
        }
        return ['scheduler' => 'wp-cron', 'state' => wp_next_scheduled(LMC_ORDER_EVENT, [$order_id]) ? 'scheduled' : 'unknown',
            'deferred' => null, 'dead' => null];
    }

    /**
     * ویژگی‌های تنوعِ قلم — فقط کلیدهای مجاز (بالای پرونده). نمایش (برچسب و نام term) از خود ووکامرس است؛
     * include_all چون ووکامرس ویژگیِ آمده در نام قلم را پنهان می‌کند.
     */
    private static function attributes($item, $product): array
    {
        $allowed = [];
        if ($product && method_exists($product, 'is_type') && $product->is_type('variation')) {
            foreach (array_keys((array) $product->get_variation_attributes()) as $key) {
                $allowed[self::attr_key((string) $key)] = true;
            }
        } elseif ($product && method_exists($product, 'is_type') && $product->is_type('variable')) {
            // فقط تنوع حذف شده: ویژگی‌های تنوع‌ساز مادر همان کلیدهای قلم‌اند.
            foreach ((array) $product->get_attributes() as $key => $attr) {
                if (is_object($attr) && method_exists($attr, 'get_variation') && $attr->get_variation()) { $allowed[self::attr_key((string) $key)] = true; }
            }
        }
        $out = [];
        foreach ((array) $item->get_formatted_meta_data('_', true) as $meta) {
            $key = self::attr_key((string) ($meta->key ?? ''));
            if (!isset($allowed[$key]) && !preg_match('/^pa_[a-z0-9_-]{1,29}$/', $key)) { continue; }
            $out[] = ['key' => self::cut(self::text((string) ($meta->display_key ?? '')), 100), 'value' => self::cut(self::text((string) ($meta->display_value ?? '')), 200)];
            if (count($out) >= self::ATTRS_MAX) { break; }
        }
        return $out;
    }

    /**
     * کلید ویژگی به همان شکلی که ووکامرس مقایسه می‌کند: بی `attribute_` و با `sanitize_title`. تنوع نام فارسی را
     * رمزشده (`%d8%b1…`) نگه می‌دارد و متای قلم گاهی خام (`رنگ`)؛ مقایسهٔ خام این دو را دو کلید می‌دید.
     */
    private static function attr_key(string $key): string
    {
        $key = rawurldecode(preg_replace('/^attribute_/', '', $key) ?? '');
        return function_exists('sanitize_title') ? sanitize_title($key) : strtolower($key);
    }

    /**
     * کد رهگیری افزونهٔ رسمی «WooCommerce Shipment Tracking» (`_wc_shipment_tracking_items`). شکل‌های دیگر شناخته
     * نمی‌شوند و فهرست خالی یعنی «این منبع رهگیری‌ای ندارد»، نه «ارسال نشده». پیوند فقط HTTPS.
     */
    private static function tracking(WC_Order $order): array
    {
        $raw = $order->get_meta('_wc_shipment_tracking_items');
        $out = [];
        foreach (is_array($raw) ? array_slice($raw, 0, self::TRACKING_MAX) : [] as $t) {
            if (!is_array($t)) { continue; }
            $number = self::cut(self::text((string) ($t['tracking_number'] ?? '')), 100);
            if ($number === '') { continue; }
            $provider = (string) ($t['custom_tracking_provider'] ?? '') !== '' ? $t['custom_tracking_provider'] : ($t['tracking_provider'] ?? '');
            $url = (string) ($t['custom_tracking_link'] ?? '');
            $shipped = $t['date_shipped'] ?? null;
            $out[] = ['provider' => self::cut(self::text((string) $provider), 100), 'number' => $number,
                'shippedAt' => is_numeric($shipped) && (int) $shipped > 0 ? gmdate('Y-m-d\TH:i:s\Z', (int) $shipped) : null,
                'url' => preg_match('#^https://[^\s"<>]{1,490}$#', $url) ? $url : ''];
        }
        return $out;
    }

    private static function address($a, bool $with_email): array
    {
        $a = is_array($a) ? $a : [];
        $out = [];
        foreach (['first_name' => 'firstName', 'last_name' => 'lastName', 'company' => 'company', 'address_1' => 'address1',
                  'address_2' => 'address2', 'city' => 'city', 'state' => 'state', 'postcode' => 'postcode',
                  'country' => 'country', 'phone' => 'phone'] as $k => $name) {
            $out[$name] = self::cut((string) ($a[$k] ?? ''), 200);
        }
        if ($with_email) { $out['email'] = self::cut((string) ($a['email'] ?? ''), 200); }
        return $out;
    }

    private static function hpos(): bool
    {
        return class_exists(\Automattic\WooCommerce\Utilities\OrderUtil::class)
            && \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
    }

    /** کد ارز خود سفارش؛ کدی که سه یا چهار حرف بزرگ نباشد «» می‌شود و Core آن را بی‌تبدیل نشان می‌دهد. */
    private static function currency(WC_Order $order): string
    {
        $c = (string) $order->get_currency();
        return preg_match('/^[A-Z]{3,4}$/', $c) ? $c : '';
    }

    /** مبلغ ذخیره‌شده، رشتهٔ اعشاری دقیق؛ هرچه عدد نیست `null` (نه صفر). */
    private static function dec($value): ?string
    {
        if ($value === null || $value === '') { return null; }
        $s = is_float($value) ? (function_exists('wc_float_to_string') ? wc_float_to_string($value) : (string) $value) : trim((string) $value);
        return preg_match('/^-?\d{1,18}(?:\.\d{1,8})?$/', $s) ? $s : null;
    }

    private static function iso($date): ?string
    {
        return $date && method_exists($date, 'getTimestamp') ? gmdate('Y-m-d\TH:i:s\Z', $date->getTimestamp()) : null;
    }

    /** روز تقویمی سایت → مهر زمانی آغاز یا پایانش؛ تاریخ ناممکن `null`. */
    private static function day($value, bool $end): ?int
    {
        if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            return null;
        }
        $tz = function_exists('wp_timezone') ? wp_timezone() : new DateTimeZone('UTC');
        $d = new DateTimeImmutable($value . ' 00:00:00', $tz);
        return $end ? $d->modify('+1 day')->getTimestamp() - 1 : $d->getTimestamp();
    }

    private static function clean_search($value): ?string
    {
        $t = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', (string) $value) ?? '');
        $len = function_exists('mb_strlen') ? mb_strlen($t) : strlen($t);
        return $len >= 1 && $len <= 100 ? $t : null;
    }

    private static function int_in($v, int $min, int $max): bool
    {
        return is_int($v) && $v >= $min && $v <= $max;
    }

    /** متن نمایشی: بی HTML و بی نویسهٔ کنترلی. */
    private static function text(string $html): string
    {
        $plain = function_exists('wp_strip_all_tags') ? wp_strip_all_tags($html) : strip_tags($html);
        return html_entity_decode($plain, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    private static function cut(string $text, int $max): string
    {
        // نویسهٔ کنترلی به Core نمی‌رود؛ طول بر حسب نویسه، نه بایت (نام فارسی).
        $clean = preg_replace('/[\x00-\x1F\x7F]/u', '', $text);
        $clean = is_string($clean) ? $clean : '';
        return function_exists('mb_substr') ? mb_substr($clean, 0, $max) : substr($clean, 0, $max);
    }
}
