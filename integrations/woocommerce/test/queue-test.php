<?php
/**
 * صف بحرانی (LMC_Queue) — بی وردپرس، با Action Scheduler جعلیِ درون‌حافظه.
 *
 * سفارش جعلی دو حالت دارد: آنچه در حافظهٔ همین درخواست است و آنچه `save()`
 * نوشته. `wc_get_order` فقط دومی را می‌خواند — مثل اجراکنندهٔ صف در پردازهٔ
 * دیگر. پس «کار پیش از ذخیرهٔ متا صف شد» اینجا دیده می‌شود.
 *
 * رفتار واقعی Action Scheduler (Claim، failed، کشته‌شدن پردازه) روی
 * ووکامرس واقعی در test/real-wc/run_queue.py سنجیده می‌شود.
 *
 *     php integrations/woocommerce/test/queue-test.php
 */
define('ABSPATH', __DIR__);
define('LMC_ORDER_EVENT', 'lmc_send_order');
define('MINUTE_IN_SECONDS', 60);

$GLOBALS['hooks'] = [];
function add_action($hook, $cb, $priority = 10, $args = 1) { $GLOBALS['hooks'][$hook][] = $cb; }
function add_filter($hook, $cb, $priority = 10, $args = 1) { $GLOBALS['hooks'][$hook][] = $cb; }
function do_action($hook, ...$args) { foreach ($GLOBALS['hooks'][$hook] ?? [] as $cb) { $cb(...$args); } }

$GLOBALS['cron'] = [];
function wp_next_scheduled($hook, $args = []) {
    foreach ($GLOBALS['cron'] as $e) { if ($e['hook'] === $hook && $e['args'] === $args) { return $e['at']; } }
    return false;
}
function wp_schedule_single_event($at, $hook, $args = []) {
    if (!empty($GLOBALS['cron_fail'])) { return false; }
    $GLOBALS['cron'][] = ['at' => $at, 'hook' => $hook, 'args' => $args];
    return true;
}
function wp_clear_scheduled_hook($hook, $args = []) {
    $GLOBALS['cron'] = array_values(array_filter($GLOBALS['cron'], fn($e) => !($e['hook'] === $hook && $e['args'] === $args)));
}
$GLOBALS['options'] = [];
function get_option($k, $d = false) { return $GLOBALS['options'][$k] ?? $d; }
function update_option($k, $v, $autoload = null) { $GLOBALS['options'][$k] = $v; return true; }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
$GLOBALS['log'] = [];
function lmc_log($m) { $GLOBALS['log'][] = $m; }
function lmc_setting($k, $d = '') { return $k === 'currency_unit' ? 'toman' : $d; }
function current_user_can($c) { return true; }
function is_wp_error($x) { return $x instanceof WP_Error; }

class WP_Error {
    public function __construct(public $code = '', public $message = '', public $data = null) {}
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
    public function get_error_data() { return $this->data; }
}

// ── Action Scheduler جعلی: سطر جدا برای هر کار، Claim و وضعیت ─────────
class ActionScheduler_Store { const STATUS_PENDING = 'pending'; }
$GLOBALS['as'] = [];
$GLOBALS['as_fail'] = false;
$GLOBALS['as_on_add'] = null;
function as_add($at, $hook, $args, $group) {
    if ($GLOBALS['as_fail']) { return 0; }
    $id = count($GLOBALS['as']) + 1;
    $GLOBALS['as'][$id] = ['hook' => $hook, 'args' => $args, 'group' => $group, 'at' => $at, 'status' => 'pending', 'claim' => 0];
    if ($GLOBALS['as_on_add']) { ($GLOBALS['as_on_add'])($id); }
    return $id;
}
function as_enqueue_async_action($hook, $args = [], $group = '') { return as_add(null, $hook, $args, $group); }
function as_schedule_single_action($at, $hook, $args = [], $group = '') { return as_add($at, $hook, $args, $group); }
function as_match($a, $q) {
    return (!isset($q['hook']) || $a['hook'] === $q['hook']) && (!isset($q['args']) || $a['args'] === $q['args'])
        && (!isset($q['group']) || $a['group'] === $q['group']);
}
function as_get_scheduled_actions($q, $ret = 'ids') {
    $out = [];
    foreach ($GLOBALS['as'] as $id => $a) {
        if (as_match($a, $q) && (!isset($q['status']) || $a['status'] === $q['status'])) { $out[] = $id; }
    }
    return array_slice($out, 0, $q['per_page'] ?? 5);
}
function as_has_scheduled_action($hook, $args = null, $group = '') {
    foreach ($GLOBALS['as'] as $a) {
        if (as_match($a, ['hook' => $hook, 'args' => $args, 'group' => $group]) && in_array($a['status'], ['pending', 'in-progress'], true)) { return true; }
    }
    return false;
}
function as_unschedule_all_actions($hook, $args = [], $group = '') {
    foreach ($GLOBALS['as'] as $id => $a) {
        if ($a['status'] === 'pending' && as_match($a, ['hook' => $hook, 'args' => $args, 'group' => $group])) { $GLOBALS['as'][$id]['status'] = 'canceled'; }
    }
}
class FakeAction {
    public function __construct(public $row) {}
    public function get_hook() { return $this->row['hook']; }
    public function get_args() { return $this->row['args']; }
    public function get_group() { return $this->row['group']; }
}
class FakeClaim {
    public function __construct(public $id, public $ids) {}
    public function get_id() { return $this->id; }
    public function get_actions() { return $this->ids; }
}
class FakeStore {
    public $claims = 0;
    public function stake_claim($max, $before = null, $hooks = [], $group = '') {
        $claim = ++$this->claims; $ids = [];
        foreach ($GLOBALS['as'] as $id => $a) {
            if (count($ids) >= $max) { break; }
            if ($a['status'] === 'pending' && $a['claim'] === 0 && ($group === '' || $a['group'] === $group)
                && ($a['at'] === null || $a['at'] <= time())) {
                $GLOBALS['as'][$id]['claim'] = $claim; $ids[] = $id;
            }
        }
        return new FakeClaim($claim, $ids);
    }
    public function get_claim_id($id) { return $GLOBALS['as'][$id]['claim']; }
    public function release_claim($claim) { foreach ($claim->get_actions() as $id) { $GLOBALS['as'][$id]['claim'] = 0; } }
    public function fetch_action($id) { return isset($GLOBALS['as'][$id]) ? new FakeAction($GLOBALS['as'][$id]) : null; }
}
class FakeRunner {
    /** همان ترتیب ActionScheduler_Abstract_QueueRunner::process_action (AS 4.0.0). */
    public function process_action($id, $context = '') {
        try {
            do_action('action_scheduler_before_execute', $id, $context);
            if ($GLOBALS['as'][$id]['status'] !== 'pending') { do_action('action_scheduler_execution_ignored', $id, $context); return; }
            $GLOBALS['as'][$id]['status'] = 'in-progress';
            $action = new FakeAction($GLOBALS['as'][$id]);
            do_action($action->get_hook(), ...array_values($action->get_args()));
            do_action('action_scheduler_after_execute', $id, $action, $context);
            $GLOBALS['as'][$id]['status'] = 'complete';
        } catch (Throwable $e) {
            $GLOBALS['as'][$id]['status'] = 'failed';
            do_action('action_scheduler_failed_execution', $id, $e, $context);
        }
    }
}

/**
 * $wpdb جعلی: قفل نام‌دار با «صاحب پردازه» (`me`) و ردیف‌های `wp_options` صف. فقط همان
 * پرسش‌هایی که LMC_Queue می‌سازد؛ رقابت واقعی میان پردازه‌ها در test/real-wc/run_queue_race.py است.
 */
$GLOBALS['wpdb'] = new class {
    public $prefix = 'wp_'; public $options = 'wp_options';
    public array $rows = []; public array $locks = []; public string $me = 'p1'; public array $log = []; public int $denied = 0;
    public function prepare($q, ...$a) {
        $i = 0;
        return preg_replace_callback('/%[sd]/', function ($m) use (&$i, $a) {
            $v = $a[$i++]; return $m[0] === '%d' ? (string) (int) $v : "'" . addslashes((string) $v) . "'";
        }, $q);
    }
    public function get_var($q) {
        $this->log[] = $q;
        if (preg_match("/GET_LOCK\\('([^']+)', \\d+\\)/", $q, $m)) {
            $o = $this->locks[$m[1]] ?? null;
            if ($o === null || $o === $this->me) { $this->locks[$m[1]] = $this->me; return '1'; }
            $this->denied++;
            return '0';
        }
        if (preg_match("/RELEASE_LOCK\\('([^']+)'\\)/", $q, $m)) {
            if (($this->locks[$m[1]] ?? null) === $this->me) { unset($this->locks[$m[1]]); return '1'; }
            return '0';
        }
        if (preg_match("/SELECT option_value FROM wp_options WHERE option_name = '([^']+)'/", $q, $m)) { return $this->rows[$m[1]] ?? null; }
        if (str_contains($q, 'COUNT(*)')) { return (string) count(array_filter(array_keys($this->rows), fn($k) => str_starts_with($k, 'lmc_qd_'))); }
        return null;
    }
    public function query($q) {
        $this->log[] = $q;
        if (preg_match("/VALUES \\('([^']+)', '1', 'no'\\)\\s+ON DUPLICATE KEY UPDATE option_value = option_value \\+ 1/", $q, $m)) {
            $this->rows[$m[1]] = (string) ((int) ($this->rows[$m[1]] ?? 0) + 1); return 1;
        }
        if (preg_match("/VALUES \\('([^']+)', '(.*)', 'no'\\)\\s+ON DUPLICATE KEY UPDATE option_value = /s", $q, $m)) {
            $this->rows[$m[1]] = stripslashes($m[2]); return 1;
        }
        if (preg_match("/DELETE FROM wp_options WHERE option_name IN \\('([^']+)', '([^']+)'\\)/", $q, $m)) {
            unset($this->rows[$m[1]], $this->rows[$m[2]]); return 1;
        }
        return 1;
    }
};
function crash_rows() { return array_filter($GLOBALS['wpdb']->rows, fn($k) => str_starts_with($k, 'lmc_qc_'), ARRAY_FILTER_USE_KEY); }
function dead_rows() { return array_map(fn($v) => json_decode($v, true), array_filter($GLOBALS['wpdb']->rows, fn($k) => str_starts_with($k, 'lmc_qd_'), ARRAY_FILTER_USE_KEY)); }
class ActionScheduler {
    public static $store, $runner;
    public static function is_initialized($f = null) { return true; }
    public static function store() { return self::$store ??= new FakeStore(); }
    public static function runner() { return self::$runner ??= new FakeRunner(); }
}

// ── سفارش با «حافظهٔ درخواست» جدا از «ذخیره‌شده» ─────────────────────
$GLOBALS['db'] = [];
class WC_Order_Item_Product {
    public function __construct(public $qty, public $original = 0) {}
    public function get_quantity() { return $this->qty; }
    public function get_meta($k) { return $this->original; }
}
class WC_Order {
    public $meta = []; public $items = []; public $notes = [];
    public function __construct(public $id) {}
    public function get_id() { return $this->id; }
    public function get_meta($k) { return $this->meta[$k] ?? ''; }
    public function update_meta_data($k, $v) { $this->meta[$k] = $v; }
    public function delete_meta_data($k) { unset($this->meta[$k]); }
    public function save() { $GLOBALS['db'][$this->id] = clone $this; }
    public function get_items() { return $this->items; }
    public function add_order_note($n) { $this->notes[] = $n; }
    public function has_status($s) { return true; }
}
class WC_Order_Refund extends WC_Order {
    public $parent = 100; public $amount = 22000; public $shipping = 0;
    public function get_parent_id() { return $this->parent; }
    public function get_amount() { return $this->amount; }
    public function get_shipping_total() { return $this->shipping; }
}
function wc_get_order($id) { return isset($GLOBALS['db'][$id]) ? clone $GLOBALS['db'][$id] : false; }

require __DIR__ . '/../labelmod-connector/includes/class-lmc-client.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-queue.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-order-sync.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-order-reservation.php';
require __DIR__ . '/../labelmod-connector/includes/class-lmc-refund-sync.php';

$checks = 0;
function check($ok, $label) { global $checks; if (!$ok) { fwrite(STDERR, "FAIL: $label\n"); exit(1); } $checks++; }
function reset_queue() {
    $GLOBALS['as'] = []; $GLOBALS['cron'] = []; $GLOBALS['options'] = []; $GLOBALS['log'] = [];
    $GLOBALS['wpdb']->rows = []; $GLOBALS['wpdb']->locks = []; $GLOBALS['wpdb']->me = 'p1'; $GLOBALS['wpdb']->log = []; $GLOBALS['wpdb']->denied = 0;
    $GLOBALS['as_fail'] = false; $GLOBALS['cron_fail'] = false; $GLOBALS['as_on_add'] = null;
}
function pending_rows($hook, $args) {
    return array_values(array_filter($GLOBALS['as'], fn($a) => $a['hook'] === $hook && $a['args'] === $args && $a['status'] === 'pending'));
}
LMC_Queue::init();

// ۱. فوری و ماندگار: سطر Action Scheduler بی تأخیر، گروه بحرانی، و kick همین حالا.
reset_queue();
$o = new WC_Order(7); $o->save();
$seen_paid = null;
$GLOBALS['as_on_add'] = function ($id) use (&$seen_paid) { $seen_paid = wc_get_order(7)->get_meta(LMC_Order_Sync::META_PAID); };
$before = time();
LMC_Order_Sync::payment_complete(7);
$rows = pending_rows(LMC_ORDER_EVENT, [7]);
check(count($rows) === 1 && $rows[0]['at'] === null, 'پرداخت: یک کار async بی تأخیر ثابت');
check($rows[0]['group'] === LMC_Queue::GROUP, 'پرداخت: گروه labelmod-critical');
check($seen_paid === 'yes', 'پرداخت: نشان پرداخت پیش از درج کار ذخیره شده است (پردازهٔ دیگر می‌بیندش)');
$kick = wp_next_scheduled(LMC_Queue::KICK);
check($kick !== false && $kick >= $before && $kick <= time(), 'kick برای همین لحظه، نه +۱۰ ثانیه');
check(wp_next_scheduled(LMC_ORDER_EVENT, [7]) === false, 'خودِ کار در WP-Cron نیست');

// ۲. تکرار اعلان پرداخت کار دوم نمی‌سازد.
LMC_Order_Sync::payment_complete(7);
check(count(pending_rows(LMC_ORDER_EVENT, [7])) === 1, 'تکرار: همان یک کار معلق');

// ۳. اجرای جاری می‌تواند تلاش بعدی خودش را صف کند (کارِ in-progress «معلق» نیست).
reset_queue();
$id = as_enqueue_async_action('lmc_send_refund', [55], LMC_Queue::GROUP);
$GLOBALS['as'][$id]['status'] = 'in-progress';
check(LMC_Queue::pending('lmc_send_refund', [55]) === false, 'in-progress معلق شمرده نمی‌شود');
LMC_Queue::enqueue('lmc_send_refund', [55], 120);
$rows = pending_rows('lmc_send_refund', [55]);
check(count($rows) === 1 && $rows[0]['at'] >= time() + 119, 'تلاش بعدی حین اجرا گم نمی‌شود');
check(LMC_Queue::queued('lmc_send_refund', [55]), 'گزارش: صف‌شده');

// ۴. reschedule: کار فوریِ صف‌شده حین HTTP جای Backoff را نمی‌گیرد.
reset_queue();
LMC_Queue::enqueue(LMC_ORDER_EVENT, [8]);
wp_schedule_single_event(time(), LMC_ORDER_EVENT, [8]); // رویداد WP-Cron مانده از نسخهٔ پیش از ارتقا
LMC_Queue::reschedule(LMC_ORDER_EVENT, [8], 240);
$rows = pending_rows(LMC_ORDER_EVENT, [8]);
check(count($rows) === 1 && $rows[0]['at'] >= time() + 239, 'reschedule: فقط Backoff می‌ماند');
check(wp_next_scheduled(LMC_ORDER_EVENT, [8]) === false, 'reschedule: رویداد قدیمی WP-Cron هم برداشته شد');
LMC_Queue::cancel(LMC_ORDER_EVENT, [8]);
check(pending_rows(LMC_ORDER_EVENT, [8]) === [], 'cancel: خطای نهایی هیچ کار معلقی باقی نمی‌گذارد');

// ۵. Backoff: نمایی، jitter برابر، سقف؛ Retry-After کف است و خودش سقف دارد.
for ($attempt = 1; $attempt <= 8; $attempt++) {
    $exp = min(3600, 60 * (2 ** ($attempt - 1)));
    $seen = []; $inside = true;
    for ($i = 0; $i < 300; $i++) {
        $d = LMC_Queue::retry_delay($attempt);
        $inside = $inside && $d >= intdiv($exp, 2) && $d <= $exp;
        $seen[$d] = true;
    }
    check($inside, "Backoff تلاش $attempt در [نیمه، کامل] (۳۰۰ نمونه)");
    check(count($seen) > 5, "Backoff تلاش $attempt واقعاً jitter دارد");
}
check(LMC_Queue::retry_delay(1, new WP_Error('x', 'y', ['retry_after' => 900])) >= 900, 'Retry-After کف تأخیر');
check(LMC_Queue::retry_delay(1, new WP_Error('x', 'y', ['retry_after' => 99999])) === 3600, 'Retry-After سقف دارد');
check(LMC_Queue::retry_delay(1000) <= 3600, 'تلاش بزرگ سرریز نمی‌کند');
check(LMC_Client::retry_after('120') === 120, 'Retry-After ثانیه');
$future = LMC_Client::retry_after(gmdate('D, d M Y H:i:s', time() + 300) . ' GMT');
check($future !== null && $future >= 298 && $future <= 300, 'Retry-After تاریخ HTTP');
check(LMC_Client::retry_after('soon') === null && LMC_Client::retry_after('') === null, 'Retry-After بدشکل = نگفته');
check(LMC_Client::retry_after('999999999') === 86400, 'Retry-After ثانیه سقف دارد');

// ۶. شکست غیرمنتظره: دوباره صف تا سقف، بعد فهرست مرده؛ اجرای سالم شمارنده را صفر می‌کند.
reset_queue();
$crash = 0;
$GLOBALS['hooks']['lmc_send_refund'] = [function ($id) use (&$crash) { $crash++; throw new RuntimeException('DB رفت'); }];
LMC_Queue::enqueue('lmc_send_refund', [9]);
for ($round = 1; $round <= LMC_Queue::MAX_CRASHES; $round++) {
    foreach ($GLOBALS['as'] as $aid => $a) { if ($a['status'] === 'pending') { $GLOBALS['as'][$aid]['at'] = null; } } // موعد Backoff رسید
    check(LMC_Queue::run(10, 'test') === 1, "شکست $round: کار برداشته و اجرا شد");
    $pending = pending_rows('lmc_send_refund', [9]);
    if ($round < LMC_Queue::MAX_CRASHES) {
        check(count($pending) === 1 && $pending[0]['at'] >= time() + 1 && $pending[0]['at'] <= time() + 5 * (2 ** ($round - 1)),
            "شکست $round: با Backoff کوتاه (پایهٔ ۵ ثانیه) دوباره صف شد");
    } else {
        check($pending === [], 'سقف: دیگر دوباره صف نمی‌شود');
    }
}
check($crash === LMC_Queue::MAX_CRASHES, 'دقیقاً MAX_CRASHES اجرا');
$dead = array_values(dead_rows());
check(count($dead) === 1 && $dead[0]['hook'] === 'lmc_send_refund' && $dead[0]['args'] === [9] && $dead[0]['crashes'] === 3, 'مرده ثبت شد');
check(LMC_Queue::health()['deadTasks'] === 1 && LMC_Queue::health()['backend'] === 'action-scheduler', 'تشخیص: مرده دیده می‌شود');
check(LMC_Queue::health()['deadScope'] === 'unexpected_failure_only', 'تشخیص: فقط شکست غیرمنتظره، نه توقف کسب‌وکاری');
check(count($GLOBALS['log']) === 1, 'مرده در لاگ هم هست');
check($GLOBALS['wpdb']->locks === [], 'هیچ قفلی پس از اجراها نمانده است');
// کار مرده با شکست بعدی (مثلاً سطر تکراری که پیش‌تر صف شده بود) دوباره صف نمی‌شود و شمارنده صفر نمی‌شود.
$dup = as_enqueue_async_action('lmc_send_refund', [9], LMC_Queue::GROUP);
LMC_Queue::run(10, 'test');
check($GLOBALS['as'][$dup]['status'] === 'failed' && pending_rows('lmc_send_refund', [9]) === [], 'مرده مرده می‌ماند: شکست بعدی صف نمی‌سازد');
check(array_values(crash_rows()) === ['3'], 'شمارندهٔ کار مرده صفر نشد');
LMC_Queue::forget('lmc_send_refund', [9]);
check(crash_rows() === [] && dead_rows() === [], 'تصمیم انسانی شمارنده و ثبت مرده را پاک می‌کند');

reset_queue();
$fail_once = true;
$GLOBALS['hooks']['lmc_send_refund'] = [function ($id) use (&$fail_once) { if ($fail_once) { $fail_once = false; throw new RuntimeException('x'); } }];
LMC_Queue::enqueue('lmc_send_refund', [10]);
LMC_Queue::run(10, 'test');
check(array_values(crash_rows()) === ['1'], 'یک شکست شمرده شد');
foreach ($GLOBALS['as'] as $aid => $a) { if ($a['status'] === 'pending') { $GLOBALS['as'][$aid]['at'] = null; } }
LMC_Queue::run(10, 'test');
check(crash_rows() === [], 'اجرای سالم شمارنده را صفر کرد');

// ۶ب. شمارندهٔ هر کار جداست: شکست‌های درهم‌آمیختهٔ دو کار یکدیگر را پاک نمی‌کنند و هر کدام در سومین مرده است.
reset_queue();
$GLOBALS['hooks']['lmc_send_refund'] = [function () { throw new RuntimeException('x'); }];
foreach ([[21], [22], [21], [22], [21], [22]] as $args) {
    $aid = as_enqueue_async_action('lmc_send_refund', $args, LMC_Queue::GROUP);
    ActionScheduler::runner()->process_action($aid, 'test');
}
$byArg = []; foreach (dead_rows() as $d) { $byArg[$d['args'][0]] = $d['crashes']; }
check($byArg === [21 => 3, 22 => 3], 'دو کار درهم: هر دو دقیقاً در سومین شکست مرده');

// ۶ج. قفل اجرا: سطر دوم همان کار وقتی پردازهٔ دیگری قفل را دارد اجرا نمی‌شود (BUSY)، شمرده نمی‌شود و بعداً دوباره صف است.
reset_queue();
$ran = 0;
$GLOBALS['hooks']['lmc_send_refund'] = [function () use (&$ran) { $ran++; }];
$aid = as_enqueue_async_action('lmc_send_refund', [31], LMC_Queue::GROUP);
// پردازهٔ دیگر (p2) قفل همین کار را دارد — همان نام قفل LMC_Queue (پایگاه، پیشوند، کلید).
$GLOBALS['wpdb']->locks['lmc_qx_' . md5('|wp_|' . md5('lmc_send_refund|[31]'))] = 'p2';
// قفل اجرای پردازهٔ دیگر «صف کن» همان کار را منتظر نمی‌گذارد (Callback پرداخت در Checkout).
$deniedBefore = $GLOBALS['wpdb']->denied;
check(LMC_Queue::enqueue('lmc_send_refund', [31]) === true && count(pending_rows('lmc_send_refund', [31])) === 1
    && $GLOBALS['wpdb']->denied === $deniedBefore, 'قفل اجرا صف‌کردن را نمی‌بندد (قفل صف جداست و منتظر نماند)');
LMC_Queue::cancel('lmc_send_refund', [31]);
ActionScheduler::runner()->process_action($aid, 'test');
check($ran === 0 && $GLOBALS['as'][$aid]['status'] === 'failed', 'قفل گرفته: Handler اجرا نشد');
$busy = pending_rows('lmc_send_refund', [31]);
check(count($busy) === 1 && $busy[0]['at'] >= time() + 30 && crash_rows() === [], 'BUSY: بی شمردن، با تأخیر ۳۰ تا ۶۰ ثانیه دوباره صف');

// ۶د. قفل «صف کن»: پرسش «معلق هست؟» و درج زیر قفل همان کار است، و قفل آزاد می‌شود.
reset_queue();
LMC_Queue::enqueue('lmc_send_refund', [41]);
$log = implode("\n", $GLOBALS['wpdb']->log);
check(preg_match('/GET_LOCK.*\\n.*RELEASE_LOCK/s', $log) === 1 && $GLOBALS['wpdb']->locks === [], 'enqueue: GET_LOCK … RELEASE_LOCK');

// ۷. فقط کارهای خودِ صف: گروه یا Hook دیگر دوباره صف نمی‌شوند و run گروه دیگر را برنمی‌دارد.
reset_queue();
$GLOBALS['hooks']['other_hook'] = [function () { throw new RuntimeException('x'); }];
$foreign = as_enqueue_async_action('other_hook', [1], 'other-group');
$GLOBALS['hooks']['lmc_send_refund'] = [function () { throw new RuntimeException('x'); }];
$sameGroupForeign = as_enqueue_async_action('other_hook', [2], LMC_Queue::GROUP);
check(LMC_Queue::run(10, 'test') === 1, 'run فقط گروه بحرانی را برمی‌دارد');
check($GLOBALS['as'][$foreign]['status'] === 'pending', 'کار گروه دیگر دست نخورد');
check(count($GLOBALS['as']) === 2, 'Hook بیگانه در گروه دوباره صف نشد');

// ۸. شکست ذخیرهٔ Action Scheduler → WP-Cron؛ شکست هر دو → مرده و لاگ، نه سکوت.
reset_queue();
$GLOBALS['as_fail'] = true;
check(LMC_Queue::enqueue(LMC_ORDER_EVENT, [11]) === true, 'جایگزین WP-Cron پذیرفت');
$fallback = wp_next_scheduled(LMC_ORDER_EVENT, [11]);
check($fallback !== false && $fallback <= time(), 'جایگزین هم بی تأخیر ثابت است');
$GLOBALS['cron'] = []; $GLOBALS['cron_fail'] = true;
check(LMC_Queue::enqueue(LMC_ORDER_EVENT, [12]) === false, 'هیچ صفی نگرفت');
check(array_values(dead_rows())[0]['reason'] === 'enqueue_failed', 'شکست صف ثبت شد');

// ۹. مرجوعی: کار پس از ذخیرهٔ Payload صف می‌شود (اجراکنندهٔ فوری Payload را می‌بیند).
reset_queue();
$parent = new WC_Order(100);
$parent->items = [501 => new WC_Order_Item_Product(2)];
$parent->meta[LMC_Order_Sync::META_PAYLOAD] = ['externalId' => '100', 'lines' => [['sku' => 'S', 'qty' => '2', 'unitPrice' => '1000']]];
$parent->meta[LMC_Order_Sync::META_LINES] = [501 => 1];
$parent->save();
$refund = new WC_Order_Refund(101);
$refund->items = [new WC_Order_Item_Product(-1, 501)];
$refund->save();
$payload_seen = null;
$GLOBALS['as_on_add'] = function ($aid) use (&$payload_seen) {
    if ($GLOBALS['as'][$aid]['hook'] === LMC_Refund_Sync::EVENT) {
        $payload_seen = wc_get_order(101)->get_meta(LMC_Refund_Sync::PAYLOAD);
    }
};
LMC_Refund_Sync::created(101, ['restock_items' => true]);
check(is_array($payload_seen) && $payload_seen['refundId'] === '101', 'مرجوعی: Payload پیش از درج کار ذخیره شده است');
check(count(pending_rows(LMC_Refund_Sync::EVENT, [101])) === 1, 'مرجوعی: یک کار فوری');

// بی Action Scheduler (WP-Cron جایگزین) در payload/reservation/refund-test سنجیده می‌شود: آنجا as_* تعریف نشده است.

echo "OK: $checks queue assertions\n";
