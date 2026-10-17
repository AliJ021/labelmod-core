<?php
/**
 * یک «نقش» در یک پردازهٔ PHP واقعی روی وردپرس ۷٫۰٫۷ (حداقلِ ووکامرس ۱۱٫۱٫۱) + ووکامرس ۱۱٫۱٫۱ + MariaDB محلی.
 *   php actor.php <wp-root> <command> [args...]
 * فقط دادهٔ مصنوعی؛ هیچ کلید، سفارش واقعی یا سرور واقعی.
 */
[$self, $root, $cmd] = array_slice($argv, 0, 3) + [null, null, null];
$args = array_slice($argv, 3);
const WH = '00000000-0000-7000-8000-000000000101';
const VAR_ID = 'aaaaaaaa-0000-7000-8000-000000000042';
if ($cmd === 'install-wp') {
    define('WP_INSTALLING', true);
    require "$root/wp-load.php";
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    wp_install('LMC repro', 'synthetic', 'synthetic@example.invalid', false, '', 'synthetic-only-' . bin2hex(random_bytes(6)));
    echo "ok\n"; exit;
}
require "$root/wp-load.php";
require_once ABSPATH . 'wp-admin/includes/plugin.php';
function out($v) { echo json_encode($v, JSON_UNESCAPED_UNICODE), "\n"; }
function stock_now(int $pid): int { global $wpdb; return (int) $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = '_stock'", $pid)); }
function holds_now(int $pid): array { global $wpdb; $t = $wpdb->prefix . 'lmc_stock_hold'; return $wpdb->get_results($wpdb->prepare("SELECT order_id, item_id, qty, confirmed, ack_rev FROM {$t} WHERE product_id = %d", $pid), ARRAY_A) ?: []; }
switch ($cmd) {
    case 'activate':
        activate_plugin('woocommerce/woocommerce.php');
        echo "ok\n"; break;
    case 'install-wc':
        WC_Install::install();
        update_option('woocommerce_manage_stock', 'yes');
        update_option('labelmod_connector_settings', ['sync_stock' => 'yes', 'warehouse_id' => WH, 'branch_id' => WH, 'base_url' => 'https://core.invalid', 'api_key' => 'x']);
        $r = activate_plugin('labelmod-connector/labelmod-connector.php');
        echo is_wp_error($r) ? $r->get_error_message() : "ok", "\n"; break;
    case 'prep':
        // کالای تازه با موجودی ۱۰، ورود به پروتکل با Pull (۱۰، rev 10)، و سفارش pending با یک قلم.
        global $wpdb;
        foreach (['lmc_stock_hold', 'lmc_stock_mark'] as $t) { $wpdb->query("DELETE FROM {$wpdb->prefix}{$t}"); }
        $p = new WC_Product_Simple();
        $p->set_name('repro ' . uniqid()); $p->set_sku('R-' . uniqid()); $p->set_regular_price('1000');
        $p->set_manage_stock(true); $p->set_stock_quantity(10); $p->set_backorders('no'); $p->save();
        update_post_meta($p->get_id(), '_lmc_variation_id', VAR_ID . substr(uniqid(), -4));
        $o = wc_create_order(['status' => 'pending']);
        $o->add_product($p, (int) ($args[0] ?? 1)); $o->calculate_totals(); $o->save();
        update_option('lmc_stock_reconcile', ['page' => 1, 'done' => true], false);
        $r = LMC_Stock_Ledger::apply_snapshot($p->get_id(), 10, true, 10, WH, 5, true);
        $item = array_values($o->get_items())[0];
        out(['pid' => $p->get_id(), 'order' => $o->get_id(), 'item' => $item->get_id(), 'stock' => stock_now($p->get_id()), 'apply' => $r]);
        break;
    case 'reduce':                                      // همان مسیر پرداخت ووکامرس
        wc_maybe_reduce_stock_levels((int) $args[0]);
        out(['done' => 'reduce']); break;
    case 'adjust':                                      // ویرایش دستی تعداد قلم در مدیریت
        $o = wc_get_order((int) $args[0]); $item = array_values($o->get_items())[0];
        $item->set_quantity((int) $args[1]); $item->save();
        // تابع در پروندهٔ مدیریت است و در CLI بار نمی‌شود؛ همان پرونده‌ای که wp-admin بار می‌کند.
        if (!function_exists('wc_maybe_adjust_line_item_product_stock')) {
            require_once WC()->plugin_path() . '/includes/admin/wc-admin-functions.php';
        }
        wc_maybe_adjust_line_item_product_stock($item, (int) $args[1]);
        out(['done' => 'adjust']); break;
    case 'cancel':                                      // لغو: wc_maybe_increase_stock_levels روی Hook وضعیت
        $o = wc_get_order((int) $args[0]); $o->update_status('cancelled');
        out(['done' => 'cancel']); break;
    case 'refund':                                      // برگرداندن کالای استرداد به انبار (wc_restock_refunded_items)
        $o = wc_get_order((int) $args[0]); $item = array_values($o->get_items())[0];
        wc_restock_refunded_items($o, [$item->get_id() => ['qty' => (int) $args[1]]]);
        out(['done' => 'refund']); break;
    case 'reset':                                       // «بازنشانی واترمارک» مدیر (بی زمان بکاپ)
        out(['carried' => LMC_Stock_Ledger::reset_epoch(null), 'epoch' => LMC_Stock_Ledger::epoch()]); break;
    case 'outer-tx':                                    // فراخوانی درون تراکنش افزونهٔ دیگر که بعد Rollback می‌شود
        global $wpdb;
        $pid = (int) $args[0];
        $wpdb->query('START TRANSACTION');
        $wpdb->query($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '1', 'no')", 'lmc_outer_probe_' . $pid));
        $r = LMC_Stock_Ledger::apply_snapshot($pid, (int) $args[1], true, (int) $args[2], WH, 5, true);
        LMC_Stock_Ledger::recompute($pid);
        $wpdb->query('ROLLBACK');
        $probe = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name = %s", 'lmc_outer_probe_' . $pid));
        out(['apply' => $r, 'probe_survived_rollback' => (int) $probe === 1, 'stock' => stock_now($pid)]); break;
    case 'apply':                                       // عکس Core (Pull)
        $r = LMC_Stock_Ledger::apply_snapshot((int) $args[0], (int) $args[1], true, (int) $args[2], WH, 10, true);
        out($r); break;
    case 'ack':                                         // ACK با تعداد ارسالی همان قلم
        $o = wc_get_order((int) $args[0]); $item = array_values($o->get_items())[0];
        $sku = $item->get_product()->get_sku();
        $stock = [['sku' => $sku, 'variationId' => 'v', 'stockRev' => (string) (int) $args[1]]];
        $m = new ReflectionMethod('LMC_Stock_Ledger', 'ack_order');
        $m->getNumberOfParameters() >= 5
            ? LMC_Stock_Ledger::ack_order($o, $stock, WH, [$item->get_id() => (int) $args[2]], LMC_Stock_Ledger::epoch())
            : LMC_Stock_Ledger::ack_order($o, $stock, WH, [$item->get_id() => (int) $args[2]]);
        out(['done' => 'ack']); break;
    case 'read':
        out(['stock' => stock_now((int) $args[0]), 'holds' => holds_now((int) $args[0])]); break;
}
