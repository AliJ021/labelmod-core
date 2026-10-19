#!/usr/bin/env python3
"""رقابت‌های صف بحرانی با درهم‌آمیزی کنترل‌شده (بازبینی ریشه روی PR183). فقط دادهٔ مصنوعی.

    python3 run_queue_race.py <wp-root> <plugin-dir> <label> <wp-cli.phar> <lab-dir> [scenario...]

مانع روی **پرسش SQL واقعی** است (mu-queue-probe.php)، پس همان نقطه در نسخهٔ پیش و پس از اصلاح سنجیده می‌شود:
  enqueue_race     دو فراخوان هم‌زمان «صف کن» برای یک کار منطقی؛ هر کدام پس از پرسش «معلق هست؟» و پیش از درج می‌ایستد.
  crash_lost       بازیابی هم‌زمان دو کار متفاوت، چهار دور؛ آیا شمارندهٔ کار اول گم می‌شود و سقف را دور می‌زند؟
  dead_lost        سومین شکست هم‌زمان دو کار متفاوت؛ آیا هر دو ثبت مرده می‌مانند؟
  exec_overlap     دو سطر AS برای یک سفارش و دو اجراکننده؛ تلاش اول کند و ۵۰۳، دوم موفق.
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


def actor(*args, e=None):
    out = subprocess.run(['php', ACTOR, WP, *map(str, args)], capture_output=True, text=True, env=e or env(), timeout=120)
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
    end = time.time() + 40
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


SCENARIOS = {'enqueue_race': enqueue_race, 'crash_lost': crash_lost, 'dead_lost': dead_lost, 'exec_overlap': exec_overlap}
link()
for name in (sys.argv[6:] or SCENARIOS):
    SCENARIOS[name]()
