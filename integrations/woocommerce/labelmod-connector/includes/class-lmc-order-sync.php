<?php
/**
 * ارسال سفارش به لیبل مد.
 *
 * ── چه وقت فرستاده می‌شود ───────────────────────────────────────────
 *
 * فقط وقتی **پول واقعاً گرفته شده**: رویداد `payment_complete` ووکامرس
 * و وضعیت فعلی `processing` یا `completed`.
 * سفارش `pending` و `on-hold` فرستاده نمی‌شود، چون فاکتور در آن سامانه
 * کالا را همان لحظه از انبار خارج می‌کند — سفارشی که هرگز پرداخت نشود،
 * موجودی را می‌خورد و کسی هم نمی‌فهمد چرا.
 *
 * ── چرا ناهم‌زمان ───────────────────────────────────────────────────
 *
 * ارسال هرگز نباید Checkout را کند یا خراب کند. اگر سرور لیبل مد پایین
 * باشد، مشتری باید بتواند خریدش را تمام کند. پس اینجا فقط یک رویداد
 * زمان‌بندی می‌شود و کار واقعی بعداً انجام می‌گیرد.
 *
 * ── تکرار، و چرا نگرانش نیستیم ──────────────────────────────────────
 *
 * سرور `externalId` را کلید Idempotency می‌گیرد. یعنی ارسال دوباره —
 * از Retry، از تغییر وضعیت، از فشار دستی دکمه — فاکتور دوم نمی‌سازد و
 * همان فاکتور اول را برمی‌گرداند. این افزونه هم `_lmc_invoice_id` را
 * روی سفارش می‌گذارد و اگر باشد، دیگر نمی‌فرستد. **دو لایه، و لایه
 * سرور همان است که اهمیت دارد** — چون متای وردپرس می‌تواند در
 * مهاجرت یا بازیابی بکاپ گم شود.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Order_Sync
{
    const META_INVOICE  = '_lmc_invoice_id';
    const META_NUMBER   = '_lmc_invoice_number';
    const META_ATTEMPTS = '_lmc_attempts';
    const META_ERROR    = '_lmc_last_error';
    const META_PAID     = '_lmc_payment_complete';
    const META_PAYLOAD  = '_lmc_order_payload';
    const META_LINES    = '_lmc_order_line_map';

    /** سقف تلاش. بعد از این، سفارش دست انسان است نه صف. */
    const MAX_ATTEMPTS = 6;

    public static function init(): void
    {
        add_action('woocommerce_payment_complete', [__CLASS__, 'payment_complete']);
        add_action(LMC_ORDER_EVENT, [__CLASS__, 'send']);

        add_action('add_meta_boxes', [__CLASS__, 'meta_box']);
        add_action('admin_post_lmc_resend', [__CLASS__, 'handle_resend']);
        add_action('admin_post_lmc_confirm_payment', [__CLASS__, 'handle_confirm_payment']);
    }

    /**
     * زمان‌بندی ارسال.
     *
     * تأخیر ۱۰ ثانیه‌ای عمدی است: در لحظه `processing` ووکامرس هنوز
     * ممکن است متای پرداخت را ننوشته باشد و `get_transaction_id()`
     * تهی برگردد — شماره پیگیری‌ای که بعداً هیچ‌جا پیدا نمی‌شود.
     */
    public static function payment_complete($order_id): void
    {
        $order_id = (int) $order_id;
        if ($order_id <= 0) {
            return;
        }
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta(self::META_INVOICE) !== '') {
            return;
        }

        // خود status برای اثبات پرداخت کافی نیست: پرداخت در محل هم
        // پیش از دریافت پول وارد processing می‌شود. این نشان فقط از
        // رویداد موفق پرداخت ووکامرس نوشته می‌شود.
        $order->update_meta_data(self::META_PAID, 'yes');
        $order->save();

        if (!wp_next_scheduled(LMC_ORDER_EVENT, [$order_id])) {
            wp_schedule_single_event(time() + 10, LMC_ORDER_EVENT, [$order_id]);
        }
    }

    /** ارسال واقعی — از دل Cron. */
    public static function send($order_id): void
    {
        $order_id = (int) $order_id;
        $order    = wc_get_order($order_id);
        if (!$order) {
            return;
        }
        if ($order->get_meta(self::META_INVOICE) !== '' || !self::is_eligible($order)) {
            return;
        }

        $payload = self::snapshot($order);
        if (is_wp_error($payload)) {
            self::fail($order, $payload, false);
            return;
        }

        $res = LMC_Client::post('/web/orders', $payload);

        if (is_wp_error($res)) {
            self::fail($order, $res, LMC_Client::is_retryable($res));
            return;
        }

        $order->update_meta_data(self::META_INVOICE, (string) ($res['invoiceId'] ?? ''));
        $order->update_meta_data(self::META_NUMBER, (string) ($res['number'] ?? ''));
        $order->delete_meta_data(self::META_ERROR);
        $order->add_order_note(sprintf(
            /* translators: %s: شماره فاکتور در سامانه لیبل مد */
            __('در لیبل مد ثبت شد — فاکتور %s', 'labelmod-connector'),
            (string) ($res['number'] ?? '—')
        ));

        // ⚠️ مقایسه مبلغ، و چرا نه یک بررسی ساکت.
        //
        // مبلغ فاکتور از **جمع سطرها در دیتابیس** می‌آید، نه از عددی
        // که ما فرستادیم. اگر با جمع ووکامرس یکی نباشد، یعنی جایی
        // گرد کردن یا تبدیل واحد فرق کرده — و آن اختلاف تا وقتی روی
        // سفارش نوشته نشود، ماه‌ها بعد در مغایرت‌گیری پیدا می‌شود.
        $sent     = self::to_rial($order->get_total());
        $recorded = isset($res['payableAmount']) ? (string) $res['payableAmount'] : '';
        if ($recorded !== '' && $recorded !== (string) $sent) {
            $order->add_order_note(sprintf(
                /* translators: 1: مبلغ ووکامرس 2: مبلغ لیبل مد — هر دو ریال */
                __('⚠️ اختلاف مبلغ: ووکامرس %1$s ریال، لیبل مد %2$s ریال. بررسی شود.', 'labelmod-connector'),
                number_format_i18n((float) $sent),
                number_format_i18n((float) $recorded)
            ));
        }

        $order->save();
        lmc_log(sprintf('سفارش %d ثبت شد → %s', $order_id, (string) ($res['number'] ?? '')));
    }

    /** Freeze the exact order and item identities before the first HTTP attempt. */
    public static function snapshot(WC_Order $order)
    {
        $saved = $order->get_meta(self::META_PAYLOAD);
        if (is_array($saved) && is_array($order->get_meta(self::META_LINES))) {
            return $saved;
        }
        if ($order->get_meta(self::META_INVOICE) !== '') {
            return new WP_Error('lmc_legacy_line_map', 'نگاشت اقلام فاکتور قدیمی موجود نیست؛ تطبیق دستی لازم است.');
        }
        $payload = self::build_payload($order);
        if (is_wp_error($payload)) { return $payload; }
        $map = [];
        $n = 0;
        foreach ($order->get_items() as $id => $item) {
            if ($item instanceof WC_Order_Item_Product && (int) $item->get_quantity() > 0) {
                $map[(int) $id] = ++$n;
            }
        }
        $order->update_meta_data(self::META_PAYLOAD, $payload);
        $order->update_meta_data(self::META_LINES, $map);
        $order->save();
        return $payload;
    }

    /**
     * شرط ارسال در لحظه اجرای هر کار و Retry دوباره بررسی می‌شود.
     * به این ترتیب سفارش لغوشده پس از صف‌شدن نیز ارسال نمی‌شود.
     */
    private static function is_eligible(WC_Order $order): bool
    {
        return $order->get_meta(self::META_PAID) === 'yes'
            && $order->has_status(['processing', 'completed', 'refunded']);
    }

    /**
     * بدنه درخواست.
     *
     * @return array|WP_Error
     */
    public static function build_payload(WC_Order $order)
    {
        $branch    = (string) lmc_setting('branch_id');
        $warehouse = (string) lmc_setting('warehouse_id');
        if ($branch === '' || $warehouse === '') {
            return new WP_Error(
                'lmc_not_configured',
                __('شعبه و انبار در تنظیمات افزونه انتخاب نشده‌اند.', 'labelmod-connector'),
                ['kind' => LMC_Client::PERMANENT]
            );
        }

        $lines = [];
        foreach ($order->get_items() as $item) {
            if (!$item instanceof WC_Order_Item_Product) {
                continue;
            }
            $product = $item->get_product();
            $sku     = $product ? (string) $product->get_sku() : '';
            if ($sku === '') {
                return new WP_Error(
                    'lmc_missing_sku',
                    sprintf(
                        /* translators: %s: نام کالا در ووکامرس */
                        __('کالای «%s» در ووکامرس SKU ندارد. بدون SKU، سامانه نمی‌داند کدام کالا فروخته شده.', 'labelmod-connector'),
                        $item->get_name()
                    ),
                    ['kind' => LMC_Client::PERMANENT]
                );
            }

            $qty = (int) $item->get_quantity();
            if ($qty <= 0) {
                continue;
            }

            // ⚠️ قیمت واحد از **مبلغ پرداختی سطر** حساب می‌شود، نه از
            //    قیمت محصول: کوپن تخفیف و قیمت حراج همه در
            //    `get_total()` نشسته‌اند. مشتری همان را پرداخت کرده و
            //    دفتر باید همان را ثبت کند.
            //
            //    مالیات عمداً کنار گذاشته می‌شود: نرخ مالیات در آن
            //    سامانه یک تنظیم است و اگر روزی روشن شود، همان یک
            //    تعریف باید همه‌جا حاکم باشد — نه عددی که ووکامرس
            //    حساب کرده.
            $line_total = self::to_rial($item->get_total());
            $unit       = (int) round($line_total / $qty);
            if ($unit <= 0) {
                return new WP_Error(
                    'lmc_zero_price',
                    sprintf(
                        /* translators: %s: نام کالا */
                        __('قیمت پرداختی کالای «%s» صفر است و ثبت نمی‌شود.', 'labelmod-connector'),
                        $item->get_name()
                    ),
                    ['kind' => LMC_Client::PERMANENT]
                );
            }

            $lines[] = [
                'sku'       => $sku,
                'qty'       => (string) $qty,
                'unitPrice' => (string) $unit,
            ];
        }

        if (!$lines) {
            return new WP_Error(
                'lmc_empty_order',
                __('این سفارش هیچ قلم قابل ارسالی ندارد.', 'labelmod-connector'),
                ['kind' => LMC_Client::PERMANENT]
            );
        }

        $shipping = self::to_rial($order->get_shipping_total());
        $paid     = self::to_rial($order->get_total());

        $payload = [
            'branchId'       => $branch,
            'warehouseId'    => $warehouse,
            // هویت این عملیات. شماره سفارش ووکامرس، نه چیزی که ما
            // می‌سازیم — تا ارسال دوباره همان سفارش شناخته شود.
            'externalId'     => (string) $order->get_id(),
            'lines'          => $lines,
            'shippingAmount' => (string) $shipping,
            'paymentMethod'  => self::map_payment_method($order),
            'paidAmount'     => (string) $paid,
            'note'           => self::note($order),
        ];

        $mobile = self::mobile($order);
        if ($mobile !== '') {
            $payload['customerMobile'] = $mobile;
            $name = trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name());
            if ($name !== '') {
                $payload['customerName'] = $name;
            }
        }

        $ref = (string) $order->get_transaction_id();
        if ($ref !== '') {
            $payload['paymentRef'] = $ref;
        }

        return $payload;
    }

    /**
     * تبدیل مبلغ ووکامرس به **ریال صحیح**.
     *
     * ⚠️ این تابع جایی است که یک اشتباه، همه اعداد را یک صفر جابه‌جا
     *    می‌کند. سامانه لیبل مد ریال نگه می‌دارد؛ بیشتر سایت‌های
     *    ایرانی تومان. تنظیم `currency_unit` صریح پرسیده می‌شود چون
     *    حدس‌زدنش از کد ارز ووکامرس قابل اعتماد نیست — «IRT»، «تومان»
     *    و افزونه‌های محلی هرکدام چیزی می‌نویسند.
     *
     *    خروجی همیشه **عدد صحیح** است: پول در آن سامانه اعشار ندارد.
     */
    public static function to_rial($amount): int
    {
        $value = (float) $amount;
        if (lmc_setting('currency_unit') === 'toman') {
            $value *= 10;
        }
        return (int) round($value);
    }

    /**
     * درگاه ووکامرس → کد روش پرداخت لیبل مد.
     *
     * نگاشت یک تنظیم است، نه یک `switch` در کد: هر سایت درگاه خودش را
     * دارد (زرین‌پال، آیدی‌پی، ملت…) و افزودن یکی تازه نباید یک
     * ویرایش فایل باشد.
     *
     * پیش‌فرض `gateway` است چون سفارش سایت پرداخت‌شده معمولاً از درگاه
     * می‌آید؛ اگر نگاشتی نباشد، سفارش رد نمی‌شود.
     */
    public static function map_payment_method(WC_Order $order): string
    {
        $id  = (string) $order->get_payment_method();
        $map = self::parse_map((string) lmc_setting('payment_map'));
        return $map[$id] ?? 'gateway';
    }

    /** «zarinpal=gateway» در هر خط. */
    public static function parse_map(string $raw): array
    {
        $out = [];
        foreach (preg_split('/\r\n|\r|\n/', $raw) as $line) {
            $line = trim($line);
            if ($line === '' || strpos($line, '=') === false) {
                continue;
            }
            [$from, $to] = array_map('trim', explode('=', $line, 2));
            if ($from !== '' && $to !== '') {
                $out[$from] = $to;
            }
        }
        return $out;
    }

    /**
     * موبایل مشتری.
     *
     * نرمال‌سازی اینجا انجام **نمی‌شود**: آن سامانه خودش
     * `sales.normalize_mobile()` دارد و «۰۹۱۲…» و «+98912…» را یکی
     * می‌کند. یک نسخه دوم اینجا یعنی دو تعریف از یک قاعده.
     */
    private static function mobile(WC_Order $order): string
    {
        $phone = trim((string) $order->get_billing_phone());
        return $phone;
    }

    private static function note(WC_Order $order): string
    {
        $note = trim((string) $order->get_customer_note());
        $head = sprintf(
            /* translators: %s: شماره سفارش ووکامرس */
            __('سفارش سایت #%s', 'labelmod-connector'),
            $order->get_order_number()
        );
        $full = $note === '' ? $head : $head . ' — ' . $note;
        // ستون یادداشت ۵۰۰ کاراکتر می‌گیرد؛ بلندتر ۴۰۰ می‌گرفت.
        return mb_substr($full, 0, 500);
    }

    /**
     * شکست — با Backoff نمایی، یا توقف.
     *
     * توقف روی خطای دائمی عمدی است: SKU نداشتن یا شعبه نامعتبر با
     * تلاش دوباره درست نمی‌شود و صفی که تا ابد یک سفارش غلط را
     * می‌فرستد، فقط لاگ را پر می‌کند و مشکل واقعی را پنهان.
     */
    private static function fail(WC_Order $order, WP_Error $err, bool $retryable): void
    {
        $attempts = (int) $order->get_meta(self::META_ATTEMPTS) + 1;
        $order->update_meta_data(self::META_ATTEMPTS, $attempts);
        $order->update_meta_data(self::META_ERROR, $err->get_error_message());

        if ($retryable && $attempts < self::MAX_ATTEMPTS) {
            // ۱، ۲، ۴، ۸، ۱۶ دقیقه — تا حدود نیم ساعت.
            $delay = MINUTE_IN_SECONDS * (2 ** ($attempts - 1));
            wp_schedule_single_event(time() + $delay, LMC_ORDER_EVENT, [$order->get_id()]);
            $order->add_order_note(sprintf(
                /* translators: 1: پیام خطا 2: شماره تلاش 3: سقف تلاش */
                __('ارسال به لیبل مد ناموفق بود (%1$s). تلاش %2$d از %3$d — دوباره تلاش می‌شود.', 'labelmod-connector'),
                $err->get_error_message(),
                $attempts,
                self::MAX_ATTEMPTS
            ));
        } else {
            $order->add_order_note(sprintf(
                /* translators: %s: پیام خطا */
                __('⛔ ارسال به لیبل مد متوقف شد: %s — این سفارش باید دستی بررسی شود.', 'labelmod-connector'),
                $err->get_error_message()
            ));
        }

        $order->save();
        lmc_log(sprintf('سفارش %d ناموفق: %s', $order->get_id(), $err->get_error_message()));
    }

    // ── جعبه کنار سفارش ─────────────────────────────────────────────

    public static function meta_box(): void
    {
        $screens = ['shop_order', 'woocommerce_page_wc-orders'];
        foreach ($screens as $screen) {
            add_meta_box(
                'lmc_status',
                __('لیبل مد', 'labelmod-connector'),
                [__CLASS__, 'render_meta_box'],
                $screen,
                'side'
            );
        }
    }

    public static function render_meta_box($post): void
    {
        $order = $post instanceof WC_Order ? $post : wc_get_order($post->ID ?? 0);
        if (!$order) {
            return;
        }

        $invoice = (string) $order->get_meta(self::META_NUMBER);
        $error   = (string) $order->get_meta(self::META_ERROR);

        if ($invoice !== '') {
            printf(
                '<p>✅ %s <strong>%s</strong></p>',
                esc_html__('ثبت شد — فاکتور', 'labelmod-connector'),
                esc_html($invoice)
            );
            return;
        }

        if ($order->get_meta(self::META_PAID) !== 'yes') {
            $confirm_url = wp_nonce_url(
                admin_url('admin-post.php?action=lmc_confirm_payment&order=' . $order->get_id()),
                'lmc_confirm_payment_' . $order->get_id()
            );
            printf('<p>%s</p><p><a class="button" href="%s">%s</a></p>',
                esc_html__('تأیید دریافت وجه موجود نیست. برای سفارش قدیمی، ابتدا سند دریافت وجه را بررسی کنید.', 'labelmod-connector'),
                esc_url($confirm_url), esc_html__('بررسی و تأیید دریافت وجه', 'labelmod-connector'));
            return;
        }

        if ($error !== '') {
            printf('<p style="color:#b32d2e">⛔ %s</p>', esc_html($error));
        } else {
            printf('<p>%s</p>', esc_html__('هنوز به لیبل مد فرستاده نشده.', 'labelmod-connector'));
        }

        $url = wp_nonce_url(
            admin_url('admin-post.php?action=lmc_resend&order=' . $order->get_id()),
            'lmc_resend_' . $order->get_id()
        );
        printf(
            '<p><a class="button" href="%s">%s</a></p>',
            esc_url($url),
            esc_html__('ارسال دوباره', 'labelmod-connector')
        );
    }

    /**
     * ارسال دستی.
     *
     * بی‌خطر است حتی اگر سفارش قبلاً رفته باشد: سرور `externalId` را
     * می‌شناسد و همان فاکتور را برمی‌گرداند، نه یکی تازه.
     */
    public static function handle_resend(): void
    {
        $order_id = isset($_GET['order']) ? (int) $_GET['order'] : 0;
        if (!current_user_can('edit_shop_orders') || $order_id <= 0) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_resend_' . $order_id);

        $order = wc_get_order($order_id);
        if ($order) {
            // شمارنده تلاش صفر می‌شود: این یک تصمیم انسانی است، نه
            // ادامه همان صفِ ناموفق.
            $order->update_meta_data(self::META_ATTEMPTS, 0);
            $order->delete_meta_data(self::META_INVOICE);
            $order->save();
            self::send($order_id);
        }

        wp_safe_redirect(wp_get_referer() ?: admin_url('admin.php?page=wc-orders'));
        exit;
    }

    /** مسیر صریح بازیابی سفارش قدیمی؛ وضعیت سفارش هرگز مدرک دریافت پول نیست. */
    public static function confirm_legacy_payment(WC_Order $order, string $reference)
    {
        if (!current_user_can('manage_woocommerce') || !current_user_can('edit_shop_order', $order->get_id())) {
            return new WP_Error('payment_confirmation_forbidden', 'اجازه تأیید دریافت وجه ندارید.');
        }
        $reference = trim($reference);
        if ($reference === '' || strlen($reference) > 500 || !$order->has_status(['processing', 'completed'])) {
            return new WP_Error('payment_confirmation_invalid', 'سفارش و شماره سند دریافت وجه را بررسی کنید.');
        }
        if ($order->get_meta(self::META_PAID) === 'yes') {
            return true;
        }
        $order->add_order_note(sprintf('لیبل مد: دریافت وجه با بررسی دستی تأیید شد. کاربر %d؛ سند: %s', get_current_user_id(), $reference));
        $order->update_meta_data('_lmc_payment_evidence', [
            'reference' => $reference, 'actor' => get_current_user_id(), 'at' => gmdate('c'),
        ]);
        $order->update_meta_data(self::META_PAID, 'yes');
        $order->save();
        if (!wp_next_scheduled(LMC_ORDER_EVENT, [$order->get_id()])) {
            wp_schedule_single_event(time() + 10, LMC_ORDER_EVENT, [$order->get_id()]);
        }
        return true;
    }

    public static function handle_confirm_payment(): void
    {
        $order_id = absint($_GET['order'] ?? $_POST['order'] ?? 0);
        if ($order_id <= 0 || !current_user_can('manage_woocommerce') || !current_user_can('edit_shop_order', $order_id)) {
            wp_die(esc_html__('دسترسی ندارید.', 'labelmod-connector'));
        }
        check_admin_referer('lmc_confirm_payment_' . $order_id);
        $order = wc_get_order($order_id);
        if (!$order) {
            wp_die(esc_html__('سفارش یافت نشد.', 'labelmod-connector'));
        }
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
            $reference = isset($_POST['reference']) && is_string($_POST['reference'])
                ? sanitize_text_field(wp_unslash($_POST['reference'])) : '';
            $result = self::confirm_legacy_payment($order, $reference);
            if (is_wp_error($result)) {
                wp_die(esc_html($result->get_error_message()));
            }
            wp_safe_redirect(admin_url('admin.php?page=wc-orders&action=edit&id=' . $order_id));
            exit;
        }
        header('Content-Type: text/html; charset=UTF-8');
        echo '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>تأیید دریافت وجه</title><body>';
        echo '<h1>تأیید دریافت وجه سفارش ' . esc_html((string) $order_id) . '</h1>';
        echo '<p>فقط پس از تطبیق مبلغ با رسید بانک یا دریافت واقعی وجه، شماره سند را وارد کنید. وضعیت «در حال انجام» به‌تنهایی کافی نیست.</p>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="lmc_confirm_payment">';
        echo '<input type="hidden" name="order" value="' . esc_attr((string) $order_id) . '">';
        wp_nonce_field('lmc_confirm_payment_' . $order_id);
        echo '<label>شماره سند دریافت وجه <input name="reference" required maxlength="150"></label> ';
        echo '<button type="submit">دریافت وجه را بررسی و تأیید کردم</button></form></body></html>';
        exit;
    }
}
