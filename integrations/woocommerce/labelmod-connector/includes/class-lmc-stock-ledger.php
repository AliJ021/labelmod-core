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
    /** خرابی پایدار: نوشتن نشانهٔ پایدار هم شکست خورد. فقط بازنشانی مدیر پاکش می‌کند. */
    const FAULT           = 'lmc_stock_fault';
    /** دورهٔ واترمارک؛ «بازنشانی» آن را جلو می‌برد و ACKهای دورهٔ قبل بی‌اعتبار می‌شوند. */
    const EPOCH           = 'lmc_stock_epoch';
    /** حصاری که پردازه‌اش مرده: پس از این مدت از دادهٔ خود ووکامرس بازسازی می‌شود. */
    const FENCE_STALE     = 900;
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
            confirmed TINYINT UNSIGNED NOT NULL DEFAULT 1,
            ack_rev BIGINT UNSIGNED NULL,
            ack_wh VARCHAR(36) NULL,
            ack_epoch INT UNSIGNED NULL,
            ack_at BIGINT UNSIGNED NULL,
            created_at BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY  (order_id,item_id),
            KEY product_id (product_id)
        ) {$collate}";
        // نشانه‌های پایدار: یک سطر برای هر رویداد با token خودش. نوشتن یک INSERT است و پاک‌کردن
        // فقط tokenهایی که خوانده شده‌اند؛ پس هیچ نشانهٔ هم‌زمانی گم نمی‌شود (برخلاف آرایهٔ option).
        $marks = self::marks_table();
        $sql2 = "CREATE TABLE {$marks} (
            kind VARCHAR(8) NOT NULL,
            ref BIGINT UNSIGNED NOT NULL,
            token VARCHAR(40) NOT NULL,
            at BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY  (kind,ref,token),
            KEY at (at)
        ) {$collate}";
        if (!function_exists('dbDelta')) {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        }
        dbDelta($sql);
        dbDelta($sql2);
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

    public static function marks_table(): string
    {
        global $wpdb;
        return $wpdb->prefix . 'lmc_stock_mark';
    }

    public static function table_exists(): bool
    {
        global $wpdb;
        foreach ([self::table(), self::marks_table()] as $t) {
            if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $t)) !== $t) { return false; }
        }
        return true;
    }

    // ── نشانه‌های پایدار (عقب‌مانده، بازمحاسبه، حصار) ─────────────────────

    /** درج یک نشانه؛ token برمی‌گردد یا null. شکست نوشتن = خرابی پایدار (fault). */
    public static function mark(string $kind, int $ref): ?string
    {
        global $wpdb;
        $t = self::marks_table();
        $token = bin2hex(random_bytes(10));
        $done = $wpdb->query($wpdb->prepare("INSERT INTO {$t} (kind, ref, token, at) VALUES (%s, %d, %s, %d)", $kind, $ref, $token, time()));
        if ($done !== 1) {
            self::fault("نشانهٔ {$kind}:{$ref} ثبت نشد: " . (string) $wpdb->last_error);
            return null;
        }
        return $token;
    }

    /** @return array<int,array{ref:int,token:string,at:int}> */
    private static function marked(string $kind, ?int $ref = null): array
    {
        global $wpdb;
        $t = self::marks_table();
        $rows = $ref === null
            ? self::rows($wpdb->prepare("SELECT ref, token, at FROM {$t} WHERE kind = %s", $kind))
            : self::rows($wpdb->prepare("SELECT ref, token, at FROM {$t} WHERE kind = %s AND ref = %d", $kind, $ref));
        return array_map(static fn ($r) => ['ref' => (int) $r['ref'], 'token' => (string) $r['token'], 'at' => (int) $r['at']], $rows);
    }

    /** فقط همان tokenها پاک می‌شوند؛ نشانهٔ تازه‌ای که هم‌زمان نوشته شده می‌ماند. */
    private static function unmark(string $kind, int $ref, array $tokens): void
    {
        global $wpdb;
        $t = self::marks_table();
        foreach ($tokens as $token) {
            self::exec($wpdb->prepare("DELETE FROM {$t} WHERE kind = %s AND ref = %d AND token = %s", $kind, $ref, (string) $token));
        }
    }

    /**
     * خرابی پایدار: نوشتن کسر و نشانهٔ پایدارش هر دو شکست خورده‌اند (معمولاً جدول خراب یا
     * ناموجود). مقدار در wp_options است، جدولی جدا از دفتر؛ فقط «بازنشانی» مدیر پاکش می‌کند.
     * اگر این هم نوشته نشود (شکست کل دیتابیس) چیزی برای محافظت باقی نمی‌ماند؛ آن‌وقت کسر خود
     * ووکامرس هم نوشته نشده است. این مرز در سند پروتکل آمده.
     */
    public static function fault(string $why): void
    {
        update_option(self::FAULT, time(), false);
        $ok = (int) get_option(self::FAULT, 0) > 0;
        lmc_log('خرابی دفتر کسر موجودی: ' . $why . ($ok ? '؛ نشاندن موجودی تا بازنشانی مدیر متوقف است.' : '؛ ثبت خرابی هم ناموفق بود.'));
    }

    public static function epoch(): int
    {
        return max(1, (int) get_option(self::EPOCH, 1));
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
        // پیش از تغییر `_stock`: نیت کسر (در حلقهٔ wc_reduce_stock_levels) و حصار کالا.
        add_filter('woocommerce_can_reduce_order_stock', [__CLASS__, 'on_can_reduce'], PHP_INT_MAX, 2);
        add_filter('woocommerce_order_item_quantity', [__CLASS__, 'on_item_quantity'], PHP_INT_MAX, 3);
        add_action('woocommerce_product_before_set_stock', [__CLASS__, 'on_before_set_stock'], 10, 1);
        add_action('woocommerce_variation_before_set_stock', [__CLASS__, 'on_before_set_stock'], 10, 1);
        add_action('woocommerce_reduce_order_stock', [__CLASS__, 'on_reduce_done'], 10, 1);
        add_action('shutdown', [__CLASS__, 'shutdown'], 10, 0);
        add_action('woocommerce_reduce_order_item_stock', [__CLASS__, 'on_reduce'], 10, 3);
        add_action('woocommerce_restore_order_item_stock', [__CLASS__, 'on_restore'], 10, 4);
        add_action('woocommerce_update_order_item', [__CLASS__, 'on_item_saved'], 10, 3);
        add_action('woocommerce_restock_refunded_item', [__CLASS__, 'on_refund_restock'], 10, 5);
        add_action('woocommerce_delete_order', [__CLASS__, 'on_order_deleted'], 10, 1);
        // لغو سفارشی که کسرش وسط کار مرده: ووکامرس (پرچم کسر false) چیزی برنمی‌گرداند و هیچ Hook
        // قلمی اجرا نمی‌شود؛ نیت باید همین‌جا حل شود.
        add_action('woocommerce_order_status_changed', [__CLASS__, 'on_status_changed'], 20, 1);
        add_action('admin_post_lmc_stock_reset', [__CLASS__, 'handle_reset']);
    }

    /** @var array<string,int> token حصارهای همین درخواست → کالا */
    private static array $own = [];
    /** @var array<int,bool> سفارش‌هایی که همین درخواست وسط wc_reduce_stock_levels است */
    private static array $reducing = [];

    /**
     * WC 11.1.1، `wc_reduce_stock_levels`: این فیلتر در آغاز، پیش از حلقهٔ کسر اجرا می‌شود.
     * با اولویت آخر، فقط وقتی کسر واقعاً انجام می‌شود پرچم می‌گیرد.
     */
    public static function on_can_reduce($can, $order = null)
    {
        if ($can && is_object($order) && method_exists($order, 'get_id')) { self::$reducing[(int) $order->get_id()] = true; }
        return $can;
    }

    /**
     * WC 11.1.1: در حلقهٔ کسر، این فیلتر درست پیش از `wc_update_product_stock(..., 'decrease')`
     * و فقط برای قلمی که هنوز کسر نخورده اعمال می‌شود. «نیت کسر» همین‌جا، **پیش از** تغییر
     * `_stock`، پایدار می‌شود؛ پس هر عکسی که میان کسر و `_reduced_stock` نشانده شود آن را
     * کم می‌کند و مرگ پردازه پیش از Hook واحد را برنمی‌گرداند. مقدار فیلتر دست نمی‌خورد.
     */
    public static function on_item_quantity($qty, $order = null, $item = null)
    {
        if (!is_object($order) || !is_object($item) || empty(self::$reducing[(int) $order->get_id()])) { return $qty; }
        try {
            self::record_intent($order, $item, (int) ceil((float) $qty));
        } catch (LMC_Stock_Ledger_Error $e) {
            self::fault('نیت کسر سفارش ' . (int) $order->get_id() . ' ثبت نشد: ' . $e->getMessage());
        }
        return $qty;
    }

    /**
     * WC 11.1.1، `wc_update_product_stock`: پیش از هر نوشتن `_stock` با API ووکامرس. حصار تا
     * پایان همین درخواست (یا ذخیرهٔ `_reduced_stock`) نشاندن عکس دیگران را روی این کالا می‌بندد؛
     * قفل مشورتی ما نوشتن خود ووکامرس را پوشش نمی‌داد.
     */
    public static function on_before_set_stock($product): void
    {
        if (!is_object($product) || !method_exists($product, 'get_id')) { return; }
        $pid = (int) $product->get_id();
        $token = self::mark('mut', $pid);
        if ($token !== null) { self::$own[$token] = $pid; }
    }

    /** پایان حلقهٔ کسر: نیت‌هایی که کسر نخوردند (خطای ووکامرس) پاک می‌شوند. */
    public static function on_reduce_done($order): void
    {
        if (!is_object($order)) { return; }
        unset(self::$reducing[(int) $order->get_id()]);
        self::sync_order_safe($order, true);
    }

    /**
     * پایان درخواست: حصارهای همین درخواست برداشته و کالاها بازمحاسبه می‌شوند — مگر درخواست با
     * خطای مهلک تمام شده باشد؛ آن‌وقت حصار می‌ماند تا `maintain()` از دادهٔ ووکامرس بازسازی کند.
     */
    public static function shutdown(): void
    {
        if (!self::$own) { return; }
        $err = error_get_last();
        if (is_array($err) && in_array($err['type'] ?? 0, [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR], true)) {
            return;
        }
        self::release_own_fences();
    }

    private static function release_own_fences(): void
    {
        $by_pid = [];
        foreach (self::$own as $token => $pid) { $by_pid[$pid][] = $token; }
        self::$own = [];
        foreach ($by_pid as $pid => $tokens) {
            try { self::unmark('mut', (int) $pid, $tokens); } catch (LMC_Stock_Ledger_Error $e) { lmc_log('برداشتن حصار کالای ' . $pid . ' ناموفق: ' . $e->getMessage()); continue; }
            self::recompute((int) $pid);
        }
    }

    /** وضعیت هر درخواست؛ پردازه‌های بلند (CLI) و آزمون میان دو «درخواست» صدایش می‌زنند. */
    public static function new_request(): void
    {
        self::$own = [];
        self::$reducing = [];
    }

    /** آیا پردازهٔ دیگری الان `_stock` این کالا را عوض می‌کند (یا وسط کار مرده)؟ */
    private static function fenced(int $pid): bool
    {
        foreach (self::marked('mut', $pid) as $m) {
            if (!isset(self::$own[$m['token']])) { return true; }
        }
        return false;
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

    public static function on_status_changed($order_id): void
    {
        $order = function_exists('wc_get_order') ? wc_get_order((int) $order_id) : null;
        if ($order) { self::sync_order_safe($order); }
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

    public static function sync_order_safe($order, bool $finished = false): bool
    {
        try {
            $pids = self::sync_order($order, $finished);
        } catch (LMC_Stock_Ledger_Error $e) {
            self::to_backlog($order, $e);
            return false;
        }
        foreach ($pids as $pid) { self::recompute($pid); }
        return true;
    }

    /** @return int[] کالاهایی که کسرشان عوض شد. */
    public static function sync_order($order, bool $finished = false): array
    {
        global $wpdb;
        $t = self::table();
        $pids = [];
        $seen = [];
        foreach ($order->get_items() as $item_id => $item) {
            if (!is_object($item) || !method_exists($item, 'get_product')) { continue; }
            $seen[] = (int) (method_exists($item, 'get_id') ? $item->get_id() : $item_id);
            $pids = array_merge($pids, self::sync_item($order, $item, $finished));
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
    public static function sync_item($order, $item, bool $finished = false): array
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

        $rows = self::rows($wpdb->prepare("SELECT product_id, qty, ack_rev, confirmed FROM {$t} WHERE order_id = %d AND item_id = %d", $order_id, $item_id));
        $row = $rows[0] ?? null;
        $touched = $pid > 0 ? [$pid] : [];
        if ($qty <= 0) {
            if ($row === null) { return $touched; }
            // نیتی که هنوز `_reduced_stock` نگرفته فقط وقتی پاک می‌شود که ووکامرس قطعاً کسرش
            // نکرده: حلقهٔ کسر تمام شده، سفارش لغو/ناموفق است، یا پرچم کسر سفارش خورده و این
            // درخواست وسط حلقه نیست. وگرنه (مرگ پردازه وسط کسر) می‌ماند — محافظه‌کار.
            if ((int) $row['confirmed'] === 0 && !self::intent_resolved($order, $finished)) { return $touched; }
            self::exec($wpdb->prepare("DELETE FROM {$t} WHERE order_id = %d AND item_id = %d", $order_id, $item_id));
            return array_values(array_unique(array_merge($touched, [(int) $row['product_id']])));
        }
        if ($row === null) {
            // سفارشی که پیش از نصب دفتر در Core تأیید شده و حالا رویدادی (استرداد) گرفته: کالا
            // پس از نصب با Pull زنده وارد پروتکل شده، پس هر عکس واترمارک‌دار شامل آن است.
            // تنها استنتاج مجاز؛ پاسخ API بی stock هرگز چنین ACKی نمی‌سازد.
            $historical = self::confirmed_before($order) && self::created_before_install($order);
            self::exec($historical
                ? $wpdb->prepare("INSERT INTO {$t} (order_id, item_id, product_id, qty, confirmed, ack_rev, ack_wh, ack_epoch, ack_at, created_at) VALUES (%d, %d, %d, %d, 1, 0, %s, %d, %d, %d)",
                    $order_id, $item_id, $pid, $qty, (string) lmc_setting('warehouse_id'), self::epoch(), time(), time())
                : $wpdb->prepare("INSERT INTO {$t} (order_id, item_id, product_id, qty, confirmed, created_at) VALUES (%d, %d, %d, %d, 1, %d)",
                    $order_id, $item_id, $pid, $qty, time()), 1);
            return $touched;
        }
        if ((int) $row['confirmed'] === 0) {
            // نیت پیش از کسر حالا با `_reduced_stock` واقعی تأیید می‌شود؛ ACK هنوز ندارد.
            self::exec($wpdb->prepare(
                "UPDATE {$t} SET product_id = %d, qty = %d, confirmed = 1 WHERE order_id = %d AND item_id = %d",
                $pid, $qty, $order_id, $item_id), 1);
            return array_values(array_unique([$pid, (int) $row['product_id']]));
        }
        if ((int) $row['product_id'] !== $pid || $qty > (int) $row['qty']) {
            self::exec($wpdb->prepare(
                "UPDATE {$t} SET product_id = %d, qty = %d, ack_rev = NULL, ack_wh = NULL, ack_epoch = NULL, ack_at = NULL WHERE order_id = %d AND item_id = %d",
                $pid, $qty, $order_id, $item_id), 1);
            return array_values(array_unique([$pid, (int) $row['product_id']]));
        }
        if ($qty < (int) $row['qty']) {
            self::exec($wpdb->prepare("UPDATE {$t} SET qty = %d WHERE order_id = %d AND item_id = %d", $qty, $order_id, $item_id), 1);
        }
        return $touched;
    }

    /** نیت پیش از کسر (سطر confirmed=0)؛ پاک نمی‌شود، فقط با `_reduced_stock` تأیید یا با حل‌شدن حذف. */
    private static function record_intent($order, $item, int $qty): void
    {
        global $wpdb;
        $t = self::table();
        $product = method_exists($item, 'get_product') ? $item->get_product() : null;
        $iid = method_exists($item, 'get_id') ? (int) $item->get_id() : 0;
        if (!$product || $iid <= 0 || $qty <= 0) { return; }
        $pid = (int) $product->get_id();
        $oid = (int) $order->get_id();
        $rows = self::rows($wpdb->prepare("SELECT confirmed FROM {$t} WHERE order_id = %d AND item_id = %d", $oid, $iid));
        if (!$rows) {
            self::exec($wpdb->prepare(
                "INSERT INTO {$t} (order_id, item_id, product_id, qty, confirmed, created_at) VALUES (%d, %d, %d, %d, 0, %d)",
                $oid, $iid, $pid, $qty, time()), 1);
        } elseif ((int) $rows[0]['confirmed'] === 0) {
            self::exec($wpdb->prepare("UPDATE {$t} SET product_id = %d, qty = %d WHERE order_id = %d AND item_id = %d AND confirmed = 0",
                $pid, $qty, $oid, $iid));
        }
    }

    private static function intent_resolved($order, bool $finished): bool
    {
        if ($finished) { return true; }
        if (method_exists($order, 'has_status') && $order->has_status(['cancelled', 'failed', 'refunded', 'trash'])) { return true; }
        if (!empty(self::$reducing[(int) $order->get_id()])) { return false; }
        $store = method_exists($order, 'get_data_store') ? $order->get_data_store() : null;
        return $store && method_exists($store, 'get_stock_reduced') && (bool) $store->get_stock_reduced((int) $order->get_id());
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
        $token = self::mark('order', (int) $order->get_id());
        lmc_log('ثبت کسر موجودی سفارش ' . (int) $order->get_id() . ' ناموفق: ' . $e->getMessage()
            . ($token !== null ? '؛ در عقب‌مانده نشست و تا ثبتش نشاندن موجودی متوقف است.' : '؛ خرابی پایدار ثبت شد.'));
        if (method_exists($order, 'add_order_note')) {
            $order->add_order_note('لیبل مد — کسر محلی موجودی ثبت نشد؛ تا ثبت دوباره، موجودی سایت از Core به‌روز نمی‌شود.');
        }
    }

    /**
     * عقب‌ماندهٔ کسر را دوباره ثبت می‌کند. فقط tokenهایی پاک می‌شوند که پیش از همگام‌سازی
     * خوانده شده‌اند؛ شکستی که هم‌زمان ثبت شود سطر خودش را دارد و می‌ماند.
     */
    public static function drain_backlog(): bool
    {
        try {
            $rows = self::marked('order');
        } catch (LMC_Stock_Ledger_Error $e) {
            return false;
        }
        $by_order = [];
        foreach ($rows as $r) { $by_order[$r['ref']][] = $r['token']; }
        foreach ($by_order as $order_id => $tokens) {
            $order = function_exists('wc_get_order') ? wc_get_order((int) $order_id) : null;
            try {
                $pids = $order ? self::sync_order($order) : self::drop_order((int) $order_id);
                self::unmark('order', (int) $order_id, $tokens);
            } catch (LMC_Stock_Ledger_Error $e) {
                return false;
            }
            foreach ($pids as $pid) { self::mark_redo($pid); }
        }
        try {
            return self::marked('order') === [];
        } catch (LMC_Stock_Ledger_Error $e) {
            return false;
        }
    }

    /** آیا دفتر کامل است و نشاندن مجاز؟ پیش از آن، پیشرفت محدود هم می‌کند. */
    public static function ready(): bool
    {
        if ((int) get_option(self::SCHEMA_OPTION, 0) < self::SCHEMA_VERSION) {
            self::ensure_schema();
            if ((int) get_option(self::SCHEMA_OPTION, 0) < self::SCHEMA_VERSION) { return false; }
        }
        if ((int) get_option(self::FAULT, 0) > 0) { return false; }
        return self::drain_backlog() && self::reconcile_step(2);
    }

    // ── ACK ─────────────────────────────────────────────────────────────

    /**
     * ACK سفارش از پاسخ Core: `stock` = [{sku, variationId, stockRev}].
     *
     * - پاسخ بی `stock` یا بدشکل هیچ‌چیز تأیید نمی‌کند.
     * - `$sent` تعداد **همان درخواست** برای هر قلم است (item_id → qty). قلمی که در درخواست نبوده
     *   تأیید نمی‌شود، و تأیید شرطی است: `qty <= تعداد ارسالی`، در **همان** UPDATE. پس افزایش
     *   تعداد حین درخواست (یا ACK کهنهٔ درخواست قبلی) هیچ‌چیز تأیید نمی‌کند — حتی اگر افزایش
     *   میان خواندن و نوشتن ما رخ دهد. کاهش (استرداد) تأیید را نگه می‌دارد؛ Core بیشتر دارد.
     * - تأیید با دورهٔ جاری ثبت می‌شود؛ پس از «بازنشانی» تأییدهای دورهٔ قبل اثبات نیستند.
     *
     * @param array<int,int> $sent
     */
    public static function ack_order($order, $stock, string $warehouse, array $sent): void
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
        $unproven = 0;
        foreach ($order->get_items() as $item_id => $item) {
            if (!is_object($item) || !method_exists($item, 'get_product')) { continue; }
            $product = $item->get_product();
            $sku = $product ? trim((string) $product->get_sku()) : '';
            $iid = (int) (method_exists($item, 'get_id') ? $item->get_id() : $item_id);
            if ($sku === '' || !isset($by_sku[$sku]) || !isset($sent[$iid])) { $unproven++; continue; }
            try {
                $done = $wpdb->query($wpdb->prepare(
                    "UPDATE {$t} SET ack_rev = %d, ack_wh = %s, ack_epoch = %d, ack_at = %d
                      WHERE order_id = %d AND item_id = %d AND ack_rev IS NULL AND confirmed = 1 AND qty <= %d",
                    $by_sku[$sku], $warehouse, self::epoch(), time(), (int) $order->get_id(), $iid, (int) $sent[$iid]));
                if ($done === false) { throw new LMC_Stock_Ledger_Error((string) $wpdb->last_error); }
            } catch (LMC_Stock_Ledger_Error $e) {
                lmc_log('ثبت ACK موجودی سفارش ' . (int) $order->get_id() . ' ناموفق: ' . $e->getMessage() . '؛ کسر می‌ماند.');
                continue;
            }
            self::recompute((int) $product->get_id());
        }
        if ($unproven > 0 && method_exists($order, 'add_order_note')) {
            $order->add_order_note(sprintf('لیبل مد — %d قلم در پاسخ Core اثبات تعداد ارسالی نداشت؛ کسر محلی‌شان می‌ماند.', $unproven));
        }
    }

    /**
     * تعداد ارسالی هر قلم از Payload یخ‌زده و نگاشت قلم → شمارهٔ سطر (۱-مبنا).
     *
     * @return array<int,int>
     */
    public static function sent_from($payload, $map): array
    {
        $out = [];
        if (!is_array($payload) || !is_array($map) || !isset($payload['lines']) || !is_array($payload['lines'])) { return $out; }
        foreach ($map as $item_id => $line_no) {
            $line = $payload['lines'][(int) $line_no - 1] ?? null;
            if (is_array($line) && isset($line['qty']) && preg_match('/^[0-9]+(?:\.[0-9]+)?$/D', (string) $line['qty'])) {
                $out[(int) $item_id] = (int) floor((float) $line['qty']);
            }
        }
        return $out;
    }

    // ── خواندن دفتر ─────────────────────────────────────────────────────

    /** جمع کسرهایی که عکس (`$rev`، `$wh`) هنوز در خود ندارد. خطای دیتابیس = استثنا، نه صفر. */
    public static function pending(int $product_id, int $rev, string $wh): int
    {
        global $wpdb;
        $t = self::table();
        $rows = self::rows($wpdb->prepare(
            "SELECT COALESCE(SUM(qty), 0) AS n FROM {$t} WHERE product_id = %d
               AND (ack_rev IS NULL OR ack_wh IS NULL OR ack_wh <> %s OR ack_epoch IS NULL OR ack_epoch <> %d OR ack_rev > %d)",
            $product_id, $wh, self::epoch(), $rev));
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
            if (self::fenced($pid)) {
                // ووکامرس در پردازهٔ دیگری `_stock` این کالا را عوض می‌کند (یا وسط کار مرده است).
                return ['ok' => false, 'applied' => false, 'busy' => true, 'note' => 'کالا زیر حصار تغییر ووکامرس'];
            }
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

    /**
     * نوشتن عدد مطلق، با بازبینی **پس از** ذخیره.
     *
     * ووکامرس در پردازه‌ای دیگر می‌تواند میان خواندن `pending` و `save()` ما نیتش را ثبت و `_stock`
     * را کم کند. آن‌وقت ذخیرهٔ ما کسرش را بازنویسی می‌کند. چون نیت **پیش از** کسر ووکامرس ثبت
     * می‌شود، هر کسری که ما بازنویسی کرده باشیم در خواندن دوبارهٔ `pending` دیده می‌شود و عدد
     * دوباره نوشته می‌شود. کسری که پس از خواندن دوباره برسد، عدد درست ما را کم می‌کند: لحظه‌ای
     * کمتر، نه بیشتر، تا Hook خودش بازمحاسبه کند. اگر حصار تازه‌ای بی نیت ظاهر شود (ویرایش دستی
     * قلم)، پایان همان درخواست بازمحاسبه می‌کند و کالا در «دوباره» هم می‌نشیند.
     *
     * @param array{w:string,r:int,c:int,a:bool} $s
     */
    private static function write_stock(int $pid, array $s): int
    {
        $display = 0;
        for ($round = 0; $round < 3; $round++) {
            $product = wc_get_product($pid);
            if (!$product) { throw new LMC_Stock_Ledger_Error('کالا خوانده نشد'); }
            $pending = $s['a'] ? self::pending($pid, $s['r'], $s['w']) : 0;
            $display = $s['a'] ? max(0, $s['c'] - $pending) : 0;
            if (LMC_Stock_Sync::apply_stock($product, $display)) {
                $saved = $product->save();
                if (!$saved) { throw new LMC_Stock_Ledger_Error('ذخیرهٔ کالا ناموفق'); }
            }
            $after = $s['a'] ? self::pending($pid, $s['r'], $s['w']) : 0;
            if (self::fenced($pid)) { self::mark_redo($pid); }
            if ($after === $pending) { return $display; }
        }
        self::mark_redo($pid);
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
        try {
            $blocked = (int) get_option(self::FAULT, 0) > 0 || self::marked('order') !== [] || self::fenced($pid);
        } catch (LMC_Stock_Ledger_Error $e) {
            $blocked = true;
        }
        if ($blocked) { self::mark_redo($pid); return false; }
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
        self::mark('redo', $pid);
    }

    /**
     * نگه‌داری در هر Pull: عقب‌ماندهٔ کسر، آشتی اولیه، بازسازی حصارهای مرده از دادهٔ ووکامرس و
     * بازمحاسبهٔ کالاهای «دوباره». هر نشانه فقط با token خوانده‌شده‌اش پاک می‌شود.
     */
    public static function maintain(): bool
    {
        if (!self::ready()) { return false; }
        try {
            foreach (self::marked('mut') as $m) {
                if ($m['at'] > time() - self::FENCE_STALE || isset(self::$own[$m['token']])) { continue; }
                self::rebuild_product($m['ref']);
                self::unmark('mut', $m['ref'], [$m['token']]);
                self::mark_redo($m['ref']);
            }
            $redo = self::marked('redo');
        } catch (LMC_Stock_Ledger_Error $e) {
            lmc_log('نگه‌داری دفتر کسر ناموفق: ' . $e->getMessage());
            return false;
        }
        $left = 0;
        $by_pid = [];
        foreach ($redo as $r) { $by_pid[$r['ref']][] = $r['token']; }
        foreach ($by_pid as $pid => $tokens) {
            $lock = self::lock_name((int) $pid);
            if (self::fenced((int) $pid) || !LMC_Push_Guard::acquire($lock, 0)) { $left++; continue; }
            try {
                self::fresh_meta((int) $pid);
                self::recompute_locked((int) $pid);
                self::unmark('redo', (int) $pid, $tokens);
            } catch (Throwable $e) {
                $left++;
                lmc_log('بازمحاسبهٔ موجودی کالای ' . (int) $pid . ' هنوز ناموفق: ' . $e->getMessage());
            } finally {
                LMC_Push_Guard::release($lock);
            }
        }
        return $left === 0;
    }

    /**
     * بازسازی کسرهای یک کالا از دادهٔ خود ووکامرس، پس از حصاری که پردازه‌اش مرده است: هر سفارشِ
     * دارای قلمی از این کالا با `_reduced_stock` (جدول اقلام سفارش؛ با HPOS هم همین است) یا با
     * سطری در دفتر، دوباره همگام می‌شود. نیتِ بی `_reduced_stock` تا حل‌شدن (پرچم کسر سفارش،
     * لغو) می‌ماند؛ پس مرگ میان کسر و Hook واحد را برنمی‌گرداند. فقط خواندن جدول ووکامرس.
     */
    private static function rebuild_product(int $pid): void
    {
        global $wpdb;
        $items = $wpdb->prefix . 'woocommerce_order_items';
        $meta  = $wpdb->prefix . 'woocommerce_order_itemmeta';
        $ids = array_map(static fn ($r) => (int) $r['order_id'], self::rows($wpdb->prepare(
            "SELECT DISTINCT oi.order_id AS order_id FROM {$items} oi
               JOIN {$meta} p ON p.order_item_id = oi.order_item_id AND p.meta_key IN ('_product_id', '_variation_id') AND p.meta_value = %s
               JOIN {$meta} r ON r.order_item_id = oi.order_item_id AND r.meta_key = '_reduced_stock'
              WHERE oi.order_item_type = 'line_item'", (string) $pid)));
        $t = self::table();
        foreach (self::rows($wpdb->prepare("SELECT DISTINCT order_id FROM {$t} WHERE product_id = %d", $pid)) as $r) {
            $ids[] = (int) $r['order_id'];
        }
        foreach (array_unique($ids) as $oid) {
            $order = function_exists('wc_get_order') ? wc_get_order($oid) : null;
            if (!$order) { self::drop_order($oid); continue; }
            $has_rows = self::rows($wpdb->prepare("SELECT 1 FROM {$t} WHERE order_id = %d LIMIT 1", $oid)) !== [];
            if (!$has_rows && (self::confirmed_before($order) || !self::connector_owned($order))) { continue; }
            self::sync_order($order);
        }
    }

    // ── بازنشانی صریح ───────────────────────────────────────────────────

    /**
     * دورهٔ تازه: تأییدهای دورهٔ قبل دیگر اثبات نیستند (بازیابی Core سفارش‌های پس از بکاپ را
     * ندارد). فقط تأییدی که **پیش از** زمان بکاپِ بازیابی‌شده دریافت شده — یعنی Commit آن
     * سفارش در بکاپ هست — به دورهٔ تازه منتقل می‌شود (واترمارک ۰، چون کالاها با Pull زندهٔ
     * Core بازیابی‌شده دوباره وارد می‌شوند). بی زمان بکاپ، هیچ تأییدی منتقل نمی‌شود.
     */
    public static function reset_epoch(?int $restore_point): int
    {
        global $wpdb;
        $t = self::table();
        $old = self::epoch();
        update_option(self::EPOCH, $old + 1, false);
        if (self::epoch() !== $old + 1) { throw new LMC_Stock_Ledger_Error('دورهٔ تازه ثبت نشد'); }
        delete_post_meta_by_key(self::STATE_META);
        delete_option(LMC_Stock_Sync::CURSOR_OPTION);
        if ($restore_point === null) { return 0; }
        $done = $wpdb->query($wpdb->prepare(
            "UPDATE {$t} SET ack_rev = 0, ack_epoch = %d WHERE ack_epoch = %d AND ack_at IS NOT NULL AND ack_at < %d",
            $old + 1, $old, $restore_point));
        return is_int($done) ? $done : 0;
    }

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
        $raw = isset($_POST['lmc_restore_point']) ? trim((string) wp_unslash($_POST['lmc_restore_point'])) : '';
        $point = $raw === '' ? null : strtotime($raw . ' UTC');
        if ($raw !== '' && $point === false) {
            wp_die(esc_html__('زمان بکاپ بازیابی‌شده خوانا نیست.', 'labelmod-connector'));
        }
        try {
            $carried = self::reset_epoch($point === null ? null : (int) $point);
        } catch (LMC_Stock_Ledger_Error $e) {
            wp_die(esc_html($e->getMessage()));
        }
        delete_option(self::FAULT);
        lmc_log(sprintf('واترمارک موجودی با دستور مدیر بازنشانی شد؛ %d تأیید پیش از زمان بکاپ منتقل شد، بقیهٔ تأییدها تا تأیید دوباره بی‌اعتبارند.', $carried));
        $res = LMC_Stock_Sync::run();
        wp_safe_redirect(add_query_arg(['lmc_msg' => 'synced', 'lmc_count' => $res['updated'],
            'lmc_detail' => rawurlencode('واترمارک بازنشانی شد. ' . LMC_Stock_Sync::manual_summary($res))],
            admin_url('admin.php?page=labelmod-connector')));
        exit;
    }
}
