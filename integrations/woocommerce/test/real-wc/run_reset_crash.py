#!/usr/bin/env python3
"""
مرگ پردازهٔ «بازنشانی» (نه نویسنده) درست پس از Commit دوره، و Pull نسل قبل که مکان‌نمایش را پس از
بازنشانی می‌نویسد — بازبینی root روی 29df1bb. پردازه‌های واقعی PHP، ووکامرس ۱۱٫۱٫۱، MariaDB؛ Core جعلی
محلی (`pre_http_request` در mu-repro). فقط محلی و مصنوعی.

  run_reset_crash.py <work-dir> <plugins-dir> [نسخه ...]

reset-process-killed: عکس ۱۰ (rev 30)، سفارش ۲، ACK rev 31، Pull واقعی ۱۰ (rev 32) با مکان‌نمای C-old؛
بازنشانی(null) در پردازهٔ R پس از Commit دوره SIGKILL می‌خورد (نسخهٔ تازه: probe_reset_committed؛ نسخهٔ قبل:
نخستین probe_locked بازمحاسبه، که پس از UPDATE خودکار دوره است). Core بازیابی‌شده خوراک افزایشی خالی
می‌دهد؛ دور بعد باید Pull کامل (بی since) باشد و عدد ۸ (۱۰ − ۲).
repeat-reset-after-death: پس از مرگ بازنشانی نخست، مدیر دوباره بازنشانی می‌کند؛ پایهٔ بازیابی (حالت دورهٔ ۱) نباید
گم شود و Pull خالی بعدی باید ۸ بماند (بازبینی root روی aa3f966).
late-old-cursor: Pull نسل قبل پس از Commit نوشتنش و پیش از نوشتن مکان‌نما می‌ایستد؛ بازنشانی کامل
می‌شود؛ Pull ادامه می‌دهد و مکان‌نمای نسل قبل را می‌نویسد. دور بعد باید باز هم Pull کامل باشد.
"""
import json, os, sys, time
sys.argv = sys.argv[:3] + (sys.argv[3:] or ['new'])
import run as R

def feed(path, items, cursor):
    with open(path, 'w') as f: json.dump({'items': items, 'cursor': cursor}, f)

def sync(role, feed_path):
    os.environ['LMC_FAKE_FEED'] = feed_path
    try:
        p = R.start(role, [], 'sync'); p.wait(timeout=90)
    finally:
        del os.environ['LMC_FAKE_FEED']
    urls = open(os.path.join(R.BAR, f'{role}.urls')).read().split() if os.path.exists(os.path.join(R.BAR, f'{role}.urls')) else []
    return R.last_json(role), urls

def base(version):
    R.use(version); R.fresh_bar()
    for f in os.listdir(R.BAR):
        if f.endswith('.urls'): os.unlink(os.path.join(R.BAR, f))
    p = R.run('prep', 2); pid, order = p['pid'], p['order']
    R.run('apply', pid, 10, 30); R.run('reduce', order); R.run('ack', order, 31, 2)
    vid = R.run('state', pid)['vid']
    f = os.path.join(R.BAR, 'feed-old.json'); feed(f, [{'variationId': vid, 'available': '10', 'stockRev': '32'}], 'C-old')
    out, _ = sync('P0', f)
    return pid, vid, out

def reset_killed(version):
    pid, vid, first = base(version)
    obs = {'pull_rev32': first, 'before_reset': R.run('state', pid)}
    RS = R.start('R', ['probe_reset_committed', 'probe_locked'], 'reset')
    stage = None
    t = time.time()
    while stage is None and time.time() - t < 60:
        for s in ('probe_reset_committed', 'probe_locked'):
            if os.path.exists(os.path.join(R.BAR, f'R.{s}.reached')): stage = s
        if RS.poll() is not None: break
        time.sleep(0.02)
    R.kill(RS)
    obs['reset_killed_at'] = stage
    obs['after_kill'] = R.run('state', pid)
    empty = os.path.join(R.BAR, 'feed-empty.json'); feed(empty, [], None)
    out, urls = sync('S1', empty)
    obs['next_sync'] = out; obs['next_sync_sent_since'] = any('since=' in u for u in urls)
    obs['after_next_sync'] = R.run('state', pid)
    restored = os.path.join(R.BAR, 'feed-restored.json'); feed(restored, [{'variationId': vid, 'available': '10', 'stockRev': '1'}], 'N1')
    out2, urls2 = sync('S2', restored)
    obs['restored_pull'] = out2; obs['after_restored_pull'] = R.run('state', pid)
    obs['expected'] = 8
    obs['ok'] = obs['after_next_sync']['stock'] == 8 and not obs['next_sync_sent_since'] and obs['after_restored_pull']['stock'] == 8
    return obs

def late_old_cursor(version):
    pid, vid, first = base(version)
    f = os.path.join(R.BAR, 'feed-late.json'); feed(f, [{'variationId': vid, 'available': '10', 'stockRev': '33'}], 'C-late')
    os.environ['LMC_FAKE_FEED'] = f
    try:
        L = R.start('L', ['probe_committed'], 'sync')
    finally:
        del os.environ['LMC_FAKE_FEED']
    if not R.reached('L', 'probe_committed', L): return {'error': 'L نرسید', 'log': open(os.path.join(R.BAR, 'L.log')).read()[-300:]}
    rs = R.run('reset')
    R.go('L', 'probe_committed'); L.wait(timeout=60)
    obs = {'reset': rs, 'old_pull': R.last_json('L'), 'after_old_pull': R.run('state', pid)}
    empty = os.path.join(R.BAR, 'feed-empty.json'); feed(empty, [], None)
    out, urls = sync('S3', empty)
    obs['next_sync'] = out; obs['next_sync_sent_since'] = any('since=' in u for u in urls)
    obs['after_next_sync'] = R.run('state', pid)
    obs['expected'] = 8
    obs['ok'] = not obs['next_sync_sent_since'] and obs['after_next_sync']['stock'] == 8
    return obs

def repeat_reset(version):
    """بازنشانی دوم پس از مرگ بازنشانی نخست (بازبینی root روی aa3f966): مدیر دوباره می‌زند و تا پایان می‌رود."""
    pid, vid, first = base(version)
    RS = R.start('R', ['probe_reset_committed', 'probe_locked'], 'reset')
    stage = None; t = time.time()
    while stage is None and time.time() - t < 60:
        for s in ('probe_reset_committed', 'probe_locked'):
            if os.path.exists(os.path.join(R.BAR, f'R.{s}.reached')): stage = s
        if RS.poll() is not None: break
        time.sleep(0.02)
    R.kill(RS)
    obs = {'first_reset_killed_at': stage, 'after_kill': R.run('state', pid)}
    obs['second_reset'] = R.run('reset')
    obs['after_second_reset'] = R.run('state', pid)
    empty = os.path.join(R.BAR, 'feed-empty.json'); feed(empty, [], None)
    out, urls = sync('S4', empty)
    obs['next_sync'] = out; obs['next_sync_sent_since'] = any('since=' in u for u in urls)
    obs['after_next_sync'] = R.run('state', pid)
    obs['expected'] = 8
    obs['ok'] = obs['after_next_sync']['stock'] == 8 and obs['after_next_sync']['intent'] is None and not obs['next_sync_sent_since']
    return obs

if __name__ == '__main__':
    for v in sys.argv[3:]:
        print(json.dumps({'scenario': f'{v}/reset-process-killed', **reset_killed(v)}, ensure_ascii=False))
        print(json.dumps({'scenario': f'{v}/late-old-cursor', **late_old_cursor(v)}, ensure_ascii=False))
        print(json.dumps({'scenario': f'{v}/repeat-reset-after-death', **repeat_reset(v)}, ensure_ascii=False))
