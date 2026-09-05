<?php
/**
 * صفحه تنظیمات افزونه.
 *
 * ── چرا شعبه و انبار Dropdown‌اند و نه یک فیلد متنی ─────────────────
 *
 * شناسه‌ها UUID‌اند. خواستن یک UUID از مالک فروشگاه یعنی یک اشتباه
 * کپی‌کردن که تا اولین سفارش پیدا نمی‌شود — و آن‌وقت پیامش «به این
 * شعبه دسترسی ندارید» است، که هیچ‌کس از رویش نمی‌فهمد یک حرف جا
 * افتاده. فهرست از خودِ سامانه گرفته می‌شود (`GET /branches`)، یعنی
 * دقیقاً همان چیزی که سرور بعداً می‌پذیرد.
 *
 * ── کلید API نمایش داده نمی‌شود ─────────────────────────────────────
 *
 * فیلد کلید همیشه خالی نشان داده می‌شود و خالی‌ماندنش یعنی «دست
 * نخورد». نشان‌دادن کلید ذخیره‌شده در HTML یعنی هر کسی که به صفحه
 * تنظیمات دسترسی دارد — یا هر افزونه‌ای که DOM را می‌خواند — آن را
 * دارد. صفحه‌ای که راز را نمایش دهد، خودش یک نشت است.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Settings
{
    const PAGE = 'labelmod-connector';

    public static function init(): void
    {
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_post_lmc_save_settings', [__CLASS__, 'save']);
    }

    public static function menu(): void
    {
        add_submenu_page(
            'woocommerce',
            __('اتصال لیبل مد', 'labelmod-connector'),
            __('اتصال لیبل مد', 'labelmod-connector'),
            'manage_woocommerce',
            self::PAGE,
            [__CLASS__, 'render']
        );
    }

    public static function save(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_save_settings');

        $old = lmc_settings();
        $new = $old;

        // آدرس: فقط http/https، و بدون اسلش پایانی تا با `/api` جوش
        // نخورد به «//api».
        $base = isset($_POST['base_url']) ? esc_url_raw(wp_unslash($_POST['base_url']), ['http', 'https']) : '';
        $new['base_url'] = untrailingslashit($base);

        // کلید خالی یعنی «دست نخورد» — نه «پاکش کن». پاک‌کردن راه
        // خودش را دارد (تیک زیرش).
        $key = isset($_POST['api_key']) ? trim((string) wp_unslash($_POST['api_key'])) : '';
        if ($key !== '') {
            $new['api_key'] = sanitize_text_field($key);
        }
        if (!empty($_POST['clear_key'])) {
            $new['api_key'] = '';
        }

        foreach (['branch_id', 'warehouse_id'] as $field) {
            $new[$field] = isset($_POST[$field])
                ? sanitize_text_field(wp_unslash($_POST[$field]))
                : '';
        }

        $unit = isset($_POST['currency_unit']) ? sanitize_text_field(wp_unslash($_POST['currency_unit'])) : 'toman';
        $new['currency_unit'] = in_array($unit, ['toman', 'rial'], true) ? $unit : 'toman';

        $new['payment_map'] = isset($_POST['payment_map'])
            ? sanitize_textarea_field(wp_unslash($_POST['payment_map']))
            : '';

        $new['sync_stock']   = empty($_POST['sync_stock']) ? 'no' : 'yes';
        $new['sync_price']   = empty($_POST['sync_price']) ? 'no' : 'yes';
        $new['link_by_sku']  = empty($_POST['link_by_sku']) ? 'no' : 'yes';
        $new['sync_instore'] = empty($_POST['sync_instore']) ? 'no' : 'yes';
        $new['debug_log']    = empty($_POST['debug_log']) ? 'no' : 'yes';

        $list = isset($_POST['price_list'])
            ? sanitize_text_field(wp_unslash($_POST['price_list']))
            : 'default';
        $new['price_list'] = $list === '' ? 'default' : $list;

        update_option(LMC_OPTION, $new);

        // انبار عوض شد؟ مکان‌نما دیگر معنا ندارد — به انبار قبلی
        // اشاره می‌کرد و نگه‌داشتنش یعنی موجودی انبار تازه ناقص بیاید.
        if ($new['warehouse_id'] !== $old['warehouse_id']) {
            delete_option(LMC_Stock_Sync::CURSOR_OPTION);
        }

        // فهرست قیمت هم همین‌طور: مکان‌نما فقط تغییرات موجودی را دنبال
        // می‌کند، پس کالایی که فقط قیمتش در فهرست تازه فرق دارد هرگز
        // دوباره نمی‌آمد و ویترین با قیمت فهرست قبلی می‌ماند.
        if (($new['price_list'] ?? '') !== ($old['price_list'] ?? '')) {
            delete_option(LMC_Stock_Sync::CURSOR_OPTION);
        }

        // شعبه عوض شد؟ مکان‌نمای خرید حضوری به شعبه قبلی اشاره می‌کرد.
        if ($new['branch_id'] !== $old['branch_id']) {
            delete_option(LMC_Instore::CURSOR_OPTION);
            delete_option(LMC_Instore::CURSOR_ID);
        }

        wp_safe_redirect(add_query_arg('lmc_msg', 'saved', admin_url('admin.php?page=' . self::PAGE)));
        exit;
    }

    public static function render(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            return;
        }
        $s = lmc_settings();

        echo '<div class="wrap" dir="rtl">';
        echo '<h1>' . esc_html__('اتصال به سامانه لیبل مد', 'labelmod-connector') . '</h1>';

        self::notices();
        self::connection_box($s);

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('lmc_save_settings');
        echo '<input type="hidden" name="action" value="lmc_save_settings">';
        echo '<table class="form-table" role="presentation">';

        self::row(
            __('آدرس سامانه', 'labelmod-connector'),
            '<input type="url" name="base_url" class="regular-text" dir="ltr" value="'
                . esc_attr($s['base_url']) . '" placeholder="https://shop.example.com">',
            __('همان دامنه‌ای که پنل لیبل مد رویش باز می‌شود — بدون /api در انتها.', 'labelmod-connector')
        );

        $key_note = $s['api_key'] === ''
            ? __('هنوز کلیدی ذخیره نشده است.', 'labelmod-connector')
            : __('کلیدی ذخیره شده است. برای تغییر، کلید تازه را بنویسید؛ خالی گذاشتن یعنی دست‌نخورده بماند.', 'labelmod-connector');
        self::row(
            __('کلید API', 'labelmod-connector'),
            '<input type="password" name="api_key" class="regular-text" dir="ltr" autocomplete="new-password" value="">'
                . '<p><label><input type="checkbox" name="clear_key" value="1"> '
                . esc_html__('کلید ذخیره‌شده پاک شود', 'labelmod-connector') . '</label></p>',
            $key_note . ' ' . __('کلید را با دستور create-api-client روی سرور بسازید.', 'labelmod-connector')
        );

        [$branches, $scope_error] = self::fetch_scope();
        self::row(
            __('شعبه', 'labelmod-connector'),
            self::branch_select($branches, $s['branch_id'], $scope_error),
            __('فاکتور سایت به این شعبه می‌خورد.', 'labelmod-connector')
        );
        self::row(
            __('انبار', 'labelmod-connector'),
            self::warehouse_select($branches, $s['branch_id'], $s['warehouse_id'], $scope_error),
            __('کالا از این انبار خارج می‌شود و موجودی سایت از همین‌جا می‌آید.', 'labelmod-connector')
        );

        self::row(
            __('واحد پول سایت', 'labelmod-connector'),
            '<label><input type="radio" name="currency_unit" value="toman" '
                . checked($s['currency_unit'], 'toman', false) . '> '
                . esc_html__('تومان', 'labelmod-connector') . '</label> &nbsp; '
                . '<label><input type="radio" name="currency_unit" value="rial" '
                . checked($s['currency_unit'], 'rial', false) . '> '
                . esc_html__('ریال', 'labelmod-connector') . '</label>',
            __('⚠️ سامانه لیبل مد ریال نگه می‌دارد. اگر این گزینه غلط باشد، همه مبالغ یک صفر کم یا زیاد می‌گیرند.', 'labelmod-connector')
        );

        self::row(
            __('نگاشت درگاه پرداخت', 'labelmod-connector'),
            '<textarea name="payment_map" rows="4" class="large-text" dir="ltr">'
                . esc_textarea($s['payment_map']) . '</textarea>',
            __('هر خط یکی: شناسه درگاه ووکامرس = کد روش پرداخت لیبل مد. مثال: zarinpal=gateway — بدون نگاشت، «gateway» فرض می‌شود.', 'labelmod-connector')
        );

        self::row(
            __('همگام‌سازی موجودی', 'labelmod-connector'),
            '<label><input type="checkbox" name="sync_stock" value="1" '
                . checked($s['sync_stock'], 'yes', false) . '> '
                . esc_html__('موجودی سایت هر ۱۵ دقیقه از انبار به‌روز شود', 'labelmod-connector') . '</label>',
            __('انبار مرجع است. اتصال با کلید «_lmc_variation_id» روی کالای سایت برقرار می‌شود، نه با نام و نه با SKU — پس نام سایت می‌تواند برای سئو آزادانه فرق کند.', 'labelmod-connector')
        );

        self::row(
            __('همگام‌سازی قیمت', 'labelmod-connector'),
            '<label><input type="checkbox" name="sync_price" value="1" '
                . checked($s['sync_price'], 'yes', false) . '> '
                . esc_html__('قیمت کالاهای سایت از حسابداری به‌روز شود', 'labelmod-connector') . '</label>',
            __('قیمت مرجع در حسابداری است. «فروش ویژه» ووکامرس دست نمی‌خورد؛ فقط قیمت اصلی نوشته می‌شود. کالایی که در فهرست قیمت انتخاب‌شده قیمت ندارد، دست‌نخورده می‌ماند — صفر نوشته نمی‌شود.', 'labelmod-connector')
        );

        self::row(
            __('فهرست قیمت', 'labelmod-connector'),
            '<input type="text" name="price_list" class="regular-text" dir="ltr" value="'
                . esc_attr($s['price_list']) . '">',
            __('کدام فهرست قیمت به سایت برود. پیش‌فرض «default» — اگر قیمت آنلاین جدا دارید، کد همان فهرست را بنویسید.', 'labelmod-connector')
        );

        self::row(
            __('اتصال اولیه با SKU', 'labelmod-connector'),
            '<label><input type="checkbox" name="link_by_sku" value="1" '
                . checked($s['link_by_sku'], 'yes', false) . '> '
                . esc_html__('کالاهایی که هنوز کلید اتصال ندارند، یک بار با SKU پیدا شوند', 'labelmod-connector') . '</label>',
            __('پلی برای سایتی که تازه وصل می‌شود: کلید اتصال همان لحظه نوشته می‌شود. پس از یک دور کامل می‌توانید خاموشش کنید تا SKU سایت آزادانه عوض شود.', 'labelmod-connector')
        );

        self::row(
            __('خریدهای حضوری در حساب کاربری', 'labelmod-connector'),
            '<label><input type="checkbox" name="sync_instore" value="1" '
                . checked($s['sync_instore'], 'yes', false) . '> '
                . esc_html__('خرید حضوری مشتری در حساب کاربری سایت دیده شود', 'labelmod-connector') . '</label>',
            __('با شماره موبایل به حساب مشتری وصل می‌شود و اگر حسابی نباشد ساخته می‌شود. این رکورد **سفارش ووکامرس نیست**: موجودی را کم نمی‌کند، ایمیل نمی‌فرستد و در گزارش فروش سایت نمی‌آید.', 'labelmod-connector')
        );

        self::row(
            __('لاگ عیب‌یابی', 'labelmod-connector'),
            '<label><input type="checkbox" name="debug_log" value="1" '
                . checked($s['debug_log'], 'yes', false) . '> '
                . esc_html__('در ووکامرس ← وضعیت ← گزارش‌ها ثبت شود', 'labelmod-connector') . '</label>',
            __('کلید API هرگز در لاگ نمی‌نشیند.', 'labelmod-connector')
        );

        echo '</table>';
        submit_button(__('ذخیره', 'labelmod-connector'));
        echo '</form>';

        // همگام‌سازی دستی — فرم جدا، چون یک عمل است نه یک تنظیم.
        echo '<hr><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('lmc_sync_now');
        echo '<input type="hidden" name="action" value="lmc_sync_now">';
        submit_button(__('همین حالا موجودی را همگام کن', 'labelmod-connector'), 'secondary', 'submit', false);
        echo ' <span class="description">'
            . esc_html__('همه کالاها را دوباره می‌گیرد، نه فقط تغییرات تازه.', 'labelmod-connector')
            . '</span></form>';

        echo '</div>';
    }

    /** پیام‌های بعد از ذخیره و همگام‌سازی. */
    private static function notices(): void
    {
        $msg = isset($_GET['lmc_msg']) ? sanitize_text_field(wp_unslash($_GET['lmc_msg'])) : '';
        if ($msg === 'saved') {
            echo '<div class="notice notice-success"><p>'
                . esc_html__('تنظیمات ذخیره شد.', 'labelmod-connector') . '</p></div>';
        } elseif ($msg === 'synced') {
            $n = isset($_GET['lmc_count']) ? (int) $_GET['lmc_count'] : 0;
            printf(
                '<div class="notice notice-success"><p>%s</p></div>',
                esc_html(sprintf(
                    /* translators: %d: تعداد کالاهای به‌روزشده */
                    __('همگام‌سازی انجام شد — %d کالا به‌روز شد.', 'labelmod-connector'),
                    $n
                ))
            );
        } elseif ($msg === 'sync_failed') {
            $detail = isset($_GET['lmc_detail'])
                ? sanitize_text_field(rawurldecode(wp_unslash($_GET['lmc_detail'])))
                : '';
            printf(
                '<div class="notice notice-error"><p>%s</p></div>',
                esc_html(sprintf(
                    /* translators: %s: پیام خطا */
                    __('همگام‌سازی ناموفق بود: %s', 'labelmod-connector'),
                    $detail
                ))
            );
        }
    }

    /**
     * وضعیت اتصال — پیش از هر چیز دیگر.
     *
     * بدون این، تنها راه فهمیدن «آیا کلید کار می‌کند» یک سفارش واقعی
     * بود — یعنی اولین خبر از پیکربندی غلط، یک سفارش گم‌شده.
     */
    private static function connection_box(array $s): void
    {
        if ($s['base_url'] === '' || $s['api_key'] === '') {
            echo '<div class="notice notice-warning inline"><p>'
                . esc_html__('هنوز وصل نشده: آدرس سامانه و کلید API را وارد کنید.', 'labelmod-connector')
                . '</p></div>';
            return;
        }

        [$branches, $error] = self::fetch_scope();
        if ($error !== '') {
            printf(
                '<div class="notice notice-error inline"><p>%s</p></div>',
                esc_html(sprintf(
                    /* translators: %s: پیام خطای سامانه */
                    __('اتصال برقرار نشد: %s', 'labelmod-connector'),
                    $error
                ))
            );
            return;
        }

        printf(
            '<div class="notice notice-success inline"><p>%s</p></div>',
            esc_html(sprintf(
                /* translators: %d: تعداد شعبه‌های در دسترس */
                __('اتصال برقرار است — %d شعبه در دسترس این کلید.', 'labelmod-connector'),
                count($branches)
            ))
        );
    }

    /**
     * شعبه‌ها و انبارهایشان، با Cache کوتاه.
     *
     * ۶۰ ثانیه عمدی است: صفحه تنظیمات چند بار در یک بازدید رندر
     * می‌شود (جعبه وضعیت، Dropdown شعبه، Dropdown انبار) و بدون
     * Cache هر بار یک درخواست شبکه می‌خورد.
     *
     * @return array{0:array,1:string} فهرست شعبه‌ها و پیام خطا
     */
    private static function fetch_scope(): array
    {
        static $cache = null;
        if ($cache !== null) {
            return $cache;
        }

        $res = LMC_Client::get('/branches');
        if (is_wp_error($res)) {
            $cache = [[], $res->get_error_message()];
            return $cache;
        }

        $branches = isset($res['branches']) && is_array($res['branches']) ? $res['branches'] : [];
        $cache = [$branches, ''];
        return $cache;
    }

    private static function branch_select(array $branches, string $selected, string $error): string
    {
        if ($error !== '' && !$branches) {
            return '<input type="hidden" name="branch_id" value="' . esc_attr($selected) . '">'
                . '<em>' . esc_html__('تا وقتی اتصال برقرار نشود، فهرست شعبه‌ها نمی‌آید.', 'labelmod-connector') . '</em>';
        }

        $html = '<select name="branch_id"><option value="">—</option>';
        foreach ($branches as $b) {
            $id = isset($b['id']) ? (string) $b['id'] : '';
            $html .= sprintf(
                '<option value="%s" %s>%s</option>',
                esc_attr($id),
                selected($selected, $id, false),
                esc_html((string) ($b['name'] ?? $id))
            );
        }
        return $html . '</select>';
    }

    private static function warehouse_select(
        array $branches,
        string $branch_id,
        string $selected,
        string $error
    ): string {
        if ($error !== '' && !$branches) {
            return '<input type="hidden" name="warehouse_id" value="' . esc_attr($selected) . '">'
                . '<em>' . esc_html__('تا وقتی اتصال برقرار نشود، فهرست انبارها نمی‌آید.', 'labelmod-connector') . '</em>';
        }

        $html = '<select name="warehouse_id"><option value="">—</option>';
        foreach ($branches as $b) {
            // فقط انبارهای شعبه انتخاب‌شده: انبار شعبه دیگر را سرور
            // رد می‌کند، پس نشان‌دادنش فقط یک تله است.
            if ($branch_id !== '' && (string) ($b['id'] ?? '') !== $branch_id) {
                continue;
            }
            $warehouses = isset($b['warehouses']) && is_array($b['warehouses']) ? $b['warehouses'] : [];
            foreach ($warehouses as $w) {
                $id = isset($w['id']) ? (string) $w['id'] : '';
                $html .= sprintf(
                    '<option value="%s" %s>%s</option>',
                    esc_attr($id),
                    selected($selected, $id, false),
                    esc_html((string) ($w['name'] ?? $id))
                );
            }
        }
        return $html . '</select>';
    }

    private static function row(string $label, string $field, string $help): void
    {
        printf(
            '<tr><th scope="row">%s</th><td>%s<p class="description">%s</p></td></tr>',
            esc_html($label),
            // فیلدها بالا با esc_attr ساخته شده‌اند؛ اینجا HTML عمدی است.
            $field, // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
            esc_html($help)
        );
    }
}
