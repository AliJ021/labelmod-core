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
 * - **حالت کالا** = یک متای JSON `{w,r,c,a,d,e}`: انبار، واترمارک، موجودی Core، فعال‌بودن،
 *   «کثیف» و دورهٔ بازنشانی. یک مقدار است تا نیمه‌نوشته نشود.
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
 * ── هماهنگی با نوشتن خودِ ووکامرس ────────────────────────────────────
 *
 * قفل مشورتی کالا نوشتن‌های ووکامرس را سریال نمی‌کند؛ قفل سطری InnoDB روی خودِ سطر `_stock`
 * می‌کند. ووکامرس `_stock` را فقط با یک UPDATE اتمیک (`meta_value ± n`) عوض می‌کند و آن UPDATE
 * همان قفل سطر را می‌خواهد. `write_stock` در یک تراکنش: سطر را `FOR UPDATE` قفل می‌کند، بعد
 * دوره و جمع کسرها را می‌خواند، بعد عدد مطلق را می‌نویسد و Commit می‌کند. پس هیچ تغییر `_stock`
 * ووکامرس میان خواندن کسرها و نوشتن ما نمی‌نشیند، و با دو ترتیب ثابت ووکامرس (کم‌کردن پس از
 * نیت؛ افزودن پیش از برداشتن کسر) در هیچ ترتیبی عدد از «Core − کسرها» بیشتر نمی‌شود — برای
 * کم‌کردن و افزودن هر دو. استدلال کامل در سند پروتکل است.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Stock_Ledger_Error extends RuntimeException {}
/** دوره هنگام نوشتن عوض شد (بازنشانی هم‌زمان): «مشغول»، نه خطا. */
class LMC_Stock_Ledger_Epoch extends LMC_Stock_Ledger_Error {}
/** اتصال درون تراکنش فراخواننده است: نوشتن «مشغول»/«دوباره»، نه Commit ضمنی آن تراکنش. */
class LMC_Stock_Ledger_Nested extends LMC_Stock_Ledger_Error {}

class LMC_Stock_Ledger
{
    const SCHEMA_VERSION  = 3;
    const SCHEMA_OPTION   = 'lmc_stock_ledger_schema';
    const RECONCILE       = 'lmc_stock_reconcile';
    /** خرابی پایدار: نوشتن نشانهٔ پایدار هم شکست خورد. فقط بازنشانی مدیر پاکش می‌کند. */
    const FAULT           = 'lmc_stock_fault';
    /** دورهٔ واترمارک؛ «بازنشانی» آن را جلو می‌برد و ACKهای دورهٔ قبل بی‌اعتبار می‌شوند. */
    const EPOCH           = 'lmc_stock_epoch';
    /** پروتکل واترمارک دست‌کم یک بار فعال شده؛ پس از آن Push کالای بی‌حالت منتظر Pull می‌ماند. */
    const ACTIVE          = 'lmc_stock_protocol_active';
    const STATE_META      = '_lmc_stock_state';
    /** همان `LMC_Push_Receiver::STOCK_VERSION_META`؛ هم نام قفل و هم نسخهٔ سراسری Push. */
    const VERSION_META    = '_lmc_stock_version';
    const LOCK_WAIT       = 10;
    const RECONCILE_PAGE  = 100;
    /** زمان نصب دفتر؛ مرز «تأییدشده پیش از دفتر». */
    const SINCE           = 'lmc_stock_ledger_since';
    /** کسری که پس از این مدت هنوز تأیید یا حل نشده، در صفحهٔ اتصال برای رسیدگی دیده می‌شود. */
    const STUCK_AFTER     = 3600;

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
            release_after BIGINT UNSIGNED NULL,
            release_epoch INT UNSIGNED NULL,
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

    // ── نشانه‌های پایدار (عقب‌مانده، بازمحاسبه) ───────────────────────────

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

    /**
     * دورهٔ جاری از **دیتابیس**، نه از Cache گزینه‌ها: بازنشانی در پردازهٔ دیگری رخ می‌دهد و
     * `get_option` درون یک درخواست مقدار Cacheشده را برمی‌گرداند.
     */
    public static function epoch(): int
    {
        global $wpdb;
        $v = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::EPOCH));
        if ($v === null && (string) $wpdb->last_error !== '') { throw new LMC_Stock_Ledger_Error('دورهٔ واترمارک خوانده نشد'); }
        return max(1, (int) $v);
    }

    /**
     * «پروتکل دست‌کم یک بار فعال شده» از **دیتابیس**، مثل دوره: درخواستی که پیش از فعال‌شدن
     * سراسری `get_option` را خوانده، نباید با مقدار Cacheشدهٔ false عکس بی واترمارک بنشاند.
     */
    public static function active(): bool
    {
        global $wpdb;
        $v = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::ACTIVE));
        if ($v === null && (string) $wpdb->last_error !== '') { throw new LMC_Stock_Ledger_Error('وضعیت پروتکل خوانده نشد'); }
        return (int) $v > 0;
    }

    /**
     * آیا اتصال درون تراکنشی است که کس دیگری باز کرده؟ `START TRANSACTION` در MySQL تراکنش باز را
     * **ضمنی Commit** می‌کند؛ پس درون تراکنش دیگری نمی‌نویسیم.
     *
     * ۰. `@@autocommit = 0`: هر جملهٔ فراخواننده تراکنش ضمنی باز می‌کند و ما نمی‌دانیم چه نگه داشته
     *    (روی MariaDB یک SELECT ساده با autocommit=0 خطای ۱۵۶۸ نمی‌دهد)؛ پس «درون تراکنش».
     * ۱. MariaDB: `@@in_transaction`.
     * ۲. جایی که آن متغیر نیست (MySQL Oracle): `SET TRANSACTION` درون تراکنش در جریان خطای ۱۵۶۸
     *    می‌دهد و Commit ضمنی نمی‌کند. فقط حالت دسترسی تراکنش **بعدی** را می‌گذارد، نه سطح جداسازی؛ و
     *    همان حالت خود نشست (`@@transaction_read_only`) را می‌گذاریم، پس چیزی برای فراخواننده عوض نمی‌شود.
     *    روی MariaDB 10.11 سنجیده شد؛ روی MySQL Oracle فقط از مستندات — آزموده نشده.
     * ۳. هر نتیجهٔ دیگر: null («نمی‌دانم»)؛ نویسنده آن را مثل «درون تراکنش» می‌گیرد (بسته در شکست) و
     *    «دوباره» می‌ماند تا درخواست بعدی (Pull، دکمهٔ همگام‌سازی) که از ابتدای خودش اجرا می‌شود.
     */
    public static function in_transaction(): ?bool
    {
        global $wpdb;
        $quiet = method_exists($wpdb, 'suppress_errors') ? $wpdb->suppress_errors(true) : null;
        try {
            $ac = $wpdb->get_var('SELECT @@autocommit');
            if ($ac === null) { return null; }
            if ((int) $ac === 0) { return true; }
            $v = $wpdb->get_var('SELECT @@in_transaction');
            if ($v !== null) { return (int) $v === 1; }
            $ro = $wpdb->get_var('SELECT @@transaction_read_only');
            if ($ro === null) { $ro = $wpdb->get_var('SELECT @@tx_read_only'); }
            if ($ro === null) { return null; }
            if ($wpdb->query('SET TRANSACTION ' . ((int) $ro === 1 ? 'READ ONLY' : 'READ WRITE')) !== false) { return false; }
            $err = (string) $wpdb->last_error;
            return (str_contains($err, '1568') || stripos($err, 'transaction is in progress') !== false) ? true : null;
        } finally {
            if ($quiet !== null) { $wpdb->suppress_errors($quiet); }
        }
    }

    /** null = هنوز سنجیده نشده؛ در هر درخواست یک بار. */
    private static ?bool $transactional = null;

    /**
     * هماهنگی با ووکامرس به قفل سطری InnoDB روی `postmeta` تکیه دارد. روی موتور بی تراکنش
     * (MyISAM) `FOR UPDATE` بی‌اثر است، پس نشاندن بسته می‌ماند — نه «کار کند ولی ناامن».
     */
    public static function transactional(): bool
    {
        if (self::$transactional !== null) { return self::$transactional; }
        global $wpdb;
        $engine = $wpdb->get_var($wpdb->prepare(
            'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $wpdb->postmeta));
        self::$transactional = is_string($engine) && strcasecmp($engine, 'InnoDB') === 0;
        if (!self::$transactional) {
            lmc_log('جدول postmeta تراکنشی (InnoDB) نیست یا موتورش خوانده نشد؛ نشاندن موجودی متوقف است.');
        }
        return self::$transactional;
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
        // پیش از کم‌شدن `_stock` به دست ووکامرس، نیت پایدار: کسر سفارش و افزایش دستی تعداد قلم.
        add_filter('woocommerce_can_reduce_order_stock', [__CLASS__, 'on_can_reduce'], PHP_INT_MAX, 2);
        add_filter('woocommerce_order_item_quantity', [__CLASS__, 'on_item_quantity'], PHP_INT_MAX, 3);
        add_filter('woocommerce_prevent_adjust_line_item_product_stock', [__CLASS__, 'on_prevent_adjust'], PHP_INT_MAX, 3);
        add_action('woocommerce_reduce_order_stock', [__CLASS__, 'on_reduce_done'], 10, 1);
        add_action('woocommerce_reduce_order_item_stock', [__CLASS__, 'on_reduce'], 10, 3);
        add_action('woocommerce_restore_order_item_stock', [__CLASS__, 'on_restore'], 10, 4);
        add_action('woocommerce_update_order_item', [__CLASS__, 'on_item_saved'], 10, 3);
        add_action('woocommerce_restock_refunded_item', [__CLASS__, 'on_refund_restock'], 10, 5);
        add_action('woocommerce_delete_order', [__CLASS__, 'on_order_deleted'], 10, 1);
        // لغو سفارشی که کسرش وسط کار مرده: ووکامرس (پرچم کسر false) چیزی برنمی‌گرداند و هیچ Hook
        // قلمی اجرا نمی‌شود؛ نیت باید همین‌جا حل شود.
        add_action('woocommerce_order_status_changed', [__CLASS__, 'on_status_changed'], 20, 1);
        add_action('admin_post_lmc_stock_reset', [__CLASS__, 'handle_reset']);
        add_action('admin_post_lmc_stock_release', [__CLASS__, 'handle_release']);
        add_action('admin_notices', [__CLASS__, 'stuck_notice']);
    }

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

    /** پایان حلقهٔ کسر: نیت‌هایی که کسر نخوردند (خطای ووکامرس) پاک می‌شوند. */
    public static function on_reduce_done($order): void
    {
        if (!is_object($order)) { return; }
        unset(self::$reducing[(int) $order->get_id()]);
        self::sync_order_safe($order, true);
    }

    /** وضعیت هر درخواست؛ پردازه‌های بلند (CLI) و آزمون میان دو «درخواست» صدایش می‌زنند. */
    public static function new_request(): void
    {
        self::$reducing = [];
    }

    /**
     * WC 11.1.1، `wc_maybe_adjust_line_item_product_stock`: این فیلتر پیش از هر تغییر `_stock` برای
     * ویرایش دستی تعداد قلم اعمال می‌شود (با قلم و تعداد تازه). اگر تعدادِ کسرشدنیِ تازه بیشتر از
     * کسر ثبت‌شده است، همین‌جا نیت (confirmed=2) با تعداد تازه پایدار می‌شود؛ پس `_stock`ی که
     * ووکامرس کم می‌کند هیچ‌وقت بی کسر متناظر در دفتر نیست. کاهش (افزایش `_stock`) نیت نمی‌خواهد.
     */
    public static function on_prevent_adjust($prevent, $item = null, $item_quantity = -1)
    {
        if ($prevent || !is_object($item) || !method_exists($item, 'get_order_id')) { return $prevent; }
        try {
            $qty = (float) ($item_quantity >= 0 ? $item_quantity : $item->get_quantity());
            $target = (int) ceil($qty - (float) $item->get_meta('_restock_refunded_items', true));
            if ($qty > 0 && $target > 0) { self::record_adjust_intent((int) $item->get_order_id(), $item, $target); }
        } catch (LMC_Stock_Ledger_Error $e) {
            self::fault('نیت ویرایش قلم ثبت نشد: ' . $e->getMessage());
        }
        return $prevent;
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
            if ((int) $row['confirmed'] === 2 && !self::order_closed($order)) { return $touched; }
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
        if ((int) $row['confirmed'] === 2) {
            // نیت ویرایش دستی: فقط وقتی `_reduced_stock` به تعداد تازه رسید (یا سفارش بسته شد)
            // تأیید می‌شود؛ پیش از آن تعداد بزرگ‌تر می‌ماند (محافظه‌کار).
            if ($qty < (int) $row['qty'] && !self::order_closed($order)) { return $touched; }
            self::exec($wpdb->prepare(
                "UPDATE {$t} SET product_id = %d, qty = %d, confirmed = 1 WHERE order_id = %d AND item_id = %d",
                $pid, $qty, $order_id, $item_id), 1);
            return array_values(array_unique([$pid, (int) $row['product_id']]));
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
                "UPDATE {$t} SET product_id = %d, qty = %d, ack_rev = NULL, ack_wh = NULL, ack_epoch = NULL, ack_at = NULL, release_after = NULL WHERE order_id = %d AND item_id = %d",
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

    private static function order_closed($order): bool
    {
        return method_exists($order, 'has_status') && $order->has_status(['cancelled', 'failed', 'refunded', 'trash']);
    }

    /** نیت ویرایش دستی؛ تأیید پیشین باطل می‌شود چون Core تعداد تازه را ندیده است. */
    private static function record_adjust_intent(int $order_id, $item, int $target): void
    {
        global $wpdb;
        $t = self::table();
        $product = method_exists($item, 'get_product') ? $item->get_product() : null;
        $iid = method_exists($item, 'get_id') ? (int) $item->get_id() : 0;
        if (!$product || $iid <= 0 || $order_id <= 0) { return; }
        $pid = (int) $product->get_id();
        $rows = self::rows($wpdb->prepare("SELECT qty FROM {$t} WHERE order_id = %d AND item_id = %d", $order_id, $iid));
        $have = $rows ? (int) $rows[0]['qty'] : (int) ceil((float) $item->get_meta('_reduced_stock', true));
        if ($target <= $have) { return; }
        if ($rows) {
            self::exec($wpdb->prepare(
                "UPDATE {$t} SET product_id = %d, qty = %d, confirmed = 2, ack_rev = NULL, ack_wh = NULL, ack_epoch = NULL, ack_at = NULL, release_after = NULL
                  WHERE order_id = %d AND item_id = %d", $pid, $target, $order_id, $iid), 1);
        } else {
            self::exec($wpdb->prepare(
                "INSERT INTO {$t} (order_id, item_id, product_id, qty, confirmed, created_at) VALUES (%d, %d, %d, %d, 2, %d)",
                $order_id, $iid, $pid, $target, time()), 1);
        }
    }

    private static function intent_resolved($order, bool $finished): bool
    {
        if ($finished) { return true; }
        if (self::order_closed($order)) { return true; }
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
        if (!self::transactional()) { return false; }
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
    public static function ack_order($order, $stock, string $warehouse, array $sent, int $epoch): void
    {
        if ($epoch !== self::epoch()) {
            // پاسخ درخواستی که پیش از «بازنشانی» فرستاده شده: از Core پیشین است و اثبات دورهٔ تازه نیست.
            if (method_exists($order, 'add_order_note')) {
                $order->add_order_note('لیبل مد — پاسخ Core به درخواستی پیش از بازنشانی واترمارک رسید و تأیید نشد؛ کسر محلی می‌ماند.');
            }
            return;
        }
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
                // دوره در **همان** UPDATE سنجیده می‌شود: بازنشانی‌ای که میان سنجش بالا و این نوشتن
                // رخ دهد، ACK درخواست پیشین را به دورهٔ تازه نمی‌چسباند.
                $done = $wpdb->query($wpdb->prepare(
                    "UPDATE {$t} SET ack_rev = %d, ack_wh = %s, ack_epoch = %d, ack_at = %d
                      WHERE order_id = %d AND item_id = %d AND ack_rev IS NULL AND confirmed = 1 AND qty <= %d
                        AND COALESCE((SELECT o.option_value + 0 FROM {$wpdb->options} o WHERE o.option_name = %s), 1) = %d",
                    $by_sku[$sku], $warehouse, $epoch, time(), (int) $order->get_id(), $iid, (int) $sent[$iid], self::EPOCH, $epoch));
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
    public static function pending(int $product_id, int $rev, string $wh, ?int $epoch = null): int
    {
        global $wpdb;
        $t = self::table();
        $rows = self::rows($wpdb->prepare(
            "SELECT COALESCE(SUM(qty), 0) AS n FROM {$t} WHERE product_id = %d
               AND (ack_rev IS NULL OR ack_wh IS NULL OR ack_wh <> %s OR ack_epoch IS NULL OR ack_epoch <> %d OR ack_rev > %d)",
            $product_id, $wh, $epoch ?? self::epoch(), $rev));
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
        // حالتی از دورهٔ پیشین (نوشته‌شده هم‌زمان با بازنشانی) حالت نیست.
        if ((int) ($s['e'] ?? 1) !== self::epoch()) { return null; }
        return ['w' => (string) $s['w'], 'r' => (int) $s['r'], 'c' => (int) $s['c'],
            'a' => ($s['a'] ?? true) !== false, 'd' => !empty($s['d']), 'e' => (int) ($s['e'] ?? 1)];
    }

    private static function write_state(int $product_id, array $s): void
    {
        $json = wp_json_encode(['w' => $s['w'], 'r' => $s['r'], 'c' => $s['c'], 'a' => $s['a'], 'd' => $s['d'], 'e' => $s['e'] ?? self::epoch()]);
        update_post_meta($product_id, self::STATE_META, $json);
        self::fresh_meta($product_id);
        if (get_post_meta($product_id, self::STATE_META, true) !== $json) {
            throw new LMC_Stock_Ledger_Error('حالت موجودی کالا ذخیره نشد');
        }
        if (!self::active()) { update_option(self::ACTIVE, 1, false); }
    }

    private static function restore_state(int $product_id, $raw): void
    {
        if (is_string($raw) && $raw !== '') {
            update_post_meta($product_id, self::STATE_META, $raw);
        } else {
            delete_post_meta($product_id, self::STATE_META);
        }
    }

    /**
     * نسخهٔ Push نشسته برای دورهٔ جاری. مقدار «دوره:نسخه» است؛ عدد خالی (افزونهٔ پیشین/رفتار
     * پیش از پروتکل) فقط پیش از فعال‌شدن پروتکل یا در دورهٔ ۱ معتبر است. نسخهٔ دورهٔ دیگر صفر است، پس Push تازهٔ Core
     * بازیابی‌شده با نسخهٔ کوچک‌تر «قدیمی» شمرده نمی‌شود.
     */
    public static function version(int $product_id): int
    {
        $raw = (string) get_post_meta($product_id, self::VERSION_META, true);
        if (preg_match('/^([0-9]+):([0-9]+)$/D', $raw, $m)) {
            return (int) $m[1] === self::epoch() ? (int) $m[2] : 0;
        }
        // عدد خالی را مسیر پیش از پروتکل (و افزونهٔ پیشین) می‌نویسد؛ همان‌جا معتبر است.
        return (self::epoch() === 1 || !self::active()) ? (int) $raw : 0;
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
    public static function apply_snapshot(int $pid, int $available, bool $active, int $rev, string $wh, int $wait, bool $may_enter, ?int $version = null, ?int $epoch = null, ?int $fetched_ms = null): array
    {
        if ($epoch !== null && $epoch !== self::epoch()) {
            // عکس درخواستی که پیش از بازنشانی آغاز شده؛ از Core پیشین است.
            return ['ok' => false, 'applied' => false, 'busy' => true, 'note' => 'دورهٔ واترمارک عوض شده است'];
        }
        if (!self::ready()) {
            return ['ok' => false, 'applied' => false, 'blocked' => true, 'note' => 'دفتر کسر کامل نیست'];
        }
        $lock = self::lock_name($pid);
        if (!LMC_Push_Guard::acquire($lock, $wait)) {
            return ['ok' => false, 'applied' => false, 'busy' => true];
        }
        try {
            self::fresh_meta($pid);
            if ($epoch !== null && $epoch !== self::epoch()) {
                return ['ok' => false, 'applied' => false, 'busy' => true, 'note' => 'دورهٔ واترمارک عوض شده است'];
            }
            $state = self::state($pid);
            if ($state === null && !$may_enter && self::active()) {
                // پس از فعال‌شدن پروتکل (و پس از هر بازنشانی)، کالای بی‌حالت فقط با Pull زنده وارد می‌شود.
                return ['ok' => false, 'applied' => false, 'busy' => true, 'note' => 'کالا منتظر Pull است'];
            }
            if ($state === null && !$may_enter) {
                // Push در راه، کالای بیرون از پروتکل: رفتار پیشین (نه ورود).
                return ['legacy' => true] + self::legacy_locked($pid, $available, $version);
            }
            // فقط عکس Pull زنده که خواندنش پس از درخواست رها کردن آغاز شده، آن را تأیید می‌کند.
            $bound = ($fetched_ms !== null && $epoch !== null) ? self::bind_releases($pid, $rev, $wh, $epoch, $fetched_ms) : 0;
            if ($version !== null) {
                $sv = self::version($pid);
                if ($sv > 0 && $version <= $sv) {
                    if ($state && ($state['d'] || $bound > 0)) { self::recompute_locked($pid); }
                    return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'نسخهٔ قدیمی یا تکراری'];
                }
            }
            if ($state !== null && $state['w'] === $wh && $rev <= $state['r']) {
                if ($state['d'] || $bound > 0) { self::recompute_locked($pid); }
                return ['ok' => true, 'applied' => false, 'stale' => true, 'note' => 'واترمارک قدیمی یا تکراری'];
            }
            $prev = get_post_meta($pid, self::STATE_META, true);
            $next = ['w' => $wh, 'r' => $rev, 'c' => max(0, $available), 'a' => $active, 'd' => true, 'e' => self::epoch()];
            self::write_state($pid, $next);
            try {
                $display = self::write_stock($pid, $next);
            } catch (LMC_Stock_Ledger_Epoch | LMC_Stock_Ledger_Nested $e) {
                self::restore_state($pid, $prev);
                return ['ok' => false, 'applied' => false, 'busy' => true, 'note' => $e->getMessage()];
            } catch (Throwable $e) {
                self::restore_state($pid, $prev);
                lmc_log('نشاندن موجودی کالای ' . $pid . ' ناموفق؛ حالت قبلی برگشت: ' . $e->getMessage());
                return ['ok' => false, 'applied' => false, 'error' => $e->getMessage()];
            }
            $next['d'] = false;
            try { self::write_state($pid, $next); } catch (LMC_Stock_Ledger_Error $e) { self::mark_redo($pid); }
            // نسخه با دوره برچسب می‌خورد: نوشتنی که پس از بازنشانی برسد، نسخهٔ دورهٔ تازه نیست.
            if ($version !== null) { update_post_meta($pid, self::VERSION_META, $next['e'] . ':' . $version); }
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
            // پس از فعال‌شدن پروتکل (حتی پس از بازنشانی که حالت را پاک کرده) عکس بی واترمارک کسرهای
            // تأییدنشده را نمی‌بیند؛ نشاندنش یعنی واحد فروخته‌شده برگردد. بازگشت به رفتار پیشین فقط با
            // برگرداندن خود افزونه است، نه بی‌صدا.
            if (self::state($pid) !== null || self::active()) {
                lmc_log('عکس موجودی بی واترمارک برای کالای ' . $pid . ' رد شد؛ پروتکل واترمارک فعال است.');
                return ['ok' => false, 'applied' => false, 'rejected' => true,
                    'note' => 'عکس بی واترمارک پس از فعال‌شدن پروتکل پذیرفته نمی‌شود'];
            }
            return self::legacy_locked($pid, $available, $version);
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    private static function legacy_locked(int $pid, int $available, ?int $version): array
    {
        if ($version !== null) {
            $sv = self::version($pid);
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
     * نوشتن عدد سایت در یک تراکنش، زیر قفل سطری خودِ `_stock`.
     *
     * ۱. `SELECT … FOR UPDATE` روی سطر `_stock`. ۲. دورهٔ جاری؛ اگر عوض شده، Rollback و «مشغول».
     * ۳. جمع کسرهایی که این عکس ندارد. ۴. عدد مطلق `max(0, c − کسرها)`. ۵. Commit.
     *
     * ووکامرس `_stock` را فقط با `UPDATE … SET meta_value = meta_value ± n` عوض می‌کند و آن UPDATE
     * پشت قفل ۱ می‌ماند. پس هر تغییر `_stock` ووکامرس یا پیش از ۱ است یا پس از ۵؛ هیچ‌کدام میان
     * خواندن ۳ و نوشتن ۴ نمی‌نشیند و عدد مطلق ما با چیزی که ندیده‌ایم ترکیب نمی‌شود. با دو ترتیب
     * ثابت ووکامرس — کم‌کردن **پس از** نیت پایدارش، و افزودن (لغو، استرداد، کاهش تعداد) **پیش از**
     * کم‌شدن کسرش — هر رویداد ووکامرس در هر جای این بازه یا دقیق است یا یک بار بیشتر کم می‌کند؛
     * هرگز بیشتر از «Core − کسرها» نشان نمی‌دهد (جدول در سند پروتکل).
     *
     * مرگ پردازه پیش از Commit یعنی Rollback خودِ دیتابیس و آزاد شدن قفل؛ پس از Commit عدد درست
     * نشسته است. نسخهٔ پیشین تفاضل `هدف − خوانده` را می‌افزود و افزایشِ ووکامرسی که میان دو خواندن
     * می‌نشست دو بار شمرده می‌شد (لغو هم‌زمان: ۱۲ به‌جای ۱۰).
     *
     * @param array{w:string,r:int,c:int,a:bool,e:int} $s
     */
    private static function write_stock(int $pid, array $s): int
    {
        global $wpdb;
        $product = wc_get_product($pid);
        if (!$product) { throw new LMC_Stock_Ledger_Error('کالا خوانده نشد'); }
        if (LMC_Stock_Sync::prepare_managed($product)) {
            // فقط مدیریت موجودی و منع پیش‌خرید؛ ذخیره‌شان `_stock` را نمی‌نویسد.
            if (!$product->save()) { throw new LMC_Stock_Ledger_Error('ذخیرهٔ کالا ناموفق'); }
        }
        // همان کاری که ووکامرس پیش از هر تغییر موجودی می‌کند: سطر باید باشد تا قفل شود.
        add_post_meta($pid, '_stock', 0, true);
        if (self::in_transaction() !== false) {
            // تراکنش کس دیگری باز است (یا نمی‌دانیم)؛ START TRANSACTION آن را ضمنی Commit می‌کرد.
            lmc_log('نوشتن موجودی کالای ' . $pid . ' به بعد موکول شد: اتصال درون تراکنش دیگری است یا وضعیتش معلوم نیست؛ Pull بعدی یا دکمهٔ همگام‌سازی آن را می‌نشاند.');
            throw new LMC_Stock_Ledger_Nested('درون تراکنش دیگری؛ نوشتن موجودی به بعد موکول شد');
        }
        $pm = $wpdb->postmeta;
        if ($wpdb->query('START TRANSACTION') === false) { throw new LMC_Stock_Ledger_Error('تراکنش موجودی باز نشد'); }
        $done = false;
        try {
            $locked = self::rows($wpdb->prepare("SELECT meta_value FROM {$pm} WHERE post_id = %d AND meta_key = '_stock' FOR UPDATE", $pid));
            if ($locked === []) { throw new LMC_Stock_Ledger_Error('سطر موجودی کالا نیست'); }
            self::probe('locked', $pid);
            if (self::epoch() !== (int) $s['e']) {
                throw new LMC_Stock_Ledger_Epoch('دورهٔ واترمارک هنگام نوشتن عوض شد');
            }
            $target = $s['a'] ? max(0, $s['c'] - self::pending($pid, $s['r'], $s['w'], (int) $s['e'])) : 0;
            self::probe('pending_read', $pid);
            if ($wpdb->query($wpdb->prepare("UPDATE {$pm} SET meta_value = %s WHERE post_id = %d AND meta_key = '_stock'", (string) $target, $pid)) === false) {
                throw new LMC_Stock_Ledger_Error('نوشتن موجودی ناموفق: ' . (string) $wpdb->last_error);
            }
            if ($wpdb->query('COMMIT') === false) { throw new LMC_Stock_Ledger_Error('Commit موجودی ناموفق'); }
            $done = true;
        } finally {
            if (!$done) { $wpdb->query('ROLLBACK'); }
        }
        self::probe('committed', $pid);
        // وضعیت انبار و Cacheهای ووکامرس از همان مسیر خودش؛ `+0` عدد را دست نمی‌زند.
        // عدد پس از Commit نشسته است؛ شکست این گام فقط وضعیت/Cache را کهنه می‌گذارد و حالت قبلی
        // را برنمی‌گرداند (برگرداندن حالت، عددی را که نشسته بی‌پشتوانه می‌کرد). «دوباره» تازه‌اش می‌کند.
        self::fresh_meta($pid);
        try {
            $res = wc_update_product_stock($product, 0, 'increase');
            if ($res === false || $res === null || (function_exists('is_wp_error') && is_wp_error($res))) {
                throw new LMC_Stock_Ledger_Error('تازه‌سازی وضعیت ووکامرس ناموفق');
            }
        } catch (Throwable $e) {
            lmc_log('موجودی کالای ' . $pid . ' نشست ولی تازه‌سازی وضعیتش ناموفق بود: ' . $e->getMessage());
            self::mark_redo($pid);
        }
        return $target;
    }

    /** نقطهٔ مشاهده برای بازتولید با پردازه‌های واقعی (`lmc_stock_probe`)؛ در تولید بی‌اثر. */
    private static function probe(string $stage, int $pid): void
    {
        if (function_exists('do_action')) { do_action('lmc_stock_probe', $stage, $pid); }
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
            $blocked = (int) get_option(self::FAULT, 0) > 0 || self::marked('order') !== [];
        } catch (LMC_Stock_Ledger_Error $e) {
            $blocked = true;
        }
        if ($blocked) { self::mark_redo($pid); return false; }
        // از Hookهای ووکامرس صدا زده می‌شود؛ شاید درون تراکنش فراخواننده. درونش هرگز؛ نامعلوم (MySQL):
        // پس از پایان درخواست، وقتی پشتهٔ فراخواننده بسته شده است. «دوباره» در هر دو حالت پایدار است.
        $tx = self::in_transaction();
        if ($tx !== false) {
            self::mark_redo($pid);
            if ($tx === null) { self::defer($pid); }
            return false;
        }
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

    /** @var array<int,bool> */
    private static array $deferred = [];

    private static function defer(int $pid): void
    {
        if (self::$deferred === [] && function_exists('add_action')) {
            add_action('shutdown', [__CLASS__, 'flush_deferred'], 1);
        }
        self::$deferred[$pid] = true;
    }

    /** پایان درخواست: بازمحاسبهٔ کالاهای موکول‌شده بیرون از پشتهٔ هر فراخواننده. */
    public static function flush_deferred(): void
    {
        $pids = array_keys(self::$deferred);
        self::$deferred = [];
        foreach ($pids as $pid) {
            $lock = self::lock_name((int) $pid);
            if (!LMC_Push_Guard::acquire($lock, self::LOCK_WAIT)) { continue; }   // «دوباره» می‌ماند
            try {
                self::fresh_meta((int) $pid);
                self::recompute_locked((int) $pid);
            } catch (Throwable $e) {
                lmc_log('بازمحاسبهٔ پایان درخواست کالای ' . (int) $pid . ' ناموفق: ' . $e->getMessage());
            } finally {
                LMC_Push_Guard::release($lock);
            }
        }
    }

    private static function mark_redo(int $pid): void
    {
        self::mark('redo', $pid);
    }

    /**
     * نگه‌داری در هر Pull: بازمحاسبهٔ کالاهای «دوباره» (قفل نرسید، عقب‌مانده بود یا نوشتن
     * شکست خورد). هر نشانه فقط با token خوانده‌شده‌اش پاک می‌شود.
     */
    public static function maintain(): bool
    {
        if (!self::ready()) { return false; }
        try {
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
            if (!LMC_Push_Guard::acquire($lock, 0)) { $left++; continue; }
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

    // ── رسیدگی به کسرِ گیرکرده ──────────────────────────────────────────

    /**
     * کسرهایی که دیگر خودبه‌خود حل نمی‌شوند و عدد سایت را پایین نگه داشته‌اند: نیت کسر یا
     * ویرایش دستی که پردازه‌اش وسط کار مرده، یا کسری که ACK نگرفته — هر کدام پس از
     * `STUCK_AFTER`. بی این فهرست، کمتر نشان دادن «محافظه‌کار» عملاً یخ‌زدن بی‌پایان بود.
     *
     * @return list<array{order_id:int,item_id:int,product_id:int,qty:int,confirmed:int,ack_rev:?int,ack_epoch:?int,release_after:?int,created_at:int}>
     */
    public static function unresolved(int $limit = 50): array
    {
        global $wpdb;
        $t = self::table();
        $rows = self::rows($wpdb->prepare(
            "SELECT order_id, item_id, product_id, qty, confirmed, ack_rev, ack_epoch, release_after, created_at FROM {$t}
              WHERE created_at < %d AND (confirmed <> 1 OR ack_rev IS NULL OR ack_epoch IS NULL OR ack_epoch <> %d)
              ORDER BY created_at LIMIT %d",
            time() - self::STUCK_AFTER, self::epoch(), max(1, $limit)));
        return array_map(static fn ($r) => array_map(static fn ($v) => $v === null ? null : (int) $v, $r), $rows);
    }

    private static function now_ms(): int { return (int) floor(microtime(true) * 1000); }

    /**
     * درخواست رها کردن یک کسر با تصمیم مدیر: «در Core دیدم این قلم ثبت شده» (یا ووکامرس تغییر را
     * اعمال نکرده). خودِ درخواست **هیچ‌چیز را تأیید نمی‌کند**: فقط زمانش ثبت می‌شود. تأیید با اولین
     * Pull زنده‌ای است که خواندنش **پس از** این زمان آغاز شده (`bind_releases`): واترمارک آن عکس، چون
     * Core در لحظهٔ خواندن آن قلم را داشته است. عکس‌های کهنه‌تر (واترمارک کوچک‌تر) همچنان کسر را
     * می‌بینند؛ بی خواندن زنده، چیزی رها نمی‌شود.
     *
     * فرم همان نسخهٔ نمایش‌داده را می‌فرستد (تعداد، وضعیت، ACK، دوره، زمان ساخت)؛ اگر سطر از آن پس
     * عوض شده (کسر تازه‌تر)، درخواست رد می‌شود.
     *
     * فرم به **دورهٔ** صفحه‌ای که مدیر دیده هم بسته است (`epoch`)، حتی وقتی `ack_epoch` تهی است: بررسیِ
     * پیش از «بازنشانی» (Core بازیابی‌شده از بکاپ) اثبات دورهٔ تازه نیست. دوره در همان UPDATE سنجیده و
     * با درخواست ذخیره می‌شود؛ `bind_releases` فقط درخواستِ همان دوره را تأیید می‌کند.
     *
     * @param array{qty:int,confirmed:int,ack_rev:?int,ack_epoch:?int,created_at:int,epoch:int} $seen
     */
    public static function release_hold(int $order_id, int $item_id, array $seen, string $reason, string $who): bool
    {
        global $wpdb;
        $t = self::table();
        $same = static fn (string $col, ?int $v) => $v === null ? "{$col} IS NULL" : $wpdb->prepare("{$col} = %d", $v);
        $done = $wpdb->query($wpdb->prepare(
            "UPDATE {$t} SET release_after = %d, release_epoch = %d WHERE order_id = %d AND item_id = %d AND qty = %d AND confirmed = %d AND created_at = %d
               AND COALESCE((SELECT o.option_value + 0 FROM {$wpdb->options} o WHERE o.option_name = %s), 1) = %d AND ",
            self::now_ms(), (int) $seen['epoch'], $order_id, $item_id, (int) $seen['qty'], (int) $seen['confirmed'], (int) $seen['created_at'],
            self::EPOCH, (int) $seen['epoch'])
            . $same('ack_rev', $seen['ack_rev']) . ' AND ' . $same('ack_epoch', $seen['ack_epoch']));
        if ($done === false) { throw new LMC_Stock_Ledger_Error('ثبت درخواست رها کردن ناموفق: ' . (string) $wpdb->last_error); }
        if ($done === 0) { return false; }
        $msg = sprintf('لیبل مد — درخواست رها کردن کسر محلی قلم %d (تعداد %d، وضعیت %d) با تصمیم %s ثبت شد. دلیل: %s. '
            . 'تا اولین خواندن زندهٔ Core پس از این لحظه کسر می‌ماند.', $item_id, (int) $seen['qty'], (int) $seen['confirmed'], $who, $reason);
        $order = function_exists('wc_get_order') ? wc_get_order($order_id) : false;
        if ($order && method_exists($order, 'add_order_note')) { $order->add_order_note($msg); }
        lmc_log($msg);
        return true;
    }

    /**
     * تأیید درخواست‌های رها کردن با عکس Pull زنده‌ای که پس از درخواست خوانده شده. زیر قفل کالا،
     * دوره در همان UPDATE. شمار سطرهای تأییدشده را برمی‌گرداند.
     */
    private static function bind_releases(int $pid, int $rev, string $wh, int $epoch, int $fetched_ms): int
    {
        global $wpdb;
        $t = self::table();
        $n = $wpdb->query($wpdb->prepare(
            "UPDATE {$t} SET confirmed = 1, ack_rev = %d, ack_wh = %s, ack_epoch = %d, ack_at = %d, release_after = NULL, release_epoch = NULL
              WHERE product_id = %d AND release_after IS NOT NULL AND release_after < %d AND release_epoch = %d
                AND (ack_rev IS NULL OR ack_wh IS NULL OR ack_wh <> %s OR ack_epoch IS NULL OR ack_epoch <> %d)
                AND COALESCE((SELECT o.option_value + 0 FROM {$wpdb->options} o WHERE o.option_name = %s), 1) = %d",
            $rev, $wh, $epoch, time(), $pid, $fetched_ms, $epoch, $wh, $epoch, self::EPOCH, $epoch));
        if ($n === false) { throw new LMC_Stock_Ledger_Error('تأیید درخواست رها کردن ناموفق: ' . (string) $wpdb->last_error); }
        if ($n > 0) { lmc_log(sprintf('%d کسر رهاشدهٔ کالای %d با عکس زندهٔ Core (واترمارک %d) تأیید شد.', $n, $pid, $rev)); }
        return (int) $n;
    }

    public static function handle_release(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_stock_release');
        $int = static fn (string $k) => isset($_POST[$k]) && preg_match('/^[0-9]{1,18}$/D', (string) $_POST[$k]) ? (int) $_POST[$k] : null;
        $order = $int('lmc_order'); $item = $int('lmc_item');
        $seen = ['qty' => $int('lmc_qty'), 'confirmed' => $int('lmc_confirmed'), 'created_at' => $int('lmc_created'),
            'ack_rev' => $int('lmc_ack_rev'), 'ack_epoch' => $int('lmc_ack_epoch'), 'epoch' => $int('lmc_epoch')];
        $reason = isset($_POST['lmc_reason']) ? trim(sanitize_text_field(wp_unslash($_POST['lmc_reason']))) : '';
        if (!$order || !$item || $seen['qty'] === null || $seen['confirmed'] === null || $seen['created_at'] === null || !$seen['epoch']
            || $reason === '' || mb_strlen($reason) > 200) {
            wp_die(esc_html__('سفارش، قلم، نسخهٔ نمایش‌داده و دلیل (حداکثر ۲۰۰ نویسه) لازم است.', 'labelmod-connector'));
        }
        $user = wp_get_current_user();
        try {
            $ok = self::release_hold($order, $item, $seen, $reason, (string) ($user->user_login ?? 'مدیر'));
        } catch (LMC_Stock_Ledger_Error $e) {
            wp_die(esc_html($e->getMessage()));
        }
        $detail = 'این کسر از وقتی صفحه را دیدید عوض شده است؛ چیزی ثبت نشد. صفحه را تازه کنید و دوباره بررسی کنید.';
        if ($ok) {
            // خواندن زندهٔ کامل Core همین حالا؛ تأیید فقط از همین (یا Pull بعدی) می‌آید.
            delete_option(LMC_Stock_Sync::CURSOR_OPTION);
            $res = LMC_Stock_Sync::run();
            $detail = $res['error'] !== ''
                ? 'درخواست ثبت شد ولی خواندن Core ناموفق بود؛ کسر تا خواندن موفق بعدی می‌ماند: ' . $res['error']
                : 'درخواست ثبت شد و با خواندن زندهٔ Core اعمال شد. ' . LMC_Stock_Sync::manual_summary($res);
        }
        wp_safe_redirect(add_query_arg(['lmc_msg' => 'synced', 'lmc_count' => 0, 'lmc_detail' => rawurlencode($detail)],
            admin_url('admin.php?page=labelmod-connector')));
        exit;
    }

    /** هشدار پیشخوان: کسر گیرکرده‌ای هست که عدد سایت را پایین نگه داشته است. */
    public static function stuck_notice(): void
    {
        if (!function_exists('current_user_can') || !current_user_can('manage_woocommerce')) { return; }
        try {
            $n = count(self::unresolved(50));
        } catch (Throwable $e) {
            return;
        }
        if ($n === 0) { return; }
        printf('<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
            esc_html(sprintf('لیبل مد: %d کسر موجودی بیش از یک ساعت حل نشده و موجودی سایت را پایین نگه داشته است.', $n)),
            esc_url(admin_url('admin.php?page=labelmod-connector#lmc-stuck')),
            esc_html__('رسیدگی', 'labelmod-connector'));
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
        // Core بازیابی‌شده دنبالهٔ نسخهٔ Push را هم عقب برده است؛ نسخهٔ قدیمی Pushهای تازه را رد می‌کرد.
        delete_post_meta_by_key(self::VERSION_META);
        delete_option(LMC_Stock_Sync::CURSOR_OPTION);
        if ($restore_point === null) { return 0; }
        $done = $wpdb->query($wpdb->prepare(
            "UPDATE {$t} SET ack_rev = 0, ack_epoch = %d WHERE ack_epoch = %d AND ack_at IS NOT NULL AND ack_at < %d",
            $old + 1, $old, $restore_point));
        return is_int($done) ? $done : 0;
    }

    /**
     * «بازنشانی واترمارک»: پس از بازیابی Core از بکاپ قدیمی‌تر (برگشت API یعنی برگشت افزونه، نه بازنشانی).
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
