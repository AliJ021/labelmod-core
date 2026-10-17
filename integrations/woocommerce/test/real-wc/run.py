#!/usr/bin/env python3
"""
بازتولید interleavingهای بازبینی root روی 757a1c4 با پردازه‌های واقعی PHP، وردپرس ۷٫۰٫۷،
ووکامرس ۱۱٫۱٫۱ و MariaDB محلی — فقط دادهٔ مصنوعی.

  run.py <work-dir> <plugins-dir-with-old-and-new> [old|new ...]

هر سناریو دو پردازهٔ هم‌زمان دارد:
  L  = نوشتن دفتر ما (عکس Core، مسیر Pull)
  W  = نوشتن خود ووکامرس (کسر سفارش یا ویرایش دستی تعداد قلم)
و با SIGKILL در همان نقطه‌هایی که بازبینی نام برد می‌کشد. «درست» = موجودی Core − کسرهای واقعی.
"""
import json, os, signal, subprocess, sys, time

WORK, PLUGINS = sys.argv[1], sys.argv[2]
VERSIONS = sys.argv[3:] or ['old', 'new']
WP = os.path.join(WORK, 'wp')
ACTOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'actor.php')
BAR = os.path.join(WORK, 'bar')

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
        if time.time() - t > timeout: raise SystemExit(f'timeout waiting {role}.{stage}')
        time.sleep(0.02)
    return True

def go(role, stage): open(os.path.join(BAR, f'{role}.{stage}.go'), 'w').close()

def kill(p):
    if p.poll() is None: p.send_signal(signal.SIGKILL); p.wait()

def stock(pid): return run('read', pid)['stock']

def fresh_bar():
    os.makedirs(BAR, exist_ok=True)
    for f in os.listdir(BAR):
        if f.endswith(('.reached', '.go', '.log')): os.unlink(os.path.join(BAR, f))

def pre(version): return 'probe_pending_read' if version == 'new' else 'old_before_save'
def saved(version): return 'after_set_stock' if version == 'new' else 'old_after_save'

def scenario_reduce(version, l_pause=None):
    """L نوشتن را آغاز کرده (کسرها خوانده شده)؛ W نیت ثبت و `_stock` را کم می‌کند و پیش از
    `_reduced_stock` می‌ایستد؛ L می‌نویسد و درست پس از نوشتن کشته می‌شود؛ بعد W هم می‌میرد."""
    fresh_bar(); p = run('prep', 1); pid, order = p['pid'], p['order']
    core, truth = 12, 11                                    # Core: رسید خرید +۲ (۱۰→۱۲)؛ سفارش ۱ تأییدنشده
    l_pause = l_pause or pre(version)
    L = start('L', [l_pause, saved(version)], 'apply', pid, core, 11)
    reached('L', l_pause)
    W = start('W', ['after_set_stock'], 'reduce', order)
    reached('W', 'after_set_stock')
    go('L', l_pause)
    wrote = reached('L', saved(version), L)
    obs = {'after_L_write': stock(pid)}
    kill(L); obs['L_killed'] = stock(pid)
    kill(W); obs['W_killed_before_hook'] = stock(pid)
    r = run('apply', pid, core, 12); obs['next_snapshot'] = stock(pid); obs['next_snapshot_result'] = {k: r.get(k) for k in ('applied', 'busy', 'note')}
    return {'truth': truth, 'L_wrote': wrote, **obs}

def scenario_adjust(version):
    """سفارش ۱ تأییدشده؛ مدیر تعداد قلم را ۳ می‌کند (ووکامرس ۲ کم می‌کند و پیش از `_reduced_stock`
    می‌ایستد)؛ L هم‌زمان می‌نویسد و پس از نوشتن کشته می‌شود؛ بعد W هم می‌میرد."""
    fresh_bar(); p = run('prep', 1); pid, order = p['pid'], p['order']
    run('reduce', order); run('ack', order, 11, 1); run('apply', pid, 9, 11)
    core, truth = 11, 9                                     # Core ۱۱ (رسید +۲)، قلم: ۱ در Core، ۲ تازه
    L = start('L', [pre(version), saved(version)], 'apply', pid, core, 12)
    reached('L', pre(version))
    W = start('W', ['after_set_stock'], 'adjust', order, 3)
    reached('W', 'after_set_stock')
    go('L', pre(version))
    wrote = reached('L', saved(version), L)
    obs = {'after_L_write': stock(pid)}
    kill(L); obs['L_killed'] = stock(pid)
    kill(W); obs['W_killed_before_meta'] = stock(pid)
    r = run('apply', pid, core, 13); obs['next_snapshot'] = stock(pid); obs['next_snapshot_result'] = {k: r.get(k) for k in ('applied', 'busy', 'note')}
    return {'truth': truth, 'L_wrote': wrote, **obs}

results = {}
for v in VERSIONS:
    use(v)
    results[f'{v}/reduce'] = scenario_reduce(v)
    results[f'{v}/adjust'] = scenario_adjust(v)
    if v == 'new':
        results['new/reduce(I,D between S and P)'] = scenario_reduce(v, 'probe_stock_read')
over = []
for name, r in results.items():
    vals = [r[k] for k in r if k not in ('truth', 'L_wrote', 'next_snapshot_result')]
    worst = max(vals)
    if worst > r['truth']: over.append(name)
    print(json.dumps({'scenario': name, **r, 'max_seen': worst, 'over_truth': worst > r['truth']}, ensure_ascii=False))
print(json.dumps({'over_truth_in': over}, ensure_ascii=False))
