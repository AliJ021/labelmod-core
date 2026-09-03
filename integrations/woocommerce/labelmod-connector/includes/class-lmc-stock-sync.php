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
 * ── قیمت اینجا نیست، و نباید باشد ───────────────────────────────────
 *
 * قیمت سایت می‌تواند از قیمت فروشگاه فرق کند: کمپین، ارسال رایگانِ
 * بسته‌شده در قیمت، قیمت آنلاین متفاوت. همگام‌سازی خودکار قیمت یک
 * تصمیم تجاری است که مالک باید بگیرد، نه چیزی که بی‌صدا اتفاق بیفتد.
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
        $out = ['updated' => 0, 'skipped' => 0, 'error' => ''];

        if (lmc_setting('sync_stock') !== 'yes') {
            return $out;
        }
        $warehouse = (string) lmc_setting('warehouse_id');
        if ($warehouse === '') {
            $out['error'] = __('انبار در تنظیمات انتخاب نشده است.', 'labelmod-connector');
            return $out;
        }

        $query = ['warehouseId' => $warehouse, 'limit' => self::BATCH];
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

        $items = isset($res['items']) && is_array($res['items']) ? $res['items'] : [];
        foreach ($items as $item) {
            $sku = isset($item['sku']) ? (string) $item['sku'] : '';
            if ($sku === '' || !isset($item['available'])) {
                continue;
            }
            // عدد در JSON **رشته** است — پول و تعداد هر دو. تبدیل صریح،
            // نه اتکا به تبدیل ضمنی PHP.
            $available = max(0, (int) $item['available']);

            $product_id = wc_get_product_id_by_sku($sku);
            if (!$product_id) {
                // SKUهایی که در سایت نیستند طبیعی‌اند: انبار فروشگاه
                // کالاهایی دارد که آنلاین فروخته نمی‌شوند.
                $out['skipped']++;
                continue;
            }

            $product = wc_get_product($product_id);
            if (!$product) {
                $out['skipped']++;
                continue;
            }

            // مدیریت موجودی باید روشن باشد وگرنه عدد نوشته می‌شود و
            // ووکامرس نادیده‌اش می‌گیرد — بدترین حالت: عدد درست در
            // دیتابیس، فروش نامحدود در ویترین.
            if (!$product->get_manage_stock()) {
                $product->set_manage_stock(true);
            }

            if ((int) $product->get_stock_quantity() === $available) {
                continue;
            }

            $product->set_stock_quantity($available);
            $product->set_stock_status($available > 0 ? 'instock' : 'outofstock');
            $product->save();
            $out['updated']++;
        }

        // مکان‌نما فقط وقتی جلو می‌رود که واقعاً سطری آمده باشد.
        // ذخیره‌کردن `null` یعنی دور بعد از اول شروع کند — که درست
        // است ولی هر بار همه‌چیز را می‌فرستد.
        if (!empty($res['cursor'])) {
            update_option(self::CURSOR_OPTION, (string) $res['cursor'], false);
        }

        lmc_log(sprintf('موجودی: %d به‌روز، %d رد شد', $out['updated'], $out['skipped']));

        // صفحه پر بود؟ یعنی احتمالاً باز هم هست. زودتر دوباره اجرا
        // شود تا عقب‌ماندگی روی چند ساعت پخش نشود.
        if (count($items) >= self::BATCH) {
            wp_schedule_single_event(time() + 60, LMC_STOCK_EVENT);
        }

        return $out;
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
