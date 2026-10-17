#!/usr/bin/env python3
"""
بازتولید interleavingهای بازبینی root با پردازه‌های واقعی PHP، وردپرس ۷٫۰٫۷، ووکامرس ۱۱٫۱٫۱ و
MariaDB محلی (InnoDB) — فقط دادهٔ مصنوعی.

  run.py <work-dir> <plugins-dir> [نسخه ...]      نسخه‌ها: 757a1c4 · bbae0d1 · new

<plugins-dir>/<نسخه> افزونه در همان commit است. هر سناریو دو پردازهٔ هم‌زمان دارد:
  L  = نشاندن عکس Core (مسیر Pull) که در مرحلهٔ «پیش» می‌ایستد؛
  W  = نوشتن خود ووکامرس: کسر پرداخت، ویرایش دستی (بالا/پایین)، لغو، یا برگرداندن کالای استرداد.
W در همان حال اجرا می‌شود و پس از تغییر `_stock` و پیش از `_reduced_stock`/Hook می‌ایستد. اگر نرسد و
زنده باشد، پشت قفل سطر `_stock` مانده است («blocked»). بعد L ادامه می‌دهد، پس از نوشتن SIGKILL
می‌خورد، و W یا کامل می‌شود یا SIGKILL می‌خورد. «درست» = Core − کسرهایی که ووکامرس واقعاً زده.
"""
import json, os, signal, subprocess, sys, time

WORK, PLUGINS = sys.argv[1], sys.argv[2]
VERSIONS = sys.argv[3:] or ['bbae0d1', 'new']
WP = os.path.join(WORK, 'wp')
ACTOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'actor.php')
BAR = os.path.join(WORK, 'bar')

# مرحلهٔ «پیش» (L ایستاده؛ کسرها یا `_stock` خوانده شده) و «پس از نوشتن» هر نسخه.
STAGES = {
    '757a1c4': ('old_before_save', 'old_after_save'),        # مطلق از PHP، پیش/پس از save
    'bbae0d1': ('probe_stock_read', 'after_set_stock'),      # تفاضل: `_stock` خوانده شد / تفاضل نشست
    'new':     ('probe_locked', 'probe_committed'),          # سطر قفل شد / Commit شد
}

def use(version):
    link = os.path.join(WP, 'wp-content/plugins/labelmod-connector')
    if os.path.islink(link): os.unlink(link)
    os.symlink(os.path.join(PLUGINS, version), link)

def run(*args):
    out = subprocess.run(['php', ACTOR, WP, *map(str, args)], capture_output=True, text=True, timeout=120)
    lines = [l for l in out.stdout.splitlines() if l.startswith('{')]
    return json.loads(lines[-1]) if lines else {'raw': out.stdout[-300:], 'err': out.stderr[-300:]}

def start(role, pause, *args):
    env = dict(os.environ, LMC_ROLE=role, LMC_PAUSE=','.join(pause), LMC_BAR=BAR)
    # خروجی به فایل، نه Pipe: Pipeِ خوانده‌نشده با هشدارهای وردپرس پر می‌شود و پردازه را می‌خواباند.
    log = open(os.path.join(BAR, f'{role}.log'), 'w')
    return subprocess.Popen(['php', ACTOR, WP, *map(str, args)], env=env, stdout=log, stderr=subprocess.STDOUT)

def reached(role, stage, proc=None, timeout=60):
    f = os.path.join(BAR, f'{role}.{stage}.reached'); t = time.time()
    while not os.path.exists(f):
        if proc is not None and proc.poll() is not None: return False
        if time.time() - t > timeout: return None
        time.sleep(0.02)
    return True

def go(role, stage): open(os.path.join(BAR, f'{role}.{stage}.go'), 'w').close()

def kill(p):
    if p.poll() is None: p.send_signal(signal.SIGKILL); p.wait()

def last_json(role):
    lines = [l for l in open(os.path.join(BAR, f'{role}.log')).read().splitlines() if l.startswith('{')]
    return json.loads(lines[-1]) if lines else None

def stock(pid): return run('read', pid)['stock']

def wc_changed(role='W'): return os.path.exists(os.path.join(BAR, f'{role}.wc_changed'))

def fresh_bar():
    os.makedirs(BAR, exist_ok=True)
    for f in os.listdir(BAR):
        if f.endswith(('.reached', '.go', '.log', '.wc_changed')): os.unlink(os.path.join(BAR, f))

# (تعداد سفارش، آماده‌سازی پس از prep، core عکس L، فرمان W، درستِ پیش و پس از تغییر `_stock` ووکامرس)
KINDS = {
    'reduce':      dict(qty=1, reduced=False, core=12, w=lambda o: ('reduce', o),    before=12, after=11),
    'adjust_up':   dict(qty=1, reduced=True, acked=True, core=11, w=lambda o: ('adjust', o, 3), before=11, after=9),
    'cancel':      dict(qty=2, reduced=True, core=10, w=lambda o: ('cancel', o),     before=8, after=10),
    'refund':      dict(qty=2, reduced=True, core=10, w=lambda o: ('refund', o, 1),  before=8, after=9),
    'adjust_down': dict(qty=2, reduced=True, core=10, w=lambda o: ('adjust', o, 1),  before=8, after=9),
}

def scenario(version, kind, w_end):
    """w_end: 'through' (W کامل، وقتی L ایستاده)، 'complete' (W پس از تغییر `_stock` می‌ایستد و پس از
    نوشتن L کامل می‌شود) یا 'crash' (همان، ولی W پیش از `_reduced_stock`/Hook کشته می‌شود)."""
    k = KINDS[kind]; pre, post = STAGES[version]
    fresh_bar(); p = run('prep', k['qty']); pid, order = p['pid'], p['order']
    if k['reduced']: run('reduce', order)
    if k.get('acked'): run('ack', order, 11, k['qty']); run('apply', pid, 9, 11)
    L = start('L', [pre, post], 'apply', pid, k['core'], 20)
    if not reached('L', pre, L): return {'error': 'L به مرحلهٔ پیش نرسید', 'log': open(os.path.join(BAR, 'L.log')).read()[-400:]}
    obs = []                                              # (نام، عدد، آیا ووکامرس `_stock` را عوض کرده)
    def see(name): obs.append((name, stock(pid), wc_changed()))
    W = start('W', [] if w_end == 'through' else ['after_set_stock'], *k['w'](order))
    if w_end == 'through':
        # بازتولید دقیق root: ووکامرس تا پایان (تغییر `_stock`، `_reduced_stock`، Hook) اجرا می‌شود
        # در حالی که L میان خواندن‌هایش ایستاده؛ Hook پس از مهلت قفل کالا «دوباره» می‌گذارد.
        try: W.wait(timeout=30)
        except subprocess.TimeoutExpired: pass
        see('while_L_paused'); waiting = W.poll() is None
        go('L', pre); wrote = bool(reached('L', post, L, timeout=60)); see('after_L_write')
        kill(L); see('L_killed')
        W.wait(timeout=90); see('W_completed')
        r = run('apply', pid, k['core'], 21); see('next_snapshot')
        over = [f'{n}={v}>{k["after"] if c else k["before"]}' for n, v, c in obs if v > (k['after'] if c else k['before'])]
        return {'truth_before_after': [k['before'], k['after']], 'W_waited_on_L': waiting, 'L_wrote': wrote,
                'seen': {n: [v, c] for n, v, c in obs}, 'over': over, 'over_truth': bool(over),
                'next_snapshot_result': {x: r.get(x) for x in ('applied', 'busy', 'note')}}
    # بیش از LOCK_WAIT (۱۰ ثانیه): Hook ذخیرهٔ قلم ووکامرس پشت قفل کالای L می‌ماند و پس از مهلت
    # «دوباره» می‌گذارد و ادامه می‌دهد — همان interleaving بازبینی root (ووکامرس وسط کار L می‌نویسد).
    w_at = reached('W', 'after_set_stock', W, timeout=14)
    waiting = w_at is None and W.poll() is None           # هنوز پشت قفل سطر `_stock`
    see('while_L_paused')
    go('L', pre)
    wrote = bool(reached('L', post, L, timeout=30))
    see('after_L_write')
    kill(L); see('L_killed')
    if not w_at: w_at = reached('W', 'after_set_stock', W, timeout=30)
    see('W_after_stock_change')
    if w_end == 'crash':
        kill(W); see('W_killed_before_hook')
    else:
        go('W', 'after_set_stock'); W.wait(timeout=60); see('W_completed')
    r = run('apply', pid, k['core'], 21)
    see('next_snapshot')
    # «درست» در هر لحظه: پیش از تغییر واقعی `_stock` ووکامرس، before؛ پس از آن، after.
    over = [f'{n}={v}>{k["after"] if c else k["before"]}' for n, v, c in obs if v > (k['after'] if c else k['before'])]
    return {'truth_before_after': [k['before'], k['after']], 'W_waited_on_L': waiting, 'L_wrote': wrote,
            'seen': {n: [v, c] for n, v, c in obs}, 'over': over, 'over_truth': bool(over),
            'next_snapshot_result': {x: r.get(x) for x in ('applied', 'busy', 'note')}}

def scenario_kill_in_tx(version):
    """نسخهٔ تازه: L درون تراکنش (پس از قفل سطر) کشته می‌شود؛ Rollback و آزادشدن قفل."""
    pre, _ = STAGES[version]
    fresh_bar(); p = run('prep', 2); pid, order = p['pid'], p['order']; run('reduce', order)
    L = start('L', [pre], 'apply', pid, 10, 20); reached('L', pre, L)
    W = start('W', [], 'cancel', order)
    time.sleep(2); obs = {'W_blocked_by_row_lock': W.poll() is None, 'while_L_paused': stock(pid)}
    kill(L); W.wait(timeout=60); obs['after_L_killed_and_W_done'] = stock(pid)
    run('apply', pid, 10, 21); obs['next_snapshot'] = stock(pid)
    return {'truth': 10, **obs, 'over_truth': max(v for v in obs.values() if not isinstance(v, bool)) > 10}

def scenario_reset_inflight(version):
    """L قفل گرفته و ایستاده؛ مدیر «بازنشانی» می‌زند؛ L ادامه می‌دهد. نباید با دورهٔ قبل بنویسد."""
    pre, post = STAGES[version]
    fresh_bar(); p = run('prep', 1); pid = p['pid']
    before = stock(pid)
    L = start('L', [pre], 'apply', pid, 50, 20); reached('L', pre, L)
    rs = run('reset')
    go('L', pre); L.wait(timeout=60)
    return {'stock_before': before, 'reset': rs, 'L_result': last_json('L'), 'stock_after': stock(pid),
            'state_after': run('read', pid).get('holds')}

if __name__ == '__main__':
    results = {}
    for v in VERSIONS:
        use(v)
        for kind in KINDS:
            for end in ('through', 'complete', 'crash'):
                results[f'{v}/{kind}/{end}'] = scenario(v, kind, end)
        if v == 'new':
            results['new/kill_L_inside_tx'] = scenario_kill_in_tx(v)
            results['new/reset_inflight'] = scenario_reset_inflight(v)
    over = []
    for name, r in results.items():
        if r.get('over_truth'): over.append(name)
        print(json.dumps({'scenario': name, **r}, ensure_ascii=False))
    print(json.dumps({'over_truth_in': over}, ensure_ascii=False))
