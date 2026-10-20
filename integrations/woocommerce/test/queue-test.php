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
define('ARRAY_A', 'ARRAY_A');

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
function as_get_datetime_object($s = null) { return new DateTime('@' . time()); }
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
    // مرگ پردازه میان نوشتن‌ها (۱۲ب): پس از نوشتنِ پیشاپیشِ تصمیم و پیش از هر تغییر صف.
    if (!empty($GLOBALS['crash_on_cancel'])) { throw new RuntimeException('process died'); }
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
    public function query_actions($q, $ret = 'ids') {
        // شکست شبیه‌سازی‌شدهٔ یک شمارش (۱۳ب): فقط وضعیت‌های نام‌برده.
        if (in_array($q['status'] ?? '', $GLOBALS['as_query_fail'] ?? [], true)) { throw new RuntimeException('store down'); }
        // `date`/`date_compare` مثل ActionScheduler_DBStore روی زمان سررسید؛ کار async (`at` تهی) سررسیده است.
        $when = fn($a) => $a['at'] ?? 0;
        $date = isset($q['date']) ? $q['date']->getTimestamp() : null;
        $ids = array_keys(array_filter($GLOBALS['as'], fn($a) => $a['group'] === ($q['group'] ?? $a['group']) && $a['status'] === ($q['status'] ?? $a['status'])
            && ($date === null || (($q['date_compare'] ?? '<=') === '<=' ? $when($a) <= $date : $when($a) > $date))));
        return $ret === 'count' ? count($ids) : $ids;
    }
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
    public string $last_error = '';
    /** تزریق شکست: الگوهای Regex روی متن پرسش؛ نوشتنِ منطبق false و خواندنِ منطبق خطای SQL می‌گیرد. */
    public array $fail_write = []; public array $fail_read = []; public bool $lock_error = false;
    /** خطای SQL فقط برای نام‌های قفل منطبق (مثلاً فقط قفل اجرا)، و کالبکی که هنگام گرفتن قفل اجرا می‌شود (درهم‌آمیزی). */
    public ?string $lock_error_re = null; public $on_lock = null;
    private function failing(array $patterns, string $q): bool {
        foreach ($patterns as $re) { if (preg_match($re, $q)) { return true; } }
        return false;
    }
    public function prepare($q, ...$a) {
        $i = 0;
        $q = preg_replace_callback('/%[sd%]/', function ($m) use (&$i, $a) {
            if ($m[0] === '%%') { return '%'; }
            $v = $a[$i++]; return $m[0] === '%d' ? (string) (int) $v : "'" . addslashes((string) $v) . "'";
        }, $q);
        return $q;
    }
    public function get_var($q) {
        $this->log[] = $q; $this->last_error = '';
        if (preg_match("/GET_LOCK\\('([^']+)', \\d+\\)/", $q, $m)) {
            if ($this->lock_error || ($this->lock_error_re && preg_match($this->lock_error_re, $m[1]))) { $this->last_error = 'lock service gone'; return null; }
            $o = $this->locks[$m[1]] ?? null;
            if ($o === null || $o === $this->me) {
                $this->locks[$m[1]] = $this->me;
                if ($this->on_lock) { $cb = $this->on_lock; $this->on_lock = null; $cb($m[1]); }
                return '1';
            }
            $this->denied++;
            return '0';
        }
        if (preg_match("/RELEASE_LOCK\\('([^']+)'\\)/", $q, $m)) {
            if (($this->locks[$m[1]] ?? null) === $this->me) { unset($this->locks[$m[1]]); return '1'; }
            return '0';
        }
        if ($this->failing($this->fail_read, $q)) { $this->last_error = 'injected read failure'; return null; }
        if (preg_match("/SELECT option_value FROM wp_options WHERE option_name = '([^']+)'/", $q, $m)) { return $this->rows[$m[1]] ?? null; }
        if (preg_match("/COUNT\\(\\*\\).*LIKE '((?:[^'\\\\]|\\\\.)*)'/s", $q, $m)) { return (string) count($this->like($m[1])); }
        return null;
    }
    public function esc_like($t) { return addcslashes($t, '_%\\'); }
    /** نام‌های منطبق با LIKE (لفظِ SQL پس از addslashes؛ `\_` لفظی، `%` هر چیز، `_` یک نویسه). */
    public function like(string $lit): array {
        $p = stripslashes($lit); $re = '';
        for ($i = 0; $i < strlen($p); $i++) {
            $c = $p[$i];
            if ($c === '\\' && $i + 1 < strlen($p)) { $re .= preg_quote($p[++$i], '/'); }
            elseif ($c === '%') { $re .= '.*'; } elseif ($c === '_') { $re .= '.'; } else { $re .= preg_quote($c, '/'); }
        }
        return array_values(array_filter(array_keys($this->rows), fn($k) => preg_match('/^' . $re . '$/s', $k)));
    }
    public function get_results($q, $o = null) {
        $this->log[] = $q; $this->last_error = '';
        if ($this->failing($this->fail_read, $q)) { $this->last_error = 'injected read failure'; return null; }
        if (preg_match("/LIKE '((?:[^'\\\\]|\\\\.)*)' ORDER BY option_id LIMIT (\\d+)/s", $q, $m)) {
            return array_map(fn($k) => ['option_name' => $k, 'option_value' => $this->rows[$k]], array_slice($this->like($m[1]), 0, (int) $m[2]));
        }
        return [];
    }
    public function query($q) {
        $this->log[] = $q; $this->last_error = '';
        if ($this->failing($this->fail_write, $q)) { $this->last_error = 'injected write failure'; return false; }
        if (preg_match("/VALUES \\('([^']+)', (\\d+), 'no'\\)\\s+ON DUPLICATE KEY UPDATE option_value = GREATEST/", $q, $m)) {
            $this->rows[$m[1]] = (string) max((int) ($this->rows[$m[1]] ?? 0), (int) $m[2]); return 1;
        }
        if (preg_match("/VALUES \\('([^']+)', '(.*)', 'no'\\)\\s+ON DUPLICATE KEY UPDATE option_name = option_name/s", $q, $m)) {
            if (!isset($this->rows[$m[1]])) { $this->rows[$m[1]] = stripslashes($m[2]); return 1; }
            return 0;
        }
        if (preg_match("/VALUES \\('([^']+)', '(.*?)', 'no'\\)\\s+ON DUPLICATE KEY UPDATE option_value = /s", $q, $m)) {
            $this->rows[$m[1]] = stripslashes($m[2]); return 1;
        }
        if (preg_match("/DELETE FROM wp_options WHERE option_name IN \\('([^']+)', '([^']+)'\\) OR option_name LIKE '((?:[^'\\\\]|\\\\.)*)'/", $q, $m)) {
            foreach ($this->like($m[3]) as $k) { unset($this->rows[$k]); }
            unset($this->rows[$m[1]], $this->rows[$m[2]]); return 1;
        }
        if (preg_match("/DELETE FROM wp_options WHERE option_name LIKE '((?:[^'\\\\]|\\\\.)*)'$/", $q, $m)) {
            $n = 0; foreach ($this->like($m[1]) as $k) { unset($this->rows[$k]); $n++; } return $n;
        }
        if (preg_match("/DELETE FROM wp_options WHERE option_name = '([^']+)' AND option_value = '(.*)'$/s", $q, $m)) {
            if (($this->rows[$m[1]] ?? null) === stripslashes($m[2])) { unset($this->rows[$m[1]]); return 1; }
            return 0;
        }
        if (preg_match("/DELETE FROM wp_options WHERE option_name = '([^']+)'$/", $q, $m)) {
            $n = isset($this->rows[$m[1]]) ? 1 : 0; unset($this->rows[$m[1]]); return $n;
        }
        return 1;
    }
};
function marker_rows() { return array_map(fn($v) => json_decode($v, true), array_filter($GLOBALS['wpdb']->rows, fn($k) => str_starts_with($k, 'lmc_qp_'), ARRAY_FILTER_USE_KEY)); }
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
    $GLOBALS['wpdb']->fail_write = []; $GLOBALS['wpdb']->fail_read = []; $GLOBALS['wpdb']->lock_error = false;
    $GLOBALS['wpdb']->lock_error_re = null; $GLOBALS['wpdb']->on_lock = null;
    $GLOBALS['as_fail'] = false; $GLOBALS['cron_fail'] = false; $GLOBALS['as_on_add'] = null; $GLOBALS['crash_on_cancel'] = false;
    $GLOBALS['as_query_fail'] = [];
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
check(count(crash_rows()) === 3, 'شمارندهٔ کار مرده صفر نشد');
LMC_Queue::forget('lmc_send_refund', [9]);
check(crash_rows() === [] && dead_rows() === [], 'تصمیم انسانی شمارنده و ثبت مرده را پاک می‌کند');

reset_queue();
$fail_once = true;
$GLOBALS['hooks']['lmc_send_refund'] = [function ($id) use (&$fail_once) { if ($fail_once) { $fail_once = false; throw new RuntimeException('x'); } }];
LMC_Queue::enqueue('lmc_send_refund', [10]);
LMC_Queue::run(10, 'test');
check(count(crash_rows()) === 1, 'یک شکست شمرده شد');
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

// ── ۱۰. شکست قفل و نوشتن وضعیت (بازبینی دوم ریشه؛ کنترل منفی با تزریق شکست) ──────────────────
function qlock($kind, $hook, $args) { return 'lmc_q' . $kind . '_' . md5('|wp_|' . md5($hook . '|' . json_encode($args))); }
function due_now() { foreach ($GLOBALS['as'] as $aid => $a) { if ($a['status'] === 'pending') { $GLOBALS['as'][$aid]['at'] = null; } } }

// ۱۰الف. قفل صف در دست پردازهٔ دیگر (مهلت تمام): نه پرسش «معلق هست؟» نه درج؛ نشان معوق، و Checkout استثنا نمی‌گیرد.
reset_queue();
$GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [61])] = 'other-process';
check(LMC_Queue::enqueue('lmc_send_refund', [61]) === true, 'قفل گرفته نشد: enqueue بی استثنا و ماندگار (true)');
check(pending_rows('lmc_send_refund', [61]) === [], 'قفل گرفته نشد: هیچ سطر صفی بی قفل درج نشد');
check($GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [61])] === 'other-process', 'قفل پردازهٔ دیگر دست نخورد');
$m = array_values(marker_rows());
check(count($m) === 1 && $m[0]['op'] === 'e' && $m[0]['args'] === [61], 'نشان معوق «صف کن» ذخیره شد');
check(LMC_Queue::health()['deferredTasks'] === 1, 'تشخیص: کار معوق شمرده می‌شود');
LMC_Queue::enqueue('lmc_send_refund', [61]);
check(count(marker_rows()) === 1, 'تکرار: همان یک نشان');
check(LMC_Queue::drain() === 0 && pending_rows('lmc_send_refund', [61]) === [] && count(marker_rows()) === 1, 'drain تا قفل آزاد نشود کاری نمی‌کند');
unset($GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [61])]);
check(LMC_Queue::drain() === 1, 'drain پس از آزادشدن قفل');
check(count(pending_rows('lmc_send_refund', [61])) === 1 && marker_rows() === [], 'drain: دقیقاً یک سطر، نشان حذف شد');
check(LMC_Queue::health()['deferredTasks'] === 0 && $GLOBALS['wpdb']->locks === [], 'پس از drain: هیچ کار معوق و هیچ قفلی');

// ۱۰ب. خطای SQL در GET_LOCK (null): همان رفتار — بی قفل وارد بخش محافظت‌شده نمی‌شود؛ تا سقف عمر نشان، بعد مرده.
reset_queue();
$GLOBALS['wpdb']->lock_error = true;
check(LMC_Queue::enqueue(LMC_ORDER_EVENT, [62]) === true && pending_rows(LMC_ORDER_EVENT, [62]) === [], 'خطای قفل: درج بی قفل نشد');
check(count(marker_rows()) === 1, 'خطای قفل: نشان معوق');
LMC_Queue::drain();
check(count(marker_rows()) === 1 && dead_rows() === [], 'خطای قفل در drain: نشان پیش از سقف عمر می‌ماند');
$name = array_keys(marker_rows())[0];
$old = json_decode($GLOBALS['wpdb']->rows[$name], true); $old['at'] = time() - LMC_Queue::DEFER_MAX_AGE - 1;
$GLOBALS['wpdb']->rows[$name] = json_encode($old);
LMC_Queue::drain();
$dead = array_values(dead_rows());
check(marker_rows() === [] && count($dead) === 1 && $dead[0]['reason'] === 'queue_lock_unavailable', 'سقف عمر: نشان مرده ثبت شد (بی‌انتها نیست)');
check(pending_rows(LMC_ORDER_EVENT, [62]) === [] && LMC_Queue::health()['deadTasks'] === 1, 'مرده دیده می‌شود و هیچ درجی بی قفل نشد');

// ۱۰ج. reschedule بی قفل: سطر معلق موجود لغو یا جایگزین نمی‌شود؛ drain پس از قفل همان Backoff را می‌نشاند.
reset_queue();
LMC_Queue::enqueue(LMC_ORDER_EVENT, [63]);
$GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [63])] = 'other-process';
check(LMC_Queue::reschedule(LMC_ORDER_EVENT, [63], 300) === true, 'reschedule بی قفل: ماندگار (معوق)');
$p = pending_rows(LMC_ORDER_EVENT, [63]);
check(count($p) === 1 && $p[0]['at'] === null, 'reschedule بی قفل: سطر موجود دست نخورد');
unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [63])]);
LMC_Queue::drain();
$p = pending_rows(LMC_ORDER_EVENT, [63]);
check(count($p) === 1 && $p[0]['at'] >= time() + 299 && marker_rows() === [], 'drain: فقط Backoff کامل ماند');

// ۱۰د. بازیابی بی قفل: نه شمارش نه صف؛ drain زیر قفل همان تصمیم را می‌گیرد.
reset_queue();
$GLOBALS['hooks']['lmc_send_refund'] = [function () { throw new RuntimeException('x'); }];
$aid = as_enqueue_async_action('lmc_send_refund', [64], LMC_Queue::GROUP);
$GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [64])] = 'other-process';
ActionScheduler::runner()->process_action($aid, 'test');
check(crash_rows() === [] && pending_rows('lmc_send_refund', [64]) === [], 'بازیابی بی قفل: نه شمارش نه صف');
check(array_values(marker_rows())[0]['op'] === 'c', 'بازیابی بی قفل: نشان معوق بازیابی');
unset($GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [64])]);
LMC_Queue::drain();
check(count(crash_rows()) === 1 && count(pending_rows('lmc_send_refund', [64])) === 1 && marker_rows() === [], 'drain: یک شکست شمرده و دوباره صف شد');

// ۱۰ه. قفل اجرا با خطای SQL: Handler بی سریال‌سازی اجرا نمی‌شود (BUSY، بی شمردن).
reset_queue();
$ran = 0;
$GLOBALS['hooks']['lmc_send_refund'] = [function () use (&$ran) { $ran++; }];
$aid = as_enqueue_async_action('lmc_send_refund', [65], LMC_Queue::GROUP);
$GLOBALS['wpdb']->lock_error = true;
ActionScheduler::runner()->process_action($aid, 'test');
check($ran === 0 && $GLOBALS['as'][$aid]['status'] === 'failed', 'قفل اجرا null: Handler بی سریال‌سازی اجرا نشد');
$m = array_values(marker_rows());
check(count($m) === 1 && $m[0]['why'] === 'lock_error' && $m[0]['action'] === $aid, 'خطای SQL قفل اجرا BUSY نیست: شکست شمرده‌شدنی (lock_error)، با هویت همان سطر');

// ۱۰و. همان تزریق ریشه: نوشتن شمارندهٔ شکست (lmc_qc_) همیشه ناموفق. پیش از اصلاح: شش اجرا با سقف سه، deadTasks=0.
reset_queue();
$runs = 0;
$GLOBALS['hooks']['lmc_send_refund'] = [function () use (&$runs) { $runs++; throw new RuntimeException('x'); }];
$GLOBALS['wpdb']->fail_write = ['/lmc_qc_/'];
LMC_Queue::enqueue('lmc_send_refund', [66]);
for ($i = 0; $i < 8; $i++) { due_now(); LMC_Queue::run(10, 'test'); }
$dead = array_values(dead_rows());
check($runs === 1, 'شمارنده ذخیره نشد: هیچ تلاش شمرده‌نشده‌ای صف نشد (یک اجرا، نه شش)');
check(count($dead) === 1 && $dead[0]['reason'] === 'counter_write_failed', 'توقف دیده‌شده: counter_write_failed');
check(pending_rows('lmc_send_refund', [66]) === [] && LMC_Queue::health()['deadTasks'] === 1, 'بی سطر معلق؛ تشخیص صفر نمی‌گوید');

// ۱۰ز. خواندن شمارنده خطا می‌دهد (ردیف «نیست» شمرده نمی‌شود).
reset_queue();
$runs = 0;
$GLOBALS['wpdb']->fail_read = ['/COUNT.*qc/'];
LMC_Queue::enqueue('lmc_send_refund', [67]);
for ($i = 0; $i < 8; $i++) { due_now(); LMC_Queue::run(10, 'test'); }
check($runs === 1 && array_values(dead_rows())[0]['reason'] === 'counter_write_failed', 'خطای خواندن شمارنده: یک اجرا و توقف دیده‌شده');

// ۱۰ز۲. خطای خواندن ثبت مرده «زنده» شمرده نمی‌شود: کار مردهٔ بی‌شمارنده (counter_write_failed) دوباره صف نمی‌شود.
reset_queue(); // Handler همان ۱۰و: همیشه استثنا (و $runs می‌شمارد)
$GLOBALS['wpdb']->rows['lmc_qd_' . md5('lmc_send_refund|[71]')] = json_encode(['hook' => 'lmc_send_refund', 'args' => [71], 'reason' => 'counter_write_failed']);
$GLOBALS['wpdb']->fail_read = ["/option_name = 'lmc_qd_/"];
$aid = as_enqueue_async_action('lmc_send_refund', [71], LMC_Queue::GROUP);
ActionScheduler::runner()->process_action($aid, 'test');
check(pending_rows('lmc_send_refund', [71]) === [] && crash_rows() === [], 'خطای خواندن ثبت مرده: نه شمارش نه صف');
check(array_values(marker_rows())[0]['op'] === 'c', 'خطای خواندن ثبت مرده: تصمیم معوق ماند');

// ۱۰ح. شمارنده و ثبت مرده هر دو ناموفق: نشان معوق؛ تشخیص سالم و خالی نمی‌گوید.
reset_queue();
$runs = 0;
$GLOBALS['wpdb']->fail_write = ['/lmc_qc_/', '/lmc_qd_/'];
LMC_Queue::enqueue('lmc_send_refund', [68]);
for ($i = 0; $i < 8; $i++) { due_now(); LMC_Queue::run(10, 'test'); }
$h = LMC_Queue::health();
check($runs === 1 && pending_rows('lmc_send_refund', [68]) === [], 'هیچ تکرار شمرده‌نشده‌ای');
check($h['deadTasks'] === 0 && $h['deferredTasks'] === 1 && $h['failedActions'] === 1, 'تشخیص: معوق ۱ و سطر failed ۱، نه «صف سالم»');
check((bool) preg_grep('/⛔ ثبت مرده/u', $GLOBALS['log']), 'شکست ثبت مرده در لاگ');
$GLOBALS['wpdb']->fail_write = [];
LMC_Queue::drain();
check(count(crash_rows()) === 1 && count(pending_rows('lmc_send_refund', [68])) === 1 && marker_rows() === [],
    'پس از بهبود پایگاه، drain همان شکست را یک بار شمرد و با Backoff دوباره صف کرد');

// ۱۰ط. همهٔ نوشتن‌ها ناموفق: چیزی بی‌صدا «سالم» نمی‌شود — سطر failed و لاگ خطا.
reset_queue();
$runs = 0;
$GLOBALS['wpdb']->fail_write = ['/lmc_q[cdp]_/'];
LMC_Queue::enqueue('lmc_send_refund', [69]);
for ($i = 0; $i < 4; $i++) { due_now(); LMC_Queue::run(10, 'test'); }
$h = LMC_Queue::health();
check($runs === 1 && $h['failedActions'] === 1 && $h['deadTasks'] === 0 && $h['deferredTasks'] === 0, 'همه ناموفق: یک اجرا و failedActions=۱');
check((bool) preg_grep('/⛔ تغییر صف lmc_send_refund انجام نشد و نشان معوقش هم ذخیره نشد/u', $GLOBALS['log']), 'همه ناموفق: لاگ خطای صریح');

// ۱۰ی. «ارسال دوباره» که نتواند ثبت مرده را پاک کند false می‌دهد (فراخوان یادداشت سفارش می‌گذارد).
reset_queue();
$GLOBALS['wpdb']->rows['lmc_qd_' . md5('lmc_send_refund|[70]')] = '{}';
$GLOBALS['wpdb']->fail_write = ['/DELETE FROM wp_options WHERE option_name IN/'];
check(LMC_Queue::forget('lmc_send_refund', [70]) === false && count(dead_rows()) === 1, 'forget ناموفق false می‌دهد');
$GLOBALS['wpdb']->fail_write = [];
check(LMC_Queue::forget('lmc_send_refund', [70]) === true && dead_rows() === [], 'forget موفق');

// ── ۱۱. بازبینی سوم ریشه: بازپخش ماندگار idempotent، آخرین تصمیم، اشغال در برابر خطای قفل، ورودی‌های بیرون از AS ──
function crash_count($hook, $arg) { return count(array_filter(array_keys($GLOBALS['wpdb']->rows), fn($k) => str_starts_with($k, 'lmc_qc_' . md5($hook . '|' . json_encode([$arg])) . '_'))); }
function one_pending($hook, $arg) { $p = pending_rows($hook, [$arg]); return count($p) === 1 ? $p[0] : null; }

// ۱۱الف. همان بازتولید ریشه: یک شکست واقعی، نشان «c»، و حذف نشان همیشه ناموفق؛ سه drain.
reset_queue();
$runs = 0;
$GLOBALS['hooks']['lmc_send_refund'] = [function () use (&$runs) { $runs++; throw new RuntimeException('x'); }];
$aid = as_enqueue_async_action('lmc_send_refund', [81], LMC_Queue::GROUP);
$GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [81])] = 'other-process';
ActionScheduler::runner()->process_action($aid, 'test');
unset($GLOBALS['wpdb']->locks[qlock('e', 'lmc_send_refund', [81])]);
$GLOBALS['wpdb']->fail_write = ['/DELETE FROM wp_options WHERE option_name = .lmc_qp_/'];
for ($i = 0; $i < 3; $i++) { LMC_Queue::drain(); }
check($runs === 1 && crash_count('lmc_send_refund', 81) === 1, 'بازپخش سه‌باره: یک شکست واقعی یک بار شمرده شد (نه ۱→۲→۳)');
check(one_pending('lmc_send_refund', 81) !== null && dead_rows() === [], 'بازپخش: تلاش دوباره لغو نشد و کار مرده نشد');
check(count(marker_rows()) === 1, 'نشانِ حذف‌نشده می‌ماند، ولی بی‌اثر است');

// ۱۱ب. اجرای سالم پس از آن: بازپخش دیرهنگام همان نشان کهنه است — نه شمارش نه صف (واترمارک).
$GLOBALS['hooks']['lmc_send_refund'] = [function () use (&$runs) { $runs++; }];
due_now(); LMC_Queue::run(10, 'test');
check($runs === 2 && crash_count('lmc_send_refund', 81) === 0, 'اجرای سالم شمارنده را پاک کرد');
LMC_Queue::drain();
check(crash_count('lmc_send_refund', 81) === 0 && pending_rows('lmc_send_refund', [81]) === [] && dead_rows() === [], 'بازپخش پس از اجرای سالم: نه شمارش نه صف تازه');
$GLOBALS['wpdb']->fail_write = [];
LMC_Queue::drain();
check(marker_rows() === [], 'وقتی حذف ممکن شد، نشان کهنه برداشته شد');

// ۱۱ج. دو Hook برای یک سطر (failed_execution و unexpected_shutdown) یک شکست‌اند.
reset_queue();
$aid = as_enqueue_async_action('lmc_send_refund', [82], LMC_Queue::GROUP);
$GLOBALS['as'][$aid]['status'] = 'failed';
LMC_Queue::on_failed_execution($aid, new RuntimeException('x'));
LMC_Queue::on_failed($aid);
check(crash_count('lmc_send_refund', 82) === 1 && count(pending_rows('lmc_send_refund', [82])) === 1, 'یک سطر، دو Hook: یک شمارش و یک تلاش');

// ۱۱د. همان بازتولید ریشه برای آخرین تصمیم: قفل صف گرفته، reschedule ۳۰ و سپس ۹۰۰، آزادسازی، drain.
reset_queue();
$GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [83])] = 'other-process';
LMC_Queue::reschedule(LMC_ORDER_EVENT, [83], 30);
LMC_Queue::reschedule(LMC_ORDER_EVENT, [83], 900);
unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [83])]);
LMC_Queue::drain();
$p = one_pending(LMC_ORDER_EVENT, 83);
check($p !== null && $p['at'] >= time() + 899 && marker_rows() === [], 'آخرین تصمیم برنده: ۹۰۰ ثانیه، نه ۳۰');

// ۱۱ه. تصمیم مستقیم تازه‌تر زیر قفل، نشان کهنه را بی‌اثر می‌کند.
reset_queue();
$GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [84])] = 'other-process';
LMC_Queue::reschedule(LMC_ORDER_EVENT, [84], 900);
unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [84])]);
LMC_Queue::reschedule(LMC_ORDER_EVENT, [84], 30);
LMC_Queue::drain();
$p = one_pending(LMC_ORDER_EVENT, 84);
check($p !== null && $p['at'] <= time() + 31, 'نشان کهنهٔ ۹۰۰ تصمیم مستقیم تازه‌ترِ ۳۰ را بازنویسی نکرد');

// ۱۱و. هم‌پوشانی drain: نشانی که میان خواندن و گرفتن قفل عوض شد، با نسخهٔ کهنه اعمال نمی‌شود.
reset_queue();
$GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [85])] = 'other-process';
LMC_Queue::reschedule(LMC_ORDER_EVENT, [85], 30);
unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [85])]);
$GLOBALS['wpdb']->on_lock = function () {
    // پردازهٔ دیگری همین لحظه تصمیم تازه‌تری را معوق کرد.
    $name = array_keys(marker_rows())[0];
    $d = json_decode($GLOBALS['wpdb']->rows[$name], true); $d['due'] = time() + 900; $d['seq'] = 'newer';
    $GLOBALS['wpdb']->rows[$name] = json_encode($d);
};
LMC_Queue::drain();
check(pending_rows(LMC_ORDER_EVENT, [85]) === [] && count(marker_rows()) === 1, 'drain نشانِ عوض‌شده را با نسخهٔ کهنه اعمال نکرد');
LMC_Queue::drain();
$p = one_pending(LMC_ORDER_EVENT, 85);
check($p !== null && $p['at'] >= time() + 899 && marker_rows() === [], 'دور بعد نسخهٔ تازه (۹۰۰) اعمال شد');

// ۱۱ز. فقط قفل اجرا خطای SQL می‌دهد (قفل صف سالم): شکست شمرده‌شده، Handler اجرا نمی‌شود، پس از سه بار مرده.
reset_queue();
$runs = 0;
$GLOBALS['hooks']['lmc_send_refund'] = [function () use (&$runs) { $runs++; }];
$GLOBALS['wpdb']->lock_error_re = '/^lmc_qx_/';
LMC_Queue::enqueue('lmc_send_refund', [86]);
for ($i = 0; $i < 8; $i++) { due_now(); LMC_Queue::run(10, 'test'); }
$dead = array_values(dead_rows());
$failed = count(array_filter($GLOBALS['as'], fn($a) => $a['status'] === 'failed'));
check($runs === 0 && $failed === LMC_Queue::MAX_CRASHES, 'خطای قفل اجرا: Handler اجرا نشد؛ دقیقاً سه سطر failed، نه هشت');
check(count($dead) === 1 && $dead[0]['reason'] === 'lock_error' && pending_rows('lmc_send_refund', [86]) === [], 'مرده با lock_error، بی کار معلق');

// ۱۱ح. مالک واقعی قفل اجرا (مهلت تمام): شمرده نمی‌شود، دورهٔ اشغال دیده می‌شود، و پس از BUSY_MAX_AGE مرده.
reset_queue();
$runs = 0;
$GLOBALS['wpdb']->locks[qlock('x', 'lmc_send_refund', [87])] = 'other-process';
LMC_Queue::enqueue('lmc_send_refund', [87]);
due_now(); LMC_Queue::run(10, 'test');
check($runs === 0 && crash_count('lmc_send_refund', 87) === 0 && one_pending('lmc_send_refund', 87) !== null, 'اشغال واقعی: شمرده نشد، دوباره صف');
check(LMC_Queue::health()['busyTasks'] === 1, 'تشخیص: اشغال دیده می‌شود');
$bk = 'lmc_qb_' . md5('lmc_send_refund|[87]');
$GLOBALS['wpdb']->rows[$bk] = (time() - LMC_Queue::BUSY_MAX_AGE - 5) . ':' . (time() - 40); // همان دورهٔ اشغال، طولانی
due_now(); LMC_Queue::run(10, 'test');
$dead = array_values(dead_rows());
check(count($dead) === 1 && $dead[0]['reason'] === 'exec_lock_held' && pending_rows('lmc_send_refund', [87]) === [], 'اشغال بیش از سقف: مرده، بی تلاش بی‌انتها');
// دورهٔ تازه: اشغالی که پس از فاصلهٔ طولانی بیاید از صفر شروع می‌شود (اجرای قدیمی سالم نبود ولی کار زنده است).
reset_queue();
$GLOBALS['wpdb']->locks[qlock('x', 'lmc_send_refund', [88])] = 'other-process';
$GLOBALS['wpdb']->rows['lmc_qb_' . md5('lmc_send_refund|[88]')] = (time() - 5000) . ':' . (time() - 4000);
LMC_Queue::enqueue('lmc_send_refund', [88]);
due_now(); LMC_Queue::run(10, 'test');
check(dead_rows() === [] && one_pending('lmc_send_refund', 88) !== null, 'اشغال پس از فاصلهٔ طولانی دورهٔ تازه است، نه مرگ');
// اجرای سالم دورهٔ اشغال را پاک می‌کند.
unset($GLOBALS['wpdb']->locks[qlock('x', 'lmc_send_refund', [88])]);
$GLOBALS['hooks']['lmc_send_refund'] = [function () {}];
due_now(); LMC_Queue::run(10, 'test');
check(!isset($GLOBALS['wpdb']->rows['lmc_qb_' . md5('lmc_send_refund|[88]')]) && LMC_Queue::health()['busyTasks'] === 0, 'اجرای سالم دورهٔ اشغال را پاک کرد');

// ۱۱ط. کار مرده با BUSY دوباره صف نمی‌شود (بررسی مرده پیش از اشغال).
reset_queue();
$GLOBALS['wpdb']->rows['lmc_qd_' . md5('lmc_send_refund|[89]')] = json_encode(['reason' => 'x']);
$GLOBALS['wpdb']->locks[qlock('x', 'lmc_send_refund', [89])] = 'other-process';
$aid = as_enqueue_async_action('lmc_send_refund', [89], LMC_Queue::GROUP);
ActionScheduler::runner()->process_action($aid, 'test');
check(pending_rows('lmc_send_refund', [89]) === [], 'مرده + اشغال: دوباره صف نشد');

// ۱۱ی. ورودی بیرون از AS (ارسال دستی، رویداد WP-Cron مانده از پیش از ارتقا): پشت همان قفل اجرا.
reset_queue();
$GLOBALS['wpdb']->locks[qlock('x', 'lmc_send_refund', [90])] = 'other-process';
LMC_Refund_Sync::send(90);
$p = one_pending('lmc_send_refund', 90);
check($p !== null && $p['at'] >= time() + 30 && (bool) preg_grep('/اجرای lmc_send_refund هم‌اکنون ممکن نشد/u', $GLOBALS['log']), 'ورودی دستی/WP-Cron هم‌زمان با اجرای دیگر: اجرا نشد، دوباره صف');
check($GLOBALS['wpdb']->locks[qlock('x', 'lmc_send_refund', [90])] === 'other-process', 'قفل اجرای دیگر دست نخورد');
// درون اجرای AS همان قفل بازگشتی است: نه انتظار، نه رد.
reset_queue();
$GLOBALS['hooks']['lmc_send_refund'] = [fn($id) => LMC_Refund_Sync::send($id)];
$aid = as_enqueue_async_action('lmc_send_refund', [91], LMC_Queue::GROUP);
$denied = $GLOBALS['wpdb']->denied;
ActionScheduler::runner()->process_action($aid, 'test');
check($GLOBALS['as'][$aid]['status'] === 'complete' && $GLOBALS['wpdb']->denied === $denied && $GLOBALS['wpdb']->locks === [], 'درون اجرای AS: قفل بازگشتی، و همه آزاد شدند');

// ── ۱۲. بازبینی چهارم ریشه: تصمیم تازه‌تر پیش از اثر ماندگار است؛ نشان کهنه با شکست پاک‌سازی یا مرگ پردازه برنمی‌گردد ──
$r_delete = '/DELETE FROM wp_options WHERE option_name = .lmc_qp_r_/';
function stale_r($arg, $delay) {
    $GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [$arg])] = 'other-process';
    LMC_Queue::reschedule(LMC_ORDER_EVENT, [$arg], $delay);
    unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [$arg])]);
}

// ۱۲الف. همان بازتولید ریشه: نشان کهنهٔ ۳۰، تصمیم مستقیم ۹۰۰، و فقط DELETE نشان «r» شکست می‌خورد.
foreach ([false, true] as $fault) {
    reset_queue();
    stale_r(92, 30);
    if ($fault) { $GLOBALS['wpdb']->fail_write = [$r_delete]; }
    $ret = LMC_Queue::reschedule(LMC_ORDER_EVENT, [92], 900);
    $GLOBALS['wpdb']->fail_write = [];
    $p = one_pending(LMC_ORDER_EVENT, 92);
    check($ret === true && $p !== null && $p['at'] >= time() + 899, ($fault ? 'خطا' : 'کنترل') . ': تصمیم مستقیم ۹۰۰ صف شد');
    $left = array_values(marker_rows());
    check($fault ? (count($left) === 1 && $left[0]['due'] >= time() + 899) : $left === [], ($fault ? 'خطا: نشانِ مانده خودِ تصمیم ۹۰۰ است، نه ۳۰' : 'کنترل: نشانی نمانده'));
    LMC_Queue::drain();
    $p = one_pending(LMC_ORDER_EVENT, 92);
    check($p !== null && $p['at'] >= time() + 899 && marker_rows() === [], ($fault ? 'خطا' : 'کنترل') . ': پس از drain هنوز ۹۰۰، نه ۳۰');
}

// ۱۲ب. مرگ پردازه پس از نوشتن پیشاپیشِ تصمیم و پیش از تغییر صف: drain همان تصمیم تازه را اعمال می‌کند.
reset_queue();
stale_r(93, 30);
$GLOBALS['crash_on_cancel'] = true;
$died = false;
try { LMC_Queue::reschedule(LMC_ORDER_EVENT, [93], 900); } catch (RuntimeException $e) { $died = true; }
$GLOBALS['crash_on_cancel'] = false;
check($died && $GLOBALS['wpdb']->locks === [] && array_values(marker_rows())[0]['due'] >= time() + 899, 'مرگ میان نوشتن‌ها: نشان همان تصمیم ۹۰۰ است و قفل آزاد شد');
LMC_Queue::drain();
$p = one_pending(LMC_ORDER_EVENT, 93);
check($p !== null && $p['at'] >= time() + 899 && marker_rows() === [], 'پس از مرگ: drain ۹۰۰ را صف کرد، نه ۳۰');

// ۱۲ج. خودِ نوشتن پیشاپیش شکست می‌خورد: صف دست نمی‌خورد، false، و تصمیم کهنه (نه هیچ) می‌ماند.
reset_queue();
stale_r(94, 30);
$GLOBALS['wpdb']->fail_write = ['/lmc_qp_r_/'];
$ret = LMC_Queue::reschedule(LMC_ORDER_EVENT, [94], 900);
$GLOBALS['wpdb']->fail_write = [];
check($ret === false && pending_rows(LMC_ORDER_EVENT, [94]) === [] && (bool) preg_grep('/تصمیم تازهٔ صف .* ماندگار نشد/u', $GLOBALS['log']), 'نوشتن پیشاپیش ناموفق: صف دست نخورد، false و لاگ');
LMC_Queue::drain();
$p = one_pending(LMC_ORDER_EVENT, 94);
check($p !== null && $p['at'] <= time() + 31, 'تلاش دوباره گم نشد: تصمیم کهنهٔ ۳۰ اعمال شد');

// ۱۲د. نشانِ مانده از تصمیم مصرف‌شده: پس از اجرای سالمِ تازه‌تر، بازپخش بی‌اثر است (ارسال تکراری نه).
reset_queue();
$runs = 0;
$GLOBALS['hooks'][LMC_ORDER_EVENT] = [function () use (&$runs) { $runs++; }];
stale_r(95, 30);
$GLOBALS['wpdb']->fail_write = [$r_delete];
LMC_Queue::reschedule(LMC_ORDER_EVENT, [95], 900);
// گذشت ۹۰۰ ثانیه: هم سطر AS و هم موعدِ مطلقِ نشان رسیده‌اند (due_now فقط سطر را جابه‌جا می‌کند).
due_now();
foreach (array_keys(marker_rows()) as $k) { $d = json_decode($GLOBALS['wpdb']->rows[$k], true); $d['due'] = time(); $GLOBALS['wpdb']->rows[$k] = json_encode($d); }
LMC_Queue::run(10, 'test');
check($runs === 1 && count(marker_rows()) === 1, 'تصمیم ۹۰۰ اجرا شد؛ نشانش هنوز مانده (حذف ناموفق)');
$GLOBALS['wpdb']->fail_write = [];
LMC_Queue::drain();
check(pending_rows(LMC_ORDER_EVENT, [95]) === [] && marker_rows() === [], 'پس از اجرای سالم: بازپخش بی‌اثر — بی کار تازه، نشان برداشته شد');

// ۱۲ه. کنترل منفیِ کف: تصمیم معوقِ درون همان اجرای AS پس از پایان سالمِ همان اجرا هنوز اعمال می‌شود.
reset_queue();
$GLOBALS['hooks'][LMC_ORDER_EVENT] = [function ($id) {
    $GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [$id])] = 'other-process';
    LMC_Queue::reschedule(LMC_ORDER_EVENT, [$id], 900);
}];
$aid = as_enqueue_async_action(LMC_ORDER_EVENT, [96], LMC_Queue::GROUP);
ActionScheduler::runner()->process_action($aid, 'test');
unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [96])]);
$m = array_values(marker_rows());
check($GLOBALS['as'][$aid]['status'] === 'complete' && count($m) === 1 && $m[0]['floor'] === $aid, 'تصمیم معوق کفِ همان اجرا را دارد');
LMC_Queue::drain();
$p = one_pending(LMC_ORDER_EVENT, 96);
check($p !== null && $p['at'] >= time() + 899 && marker_rows() === [], 'اجرای سالمِ همان اجرا تصمیمش را بی‌اثر نکرد: ۹۰۰ صف شد');

// ۱۲و. شکست قطعی (stop) جای تلاش دوبارهٔ معوقِ کهنه را می‌گیرد؛ cancel تنها نمی‌گرفت.
reset_queue();
stale_r(97, 30);
LMC_Queue::stop(LMC_ORDER_EVENT, [97]);
LMC_Queue::drain();
check(pending_rows(LMC_ORDER_EVENT, [97]) === [] && marker_rows() === [], 'توقف قطعی: نشان کهنهٔ ۳۰ کار را برنگرداند');
reset_queue();
stale_r(98, 30);
$GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [98])] = 'other-process';
LMC_Queue::stop(LMC_ORDER_EVENT, [98]);
unset($GLOBALS['wpdb']->locks[qlock('e', LMC_ORDER_EVENT, [98])]);
LMC_Queue::drain();
check(pending_rows(LMC_ORDER_EVENT, [98]) === [] && marker_rows() === [], 'توقف معوق (بی قفل) هم آخرین تصمیم است');

// ۱۲ز. نشان «r» پیش از این نسخه (بی floor) مثل قبل اعمال می‌شود — ارتقا تصمیم معوقی را گم نمی‌کند.
reset_queue();
$GLOBALS['wpdb']->rows['lmc_qs_' . md5(LMC_ORDER_EVENT . '|[99]')] = '500';
$GLOBALS['wpdb']->rows['lmc_qp_r_' . md5(LMC_ORDER_EVENT . '|[99]')] = json_encode(['op' => 'r', 'hook' => LMC_ORDER_EVENT, 'args' => [99], 'at' => time(), 'seq' => 'legacy', 'due' => time() + 60]);
LMC_Queue::drain();
check(one_pending(LMC_ORDER_EVENT, 99) !== null && marker_rows() === [], 'نشان قدیمی بی floor اعمال شد');

// ۱۳. صف زنده برای داشبورد Core: سررسیده، آینده و در حال اجرا جدا؛ کار دیگران و وضعیت‌های پایانی شمرده نمی‌شوند.
reset_queue();
LMC_Queue::enqueue('lmc_send_refund', [131]);
LMC_Queue::enqueue('lmc_send_refund', [132]);
LMC_Queue::enqueue('lmc_send_refund', [133], 600);
as_add(null, 'other_plugin_hook', [], 'other-group');
$GLOBALS['as'][count($GLOBALS['as'])]['status'] = 'pending';
$h = LMC_Queue::health();
check([$h['pendingDue'], $h['pendingFuture'], $h['running']] === [2, 1, 0], 'سررسیده ۲، آینده ۱، در حال اجرا ۰ — فقط گروه همین صف');
$first = array_key_first(array_filter($GLOBALS['as'], fn($a) => $a['args'] === [131]));
$GLOBALS['as'][$first]['status'] = 'in-progress';
$h = LMC_Queue::health();
check([$h['pendingDue'], $h['pendingFuture'], $h['running']] === [1, 1, 1], 'در حال اجرا از سررسیده جدا شمرده می‌شود');
$GLOBALS['as'][$first]['status'] = 'complete';
check(LMC_Queue::health()['running'] === 0 && LMC_Queue::health()['pendingDue'] === 1, 'کار تمام‌شده در هیچ‌کدام نیست');

// ۱۳ب. شمارشی که شکست بخورد «نمی‌دانم» است، نه صفر — و شمارش‌های دیگر را نمی‌برد.
$GLOBALS['as_query_fail'] = ['in-progress'];
$h = LMC_Queue::health();
check($h['running'] === null && $h['pendingDue'] === 1 && $h['pendingFuture'] === 1, 'شکست شمارش در حال اجرا فقط همان را null می‌کند');
$GLOBALS['as_query_fail'] = ['pending', 'failed'];
$h = LMC_Queue::health();
check($h['pendingDue'] === null && $h['pendingFuture'] === null && $h['failedActions'] === null && $h['running'] === 0, 'شکست شمارش معلق: null، هرگز ۰');

// ۱۳ج. قرارداد با Core (`queueTelemetry` در apps/api/src/platform/woocommerce-diagnostics.ts): همین کلیدها، نه بیشتر.
$keys = array_keys(LMC_Queue::health()); sort($keys);
check($keys === ['backend', 'busyTasks', 'deadScope', 'deadTasks', 'deferredTasks', 'failedActions', 'failedActionsScope', 'group', 'pendingDue', 'pendingFuture', 'running'],
    'کلیدهای گزارش صف همان قرارداد Core است');

echo "OK: $checks queue assertions\n";
