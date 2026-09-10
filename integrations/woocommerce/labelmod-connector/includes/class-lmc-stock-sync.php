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
    const BATCH         = 500;
    /** کلید اتصال، روی خودِ کالای سایت. */
    const META_KEY      = '_lmc_variation_id';

    public static function init(): void
    {
        add_action(LMC_STOCK_EVENT, [__CLASS__, 'run']);
        add_action('admin_post_lmc_sync_now', [__CLASS__, 'handle_manual']);
    }

    /**
     * یک دور همگام‌سازی.
     *
     * @return array{updated:int,skipped:int,error:string}
     */
    public static function run(): array
    {
        $out = ['updated' => 0, 'skipped' => 0, 'linked' => 0, 'error' => ''];

        if (lmc_setting('sync_stock') !== 'yes') {
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
        $since = get_option(self::CURSOR_OPTION, '');
        if (is_string($since) && $since !== '') {
            $query['since'] = $since;
        }

        $res = LMC_Client::get('/web/stock', $query);
        if (is_wp_error($res)) {
            $out['error'] = $res->get_error_message();
            lmc_log('همگام‌سازی موجودی ناموفق: ' . $out['error']);
            return $out;
        }

        $sync_price = lmc_setting('sync_price') === 'yes';

        $items = isset($res['items']) && is_array($res['items']) ? $res['items'] : [];
        foreach ($items as $item) {
            $variation_id = isset($item['variationId']) ? (string) $item['variationId'] : '';
            $sku          = isset($item['sku']) ? (string) $item['sku'] : '';
            if ($variation_id === '' || !isset($item['available'])) {
                continue;
            }
            // عدد در JSON **رشته** است — پول و تعداد هر دو. تبدیل صریح،
            // نه اتکا به تبدیل ضمنی PHP.
            $available = max(0, (int) $item['available']);

            $product_id = self::find_by_meta($variation_id);

            if (!$product_id && $sku !== '' && lmc_setting('link_by_sku') === 'yes') {
                // پل یک‌بارمصرف: روی سایتی که هنوز متا ندارد، اتصال با
                // SKU برقرار و همان لحظه در متا نوشته می‌شود. از دور
                // بعد، متا کافی است و SKU می‌تواند آزادانه عوض شود.
                $product_id = wc_get_product_id_by_sku($sku);
                if ($product_id) {
                    update_post_meta($product_id, self::META_KEY, $variation_id);
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
            $stock_status = $available > 0 ? 'instock' : 'outofstock';
            if ($product->get_stock_status() !== $stock_status) {
                $product->set_stock_status($stock_status);
                $changed = true;
            }

            if ($sync_price) {
                $price = self::price_for_site($item);
                // `null` یعنی «قیمت ندارد» و دست نمی‌خورد. صفر نوشتن
                // یعنی ویترین کالا را مجانی بفروشد.
                if ($price !== null && $product->get_regular_price() !== $price) {
                    $product->set_regular_price($price);
                    // فروش ویژه سایت دست نمی‌خورد: آن تصمیم بازاریابی
                    // سایت است، نه عددی که از انبار می‌آید.
                    $changed = true;
                }
            }

            if ($changed) {
                $product->save();
                $out['updated']++;
            }
        }

        // مکان‌نما فقط وقتی جلو می‌رود که واقعاً سطری آمده باشد.
        // ذخیره‌کردن `null` یعنی دور بعد از اول شروع کند — که درست
        // است ولی هر بار همه‌چیز را می‌فرستد.
        if (!empty($res['cursor'])) {
            update_option(self::CURSOR_OPTION, (string) $res['cursor'], false);
        }

        lmc_log(sprintf('موجودی: %d به‌روز، %d رد شد، %d اتصال تازه',
            $out['updated'], $out['skipped'], $out['linked']));

        // صفحه پر بود؟ یعنی احتمالاً باز هم هست. زودتر دوباره اجرا
        // شود تا عقب‌ماندگی روی چند ساعت پخش نشود.
        if (count($items) >= self::BATCH) {
            wp_schedule_single_event(time() + 60, LMC_STOCK_EVENT);
        }

        return $out;
    }


    /**
     * کالای سایت از روی کلید اتصال.
     *
     * `wc_get_products` با `meta_key` هم کار می‌کند ولی تنوع‌ها
     * (`product_variation`) را برنمی‌گرداند، و در یک فروشگاه پوشاک
     * دقیقاً همان‌ها مهم‌اند. `get_posts` با هر دو نوع پست کار می‌کند.
     */
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
        return (string) intdiv((int) $rial, 10);
    }

    /** «همین حالا همگام کن» از صفحه تنظیمات. */
    public static function handle_manual(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_sync_now');

        // ⚠️ مکان‌نما پاک می‌شود: کسی که دکمه را می‌زند معمولاً
        //    می‌خواهد **همه** را دوباره بگیرد، نه فقط تغییرات تازه.
        delete_option(self::CURSOR_OPTION);
        $res = self::run();

        $args = $res['error'] !== ''
            ? ['lmc_msg' => 'sync_failed', 'lmc_detail' => rawurlencode($res['error'])]
            : ['lmc_msg' => 'synced', 'lmc_count' => $res['updated']];

        wp_safe_redirect(add_query_arg($args, admin_url('admin.php?page=labelmod-connector')));
        exit;
    }
}
