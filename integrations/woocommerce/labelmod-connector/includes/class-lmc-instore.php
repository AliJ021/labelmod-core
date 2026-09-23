<?php
/**
 * خرید حضوری → حساب کاربری سایت.
 *
 * مشتری که در فروشگاه خرید می‌کند، همان خرید را در «حساب کاربری» سایت
 * می‌بیند — با برچسب «سفارش حضوری». اگر حسابی با آن شماره نباشد، ساخته
 * می‌شود.
 *
 * ── چرا این یک `shop_order` **نیست** ────────────────────────────────
 *
 * این مهم‌ترین تصمیم این پرونده است. ساختن سفارش ووکامرس برای خریدی
 * که در فروشگاه انجام شده، سه فاجعه دارد:
 *
 * ۱. **کسر دوباره موجودی.** کالا در همان لحظه فروش از انبار خارج
 *    شده. ووکامرس با ساخته‌شدن سفارش دوباره کمش می‌کند و موجودی
 *    سایت نصف واقعیت می‌شود.
 *
 * ۲. **حلقه بازگشتی.** سفارش تازه ووکامرس، همان Hookهایی را می‌زند که
 *    `LMC_Order_Sync` به آن‌ها گوش می‌دهد — پس همان خرید دوباره به
 *    لیبل مد فرستاده می‌شود، فاکتور دوم می‌سازد، آن فاکتور دوباره در
 *    خوراک می‌آید، و چرخه بسته می‌شود.
 *
 * ۳. **ایمیل، گزارش و مالیات.** ووکامرس برای سفارش تازه ایمیل
 *    می‌فرستد، در گزارش فروش سایت می‌نشاندش و در آمار ضربش می‌کند.
 *    فروش فروشگاه دو بار شمرده می‌شود.
 *
 * پس یک **نوع پست جدا** (`lmc_instore_purchase`) ساخته می‌شود که هیچ
 * Hook ووکامرسی ندارد و فقط برای نمایش است. `wc_reduce_stock_levels`
 * و `wc_create_order` در این پرونده **اصلاً فراخوانی نمی‌شوند**.
 *
 * ── سه نگهبان حلقه، نه یکی ──────────────────────────────────────────
 *
 * ۱. سرور فاکتور کانال `web` را در خوراک نمی‌گذارد.
 * ۲. این پرونده هم هر سطری با کانال `web` را رد می‌کند.
 * ۳. رکورد ساخته‌شده `shop_order` نیست، پس حتی اگر دو تای بالا
 *    برداشته شوند، هیچ Hook سفارشی زده نمی‌شود.
 *
 * سه لایه، چون هرکدام روزی با یک تغییر بی‌ربط ممکن است برداشته شود.
 *
 * ── تکرار ───────────────────────────────────────────────────────────
 *
 * `invoiceId` هویت این خرید است و در متا می‌نشیند. خوراک «حداقل یک
 * بار» تحویل می‌دهد، پس رکورد تکراری باید بی‌صدا رد شود، نه اینکه
 * دوباره ساخته شود.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Instore
{
    const POST_TYPE      = 'lmc_instore_purchase';
    const CURSOR_OPTION  = 'lmc_instore_cursor';
    const CURSOR_ID      = 'lmc_instore_cursor_id';
    const META_INVOICE   = '_lmc_invoice_id';
    const META_MOBILE    = '_lmc_mobile';
    const BATCH          = 100;
    const CHECKPOINT     = 'lmc_instore_checkpoint';
    /** نقطه پایان حساب کاربری — `/my-account/instore/`. */
    const ENDPOINT       = 'instore';

    public static function init(): void
    {
        add_action('init', [__CLASS__, 'register_post_type']);
        add_action('init', [__CLASS__, 'register_endpoint']);
        add_action(LMC_INSTORE_EVENT, [__CLASS__, 'run']);

        add_filter('woocommerce_account_menu_items', [__CLASS__, 'menu_item']);
        add_action(
            'woocommerce_account_' . self::ENDPOINT . '_endpoint',
            [__CLASS__, 'render_account_page']
        );
        add_filter('query_vars', [__CLASS__, 'query_vars']);
    }

    /**
     * نوع پست خصوصی — نه در جست‌وجوی سایت، نه در نقشه سایت.
     *
     * `public => false` عمدی است: این رکورد فقط از صفحه حساب کاربری و
     * فقط به صاحبش نشان داده می‌شود. اگر عمومی بود، خرید یک مشتری با
     * یک URL حدسی برای بقیه باز می‌شد.
     */
    public static function register_post_type(): void
    {
        register_post_type(self::POST_TYPE, [
            'label'               => __('خرید حضوری', 'labelmod-connector'),
            'public'              => false,
            'publicly_queryable'  => false,
            'exclude_from_search' => true,
            'show_ui'             => false,
            'show_in_menu'        => false,
            'show_in_rest'        => false,
            'has_archive'         => false,
            'rewrite'             => false,
            'supports'            => ['title', 'author'],
            'capability_type'     => 'post',
        ]);
    }

    public static function register_endpoint(): void
    {
        add_rewrite_endpoint(self::ENDPOINT, EP_ROOT | EP_PAGES);
    }

    /** @param array $vars */
    public static function query_vars($vars): array
    {
        $vars[] = self::ENDPOINT;
        return is_array($vars) ? $vars : [self::ENDPOINT];
    }

    /** @param array $items */
    public static function menu_item($items): array
    {
        if (!is_array($items)) {
            return $items;
        }
        // پیش از «خروج» می‌نشیند — خروج همیشه آخر است.
        $out = [];
        foreach ($items as $key => $label) {
            if ($key === 'customer-logout') {
                $out[self::ENDPOINT] = __('خریدهای حضوری', 'labelmod-connector');
            }
            $out[$key] = $label;
        }
        if (!isset($out[self::ENDPOINT])) {
            $out[self::ENDPOINT] = __('خریدهای حضوری', 'labelmod-connector');
        }
        return $out;
    }

    /**
     * یک دور دریافت.
     *
     * @return array{created:int,skipped:int,users:int,error:string}
     */
    public static function run(): array
    {
        global $wpdb;
        // قفل اتصال، نه transient با مهلتی که وسط اجرای کند منقضی شود.
        $lock = 'lmc_instore_run_' . md5($wpdb->prefix);
        if ((string) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', $lock)) !== '1') {
            return ['created' => 0, 'skipped' => 0, 'users' => 0,
                'error' => __('دریافت خرید حضوری دیگری در حال اجراست یا قفل در دسترس نیست.', 'labelmod-connector')];
        }
        try {
            return self::run_locked();
        } finally {
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
        }
    }

    private static function run_locked(): array
    {
        $out = ['created' => 0, 'skipped' => 0, 'users' => 0, 'error' => ''];

        if (lmc_setting('sync_instore') !== 'yes') {
            return $out;
        }
        $branch = (string) lmc_setting('branch_id');
        if ($branch === '') {
            $out['error'] = __('شعبه در تنظیمات انتخاب نشده است.', 'labelmod-connector');
            return $out;
        }

        $query = ['branchId' => $branch, 'limit' => self::BATCH];
        // زمان و شناسه در یک گزینه ذخیره می‌شوند تا شکست میان دو نوشتن، خریدی را رد نکند.
        $checkpoint = get_option(self::CHECKPOINT, null);
        $same_branch = is_array($checkpoint) && ($checkpoint['branch'] ?? '') === $branch;
        $since = is_array($checkpoint) ? ($same_branch ? ($checkpoint['since'] ?? '') : '') : get_option(self::CURSOR_OPTION, '');
        $sinceId = is_array($checkpoint) ? ($same_branch ? ($checkpoint['id'] ?? '') : '') : get_option(self::CURSOR_ID, '');
        if (is_string($since) && $since !== '') {
            $query['since'] = $since;
            if (is_string($sinceId) && $sinceId !== '') {
                $query['sinceId'] = $sinceId;
            }
        }

        $res = LMC_Client::get('/web/instore-purchases', $query);
        if (is_wp_error($res)) {
            $out['error'] = $res->get_error_message();
            lmc_log('دریافت خرید حضوری ناموفق: ' . $out['error']);
            return $out;
        }

        $items = isset($res['items']) && is_array($res['items']) ? $res['items'] : [];
        foreach ($items as $item) {
            $result = self::import_one($item);
            if ($result === 'retry') {
                $out['error'] = __('ذخیره خرید حضوری کامل نشد؛ دریافت بعدی از همین مکان تکرار می‌شود.', 'labelmod-connector');
                lmc_log($out['error']);
                if (!wp_next_scheduled(LMC_INSTORE_EVENT)) {
                    wp_schedule_single_event(time() + 60, LMC_INSTORE_EVENT);
                }
                return $out;
            }
            if ($result === 'created') {
                $out['created']++;
            } else {
                $out['skipped']++;
            }
        }

        // مکان‌نما فقط وقتی جلو می‌رود که سطری آمده باشد.
        if (!empty($res['cursor'])) {
            $next = ['since' => (string) $res['cursor'], 'id' => (string) ($res['cursorId'] ?? ''), 'branch' => $branch];
            update_option(self::CHECKPOINT, $next, false);
            if (get_option(self::CHECKPOINT) !== $next) {
                $out['error'] = __('ذخیره مکان دریافت خرید حضوری ناموفق بود.', 'labelmod-connector');
            }
        }

        lmc_log(sprintf('خرید حضوری: %d تازه، %d رد شد', $out['created'], $out['skipped']));

        if (count($items) >= self::BATCH) {
            wp_schedule_single_event(time() + 60, LMC_INSTORE_EVENT);
        }

        return $out;
    }

    /**
     * یک خرید.
     *
     * @param array $item
     * @return string 'created' | 'skipped' | 'retry'
     */
    public static function import_one($item): string
    {
        if (!is_array($item)) {
            return 'skipped';
        }

        // نگهبان دوم حلقه — سرور هم این را رد می‌کند، ولی یکی از دو
        // نگهبان روزی با یک تغییر بی‌ربط برداشته می‌شود.
        if (($item['channel'] ?? '') === 'web') {
            return 'skipped';
        }

        $invoice_id = isset($item['invoiceId']) ? (string) $item['invoiceId'] : '';
        $mobile     = isset($item['customer']['mobile']) ? (string) $item['customer']['mobile'] : '';
        if ($invoice_id === '' || $mobile === '') {
            return 'skipped';
        }

        $mobile = self::normalize_mobile($mobile);
        if ($mobile === '') {
            lmc_log('خرید حضوری با شماره موبایل نامعتبر رد شد: ' . $invoice_id);
            return 'skipped';
        }

        global $wpdb;
        // همه واردکننده‌ها، حتی فراخوانی مستقیم، همین قفل را می‌گیرند.
        // قفل مشترک ساخت مشتری با شماره یکسان را نیز سری می‌کند.
        $lock = 'lmc_instore_import_' . md5($wpdb->prefix);
        if ((string) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', $lock)) !== '1') {
            return 'retry';
        }
        try {
            return self::import_locked($item, $invoice_id, $mobile);
        } finally {
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
        }
    }

    private static function import_locked(array $item, string $invoice_id, string $mobile): string
    {
        global $wpdb;
        // نام پایدار در همان INSERT پست است؛ قطع اجرا پیش از نوشتن متا، پست بی‌هویت نمی‌سازد.
        $slug = 'lmc-' . hash('sha256', $invoice_id);
        $row = $wpdb->get_row($wpdb->prepare(
            "SELECT p.ID, p.post_status FROM {$wpdb->posts} p
             WHERE p.post_type=%s AND (p.post_name=%s OR EXISTS (
               SELECT 1 FROM {$wpdb->postmeta} m WHERE m.post_id=p.ID AND m.meta_key=%s AND m.meta_value=%s
             )) ORDER BY p.ID LIMIT 1",
            self::POST_TYPE, $slug, self::META_INVOICE, $invoice_id
        ));
        if ($wpdb->last_error !== '') {
            return 'retry';
        }
        if ($row && in_array($row->post_status, ['publish', 'trash'], true)) {
            return 'skipped';
        }
        $user_id = self::find_or_create_user($mobile, (string) ($item['customer']['name'] ?? ''));
        if ($user_id === 0) {
            return 'retry';
        }
        $post_id = $row ? (int) $row->ID : wp_insert_post([
            'post_type' => self::POST_TYPE,
            'post_status' => 'draft',
            'post_name' => $slug,
            'post_author' => $user_id,
            'post_title' => sprintf(__('سفارش حضوری %s', 'labelmod-connector'), (string) ($item['number'] ?? '—')),
        ], true);
        if (is_wp_error($post_id) || !$post_id) {
            return 'retry';
        }
        $meta = [
            self::META_INVOICE => $invoice_id,
            self::META_MOBILE => $mobile,
            '_lmc_number' => (string) ($item['number'] ?? ''),
            '_lmc_channel' => (string) ($item['channel'] ?? 'pos'),
            '_lmc_occurred_at' => (string) ($item['occurredAt'] ?? ''),
            '_lmc_net_amount' => (string) ($item['netAmount'] ?? '0'),
            '_lmc_payable_amount' => (string) ($item['payableAmount'] ?? '0'),
            '_lmc_lines' => self::clean_lines($item['lines'] ?? []),
        ];
        foreach ($meta as $key => $value) {
            // API متا اسلش ورودی را برمی‌دارد؛ داده خوراک باید بدون تغییر بماند.
            update_post_meta($post_id, $key, wp_slash($value));
            wp_cache_delete($post_id, 'post_meta');
            if (get_post_meta($post_id, $key, true) !== $value) {
                return 'retry';
            }
        }
        $published = wp_update_post(['ID' => $post_id, 'post_author' => $user_id, 'post_status' => 'publish'], true);
        if (is_wp_error($published) || !$published) {
            return 'retry';
        }
        return 'created';
    }

    /** آیا این فاکتور قبلاً وارد شده؟ */
    public static function already_imported(string $invoice_id): bool
    {
        $found = get_posts([
            'post_type'     => self::POST_TYPE,
            'post_status'   => 'any',
            'numberposts'   => 1,
            'fields'        => 'ids',
            'meta_key'      => self::META_INVOICE,
            'meta_value'    => $invoice_id,
            'no_found_rows' => true,
        ]);
        return !empty($found);
    }

    /**
     * حساب کاربری از روی شماره موبایل.
     *
     * ── چرا ایمیل ساختگی ──────────────────────────────────────────
     *
     * وردپرس بدون ایمیل کاربر نمی‌سازد. مشتری فروشگاه ایمیل ندارد و
     * پرسیدنش پای صندوق کار را کند می‌کند. پس ایمیلی از شماره ساخته
     * می‌شود روی دامنه رزروشده `invalid.` (RFC 2606) — دامنه‌ای که
     * **هرگز** وجود نخواهد داشت، پس هیچ ایمیلی به کسِ دیگری نمی‌رود.
     *
     * اگر مشتری بعداً خودش در سایت ثبت‌نام کند، شماره‌اش کلید است و
     * همان حساب پیدا می‌شود — نه حساب دوم.
     *
     * ⚠️ رمز تصادفی و **هرگز نمایش داده نمی‌شود**. ورود این حساب از
     *    راه رمز نیست؛ مشتری با «فراموشی رمز» یا ورود با شماره وارد
     *    می‌شود.
     */
    public static function find_or_create_user(string $mobile, string $name): int
    {
        $mobile = self::normalize_mobile($mobile);
        if ($mobile === '') {
            return 0;
        }

        $existing = get_users([
            'meta_key'    => self::META_MOBILE,
            'meta_value'  => $mobile,
            'number'      => 1,
            'fields'      => 'ID',
        ]);
        if (!empty($existing)) {
            return (int) $existing[0];
        }

        // شاید با همین شماره به‌عنوان نام کاربری ثبت‌نام کرده باشد.
        $by_login = get_user_by('login', $mobile);
        if ($by_login) {
            update_user_meta($by_login->ID, self::META_MOBILE, $mobile);
            return (int) $by_login->ID;
        }
        // یا در آدرس صورتحساب ووکامرس.
        $by_billing = get_users([
            'meta_key'   => 'billing_phone',
            'meta_value' => $mobile,
            'number'     => 1,
            'fields'     => 'ID',
        ]);
        if (!empty($by_billing)) {
            update_user_meta((int) $by_billing[0], self::META_MOBILE, $mobile);
            return (int) $by_billing[0];
        }

        $user_id = wp_insert_user([
            'user_login' => $mobile,
            'user_email' => $mobile . '@instore.invalid',
            'user_pass'  => wp_generate_password(24, true, true),
            'display_name' => $name !== '' ? $name : $mobile,
            'first_name' => $name,
            'role'       => 'customer',
        ]);
        if (is_wp_error($user_id)) {
            lmc_log('ساخت حساب مشتری ناموفق: ' . $user_id->get_error_message());
            return 0;
        }

        update_user_meta($user_id, self::META_MOBILE, $mobile);
        update_user_meta($user_id, 'billing_phone', $mobile);
        if ($name !== '') {
            update_user_meta($user_id, 'billing_first_name', $name);
        }
        return (int) $user_id;
    }

    /**
     * نرمال‌سازی شماره — همان قاعده‌ای که `sales.normalize_mobile` دارد.
     *
     * ⚠️ اگر این دو از هم جدا شوند، مشتری‌ای که یک بار آنلاین و یک بار
     *    حضوری خرید کند دو حساب پیدا می‌کند و سابقه‌اش بینشان گم
     *    می‌شود. خوراک شماره را **نرمال‌شده** می‌فرستد، پس اینجا فقط
     *    یک دفاع دوم است.
     *
     * ── یک تفاوت عمدی با نسخه SQL ─────────────────────────────────
     *
     * `sales.normalize_mobile` شماره‌ای را که موبایل ایرانی نیست
     * (مثلاً تلفن ثابت) **دست‌نخورده برمی‌گرداند**، چون آنجا فقط
     * یکتایی مشتری مهم است. اینجا رد می‌شود و رشته خالی می‌دهد:
     * حساب کاربری سایت با تلفن ثابت نه ورود دارد و نه بازیابی رمز،
     * پس حسابی می‌ساخت که هیچ‌کس نمی‌توانست واردش شود.
     *
     * آن خرید وارد نمی‌شود و **لاگ می‌شود** — گم‌شدن بی‌صدا بدترین
     * حالت بود.
     */
    public static function normalize_mobile(string $raw): string
    {
        // ارقام فارسی و عربی به لاتین.
        $map = [
            '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4',
            '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
            '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4',
            '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
        ];
        $s = strtr($raw, $map);
        $s = preg_replace('/\D+/', '', $s) ?? '';

        if (strpos($s, '0098') === 0) {
            $s = '0' . substr($s, 4);
        } elseif (strpos($s, '98') === 0 && strlen($s) === 12) {
            $s = '0' . substr($s, 2);
        } elseif (strlen($s) === 10 && strpos($s, '9') === 0) {
            $s = '0' . $s;
        }

        return preg_match('/^09\d{9}$/', $s) === 1 ? $s : '';
    }

    /**
     * اقلام، پاک‌شده.
     *
     * هرچه از سرور می‌آید در متا می‌نشیند و بعداً روی صفحه می‌رود، پس
     * اینجا به شکل مورد انتظار محدود می‌شود — نه اینکه یک ساختار
     * دلخواه ذخیره شود.
     *
     * @param mixed $lines
     */
    public static function clean_lines($lines): array
    {
        if (!is_array($lines)) {
            return [];
        }
        $out = [];
        foreach ($lines as $l) {
            if (!is_array($l)) {
                continue;
            }
            $out[] = [
                'name'      => (string) ($l['name'] ?? ''),
                'sku'       => (string) ($l['sku'] ?? ''),
                'color'     => (string) ($l['color'] ?? ''),
                'size'      => (string) ($l['size'] ?? ''),
                'qty'       => (string) ($l['qty'] ?? '0'),
                'unitPrice' => (string) ($l['unitPrice'] ?? '0'),
                'netAmount' => (string) ($l['netAmount'] ?? '0'),
            ];
        }
        return $out;
    }

    /** صفحه «خریدهای حضوری» در حساب کاربری. */
    public static function render_account_page(): void
    {
        $user_id = get_current_user_id();
        if (!$user_id) {
            return;
        }

        $posts = get_posts([
            'post_type'   => self::POST_TYPE,
            'post_status' => 'publish',
            'author'      => $user_id,
            'numberposts' => 50,
            'orderby'     => 'date',
            'order'       => 'DESC',
        ]);

        if (empty($posts)) {
            echo '<p>' . esc_html__('هنوز خرید حضوری‌ای ثبت نشده است.', 'labelmod-connector') . '</p>';
            return;
        }

        echo '<table class="woocommerce-orders-table shop_table"><thead><tr>';
        echo '<th>' . esc_html__('شماره', 'labelmod-connector') . '</th>';
        echo '<th>' . esc_html__('تاریخ', 'labelmod-connector') . '</th>';
        echo '<th>' . esc_html__('مبلغ', 'labelmod-connector') . '</th>';
        echo '<th>' . esc_html__('اقلام', 'labelmod-connector') . '</th>';
        echo '</tr></thead><tbody>';

        foreach ($posts as $p) {
            $lines = get_post_meta($p->ID, '_lmc_lines', true);
            $lines = is_array($lines) ? $lines : [];
            $net   = (string) get_post_meta($p->ID, '_lmc_payable_amount', true);

            echo '<tr><td>';
            echo esc_html((string) get_post_meta($p->ID, '_lmc_number', true));
            // برچسبی که مشتری را گمراه نکند: این سفارش سایت نیست.
            echo ' <span class="lmc-tag">'
               . esc_html__('سفارش حضوری', 'labelmod-connector') . '</span>';
            echo '</td><td>';
            echo esc_html(self::purchase_date((int) $p->ID));
            echo '</td><td>';
            echo wp_kses_post(wc_price(self::to_site_amount($net)));
            echo '</td><td><ul style="margin:0;padding-inline-start:1em">';
            foreach ($lines as $l) {
                $label = trim(($l['name'] ?? '') . ' ' . ($l['color'] ?? '') . ' ' . ($l['size'] ?? ''));
                echo '<li>' . esc_html($label) . ' × ' . esc_html((string) ($l['qty'] ?? '')) . '</li>';
            }
            echo '</ul></td></tr>';
        }

        echo '</tbody></table>';
    }

    /** تاریخ خرید از سرور؛ تاریخ واردسازی هرگز جای تاریخ نامعلوم جا زده نمی‌شود. */
    public static function purchase_date(int $post_id): string
    {
        $raw = (string) get_post_meta($post_id, '_lmc_occurred_at', true);
        if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/', $raw)) {
            return '—';
        }
        try {
            $at = new DateTimeImmutable($raw);
            $errors = DateTimeImmutable::getLastErrors();
            if (is_array($errors) && ($errors['warning_count'] || $errors['error_count'])) {
                return '—';
            }
            return (string) wp_date((string) get_option('date_format', 'Y/m/d'), $at->getTimestamp(), wp_timezone());
        } catch (Exception $e) {
            return '—';
        }
    }

    /** ریال ذخیره‌شده → واحد پول سایت، برای نمایش. */
    public static function to_site_amount(string $rial): float
    {
        if (preg_match('/^\d+$/', $rial) !== 1) {
            return 0.0;
        }
        return lmc_setting('currency_unit') === 'rial'
            ? (float) $rial
            : (float) intdiv((int) $rial, 10);
    }
}
