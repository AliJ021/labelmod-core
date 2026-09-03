<?php
/**
 * کلاینت HTTP سامانه لیبل مد.
 *
 * ── سه تصمیم که همه‌شان از یک جا می‌آیند ────────────────────────────
 *
 * ۱. **کلید در هدر `Authorization`، نه در Query String.** آدرس در لاگ
 *    وب‌سرور، در Referer و در تاریخچه مرورگر می‌نشیند؛ هدر نه.
 *
 * ۲. **پیام خطای سرور فارسی است و همان را نشان می‌دهیم.** آن سامانه
 *    خطاهایش را برای آدم می‌نویسد («کالایی با SKU … در سیستم نیست»).
 *    جایگزین‌کردنش با «خطای ارتباط» یعنی همان اطلاعاتی که مشکل را حل
 *    می‌کند، دور ریخته شود.
 *
 * ۳. **تفاوت میان «رد شد» و «نرسید».** ۴xx یعنی درخواست غلط بود و
 *    تلاش دوباره همان جواب را می‌گیرد؛ ۵xx و خطای شبکه یعنی شاید
 *    برسد. فقط دومی Retry می‌شود — وگرنه صفی می‌سازیم که تا ابد یک
 *    سفارش غلط را می‌فرستد.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Client
{
    /** خطای قابل تلاش دوباره (شبکه، ۵xx، Timeout). */
    const RETRYABLE = 'retryable';
    /** خطای نهایی — تلاش دوباره همین جواب را می‌گیرد. */
    const PERMANENT = 'permanent';

    public static function post(string $path, array $body)
    {
        return self::request('POST', $path, $body);
    }

    public static function get(string $path, array $query = [])
    {
        if ($query) {
            $path .= (strpos($path, '?') === false ? '?' : '&') . http_build_query($query);
        }
        return self::request('GET', $path, null);
    }

    /**
     * @return array|WP_Error آرایه پاسخ، یا WP_Error با `data['kind']`
     *                        برابر RETRYABLE / PERMANENT.
     */
    private static function request(string $method, string $path, ?array $body)
    {
        $base = rtrim((string) lmc_setting('base_url'), '/');
        $key  = (string) lmc_setting('api_key');

        if ($base === '' || $key === '') {
            return new WP_Error(
                'lmc_not_configured',
                __('افزونه هنوز پیکربندی نشده است: آدرس سامانه و کلید API را در تنظیمات وارد کنید.', 'labelmod-connector'),
                ['kind' => self::PERMANENT]
            );
        }

        $url  = $base . '/api' . $path;
        $args = [
            'method'  => $method,
            // ⚠️ کوتاه عمدی: این درخواست از دل WP-Cron می‌آید و نباید
            //    یک درخواست وب را دقیقه‌ها نگه دارد. Timeout یعنی
            //    «شاید رسید» و همان مسیر Retry را می‌گیرد — سرور
            //    Idempotent است، پس ارسال دوباره فاکتور دوم نمی‌سازد.
            'timeout' => 20,
            'headers' => [
                'Authorization' => 'Bearer ' . $key,
                'Accept'        => 'application/json',
                'Content-Type'  => 'application/json; charset=utf-8',
                'User-Agent'    => 'LabelModConnector/' . LMC_VERSION,
            ],
        ];
        if ($body !== null) {
            // JSON_UNESCAPED_UNICODE تا فارسی در لاگ خوانا بماند.
            $args['body'] = wp_json_encode($body, JSON_UNESCAPED_UNICODE);
        }

        $res = wp_remote_request($url, $args);

        if (is_wp_error($res)) {
            lmc_log(sprintf('%s %s → خطای شبکه: %s', $method, $path, $res->get_error_message()));
            return new WP_Error(
                'lmc_network',
                sprintf(
                    /* translators: %s: پیام خطای شبکه */
                    __('ارتباط با سامانه لیبل مد برقرار نشد: %s', 'labelmod-connector'),
                    $res->get_error_message()
                ),
                ['kind' => self::RETRYABLE]
            );
        }

        $code = (int) wp_remote_retrieve_response_code($res);
        $raw  = (string) wp_remote_retrieve_body($res);
        $json = json_decode($raw, true);

        if ($code >= 200 && $code < 300) {
            if (!is_array($json)) {
                return new WP_Error(
                    'lmc_bad_json',
                    __('پاسخ سامانه قابل خواندن نبود.', 'labelmod-connector'),
                    ['kind' => self::RETRYABLE]
                );
            }
            $json['_status'] = $code;
            return $json;
        }

        // پیام فارسی سرور، اگر داشت. آن سامانه خطاهایش را برای کاربر
        // می‌نویسد و بازنویسی‌شان اطلاعات را دور می‌ریزد.
        $message = is_array($json) && isset($json['error']['message'])
            ? (string) $json['error']['message']
            : sprintf(
                /* translators: %d: کد وضعیت HTTP */
                __('سامانه لیبل مد پاسخ %d داد.', 'labelmod-connector'),
                $code
            );
        $errCode = is_array($json) && isset($json['error']['code'])
            ? (string) $json['error']['code']
            : 'http_' . $code;

        // ۴۰۹ «در حال پردازش» یک استثناست: درخواست هم‌زمانِ دیگری
        // زودتر رسیده و هنوز تمام نشده. تلاش دوباره **درست** است.
        $inFlight  = $errCode === 'idempotency_in_flight';
        $retryable = $code >= 500 || $code === 429 || $inFlight;

        lmc_log(sprintf('%s %s → %d %s', $method, $path, $code, $errCode));

        return new WP_Error('lmc_' . $errCode, $message, [
            'kind'   => $retryable ? self::RETRYABLE : self::PERMANENT,
            'status' => $code,
        ]);
    }

    /** آیا این خطا ارزش تلاش دوباره دارد؟ */
    public static function is_retryable(WP_Error $err): bool
    {
        $data = $err->get_error_data();
        return is_array($data) && ($data['kind'] ?? '') === self::RETRYABLE;
    }
}
