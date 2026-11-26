<?php
/** Run against a disposable WordPress installation with WooCommerce and the connector active. */
declare(strict_types=1);

if (PHP_SAPI !== 'cli' || empty($argv[1])) { exit(2); }
require rtrim($argv[1], '/\\') . '/wp-load.php';
if (wp_get_environment_type() !== 'local' || !class_exists('LMC_Stock_Sync')) {
    throw new RuntimeException('A local WooCommerce installation with the connector is required.');
}
require_once WC_ABSPATH . 'includes/admin/class-wc-admin-duplicate-product.php';

function verify_duplicate($source, $copy): void
{
    if (!$copy || !$copy->get_id() || $source->get_id() === $copy->get_id()) {
        throw new RuntimeException('Expected a distinct duplicate.');
    }
    foreach (['_lmc_variation_id', '_lmc_stock_state', '_lmc_stock_version', '_lmc_price_version'] as $key) {
        if ($source->get_meta($key) !== 'source-' . $key || $copy->meta_exists($key)) {
            throw new RuntimeException('Unexpected duplicated metadata: ' . $key);
        }
    }
    if ($copy->get_meta('fixture_label') !== $source->get_meta('fixture_label') || $copy->meta_exists('fixture_excluded')) {
        throw new RuntimeException('Other metadata or another plugin exclusion changed.');
    }
}
function seed_meta($product, string $label): void
{
    foreach (['_lmc_variation_id', '_lmc_stock_state', '_lmc_stock_version', '_lmc_price_version'] as $key) {
        $product->update_meta_data($key, 'source-' . $key);
    }
    $product->update_meta_data('fixture_label', $label);
    $product->update_meta_data('fixture_excluded', 'private');
    $product->save();
}
add_filter('woocommerce_duplicate_product_exclude_meta', static function ($keys) {
    $keys[] = 'fixture_excluded';
    return $keys;
}, 5);
$duplicator = new WC_Admin_Duplicate_Product();
$simple = new WC_Product_Simple();
$simple->set_name('Duplication fixture');
seed_meta($simple, 'simple');
verify_duplicate(wc_get_product($simple->get_id()), $duplicator->product_duplicate($simple));

// The shared parent has no connector metadata. Both children have independent bindings.
$parent = new WC_Product_Variable();
$parent->set_name('Variable duplication fixture');
$parent->save();
foreach (['ivory', 'burgundy'] as $color) {
    $variation = new WC_Product_Variation();
    $variation->set_parent_id($parent->get_id());
    $variation->set_regular_price('10');
    seed_meta($variation, $color);
    $originals[$color] = $variation->get_id();
}
$copy = $duplicator->product_duplicate(wc_get_product($parent->get_id()));
$children = $copy->get_children();
if (count($children) !== 2) { throw new RuntimeException('Expected both variations.'); }
foreach ($children as $id) {
    $child = wc_get_product($id);
    $color = $child->get_meta('fixture_label');
    verify_duplicate(wc_get_product($originals[$color]), $child);
    unset($originals[$color]);
}
if ($originals) { throw new RuntimeException('Missing copied variation.'); }
echo "PASS: simple product, variable product with two variations, source and third-party metadata.\n";
