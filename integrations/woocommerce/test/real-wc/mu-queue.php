<?php
/**
 * فقط آزمایشگاه محلی صف (run_queue.py) با دادهٔ مصنوعی — هرگز روی سایت واقعی نصب نشود.
 *
 * Core جعلی برای `POST /api/web/orders`: هر درخواست با زمان میلی‌ثانیه در `<LMC_QUEUE_LAB>/core.jsonl`
 * ثبت می‌شود و پاسخ از `<LMC_QUEUE_LAB>/mode.json` می‌آید: برای هر externalId فهرستی به ترتیب تلاش
 * (`ok`، `503:<retry-after>`، `429:<retry-after>`، `slow503:<ثانیه>`، `hang`). پاسخ ok برای همان externalId همیشه همان
 * فاکتور است — همان Idempotency سرور واقعی. هیچ درخواستی به شبکه نمی‌رود.
 */
$lab = getenv('LMC_QUEUE_LAB');
if (!$lab) { return; }
$lab = rtrim($lab, '/');

add_filter('pre_http_request', static function ($pre, $args, $url) use ($lab) {
    if (!str_contains((string) $url, '/api/web/orders')) { return $pre; }
    $body = json_decode((string) ($args['body'] ?? ''), true);
    $ext = (string) ($body['externalId'] ?? '');
    $log = "$lab/core.jsonl";
    $fh = fopen($log, 'a+');
    flock($fh, LOCK_EX);
    $prior = 0;
    rewind($fh);
    while (($line = fgets($fh)) !== false) {
        $row = json_decode($line, true);
        if (($row['ext'] ?? null) === $ext) { $prior++; }
    }
    $modes = json_decode((string) @file_get_contents("$lab/mode.json"), true) ?: [];
    $plan = $modes[$ext] ?? ($modes['*'] ?? ['ok']);
    $mode = $plan[min($prior, count($plan) - 1)];
    fwrite($fh, json_encode(['ext' => $ext, 't' => (int) round(microtime(true) * 1000), 'pid' => getmypid(),
        'attempt' => $prior + 1, 'mode' => $mode, 'body' => md5((string) ($args['body'] ?? ''))]) . "\n");
    flock($fh, LOCK_UN);
    fclose($fh);
    if ($mode === 'hang') {
        touch("$lab/hang.$ext.reached");
        sleep(600);
    }
    if (preg_match('/^slow503:(\d+)$/', $mode, $m)) {
        sleep((int) $m[1]);
        $mode = '503:0';
    }
    if (preg_match('/^(503|429):(\d+)$/', $mode, $m)) {
        return ['headers' => ['retry-after' => $m[2]], 'body' => json_encode(['error' => ['code' => 'busy', 'message' => 'آزمایشگاه: مشغول']]),
            'response' => ['code' => (int) $m[1], 'message' => 'busy'], 'cookies' => [], 'filename' => null];
    }
    return ['headers' => [], 'body' => json_encode(['invoiceId' => 'inv-' . $ext, 'number' => 'W-' . $ext, 'payableAmount' => (string) ($body['paidAmount'] ?? '')]),
        'response' => ['code' => 201, 'message' => 'Created'], 'cookies' => [], 'filename' => null];
}, 10, 3);

// زمان failed شدن کار پردازهٔ کشته‌شده (پیش‌فرض واقعی ۳۰۰ ثانیه) فقط برای کوتاه‌شدن آزمایش.
if (getenv('LMC_QUEUE_FAILURE_PERIOD')) {
    add_filter('action_scheduler_failure_period', static fn() => (int) getenv('LMC_QUEUE_FAILURE_PERIOD'));
}
// کنترل منفی: بازیابی شکست غیرمنتظره خاموش.
if (getenv('LMC_QUEUE_NO_RECOVER')) {
    add_action('plugins_loaded', static function () {
        remove_action('action_scheduler_failed_execution', ['LMC_Queue', 'on_failed_execution'], 10);
        remove_action('action_scheduler_failed_action', ['LMC_Queue', 'on_failed'], 10);
        remove_action('action_scheduler_unexpected_shutdown', ['LMC_Queue', 'on_failed'], 10);
    }, 100);
}
// ایمیل سفارش در آزمایشگاه فرستاده نمی‌شود (sendmail نیست و زمان payment_complete را آلوده می‌کرد).
add_filter('pre_wp_mail', '__return_false');
