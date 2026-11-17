<?php
/**
 * نگه‌داشت موجودی در Core **پیش از** رفتن مشتری به درگاه — مهاجرت ۱۲۵ Core.
 *
 * ── چرا ──────────────────────────────────────────────────────────────
 *
 * بیشتر کالاهای فروشگاه از هر سایز یک عدد دارند. سفارش پیش‌پرداخت تا پس از پرداخت به
 * Core نمی‌رسید و مشتری چند دقیقه در صفحهٔ بانک بود؛ در این فاصله صندوق همان تک‌قلم را
 * می‌فروخت و پرداخت آنلاین موفق می‌شد بی‌آنکه کالایی مانده باشد. Push موجودی هر چقدر هم
 * سریع باشد این پنجره را نمی‌بندد. حالا لحظهٔ ساخت سفارش (و در «پرداخت دوباره») Core
 * قلم را نگه می‌دارد؛ اگر نتواند، مشتری **پیش از** پرداخت پیام روشن می‌گیرد.
 *
 * ── رفتار ───────────────────────────────────────────────────────────
 *
 * - held / reserved / consumed: پرداخت ادامه می‌یابد.
 * - unavailable: پرداخت شروع نمی‌شود و نام کالا گفته می‌شود.
 * - Core در دسترس نیست یا هنوز به‌روز نشده: پرداخت ادامه می‌یابد (یادداشت روی سفارش). فروش
 *   آنلاین به سلامت سرور فروشگاه گره نمی‌خورد؛ همان مسیر پیشین (کنترل موجودی هنگام ثبت
 *   سفارش در Core) پشتوانه است.
 * - لغو سفارش نگه‌داشت را آزاد می‌کند؛ پرداخت ناموفق نه (مشتری معمولاً دوباره می‌پردازد)
 *   — مهلت Core (`web.checkout_hold_minutes`) آن را آزاد می‌کند.
 *
 * ⚠️ عدد موجودی سایت با نگه‌داشت عوض نمی‌شود (Core آن را از عدد سایت کم نمی‌کند)؛ پس
 *    ووکامرس خودِ همین مشتری را در «پرداخت دوباره» به‌خاطر نگه‌داشت خودش رد نمی‌کند.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Checkout_Hold
{
    const META_STATE   = '_lmc_checkout_hold';
    const META_EXPIRES = '_lmc_checkout_hold_expires';
    /** مشتری منتظر پاسخ است؛ Core سالم در چند ده میلی‌ثانیه پاسخ می‌دهد. */
    const TIMEOUT = 5;

    public static function init(): void
    {
        // پیش از هر کار دیگری روی سفارش تازه (رزرو پرداخت در محل در اولویت ۱۰ است).
        add_action('woocommerce_checkout_order_processed', [__CLASS__, 'classic'], 5, 3);
        add_action('woocommerce_store_api_checkout_order_processed', [__CLASS__, 'blocks'], 5, 1);
        add_action('woocommerce_before_pay_action', [__CLASS__, 'pay'], 5, 1);
        add_action('woocommerce_order_status_changed', [__CLASS__, 'status_changed'], 20, 3);
    }

    /** پرداخت کلاسیک: استثنا را ووکامرس به پیام خطای صفحهٔ پرداخت تبدیل می‌کند. */
    public static function classic($order_id, $posted = null, $order = null): void
    {
        $order = $order instanceof WC_Order ? $order : wc_get_order((int) $order_id);
        $message = $order ? self::hold($order) : null;
        if ($message !== null) {
            throw new Exception($message);
        }
    }

    /** پرداخت بلوکی (Store API). */
    public static function blocks($order): void
    {
        $message = $order instanceof WC_Order ? self::hold($order) : null;
        if ($message === null) {
            return;
        }
        $route = '\\Automattic\\WooCommerce\\StoreApi\\Exceptions\\RouteException';
        if (class_exists($route)) {
            throw new $route('lmc_stock_unavailable', $message, 409);
        }
        throw new Exception($message);
    }

    /** «پرداخت دوباره» (صفحهٔ order-pay): خطا پیش از فراخوانی درگاه پرداخت را متوقف می‌کند. */
    public static function pay($order): void
    {
        $message = $order instanceof WC_Order ? self::hold($order) : null;
        if ($message !== null) {
            wc_add_notice($message, 'error');
        }
    }

    /**
     * @return string|null پیام خطا برای مشتری، یا null یعنی پرداخت ادامه یابد.
     */
    public static function hold(WC_Order $order): ?string
    {
        $branch = (string) lmc_setting('branch_id');
        $warehouse = (string) lmc_setting('warehouse_id');
        if ($branch === '' || $warehouse === '') {
            return null;   // اتصال هنوز پیکربندی نشده؛ رفتار پیشین.
        }
        $lines = [];
        $names = [];
        foreach ($order->get_items() as $item) {
            if (!$item instanceof WC_Order_Item_Product) {
                continue;
            }
            $product = $item->get_product();
            $sku = $product ? trim((string) $product->get_sku()) : '';
            $qty = (string) $item->get_quantity();
            if ($sku === '' || !preg_match('/^[0-9]+(?:\.[0-9]{1,3})?$/D', $qty) || (float) $qty <= 0) {
                // بی SKU، Core این کالا را نمی‌شناسد؛ نگه‌داشت ناقص بدتر از هیچ است.
                self::note($order, 'skipped', 'نگه‌داشت موجودی انجام نشد: یکی از اقلام SKU یا تعداد معتبر ندارد.');
                return null;
            }
            $lines[] = ['sku' => $sku, 'qty' => $qty];
            $names[$sku] = (string) $item->get_name();
        }
        if (!$lines || count($lines) > 200) {
            return null;
        }

        $result = LMC_Client::post('/web/checkout-holds', [
            'branchId' => $branch, 'warehouseId' => $warehouse,
            'externalId' => (string) $order->get_id(), 'lines' => $lines,
        ], self::TIMEOUT);

        if (is_wp_error($result)) {
            self::note($order, 'failed', 'نگه‌داشت موجودی پیش از پرداخت ممکن نشد ('
                . $result->get_error_message() . ')؛ پرداخت بدون تضمین موجودی ادامه یافت.');
            return null;
        }
        $status = (string) ($result['status'] ?? '');
        if ($status === 'held') {
            $order->update_meta_data(self::META_STATE, 'held');
            $order->update_meta_data(self::META_EXPIRES, (string) ($result['expiresAt'] ?? ''));
            $order->save();
            return null;
        }
        if ($status === 'reserved' || $status === 'consumed') {
            return null;
        }
        if ($status !== 'unavailable') {
            self::note($order, 'failed', 'پاسخ نگه‌داشت موجودی معتبر نبود؛ پرداخت بدون تضمین موجودی ادامه یافت.');
            return null;
        }

        $sold = [];
        $paying = [];
        foreach ((array) ($result['unavailable'] ?? []) as $row) {
            $sku = is_array($row) ? (string) ($row['sku'] ?? '') : '';
            $name = $names[$sku] ?? $sku;
            if (is_array($row) && ($row['heldByCheckout'] ?? false) === true) {
                $paying[] = $name;
            } else {
                $sold[] = $name;
            }
        }
        $parts = [];
        if ($sold) {
            $parts[] = sprintf('«%s» همین حالا فروخته شد و دیگر موجود نیست.', implode('»، «', $sold));
        }
        if ($paying) {
            $parts[] = sprintf('«%s» در حال پرداخت توسط مشتری دیگری است؛ اگر آن پرداخت تا چند دقیقهٔ دیگر کامل نشود، دوباره موجود می‌شود.',
                implode('»، «', $paying));
        }
        $message = 'متأسفیم، ' . ($parts ? implode(' ', $parts) : 'موجودی برخی اقلام کافی نیست.')
            . ' لطفاً سبد خرید را اصلاح کنید؛ مبلغی از حساب شما برداشت نشده است.';
        self::note($order, 'unavailable', 'پرداخت متوقف شد: ' . $message);
        return $message;
    }

    /** لغو سفارش پیش‌پرداخت، نگه‌داشتش را همان لحظه آزاد می‌کند. */
    public static function status_changed($order_id, $from = '', $to = ''): void
    {
        if ($to !== 'cancelled') {
            return;
        }
        $order = wc_get_order((int) $order_id);
        // سفارش پرداخت در محل را رزرو خودش (LMC_Order_Reservation) آزاد می‌کند.
        if (!$order || $order->get_meta(self::META_STATE) !== 'held'
            || is_array($order->get_meta(LMC_Order_Reservation::PAYLOAD))) {
            return;
        }
        $result = LMC_Client::post('/web/order-reservations/release', [
            'branchId' => (string) lmc_setting('branch_id'), 'warehouseId' => (string) lmc_setting('warehouse_id'),
            'externalId' => (string) $order->get_id(),
        ], self::TIMEOUT);
        if (is_wp_error($result)) {
            // مهلت Core آزادش می‌کند؛ اینجا فقط زودتر بود.
            self::note($order, 'held', 'آزادکردن نگه‌داشت موجودی ممکن نشد؛ با پایان مهلت خودبه‌خود آزاد می‌شود.');
            return;
        }
        self::note($order, 'released', 'نگه‌داشت موجودی با لغو سفارش آزاد شد.');
    }

    private static function note(WC_Order $order, string $state, string $text): void
    {
        $order->update_meta_data(self::META_STATE, $state);
        $order->add_order_note('لیبل مد — ' . $text);
        $order->save();
    }
}
