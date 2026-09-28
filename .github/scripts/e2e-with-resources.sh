#!/usr/bin/env bash
# شواهد منابع (پایدار): آزمون مرورگر را اجرا می‌کند و هم‌زمان هر ۵ ثانیه حافظه، بار CPU و
# شمار کل پردازه‌ها را در RESOURCE_LOG ثبت می‌کند؛ CI فقط هنگام شکست چاپش می‌کند. کد خروج خودِ Playwright برمی‌گردد؛
# این اسکریپت هیچ شکستی را پنهان نمی‌کند.
set -uo pipefail
log="${RESOURCE_LOG:?}"
echo "cpus=$(nproc) $(free -m | awk 'NR==2{print "totalMB="$2}')" > "$log"
(
  while true; do
    mem=$(free -m | awk 'NR==2{print "usedMB="$3" availMB="$7}')
    swap=$(free -m | awk 'NR==3{print "swapUsedMB="$3}')
    # شمار پردازه‌های WebKit با نام پردازه در CI همیشه صفر بود؛ شمار کل پردازه‌ها قابل اتکاست.
    echo "$(date -u +%H:%M:%S) $mem $swap load=$(cut -d' ' -f1-3 /proc/loadavg) procs=$(ps -e --no-headers | wc -l)"
    sleep 5
  done
) >> "$log" 2>&1 &
sampler=$!
"$@"
status=$?
kill "$sampler" 2>/dev/null || true
exit "$status"
