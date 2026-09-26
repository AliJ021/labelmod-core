<?php
/** Mirrors completed WooCommerce refund documents; never initiates a gateway refund. */
if (!defined('ABSPATH')) { exit; }

class LMC_Refund_Sync
{
    const EVENT = 'lmc_send_refund';
    const DONE = '_lmc_return_id';
    const ERROR = '_lmc_refund_error';
    const ATTEMPTS = '_lmc_refund_attempts';
    const PAYLOAD = '_lmc_refund_payload';
    const REQUEST = '_lmc_refund_request_id';
    const STATUS = '_lmc_refund_review_status';

    public static function init(): void
    {
        add_action('woocommerce_refund_created', [__CLASS__, 'created'], 10, 2);
        add_action(self::EVENT, [__CLASS__, 'send']);
        add_filter('woocommerce_order_actions', function ($actions) {
            $actions['lmc_retry_refunds'] = 'ارسال دوباره مرجوعی‌ها به لیبل مد';
            return $actions;
        });
        add_action('woocommerce_order_action_lmc_retry_refunds', [__CLASS__, 'retry_order']);
    }

    public static function created($refund_id, $args): void
    {
        $refund = wc_get_order((int) $refund_id);
        if (!$refund instanceof WC_Order_Refund) { return; }
        // Woo's event arguments are the authoritative restock decision.
        $refund->update_meta_data('_lmc_restock', !empty($args['restock_items']) ? 'yes' : 'no');
        $order = wc_get_order($refund->get_parent_id());
        if (!$order) { return; }
        $payload = self::build_payload($order, $refund);
        if (is_wp_error($payload)) {
            $refund->update_meta_data(self::ERROR, $payload->get_error_message());
            $order->add_order_note('مرجوعی در لیبل مد ثبت نشد: ' . $payload->get_error_message());
        } else {
            // Freeze the event so later product/order edits cannot change a retry.
            $refund->update_meta_data(self::PAYLOAD, $payload);
            self::schedule((int) $refund_id, 15);
        }
        $refund->save();
    }

    private static function schedule(int $id, int $delay): void
    {
        if (!wp_next_scheduled(self::EVENT, [$id])) {
            wp_schedule_single_event(time() + $delay, self::EVENT, [$id]);
        }
    }

    public static function build_payload($order, $refund)
    {
        $snapshot = LMC_Order_Sync::snapshot($order);
        if (is_wp_error($snapshot)) { return $snapshot; }
        $map = $order->get_meta(LMC_Order_Sync::META_LINES);
        $lines = [];
        foreach ($refund->get_items() as $item) {
            if (!$item instanceof WC_Order_Item_Product) { continue; }
            $original = (int) $item->get_meta('_refunded_item_id');
            $qty = abs((float) $item->get_quantity());
            if ($qty <= 0) { continue; }
            if (!isset($map[$original])) {
                return new WP_Error('lmc_refund_line_missing', 'قلم اصلی مرجوعی یافت نشد؛ بررسی دستی لازم است.');
            }
            $lines[] = ['lineNo' => $map[$original], 'qty' => (string) $qty,
                'restock' => $refund->get_meta('_lmc_restock') === 'yes'];
        }
        if (!$lines) {
            return new WP_Error('lmc_refund_without_items', 'مرجوعی صرفاً مبلغی بدون تعداد کالا خودکار منتقل نمی‌شود؛ سند اصلاحی حسابداری لازم است.');
        }
        return [
            'orderId' => (string) $order->get_id(),
            'refundId' => (string) $refund->get_id(),
            'amount' => (string) LMC_Order_Sync::to_rial($refund->get_amount()),
            'shippingAmount' => (string) abs(LMC_Order_Sync::to_rial($refund->get_shipping_total())),
            'lines' => $lines,
        ];
    }

    public static function send($id): void
    {
        $refund = wc_get_order((int) $id);
        if (!$refund instanceof WC_Order_Refund || $refund->get_meta(self::DONE) !== '' || $refund->get_meta(self::STATUS) === 'rejected') { return; }
        $order = wc_get_order($refund->get_parent_id());
        if (!$order) { return; }
        $payload = $refund->get_meta(self::PAYLOAD);
        if (!is_array($payload)) { return; } // Never guess the original restock flag.
        $attempt = (int) $refund->get_meta(self::ATTEMPTS) + 1;
        if ($attempt > LMC_Order_Sync::MAX_ATTEMPTS) { return; }
        $refund->update_meta_data(self::ATTEMPTS, $attempt);
        // The original order may still be queued. Do not create an unrelated return.
        $result = $order->get_meta(LMC_Order_Sync::META_INVOICE) === ''
            ? new WP_Error('lmc_order_pending', 'سفارش اصلی هنوز به حسابداری نرسیده است.')
            : LMC_Client::post('/web/refunds', $payload);
        if (is_wp_error($result)) {
            $refund->update_meta_data(self::ERROR, $result->get_error_message());
            $retryable = $result->get_error_code() === 'lmc_order_pending' || LMC_Client::is_retryable($result);
            if ($retryable && $attempt < LMC_Order_Sync::MAX_ATTEMPTS) {
                self::schedule((int) $id, min(3600, 60 * (2 ** $attempt)));
            }
            $order->add_order_note('ارسال مرجوعی به لیبل مد ناموفق: ' . $result->get_error_message());
        } elseif (!empty($result['requestId']) && in_array($result['status'] ?? '', ['pending', 'rejected'], true)) {
            $previous = $refund->get_meta(self::STATUS);
            $refund->update_meta_data(self::REQUEST, (string) $result['requestId']);
            $refund->update_meta_data(self::STATUS, $result['status']);
            $refund->delete_meta_data(self::ERROR);
            if ($result['status'] === 'pending') {
                // انتظار تصمیم انسانی خطای انتقال نیست و سقف retry را مصرف نمی‌کند.
                $refund->update_meta_data(self::ATTEMPTS, 0);
                self::schedule((int) $id, 300);
                if ($previous !== 'pending') { $order->add_order_note('درخواست مرجوعی به حسابداری رسید و منتظر تأیید دستی است؛ هنوز سندی ثبت نشده است.'); }
            } else {
                $order->add_order_note('درخواست مرجوعی در حسابداری رد شد؛ بررسی دستی لازم است.');
            }
        } elseif (empty($result['returnId']) || ($result['status'] ?? '') !== 'posted') {
            $refund->update_meta_data(self::ERROR, 'پاسخ مرجوعی معتبر نبود؛ ثبت تأیید نشد.');
            if ($attempt < LMC_Order_Sync::MAX_ATTEMPTS) { self::schedule((int) $id, 120); }
        } else {
            $refund->update_meta_data(self::DONE, (string) $result['returnId']);
            $refund->update_meta_data(self::STATUS, 'approved');
            $refund->delete_meta_data(self::ERROR);
            $order->add_order_note('مرجوعی در لیبل مد ثبت شد: ' . (string) ($result['number'] ?? $result['returnId']));
        }
        $refund->save();
    }

    public static function retry_order($order): void
    {
        if (!current_user_can('manage_woocommerce')) { return; }
        foreach ($order->get_refunds() as $refund) {
            if ($refund->get_meta(self::DONE) !== '' || $refund->get_meta(self::STATUS) === 'rejected' || !is_array($refund->get_meta(self::PAYLOAD))) { continue; }
            $refund->update_meta_data(self::ATTEMPTS, 0);
            $refund->save();
            self::schedule((int) $refund->get_id(), 10);
        }
    }
}
