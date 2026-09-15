<?php
/**
 * دو نگهبان **اتمیک** برای گیرندهٔ Push — یافته‌های FND-R60-01 و ۰۳.
 *
 * ── مسئله‌ای که این فایل حل می‌کند ───────────────────────────────────
 *
 * گیرندهٔ Push دو جا «بخوان، تصمیم بگیر، بنویس» داشت و **هیچ‌کدام
 * اتمیک نبود**:
 *
 * ۱. **Nonce.** `get_transient()` و بعد در فراخوانی جدا
 *    `set_transient()`. دو درخواست با همان Nonce که هم‌زمان برسند، هر
 *    دو «تازه» می‌دیدند و هر دو اعمال می‌شدند.
 * ۲. **نسخه.** `get_post_meta()` تصمیم می‌گرفت و `update_post_meta()`
 *    تازه **پس از** `save()` اجرا می‌شد. دو Worker هم‌زمان می‌توانستند
 *    هر دو نسخهٔ خودشان را جلوتر ببینند و ترتیب معکوس اعمال شود.
 *
 * ⚠️ و سناریو فرضی نیست: `loop.ts` در کامنت `workerName` صریح می‌گوید
 *    «برای وقتی دوتا بالاست»، و تجمیع صف تنها پیام‌های **معلق** را جمع
 *    می‌کند — پیامی که Claim شده و در پرواز است را نه. پس دو پیام برای
 *    یک کالا واقعاً می‌توانند هم‌زمان باشند.
 *
 * ── چرا Transient و wp_cache_add انتخاب نشدند ────────────────────────
 *
 * `wp_cache_add()` **فقط** با یک Object Cache پایدارِ اتمیک (Redis یا
 * Memcached) اتمیک است. روی نصب پیش‌فرض وردپرس، Cache درون‌حافظه‌ای و
 * تک‌درخواستی است — یعنی نگهبان Nonce عملاً وجود نداشت و هیچ خطایی هم
 * نمی‌داد. و `wp_using_ext_object_cache()` هم فقط می‌گوید «Cache پایدار
 * هست»، نه «`add` اتمیک است».
 *
 * پس یک جدول با **کلید اصلی** و یک `INSERT` خام: روی همان MySQLی که
 * وردپرس رویش نشسته، تنها چیزی که بی هیچ فرضی اتمیک است.
 *
 * ⚠️ **شکستِ ذخیرهٔ Nonce fail-open نمی‌دهد.** اگر جدول نباشد یا
 *    دیتابیس خطا بدهد، درخواست **رد** می‌شود (۵۰۳). «باز بگذار تا کار
 *    کند» اینجا یعنی Replay بی‌نهایت.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Push_Guard
{
    /** نسخهٔ اسکیمای این جدول — بالا بردنش یعنی `install()` دوباره اجرا شود. */
    const SCHEMA_VERSION = 1;
    const SCHEMA_OPTION  = 'lmc_push_guard_schema';
    /** عمر نگه‌داشتن Nonce، بر حسب ثانیه — دو برابر پنجرهٔ Timestamp. */
    const RETENTION      = 600;

    public static function table(): string
    {
        global $wpdb;
        return $wpdb->prefix . 'lmc_push_nonce';
    }

    /**
     * جدول Nonce را می‌سازد.
     *
     * ⚠️ هم از Hook فعال‌سازی صدا زده می‌شود و هم از `plugins_loaded` با
     *    سنجش نسخه: افزونه‌ای که **به‌روزرسانی** شود (نه فعال‌سازی
     *    دوباره) Hook فعال‌سازی را اجرا نمی‌کند، و آن‌وقت جدول هرگز
     *    ساخته نمی‌شد و هر Push با ۵۰۳ رد می‌شد.
     */
    public static function install(): void
    {
        global $wpdb;

        $table   = self::table();
        $collate = method_exists($wpdb, 'get_charset_collate') ? $wpdb->get_charset_collate() : '';

        // ⚠️ `nonce` کلید اصلی است و همین **تمام** ادعای اتمیک‌بودن
        //    است: درج تکراری با خطای کلید یکتا رد می‌شود، بی هیچ
        //    خواندنِ قبلی.
        $sql = "CREATE TABLE {$table} (
            nonce VARCHAR(64) NOT NULL,
            created_at BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (nonce),
            KEY created_at (created_at)
        ) {$collate}";

        if (!function_exists('dbDelta')) {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        }
        dbDelta($sql);
        update_option(self::SCHEMA_OPTION, self::SCHEMA_VERSION, false);
    }

    /** اگر اسکیما عقب است، بسازش. روی هر بارگذاری صدا زده می‌شود و ارزان است. */
    public static function ensure_schema(): void
    {
        if ((int) get_option(self::SCHEMA_OPTION, 0) >= self::SCHEMA_VERSION) {
            return;
        }
        self::install();
    }

    /**
     * Nonce را **یک بار** ثبت می‌کند.
     *
     * برمی‌گرداند: `'new'` (اولین بار)، `'replay'` (قبلاً بوده)، یا
     * `'unavailable'` (دیتابیس نتوانست — و این fail-closed است).
     */
    public static function claim_nonce(string $nonce): string
    {
        global $wpdb;
        $table = self::table();

        // پاک‌سازی محدود، بی تصادف و بی Cron: با ایندکس `created_at`
        // ارزان است و صف Nonce را بی‌نهایت رشد نمی‌دهد.
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$table} WHERE created_at < %d LIMIT 200",
            time() - self::RETENTION
        ));

        // ⚠️ `INSERT` خام و **بدون** `ON DUPLICATE KEY`: همان یک دستور
        //    هم سنجش است و هم نوشتن. `$wpdb->insert()` هم می‌شد، ولی
        //    این‌طور صریح است که هیچ خواندنی پیش از نوشتن نیست.
        $before = (string) $wpdb->last_error;
        $done   = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$table} (nonce, created_at) VALUES (%s, %d)",
            $nonce,
            time()
        ));

        if ($done === 1) {
            return 'new';
        }

        $error = (string) $wpdb->last_error;
        if ($error !== '' && $error !== $before && self::is_duplicate($error)) {
            return 'replay';
        }
        // هر شکست دیگری — جدول نیست، دیتابیس خوانده نمی‌شود — یعنی
        // **نمی‌دانیم** این Nonce تازه است یا نه. و «نمی‌دانم» اجازه
        // نیست.
        return 'unavailable';
    }

    private static function is_duplicate(string $error): bool
    {
        return stripos($error, 'duplicate') !== false
            || stripos($error, '1062') !== false;
    }

    /** نام قفل — حداکثر ۶۴ بایت، محدودیت خودِ MySQL. */
    public static function lock_name(int $product_id, string $meta): string
    {
        return substr('lmc_push_' . $product_id . '_' . md5($meta), 0, 64);
    }

    /**
     * قفل مشورتی MySQL، **بی انتظار**.
     *
     * ⚠️ مهلت صفر عمدی است: اگر Worker دیگری همین کالا را در دست دارد،
     *    این پیام باید **بعداً دوباره** بیاید، نه اینکه نخِ PHP را
     *    اشغال کند. صف Outbox خودش Backoff دارد.
     */
    public static function acquire(string $name): bool
    {
        global $wpdb;
        $got = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', $name));
        return (string) $got === '1';
    }

    public static function release(string $name): void
    {
        global $wpdb;
        $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $name));
    }
}
