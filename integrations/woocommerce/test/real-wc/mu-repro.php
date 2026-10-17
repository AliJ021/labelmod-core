<?php
/**
 * فقط برای بازتولید محلی با دادهٔ مصنوعی — هرگز روی سایت واقعی نصب نشود.
 *
 * مانع‌های فایلی روی Hookهای واقعی ووکامرس ۱۱٫۱٫۱ و نقطه‌های probe دفتر کسر. هر پردازه با
 * LMC_ROLE و LMC_PAUSE (فهرست مرحله‌ها) اجرا می‌شود؛ در هر مرحلهٔ فهرست، فایل «reached» را
 * می‌سازد و تا فایل «go» صبر می‌کند. راننده (run.py) همین‌جا ادامه می‌دهد یا با SIGKILL می‌کشد.
 */
if (!getenv('LMC_ROLE')) { return; }

function lmc_repro_barrier(string $stage): void
{
    $pause = array_filter(explode(',', (string) getenv('LMC_PAUSE')));
    if (!in_array($stage, $pause, true)) { return; }
    static $hit = [];
    if (!empty($hit[$stage])) { return; }        // هر مرحله یک بار
    $hit[$stage] = true;
    $dir = rtrim((string) getenv('LMC_BAR'), '/');
    $role = (string) getenv('LMC_ROLE');
    touch("$dir/$role.$stage.reached");
    $t = microtime(true);
    while (!file_exists("$dir/$role.$stage.go")) {
        if (microtime(true) - $t > 120) { fwrite(STDERR, "barrier timeout $stage\n"); exit(3); }
        usleep(20000);
    }
}

$GLOBALS['lmc_repro_sum_seen'] = false;
add_filter('query', static function ($q) {
    if (is_string($q) && str_contains($q, 'SUM(qty)')) { $GLOBALS['lmc_repro_sum_seen'] = true; }
    return $q;
});
// دفتر تازه: پس از خواندن `_stock` و پس از خواندن کسرها.
add_action('lmc_stock_probe', static function ($stage) { lmc_repro_barrier('probe_' . $stage); }, 10, 1);
// دفتر قدیمی (757a1c4): پیش از save مطلق، پس از خواندن کسرها.
add_action('woocommerce_before_product_object_save', static function () {
    if (!empty($GLOBALS['lmc_repro_sum_seen'])) { lmc_repro_barrier('old_before_save'); }
}, 10, 0);
// ووکامرس: پیش و پس از UPDATE اتمیک `_stock` در wc_update_product_stock.
add_action('woocommerce_product_before_set_stock', static function () { lmc_repro_barrier('before_set_stock'); }, 10, 0);
add_action('woocommerce_product_set_stock', static function () { lmc_repro_barrier('after_set_stock'); }, 10, 0);
// دفتر قدیمی پس از save مطلق (پیش از بازبینی دوباره).
add_action('woocommerce_update_product', static function () {
    if (!empty($GLOBALS['lmc_repro_sum_seen'])) { lmc_repro_barrier('old_after_save'); }
}, 10, 0);
