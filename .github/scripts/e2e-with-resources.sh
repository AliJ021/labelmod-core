#!/usr/bin/env bash
# تشخیص موقت (PR #106): آزمون مرورگر را اجرا می‌کند و هم‌زمان هر ۵ ثانیه حافظه، بار CPU و
# شمار پردازه‌های مرورگر را در RESOURCE_LOG ثبت می‌کند. کد خروج خودِ Playwright برمی‌گردد؛
# این اسکریپت هیچ شکستی را پنهان نمی‌کند.
set -uo pipefail
log="${RESOURCE_LOG:?}"
echo "cpus=$(nproc) $(free -m | awk 'NR==2{print "totalMB="$2}')" > "$log"
(
  while true; do
    mem=$(free -m | awk 'NR==2{print "usedMB="$3" availMB="$7}')
    swap=$(free -m | awk 'NR==3{print "swapUsedMB="$3}')
    echo "$(date -u +%H:%M:%S) $mem $swap load=$(cut -d' ' -f1-3 /proc/loadavg) webkitWeb=$(pgrep -c -f WebKitWebProcess || true) webkitNet=$(pgrep -c -f WebKitNetworkProcess || true) chrome=$(pgrep -c -f 'chrome|headless_shell' || true)"
    sleep 5
  done
) >> "$log" 2>&1 &
sampler=$!
"$@"
status=$?
kill "$sampler" 2>/dev/null || true
exit "$status"
