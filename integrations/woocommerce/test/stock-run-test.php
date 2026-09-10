<?php
/** Isolated persistence/HTTP doubles; real WooCommerce coverage runs separately. */

class LMC_Stored_Product
{
    public bool $managed = false;
    public ?int $quantity = null;
    public string $status = 'instock';
    public string $price = '1000';
    public function get_manage_stock() { return $this->managed; }
    public function set_manage_stock($v) { $this->managed = $v; }
    public function get_stock_quantity() { return $this->quantity; }
    public function set_stock_quantity($v) { $this->quantity = $v; }
    public function get_stock_status() { return $this->status; }
    public function set_stock_status($v) { $this->status = $v; }
    public function get_regular_price() { return $this->price; }
    public function set_regular_price($v) { $this->price = $v; }
    public function save() { $GLOBALS['stock_saved'] = clone $this; }
}

function get_option($key, $default = false) { return $default; }
function get_posts($args) { return [42]; }
function wc_get_product($id) { return clone $GLOBALS['stock_saved']; }
function wp_remote_request($url, $args) {
    return ['body' => json_encode(['items' => [[
        'variationId' => 'synthetic-stock', 'available' => (string) $GLOBALS['stock_available'], 'price' => null,
    ]]])];
}
function wp_remote_retrieve_response_code($response) { return 200; }
function wp_remote_retrieve_body($response) { return $response['body']; }

set_settings(['sync_stock' => 'yes', 'sync_price' => 'yes',
    'base_url' => 'http://127.0.0.1:54999', 'api_key' => bin2hex(random_bytes(24))]);

foreach ([
    ['unmanaged zero stock', false, null, 'instock', 0],
    ['managed zero stale status', true, 0, 'instock', 0],
    ['positive stock stale status', true, 5, 'outofstock', 5],
    ['unmanaged positive stock', false, null, 'instock', 5],
] as [$label, $managed, $quantity, $status, $available]) {
    $p = new LMC_Stored_Product();
    $p->managed = $managed;
    $p->quantity = $quantity;
    $p->status = $status;
    $GLOBALS['stock_saved'] = $p;
    $GLOBALS['stock_available'] = $available;
    $result = LMC_Stock_Sync::run();
    $fresh = wc_get_product(42);
    assert_eq("$label persisted management", $fresh->get_manage_stock(), true);
    assert_eq("$label persisted quantity", $fresh->get_stock_quantity(), $available);
    assert_eq("$label persisted status", $fresh->get_stock_status(), $available > 0 ? 'instock' : 'outofstock');
    assert_eq("$label null price preserved", $fresh->get_regular_price(), '1000');
    assert_eq("$label reports update", $result['updated'], 1);
    assert_eq("$label replay is unchanged", LMC_Stock_Sync::run()['updated'], 0);
}
