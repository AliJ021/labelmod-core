<?php
/**
 * همگام‌سازی موجودی — تا سایت بیش از موجودی نفروشد.
 *
 * ── جهت، و اینکه چرا یک‌طرفه است ────────────────────────────────────
 *
 * انبار → سایت. **همیشه.** انبار فروشگاه مرجع است؛ سایت یک ویترین.
 * اگر روزی جهت برعکس هم اضافه شود، دو مرجع برای یک عدد داریم و اولین
 * قطعی شبکه معلوم می‌کند کدام برنده است — که هیچ‌کس نخواسته بود.
 *
 * ── اتصال با کلید، نه با SKU و نه با نام ────────────────────────────
 *
 * نام کالا در سایت و در حسابداری عمداً یکی **نیست** — تصمیم سئویی
 * مالک. SKU هم می‌تواند روزی عوض شود. پس هر کالای سایت متای
 * `_lmc_variation_id` می‌گیرد و از آن به بعد اتصال به آن بسته است:
 * نام و SKU هر دو می‌توانند آزادانه فرق کنند.
 *
 * SKU فقط برای **یک بار** برقرار کردن اتصال روی سایتی که هنوز متا
 * ندارد به کار می‌رود و همان لحظه متا نوشته می‌شود. پس از آن، متا حرف
 * آخر را می‌زند و SKU دیگر تطبیق نمی‌دهد.
 *
 * ── قیمت حالا همگام می‌شود ─────────────────────────────────────────
 *
 * تصمیم مالک: قیمت مرجع در حسابداری است و سایت از آن به‌روز می‌شود.
 * پیش از این عمداً نبود؛ حالا با یک کلید تنظیمات جدا روشن می‌شود تا
 * سایتی که کمپین مستقل دارد بتواند خاموشش کند.
 *
 * ⚠️ قیمت **صفر نوشته نمی‌شود.** `null` در خوراک یعنی «این کالا در آن
 *    فهرست قیمت ندارد»، نه «مجانی است». نوشتن صفر یعنی ویترین کالا را
 *    رایگان بفروشد.
 *
 * ── مکان‌نما، نه ساعت ───────────────────────────────────────────────
 *
 * هر پاسخ یک `cursor` می‌دهد و درخواست بعدی همان را `since` می‌فرستد.
 * با ساعت خودِ سایت کار نمی‌کرد: اختلاف ساعت میان دو ماشین یعنی یا
 * تغییری جا بیفتد (بدتر) یا هر بار همه‌چیز دوباره فرستاده شود.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Stock_Sync
{
    const CURSOR_OPTION = 'lmc_stock_cursor';
    const SKU_GENERATION = 'lmc_stock_sku_generation';
    const NEXT_PAGE_EVENT = 'lmc_sync_next_stock_page';
    const BATCH         = 500;
    /** کلید اتصال، روی خودِ کالای سایت. */
    const META_KEY      = '_lmc_variation_id';

    public static function init(): void
    {
        add_filter('woocommerce_duplicate_product_exclude_meta', [__CLASS__, 'exclude_duplicate_meta']);
        add_action(LMC_STOCK_EVENT, [__CLASS__, 'run']);
        add_action(self::NEXT_PAGE_EVENT, [__CLASS__, 'run']);
        add_action('added_post_meta', [__CLASS__, 'on_sku_change'], 10, 4);
        add_action('updated_post_meta', [__CLASS__, 'on_sku_change'], 10, 4);
        add_action('wp_ajax_lmc_stock_scan', [__CLASS__, 'ajax_scan']);
        add_action('admin_post_lmc_sync_now', [__CLASS__, 'handle_manual']);
    }

    /** WooCommerce uses the same exclusions for the product and every copied variation. */
    public static function exclude_duplicate_meta(array $keys): array
    {
        return array_values(array_unique(array_merge($keys, [
            self::META_KEY,
            LMC_Stock_Ledger::STATE_META,
            LMC_Stock_Ledger::VERSION_META,
            LMC_Push_Receiver::PRICE_VERSION_META,
        ])));
    }

    /** A newly entered site SKU can match a variation whose last stock change predates the cursor. */
    public static function on_sku_change($meta_id, $post_id, $key, $value): void
    {
        if ($key !== '_sku' || $value === '' || lmc_setting('link_by_sku') !== 'yes'
            || lmc_setting('sync_stock') !== 'yes'
            || !in_array(get_post_type($post_id), ['product', 'product_variation'], true)) {
            return;
        }
        update_option(self::SKU_GENERATION, wp_generate_uuid4(), false);
        self::schedule_next_page();
    }

    private static function schedule_next_page(): bool
    {
        return (bool) wp_next_scheduled(self::NEXT_PAGE_EVENT, [])
            || (bool) wp_schedule_single_event(time() + 60, self::NEXT_PAGE_EVENT, []);
    }

    /**
     * یک دور همگام‌سازی.
     *
     * @return array{updated:int,skipped:int,busy:int,linked:int,received:int,unchanged:int,invalid:int,price_enabled:bool,link_enabled:bool,error:string}
     */
    public static function run(bool $manual = false, string $scan_action = ''): array
    {
        global $wpdb;
        $out = ['updated' => 0, 'skipped' => 0, 'busy' => 0, 'linked' => 0, 'received' => 0, 'unchanged' => 0,
            'invalid' => 0, 'conflicts' => 0, 'price_enabled' => lmc_setting('sync_price') === 'yes',
            'link_enabled' => lmc_setting('link_by_sku') === 'yes', 'error' => ''];
        $lock = LMC_Push_Guard::lock_name(0, $wpdb->prefix . ':stock-feed');
        if (!LMC_Push_Guard::acquire($lock)) {
            $out['error'] = 'همگام‌سازی موجودی در حال اجراست. پس از پایان، ادامهٔ صفحات از همان نقطه خوانده می‌شود.';
            return $out;
        }
        try {
            return self::read_page($out, $manual, $scan_action);
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    private static function read_page(array $out, bool $manual, string $scan_action): array
    {
        if (lmc_setting('sync_stock') !== 'yes') {
            $out['error'] = __('دریافت موجودی خاموش است؛ ابتدا آن را در تنظیمات فعال کنید.', 'labelmod-connector');
            return $out;
        }
        $warehouse = (string) lmc_setting('warehouse_id');
        if ($warehouse === '') {
            $out['error'] = __('انبار در تنظیمات انتخاب نشده است.', 'labelmod-connector');
            return $out;
        }

        $query = ['warehouseId' => $warehouse, 'limit' => self::BATCH];
        $list  = (string) lmc_setting('price_list');
        if ($list !== '') {
            $query['priceList'] = $list;
        }
        // عقب‌ماندهٔ کسر، آشتی اولیه و بازمحاسبه‌های معوق پیش از هر خواندن.
        LMC_Stock_Ledger::maintain();
        // بازنشانی‌ای که پردازه‌اش پس از Commit دوره مُرد، پیش از هر خواندن ادامه می‌یابد؛ تا تمام نشده
        // این دور «خطا» گزارش می‌شود، نه موفقیت بی‌صدا (Pull کامل در همین دور باز هم انجام می‌شود).
        try {
            $reset = LMC_Stock_Ledger::resume_reset();
        } catch (Throwable $e) {
            $reset = ['pending' => true, 'failed' => 0];
            lmc_log('ادامهٔ بازنشانی واترمارک ناموفق: ' . $e->getMessage());
        }

        // دورهٔ واترمارک پیش از خواندن Core؛ اگر میان خواندن و نشاندن «بازنشانی» شود، این صفحه رد می‌شود.
        $epoch = LMC_Stock_Ledger::epoch();
        // مکان‌نما فقط در همان دوره معتبر است: پس از بازنشانی (حتی اگر پردازه‌اش پیش از هر کار دیگری
        // مُرده باشد) و برای مکان‌نمایی که Pull نسل قبل دیر نوشته، Pull کامل است نه افزایشی.
        $scope = hash('sha256', wp_json_encode([lmc_setting('base_url'), $warehouse, $list,
            $out['link_enabled'], $out['price_enabled'], lmc_setting('currency_unit')]));
        // Another request can finish a page before this request acquires the feed lock.
        if (function_exists('wp_cache_delete')) { wp_cache_delete(self::CURSOR_OPTION, 'options'); }
        $stored = get_option(self::CURSOR_OPTION, '');
        $checkpoint = is_array($stored) && ($stored['epoch'] ?? null) === $epoch && ($stored['scope'] ?? null) === $scope
            ? $stored : [];
        $report = $checkpoint['report'] ?? null;
        if ($scan_action === 'next' && empty($report['running'])) {
            $out['report'] = $report;
            if (!$report) { $out['error'] = 'وضعیت همگام‌سازی عوض شد؛ دوباره شروع کنید.'; }
            return $out;
        }
        if ($scan_action === 'start' && empty($report['running'])) {
            $checkpoint = [];
            $manual = true;
            $report = ['running' => true, 'received' => 0, 'updated' => 0, 'unchanged' => 0,
                'skipped' => 0, 'linked' => 0, 'invalid' => 0, 'conflicts' => 0];
        }
        $scan_started = $checkpoint['scan_started'] ?? time();
        $sku_generation = (string) get_option(self::SKU_GENERATION, '');
        $scanning_generation = $checkpoint['sku_generation'] ?? $sku_generation;
        $new_scan = empty($checkpoint['more'])
            && ($manual || $scanning_generation !== $sku_generation || time() - $scan_started >= 86400);
        if ($new_scan) {
            $checkpoint = [];
            $scanning_generation = $sku_generation;
            $scan_started = time();
            // Persist the restart before I/O so a busy first page or HTTP failure retries from the beginning.
            update_option(self::CURSOR_OPTION, ['epoch' => $epoch, 'scope' => $scope,
                'more' => true, 'report' => $report, 'scan_started' => $scan_started, 'sku_generation' => $scanning_generation, 'since' => null, 'id' => null], false);
        }
        if (!empty($checkpoint['since'])) {
            $query['since'] = $checkpoint['since'];
            if (!empty($checkpoint['id'])) { $query['sinceId'] = $checkpoint['id']; }
        } elseif (!$manual && is_string($stored)) {
            // Old Core ignores restartCatalog. New Core replays the catalog once on upgrade.
            $since = self::cursor_for($epoch);
            if ($since !== '') {
                $query['since'] = $since;
                $query['restartCatalog'] = '1';
            }
        }
        // زمان آغاز خواندن: درخواست رها کردن کسر فقط با عکسی تأیید می‌شود که پس از آن خوانده شده.
        $fetched_ms = (int) floor(microtime(true) * 1000);
        $res = LMC_Client::get('/web/stock', $query);
        if (is_wp_error($res)) {
            $out['error'] = $res->get_error_message();
            lmc_log('همگام‌سازی موجودی ناموفق: ' . $out['error']);
            return $out;
        }

        $sync_price = lmc_setting('sync_price') === 'yes';

        if (!isset($res['items']) || !is_array($res['items'])) {
            $out['error'] = 'پاسخ فهرست موجودی کامل نیست؛ دریافت از همین صفحه قابل تکرار است.';
            return $out;
        }
        $items = $res['items'];
        if (count($items) >= self::BATCH && (empty($res['cursor']) || (isset($query['since']) && $res['cursor'] === $query['since']
            && ($res['cursorId'] ?? null) === ($query['sinceId'] ?? null)))) {
            $out['error'] = 'حسابداری نشانگر صفحهٔ بعد را برنگرداند؛ دریافت کامل نشده است.';
            return $out;
        }
        $out['received'] = count($items);
        foreach ($items as $item) {
            $variation_id = isset($item['variationId']) ? (string) $item['variationId'] : '';
            $sku          = isset($item['sku']) ? (string) $item['sku'] : '';
            if ($variation_id === '' || !isset($item['available']) || !is_scalar($item['available'])
                || !preg_match('/^\d+(?:\.\d+)?$/D', (string) $item['available'])) {
                $out['invalid']++;
                continue;
            }
            // عدد در JSON **رشته** است — پول و تعداد هر دو. تبدیل صریح،
            // نه اتکا به تبدیل ضمنی PHP.
            $available = max(0, (int) $item['available']);

            $product_id = self::find_by_meta($variation_id);

            if (!$product_id && $sku !== '' && lmc_setting('link_by_sku') === 'yes') {
                // پل یک‌بارمصرف: روی سایتی که هنوز متا ندارد، اتصال با
                // SKU برقرار و همان لحظه در متا نوشته می‌شود. از دور
                // بعد، برای موجودی متا کافی است؛ ارسال سفارش هنوز SKU معتبر می‌خواهد.
                $product_id = wc_get_product_id_by_sku($sku);
                if ($product_id) {
                    $existing = (string) get_post_meta($product_id, self::META_KEY, true);
                    if ($existing !== '' && $existing !== $variation_id) {
                        // An explicit link takes precedence over a reused site SKU.
                        $out['conflicts']++;
                        continue;
                    }
                    if ($existing === '' && !update_post_meta($product_id, self::META_KEY, $variation_id)
                        && get_post_meta($product_id, self::META_KEY, true) !== $variation_id) {
                        $out['busy']++;
                        continue;
                    }
                    $out['linked']++;
                }
            }

            if (!$product_id) {
                // کالاهایی که در سایت نیستند طبیعی‌اند: انبار فروشگاه
                // کالاهایی دارد که آنلاین فروخته نمی‌شوند.
                $out['skipped']++;
                continue;
            }

            $product = wc_get_product($product_id);
            if (!$product) {
                $out['skipped']++;
                continue;
            }

            // ⚠️ موجودی فقط از دفتر کسر و زیر قفل مشترک با Push نشانده می‌شود:
            //    عکس Pull که از Push تازه‌تر کهنه‌تر است، یا کسر محلیِ تأییدنشده را در
            //    خود ندارد، واحد فروخته‌شده را برنمی‌گرداند (docs/STOCK-SYNC-PROTOCOL.md).
            if (array_key_exists('stockRev', $item)) {
                $rev = (string) $item['stockRev'];
                $res_stock = preg_match('/^[0-9]{1,18}$/D', $rev)
                    ? LMC_Stock_Ledger::apply_snapshot((int) $product_id, $available, ($item['active'] ?? true) !== false,
                        (int) $rev, $warehouse, 5, true, null, $epoch, $fetched_ms)
                    : ['ok' => false, 'applied' => false, 'rejected' => true];
            } else {
                $res_stock = LMC_Stock_Ledger::apply_legacy((int) $product_id, $available, 5);
            }
            if (!empty($res_stock['busy']) || !empty($res_stock['blocked']) || !empty($res_stock['rejected']) || isset($res_stock['error'])) {
                // مشغول، دفتر ناقص، عکس بی‌واترمارک/بدشکل یا شکست نوشتن: مکان‌نما جلو نمی‌رود تا
                // این سطر دوباره بیاید؛ و دیده می‌شود، نه بی‌صدا.
                $out['busy']++;
                continue;
            }
            $changed = !empty($res_stock['applied']);

            if ($sync_price) {
                $fresh = wc_get_product($product_id);
                if ($fresh && self::apply_price($fresh, self::price_for_site($item))) {
                    $fresh->save();
                    $changed = true;
                }
            }

            if ($changed) {
                $out['updated']++;
            } else {
                $out['unchanged']++;
            }
        }

        // مکان‌نما فقط وقتی جلو می‌رود که واقعاً سطری آمده باشد.
        // ذخیره‌کردن `null` یعنی دور بعد از اول شروع کند — که درست
        // است ولی هر بار همه‌چیز را می‌فرستد.
        $more = count($items) >= self::BATCH;
        if ($out['busy'] === 0 && !$reset['pending'] && $epoch === LMC_Stock_Ledger::epoch()) {
            if (array_key_exists('cursorId', $res) || $report) {
                if (!empty($report['running'])) {
                    foreach (['received', 'updated', 'unchanged', 'skipped', 'linked', 'invalid', 'conflicts'] as $key) {
                        $report[$key] += $out[$key];
                    }
                    $report['running'] = $more;
                }
                $next_checkpoint = [
                    'report' => $report,
                    'epoch' => $epoch, 'scope' => $scope, 'more' => $more, 'scan_started' => $scan_started,
                    'sku_generation' => $scanning_generation,
                    'since' => $res['cursor'] ?? ($checkpoint['since'] ?? null),
                    'id' => $res['cursorId'] ?? ($checkpoint['id'] ?? null),
                ];
                if (!update_option(self::CURSOR_OPTION, $next_checkpoint, false) && get_option(self::CURSOR_OPTION) !== $next_checkpoint) {
                    $out['error'] = 'ذخیرهٔ پیشرفت همگام‌سازی ممکن نشد؛ دوباره تلاش کنید.';
                    return $out;
                }
            } elseif (!empty($res['cursor'])) {
                update_option(self::CURSOR_OPTION, $epoch . ':' . (string) $res['cursor'], false);
            }
        }
        $out['report'] = $report;
        if (!empty($report['running']) && $out['busy'] > 0) {
            $out['error'] = 'برخی تنوع‌ها در حال تغییرند؛ دریافت از همین صفحه ادامه می‌یابد.';
        }
        if ($epoch !== LMC_Stock_Ledger::epoch()) {
            $out['error'] = 'دورهٔ موجودی عوض شد؛ همگام‌سازی را دوباره شروع کنید.';
        }
        if ($reset['pending']) {
            $out['error'] = __('بازنشانی واترمارک هنوز کامل نشده است (بازمحاسبهٔ بخشی از کالاها ماند)؛ دور بعد دوباره تلاش می‌کند. گزارش افزونه را ببینید.', 'labelmod-connector');
        }

        lmc_log(sprintf('موجودی: %d به‌روز، %d رد شد، %d اتصال تازه',
            $out['updated'], $out['skipped'], $out['linked']));

        // صفحه پر بود؟ یعنی احتمالاً باز هم هست. زودتر دوباره اجرا
        // شود تا عقب‌ماندگی روی چند ساعت پخش نشود.
        if (($more || $scanning_generation !== $sku_generation) && !self::schedule_next_page()) {
            $out['error'] = 'ثبت نوبت ادامهٔ صفحات موفق نشد. دکمهٔ همگام‌سازی را برای ادامه بزنید.';
        }

        return $out;
    }


    /** مکان‌نمای ذخیره‌شده برای این دوره، یا خالی (دورهٔ دیگر، قالب پیش از برچسب، یا بدشکل). */
    public static function cursor_for(int $epoch): string
    {
        $raw = get_option(self::CURSOR_OPTION, '');
        if (is_array($raw)) {
            return ($raw['epoch'] ?? null) === $epoch ? (string) ($raw['since'] ?? '') : '';
        }
        if (!is_string($raw) || !preg_match('/^([0-9]{1,18}):(.+)$/sD', $raw, $m)) { return ''; }
        return (int) $m[1] === $epoch ? $m[2] : '';
    }

    /**
     * کالای سایت از روی کلید اتصال.
     *
     * `wc_get_products` با `meta_key` هم کار می‌کند ولی تنوع‌ها
     * (`product_variation`) را برنمی‌گرداند، و در یک فروشگاه پوشاک
     * دقیقاً همان‌ها مهم‌اند. `get_posts` با هر دو نوع پست کار می‌کند.
     */
    /**
     * نشاندن موجودی روی یک کالا — **تنها تعریف**.
     *
     * ⚠️ این متد از دو مسیر صدا زده می‌شود: خوراک ۱۵ دقیقه‌ای (Pull) و
     *    مسیر REST ارسال لحظه‌ای (Push). دو نسخه از این منطق یعنی یکی
     *    از دو مسیر دیر یا زود عقب بماند — و چون هر دو «کار می‌کنند»،
     *    تفاوتشان فقط وقتی دیده می‌شود که ویترین عدد اشتباه نشان دهد.
     *
     * برمی‌گرداند: آیا چیزی واقعاً عوض شد.
     */
    /** فقط مدیریت موجودی و منع پیش‌خرید، بی دست‌زدن به عدد؛ عدد را دفتر کسر با تفاضل اتمیک می‌نویسد. */
    public static function prepare_managed($product): bool
    {
        $changed = false;
        if (!$product->get_manage_stock()) { $product->set_manage_stock(true); $changed = true; }
        if ($product->get_backorders() !== 'no') { $product->set_backorders('no'); $changed = true; }
        return $changed;
    }

    public static function apply_stock($product, int $available): bool
    {
        $changed = false;

        // مدیریت موجودی باید روشن باشد وگرنه عدد نوشته می‌شود و
        // ووکامرس نادیده‌اش می‌گیرد — بدترین حالت: عدد درست در
        // دیتابیس، فروش نامحدود در ویترین.
        if (!$product->get_manage_stock()) {
            $product->set_manage_stock(true);
            $changed = true;
        }

        if ($product->get_stock_quantity() === null || (int) $product->get_stock_quantity() !== $available) {
            $product->set_stock_quantity($available);
            $changed = true;
        }
        // ⚠️ سفارش معوق (Backorder) باید خاموش باشد، وگرنه دو تای بالا
        //    بی‌اثرند. ووکامرس در `validate_props()` وضعیت را از
        //    `backorders` بازمی‌سازد: با `yes` یا `notify`، موجودی صفر
        //    به `onbackorder` می‌نشیند و `is_in_stock()` **درست**
        //    برمی‌گرداند — یعنی ویترین کالای تمام‌شده را می‌فروشد و
        //    ما هرگز آن فروش را در انبار نداریم.
        //
        //    مرجع نهایی موجودی Core است، پس فروش بیش از عدد Core
        //    معنا ندارد. اگر مالک روزی واقعاً سفارش معوق بخواهد،
        //    آن یک تصمیم تازه است و جایش یک تنظیم است، نه این خط.
        if ($product->get_backorders() !== 'no') {
            $product->set_backorders('no');
            $changed = true;
        }

        $stock_status = $available > 0 ? 'instock' : 'outofstock';
        if ($product->get_stock_status() !== $stock_status) {
            $product->set_stock_status($stock_status);
            $changed = true;
        }

        return $changed;
    }

    /**
     * نشاندن قیمت — **تنها تعریف**، مثل بالا.
     *
     * ⚠️ `null` یعنی «قیمت ندارد» و دست نمی‌خورد. صفر نوشتن یعنی ویترین
     *    کالا را مجانی بفروشد. این با ارسال لحظه‌ای از «گاهی» به
     *    «همیشه» می‌رود، پس حساس‌تر هم شده.
     */
    public static function apply_price($product, ?string $price): bool
    {
        if ($price === null || $product->get_regular_price() === $price) {
            return false;
        }
        $product->set_regular_price($price);
        // فروش ویژه سایت دست نمی‌خورد: آن تصمیم بازاریابی سایت است، نه
        // عددی که از انبار می‌آید.
        return true;
    }

    public static function find_by_meta(string $variation_id): int
    {
        $found = get_posts([
            'post_type'      => ['product', 'product_variation'],
            'post_status'    => 'any',
            'numberposts'    => 1,
            'fields'         => 'ids',
            'meta_key'       => self::META_KEY,
            'meta_value'     => $variation_id,
            'no_found_rows'  => true,
        ]);
        return empty($found) ? 0 : (int) $found[0];
    }

    /**
     * ریال خوراک → واحد پول سایت، به‌شکل رشته.
     *
     * ⚠️ عکسِ `LMC_Order_Sync::to_rial()` و دقیقاً به همان اندازه
     *    حساس: غلط بودنش یعنی **همه** قیمت‌ها یک صفر کم یا زیاد
     *    داشته باشند. تقسیم بر ۱۰ در PHP اگر با `/` نوشته شود شناور
     *    می‌دهد و `1234567/10` را `123456.7` می‌کند — که برای تومان
     *    درست است ولی اگر مبلغ بر ۱۰ بخش‌پذیر نباشد، عددی با اعشار
     *    به ویترین می‌رود. `intdiv` این را صریح می‌کند.
     *
     * @param array $item یک سطر خوراک
     * @return string|null رشته قیمت، یا `null` اگر قیمتی نبود
     */
    public static function price_for_site(array $item): ?string
    {
        if (!isset($item['price']) || $item['price'] === null || $item['price'] === '') {
            return null;
        }
        $rial = (string) $item['price'];
        if (!preg_match('/^\d+$/', $rial)) {
            // خوراک باید رقم صحیح بدهد. هر چیز دیگری یعنی چیزی عوض
            // شده و قیمت **نوشته نمی‌شود** — بهتر از نوشتن یک عدد
            // حدسی روی ویترین.
            return null;
        }
        if (lmc_setting('currency_unit') === 'rial') {
            return $rial;
        }
        // تومان: تقسیم صحیح. باقی‌مانده ریالی روی ویترین معنا ندارد و
        // قیمت‌های واقعی پوشاک همیشه مضرب ۱۰ ریال‌اند.
        if (ltrim($rial, '0') === '') { return '0'; }
        $toman = ltrim(substr($rial, 0, -1), '0');
        return $toman === '' ? null : $toman;
    }

    /** خلاصهٔ همین صفحه؛ صفرِ تغییر به‌تنهایی موفقیت اتصال کالا را ثابت نمی‌کند. */
    public static function manual_summary(array $result): string
    {
        $text = sprintf('این صفحه: %d سطر دریافت شد؛ %d کالا به‌روز شد؛ %d کالا از قبل برابر بود؛ %d سطر بدون کالای متناظر؛ %d اتصال تازه؛ %d سطر نامعتبر.',
            $result['received'], $result['updated'], $result['unchanged'], $result['skipped'], $result['linked'], $result['invalid']);
        if ($result['received'] === 0) {
            $text .= ' در این صفحه سطر تازه‌ای برای دریافت نبود.';
        } elseif ($result['skipped'] > 0 && $result['received'] < self::BATCH) {
            $text .= ' شناسهٔ اتصال یا SKU دقیق محصول/تنوع سایت را بررسی کنید.';
        }
        if (!empty($result['conflicts'])) {
            $text .= sprintf(' %d کد به تنوع دیگری متصل است؛ اتصال ثبت‌شده را بررسی کنید.', $result['conflicts']);
        }
        if (!$result['link_enabled']) { $text .= ' اتصال اولیه با SKU خاموش است.'; }
        if (!$result['price_enabled']) { $text .= ' همگام‌سازی قیمت خاموش است؛ قیمت سایت تغییر نمی‌کند.'; }
        if (!empty($result['busy'])) { $text .= sprintf(' %d سطر نشانده نشد (مشغول، دفتر کسر ناقص یا عکس بی‌واترمارک)؛ دور بعد دوباره می‌آید.', $result['busy']); }
        if ($result['received'] >= self::BATCH) { $text .= ' هر سطر یک تنوع حسابداری (مثل یک رنگ و سایز) است. این شمارش فقط برای همین صفحه است؛ زمان‌بند ادامهٔ فهرست را بررسی می‌کند.'; }
        return $text;
    }

    public static function scan_message(array $result): string
    {
        $report = $result['report'] ?? null;
        if (!$report) { return self::manual_summary($result); }
        return ($report['running'] ? 'در حال بررسی فهرست. ' : 'بررسی کامل فهرست پایان یافت. ')
            . sprintf('%d تنوع بررسی شد؛ %d به‌روز، %d برابر، %d بدون کالای متناظر، %d اتصال تازه، %d نامعتبر و %d تعارض اتصال.',
                $report['received'], $report['updated'], $report['unchanged'], $report['skipped'],
                $report['linked'], $report['invalid'], $report['conflicts']);
    }

    public static function ajax_scan(): void
    {
        if (!current_user_can('manage_woocommerce')) { wp_send_json_error(null, 403); }
        check_ajax_referer('lmc_sync_now', '_wpnonce');
        $action = ($_POST['step'] ?? '') === 'start' ? 'start' : 'next';
        $result = self::run($action === 'start', $action);
        if ($result['error'] !== '') { wp_send_json_error(['message' => $result['error']]); }
        wp_send_json_success(['message' => self::scan_message($result), 'more' => !empty($result['report']['running'])]);
    }

    /** «همین حالا همگام کن» از صفحه تنظیمات. */
    public static function handle_manual(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_sync_now');

        $res = self::run(true, 'start');

        $args = $res['error'] !== ''
            ? ['lmc_msg' => 'sync_failed', 'lmc_detail' => rawurlencode($res['error'])]
            : ['lmc_msg' => 'synced', 'lmc_count' => $res['updated'], 'lmc_detail' => rawurlencode(self::scan_message($res))];

        wp_safe_redirect(add_query_arg($args, admin_url('admin.php?page=labelmod-connector')));
        exit;
    }
}
