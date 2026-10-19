#!/usr/bin/env python3
"""رقابت‌های صف بحرانی با درهم‌آمیزی کنترل‌شده (بازبینی ریشه روی PR183). فقط دادهٔ مصنوعی.

    python3 run_queue_race.py <wp-root> <plugin-dir> <label> <wp-cli.phar> <lab-dir> [scenario...]

مانع روی **پرسش SQL واقعی** است (mu-queue-probe.php)، پس همان نقطه در نسخهٔ پیش و پس از اصلاح سنجیده می‌شود:
  enqueue_race     دو فراخوان هم‌زمان «صف کن» برای یک کار منطقی؛ هر کدام پس از پرسش «معلق هست؟» و پیش از درج می‌ایستد.
  crash_lost       بازیابی هم‌زمان دو کار متفاوت، چهار دور؛ آیا شمارندهٔ کار اول گم می‌شود و سقف را دور می‌زند؟
  dead_lost        سومین شکست هم‌زمان دو کار متفاوت؛ آیا هر دو ثبت مرده می‌مانند؟
  exec_overlap     دو سطر AS برای یک سفارش و دو اجراکننده؛ تلاش اول کند و ۵۰۳، دوم موفق.
بازبینی دوم ریشه — تزریق شکست روی پایگاه دادهٔ واقعی (ادعای هم‌زمانی تازه نیست):
  lock_timeout     پردازهٔ دیگری قفل صف همان کار را دارد؛ enqueue نباید درج کند، نشان معوق، drain پس از آزادی.
  lock_sql_error   GET_LOCK خطای SQL؛ نشان معوق، تا سقف عمر می‌ماند و بعد مرده ثبت می‌شود.
  counter_fail     نوشتن lmc_qc_ ناموفق؛ هیچ تلاش شمرده‌نشده‌ای صف نمی‌شود، مرده counter_write_failed.
  counter_dead_fail نوشتن lmc_qc_ و lmc_qd_ ناموفق؛ نشان معوق، و پس از بهبود drain تصمیم را می‌گیرد.
  all_state_fail   همهٔ نوشتن‌های وضعیت ناموفق؛ تشخیص failedActions صفر نیست.
بازبینی سوم ریشه — همان دو بازتولید و خطای فقط قفل اجرا، روی پایگاه دادهٔ واقعی:
  replay_idempotent یک شکست، نشان «c» زیر قفل گرفته، حذف نشان همیشه ناموفق، سه drain.
  latest_wins       قفل صف گرفته، reschedule ۳۰ و سپس ۹۰۰، آزادسازی، drain.
  exec_lock_error   فقط GET_LOCK قفل اجرا خطای SQL؛ هشت دور اجراکننده.
  busy_owner        مالک واقعی قفل اجرا (پردازهٔ دیگر)؛ یک دور اجراکننده — اشغال، نه شکست.
"""
import json, os, signal, subprocess, sys, time

WP, PLUGIN, LABEL, CLI, LAB = sys.argv[1:6]
HERE = os.path.dirname(os.path.abspath(__file__))
ACTOR = os.path.join(HERE, 'queue-actor.php')
BAR = os.path.join(LAB, 'bar')
CORE = os.path.join(LAB, 'core.jsonl')
HOOK = 'lmc_send_refund'


def emit(**kw):
    print(json.dumps(dict(plugin=LABEL, **kw), ensure_ascii=False), flush=True)


def env(role=None, pause=None):
    e = dict(os.environ, LMC_QUEUE_LAB=LAB, LMC_QBAR=BAR, LMC_QHOOK=HOOK)
    if role:
        e.update(LMC_QROLE=role, LMC_QPAUSE=pause or '')
    return e


def actor(*args, e=None, extra=None):
    e = dict(e or env(), **(extra or {}))
    out = subprocess.run(['php', ACTOR, WP, *map(str, args)], capture_output=True, text=True, env=e, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-2000:])
    return [json.loads(l) for l in out.stdout.splitlines() if l.startswith('{')]


def spawn(role, pause, *args):
    return subprocess.Popen(['php', ACTOR, WP, *map(str, args)], env=env(role, pause), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def reached(role, stage, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if os.path.exists(os.path.join(BAR, f'{role}.{stage}.reached')):
            return True
        time.sleep(0.02)
    return False


def go(role, stage):
    open(os.path.join(BAR, f'{role}.{stage}.go'), 'w').close()


def finish(*procs):
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=90)
        if p.returncode != 0:
            raise RuntimeError(err[-2000:])
        outs.append([json.loads(l) for l in out.splitlines() if l.startswith('{')])
    return outs


def link():
    tmp = os.path.join(WP, 'wp-content/plugins/.lmc-link')
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(PLUGIN, tmp)
    os.replace(tmp, os.path.join(WP, 'wp-content/plugins/labelmod-connector'))


def reset(mode=None):
    os.makedirs(BAR, exist_ok=True)
    for d in (LAB, BAR):
        for f in os.listdir(d):
            p = os.path.join(d, f)
            if os.path.isfile(p):
                os.unlink(p)
    with open(os.path.join(LAB, 'mode.json'), 'w') as fh:
        json.dump(mode or {}, fh)
    actor('setup')


def state(*args):
    return {r['arg']: r for r in actor('qstate', HOOK, *args)}


def pair(stage, a_args, b_args):
    """A تا مانع می‌رود؛ B شروع می‌شود؛ آیا B هم به همان مانع می‌رسد وقتی A آنجا ایستاده؟"""
    a = spawn('A', stage, *a_args)
    if not reached('A', stage, 30):
        a.kill(); raise RuntimeError(f'A never reached {stage}: ' + a.communicate()[1][-500:])
    b = spawn('B', stage, *b_args)
    both = reached('B', stage, 3)
    go('A', stage)
    go('B', stage)
    pair.outputs = finish(a, b)
    return both


def enqueue_race():
    reset()
    both = pair('enqueue_insert', ('enqueue', HOOK, 501), ('enqueue', HOOK, 501))
    s = state(501)[501]
    emit(scenario='enqueue_race', b_reached_insert_while_a_paused=both, pending_actions=s['pending'], outputs=pair.outputs)


def crash_lost():
    reset()
    lost_rounds = 0
    trace = []
    for r in range(4):
        a_id = actor('mkfailed', HOOK, 601)[0]['id']
        b_id = actor('mkfailed', HOOK, 700 + r)[0]['id']
        before = state(601)[601]['crashes']
        both = pair('crash_write', ('recover', a_id), ('recover', b_id))
        after = state(601, 700 + r)
        trace.append({'round': r + 1, 'before': before, 'after': after[601]['crashes'], 'dead': after[601]['dead'],
                      'other': after[700 + r]['crashes'], 'pending_first': after[601]['pending']})
        # هر دور باید هر دو افزایش بماند: کار تازهٔ دوم دقیقاً ۱، و کار اول +۱ (یا مرده در سومین).
        first_ok = after[601]['dead'] if r + 1 >= 3 else after[601]['crashes'] == before + 1
        if not first_ok or after[700 + r]['crashes'] != 1:
            lost_rounds += 1
    s = state(601)[601]
    emit(scenario='crash_lost', rounds=4, crashes_of_first_task=s['crashes'], first_task_dead=s['dead'],
         rounds_with_a_lost_increment=lost_rounds, both_at_barrier_last_round=both, trace=trace,
         expected='سقف سه شکست: کار اول پس از دور سوم مرده؛ شمارنده هرگز گم نمی‌شود')


def dead_lost():
    reset()
    for arg in (801, 802):
        for _ in range(2):
            actor('recover', actor('mkfailed', HOOK, arg)[0]['id'])
    a_id = actor('mkfailed', HOOK, 801)[0]['id']
    b_id = actor('mkfailed', HOOK, 802)[0]['id']
    both = pair('dead_write', ('recover', a_id), ('recover', b_id))
    s = state(801, 802)
    emit(scenario='dead_lost', both_at_barrier=both, dead_801=s[801]['dead'], dead_802=s[802]['dead'])


def runner():
    err = open(os.path.join(LAB, f'runner-{time.time_ns()}.err'), 'w')
    return subprocess.Popen(['php', CLI, '--allow-root', f'--path={WP}', 'labelmod', 'queue', 'run', '--loop', '--idle-ms=100',
                             '--max-runtime=120', '--batch=1'], env=env(), stdout=subprocess.DEVNULL, stderr=err, start_new_session=True)


def stop(p):
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
    p.wait(timeout=30)


def exec_overlap():
    # تلاش اول ۴ ثانیه طول می‌کشد و ۵۰۳ می‌گیرد؛ تلاش دوم موفق است.
    reset({'*': ['slow503:4', 'ok']})
    oid = actor('orders', 1, 0)[0]['id']               # payment_complete خودش یک سطر می‌سازد
    actor('raw_enqueue', 'lmc_send_order', oid)        # سطر دوم همان کار منطقی (تکراری)
    r1, r2 = runner(), runner()
    # تلاش دوم پس از Backoff تلاش اول ([۳۰، ۶۰] ثانیه با jitter) می‌آید؛ پنجره هر دو سر بازه را می‌پوشاند.
    end = time.time() + 75
    while time.time() < end and len(core()) < 2:
        time.sleep(0.1)
    time.sleep(6)
    stop(r1); stop(r2)
    rows = [r for r in core() if r['ext'] == str(oid)]
    overlap = len(rows) >= 2 and rows[1]['t'] < rows[0]['t'] + 4000
    st = actor('state', oid)[0]
    emit(scenario='exec_overlap', posts=len(rows), second_post_during_first=overlap,
         modes=[r['mode'] for r in rows], invoice=st['invoice'], attempts=st['attempts'], error_left=st['error'],
         stopped=st['stopped'], pending_after=[a for a in st['actions'] if a['status'] == 'pending'],
         statuses=[a['status'] for a in st['actions']])


def core():
    if not os.path.exists(CORE):
        return []
    with open(CORE) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def health():
    return actor('health')[0]


def markers():
    return actor('markers')[0]['markers']


def lock_timeout():
    reset()
    holder = subprocess.Popen(['php', ACTOR, WP, 'holdlock', 'e', HOOK, '901', '9'], env=env(), stdout=subprocess.PIPE, text=True)
    got = json.loads(holder.stdout.readline())['got']
    t0 = time.time()
    out = actor('enqueue', HOOK, 901)[0]
    waited = round(time.time() - t0, 2)
    during = dict(state=state(901)[901], markers=len(markers()), health=health())
    during['health'].setdefault('deferredTasks', None)
    holder.wait(timeout=30)
    try:
        drained = actor('drain')[0]['settled']
    except RuntimeError:
        drained = None  # نسخهٔ پیش از اصلاح drain ندارد (کنترل منفی)
    after = dict(state=state(901)[901], markers=len(markers()))
    emit(scenario='lock_timeout', holder_got=got, enqueue_returned=out['ok'], enqueue_wait_s=waited,
         pending_while_locked=during['state']['pending'], markers_while_locked=during['markers'],
         deferred_health=during['health']['deferredTasks'], drained=drained,
         pending_after_drain=after['state']['pending'], markers_after_drain=after['markers'])


def lock_sql_error():
    reset()
    fail = {'LMC_QLOCKFAIL': '1'}
    out = actor('enqueue', HOOK, 902, extra=fail)[0]
    first = dict(pending=state(902)[902]['pending'], markers=len(markers()))
    actor('drain', extra=fail)
    second = dict(pending=state(902)[902]['pending'], markers=len(markers()), dead=state(902)[902]['dead'])
    actor('age_markers')
    actor('drain', extra=fail)
    s = state(902)[902]
    emit(scenario='lock_sql_error', enqueue_returned=out['ok'], pending_after_enqueue=first['pending'], markers_after_enqueue=first['markers'],
         after_young_drain=second, after_aged_drain=dict(pending=s['pending'], dead=s['dead'], reason=s['deadReason'], markers=len(markers())),
         health=health())


def counter_fail():
    reset()
    aid = actor('mkfailed', HOOK, 903)[0]['id']
    actor('recover', aid, extra={'LMC_QFAIL': '/lmc_qc_/'})
    s = state(903)[903]
    emit(scenario='counter_fail', crashes=s['crashes'], pending=s['pending'], dead=s['dead'], reason=s['deadReason'],
         markers=len(markers()), health=health())


def counter_dead_fail():
    reset()
    aid = actor('mkfailed', HOOK, 904)[0]['id']
    actor('recover', aid, extra={'LMC_QFAIL': '/lmc_q[cd]_/'})
    s = state(904)[904]
    during = dict(crashes=s['crashes'], pending=s['pending'], dead=s['dead'], markers=len(markers()), health=health())
    actor('drain')
    s = state(904)[904]
    emit(scenario='counter_dead_fail', during=during,
         after_db_recovers=dict(crashes=s['crashes'], pending=s['pending'], dead=s['dead'], markers=len(markers())))


def all_state_fail():
    reset()
    aid = actor('mkfailed', HOOK, 905)[0]['id']
    actor('recover', aid, extra={'LMC_QFAIL': '/lmc_q[cdp]_/'})
    s = state(905)[905]
    emit(scenario='all_state_fail', crashes=s['crashes'], pending=s['pending'], dead=s['dead'], markers=len(markers()), health=health())


def hold(kind, hook, arg, secs):
    p = subprocess.Popen(['php', ACTOR, WP, 'holdlock', kind, hook, str(arg), str(secs)], env=env(), stdout=subprocess.PIPE, text=True)
    return p, json.loads(p.stdout.readline())['got']


def replay_idempotent():
    reset()
    aid = actor('mkfailed', HOOK, 701)[0]['id']
    holder, got = hold('e', HOOK, 701, 14)
    actor('recover_exec', aid)
    holder.wait(timeout=60)
    nomarker = {'LMC_QFAIL': "/DELETE FROM \\S*options WHERE option_name = .lmc_qp_/"}
    trace = []
    for i in range(3):
        actor('drain', extra=nomarker)
        s = state(701)[701]
        trace.append({'drain': i + 1, 'crashes': s['crashes'], 'pending': s['pending'], 'dead': s['dead'], 'markers': len(markers())})
    emit(scenario='replay_idempotent', holder_got=got, trace=trace, statuses=actor('statuses', HOOK, 701)[0]['statuses'])


def latest_wins():
    reset()
    holder, got = hold('e', 'lmc_send_order', 702, 14)
    a = actor('reschedule', 'lmc_send_order', 702, 30)[0]['ok']
    b = actor('reschedule', 'lmc_send_order', 702, 900)[0]['ok']
    before = len(markers())
    holder.wait(timeout=60)
    actor('drain')
    emit(scenario='latest_wins', holder_got=got, returned=[a, b], markers_before_drain=before,
         pending_due_s=actor('pending_due', 'lmc_send_order', 702)[0]['due'], markers_after=len(markers()))


def exec_lock_error():
    reset()
    actor('raw_enqueue', 'lmc_send_order', 703)
    fail = {'LMC_QLOCKFAIL': "/GET_LOCK\\('lmc_qx_/"}
    for _ in range(8):
        actor('runonce', 'lmc_send_order', extra=fail)
    st = actor('qstate', 'lmc_send_order', 703)[0]
    statuses = actor('statuses', 'lmc_send_order', 703)[0]['statuses']
    emit(scenario='exec_lock_error', statuses=statuses, failed=statuses.count('failed'), pending=statuses.count('pending'),
         crashes=st['crashes'], dead=st['dead'], reason=st['deadReason'], markers=len(markers()), health=health())


def busy_owner():
    reset()
    actor('raw_enqueue', 'lmc_send_order', 704)
    holder, got = hold('x', 'lmc_send_order', 704, 60)
    actor('runonce', 'lmc_send_order')
    st = actor('qstate', 'lmc_send_order', 704)[0]
    statuses = actor('statuses', 'lmc_send_order', 704)[0]['statuses']
    h = health()
    holder.kill(); holder.wait(timeout=30)
    emit(scenario='busy_owner', holder_got=got, statuses=statuses, crashes=st['crashes'], dead=st['dead'],
         pending_due_s=actor('pending_due', 'lmc_send_order', 704)[0]['due'], busyTasks=h.get('busyTasks'))


SCENARIOS = {'busy_owner': busy_owner, 'replay_idempotent': replay_idempotent, 'latest_wins': latest_wins, 'exec_lock_error': exec_lock_error,
'lock_timeout': lock_timeout, 'lock_sql_error': lock_sql_error, 'counter_fail': counter_fail,
             'counter_dead_fail': counter_dead_fail, 'all_state_fail': all_state_fail,
             'enqueue_race': enqueue_race, 'crash_lost': crash_lost, 'dead_lost': dead_lost, 'exec_overlap': exec_overlap}
link()
for name in (sys.argv[6:] or SCENARIOS):
    SCENARIOS[name]()
