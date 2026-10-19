<?php
/**
 * فقط آزمایشگاه محلی (run_queue_race.py) — هرگز روی سایت واقعی نصب نشود.
 *
 * مانع فایلی روی **پرسش SQL واقعی**، نه روی کد افزونه: پس همان نقطه در نسخهٔ پیش و پس از اصلاح
 * سنجیده می‌شود. پردازه با LMC_QROLE و LMC_QPAUSE (فهرست مرحله) اجرا می‌شود؛ در مرحله فایل
 * «reached» می‌سازد و تا فایل «go» صبر می‌کند.
 *   enqueue_insert درج سطر Action Scheduler پس از پرسش «کار معلق هست؟» (پنجرهٔ TOCTOU)
 *   crash_write    نوشتن شمارندهٔ شکست (آرایهٔ مشترک قدیمی یا ردیف هر کار)
 *   dead_write     نوشتن ثبت مرده (آرایهٔ مشترک قدیمی یا ردیف هر کار)
 */
$role = getenv('LMC_QROLE');
if (!$role) { return; }
function lmc_qprobe_barrier(string $stage, string $query = ''): void
{
    static $hit = [];
    $pause = array_filter(explode(',', (string) getenv('LMC_QPAUSE')));
    if (!in_array($stage, $pause, true) || !empty($hit[$stage])) { return; }
    $hit[$stage] = true;
    $dir = rtrim((string) getenv('LMC_QBAR'), '/');
    $role = (string) getenv('LMC_QROLE');
    file_put_contents("$dir/$role.$stage.reached", $query);
    $t = microtime(true);
    while (!file_exists("$dir/$role.$stage.go")) {
        if (microtime(true) - $t > 60) { fwrite(STDERR, "barrier timeout $stage\n"); exit(3); }
        usleep(10000);
    }
}
add_filter('query', static function ($q) {
    if (!is_string($q)) { return $q; }
    $hook = (string) getenv('LMC_QHOOK');
    // مانع «پیش از» اجرای پرسش است؛ پس پنجرهٔ TOCTOU میان پرسش «معلق هست؟» (اجراشده) و درج است.
    if ($hook !== '' && preg_match('/^\s*INSERT\s+INTO\s+\S*actionscheduler_actions\b/i', $q) && str_contains($q, "'" . $hook . "'")) {
        lmc_qprobe_barrier('enqueue_insert', $q);
    }
    // نسخهٔ قدیمی: update_option آرایهٔ مشترک؛ نسخهٔ تازه: ردیف جدا برای هر کار.
    if (preg_match("/^\s*(INSERT|UPDATE)/i", $q) && preg_match("/'(lmc_queue_crashes|lmc_qc_[0-9a-f]+)'/", $q)) {
        lmc_qprobe_barrier('crash_write', $q);
    }
    if (preg_match("/^\s*(INSERT|UPDATE)/i", $q) && preg_match("/'(lmc_queue_dead|lmc_qd_[0-9a-f]+)'/", $q)) {
        lmc_qprobe_barrier('dead_write', $q);
    }
    return $q;
});
