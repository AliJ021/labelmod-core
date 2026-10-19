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
    /** نشان کار معوق (قفل صف گرفته نشد): `lmc_qp_<e|r|c>_<کلید>`. */
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
        $lock = self::lock($hook, $args, self::ENQUEUE_LOCK_WAIT);
        if (!is_string($lock)) {
            return self::defer('r', $hook, $args, ['due' => time() + max(0, $delay)]);
        }
        try {
            self::cancel($hook, $args);
            return self::schedule($hook, $args, $delay);
        } finally {
            self::unlock($lock);
        }
    }

    /**
     * تصمیم انسانی («ارسال دوباره»): شمارنده و ثبت مرده پاک می‌شوند. `false` یعنی پاک نشد — ثبت مرده
     * می‌ماند و بازیابی بعدی همان کار را لغو می‌کند، پس فراخوان باید شکست را به انسان نشان دهد.
     */
    public static function forget(string $hook, array $args): bool
    {
        $ok = self::clear_rows(self::key($hook, $args));
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
        if (!is_string($lock)) {
            // مهلت تمام شد یا خطای SQL: بی سریال‌سازی اجرا نمی‌شود؛ BUSY بی شمردن دوباره صفش می‌کند.
            throw new RuntimeException(self::BUSY);
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
        $busy = $error instanceof Throwable && $error->getMessage() === self::BUSY;
        self::recover((int) $action_id, $busy ? 'busy' : ($error instanceof Throwable ? 'exception' : 'failed'));
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
        if (!self::clear_rows(self::key((string) $action->get_hook(), (array) $action->get_args()))) {
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
            // بی قفل نه شمارش نه تصمیم: نشان معوق؛ drain همان تصمیم را زیر قفل می‌گیرد.
            self::defer('c', $hook, $args, ['why' => $why]);
            return;
        }
        try {
            if (!self::recover_locked($hook, $args, $why)) {
                // تصمیم ذخیره نشد (نوشتن وضعیت شکست خورد): نشان معوق تا drain دوباره بکوشد.
                self::defer('c', $hook, $args, ['why' => $why]);
            }
        } finally {
            self::unlock($lock);
        }
    }

    /**
     * تصمیم بازیابی، **فقط زیر قفل صف همان کار**. `true` = تصمیم ماندگار شد (دوباره صف، ثبت مرده،
     * یا کار مرده لغو)؛ `false` = نوشتن وضعیت شکست خورد و هیچ تلاش شمرده‌نشده‌ای صف نشد.
     */
    private static function recover_locked(string $hook, array $args, string $why): bool
    {
        $key = self::key($hook, $args);
        if ($why === 'busy') {
            // اجرای دیگری از همین کار هنوز در جریان است؛ شکست نیست، شمرده نمی‌شود.
            return self::pending($hook, $args) || self::schedule($hook, $args, 30 + random_int(0, 30));
        }
        $dead = self::read(self::DEAD_PREFIX . $key, $ok);
        if (!$ok) {
            return false;
        }
        if ($dead !== null) {
            self::cancel($hook, $args);
            return true;
        }
        $n = self::bump(self::CRASH_PREFIX . $key);
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
        global $wpdb;
        $value = wp_json_encode(['op' => $op, 'hook' => $hook, 'args' => array_values($args), 'at' => time()] + $extra);
        $done = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')
             ON DUPLICATE KEY UPDATE option_name = option_name",
            self::DEFER_PREFIX . $op . '_' . self::key($hook, $args), $value
        ));
        if ($done === false) {
            lmc_log(sprintf('⛔ تغییر صف %s انجام نشد و نشان معوقش هم ذخیره نشد؛ پایگاه داده را بررسی کنید.', $hook));
            return false;
        }
        lmc_log(sprintf('قفل صف %s گرفته نشد؛ کار معوق ذخیره شد و زیر قفل انجام می‌شود.', $hook));
        self::request_kick();
        return true;
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
            if (!in_array($hook, self::hooks(), true) || $args === null || !in_array($op, ['e', 'r', 'c'], true)
                || $name !== self::DEFER_PREFIX . $op . '_' . self::key($hook, $args)) {
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
                $due = max(0, (int) ($d['due'] ?? 0) - time());
                if ($op === 'e') {
                    $ok = self::pending($hook, $args) || self::schedule($hook, $args, $due);
                } elseif ($op === 'r') {
                    self::cancel($hook, $args);
                    $ok = self::schedule($hook, $args, $due);
                } else {
                    $ok = self::recover_locked($hook, $args, (string) ($d['why'] ?? 'deferred'));
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
     * افزایش اتمیک در یک دستور SQL؛ خواندن پس از آن زیر قفل همان کار است. `null` = نوشتن یا
     * خواندن شکست خورد، یا ردیف پس از نوشتن نبود — هرگز «صفر» نمی‌شود.
     */
    private static function bump(string $name): ?int
    {
        global $wpdb;
        $done = $wpdb->query($wpdb->prepare(
            "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '1', 'no')
             ON DUPLICATE KEY UPDATE option_value = option_value + 1",
            $name
        ));
        if ($done === false) {
            return null;
        }
        $v = self::read($name, $ok);
        return $ok && $v !== null && ctype_digit($v) && (int) $v > 0 ? (int) $v : null;
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
        return $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name IN (%s, %s)",
            self::CRASH_PREFIX . $key, self::DEAD_PREFIX . $key)) !== false;
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
