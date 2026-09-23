<?php
/** تزریق شکست نوشتن و رقابت قفل؛ آزمون رفتار واقعی کلاس با مرزهای WordPress کنترل‌شده. */
declare(strict_types=1);
define('ABSPATH', __DIR__);
define('LMC_INSTORE_EVENT', 'lmc_sync_instore');
$options = []; $posts = []; $meta = []; $locks = []; $fail = ''; $nextId = 1; $seen = 0;
class WP_Error { public function get_error_message() { return 'injected failure'; } }
function is_wp_error($v): bool { return $v instanceof WP_Error; }
function __($s, $d = '') { return $s; }
function lmc_log($s): void {}
function lmc_setting($k) { return ['sync_instore' => 'yes', 'branch_id' => 'b'][$k] ?? ''; }
function get_option($k, $default = false) { return $GLOBALS['options'][$k] ?? $default; }
function update_option($k, $v, $auto = null) { $GLOBALS['options'][$k] = $v; return true; }
function wp_next_scheduled($hook) { return 10; }
function wp_schedule_single_event($at, $hook) {}
function wp_generate_password(...$args) { return 'random-test-only'; }
function get_users($args) { return []; }
function get_user_by(...$args) { return false; }
function wp_insert_user($v) { return $GLOBALS['fail'] === 'user' ? new WP_Error() : 50; }
function update_user_meta(...$args) {}
function wp_insert_post($v, $error = false) {
    if ($GLOBALS['fail'] === 'post') return new WP_Error();
    $id = $GLOBALS['nextId']++;
    $GLOBALS['posts'][$id] = (object) array_merge($v, ['ID' => $id]);
    return $id;
}
function wp_update_post($v, $error = false) {
    if ($GLOBALS['fail'] === 'publish') return new WP_Error();
    foreach ($v as $k => $x) $GLOBALS['posts'][$v['ID']]->$k = $x;
    return $v['ID'];
}
function wp_slash($v) { return $v; }
function wp_cache_delete(...$args) {}
function update_post_meta($id, $key, $v) {
    if ($GLOBALS['fail'] === 'meta' && $key === '_lmc_payable_amount') return false;
    $GLOBALS['meta'][$id][$key] = $v; return true;
}
function get_post_meta($id, $key, $single = false) { return $GLOBALS['meta'][$id][$key] ?? ''; }
function wp_timezone() { return new DateTimeZone('Asia/Tehran'); }
function wp_date($fmt, $at, $tz) { return (new DateTimeImmutable('@'.$at))->setTimezone($tz)->format($fmt); }
class TestWpdb {
    public string $prefix = 'wp_'; public string $posts = 'wp_posts'; public string $postmeta = 'wp_postmeta'; public string $last_error = '';
    public function prepare($sql, ...$args) { return [$sql, $args]; }
    public function get_var($q) {
        [$sql, $args] = $q; $key = $args[0];
        if (str_contains($sql, 'RELEASE_LOCK')) { unset($GLOBALS['locks'][$key]); return '1'; }
        if ($GLOBALS['fail'] === 'lock' || isset($GLOBALS['locks'][$key])) return '0';
        $GLOBALS['locks'][$key] = true; return '1';
    }
    public function get_row($q) {
        $this->last_error = $GLOBALS['fail'] === 'read' ? 'injected read failure' : '';
        if ($this->last_error) return null;
        [, $args] = $q;
        foreach ($GLOBALS['posts'] as $p) {
            if ($p->post_type === $args[0] && ($p->post_name === $args[1] || get_post_meta($p->ID, $args[2], true) === $args[3])) return $p;
        }
        return null;
    }
}
$wpdb = new TestWpdb();
class LMC_Client {
    public static array $response = []; public static array $queries = [];
    public static function get($url, $query) { self::$queries[] = $query; return self::$response; }
}
require __DIR__ . '/../labelmod-connector/includes/class-lmc-instore.php';
function check($name, $actual, $want): void {
    $GLOBALS['seen']++;
    if ($actual !== $want) throw new RuntimeException($name . ': '.json_encode([$actual, $want]));
    echo "OK $name\n";
}
function item($id): array {
    return ['invoiceId' => $id, 'number' => $id, 'channel' => 'pos', 'customer' => ['mobile' => '09121110000'],
        'occurredAt' => '2026-09-22T20:45:00Z', 'payableAmount' => '200000', 'lines' => [['name' => 'قلم', 'qty' => '1']]];
}
function reset_case(): void {
    $GLOBALS['options'] = []; $GLOBALS['posts'] = []; $GLOBALS['meta'] = []; $GLOBALS['locks'] = [];
    $GLOBALS['fail'] = ''; $GLOBALS['nextId'] = 1;
    LMC_Client::$queries = [];
    LMC_Client::$response = ['items' => [item('one'), item('two')], 'cursor' => 'end', 'cursorId' => 'two'];
}
foreach (['user', 'post', 'meta', 'publish', 'read'] as $failure) {
    reset_case(); $fail = $failure;
    $result = LMC_Instore::run();
    check("$failure reports retry", $result['error'] !== '', true);
    check("$failure keeps checkpoint", get_option(LMC_Instore::CHECKPOINT, null), null);
    check("$failure releases locks", count($locks), 0);
    check("$failure hides incomplete posts", count(array_filter($posts, fn($p) => $p->post_status === 'publish')), 0);
    $fail = '';
    $result = LMC_Instore::run();
    check("$failure recovery creates both", $result['created'], 2);
    check("$failure no orphan duplicate", count($posts), 2);
    check("$failure checkpoint pair", get_option(LMC_Instore::CHECKPOINT), ['since' => 'end', 'id' => 'two', 'branch' => 'b']);
    check("$failure replay creates none", LMC_Instore::run()['created'], 0);
}
reset_case(); $fail = 'lock';
check('lock unavailable is retry', LMC_Instore::import_one(item('one')), 'retry');
check('lock unavailable writes nothing', count($posts), 0);
check('run lock unavailable reports error', LMC_Instore::run()['error'] !== '', true);
check('run lock unavailable does not fetch', count(LMC_Client::$queries), 0);
$fail = ''; $locks['lmc_instore_import_'.md5('wp_')] = true;
check('concurrent importer cannot insert', LMC_Instore::import_one(item('one')), 'retry');
check('contender cannot release owner lock', isset($locks['lmc_instore_import_'.md5('wp_')]), true);
unset($locks['lmc_instore_import_'.md5('wp_')]);
check('owner completion', LMC_Instore::import_one(item('one')), 'created');
check('contender retry is duplicate', LMC_Instore::import_one(item('one')), 'skipped');
check('one identity only', count($posts), 1);
// قطع اجرا بلافاصله پس از INSERT و پیش از اولین متا؛ retry باید همان پست را تکمیل کند.
reset_case(); wp_insert_post(['post_type' => LMC_Instore::POST_TYPE, 'post_name' => 'lmc-'.hash('sha256', 'one'), 'post_status' => 'draft']);
check('crash before metadata recovered', LMC_Instore::import_one(item('one')), 'created');
check('crash before metadata no duplicate', count($posts), 1);
check('date is actual purchase in site timezone', LMC_Instore::purchase_date(1), '2026/09/23');
$meta[1]['_lmc_occurred_at'] = '2026-09-22T20:15:00Z';
check('before local midnight', LMC_Instore::purchase_date(1), '2026/09/22');
$meta[1]['_lmc_occurred_at'] = '2026-09-23T00:15:00+03:30';
check('explicit offset same instant', LMC_Instore::purchase_date(1), '2026/09/23');
foreach (['', 'yesterday', '2026-02-31T00:00:00Z', '<script>'] as $bad) {
    $meta[1]['_lmc_occurred_at'] = $bad;
    check('invalid date is unknown: '.$bad, LMC_Instore::purchase_date(1), '—');
}
reset_case(); $options[LMC_Instore::CURSOR_OPTION] = 'legacy'; $options[LMC_Instore::CURSOR_ID] = 'legacy-id';
LMC_Instore::run();
check('old cursor resumes', LMC_Client::$queries[0]['since'], 'legacy');
check('old cursor tie breaker resumes', LMC_Client::$queries[0]['sinceId'], 'legacy-id');
LMC_Instore::run();
check('new checkpoint replaces legacy', LMC_Client::$queries[1]['since'], 'end');
check('new checkpoint pair used', LMC_Client::$queries[1]['sinceId'], 'two');
$options[LMC_Instore::CHECKPOINT] = ['since' => 'old-branch-end', 'id' => 'old-id', 'branch' => 'different'];
LMC_Instore::run();
check('late writer from old branch cannot skip new branch feed', isset(LMC_Client::$queries[2]['since']), false);
echo "$seen assertions passed\n";
