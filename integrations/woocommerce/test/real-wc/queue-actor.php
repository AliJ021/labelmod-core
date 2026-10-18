<?php
/**
 * فرمان‌های آزمایشگاه صف روی وردپرس/ووکامرس واقعی (run_queue.py). فقط دادهٔ مصنوعی.
 *   php queue-actor.php <wp-root> setup
 *   php queue-actor.php <wp-root> orders <n> <max-gap-ms>    → یک خط JSON برای هر سفارش
 *   php queue-actor.php <wp-root> state <id>...
 *   php queue-actor.php <wp-root> due <id>...                → موعد Backoff همین حالا (جلو بردن ساعت)
 */
[$self, $root, $cmd] = array_slice($argv, 0, 3) + [null, null, null];
$args = array_slice($argv, 3);
require "$root/wp-load.php";
function out($v) { echo json_encode($v, JSON_UNESCAPED_UNICODE), "\n"; }
const WH = '00000000-0000-7000-8000-000000000101';
switch ($cmd) {
    case 'setup':
        update_option('labelmod_connector_settings', ['sync_stock' => 'no', 'warehouse_id' => WH, 'branch_id' => WH,
            'base_url' => 'https://core.invalid', 'api_key' => 'synthetic', 'currency_unit' => 'rial']);
        $id = wc_get_product_id_by_sku('Q-SKU');
        $p = $id ? wc_get_product($id) : new WC_Product_Simple();
        $p->set_name('queue lab'); $p->set_sku('Q-SKU'); $p->set_regular_price('1000');
        $p->set_manage_stock(false); $p->save();
        global $wpdb;
        $wpdb->query("DELETE a, l FROM {$wpdb->prefix}actionscheduler_actions a LEFT JOIN {$wpdb->prefix}actionscheduler_logs l ON l.action_id = a.action_id WHERE a.hook IN ('lmc_send_order','lmc_reserve_order','lmc_send_refund')");
        delete_option('lmc_queue_dead'); delete_option('lmc_queue_crashes');
        out(['product' => $p->get_id(), 'plugin' => LMC_VERSION, 'queue' => class_exists('LMC_Queue') ? LMC_Queue::health() : 'legacy-wp-cron']);
        break;
    case 'orders':
        [$n, $gap] = [(int) $args[0], (int) $args[1]];
        $product = wc_get_product(wc_get_product_id_by_sku('Q-SKU'));
        for ($i = 0; $i < $n; $i++) {
            $order = wc_create_order();
            $order->add_product($product, 1);
            $order->set_payment_method('bacs');
            $order->calculate_totals();
            $order->save();
            $t0 = microtime(true);
            $order->payment_complete('lab-' . $order->get_id());
            $t1 = microtime(true);
            out(['id' => $order->get_id(), 't_enq' => (int) round($t0 * 1000), 'pc_ms' => round(($t1 - $t0) * 1000, 2)]);
            if ($gap > 0) { usleep(random_int(0, $gap) * 1000); }
        }
        break;
    case 'state':
        global $wpdb;
        foreach ($args as $id) {
            $o = wc_get_order((int) $id);
            $rows = $wpdb->get_results($wpdb->prepare(
                "SELECT action_id, status, UNIX_TIMESTAMP(scheduled_date_gmt) - UNIX_TIMESTAMP(UTC_TIMESTAMP()) AS due_in, claim_id
                 FROM {$wpdb->prefix}actionscheduler_actions WHERE hook = 'lmc_send_order' AND args = %s ORDER BY action_id",
                wp_json_encode([(int) $id])), ARRAY_A);
            out(['id' => (int) $id, 'invoice' => $o->get_meta('_lmc_invoice_id'), 'attempts' => (int) $o->get_meta('_lmc_attempts'),
                'stopped' => $o->get_meta('_lmc_order_stopped'), 'error' => $o->get_meta('_lmc_last_error') !== '',
                'actions' => $rows, 'cron' => wp_next_scheduled('lmc_send_order', [(int) $id]),
                'dead' => count((array) get_option('lmc_queue_dead', []))]);
        }
        break;
    case 'due':
        global $wpdb;
        foreach ($args as $id) {
            $wpdb->query($wpdb->prepare("UPDATE {$wpdb->prefix}actionscheduler_actions SET scheduled_date_gmt = UTC_TIMESTAMP(), scheduled_date_local = NOW()
                WHERE hook = 'lmc_send_order' AND args = %s AND status = 'pending'", wp_json_encode([(int) $id])));
        }
        out(['ok' => true]);
        break;
    default:
        fwrite(STDERR, "unknown command\n"); exit(2);
}
