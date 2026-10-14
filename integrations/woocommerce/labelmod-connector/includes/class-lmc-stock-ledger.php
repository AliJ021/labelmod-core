<?php
/**
 * دفتر کسر محلی و تنها مسیر نشاندن موجودی Core روی سایت — docs/STOCK-SYNC-PROTOCOL.md.
 *
 * ── مسئله ───────────────────────────────────────────────────────────
 *
 * ووکامرس هنگام ثبت سفارش `_stock` را خودش کم می‌کند، ولی Core تا تأیید سفارش
 * (رزرو یا فاکتور) آن را نمی‌بیند. هر عکسی از Core که پیش از آن تأیید ساخته شده
 * باشد — Pull پانزده‌دقیقه‌ای یا Push در صف — همان واحد فروخته‌شده را روی سایت
 * **برمی‌گرداند**. و عکس بعد از تأیید، اگر کسر محلی هم دوباره کم شود، **دوبار**
 * کم می‌شود. Pull هم هیچ نسخه‌ای نداشت و بی قفل می‌نوشت، پس یک Pull کهنه پس از
 * Push تازه، عدد قدیمی را می‌نشاند.
 *
 * ── راه‌حل ───────────────────────────────────────────────────────────
 *
 * - هر کسر محلی یک سطر **پایدار** در `lmc_stock_hold` است (بی TTL): (سفارش، کالا،
 *   تعداد، `ack_rev`). `ack_rev` تهی یعنی Core هنوز این سفارش را ندیده است.
 * - Core در پاسخ رزرو/فاکتور برای هر تنوع `stockRev` می‌دهد: «هر عکس با واترمارک
 *   ≥ این عدد، این سفارش را در خود دارد». این ACK است، نه HTTP 200.
 * - Push و Pull هر دو از `apply_snapshot()` می‌گذرند، زیر **یک** قفل برای هر کالا،
 *   با **یک** واترمارک: عکس با `stockRev` کمتر یا مساوی آنچه نشسته، دور ریخته می‌شود.
 * - عدد سایت = موجودی Core در آن عکس − جمع کسرهایی که آن عکس هنوز در خود ندارد
 *   (`ack_rev` تهی یا بزرگ‌تر از واترمارک عکس). کسری که عکس در خود دارد تسویه و
 *   حذف می‌شود؛ پس هیچ کسری دوبار کم نمی‌شود.
 *
 * ⚠️ اگر عکسی که سفارش را در خود دارد **پیش از** پردازش ACK برسد، کسر هنوز تهی است
 *    و تا رسیدن ACK یک بار اضافه کم می‌شود — موقت و محافظه‌کار (کمتر نشان دادن، نه
 *    فروش اضافه). ACK همان لحظه `recompute()` می‌زند و عدد درست می‌شود.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Stock_Ledger
{
    const SCHEMA_VERSION = 1;
    const SCHEMA_OPTION  = 'lmc_stock_ledger_schema';
    /** «شناسهٔ انبار:واترمارک» آخرین عکسی که نشست. واترمارک دو انبار مقایسه‌پذیر نیست. */
    const REV_META       = '_lmc_stock_rev';
    /** موجودی Core در همان عکس، برای بازمحاسبه پس از کسر/ACK/لغو. */
    const CORE_META      = '_lmc_core_available';
    /** ثانیه‌های انتظار برای قفل در مسیرهای غیر Push. Push بی انتظار ۵۰۳ می‌دهد تا صف تکرار کند. */
    const LOCK_WAIT      = 10;
    /** همان `LMC_Push_Receiver::STOCK_VERSION_META`؛ هم نام قفل و هم نسخهٔ سراسری Push. آزمون برابری‌شان را قفل کرده. */
    const VERSION_META   = '_lmc_stock_version';

    public static function table(): string
    {
        global $wpdb;
        return $wpdb->prefix . 'lmc_stock_hold';
    }

    public static function install(): void
    {
        global $wpdb;
        $table   = self::table();
        $collate = method_exists($wpdb, 'get_charset_collate') ? $wpdb->get_charset_collate() : '';
        $sql = "CREATE TABLE {$table} (
            order_id BIGINT UNSIGNED NOT NULL,
            product_id BIGINT UNSIGNED NOT NULL,
            qty INT UNSIGNED NOT NULL,
            ack_rev BIGINT UNSIGNED NULL,
            created_at BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY  (order_id,product_id),
            KEY product_id (product_id)
        ) {$collate}";
        if (!function_exists('dbDelta')) {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        }
        dbDelta($sql);
        update_option(self::SCHEMA_OPTION, self::SCHEMA_VERSION, false);
        self::backfill();
    }

    public static function ensure_schema(): void
    {
        if ((int) get_option(self::SCHEMA_OPTION, 0) >= self::SCHEMA_VERSION) {
            return;
        }
        self::install();
    }

    public static function init(): void
    {
        add_action('woocommerce_reduce_order_item_stock', [__CLASS__, 'on_reduce'], 10, 3);
        add_action('woocommerce_restore_order_item_stock', [__CLASS__, 'on_restore'], 10, 5);
    }

    /** قفل مشترک Push و Pull برای یک کالا — همان نامی که گیرندهٔ Push از قبل داشت. */
    public static function lock_name(int $product_id): string
    {
        return LMC_Push_Guard::lock_name($product_id, self::VERSION_META);
    }

    // ── دفتر کسر ─────────────────────────────────────────────────────────

    /** کسر محلی. تکرار همان (سفارش، کالا) چیزی اضافه نمی‌کند. */
    public static function hold(int $order_id, int $product_id, int $qty): void
    {
        global $wpdb;
        if ($order_id <= 0 || $product_id <= 0 || $qty <= 0) { return; }
        $t = self::table();
        $exists = $wpdb->get_var($wpdb->prepare(
            "SELECT 1 FROM {$t} WHERE order_id = %d AND product_id = %d", $order_id, $product_id));
        if ($exists !== null) { return; }
        $wpdb->query($wpdb->prepare(
            "INSERT INTO {$t} (order_id, product_id, qty, ack_rev, created_at) VALUES (%d, %d, %d, NULL, %d)",
            $order_id, $product_id, $qty, time()));
    }

    /** اثبات شمول از Core. فقط اولین اثبات می‌نشیند؛ تکرار پاسخ آن را عقب یا جلو نمی‌برد. */
    public static function ack(int $order_id, int $product_id, int $rev): void
    {
        global $wpdb;
        $t = self::table();
        $wpdb->query($wpdb->prepare(
            "UPDATE {$t} SET ack_rev = %d WHERE order_id = %d AND product_id = %d AND ack_rev IS NULL",
            max(0, $rev), $order_id, $product_id));
    }

    public static function drop(int $order_id, int $product_id): void
    {
        global $wpdb;
        $t = self::table();
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$t} WHERE order_id = %d AND product_id = %d", $order_id, $product_id));
    }

    /** جمع کسرهایی که عکس با واترمارک `$rev` هنوز در خود ندارد. */
    public static function pending(int $product_id, int $rev): int
    {
        global $wpdb;
        $t = self::table();
        return (int) $wpdb->get_var($wpdb->prepare(
            "SELECT COALESCE(SUM(qty), 0) FROM {$t} WHERE product_id = %d AND (ack_rev IS NULL OR ack_rev > %d)",
            $product_id, $rev));
    }

    /** کسرهایی که عکس `$rev` در خود دارد دیگر کم نمی‌شوند. */
    private static function settle(int $product_id, int $rev): void
    {
        global $wpdb;
        $t = self::table();
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$t} WHERE product_id = %d AND ack_rev IS NOT NULL AND ack_rev <= %d", $product_id, $rev));
    }

    /** @return array{0:string,1:int}|null */
    private static function stored_rev(int $product_id): ?array
    {
        $raw = (string) get_post_meta($product_id, self::REV_META, true);
        if (!preg_match('/^([0-9a-f-]{36}):([0-9]+)$/', $raw, $m)) { return null; }
        return [$m[1], (int) $m[2]];
    }

    // ── تنها مسیر نشاندن عکس Core ──────────────────────────────────────

    /**
     * عکس Core را زیر قفل کالا و واترمارک مشترک می‌نشاند.
     *
     * @param int|null $version نسخهٔ سراسری Push (تکرار پیام)؛ Pull ندارد.
     * @return array{ok:bool,applied:bool,stale?:bool,busy?:bool,display?:int,note?:string}
     */
    public static function apply_snapshot(int $product_id, int $available, int $rev, string $warehouse, int $wait, ?int $version = null): array
    {
        $lock = self::lock_name($product_id);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            return ['ok' => false, 'applied' => false, 'busy' => true];
        }
        try {
            self::fresh_meta($product_id);
            if ($version !== null) {
                $stored_v = (int) get_post_meta($product_id, self::VERSION_META, true);
                if ($stored_v > 0 && $version <= $stored_v) {
                    return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'نسخهٔ قدیمی یا تکراری'];
                }
            }
            $stored = self::stored_rev($product_id);
            if ($stored !== null && $stored[0] === $warehouse && $rev <= $stored[1]) {
                // عکس کهنه‌تر یا هم‌واترمارک: سایت از قبل همین یا تازه‌تر را دارد.
                if ($version !== null) { update_post_meta($product_id, self::VERSION_META, $version); }
                return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'واترمارک قدیمی یا تکراری'];
            }
            $product = wc_get_product($product_id);
            if (!$product) {
                return ['ok' => true, 'applied' => false, 'note' => 'کالا خوانده نشد'];
            }
            $out = self::write($product, $available, $rev);
            update_post_meta($product_id, self::REV_META, $warehouse . ':' . $rev);
            update_post_meta($product_id, self::CORE_META, $available);
            if ($version !== null) { update_post_meta($product_id, self::VERSION_META, $version); }
            return ['ok' => true, 'applied' => $out['changed'], 'display' => $out['display']];
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    /**
     * بازمحاسبه از آخرین عکس نشسته — پس از کسر، ACK یا لغو.
     * بی عکس واترمارک‌دار (Core قدیمی) کاری نمی‌کند و کسر خودِ ووکامرس می‌ماند.
     */
    public static function recompute(int $product_id, int $wait = self::LOCK_WAIT): bool
    {
        $lock = self::lock_name($product_id);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            lmc_log('بازمحاسبهٔ موجودی کالای ' . $product_id . ' به قفل نرسید؛ عکس بعدی Core آن را درست می‌کند.');
            return false;
        }
        try {
            self::fresh_meta($product_id);
            $stored = self::stored_rev($product_id);
            if ($stored === null) { return false; }
            $product = wc_get_product($product_id);
            if (!$product) { return false; }
            self::write($product, (int) get_post_meta($product_id, self::CORE_META, true), $stored[1]);
            return true;
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    /** @return array{changed:bool,display:int} */
    private static function write($product, int $available, int $rev): array
    {
        $id = (int) $product->get_id();
        self::settle($id, $rev);
        $display = max(0, $available - self::pending($id, $rev));
        $changed = LMC_Stock_Sync::apply_stock($product, $display);
        if ($changed) { $product->save(); }
        return ['changed' => $changed, 'display' => $display];
    }

    /** متای این کالا را از دیتابیس بخوان، نه از Cache همین درخواست — پس از گرفتن قفل. */
    private static function fresh_meta(int $product_id): void
    {
        if (function_exists('wp_cache_delete')) { wp_cache_delete($product_id, 'post_meta'); }
    }

    /**
     * نشاندن عکس بی واترمارک (Core پیش از ۰۹۷). رفتار قدیم، ولی زیر همان قفل؛ و
     * واترمارک ذخیره‌شده پاک می‌شود تا بازمحاسبه روی عددِ ناهم‌مبنا اجرا نشود.
     */
    public static function apply_legacy(int $product_id, int $available, int $wait): array
    {
        $lock = self::lock_name($product_id);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            return ['ok' => false, 'applied' => false, 'busy' => true];
        }
        try {
            $product = wc_get_product($product_id);
            if (!$product) { return ['ok' => true, 'applied' => false]; }
            $changed = LMC_Stock_Sync::apply_stock($product, $available);
            if ($changed) { $product->save(); }
            delete_post_meta($product_id, self::REV_META);
            delete_post_meta($product_id, self::CORE_META);
            return ['ok' => true, 'applied' => $changed];
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    // ── رویدادهای ووکامرس و ACK ────────────────────────────────────────

    /** پس از کسر محلی هر قلم (wc_reduce_stock_levels). */
    public static function on_reduce($item, $change, $order): void
    {
        $product = is_array($change) ? ($change['product'] ?? null) : null;
        if (!$product || !$order || !is_object($item) || !method_exists($item, 'get_quantity')) { return; }
        $pid = (int) $product->get_stock_managed_by_id();
        self::hold((int) $order->get_id(), $pid, (int) ceil((float) $item->get_quantity()));
        self::recompute($pid);
    }

    /** پس از برگرداندن محلی هر قلم (لغو/ناموفق). کسر دیگر کم نمی‌شود. */
    public static function on_restore($item, $new_stock, $old_stock, $order, $product = null): void
    {
        if (!$order) { return; }
        $product = $product ?: (is_object($item) && method_exists($item, 'get_product') ? $item->get_product() : null);
        if (!$product) { return; }
        $pid = (int) $product->get_stock_managed_by_id();
        self::drop((int) $order->get_id(), $pid);
        self::recompute($pid);
    }

    /**
     * ACK سفارش از پاسخ Core. `stock` = [{sku, variationId, stockRev}].
     * پاسخ Core قدیمی (بی `stock`) واترمارک ۰ می‌گیرد: «در هر عکس واترمارک‌دار هست»؛
     * چنین عکسی فقط از Core به‌روزشده می‌آید که پس از این سفارش است.
     */
    public static function ack_order($order, $stock): void
    {
        $by_sku = [];
        if (is_array($stock)) {
            foreach ($stock as $row) {
                if (is_array($row) && isset($row['sku'], $row['stockRev']) && preg_match('/^[0-9]+$/D', (string) $row['stockRev'])) {
                    $by_sku[(string) $row['sku']] = (int) $row['stockRev'];
                }
            }
        }
        foreach ($order->get_items() as $item) {
            if (!is_object($item) || !method_exists($item, 'get_product')) { continue; }
            $product = $item->get_product();
            if (!$product) { continue; }
            $sku = trim((string) $product->get_sku());
            if (is_array($stock) && !isset($by_sku[$sku])) {
                // Core این قلم را در پاسخ نیاورد: اثبات نیست، کسر می‌ماند (محافظه‌کار).
                continue;
            }
            $pid = (int) $product->get_stock_managed_by_id();
            self::ack((int) $order->get_id(), $pid, is_array($stock) ? $by_sku[$sku] : 0);
            self::recompute($pid);
        }
    }

    /**
     * ارتقا: سفارش‌های فعالی که پیش از این نسخه کسر محلی خورده‌اند و هنوز Core
     * تأییدشان نکرده، کسر تأییدنشده می‌گیرند — وگرنه اولین عکس واترمارک‌دار
     * آن واحدها را برمی‌گرداند. فقط وضعیت‌های فعال؛ سفارش تکمیل‌شدهٔ همگام‌نشده
     * یک ناهنجاری قبلی است و حدس زده نمی‌شود (docs/STOCK-SYNC-PROTOCOL.md).
     */
    public static function backfill(): int
    {
        if (!function_exists('wc_get_orders')) { return 0; }
        $n = 0;
        for ($page = 1; $page <= 50; $page++) {
            $orders = wc_get_orders(['status' => ['pending', 'on-hold', 'processing'], 'limit' => 200, 'paged' => $page]);
            if (!$orders) { break; }
            foreach ($orders as $order) {
                if (!$order->get_order_stock_reduced()
                    || $order->get_meta(LMC_Order_Sync::META_INVOICE) !== ''
                    || in_array($order->get_meta(LMC_Order_Reservation::STATE), ['reserved', 'consumed'], true)) {
                    continue;
                }
                foreach ($order->get_items() as $item) {
                    $reduced = is_object($item) && method_exists($item, 'get_meta') ? (float) $item->get_meta('_reduced_stock', true) : 0.0;
                    $product = is_object($item) && method_exists($item, 'get_product') ? $item->get_product() : null;
                    if ($reduced > 0 && $product) {
                        self::hold((int) $order->get_id(), (int) $product->get_stock_managed_by_id(), (int) ceil($reduced));
                        $n++;
                    }
                }
            }
        }
        return $n;
    }
}
