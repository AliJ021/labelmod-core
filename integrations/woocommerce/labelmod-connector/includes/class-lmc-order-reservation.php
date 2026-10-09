<?php
/** رزرو سفارش پرداخت در محل؛ هیچ پرداخت یا خروج فیزیکی انبار ثبت نمی‌کند. */
if (!defined('ABSPATH')) { exit; }

class LMC_Order_Reservation
{
    const EVENT = 'lmc_reserve_order';
    const PAYLOAD = '_lmc_reservation_payload';
    const STATE = '_lmc_reservation_state';
    const ACTION = '_lmc_reservation_action';
    const ATTEMPTS = '_lmc_reservation_attempts';
    const ERROR = '_lmc_reservation_error';

    public static function init(): void
    {
        add_action('woocommerce_order_status_changed', [__CLASS__, 'changed']);
        add_action('woocommerce_checkout_order_processed', [__CLASS__, 'changed']);
        add_action(self::EVENT, [__CLASS__, 'send']);
    }

    private static function action(WC_Order $order): string
    {
        // تغییر درگاه پس از رزرو نباید رزرو را بی‌صاحب کند.
        if ($order->get_payment_method() !== 'cod' && !is_array($order->get_meta(self::PAYLOAD))) { return ''; }
        if ($order->has_status(['cancelled', 'failed'])) { return 'release'; }
        if ($order->has_status(['processing', 'completed'])) { return 'reserve'; }
        return '';
    }

    public static function changed($id): void
    {
        $order = wc_get_order((int) $id);
        if (!$order || $order->get_meta(LMC_Order_Sync::META_INVOICE) !== '') { return; }
        $action = self::action($order);
        if ($action === '') { return; }
        if ($order->get_meta(self::ACTION) !== $action) {
            $order->update_meta_data(self::ACTION, $action);
            $order->update_meta_data(self::ATTEMPTS, 0);
            $order->delete_meta_data(self::ERROR);
            $order->save();
        }
        if ($order->get_meta(self::ERROR) !== '' || (int) $order->get_meta(self::ATTEMPTS) >= LMC_Order_Sync::MAX_ATTEMPTS) { return; }
        // هویت انبار و اقلام پیش از اجرای ناهم‌زمان ثابت می‌شود.
        $payload = self::snapshot($order, $action);
        if (is_wp_error($payload)) { self::fail($order, $payload); return; }
        self::schedule($order->get_id(), 10);
    }

    private static function schedule(int $id, int $delay): void
    {
        if (!wp_next_scheduled(self::EVENT, [$id])) {
            wp_schedule_single_event(time() + $delay, self::EVENT, [$id]);
        }
    }

    public static function snapshot(WC_Order $order, string $action)
    {
        $saved = $order->get_meta(self::PAYLOAD);
        if (is_array($saved)) { return $saved; }
        $payload = ['branchId' => (string) lmc_setting('branch_id'),
            'warehouseId' => (string) lmc_setting('warehouse_id'), 'externalId' => (string) $order->get_id(), 'lines' => []];
        if ($payload['branchId'] === '' || $payload['warehouseId'] === '') {
            return new WP_Error('lmc_reservation_scope', 'برای رزرو سفارش، شعبه و انبار اتصال را انتخاب کنید.');
        }
        if ($action !== 'release') {
            foreach ($order->get_items() as $item) {
                if (!$item instanceof WC_Order_Item_Product) { continue; }
                $qty = (string) $item->get_quantity();
                $product = $item->get_product();
                $sku = $product ? trim((string) $product->get_sku()) : '';
                if ($sku === '' || !preg_match('/^[0-9]+(?:\.[0-9]{1,3})?$/D', $qty) || (float) $qty <= 0) {
                    return new WP_Error('lmc_reservation_line', 'رزرو ممکن نشد؛ SKU و تعداد اقلام سفارش را بررسی کنید.');
                }
                $payload['lines'][] = ['sku' => $sku, 'qty' => $qty];
            }
            if (!$payload['lines'] || count($payload['lines']) > 200) {
                return new WP_Error('lmc_reservation_lines', 'رزرو باید بین ۱ تا ۲۰۰ قلم داشته باشد.');
            }
        }
        $order->update_meta_data(self::PAYLOAD, $payload);
        $order->save();
        return $payload;
    }

    public static function send($id): void
    {
        $order = wc_get_order((int) $id);
        if (!$order || $order->get_meta(LMC_Order_Sync::META_INVOICE) !== '') { return; }
        $action = self::action($order);
        if ($action === '') { return; }
        $payload = self::snapshot($order, $action);
        if (is_wp_error($payload)) { self::fail($order, $payload); return; }
        $connection = LMC_Client::get('/web/connection', ['branchId' => $payload['branchId'], 'warehouseId' => $payload['warehouseId']]);
        if (is_wp_error($connection)) { self::fail($order, $connection); return; }
        if (($connection['protocol'] ?? null) !== 1 || ($connection['authenticated'] ?? false) !== true
            || ($connection['branchId'] ?? '') !== $payload['branchId'] || ($connection['warehouseId'] ?? '') !== $payload['warehouseId']
            || ($connection['features']['codReservations'] ?? false) !== true) {
            self::fail($order, new WP_Error('lmc_reservation_upgrade', 'Core هنوز رزرو پرداخت در محل را پشتیبانی نمی‌کند؛ ابتدا سامانه را به‌روز کنید.'));
            return;
        }
        if ($action === 'release') { unset($payload['lines']); }
        $result = LMC_Client::post('/web/order-reservations' . ($action === 'release' ? '/release' : ''), $payload);
        if (is_wp_error($result)) { self::fail($order, $result); return; }
        $state = $result['status'] ?? '';
        if (!in_array($state, ['reserved', 'released', 'consumed'], true)) {
            self::fail($order, new WP_Error('lmc_reservation_response', 'پاسخ رزرو معتبر نیست؛ تطبیق دستی سفارش لازم است.'));
            return;
        }
        if ($order->get_meta(self::STATE) !== $state) {
            $labels = ['reserved' => 'موجودی قابل فروش رزرو شد؛ وجه و خروج کالا ثبت نشده است.',
                'released' => 'رزرو سفارش آزاد شد؛ ثبت دوباره این شناسه نیازمند بررسی است.',
                'consumed' => 'رزرو با نهایی‌سازی فاکتور مصرف شده است.'];
            $order->add_order_note('لیبل مد: ' . $labels[$state]);
        }
        $order->update_meta_data(self::STATE, $state);
        $order->delete_meta_data(self::ERROR);
        $order->save();
    }

    private static function fail(WC_Order $order, WP_Error $error): void
    {
        $attempt = (int) $order->get_meta(self::ATTEMPTS) + 1;
        $order->update_meta_data(self::ATTEMPTS, $attempt);
        $order->update_meta_data(self::ERROR, $error->get_error_message());
        $retry = LMC_Client::is_retryable($error) && $attempt < LMC_Order_Sync::MAX_ATTEMPTS;
        if ($retry) { self::schedule($order->get_id(), MINUTE_IN_SECONDS * (2 ** ($attempt - 1))); }
        $order->add_order_note('لیبل مد — رزرو: ' . $error->get_error_message()
            . ($retry ? '؛ تلاش دوباره زمان‌بندی شد.' : '؛ متوقف شد، بررسی و ارسال دوباره لازم است.'));
        $order->save();
    }

    public static function retry(WC_Order $order): void
    {
        if (self::action($order) === '') { return; }
        $order->update_meta_data(self::ATTEMPTS, 0);
        $order->delete_meta_data(self::ERROR);
        $order->save();
        self::changed($order->get_id());
    }
}
