<?php
/**
 * گیرندهٔ ارسال لحظه‌ای از Core — ADR-007.
 *
 * ── این تنها مسیری است که از بیرون **به داخل** سایت می‌نویسد ─────────
 *
 * بقیهٔ افزونه از سایت به Core می‌رود (سفارش) یا از Core می‌کشد
 * (موجودی). این یکی برعکس است: یک مسیر REST عمومی که هر کسی می‌تواند
 * صدایش بزند. پس کل هزینهٔ طراحی اینجا پرداخت می‌شود.
 *
 *   امضا       HMAC-SHA256 روی **بدنهٔ خام**
 *   Timestamp  پنجرهٔ ±۳۰۰ ثانیه
 *   Nonce      یک‌بارمصرف، با درج اتمیک در جدول اختصاصی
 *   نسخه       پیام قدیمی یا تکراری دور انداخته می‌شود — **زیر قفل**
 *
 * ⚠️ **هر چهار لازم‌اند و هیچ‌کدام جای دیگری را نمی‌گیرد:**
 *    امضا بی Timestamp یعنی یک درخواست ضبط‌شده تا ابد قابل Replay است.
 *    Timestamp بی Nonce یعنی همان Replay در پنجرهٔ ۳۰۰ ثانیه‌ای.
 *    Nonce بی Timestamp یعنی حافظهٔ Nonce باید بی‌نهایت باشد.
 *    و نسخه، مسئلهٔ **ترتیب** را حل می‌کند نه امنیت را.
 *
 * ⚠️ کلید در `wp-config.php` به‌عنوان ثابت `LMC_PUSH_SECRET` می‌نشیند،
 *    **نه** در `wp_options`: گزینه‌ها در پشتیبان دیتابیس، در صفحهٔ
 *    تنظیمات، و در هر افزونهٔ صادرکننده دیده می‌شوند.
 *
 * ⚠️ **و دو نگهبان از این چهار، تا FND-R60-01/03 اتمیک نبودند.** هر دو
 *    الگوی «بخوان، تصمیم بگیر، بنویس» داشتند با یک پنجرهٔ باز وسطش.
 *    هر دو حالا در `LMC_Push_Guard` نشسته‌اند: Nonce با یک `INSERT`
 *    روی کلید اصلی، و نسخه زیر یک قفل مشورتی MySQL. توضیح کامل آنجا.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Push_Receiver
{
    const NS               = 'lmc/v1';
    const STOCK_VERSION_META = '_lmc_stock_version';
    const PRICE_VERSION_META = '_lmc_price_version';
    /** پنجرهٔ مجاز اختلاف ساعت، بر حسب ثانیه. */
    const WINDOW           = 300;

    public static function init(): void
    {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
    }

    public static function register_routes(): void
    {
        foreach (['stock', 'price'] as $what) {
            register_rest_route(self::NS, '/' . $what, [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'handle_' . $what],
                // ⚠️ `__return_true` **نیست**: مجوز همان امضا است و در
                //    خودِ Callback سنجیده می‌شود، چون به بدنهٔ خام نیاز
                //    دارد. یک `permission_callback` که همیشه true بدهد
                //    ولی Callback نسنجد، همان در باز است.
                'permission_callback' => [__CLASS__, 'verify_request'],
            ]);
        }
    }

    /** کلید امضا — فقط از ثابت، هرگز از گزینه‌ها. */
    public static function secret(): string
    {
        return defined('LMC_PUSH_SECRET') ? (string) constant('LMC_PUSH_SECRET') : '';
    }

    /**
     * سنجش امضا، پنجرهٔ زمانی و Nonce.
     *
     * برمی‌گرداند: true، یا یک `WP_Error` با کد HTTP مناسب.
     */
    public static function verify_request($request)
    {
        $secret = self::secret();
        if ($secret === '') {
            // بی کلید، هیچ درخواستی پذیرفته نمی‌شود. «باز بگذار تا کار
            // کند» اینجا یعنی هر کسی بتواند موجودی ویترین را بنویسد.
            return new WP_Error('lmc_no_secret',
                'کلید LMC_PUSH_SECRET در wp-config.php تنظیم نشده است.', ['status' => 503]);
        }

        $ts    = (string) $request->get_header('x-lmc-timestamp');
        $nonce = (string) $request->get_header('x-lmc-nonce');
        $sig   = (string) $request->get_header('x-lmc-signature');

        if ($ts === '' || $nonce === '' || $sig === '') {
            return new WP_Error('lmc_missing_headers',
                'هدرهای امضا ناقص است.', ['status' => 401]);
        }

        // ⚠️ پنجره **دوطرفه** است: ساعت عقبِ فرستنده و ساعت جلوی آن هر
        //    دو ممکن‌اند. سنجش یک‌طرفه یعنی نیمی از اختلاف‌های ساعت،
        //    درخواست معتبر را رد کند.
        if (!ctype_digit($ts) || abs(time() - (int) $ts) > self::WINDOW) {
            return new WP_Error('lmc_stale',
                'مهر زمانی خارج از پنجرهٔ مجاز است.', ['status' => 401]);
        }

        if (!preg_match('/^[a-f0-9]{16,64}$/i', $nonce)) {
            return new WP_Error('lmc_bad_nonce', 'Nonce نامعتبر است.', ['status' => 401]);
        }

        // ⚠️ **بدنهٔ خام**، نه JSON بازتولیدشده: هر Serialize دوباره
        //    می‌تواند ترتیب کلید یا فاصله را عوض کند و امضای درست را
        //    بی‌دلیل بشکند. و مهم‌تر — امضای چیزی که سنجیده می‌شود باید
        //    دقیقاً همان چیزی باشد که بعداً خوانده می‌شود.
        $body     = (string) $request->get_body();
        $expected = hash_hmac('sha256', $ts . '.' . $nonce . '.' . $body, $secret);
        $given    = preg_replace('/^sha256=/', '', $sig);

        // ⚠️ `hash_equals` و نه `===`: مقایسهٔ معمولی رشته در اولین بایت
        //    متفاوت برمی‌گردد و زمانش قابل اندازه‌گیری است.
        if (!is_string($given) || !hash_equals($expected, $given)) {
            return new WP_Error('lmc_bad_signature', 'امضا معتبر نیست.', ['status' => 403]);
        }

        /*
         * Nonce یک‌بارمصرف — **یک** عمل، نه «بخوان و بعد بنویس».
         *
         * ⚠️ نسخهٔ قبلی `get_transient()` و بعد `set_transient()` بود.
         *    دو درخواست با همان Nonce که هم‌زمان برسند، هر دو «تازه»
         *    می‌دیدند. و بدتر: روی نصب پیش‌فرض وردپرس Object Cache
         *    درون‌حافظه‌ای است، پس نگهبان عملاً به یک درخواست محدود بود.
         *
         * ⚠️ مقدار مطلق بودنِ Payload جلوی دوبرابرشدن موجودی را می‌گیرد،
         *    ولی اثرهای جانبی (Hookهای ووکامرس، ذخیرهٔ محصول،
         *    Invalidation کش، افزونه‌های دیگر) Idempotent نیستند.
         */
        $claim = LMC_Push_Guard::claim_nonce($nonce);
        if ($claim === 'replay') {
            return new WP_Error('lmc_replay', 'این درخواست قبلاً پردازش شده است.', ['status' => 409]);
        }
        if ($claim !== 'new') {
            // ⚠️ **fail-closed.** «نمی‌دانم این Nonce تازه است یا نه»
            //    اجازه نیست — وگرنه یک جدولِ نبوده به Replay بی‌نهایت
            //    تبدیل می‌شد. ۵۰۳ یعنی Core دوباره تلاش می‌کند.
            return new WP_Error('lmc_nonce_unavailable',
                'ثبت Nonce ممکن نشد؛ درخواست پذیرفته نشد.', ['status' => 503]);
        }

        return true;
    }

    /**
     * بدنهٔ مشترک هر دو مسیر: اعتبارسنجی Payload و پیدا کردن کالا.
     *
     * ⚠️ **سنجش نسخه دیگر اینجا نیست** (FND-R60-01). اینجا بیرون از
     *    قفل است، پس هر تصمیمی که اینجا گرفته شود تا لحظهٔ نوشتن کهنه
     *    شده. سنجش به `apply_versioned()` رفت، زیر همان قفلی که
     *    می‌نویسد.
     */
    private static function resolve($request): array
    {
        $data = $request->get_json_params();
        if (!is_array($data) || !isset($data['variationId']) || !is_string($data['variationId'])) {
            return ['error' => new WP_Error('lmc_bad_payload',
                'بدنه بدون variationId است.', ['status' => 400])];
        }
        if (!isset($data['version']) || !is_numeric($data['version'])) {
            return ['error' => new WP_Error('lmc_bad_payload',
                'بدنه بدون version است.', ['status' => 400])];
        }

        $product_id = LMC_Stock_Sync::find_by_meta($data['variationId']);
        if ($product_id === 0) {
            // ⚠️ ۲۰۰ و نه ۴۰۴: کالایی که هنوز در سایت نیست یک **خطا
            //    نیست**، و ۴۰۴ دادن یعنی Core آن را یک شکست دائمی
            //    بشمارد و به نامهٔ مرده بفرستد. خوراک ۱۵ دقیقه‌ای
            //    خودش اتصال را بعداً برقرار می‌کند.
            return ['skip' => 'کالای متناظر در سایت نیست'];
        }

        return [
            'data'       => $data,
            'product_id' => $product_id,
            'version'    => (int) $data['version'],
        ];
    }

    /**
     * اعمال یک تغییر، با سنجش نسخه **زیر قفل**.
     *
     * ── چرا قفل، و چرا خواندنِ دوباره زیرش ───────────────────────────
     *
     * دو Worker هم‌زمان (`loop.ts` صریح پیش‌بینی‌اش کرده) می‌توانند دو
     * پیام از همان کالا را با هم بفرستند — تجمیع صف تنها سطرهای
     * **معلق** را جمع می‌کند، نه پیامی که Claim شده و در پرواز است.
     * بی قفل، هر دو `stored` قدیمی را می‌دیدند و ترتیب اعمال به بخت
     * واگذار می‌شد.
     *
     * ⚠️ **جابه‌جا کردن `update_post_meta()` به قبل از `save()` کافی
     *    نبود:** آن‌وقت یک `save()` ناموفق نسخه را جلو می‌برد بی‌آنکه
     *    مقداری اعمال شده باشد، و پیام درستِ بعدی «قدیمی» شمرده می‌شد.
     *    پس ترتیب همان می‌ماند — اعمال، `save()`، بعد نسخه — و تمامش
     *    داخل قفل است.
     *
     * ⚠️ و قفل در `finally` آزاد می‌شود: اگر `save()` استثنا بدهد،
     *    قفل روی اتصال می‌ماند و کالا تا پایان درخواست PHP قابل
     *    نوشتن نیست.
     *
     * @param callable(object): bool $apply برمی‌گرداند: آیا چیزی عوض شد.
     */
    private static function apply_versioned(
        int $product_id,
        string $version_meta,
        int $incoming,
        callable $apply
    ) {
        $lock = LMC_Push_Guard::lock_name($product_id, $version_meta);
        if (!LMC_Push_Guard::acquire($lock)) {
            // Worker دیگری همین لحظه همین کالا را می‌نویسد. این یک شکست
            // **موقت** است، نه دائمی: ۵۰۳ تا صف دوباره تلاش کند.
            return new WP_Error('lmc_busy',
                'همین کالا در حال نوشتن است؛ کمی بعد دوباره.', ['status' => 503]);
        }

        try {
            // ⚠️ نسخه **اینجا** خوانده می‌شود، زیر قفل — نه بیرونش.
            $stored = (int) get_post_meta($product_id, $version_meta, true);

            // ⚠️ `>=` و نه `>`: تحویل **تکراریِ همان پیام** هم باید دور
            //    انداخته شود. تحویل «حداقل یک بار» است، پس همین حالت
            //    عادی است نه استثنا — و بی این، یک Retry بی‌دلیل
            //    `post_meta` را می‌نویسد و هر Hook وابسته را بیدار می‌کند.
            if ($stored > 0 && $incoming <= $stored) {
                return ['ok' => true, 'applied' => false, 'note' => 'نسخهٔ قدیمی یا تکراری'];
            }

            $product = wc_get_product($product_id);
            if (!$product) {
                return ['ok' => true, 'applied' => false, 'note' => 'کالا خوانده نشد'];
            }

            $changed = (bool) $apply($product);
            if ($changed) { $product->save(); }

            // ⚠️ نسخه **حتی وقتی چیزی عوض نشده** ثبت می‌شود. وگرنه یک
            //    پیام با عدد بدون تغییر (مثلاً پس از انتقال داخلی) نسخه
            //    را جلو نمی‌برد و پیام بعدیِ قدیمی‌تر باز هم پذیرفته
            //    می‌شد.
            update_post_meta($product_id, $version_meta, $incoming);

            return ['ok' => true, 'applied' => $changed];
        } finally {
            LMC_Push_Guard::release($lock);
        }
    }

    public static function handle_stock($request)
    {
        $r = self::resolve($request);
        if (isset($r['error'])) { return $r['error']; }
        if (isset($r['skip']))  { return ['ok' => true, 'applied' => false, 'note' => $r['skip']]; }

        $data = $r['data'];
        if (!isset($data['onHand']) || !is_numeric($data['onHand'])) {
            return new WP_Error('lmc_bad_payload', 'بدنه بدون onHand است.', ['status' => 400]);
        }
        $on_hand = (int) $data['onHand'];

        $out = self::apply_versioned(
            $r['product_id'],
            self::STOCK_VERSION_META,
            $r['version'],
            static fn ($product): bool => LMC_Stock_Sync::apply_stock($product, $on_hand)
        );
        if (is_array($out)) { $out['onHand'] = $on_hand; }
        return $out;
    }

    public static function handle_price($request)
    {
        $r = self::resolve($request);
        if (isset($r['error'])) { return $r['error']; }
        if (isset($r['skip']))  { return ['ok' => true, 'applied' => false, 'note' => $r['skip']]; }

        $data = $r['data'];
        if (!array_key_exists('priceRial', $data)) {
            return new WP_Error('lmc_bad_payload', 'بدنه بدون priceRial است.', ['status' => 400]);
        }

        // ⚠️ `price_for_site` تنها تعریف تبدیل ریال به واحد سایت است و
        //    `null` را همان `null` نگه می‌دارد: «قیمت ندارد»، **نه
        //    مجانی**. نوشتن صفر یعنی ویترین کالا را رایگان بفروشد.
        $price = LMC_Stock_Sync::price_for_site(['price' => $data['priceRial']]);

        $out = self::apply_versioned(
            $r['product_id'],
            self::PRICE_VERSION_META,
            $r['version'],
            static fn ($product): bool => LMC_Stock_Sync::apply_price($product, $price)
        );
        if (is_array($out)) { $out['price'] = $price; }
        return $out;
    }
}
