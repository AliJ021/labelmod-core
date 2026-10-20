<?php
/**
 * صف کارهای بحرانی (سفارش، رزرو پرداخت در محل، مرجوعی) — Action Scheduler.
 *
 * ── چرا نه WP-Cron ──────────────────────────────────────────────────
 *
 * تا نسخهٔ ۱.۴ هر سفارش با `wp_schedule_single_event(time() + 10)` صف
 * می‌شد. سه اشکال داشت:
 *   ۱. **ده ثانیه تأخیر ثابت**، و بعد تازه منتظر بازدید صفحهٔ بعدی.
 *   ۲. **همهٔ رویدادها در یک گزینهٔ سریال‌شده** (`cron`) می‌نشینند؛ دو
 *      نوشتن هم‌زمان می‌توانند رویداد دیگری را بی‌صدا پاک کنند.
 *   ۳. WP-Cron رویداد را **پیش از** اجرا برمی‌دارد؛ خطای مرگبار وسط کار
 *      یعنی کار گم شد و هیچ ردی نماند.
 *
 * Action Scheduler (همراه خودِ ووکامرس) هر کار را یک سطر جدا با وضعیت
 * pending/in-progress/complete/failed نگه می‌دارد و با Claim اتمیک
 * برمی‌دارد، پس دو اجراکننده یک کار را هم‌زمان برنمی‌دارند. گروه
 * `labelmod-critical` فقط همین سه رویداد را دارد تا اجراکنندهٔ اختصاصی
 * (`wp labelmod queue run`) فقط همین‌ها را بردارد.
 *
 * ── «فوری» یعنی چه ─────────────────────────────────────────────────
 *
 * درج سطر در همان درخواست Checkout و بی تأخیر انجام می‌شود (یک INSERT؛
 * هیچ HTTP به Core در مسیر مشتری نیست). اجرا با یکی از این سه است:
 *   • اجراکنندهٔ WP-CLI (اختیاری، مستند در README) — سریع‌ترین؛
 *   • رویداد `lmc_queue_kick` که در درخواست **بعدی** هر بازدیدکننده‌ای
 *     WP-Cron را بیدار می‌کند و فقط همین گروه را می‌راند؛
 *   • اجراکنندهٔ دقیقه‌ای خودِ Action Scheduler — کف تضمینی.
 * kick فقط شتاب‌دهنده است؛ از دست رفتنش کار را گم نمی‌کند چون سطر کار
 * در جدول Action Scheduler است، نه در گزینهٔ `cron`.
 * ⚠️ WP-Cron سراسری خاموش نمی‌شود و این افزونه خاموشش نمی‌کند.
 *
 * ── شکست ───────────────────────────────────────────────────────────
 *
 * شکست معمولی (شبکه، ۵xx، ۴۲۹) را خودِ Handler با سقف `MAX_ATTEMPTS` و
 * `retry_delay()` زمان‌بندی می‌کند. شکست **غیرمنتظره** (استثنا، خطای
 * مرگبار، کشته‌شدن پردازه) از Hookهای Action Scheduler می‌آید: تا
 * `MAX_CRASHES` بار با Backoff دوباره صف می‌شود و بعد در فهرست مرده
 * می‌نشیند — دیده می‌شود (تشخیص اتصال، لاگ، صفحهٔ Scheduled Actions)،
 * نه بی‌صدا. همهٔ Handlerها تکرار را تحمل می‌کنند: Core با `externalId`
 * و شناسهٔ مرجوعی Idempotent است.
 *
 * ── هم‌زمانی (بازبینی ریشه روی PR183، با درهم‌آمیزی کنترل‌شده بازتولید شد) ──
 *
 * کلید هر «کار منطقی» = (Hook، آرگومان). سه نگهبان، هیچ‌کدام آرایهٔ مشترک نیست:
 *   ۱. **قفل نام‌دار کوتاه** (`GET_LOCK`، پیشوند `lmc_qe_`) برای تغییر صف هر کار: «معلق هست؟» و
 *      درج یک عمل اتمیک می‌شوند؛ پیش از آن، دو Callback هم‌زمان هر دو «نیست» می‌دیدند و دو سطر
 *      می‌ساختند. Claim خودِ Action Scheduler فقط شناسهٔ سطر را سریال می‌کند، نه کار منطقی را.
 *   ۲. **قفل اجرای جدا** (`lmc_qx_`) **پیش از بررسی وضعیت** هر اجرا (`action_scheduler_before_execute`):
 *      دو سطرِ یک سفارش روی دو اجراکننده دیگر هم‌زمان HTTP نمی‌زنند، و اجرای دوم پس از اولی وضعیت
 *      تازه را می‌خواند (سطری که اولی لغو کرده نادیده گرفته می‌شود). جداست تا Callback پرداخت در
 *      درخواست Checkout پشت HTTP یک اجرا (تا ۲۰ ثانیه) منتظر نماند. ترتیب همیشه اجرا ← صف است، پس
 *      چرخهٔ بن‌بست ندارد.
 *   ۳. شمارندهٔ شکست و ثبت مرده **یک ردیف جدا برای هر کار** با افزایش اتمیک SQL است، نه
 *      get_option/update_option روی آرایه: دو بازیابی هم‌زمانِ دو کار متفاوت شمارش یکدیگر را
 *      پاک نمی‌کنند. کار مرده مرده می‌ماند (شمارنده صفر نمی‌شود) تا اجرای انسانی یا یک اجرای سالم.
 *
 * ── وقتی قفل یا نوشتن وضعیت شکست می‌خورد (بازبینی دوم ریشه، تزریق شکست) ──
 *
 *   • قفل صف گرفته نشد (مهلت تمام شد = `false`، یا خطای SQL/پشتیبانی‌نشده = `null`): بخش محافظت‌شده
 *     («معلق هست؟»+درج، لغو+جایگزینی، تصمیم بازیابی) **اجرا نمی‌شود**. به‌جایش یک «نشان معوق» برای
 *     همان کار منطقی با یک INSERT اتمیک نوشته می‌شود (`lmc_qp_`؛ تکرار همان نشان را نگه می‌دارد) و
 *     `drain()` آن را **زیر قفل** انجام می‌دهد — در هر دور اجراکنندهٔ اختصاصی، kick و اجراکنندهٔ
 *     دقیقه‌ای Action Scheduler. Checkout نه منتظر می‌ماند نه استثنا می‌گیرد، و کار گم نمی‌شود.
 *     نشانی که تا DEFER_MAX_AGE قفل نگیرد، **ثبت مرده** می‌شود (دیده می‌شود، نه بی‌انتها).
 *   • نوشتن شمارندهٔ شکست ناموفق: شکستِ شمرده‌نشده **دوباره صف نمی‌شود** (وگرنه سقف MAX_CRASHES
 *     دور زده می‌شد)؛ کار با دلیل `counter_write_failed` مرده ثبت می‌شود. خواندنی که خطا بدهد «ردیف
 *     نیست» شمرده نمی‌شود.
 *   • نوشتن ثبت مرده یا نشان معوق هم ناموفق: لاگ خطا؛ سطر failed خودِ Action Scheduler می‌ماند و
 *     `health().failedActions` آن را می‌شمارد، پس تشخیص «صف سالم و خالی» نمی‌گوید.
 *
 * ── بازپخش تصمیم ماندگار (بازبینی سوم ریشه) ──
 *
 *   • هر شکست غیرمنتظره **هویت** دارد: شناسهٔ سطر Action Scheduler. شمارنده یک ردیف برای هر شکست است
 *     (`lmc_qc_<کلید>_<شناسهٔ سطر>`، درج تکراری بی‌اثر) و شمار = تعداد ردیف‌ها. پس بازپخش همان تصمیم
 *     (drain پس از شکست حذف نشان، یا دو Hook برای یک سطر) همان شکست را دوباره نمی‌شمارد.
 *   • اجرای سالم «واترمارک» شناسهٔ سطر را بالا می‌برد (`lmc_qs_`)؛ شکستی با شناسهٔ کوچک‌تر یا برابر
 *     کهنه است و بازپخشش نه می‌شمارد نه صف می‌سازد. تصمیم انسانی («ارسال دوباره») نشان‌های بازیابی
 *     همان کار را هم پاک می‌کند.
 *   • نشان `e`/`r` **آخرین تصمیم** را نگه می‌دارد (اجراها پشت قفل اجرا پشت سر هم‌اند، پس آخرین نوشتن
 *     تازه‌ترین نتیجه است)؛ reschedule مستقیم زیر قفل نشان کهنهٔ `r` را برمی‌دارد، و drain نشان را
 *     **زیر قفل دوباره می‌خواند** تا نشان کهنه نتیجهٔ تازه‌تر را بازنویسی نکند.
 *   • قفل اجرا: مهلت تمام‌شده (`false`) یعنی اجرای دیگری واقعاً در جریان است — BUSY، شمرده نمی‌شود،
 *     ولی «دورهٔ اشغال» ثبت می‌شود و بیش از BUSY_MAX_AGE مرده ثبت می‌شود. خطای SQL (`null`) BUSY
 *     نیست: شکست شمرده‌شده است (`lock_error`) و پس از MAX_CRASHES مرده. هر دو پس از بررسی ثبت مرده.
 *   • ارسال دستی و رویداد WP-Cron (جایگزین یا مانده از پیش از ارتقا) هم از `exclusive()` می‌گذرند:
 *     همان قفل اجرا (بازگشتی برای اجرای خودِ AS)، و اگر گرفته نشد دوباره صف — نه ارسال هم‌زمان.
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Queue
{
    const GROUP = 'labelmod-critical';
    /** شتاب‌دهنده: رویداد WP-Cron که فقط گروه بحرانی را می‌راند. */
    const KICK = 'lmc_queue_kick';
    /** ردیف هر کار در `wp_options` (autoload خاموش): شمارندهٔ شکست غیرمنتظره و ثبت مرده. */
    const CRASH_PREFIX = 'lmc_qc_';
    const DEAD_PREFIX = 'lmc_qd_';
    /** شکست غیرمنتظرهٔ پیاپی تا ثبت مرده. */
    const MAX_CRASHES = 3;
    const KICK_BATCH = 10;
    /** انتظار اجرای دوم همان کار: بیش از Timeout درخواست Core (۲۰ ثانیه). */
    const EXEC_LOCK_WAIT = 45;
    const ENQUEUE_LOCK_WAIT = 5;
    const BUSY = 'lmc_queue_busy';
    const LOCK_ERROR = 'lmc_queue_lock_error';
    /** واترمارک بزرگ‌ترین سطر اجراشدهٔ سالم، و آغاز دورهٔ اشغال قفل اجرا. */
    const SUCCESS_PREFIX = 'lmc_qs_';
    const BUSY_PREFIX = 'lmc_qb_';
    /** اشغال پیاپی قفل اجرا بیش از این (اجرای واقعی حداکثر ده‌ها ثانیه است) مرده ثبت می‌شود. */
    const BUSY_MAX_AGE = 900;
    /** فاصله‌ای که پس از آن اشغال تازه دورهٔ تازه است (بیش از دو برابر فاصلهٔ تلاش BUSY). */
    const BUSY_GAP = 300;
    /** انتظار قفل اجرا برای ارسال دستی و WP-Cron (بیرون از اجراکنندهٔ AS). */
    const EXCLUSIVE_WAIT = 10;
    /** نشان کار معوق (قفل صف گرفته نشد): `lmc_qp_<e|r>_<کلید>` و `lmc_qp_c_<کلید>_<شناسهٔ سطر>`. */
    const DEFER_PREFIX = 'lmc_qp_';
    /** نشانی که این مدت قفل نگیرد مرده ثبت می‌شود. */
    const DEFER_MAX_AGE = 1800;
    const DRAIN_BATCH = 20;

    /** قفل‌های گرفته‌شده در همین پردازه: نام ← عمق (بی تکیه بر بازگشتی‌بودن GET_LOCK). */
    private static $locks = [];
    /** شناسهٔ سطر در حال اجرا ← نام قفلش. */
    private static $running = [];

    /** فقط این رویدادها مال این صف‌اند؛ هیچ کار دیگری در گروه دوباره صف نمی‌شود. */
    public static function hooks(): array
    {
        return [LMC_ORDER_EVENT, LMC_Order_Reservation::EVENT, LMC_Refund_Sync::EVENT];
    }

    public static function init(): void
    {
        add_action(self::KICK, [__CLASS__, 'kick']);
        // کف تضمینی تخلیهٔ نشان‌های معوق: هر دور اجراکنندهٔ دقیقه‌ای خودِ Action Scheduler.
        add_action('action_scheduler_before_process_queue', [__CLASS__, 'drain']);
        // قفل پیش از بررسی وضعیت خودِ Action Scheduler؛ آزادسازی پس از همهٔ Hookهای پایان.
        add_action('action_scheduler_before_execute', [__CLASS__, 'before_execute'], 0, 1);
        add_action('action_scheduler_failed_execution', [__CLASS__, 'on_failed_execution'], 10, 2);
        add_action('action_scheduler_failed_action', [__CLASS__, 'on_failed'], 10, 1);
        add_action('action_scheduler_unexpected_shutdown', [__CLASS__, 'on_failed'], 10, 1);
        add_action('action_scheduler_after_execute', [__CLASS__, 'on_executed'], 10, 2);
        foreach (['action_scheduler_after_execute', 'action_scheduler_failed_execution', 'action_scheduler_execution_ignored',
            'action_scheduler_canceled_corrupted_action'] as $done) {
            add_action($done, [__CLASS__, 'after_execute'], 1000, 1);
        }
        if (defined('WP_CLI') && WP_CLI && class_exists('WP_CLI')) {
            WP_CLI::add_command('labelmod queue', 'LMC_Queue_Command');
        }
    }

    /** Action Scheduler آماده است؟ پیش از `init` یا بدون ووکامرس نه. */
    public static function action_scheduler(): bool
    {
        return function_exists('as_enqueue_async_action') && function_exists('as_schedule_single_action')
            && function_exists('as_get_scheduled_actions') && function_exists('as_unschedule_all_actions')
            && class_exists('ActionScheduler') && method_exists('ActionScheduler', 'is_initialized')
            && ActionScheduler::is_initialized();
    }

    /** کار تازه؛ اگر همان کار هنوز معلق است، همان می‌ماند (دو ارسال برای یک رویداد نه). */
    public static function enqueue(string $hook, array $args, int $delay = 0): bool
    {
        $lock = self::lock($hook, $args, self::ENQUEUE_LOCK_WAIT);
        if (!is_string($lock)) {
            // بی قفل نه «معلق هست؟» پرسیده می‌شود نه درج: نشان معوق، و drain زیر قفل انجامش می‌دهد.
            return self::defer('e', $hook, $args, ['due' => time() + max(0, $delay)]);
        }
        try {
            if (self::pending($hook, $args)) {
                return true;
            }
            return self::schedule($hook, $args, $delay);
        } finally {
            self::unlock($lock);
        }
    }

    /**
     * نتیجهٔ همین اجرا جای هر کار معلقی را می‌گیرد که حین HTTP صف شده بود:
     * Backoff کامل می‌ماند و کارِ پیشِ‌رس آن را دور نمی‌زند.
     */
    public static function reschedule(string $hook, array $args, int $delay): bool
    {
        return self::supersede($hook, $args, max(0, $delay));
    }

    /**
     * شکست قطعی: هیچ کار معلقی نمی‌ماند — و تصمیم تلاش‌دوبارهٔ معوقِ کهنه‌تر هم دیگر برنمی‌گرداندش.
     */
    public static function stop(string $hook, array $args): bool
    {
        return self::supersede($hook, $args, null);
    }

    /**
     * تصمیم تازه‌ترِ اجرای جاری («دوباره در N ثانیه» یا «توقف») جای هر تصمیم کهنه‌تر را می‌گیرد — **پایدار**،
     * پیش از اثر:
     *
     * - بی قفل صف: نشان «r» با همین تصمیم (آخرین برنده) و drain زیر قفل انجامش می‌دهد.
     * - با قفل و نشان «r» کهنه‌تر: اول نشان با **همین تصمیم** بازنویسی می‌شود (یک UPSERT اتمیک)، بعد صف
     *   عوض می‌شود، و حذف نشان فقط پاک‌سازی است. حذفِ ناموفق یا مرگ پردازه میان نوشتن‌ها نشانی جز همین
     *   تصمیم به‌جا نمی‌گذارد، پس بازپخشش هم‌ارز است، نه بازگشت به تصمیم کهنه. اگر خودِ بازنویسی ممکن نشد،
     *   صف دست نمی‌خورد و `false` (تصمیم کهنه می‌ماند و تلاش دوباره گم نمی‌شود).
     * - `floor`: این تصمیم برای اجرایی تا این شناسه است. اجرای سالمِ تازه‌تر (واترمارک بزرگ‌تر) بازپخش آن را
     *   بی‌اثر می‌کند — تصمیمِ مصرف‌شده ارسال تکراری نمی‌سازد.
     *
     * نوشتن‌های «r» یک کار با قفل اجرای همان کار سریال‌اند (فقط Handler زیر `exclusive`/اجرای AS صدا می‌زند).
     */
    private static function supersede(string $hook, array $args, ?int $delay): bool
    {
        $decision = ['due' => $delay === null ? null : time() + $delay, 'stop' => $delay === null, 'floor' => self::floor($hook, $args)];
        $lock = self::lock($hook, $args, self::ENQUEUE_LOCK_WAIT);
        if (!is_string($lock)) {
            return self::defer('r', $hook, $args, $decision);
        }
        try {
            $name = self::marker_name('r', $hook, $args, 0);
            $older = self::read($name, $ok);
            $mine = null;
            if (!$ok || $older !== null) {
                $mine = self::put_marker('r', $hook, $args, $decision, true);
                if ($mine === null) {
                    lmc_log(sprintf('⛔ تصمیم تازهٔ صف %s ماندگار نشد؛ صف دست نخورد و تصمیم قبلی می‌ماند.', $hook));
                    return false;
                }
            }
            self::cancel($hook, $args);
            $done = $delay === null || self::schedule($hook, $args, $delay);
            if ($mine !== null && !self::forget_marker($name, $mine)) {
                lmc_log(sprintf('پاک‌سازی نشان تصمیم %s ناموفق بود؛ بازپخشش همین تصمیم است.', $hook));
            }
            return $done;
        } finally {
            self::unlock($lock);
        }
    }

    /**
     * کفِ تصمیم: شناسهٔ سطر AS در حال اجرای همین کار (تصمیم مالِ همین اجراست)، وگرنه واترمارک فعلی
     * اجرای سالم. `0` اگر هیچ‌کدام نیست یا خوانده نشد (محافظه‌کارانه: تصمیم بی‌اثر نمی‌شود).
     */
    private static function floor(string $hook, array $args): int
    {
        global $wpdb;
        $x = 'lmc_qx_' . md5((defined('DB_NAME') ? DB_NAME : '') . '|' . $wpdb->prefix . '|' . self::key($hook, $args));
        foreach (self::$running as $action_id => $lock) {
            if ($lock === $x) {
                return (int) $action_id;
            }
        }
        $mark = self::read(self::SUCCESS_PREFIX . self::key($hook, $args), $ok);
        return $ok ? (int) $mark : 0;
    }

    /**
     * قفل اجرای همان کار برای هر ورودی Handler بیرون از اجراکنندهٔ AS (ارسال دستی، رویداد WP-Cron
     * جایگزین یا مانده از پیش از ارتقا). درون اجرای AS همان قفل بازگشتی است. `null` = گرفته نشد:
     * Handler اجرا نمی‌شود و کار دوباره صف می‌شود (همان مسیر enqueue، با همهٔ نگهبان‌هایش).
     */
    public static function exclusive(string $hook, array $args): ?string
    {
        $lock = self::lock($hook, $args, self::EXCLUSIVE_WAIT, 'x');
        if (is_string($lock)) {
            return $lock;
        }
        lmc_log(sprintf('اجرای %s هم‌اکنون ممکن نشد (قفل اجرا %s)؛ دوباره صف شد.', $hook, $lock === false ? 'در دست اجرای دیگر' : 'در دسترس نیست'));
        self::enqueue($hook, $args, 30 + random_int(0, 30));
        return null;
    }

    public static function release(?string $lock): void
    {
        self::unlock($lock);
    }

    /**
     * تصمیم انسانی («ارسال دوباره»): شمارنده و ثبت مرده پاک می‌شوند. `false` یعنی پاک نشد — ثبت مرده
     * می‌ماند و بازیابی بعدی همان کار را لغو می‌کند، پس فراخوان باید شکست را به انسان نشان دهد.
     */
    public static function forget(string $hook, array $args): bool
    {
        global $wpdb;
        $key = self::key($hook, $args);
        // تصمیم انسانی بر تصمیم‌های بازیابی معوقِ همان کار مقدم است.
        $ok = self::clear_rows($key) && $wpdb->query($wpdb->prepare(
            "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", self::like_prefix(self::DEFER_PREFIX . 'c_' . $key . '_'))) !== false;
        if (!$ok) {
            lmc_log(sprintf('پاک‌کردن شمارنده/ثبت مردهٔ %s ناموفق بود؛ «ارسال دوباره» را تکرار کنید.', $hook));
        }
        return $ok;
    }

    /** هر کار **معلق** را برمی‌دارد؛ کارِ در حال اجرا (همین فراخوان) دست نمی‌خورد. */
    public static function cancel(string $hook, array $args): void
    {
        if (self::action_scheduler()) {
            as_unschedule_all_actions($hook, $args, self::GROUP);
        }
        // رویداد WP-Cron مانده از نسخهٔ پیش از ارتقا هم برداشته می‌شود.
        wp_clear_scheduled_hook($hook, $args);
    }

    /** معلق (نه در حال اجرا). اجرای جاری باید بتواند تلاش بعدی خودش را صف کند. */
    public static function pending(string $hook, array $args): bool
    {
        if (wp_next_scheduled($hook, $args)) {
            return true;
        }
        if (!self::action_scheduler()) {
            return false;
        }
        return (bool) as_get_scheduled_actions([
            'hook' => $hook, 'args' => $args, 'group' => self::GROUP,
            'status' => ActionScheduler_Store::STATUS_PENDING, 'per_page' => 1,
        ], 'ids');
    }

    /** معلق یا در حال اجرا — برای گزارش تشخیص. */
    public static function queued(string $hook, array $args): bool
    {
        if (wp_next_scheduled($hook, $args)) {
            return true;
        }
        return self::action_scheduler() && function_exists('as_has_scheduled_action')
            && as_has_scheduled_action($hook, $args, self::GROUP);
    }

    private static function schedule(string $hook, array $args, int $delay): bool
    {
        $delay = max(0, $delay);
        if (self::action_scheduler()) {
            try {
                $id = $delay === 0
                    ? as_enqueue_async_action($hook, $args, self::GROUP)
                    : as_schedule_single_action(time() + $delay, $hook, $args, self::GROUP);
            } catch (Throwable $e) {
                $id = 0;
            }
            if ($id) {
                if ($delay === 0) {
                    self::request_kick();
                }
                return true;
            }
            lmc_log(sprintf('صف Action Scheduler برای %s ذخیره نشد؛ WP-Cron جایگزین شد.', $hook));
        }
        $ok = wp_schedule_single_event(time() + $delay, $hook, $args);
        if ($ok === false || is_wp_error($ok)) {
            // هیچ صفی کار را نگرفت: گم نمی‌شود، دیده می‌شود (record_dead شکست نوشتن خودش را لاگ می‌کند).
            self::record_dead($hook, $args, 'enqueue_failed', 0);
            return false;
        }
        return true;
    }

    private static function request_kick(): void
    {
        if (!wp_next_scheduled(self::KICK)) {
            wp_schedule_single_event(time(), self::KICK);
        }
    }

    /**
     * Backoff نمایی با jitter برابر: [نیمه، کامل] از `base·2^(n−1)`، سقف `cap`.
     * Retry-After سرور (۴۲۹/۵۰۳) کفِ تأخیر است، نه سقفش — و خودش هم سقف دارد.
     */
    public static function retry_delay(int $attempt, ?WP_Error $error = null, int $base = 60, int $cap = 3600): int
    {
        $exp = (int) min($cap, $base * (2 ** max(0, min(20, $attempt - 1))));
        $delay = intdiv($exp, 2) + random_int(0, $exp - intdiv($exp, 2));
        $data = $error ? $error->get_error_data() : null;
        if (is_array($data) && isset($data['retry_after']) && is_int($data['retry_after'])) {
            $delay = max($delay, min($cap, $data['retry_after']));
        }
        return max(1, min($cap, $delay));
    }

    /** رویداد kick: فقط گروه بحرانی، با Claim خودِ Action Scheduler. */
    public static function kick(): void
    {
        if (!self::action_scheduler()) {
            self::drain();
            return;
        }
        if (self::run(self::KICK_BATCH, 'LMC Kick') >= self::KICK_BATCH) {
            self::request_kick();
        }
    }

    /**
     * حداکثر `$max` کار سررسیدهٔ گروه را برمی‌دارد و اجرا می‌کند.
     * Claim اتمیک است، پس اجراکنندهٔ دقیقه‌ای Action Scheduler یا WP-CLI
     * هم‌زمان همان کار را برنمی‌دارند.
     */
    public static function run(int $max, string $context): int
    {
        if (!self::action_scheduler() || $max <= 0) {
            return 0;
        }
        $store = ActionScheduler::store();
        self::clean($store);
        self::drain();
        // ⚠️ تا مهاجرت جدول‌های Action Scheduler تمام نشده (HybridStore)، Claim اول از انبار پست‌ها
        //    گرفته می‌شود و گروهی که آنجا Term ندارد InvalidArgumentException می‌دهد — روی ووکامرس
        //    ۱۱٫۱٫۱ واقعی دیده شد، و همان برای `wp action-scheduler run --group` هم هست. کار تازه در
        //    Hybrid همیشه در جدول اصلی (DBStore) ذخیره می‌شود، پس Claim از همان‌جاست.
        $claims = ($store instanceof ActionScheduler_HybridStore && class_exists('ActionScheduler_DBStore'))
            ? new ActionScheduler_DBStore() : $store;
        $claim = $claims->stake_claim($max, null, [], self::GROUP);
        $monitor = class_exists('ActionScheduler_FatalErrorMonitor') ? new ActionScheduler_FatalErrorMonitor($claims) : null;
        if ($monitor) {
            // خطای مرگبار وسط کار → همان لحظه failed و Hook بازیابی، نه پنج دقیقه in-progress.
            $monitor->attach($claim);
        }
        $done = 0;
        try {
            foreach ($claim->get_actions() as $action_id) {
                if ($claims->get_claim_id($action_id) !== $claim->get_id()) {
                    break;
                }
                ActionScheduler::runner()->process_action($action_id, $context);
                // اجراکنندهٔ بلندمدت قفلی را که مسیری از AS آزاد نکرده نگه نمی‌دارد.
                self::after_execute($action_id);
                $done++;
            }
        } finally {
            $claims->release_claim($claim);
            if ($monitor) {
                $monitor->detach();
            }
        }
        return $done;
    }

    /**
     * کار پردازهٔ کشته‌شده (SIGKILL، OOM) in-progress می‌ماند و هیچ Hookی شلیک
     * نمی‌شود. همان پاک‌کنندهٔ خودِ Action Scheduler (پس از `action_scheduler_failure_period`،
     * پیش‌فرض ۳۰۰ ثانیه) failedش می‌کند و `recover()` دوباره صفش. اجراکنندهٔ
     * اختصاصی باید خودش این را بزند: با WP-Cron خاموش، اجراکنندهٔ دقیقه‌ای AS نیست.
     */
    private static function clean($store): void
    {
        static $last = 0.0;
        if (!class_exists('ActionScheduler_QueueCleaner') || microtime(true) - $last < 60) {
            return;
        }
        $last = microtime(true);
        $cleaner = new ActionScheduler_QueueCleaner($store);
        $cleaner->reset_timeouts();
        $cleaner->mark_failures();
    }

    /**
     * پیش از بررسی وضعیت هر سطر (`process_action`): قفل همان کار منطقی. اگر اجرای دیگری از همان
     * کار بیش از EXEC_LOCK_WAIT طول بکشد، این سطر با BUSY شکست می‌خورد و بی شمردن دوباره صف می‌شود.
     */
    public static function before_execute($action_id): void
    {
        $action = self::owned((int) $action_id);
        if (!$action) {
            return;
        }
        $lock = self::lock((string) $action->get_hook(), (array) $action->get_args(), self::EXEC_LOCK_WAIT, 'x');
        if ($lock === false) {
            // مالک واقعی: اجرای دیگری از همین کار در جریان است. BUSY، شمرده نمی‌شود (دورهٔ اشغال محدود است).
            throw new RuntimeException(self::BUSY);
        }
        if (!is_string($lock)) {
            // خطای SQL، نه مالک: بی سریال‌سازی اجرا نمی‌شود و شکستی **شمرده‌شده** است.
            throw new RuntimeException(self::LOCK_ERROR);
        }
        self::$running[(int) $action_id] = $lock;
    }

    public static function after_execute($action_id): void
    {
        $lock = self::$running[(int) $action_id] ?? null;
        unset(self::$running[(int) $action_id]);
        self::unlock($lock);
    }

    public static function on_failed_execution($action_id, $error = null): void
    {
        $message = $error instanceof Throwable ? $error->getMessage() : '';
        self::recover((int) $action_id, $message === self::BUSY ? 'busy'
            : ($message === self::LOCK_ERROR ? 'lock_error' : ($error instanceof Throwable ? 'exception' : 'failed')));
    }

    public static function on_failed($action_id): void
    {
        self::recover((int) $action_id, 'timeout_or_shutdown');
    }

    /** اجرای بی‌استثنا شمارنده و ثبت مردهٔ همان کار را پاک می‌کند (نتیجهٔ کسب‌وکار جداست). */
    public static function on_executed($action_id, $action = null): void
    {
        if (!is_object($action) || !method_exists($action, 'get_group') || $action->get_group() !== self::GROUP) {
            return;
        }
        global $wpdb;
        $key = self::key((string) $action->get_hook(), (array) $action->get_args());
        // واترمارک پیش از پاک‌کردن: بازپخش دیرهنگام شکستی کهنه‌تر از این اجرا دیگر نمی‌شمارد.
        $mark = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %d, 'no')
             ON DUPLICATE KEY UPDATE option_value = GREATEST(CAST(option_value AS UNSIGNED), %d)",
            self::SUCCESS_PREFIX . $key, (int) $action_id, (int) $action_id
        ));
        if ($mark === false || !self::clear_rows($key)) {
            // شمارندهٔ کهنه فقط زودتر مرده می‌کند (محافظه‌کارانه)، ولی دیده شود.
            lmc_log(sprintf('پاک‌کردن شمارندهٔ شکست %s پس از اجرای سالم ناموفق بود.', (string) $action->get_hook()));
        }
    }

    /**
     * شکست غیرمنتظره: Action Scheduler کار را failed می‌کند و خودش دوباره صف نمی‌کند.
     * زیر قفل همان کار: افزایش اتمیک شمارنده؛ تا سقف دوباره صف، بعد ثبت مرده و لغو هر سطر
     * معلق. کار مرده با شکست بعدی (مثلاً سطر تکراری) دوباره صف **نمی‌شود**.
     */
    private static function recover(int $action_id, string $why): void
    {
        if ($action_id <= 0 || !self::action_scheduler()) {
            return;
        }
        $action = self::owned($action_id);
        if (!$action) {
            return;
        }
        $hook = (string) $action->get_hook();
        $args = (array) $action->get_args();
        $lock = self::lock($hook, $args, 10);
        if (!is_string($lock)) {
            // بی قفل نه شمارش نه تصمیم: نشان معوق با هویت همین شکست؛ drain همان تصمیم را زیر قفل می‌گیرد.
            self::defer('c', $hook, $args, ['why' => $why, 'action' => $action_id]);
            return;
        }
        try {
            if (!self::recover_locked($hook, $args, $why, $action_id)) {
                // تصمیم ذخیره نشد (نوشتن وضعیت شکست خورد): نشان معوق تا drain دوباره بکوشد.
                self::defer('c', $hook, $args, ['why' => $why, 'action' => $action_id]);
            }
        } finally {
            self::unlock($lock);
        }
    }

    /**
     * تصمیم بازیابی، **فقط زیر قفل صف همان کار**. `true` = تصمیم ماندگار شد (دوباره صف، ثبت مرده،
     * یا کار مرده لغو، یا شکست کهنه)؛ `false` = نوشتن وضعیت شکست خورد و هیچ تلاش شمرده‌نشده‌ای صف نشد.
     * **Idempotent** برای همان `$action_id`: بازپخش همان شکست را دوباره نمی‌شمارد و صف دوم نمی‌سازد.
     */
    private static function recover_locked(string $hook, array $args, string $why, int $action_id): bool
    {
        $key = self::key($hook, $args);
        $dead = self::read(self::DEAD_PREFIX . $key, $ok);
        if (!$ok) {
            return false;
        }
        if ($dead !== null) {
            self::cancel($hook, $args);
            return true;
        }
        if ($why === 'busy') {
            // اجرای دیگری از همین کار هنوز در جریان است؛ شکست نیست، شمرده نمی‌شود — ولی بی‌انتها هم نه.
            $since = self::busy_since($key);
            if ($since === null) {
                return false;
            }
            if (time() - $since > self::BUSY_MAX_AGE) {
                if (!self::record_dead($hook, $args, 'exec_lock_held', 0)) {
                    return false;
                }
                self::cancel($hook, $args);
                return true;
            }
            return self::pending($hook, $args) || self::schedule($hook, $args, 30 + random_int(0, 30));
        }
        $mark = self::read(self::SUCCESS_PREFIX . $key, $ok);
        if (!$ok) {
            return false;
        }
        if ($mark !== null && $action_id <= (int) $mark) {
            // اجرای سالمِ تازه‌تری پس از این شکست رخ داده است: بازپخش کهنه، نه شمارش نه صف.
            return true;
        }
        $n = self::bump($key, $action_id);
        if ($n === null) {
            // شمارنده ذخیره نشد: تلاش شمرده‌نشده یعنی سقف دور زده شود. توقف دیده‌شده به‌جای تکرار بی‌حد.
            if (!self::record_dead($hook, $args, 'counter_write_failed', 0)) {
                return false;
            }
            self::cancel($hook, $args);
            return true;
        }
        if ($n >= self::MAX_CRASHES) {
            if (!self::record_dead($hook, $args, $why, $n)) {
                return false;
            }
            self::cancel($hook, $args);
            return true;
        }
        // پایهٔ کوتاه (۵ ثانیه با jitter): رایج‌ترین شکست غیرمنتظره روی MariaDB واقعی بن‌بست InnoDB
        // در `log_execution` خودِ Action Scheduler بود — پیش از اجرای Handler — وقتی دو اجراکننده
        // هم‌زمان Claim می‌کنند. با پایهٔ ۶۰ ثانیه همان سفارش ~۵۰ ثانیه عقب می‌افتاد.
        return self::pending($hook, $args) || self::schedule($hook, $args, self::retry_delay($n, null, 5, 300))
            || self::read(self::DEAD_PREFIX . $key, $ok) !== null;
    }

    /**
     * نشان معوق برای کاری که قفل صفش گرفته نشد. INSERT اتمیک روی کلید یکتا؛ نشان موجود دست
     * نمی‌خورد (همان کار منطقی، همان عمل). `false` = حتی نشان ذخیره نشد — لاگ خطا؛ سطر failed
     * خودِ Action Scheduler (اگر هست) در `failedActions` تشخیص می‌ماند.
     */
    private static function defer(string $op, string $hook, array $args, array $extra): bool
    {
        if (self::put_marker($op, $hook, $args, $extra, $op !== 'c') === null) {
            lmc_log(sprintf('⛔ تغییر صف %s انجام نشد و نشان معوقش هم ذخیره نشد؛ پایگاه داده را بررسی کنید.', $hook));
            return false;
        }
        lmc_log(sprintf('قفل صف %s گرفته نشد؛ کار معوق ذخیره شد و زیر قفل انجام می‌شود.', $hook));
        self::request_kick();
        return true;
    }

    /**
     * نوشتن نشان؛ مقدار نوشته‌شده یا `null`. `seq` هر نوشتن را یکتا می‌کند: drain و پاک‌سازی فقط نشانی را
     * حذف می‌کنند که هنوز همان است که نوشته/خوانده بودند. `$replace`: «e»/«r» آخرین تصمیم برنده است؛
     * «c» هویتِ یک شکست است و نسخهٔ اول کافی است.
     */
    private static function put_marker(string $op, string $hook, array $args, array $extra, bool $replace): ?string
    {
        global $wpdb;
        $value = wp_json_encode(['op' => $op, 'hook' => $hook, 'args' => array_values($args), 'at' => time(),
            'seq' => bin2hex(random_bytes(8))] + $extra);
        $name = self::marker_name($op, $hook, $args, (int) ($extra['action'] ?? 0));
        $done = $wpdb->query($replace
            ? $wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')
                 ON DUPLICATE KEY UPDATE option_value = %s", $name, $value, $value)
            : $wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')
                 ON DUPLICATE KEY UPDATE option_name = option_name", $name, $value));
        return $done === false ? null : (string) $value;
    }

    /**
     * نشان‌های معوق را زیر قفل همان کار انجام می‌دهد؛ نشان فقط پس از ماندگارشدن نتیجه حذف می‌شود
     * (و فقط اگر در این فاصله عوض نشده باشد). نشانی که تا DEFER_MAX_AGE قفل نگیرد مرده ثبت می‌شود.
     */
    public static function drain(): int
    {
        global $wpdb;
        if (!isset($wpdb) || !method_exists($wpdb, 'get_results')) {
            return 0;
        }
        $rows = $wpdb->get_results($wpdb->prepare(
            "SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE 'lmc\\_qp\\_%%' ORDER BY option_id LIMIT %d",
            self::DRAIN_BATCH
        ), ARRAY_A);
        $settled = 0;
        foreach ((array) $rows as $row) {
            $name = (string) ($row['option_name'] ?? '');
            $raw = (string) ($row['option_value'] ?? '');
            $d = json_decode($raw, true);
            $hook = is_array($d) ? (string) ($d['hook'] ?? '') : '';
            $args = is_array($d) && is_array($d['args'] ?? null) ? $d['args'] : null;
            $op = is_array($d) ? (string) ($d['op'] ?? '') : '';
            $action_id = is_array($d) ? (int) ($d['action'] ?? 0) : 0;
            if (!in_array($hook, self::hooks(), true) || $args === null || !in_array($op, ['e', 'r', 'c'], true)
                || ($op === 'c' && $action_id <= 0) || $name !== self::marker_name($op, $hook, $args, $action_id)) {
                lmc_log('نشان معوق نامعتبر صف کنار گذاشته شد.');
                self::forget_marker($name, $raw);
                continue;
            }
            $lock = self::lock($hook, $args, 1);
            if (!is_string($lock)) {
                if (time() - (int) ($d['at'] ?? 0) > self::DEFER_MAX_AGE
                    && self::record_dead($hook, $args, 'queue_lock_unavailable', 0)) {
                    self::forget_marker($name, $raw);
                }
                continue;
            }
            try {
                // زیر قفل دوباره خوانده می‌شود: اگر در این فاصله تصمیمی تازه‌تر نشان را عوض یا حذف کرده،
                // نشانِ خوانده‌شده کهنه است و اعمال نمی‌شود (دور بعد، اگر هنوز هست، تازه‌اش را می‌خواند).
                if (self::read($name, $fresh) !== $raw || !$fresh) {
                    continue;
                }
                $due = max(0, (int) ($d['due'] ?? 0) - time());
                if ($op === 'e') {
                    $ok = self::pending($hook, $args) || self::schedule($hook, $args, $due);
                } elseif ($op === 'r') {
                    // تصمیمی که اجرای سالمِ تازه‌تری پس از آن مصرفش کرده، بی‌اثر است (نه ارسال تکراری).
                    // نشان‌های پیش از این نسخه `floor` ندارند و مثل قبل اعمال می‌شوند.
                    if (array_key_exists('floor', $d)) {
                        $mark = self::read(self::SUCCESS_PREFIX . self::key($hook, $args), $mok);
                        if (!$mok) {
                            continue;
                        }
                        if ((int) $mark > (int) $d['floor']) {
                            if (self::forget_marker($name, $raw)) {
                                $settled++;
                            }
                            continue;
                        }
                    }
                    self::cancel($hook, $args);
                    $ok = !empty($d['stop']) || self::schedule($hook, $args, $due);
                } else {
                    $ok = self::recover_locked($hook, $args, (string) ($d['why'] ?? 'deferred'), $action_id);
                }
                // شکست درج صف خودش مرده ثبت می‌کند؛ آن هم نتیجهٔ ماندگار است.
                $ok = $ok || self::read(self::DEAD_PREFIX . self::key($hook, $args), $read) !== null;
                if ($ok && self::forget_marker($name, $raw)) {
                    $settled++;
                }
            } finally {
                self::unlock($lock);
            }
        }
        return $settled;
    }

    private static function marker_name(string $op, string $hook, array $args, int $action_id): string
    {
        return self::DEFER_PREFIX . $op . '_' . self::key($hook, $args) . ($op === 'c' ? '_' . $action_id : '');
    }

    /** الگوی LIKE برای پیشوند (`_` و `%` و `\` لفظی). */
    private static function like_prefix(string $prefix): string
    {
        global $wpdb;
        return (method_exists($wpdb, 'esc_like') ? $wpdb->esc_like($prefix) : addcslashes($prefix, '_%\\')) . '%';
    }

    /**
     * آغاز دورهٔ اشغال قفل اجرای همین کار (زیر قفل صف همان کار، پس خواندن و نوشتن یک‌جا امن است).
     * اشغالی که بیش از BUSY_GAP پس از قبلی بیاید، دورهٔ تازه است. `null` = خواندن یا نوشتن شکست خورد.
     */
    private static function busy_since(string $key): ?int
    {
        global $wpdb;
        $raw = self::read(self::BUSY_PREFIX . $key, $ok);
        if (!$ok) {
            return null;
        }
        $now = time();
        [$since, $last] = array_map('intval', explode(':', (string) $raw) + [0, 0]);
        if ($raw === null || $now - $last > self::BUSY_GAP) {
            $since = $now;
        }
        $value = $since . ':' . $now;
        $done = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')
             ON DUPLICATE KEY UPDATE option_value = %s", self::BUSY_PREFIX . $key, $value, $value));
        return $done === false ? null : $since;
    }

    private static function forget_marker(string $name, string $raw): bool
    {
        global $wpdb;
        return $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s", $name, $raw)) !== false;
    }

    private static function record_dead(string $hook, array $args, string $why, int $crashes): bool
    {
        global $wpdb;
        $value = wp_json_encode(['hook' => $hook, 'args' => array_values($args), 'reason' => $why, 'crashes' => $crashes, 'at' => gmdate('c')]);
        $done = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')
             ON DUPLICATE KEY UPDATE option_value = %s",
            self::DEAD_PREFIX . self::key($hook, $args), $value, $value
        ));
        if ($done === false) {
            lmc_log(sprintf('⛔ ثبت مردهٔ %s (%s) ذخیره نشد؛ سطر failed در Action Scheduler تنها ردِ آن است.', $hook, $why));
            return false;
        }
        lmc_log(sprintf('کار %s متوقف شد (%s)؛ بررسی دستی و «ارسال دوباره» لازم است.', $hook, $why));
        return true;
    }

    /**
     * برای تشخیص اتصال؛ هیچ دادهٔ سفارشی در آن نیست. `deadTasks` شمار **کل** کارهای منطقی
     * مرده از شکست غیرمنتظره است (نه نمونه)؛ توقف کسب‌وکاری (شش تلاش ناموفق HTTP، خطای دائمی)
     * وضعیت خودِ سفارش است و اینجا شمرده نمی‌شود. `deferredTasks` کارهای منتظر قفل صف است و
     * `failedActions` سطرهای failed نگه‌داشته‌شدهٔ گروه در خودِ Action Scheduler (مستقل از ردیف‌های
     * ما — اگر نوشتن وضعیت شکست خورده باشد، این صفر نیست). `null` = خوانده نشد، نه صفر.
     */
    public static function health(): array
    {
        global $wpdb;
        $dead = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'lmc\\_qd\\_%'");
        $deferred = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'lmc\\_qp\\_%'");
        $busy = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'lmc\\_qb\\_%'");
        $failed = null;
        if (self::action_scheduler()) {
            try {
                $failed = (int) ActionScheduler::store()->query_actions(['group' => self::GROUP, 'status' => 'failed'], 'count');
            } catch (Throwable $e) {
                $failed = null;
            }
        }
        return [
            'backend' => self::action_scheduler() ? 'action-scheduler' : 'wp-cron',
            'group' => self::GROUP,
            'deadTasks' => $dead === null ? null : (int) $dead,
            'deadScope' => 'unexpected_failure_only',
            'deferredTasks' => $deferred === null ? null : (int) $deferred,
            // کارهایی که آخرین تلاششان پشت قفل اجرای در دستِ اجرای دیگری ماند (پس از اجرای سالم پاک می‌شود).
            'busyTasks' => $busy === null ? null : (int) $busy,
            'failedActions' => $failed,
            'failedActionsScope' => 'action_scheduler_retained_rows',
        ];
    }

    private static function owned(int $action_id)
    {
        if ($action_id <= 0 || !self::action_scheduler()) {
            return null;
        }
        $action = ActionScheduler::store()->fetch_action($action_id);
        if (!$action || !method_exists($action, 'get_group') || $action->get_group() !== self::GROUP
            || !in_array($action->get_hook(), self::hooks(), true)) {
            return null;
        }
        return $action;
    }

    /**
     * یک ردیف برای **هر شکست** (کلید + شناسهٔ سطر AS؛ درج تکراری بی‌اثر)، و شمار = تعداد ردیف‌ها.
     * بازپخش همان شکست شمار را بالا نمی‌برد. `null` = نوشتن یا شمردن شکست خورد، یا ردیف پس از
     * نوشتن نبود — هرگز «صفر» نمی‌شود.
     */
    private static function bump(string $key, int $action_id): ?int
    {
        global $wpdb;
        $done = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '1', 'no')
             ON DUPLICATE KEY UPDATE option_name = option_name",
            self::CRASH_PREFIX . $key . '_' . $action_id
        ));
        if ($done === false) {
            return null;
        }
        $n = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s",
            self::like_prefix(self::CRASH_PREFIX . $key . '_')));
        $ok = (string) ($wpdb->last_error ?? '') === '';
        return $ok && $n !== null && (int) $n > 0 ? (int) $n : null;
    }

    /** `$ok = false` یعنی پرسش خطا داد؛ `null` با `$ok = true` یعنی واقعاً ردیفی نیست. */
    private static function read(string $name, ?bool &$ok = null): ?string
    {
        global $wpdb;
        $v = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name));
        $ok = (string) ($wpdb->last_error ?? '') === '';
        return $v === null ? null : (string) $v;
    }

    private static function clear_rows(string $key): bool
    {
        global $wpdb;
        return $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name IN (%s, %s) OR option_name LIKE %s",
            self::DEAD_PREFIX . $key, self::BUSY_PREFIX . $key, self::like_prefix(self::CRASH_PREFIX . $key . '_'))) !== false;
    }

    /**
     * قفل نام‌دار همان کار منطقی: `e` تغییر صف (کوتاه)، `x` اجرا. `string` = نام قفل گرفته‌شده (برای unlock)، `false` = تا
     * مهلت گرفته نشد، `null` = خطای SQL یا پشتیبانی‌نشده. هر دو حالت غیر `string` یعنی «قفل نیست» و
     * فراخوان وارد بخش محافظت‌شده نمی‌شود. نام شامل پایگاه و پیشوند جدول است، چون قفل نام‌دار در سطح
     * سرور MySQL است نه پایگاه.
     *
     * @return string|false|null
     */
    private static function lock(string $hook, array $args, int $wait, string $kind = 'e')
    {
        global $wpdb;
        $name = 'lmc_q' . $kind . '_' . md5((defined('DB_NAME') ? DB_NAME : '') . '|' . $wpdb->prefix . '|' . self::key($hook, $args));
        if (isset(self::$locks[$name])) {
            self::$locks[$name]++;
            return $name;
        }
        $got = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', $name, $wait));
        if ((string) $got === '1') {
            self::$locks[$name] = 1;
            return $name;
        }
        if ($got === null) {
            lmc_log('قفل نام‌دار پایگاه داده در دسترس نیست (خطای SQL)؛ تغییر صف معوق می‌ماند.');
            return null;
        }
        return false;
    }

    /** @param string|false|null $name */
    private static function unlock($name): void
    {
        if (!is_string($name) || !isset(self::$locks[$name])) {
            return;
        }
        if (--self::$locks[$name] > 0) {
            return;
        }
        unset(self::$locks[$name]);
        global $wpdb;
        $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $name));
    }

    private static function key(string $hook, array $args): string
    {
        // آرگومان‌ها فقط شناسهٔ عددی‌اند؛ همان خروجی wp_json_encode.
        return md5($hook . '|' . json_encode(array_values($args)));
    }
}

/**
 * اجراکنندهٔ اختصاصی گروه بحرانی — اختیاری؛ راهنما در README افزونه.
 *
 *     wp labelmod queue run --loop --max-runtime=300
 *
 * هر دور فقط کار سررسیدهٔ `labelmod-critical` را برمی‌دارد (همان Claim
 * اتمیک)، پس کنار اجراکنندهٔ خودِ Action Scheduler امن است. با پایان
 * `max-runtime` خارج می‌شود تا ناظر (systemd/supervisor) پردازهٔ تازه
 * بسازد: حافظه و اتصال دیتابیس یک پردازهٔ همیشه‌زنده را نمی‌شود به آن
 * سپرد. بی‌کار فقط `idle-ms` می‌خوابد؛ تا کار هست، نمی‌خوابد.
 */
class LMC_Queue_Command
{
    /**
     * ## OPTIONS
     *
     * [--loop]
     * : تا پایان max-runtime ادامه بده.
     *
     * [--batch=<n>]
     * : حداکثر کار در هر دور. پیش‌فرض ۱۰.
     *
     * [--idle-ms=<ms>]
     * : خواب وقتی صف خالی است. پیش‌فرض ۵۰۰.
     *
     * [--max-runtime=<s>]
     * : خروج پس از این مدت. پیش‌فرض ۳۰۰.
     */
    public function run($args, $assoc): void
    {
        $batch = max(1, min(100, (int) ($assoc['batch'] ?? 10)));
        $idle = max(50, min(10000, (int) ($assoc['idle-ms'] ?? 500)));
        $until = microtime(true) + max(1, min(3600, (int) ($assoc['max-runtime'] ?? 300)));
        $total = 0;
        do {
            $done = LMC_Queue::run($batch, 'LMC WP-CLI');
            $total += $done;
            if (function_exists('wp_cache_flush_runtime')) {
                wp_cache_flush_runtime();
            }
            if ($done === 0 && !empty($assoc['loop'])) {
                usleep($idle * 1000);
            }
        } while (!empty($assoc['loop']) && microtime(true) < $until);
        WP_CLI::log(sprintf('labelmod-critical: %d کار اجرا شد.', $total));
    }
}
