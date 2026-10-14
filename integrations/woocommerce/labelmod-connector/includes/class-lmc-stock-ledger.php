<?php
/**
 * دفتر کسر محلی و تنها مسیر نشاندن موجودی Core روی سایت — docs/STOCK-SYNC-PROTOCOL.md.
 *
 * ── مدل ──────────────────────────────────────────────────────────────
 *
 * - **کسر** = یک سطر پایدار برای هر قلم سفارش (سفارش، قلم) با `qty` برابر
 *   `_reduced_stock` خودِ ووکامرس. ووکامرس این متا را پس از کسر، در تنظیم دستی قلم،
 *   در برگشت‌دادن به انبار هنگام استرداد و در لغو می‌نویسد؛ پس دفتر از روی آن **همگام**
 *   می‌شود، نه از روی حدسِ رویداد. Replay و تکرار Hook بی‌اثرند. TTL ندارد.
 * - **ACK** = `(ack_rev, ack_wh)` که فقط از `stock` پاسخ Core می‌آید. پاسخ بی `stock` یا
 *   بدشکل اثبات نیست و هیچ‌چیز تأیید نمی‌کند.
 * - **حالت کالا** = یک متای JSON `{w,r,c,a,d}`: انبار، واترمارک، موجودی Core، فعال‌بودن و
 *   «کثیف». یک مقدار است تا نیمه‌نوشته نشود.
 * - **عدد سایت** = فعال ? max(0, c − Σ کسرهایی که این عکس در خود ندارد) : ۰.
 *
 * ── ترتیب نوشتن (بازیابی‌پذیر) ───────────────────────────────────────
 *
 * ۱. حالت تازه با d=1 نوشته می‌شود. ۲. `_stock` نوشته می‌شود. ۳. d=0 و نسخهٔ Push.
 شکست ۲ (استثنا) حالت قبلی را برمی‌گرداند و نسخه جلو نمی‌رود. مرگ پردازه میان ۱ و ۳، d=1
 * را جا می‌گذارد که `maintain()` و عکس بعدی بازمحاسبه‌اش می‌کنند.
 * ⚠️ کسر تسویه‌شده **حذف نمی‌شود**: `pending()` آن را حساب نمی‌کند و سطرش حافظهٔ پایدار همان
 *    قلم است. حذفش یعنی استرداد یا ویرایش بعدی، قلم را «تأییدنشده» از نو بسازد و دوبار کم کند.
 *    سطر فقط وقتی می‌رود که `_reduced_stock` صفر شود یا سفارش حذف شود.
 *
 * ── بسته‌بودن در شکست ───────────────────────────────────────────────
 *
 * هر نوشتن/خواندن دفتر سنجیده می‌شود. اگر کسری ثبت نشود، سفارش در «عقب‌ماندهٔ» پایدار
 * می‌نشیند و تا ثبت‌شدنش هیچ عکسی نشانده و هیچ بازمحاسبه‌ای انجام نمی‌شود: کسر خودِ
 * ووکامرس سر جایش می‌ماند و عددی برنمی‌گردد. تا آشتی اولیهٔ سفارش‌ها کامل نشده هم همین.
 *
 * ── ورود به پروتکل ──────────────────────────────────────────────────
 *
 * کالا فقط با یک **Pull** (خواندن زندهٔ Core) حالت می‌گیرد؛ Push در راه ممکن است پیش از
 * تأیید سفارشی قدیمی ساخته شده باشد. پیش از آن رفتار قدیم است. پس از آن، عکس بی واترمارک
 * یا بدشکل **رد** می‌شود (نه نشاندن بی‌صدا). بازگشت فقط با «بازنشانی واترمارک» صریح.
 *
 * ⚠️ قفل مشورتی کالا نوشتن‌های خودِ ووکامرس را سریال نمی‌کند (کسر ووکامرس پیش از Hook است).
 *    همگرایی از این است که Hook پس از نوشتن `_reduced_stock` زیر قفل بازمحاسبه می‌کند و
 *    عدد مطلق را از نو می‌سازد؛ مرز این ادعا در سند پروتکل است.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Stock_Ledger_Error extends RuntimeException {}

class LMC_Stock_Ledger
{
    const SCHEMA_VERSION  = 1;
    const SCHEMA_OPTION   = 'lmc_stock_ledger_schema';
    const RECONCILE       = 'lmc_stock_reconcile';
    const BACKLOG         = 'lmc_stock_backlog';
    const REDO            = 'lmc_stock_redo';
    const STATE_META      = '_lmc_stock_state';
    /** همان `LMC_Push_Receiver::STOCK_VERSION_META`؛ هم نام قفل و هم نسخهٔ سراسری Push. */
    const VERSION_META    = '_lmc_stock_version';
    const LOCK_WAIT       = 10;
    const RECONCILE_PAGE  = 100;
    /** زمان نصب دفتر؛ مرز «تأییدشده پیش از دفتر». */
    const SINCE           = 'lmc_stock_ledger_since';

    // ── اسکیما و آشتی اولیه ─────────────────────────────────────────────

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
            item_id BIGINT UNSIGNED NOT NULL,
            product_id BIGINT UNSIGNED NOT NULL,
            qty INT UNSIGNED NOT NULL,
            ack_rev BIGINT UNSIGNED NULL,
            ack_wh VARCHAR(36) NULL,
            created_at BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY  (order_id,item_id),
            KEY product_id (product_id)
        ) {$collate}";
        if (!function_exists('dbDelta')) {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        }
        dbDelta($sql);
        // ⚠️ نسخهٔ اسکیما فقط وقتی ثبت می‌شود که جدول واقعاً هست؛ وگرنه بارگذاری بعدی دوباره می‌سازد.
        if (!self::table_exists()) {
            lmc_log('ساخت جدول کسر موجودی ناموفق بود؛ نشاندن موجودی تا ساخته‌شدنش متوقف است.');
            return;
        }
        if ((int) get_option(self::SINCE, 0) === 0) { update_option(self::SINCE, time(), false); }
        if (get_option(self::RECONCILE, null) === null) {
            update_option(self::RECONCILE, ['page' => 1, 'done' => false], false);
            // ورود به پروتکل با Pull کامل: مکان‌نما پاک می‌شود تا همهٔ کالاها یک بار زنده خوانده شوند.
            delete_option(LMC_Stock_Sync::CURSOR_OPTION);
        }
        update_option(self::SCHEMA_OPTION, self::SCHEMA_VERSION, false);
    }

    public static function ensure_schema(): void
    {
        if ((int) get_option(self::SCHEMA_OPTION, 0) >= self::SCHEMA_VERSION) {
            return;
        }
        self::install();
    }

    public static function table_exists(): bool
    {
        global $wpdb;
        $t = self::table();
        return $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $t)) === $t;
    }

    /**
     * آشتی سفارش‌های موجود با دفتر، صفحه‌به‌صفحه با نقطهٔ بازگشت (بی سقف پنهان).
     * سفارش تأییدشده در Core کسر نمی‌گیرد: Pull زنده که کالا را وارد پروتکل می‌کند پس از
     * آن ساخته شده و شاملش است. سفارش تأییدنشده — فعال، یا هرکدام که افزونه برایش تلاش
     * کرده (تکمیل‌شدهٔ همگام‌نشده هم) — کسر می‌گیرد. تاریخچهٔ پیش از اتصال حدس زده نمی‌شود.
     */
    public static function reconcile_step(int $pages): bool
    {
        $state = get_option(self::RECONCILE, ['page' => 1, 'done' => false]);
        if (!is_array($state)) { $state = ['page' => 1, 'done' => false]; }
        if (!empty($state['done'])) { return true; }
        if (!function_exists('wc_get_orders')) { return false; }
        for ($i = 0; $i < $pages; $i++) {
            $orders = wc_get_orders(['limit' => self::RECONCILE_PAGE, 'paged' => (int) $state['page'],
                'orderby' => 'ID', 'order' => 'ASC', 'type' => 'shop_order']);
            if (!$orders) {
                $state['done'] = true;
                update_option(self::RECONCILE, $state, false);
                return true;
            }
            foreach ($orders as $order) {
                if (self::confirmed_before($order) || !self::connector_owned($order)) { continue; }
                self::sync_order_safe($order);
            }
            $state['page'] = (int) $state['page'] + 1;
            update_option(self::RECONCILE, $state, false);
        }
        return false;
    }

    private static function confirmed_before($order): bool
    {
        return $order->get_meta(LMC_Order_Sync::META_INVOICE) !== ''
            || in_array($order->get_meta(LMC_Order_Reservation::STATE), ['reserved', 'consumed'], true);
    }

    private static function connector_owned($order): bool
    {
        if ($order->has_status(['pending', 'on-hold', 'processing'])) { return true; }
        foreach ([LMC_Order_Sync::META_ATTEMPTS, LMC_Order_Sync::META_ERROR, LMC_Order_Sync::META_PAYLOAD, LMC_Order_Reservation::PAYLOAD] as $key) {
            if ($order->get_meta($key) !== '') { return true; }
        }
        return false;
    }

    // ── Hookهای ووکامرس ────────────────────────────────────────────────

    public static function init(): void
    {
        add_action('woocommerce_reduce_order_item_stock', [__CLASS__, 'on_reduce'], 10, 3);
        add_action('woocommerce_restore_order_item_stock', [__CLASS__, 'on_restore'], 10, 4);
        add_action('woocommerce_update_order_item', [__CLASS__, 'on_item_saved'], 10, 3);
        add_action('woocommerce_restock_refunded_item', [__CLASS__, 'on_refund_restock'], 10, 5);
        add_action('woocommerce_delete_order', [__CLASS__, 'on_order_deleted'], 10, 1);
        add_action('admin_post_lmc_stock_reset', [__CLASS__, 'handle_reset']);
    }

    public static function on_reduce($item, $change, $order): void { if ($order) { self::sync_item_safe($order, $item); } }
    public static function on_restore($item, $new_stock, $old_stock, $order): void { if ($order) { self::sync_item_safe($order, $item); } }
    public static function on_refund_restock($product_id, $old, $new, $order, $product = null): void { if ($order) { self::sync_order_safe($order); } }

    public static function on_item_saved($item_id, $item, $order_id): void
    {
        if (!is_object($item) || !method_exists($item, 'get_product')) { return; }
        $order = function_exists('wc_get_order') ? wc_get_order((int) $order_id) : null;
        if ($order) { self::sync_item_safe($order, $item); }
    }

    public static function on_order_deleted($order_id): void
    {
        try {
            $pids = self::drop_order((int) $order_id);
        } catch (LMC_Stock_Ledger_Error $e) {
            lmc_log('حذف کسرهای سفارش حذف‌شده ' . (int) $order_id . ' ناموفق: ' . $e->getMessage());
            return;
        }
        foreach ($pids as $pid) { self::recompute($pid); }
    }

    // ── همگام‌سازی کسر از `_reduced_stock` ────────────────────────────────

    public static function sync_item_safe($order, $item): void
    {
        try {
            $pids = self::sync_item($order, $item);
        } catch (LMC_Stock_Ledger_Error $e) {
            self::to_backlog($order, $e);
            return;
        }
        foreach ($pids as $pid) { self::recompute($pid); }
    }

    public static function sync_order_safe($order): bool
    {
        try {
            $pids = self::sync_order($order);
        } catch (LMC_Stock_Ledger_Error $e) {
            self::to_backlog($order, $e);
            return false;
        }
        foreach ($pids as $pid) { self::recompute($pid); }
        return true;
    }

    /** @return int[] کالاهایی که کسرشان عوض شد. */
    public static function sync_order($order): array
    {
        global $wpdb;
        $t = self::table();
        $pids = [];
        $seen = [];
        foreach ($order->get_items() as $item_id => $item) {
            if (!is_object($item) || !method_exists($item, 'get_product')) { continue; }
            $seen[] = (int) (method_exists($item, 'get_id') ? $item->get_id() : $item_id);
            $pids = array_merge($pids, self::sync_item($order, $item));
        }
        // قلمی که از سفارش حذف شده کسری جا نمی‌گذارد.
        $rows = self::rows($wpdb->prepare("SELECT item_id, product_id FROM {$t} WHERE order_id = %d", (int) $order->get_id()));
        foreach ($rows as $row) {
            if (!in_array((int) $row['item_id'], $seen, true)) {
                self::exec($wpdb->prepare("DELETE FROM {$t} WHERE order_id = %d AND item_id = %d", (int) $order->get_id(), (int) $row['item_id']));
                $pids[] = (int) $row['product_id'];
            }
        }
        return array_values(array_unique($pids));
    }

    /**
     * کسر یک قلم = `_reduced_stock` همان قلم. افزایش کسرِ تأییدشده، تأیید را باطل می‌کند
     * (Core مقدار تازه را ندیده است) — محافظه‌کار، نه دوباره‌شماری.
     *
     * همیشه کالای قلم را برای بازمحاسبه برمی‌گرداند، حتی بی تغییر سطر: ووکامرس خودش `_stock`
     * را عوض کرده (لغو یا استرداد) و عدد مطلق باید از نو ساخته شود.
     *
     * @return int[]
     */
    public static function sync_item($order, $item): array
    {
        global $wpdb;
        $t = self::table();
        $order_id = (int) $order->get_id();
        $item_id = (int) $item->get_id();
        if ($order_id <= 0 || $item_id <= 0) { return []; }
        $product = $item->get_product();
        $reduced = method_exists($item, 'get_meta') ? (float) $item->get_meta('_reduced_stock', true) : 0.0;
        $qty = $product ? (int) ceil($reduced) : 0;
        $pid = $product ? (int) $product->get_id() : 0;

        $rows = self::rows($wpdb->prepare("SELECT product_id, qty, ack_rev FROM {$t} WHERE order_id = %d AND item_id = %d", $order_id, $item_id));
        $row = $rows[0] ?? null;
        $touched = $pid > 0 ? [$pid] : [];
        if ($qty <= 0) {
            if ($row === null) { return $touched; }
            self::exec($wpdb->prepare("DELETE FROM {$t} WHERE order_id = %d AND item_id = %d", $order_id, $item_id));
            return array_values(array_unique(array_merge($touched, [(int) $row['product_id']])));
        }
        if ($row === null) {
            // سفارشی که پیش از نصب دفتر در Core تأیید شده و حالا رویدادی (استرداد) گرفته: کالا
            // پس از نصب با Pull زنده وارد پروتکل شده، پس هر عکس واترمارک‌دار شامل آن است.
            // تنها استنتاج مجاز؛ پاسخ API بی stock هرگز چنین ACKی نمی‌سازد.
            $historical = self::confirmed_before($order) && self::created_before_install($order);
            self::exec($historical
                ? $wpdb->prepare("INSERT INTO {$t} (order_id, item_id, product_id, qty, ack_rev, ack_wh, created_at) VALUES (%d, %d, %d, %d, 0, %s, %d)",
                    $order_id, $item_id, $pid, $qty, (string) lmc_setting('warehouse_id'), time())
                : $wpdb->prepare("INSERT INTO {$t} (order_id, item_id, product_id, qty, ack_rev, ack_wh, created_at) VALUES (%d, %d, %d, %d, NULL, NULL, %d)",
                    $order_id, $item_id, $pid, $qty, time()), 1);
            return $touched;
        }
        if ((int) $row['product_id'] !== $pid || $qty > (int) $row['qty']) {
            self::exec($wpdb->prepare(
                "UPDATE {$t} SET product_id = %d, qty = %d, ack_rev = NULL, ack_wh = NULL WHERE order_id = %d AND item_id = %d",
                $pid, $qty, $order_id, $item_id), 1);
            return array_values(array_unique([$pid, (int) $row['product_id']]));
        }
        if ($qty < (int) $row['qty']) {
            self::exec($wpdb->prepare("UPDATE {$t} SET qty = %d WHERE order_id = %d AND item_id = %d", $qty, $order_id, $item_id), 1);
        }
        return $touched;
    }

    private static function created_before_install($order): bool
    {
        $since = (int) get_option(self::SINCE, 0);
        $created = method_exists($order, 'get_date_created') ? $order->get_date_created() : null;
        return $since > 0 && $created && (int) $created->getTimestamp() < $since;
    }

    /** @return int[] */
    private static function drop_order(int $order_id): array
    {
        global $wpdb;
        $t = self::table();
        $pids = array_map(static fn ($r) => (int) $r['product_id'],
            self::rows($wpdb->prepare("SELECT product_id FROM {$t} WHERE order_id = %d", $order_id)));
        self::exec($wpdb->prepare("DELETE FROM {$t} WHERE order_id = %d", $order_id));
        return array_values(array_unique($pids));
    }

    private static function to_backlog($order, Throwable $e): void
    {
        $backlog = get_option(self::BACKLOG, []);
        $backlog = is_array($backlog) ? $backlog : [];
        $backlog[(int) $order->get_id()] = time();
        $saved = update_option(self::BACKLOG, $backlog, false);
        lmc_log('ثبت کسر موجودی سفارش ' . (int) $order->get_id() . ' ناموفق: ' . $e->getMessage()
            . ($saved ? '؛ تا ثبتش نشاندن موجودی متوقف است.' : '؛ ثبت عقب‌مانده هم ناموفق بود.'));
        if (method_exists($order, 'add_order_note')) {
            $order->add_order_note('لیبل مد — کسر محلی موجودی ثبت نشد؛ تا ثبت دوباره، موجودی سایت از Core به‌روز نمی‌شود.');
        }
    }

    /** عقب‌ماندهٔ کسر را دوباره ثبت می‌کند. true یعنی چیزی جا نماند. */
    public static function drain_backlog(): bool
    {
        $backlog = get_option(self::BACKLOG, []);
        if (!is_array($backlog) || !$backlog) { return true; }
        foreach (array_keys($backlog) as $order_id) {
            $order = function_exists('wc_get_order') ? wc_get_order((int) $order_id) : null;
            try {
                $pids = $order ? self::sync_order($order) : self::drop_order((int) $order_id);
            } catch (LMC_Stock_Ledger_Error $e) {
                return false;
            }
            unset($backlog[$order_id]);
            if (!update_option(self::BACKLOG, $backlog, false) && $backlog) { return false; }
            if (!$backlog) { delete_option(self::BACKLOG); }
            foreach ($pids as $pid) { self::mark_redo($pid); }
        }
        return true;
    }

    /** آیا دفتر کامل است و نشاندن مجاز؟ پیش از آن، پیشرفت محدود هم می‌کند. */
    public static function ready(): bool
    {
        if ((int) get_option(self::SCHEMA_OPTION, 0) < self::SCHEMA_VERSION) {
            self::ensure_schema();
            if ((int) get_option(self::SCHEMA_OPTION, 0) < self::SCHEMA_VERSION) { return false; }
        }
        return self::drain_backlog() && self::reconcile_step(2);
    }

    // ── ACK ─────────────────────────────────────────────────────────────

    /**
     * ACK سفارش از پاسخ Core: `stock` = [{sku, variationId, stockRev}]. پاسخ بی `stock` یا
     * بدشکل هیچ‌چیز تأیید نمی‌کند؛ کسر می‌ماند و یادداشت سفارش علت را می‌گوید.
     */
    public static function ack_order($order, $stock, string $warehouse): void
    {
        if (!is_array($stock) || !preg_match('/^[0-9a-f-]{36}$/D', $warehouse)) {
            if (method_exists($order, 'add_order_note')) {
                $order->add_order_note('لیبل مد — پاسخ Core اثبات شمول موجودی (stock) نداشت؛ کسر محلی تا عکس تأییدشده می‌ماند.');
            }
            return;
        }
        $by_sku = [];
        foreach ($stock as $row) {
            if (is_array($row) && isset($row['sku'], $row['stockRev']) && preg_match('/^[0-9]{1,18}$/D', (string) $row['stockRev'])) {
                $by_sku[(string) $row['sku']] = (int) $row['stockRev'];
            }
        }
        global $wpdb;
        $t = self::table();
        foreach ($order->get_items() as $item_id => $item) {
            if (!is_object($item) || !method_exists($item, 'get_product')) { continue; }
            $product = $item->get_product();
            $sku = $product ? trim((string) $product->get_sku()) : '';
            if ($sku === '' || !isset($by_sku[$sku])) { continue; }
            $iid = (int) (method_exists($item, 'get_id') ? $item->get_id() : $item_id);
            try {
                self::exec($wpdb->prepare(
                    "UPDATE {$t} SET ack_rev = %d, ack_wh = %s WHERE order_id = %d AND item_id = %d AND ack_rev IS NULL",
                    $by_sku[$sku], $warehouse, (int) $order->get_id(), $iid));
            } catch (LMC_Stock_Ledger_Error $e) {
                lmc_log('ثبت ACK موجودی سفارش ' . (int) $order->get_id() . ' ناموفق: ' . $e->getMessage() . '؛ کسر می‌ماند.');
                continue;
            }
            self::recompute((int) $product->get_id());
        }
    }

    // ── خواندن دفتر ─────────────────────────────────────────────────────

    /** جمع کسرهایی که عکس (`$rev`، `$wh`) هنوز در خود ندارد. خطای دیتابیس = استثنا، نه صفر. */
    public static function pending(int $product_id, int $rev, string $wh): int
    {
        global $wpdb;
        $t = self::table();
        $rows = self::rows($wpdb->prepare(
            "SELECT COALESCE(SUM(qty), 0) AS n FROM {$t} WHERE product_id = %d
               AND (ack_rev IS NULL OR ack_wh IS NULL OR ack_wh <> %s OR ack_rev > %d)",
            $product_id, $wh, $rev));
        if (!isset($rows[0]['n'])) { throw new LMC_Stock_Ledger_Error('جمع کسر خوانده نشد'); }
        return (int) $rows[0]['n'];
    }

    /** @return array<int,array<string,mixed>> */
    private static function rows(string $sql): array
    {
        global $wpdb;
        $before = (string) $wpdb->last_error;
        $rows = $wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows) || ((string) $wpdb->last_error !== '' && (string) $wpdb->last_error !== $before)) {
            throw new LMC_Stock_Ledger_Error('خواندن دفتر کسر ناموفق: ' . (string) $wpdb->last_error);
        }
        return $rows;
    }

    private static function exec(string $sql, ?int $expect = null): void
    {
        global $wpdb;
        $done = $wpdb->query($sql);
        if ($done === false || ($expect !== null && (int) $done !== $expect)) {
            throw new LMC_Stock_Ledger_Error('نوشتن دفتر کسر ناموفق: ' . (string) $wpdb->last_error);
        }
    }

    // ── حالت کالا ───────────────────────────────────────────────────────

    /** @return array{w:string,r:int,c:int,a:bool,d:bool}|null */
    public static function state(int $product_id): ?array
    {
        $raw = get_post_meta($product_id, self::STATE_META, true);
        $s = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($s) || !isset($s['w'], $s['r'], $s['c'])) { return null; }
        return ['w' => (string) $s['w'], 'r' => (int) $s['r'], 'c' => (int) $s['c'],
            'a' => ($s['a'] ?? true) !== false, 'd' => !empty($s['d'])];
    }

    private static function write_state(int $product_id, array $s): void
    {
        $json = wp_json_encode(['w' => $s['w'], 'r' => $s['r'], 'c' => $s['c'], 'a' => $s['a'], 'd' => $s['d']]);
        update_post_meta($product_id, self::STATE_META, $json);
        self::fresh_meta($product_id);
        if (get_post_meta($product_id, self::STATE_META, true) !== $json) {
            throw new LMC_Stock_Ledger_Error('حالت موجودی کالا ذخیره نشد');
        }
    }

    private static function restore_state(int $product_id, $raw): void
    {
        if (is_string($raw) && $raw !== '') {
            update_post_meta($product_id, self::STATE_META, $raw);
        } else {
            delete_post_meta($product_id, self::STATE_META);
        }
    }

    public static function lock_name(int $product_id): string
    {
        return LMC_Push_Guard::lock_name($product_id, self::VERSION_META);
    }

    private static function fresh_meta(int $product_id): void
    {
        if (function_exists('wp_cache_delete')) { wp_cache_delete($product_id, 'post_meta'); }
    }

    // ── نشاندن ──────────────────────────────────────────────────────────

    /**
     * عکس واترمارک‌دار Core را زیر قفل کالا می‌نشاند.
     *
     * @param bool $may_enter فقط Pull (خواندن زنده) کالای بی‌حالت را وارد پروتکل می‌کند.
     * @return array{ok:bool,applied:bool,stale?:bool,busy?:bool,blocked?:bool,legacy?:bool,error?:string,display?:int,note?:string}
     */
    public static function apply_snapshot(int $pid, int $available, bool $active, int $rev, string $wh, int $wait, bool $may_enter, ?int $version = null): array
    {
        if (!self::ready()) {
            return ['ok' => false, 'applied' => false, 'blocked' => true, 'note' => 'دفتر کسر کامل نیست'];
        }
        $lock = self::lock_name($pid);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            return ['ok' => false, 'applied' => false, 'busy' => true];
        }
        try {
            self::fresh_meta($pid);
            $state = self::state($pid);
            if ($state === null && !$may_enter) {
                // Push در راه، کالای بیرون از پروتکل: رفتار پیشین (نه ورود).
                return ['legacy' => true] + self::legacy_locked($pid, $available, $version);
            }
            if ($version !== null) {
                $sv = (int) get_post_meta($pid, self::VERSION_META, true);
                if ($sv > 0 && $version <= $sv) {
                    if ($state && $state['d']) { self::recompute_locked($pid); }
                    return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'نسخهٔ قدیمی یا تکراری'];
                }
            }
            if ($state !== null && $state['w'] === $wh && $rev <= $state['r']) {
                if ($state['d']) { self::recompute_locked($pid); }
                return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'واترمارک قدیمی یا تکراری'];
            }
            $prev = get_post_meta($pid, self::STATE_META, true);
            $next = ['w' => $wh, 'r' => $rev, 'c' => max(0, $available), 'a' => $active, 'd' => true];
            self::write_state($pid, $next);
            try {
                $display = self::write_stock($pid, $next);
            } catch (Throwable $e) {
                self::restore_state($pid, $prev);
                lmc_log('نشاندن موجودی کالای ' . $pid . ' ناموفق؛ حالت قبلی برگشت: ' . $e->getMessage());
                return ['ok' => false, 'applied' => false, 'error' => $e->getMessage()];
            }
            $next['d'] = false;
            try { self::write_state($pid, $next); } catch (LMC_Stock_Ledger_Error $e) { self::mark_redo($pid); }
            if ($version !== null) { update_post_meta($pid, self::VERSION_META, $version); }
            return ['ok' => true, 'applied' => true, 'display' => $display];
        } catch (LMC_Stock_Ledger_Error $e) {
            lmc_log('نشاندن موجودی کالای ' . $pid . ' ناموفق: ' . $e->getMessage());
            return ['ok' => false, 'applied' => false, 'error' => $e->getMessage()];
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    /**
     * عکس بی واترمارک (Core پیش از ۰۹۷، یا برگشت API). کالای واردشده به پروتکل آن را **رد**
     * می‌کند؛ کالای بیرون از پروتکل همان رفتار قدیم را دارد.
     */
    public static function apply_legacy(int $pid, int $available, int $wait, ?int $version = null): array
    {
        $lock = self::lock_name($pid);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            return ['ok' => false, 'applied' => false, 'busy' => true];
        }
        try {
            self::fresh_meta($pid);
            if (self::state($pid) !== null) {
                lmc_log('عکس موجودی بی واترمارک برای کالای ' . $pid . ' رد شد؛ کالا در پروتکل واترمارک است.');
                return ['ok' => false, 'applied' => false, 'rejected' => true,
                    'note' => 'عکس بی واترمارک؛ برای بازگشت عمدی «بازنشانی واترمارک» لازم است'];
            }
            return self::legacy_locked($pid, $available, $version);
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    private static function legacy_locked(int $pid, int $available, ?int $version): array
    {
        if ($version !== null) {
            $sv = (int) get_post_meta($pid, self::VERSION_META, true);
            if ($sv > 0 && $version <= $sv) {
                return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'نسخهٔ قدیمی یا تکراری'];
            }
        }
        $product = wc_get_product($pid);
        if (!$product) { return ['ok' => true, 'applied' => false, 'note' => 'کالا خوانده نشد']; }
        $changed = LMC_Stock_Sync::apply_stock($product, max(0, $available));
        if ($changed) { $product->save(); }
        if ($version !== null) { update_post_meta($pid, self::VERSION_META, $version); }
        return ['ok' => true, 'applied' => $changed];
    }

    /** @param array{w:string,r:int,c:int,a:bool} $s */
    private static function write_stock(int $pid, array $s): int
    {
        $product = wc_get_product($pid);
        if (!$product) { throw new LMC_Stock_Ledger_Error('کالا خوانده نشد'); }
        $display = $s['a'] ? max(0, $s['c'] - self::pending($pid, $s['r'], $s['w'])) : 0;
        if (LMC_Stock_Sync::apply_stock($product, $display)) {
            $saved = $product->save();
            if (!$saved) { throw new LMC_Stock_Ledger_Error('ذخیرهٔ کالا ناموفق'); }
        }
        return $display;
    }

    private static function recompute_locked(int $pid): bool
    {
        $s = self::state($pid);
        if ($s === null) { return false; }
        self::write_stock($pid, $s);
        if ($s['d']) { $s['d'] = false; self::write_state($pid, $s); }
        return true;
    }

    /**
     * بازمحاسبه از آخرین حالت. تا عقب‌ماندهٔ کسر هست، یا قفل نرسید، یا نوشتن شکست خورد،
     * کالا در فهرست «دوباره» می‌نشیند تا `maintain()` آن را بسازد — بی‌صدا رها نمی‌شود.
     */
    public static function recompute(int $pid, int $wait = self::LOCK_WAIT): bool
    {
        $backlog = get_option(self::BACKLOG, []);
        if (is_array($backlog) && $backlog) { self::mark_redo($pid); return false; }
        $lock = self::lock_name($pid);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            self::mark_redo($pid);
            return false;
        }
        try {
            self::fresh_meta($pid);
            return self::recompute_locked($pid);
        } catch (Throwable $e) {
            self::mark_redo($pid);
            lmc_log('بازمحاسبهٔ موجودی کالای ' . $pid . ' ناموفق: ' . $e->getMessage());
            return false;
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    private static function mark_redo(int $pid): void
    {
        $redo = get_option(self::REDO, []);
        $redo = is_array($redo) ? $redo : [];
        $redo[$pid] = time();
        update_option(self::REDO, $redo, false);
    }

    /** نگه‌داری در هر Pull: عقب‌ماندهٔ کسر، آشتی اولیه، و بازمحاسبهٔ کالاهای «دوباره». */
    public static function maintain(): bool
    {
        if (!self::ready()) { return false; }
        $redo = get_option(self::REDO, []);
        if (!is_array($redo) || !$redo) { return true; }
        foreach (array_keys($redo) as $pid) {
            $lock = self::lock_name((int) $pid);
            if (!LMC_Push_Guard::acquire($lock, 0)) { continue; }
            try {
                self::fresh_meta((int) $pid);
                self::recompute_locked((int) $pid);
                unset($redo[$pid]);
            } catch (Throwable $e) {
                lmc_log('بازمحاسبهٔ موجودی کالای ' . (int) $pid . ' هنوز ناموفق: ' . $e->getMessage());
            } finally {
                LMC_Push_Guard::release($lock);
            }
        }
        $redo ? update_option(self::REDO, $redo, false) : delete_option(self::REDO);
        return !$redo;
    }

    // ── بازنشانی صریح ───────────────────────────────────────────────────

    /**
     * «بازنشانی واترمارک»: پس از بازیابی Core از بکاپ قدیمی‌تر یا برگشت عمدی به Core قدیم.
     * حالت همهٔ کالاها پاک و مکان‌نما صفر می‌شود؛ Pull بعدی دوباره واردشان می‌کند. کسرها
     * می‌مانند. فقط مدیر فروشگاه با Nonce.
     */
    public static function handle_reset(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_stock_reset');
        delete_post_meta_by_key(self::STATE_META);
        delete_option(LMC_Stock_Sync::CURSOR_OPTION);
        lmc_log('واترمارک موجودی همهٔ کالاها با دستور مدیر بازنشانی شد.');
        $res = LMC_Stock_Sync::run();
        wp_safe_redirect(add_query_arg(['lmc_msg' => 'synced', 'lmc_count' => $res['updated'],
            'lmc_detail' => rawurlencode('واترمارک بازنشانی شد. ' . LMC_Stock_Sync::manual_summary($res))],
            admin_url('admin.php?page=labelmod-connector')));
        exit;
    }
}
