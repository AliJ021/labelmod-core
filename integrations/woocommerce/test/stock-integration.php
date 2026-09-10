<?php
/** Run only against a disposable local WordPress/WooCommerce installation.
 * php stock-integration.php /absolute/path/to/wordpress
 * WooCommerce CRUD and DB are real; the Core HTTP response is simulated.
 */
if (PHP_SAPI !== 'cli' || empty($argv[1])) {
    fwrite(STDERR, "A disposable WordPress directory is required.\n");
    exit(2);
}
require rtrim($argv[1], '/\\') . '/wp-load.php';
if (wp_get_environment_type() !== 'local' || !class_exists('LMC_Stock_Sync')) {
    throw new RuntimeException('Requires a local test installation with the connector active');
}
$original = get_option(LMC_OPTION);
$stock = [];
$requests = 0;
$intercept = function ($pre, $args, $url) use (&$stock, &$requests) {
    if (!str_starts_with($url, 'http://127.0.0.1:54999/api/web/stock?')) {
        return new WP_Error('test_external_http_blocked', 'HTTP is blocked during this test');
    }
    $requests++;
    return ['headers' => [], 'body' => wp_json_encode(['items' => $stock]),
        'response' => ['code' => 200, 'message' => 'OK'], 'cookies' => [], 'filename' => null];
};
add_filter('pre_http_request', $intercept, PHP_INT_MAX, 3);
$results = [];
try {
    update_option(LMC_OPTION, array_merge(lmc_settings(), [
        'base_url' => 'http://127.0.0.1:54999', 'api_key' => bin2hex(random_bytes(24)),
        'warehouse_id' => 'synthetic-warehouse', 'sync_stock' => 'yes',
        'sync_price' => 'yes', 'link_by_sku' => 'no', 'currency_unit' => 'rial',
    ]));
    foreach ([
        ['unmanaged zero', false, null, 'instock', 0],
        ['managed zero stale status', true, 0, 'instock', 0],
        ['positive stale status', true, 5, 'outofstock', 5],
        ['unmanaged positive', false, null, 'instock', 5],
    ] as [$label, $managed, $quantity, $status, $available]) {
        $product = new WC_Product_Simple();
        $product->set_name('Synthetic audit stock ' . $label);
        $product->set_sku('AUDIT-STOCK-' . bin2hex(random_bytes(8)));
        $product->set_regular_price('1000');
        $product->set_manage_stock($managed);
        $product->set_stock_quantity($quantity);
        $product->set_stock_status($status);
        $id = $product->save();
        $variation = 'synthetic-' . $id;
        update_post_meta($id, LMC_Stock_Sync::META_KEY, $variation);
        $stock = [['variationId' => $variation, 'available' => (string) $available, 'price' => null]];
        $before = new WC_Product_Simple($id);
        $changed = LMC_Stock_Sync::run();
        $fresh = new WC_Product_Simple($id);
        $replay = LMC_Stock_Sync::run();
        $ok = $fresh->get_manage_stock() === true
            && $fresh->get_stock_quantity() !== null && (int) $fresh->get_stock_quantity() === $available
            && $fresh->get_stock_status() === ($available > 0 ? 'instock' : 'outofstock')
            && $fresh->get_regular_price() === '1000' && $replay['updated'] === 0;
        $results[] = ['case' => $label, 'id' => $id,
            'before' => [$before->get_manage_stock(), $before->get_stock_quantity(), $before->get_stock_status()],
            'after' => [$fresh->get_manage_stock(), $fresh->get_stock_quantity(), $fresh->get_stock_status()],
            'updated' => $changed['updated'], 'replay_updated' => $replay['updated'], 'passed' => $ok];
    }
    echo wp_json_encode(['wp' => get_bloginfo('version'), 'woo' => WC_VERSION,
        'hpos' => \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled(),
        'core_http' => 'simulated', 'requests' => $requests, 'results' => $results], JSON_PRETTY_PRINT) . "\n";
} finally {
    remove_filter('pre_http_request', $intercept, PHP_INT_MAX);
    update_option(LMC_OPTION, $original);
}
exit(count(array_filter($results, fn($result) => !$result['passed'])) ? 1 : 0);
