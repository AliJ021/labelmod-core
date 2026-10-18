#!/usr/bin/env python3
"""
بازنشانی **پس از** سنجش دوره و خواندن کسرها، پیش از UPDATE/COMMIT (بازبینی root روی c5d9623)، با دو پردازهٔ
واقعی PHP روی MariaDB. فقط محلی و مصنوعی.

  run_reset.py <work-dir> <plugins-dir> [نسخه ...]

L: عکس نسل قبل (۱۰، rev 32) که ACK سفارش (rev 31) را دارد، در `probe_pending_read` می‌ایستد.
R: «بازنشانی» در پردازهٔ دیگر (Core پیش از آن سفارش بازیابی شده). درست پس از هر دو: ۸ (۱۰ − ۲، ACK دورهٔ
قبل اعتبار ندارد). حالت crash: L درون تراکنش SIGKILL می‌خورد؛ Rollback، و بازنشانی از حالت Commitشدهٔ قبلی.
"""
import json, os, subprocess, sys, time
sys.argv = sys.argv[:3] + (sys.argv[3:] or ['new'])
import run as R

def scenario(version, crash):
    R.use(version); R.fresh_bar()
    p = R.run('prep', 2); pid, order = p['pid'], p['order']
    R.run('apply', pid, 10, 30); R.run('reduce', order); R.run('ack', order, 31, 2)
    obs = {'before': R.stock(pid)}
    L = R.start('L', ['probe_pending_read'], 'apply', pid, 10, 32)
    if not R.reached('L', 'probe_pending_read', L): return {'error': 'L نرسید', 'log': open(os.path.join(R.BAR, 'L.log')).read()[-300:]}
    RS = R.start('R', [], 'reset')
    time.sleep(3)
    obs['reset_waited_for_writer'] = RS.poll() is None
    if crash: R.kill(L)
    else: R.go('L', 'probe_pending_read'); L.wait(timeout=60)
    RS.wait(timeout=60)
    obs['L_result'] = None if crash else R.last_json('L')
    obs['reset'] = R.last_json('R')
    obs['after'] = R.stock(pid)
    obs['expected'] = 8
    obs['ok'] = obs['after'] == 8
    return obs

if __name__ == '__main__':
    for v in sys.argv[3:]:
        for crash in (False, True):
            print(json.dumps({'scenario': f'{v}/reset-after-check' + ('/L-killed-in-tx' if crash else ''), **scenario(v, crash)}, ensure_ascii=False))
