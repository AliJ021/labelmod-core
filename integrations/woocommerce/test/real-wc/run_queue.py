#!/usr/bin/env python3
"""آزمایشگاه صف بحرانی روی وردپرس ۷٫۰٫۷ + ووکامرس ۱۱٫۱٫۱ + MariaDB محلی. فقط دادهٔ مصنوعی.

    python3 run_queue.py <wp-root> <plugin-new> <plugin-old> <wp-cli.phar> <lab-dir> > result.jsonl

Core جعلی (mu-queue.php) هر POST سفارش را با زمان میلی‌ثانیه ثبت می‌کند. «تأخیر صف» = زمان POST به Core
منهای زمان پیش از payment_complete — یعنی درج کار، برداشتن، اجرای Handler تا ارسال HTTP. WP-Cron در این
نصب خاموش است (DISABLE_WP_CRON)، پس فقط اجراکنندهٔ اختصاصی WP-CLI سنجیده می‌شود، نه مسیر kick.
"""
import json, os, random, signal, subprocess, sys, time

WP, NEW, OLD, CLI, LAB = sys.argv[1:6]
HERE = os.path.dirname(os.path.abspath(__file__))
ACTOR = os.path.join(HERE, 'queue-actor.php')
CORE = os.path.join(LAB, 'core.jsonl')
MODE = os.path.join(LAB, 'mode.json')
ENV = dict(os.environ, LMC_QUEUE_LAB=LAB)


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def actor(*args, env=None):
    out = subprocess.run(['php', ACTOR, WP, *map(str, args)], capture_output=True, text=True, env=env or ENV, timeout=600)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-2000:])
    return [json.loads(l) for l in out.stdout.splitlines() if l.startswith('{')]


def link(plugin):
    os.replace(make_link(plugin), os.path.join(WP, 'wp-content/plugins/labelmod-connector'))


def make_link(plugin):
    tmp = os.path.join(WP, 'wp-content/plugins/.lmc-link')
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(plugin, tmp)
    return tmp


def reset(mode):
    for f in os.listdir(LAB):
        os.unlink(os.path.join(LAB, f))
    with open(MODE, 'w') as fh:
        json.dump(mode, fh)
    return actor('setup')[0]


def core_rows():
    if not os.path.exists(CORE):
        return []
    with open(CORE) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def wait_core(n, timeout):
    end = time.time() + timeout
    while time.time() < end:
        rows = core_rows()
        if len(rows) >= n:
            return rows
        time.sleep(0.05)
    return core_rows()


def runner(idle=200, max_runtime=900, env=None):
    cmd = ['php', CLI, '--allow-root', f'--path={WP}', 'labelmod', 'queue', 'run', '--loop',
           f'--idle-ms={idle}', f'--max-runtime={max_runtime}']
    err = open(os.path.join(os.path.dirname(LAB.rstrip('/')), f'runner-{time.time_ns()}.err'), 'w')
    return subprocess.Popen(cmd, env=env or ENV, stdout=subprocess.DEVNULL, stderr=err, start_new_session=True)


def stop(p, sig=signal.SIGTERM):
    if p.poll() is None:
        os.killpg(p.pid, sig)
    p.wait(timeout=30)


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q / 100 * (len(xs) - 1))))]


def latency(name, n, gap, runners=1, idle=200):
    reset({})
    procs = [runner(idle) for _ in range(runners)]
    time.sleep(2)  # بوت وردپرس در اجراکننده
    orders = actor('orders', n, gap)
    rows = wait_core(n, 120)
    for p in procs:
        stop(p)
    enq = {str(o['id']): o['t_enq'] for o in orders}
    first = {}
    for r in rows:
        first.setdefault(r['ext'], r['t'])
    lat = [first[e] - enq[e] for e in enq if e in first]
    posts = {}
    for r in rows:
        posts[r['ext']] = posts.get(r['ext'], 0) + 1
    states = actor('state', *enq.keys())
    slow = sorted(((first[e] - enq[e], e) for e in enq if e in first), reverse=True)[:3]
    emit(scenario=name, orders=n, runners=runners, idle_ms=idle, max_gap_ms=gap, posted=len(first),
         duplicate_posts=sum(v - 1 for v in posts.values()), invoiced=sum(1 for s in states if s['invoice']),
         p50_ms=pct(lat, 50), p95_ms=pct(lat, 95), p99_ms=pct(lat, 99), max_ms=max(lat),
         checkout_hook_p50_ms=pct([o['pc_ms'] for o in orders], 50), checkout_hook_p95_ms=pct([o['pc_ms'] for o in orders], 95),
         slowest=[{'order': e, 'ms': ms, 'pids': sorted({r['pid'] for r in rows if r['ext'] == e})} for ms, e in slow])


def backlog(n):
    # کار انباشته بی اجراکننده، بعد یک اجراکننده: زمان تخلیه (بی خواب میان کارها).
    reset({})
    orders = actor('orders', n, 0)
    t0 = time.time()
    p = runner(idle=200)
    rows = wait_core(n, 300)
    t1 = time.time()
    stop(p)
    emit(scenario='backlog_drain', orders=n, posted=len({r['ext'] for r in rows}), drain_s=round(t1 - t0, 2),
         per_order_ms=round((t1 - t0) * 1000 / max(1, len(rows)), 1), note='شامل بوت وردپرس در اجراکننده')


def kill_restart(name, recover=True):
    reset({'*': ['hang', 'ok']})
    p = runner()
    time.sleep(2)
    oid = str(actor('orders', 1, 0)[0]['id'])
    end = time.time() + 60
    while not os.path.exists(os.path.join(LAB, f'hang.{oid}.reached')) and time.time() < end:
        time.sleep(0.05)
    stop(p, signal.SIGKILL)  # پس از ثبت درخواست در Core و پیش از ذخیرهٔ فاکتور
    killed = actor('state', oid)[0]
    time.sleep(16)
    env = dict(ENV, LMC_QUEUE_FAILURE_PERIOD='15')
    if not recover:
        env['LMC_QUEUE_NO_RECOVER'] = '1'
    p = runner(env=env)
    time.sleep(5)
    after_restart = actor('state', oid)[0]
    actor('due', oid)  # Backoff بازیابی (۳۰ تا ۶۰ ثانیه) همین حالا سررسید شود
    rows = wait_core(2, 20)
    time.sleep(1)
    stop(p)
    final = actor('state', oid)[0]
    mine = [r for r in rows if r['ext'] == oid]
    emit(scenario=name, order=oid, recover_hooks=recover,
         killed_status=[a['status'] for a in killed['actions']], after_restart=[(a['status'], int(a['due_in'])) for a in after_restart['actions']],
         final_status=[a['status'] for a in final['actions']], posts=len(mine), same_body=len({r['body'] for r in mine}) == 1,
         invoice=final['invoice'], dead=final['dead'])


def kill_old():
    # کنترل منفی با افزونهٔ main (WP-Cron، +۱۰ ثانیه): کشتن همان نقطه.
    link(OLD)
    try:
        reset({'*': ['hang', 'ok']})
        oid = str(actor('orders', 1, 0)[0]['id'])
        before = actor('state', oid)[0]
        cmd = ['php', CLI, '--allow-root', f'--path={WP}', 'cron', 'event', 'run', 'lmc_send_order']
        p = subprocess.Popen(cmd, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        end = time.time() + 60
        while not os.path.exists(os.path.join(LAB, f'hang.{oid}.reached')) and time.time() < end:
            time.sleep(0.05)
        stop(p, signal.SIGKILL)
        time.sleep(16)
        subprocess.run(['php', CLI, '--allow-root', f'--path={WP}', 'cron', 'event', 'run', '--due-now'], env=ENV,
                       capture_output=True, timeout=120)
        final = actor('state', oid)[0]
        emit(scenario='kill_restart_old_wp_cron', order=oid, cron_before_kill=bool(before['cron']),
             cron_after=bool(final['cron']), posts=len([r for r in core_rows() if r['ext'] == oid]),
             invoice=final['invoice'])
    finally:
        link(NEW)


def retry_after(code, seconds):
    reset({'*': [f'{code}:{seconds}', 'ok']})
    p = runner()
    time.sleep(2)
    oid = str(actor('orders', 1, 0)[0]['id'])
    wait_core(1, 30)
    time.sleep(0.5)
    mid = actor('state', oid)[0]
    pending = [int(a['due_in']) for a in mid['actions'] if a['status'] == 'pending']
    actor('due', oid)
    rows = wait_core(2, 20)
    time.sleep(0.5)
    stop(p)
    final = actor('state', oid)[0]
    emit(scenario=f'retry_after_{code}', retry_after=seconds, attempts_after_first=mid['attempts'], next_due_in_s=pending,
         posts=len(rows), invoice=final['invoice'])


def bounded():
    reset({'*': ['503:0']})
    p = runner()
    time.sleep(2)
    oid = str(actor('orders', 1, 0)[0]['id'])
    for k in range(1, 7):
        wait_core(k, 30)
        time.sleep(0.5)
        actor('due', oid)
    time.sleep(3)
    actor('due', oid)
    time.sleep(2)
    stop(p)
    final = actor('state', oid)[0]
    emit(scenario='bounded_503', posts=len(core_rows()), attempts=final['attempts'], stopped=final['stopped'],
         pending=[a for a in final['actions'] if a['status'] == 'pending'], invoice=final['invoice'])


SCENARIOS = {
    'latency_idle200': lambda: latency('latency_runner_idle200', 200, 300),
    'latency_idle500': lambda: latency('latency_runner_idle500_default', 100, 300, idle=500),
    'latency_two_runners': lambda: latency('latency_two_runners', 200, 50, runners=2),
    'backlog': lambda: backlog(100),
    'kill_restart': lambda: kill_restart('kill_restart_new'),
    'kill_restart_no_recover': lambda: kill_restart('kill_restart_new_no_recover_negative', recover=False),
    'kill_old': kill_old,
    'retry_after_503': lambda: retry_after(503, 120),
    'retry_after_429': lambda: retry_after(429, 90),
    'bounded': bounded,
}
link(NEW)
for name in (sys.argv[6:] or SCENARIOS):
    SCENARIOS[name]()
