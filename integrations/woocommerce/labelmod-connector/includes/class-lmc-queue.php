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
 */

if (!defined('ABSPATH')) {
    exit;
}

class LMC_Queue
{
    const GROUP = 'labelmod-critical';
    /** شتاب‌دهنده: رویداد WP-Cron که فقط گروه بحرانی را می‌راند. */
    const KICK = 'lmc_queue_kick';
    const CRASHES = 'lmc_queue_crashes';
    const DEAD = 'lmc_queue_dead';
    /** شکست غیرمنتظرهٔ پیاپی تا ثبت در فهرست مرده. */
    const MAX_CRASHES = 3;
    const DEAD_KEEP = 50;
    const KICK_BATCH = 10;

    /** فقط این رویدادها مال این صف‌اند؛ هیچ کار دیگری در گروه دوباره صف نمی‌شود. */
    public static function hooks(): array
    {
        return [LMC_ORDER_EVENT, LMC_Order_Reservation::EVENT, LMC_Refund_Sync::EVENT];
    }

    public static function init(): void
    {
        add_action(self::KICK, [__CLASS__, 'kick']);
        add_action('action_scheduler_failed_execution', [__CLASS__, 'on_failed_execution'], 10, 2);
        add_action('action_scheduler_failed_action', [__CLASS__, 'on_failed'], 10, 1);
        add_action('action_scheduler_unexpected_shutdown', [__CLASS__, 'on_failed'], 10, 1);
        add_action('action_scheduler_after_execute', [__CLASS__, 'on_executed'], 10, 2);
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
        if (self::pending($hook, $args)) {
            return true;
        }
        return self::schedule($hook, $args, $delay);
    }

    /**
     * نتیجهٔ همین اجرا جای هر کار معلقی را می‌گیرد که حین HTTP صف شده بود:
     * Backoff کامل می‌ماند و کارِ پیشِ‌رس آن را دور نمی‌زند.
     */
    public static function reschedule(string $hook, array $args, int $delay): bool
    {
        self::cancel($hook, $args);
        return self::schedule($hook, $args, $delay);
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
            // هیچ صفی کار را نگرفت: گم نمی‌شود، دیده می‌شود.
            self::record_dead($hook, $args, 'enqueue_failed');
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

    public static function on_failed_execution($action_id, $error = null): void
    {
        self::recover((int) $action_id, $error instanceof Throwable ? 'exception' : 'failed');
    }

    public static function on_failed($action_id): void
    {
        self::recover((int) $action_id, 'timeout_or_shutdown');
    }

    /** اجرای بی‌استثنا شمارندهٔ شکست غیرمنتظره را صفر می‌کند (نتیجهٔ کسب‌وکار جداست). */
    public static function on_executed($action_id, $action = null): void
    {
        if (!is_object($action) || !method_exists($action, 'get_group') || $action->get_group() !== self::GROUP) {
            return;
        }
        $crashes = get_option(self::CRASHES, []);
        $key = self::key((string) $action->get_hook(), (array) $action->get_args());
        if (is_array($crashes) && isset($crashes[$key])) {
            unset($crashes[$key]);
            update_option(self::CRASHES, $crashes, false);
        }
    }

    /**
     * شکست غیرمنتظره: Action Scheduler کار را failed می‌کند و خودش دوباره
     * صف نمی‌کند. اینجا تا سقف دوباره صف می‌شود؛ بعد از آن مرده و دیدنی.
     */
    private static function recover(int $action_id, string $why): void
    {
        if ($action_id <= 0 || !self::action_scheduler()) {
            return;
        }
        $action = ActionScheduler::store()->fetch_action($action_id);
        if (!$action || !method_exists($action, 'get_group') || $action->get_group() !== self::GROUP
            || !in_array($action->get_hook(), self::hooks(), true)) {
            return;
        }
        $hook = (string) $action->get_hook();
        $args = (array) $action->get_args();
        $key = self::key($hook, $args);
        $crashes = get_option(self::CRASHES, []);
        $crashes = is_array($crashes) ? $crashes : [];
        $n = (int) ($crashes[$key] ?? 0) + 1;
        if ($n >= self::MAX_CRASHES) {
            unset($crashes[$key]);
            update_option(self::CRASHES, $crashes, false);
            self::record_dead($hook, $args, $why);
            return;
        }
        $crashes[$key] = $n;
        update_option(self::CRASHES, $crashes, false);
        // پایهٔ کوتاه (۵ ثانیه با jitter): رایج‌ترین شکست غیرمنتظره روی MariaDB واقعی بن‌بست InnoDB
        // در `log_execution` خودِ Action Scheduler بود — پیش از اجرای Handler — وقتی دو اجراکننده
        // هم‌زمان Claim می‌کنند. با پایهٔ ۶۰ ثانیه همان سفارش ~۵۰ ثانیه عقب می‌افتاد.
        if (!self::pending($hook, $args)) {
            self::schedule($hook, $args, self::retry_delay($n, null, 5, 300));
        }
    }

    private static function record_dead(string $hook, array $args, string $why): void
    {
        $dead = get_option(self::DEAD, []);
        $dead = is_array($dead) ? $dead : [];
        $dead[] = ['hook' => $hook, 'args' => array_values($args), 'reason' => $why, 'at' => gmdate('c')];
        update_option(self::DEAD, array_slice($dead, -self::DEAD_KEEP), false);
        lmc_log(sprintf('کار %s متوقف شد (%s)؛ بررسی دستی و «ارسال دوباره» لازم است.', $hook, $why));
    }

    /** برای تشخیص اتصال؛ هیچ داده‌ای از سفارش در آن نیست. */
    public static function health(): array
    {
        $dead = get_option(self::DEAD, []);
        return [
            'backend' => self::action_scheduler() ? 'action-scheduler' : 'wp-cron',
            'group' => self::GROUP,
            'dead' => is_array($dead) ? count($dead) : 0,
        ];
    }

    private static function key(string $hook, array $args): string
    {
        return md5($hook . '|' . wp_json_encode(array_values($args)));
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
