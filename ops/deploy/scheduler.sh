#!/usr/bin/env bash
# =====================================================================
# زمان‌بند شبانه — بدون cron
# =====================================================================
# چرا cron نه: cron در ظرف یعنی یک لایه دیگر برای انتقال محیط، یک
# مسیر دیگر برای گم‌شدن `DATABASE_URL`، و لاگی که به stdout ظرف
# نمی‌رود. این حلقه هر ساعت بیدار می‌شود، ساعت **محلی** را می‌بیند و
# اگر کار امروز انجام نشده باشد اجرایش می‌کند.
#
# نشانه انجام‌شدن یک فایل در Volume است، نه حافظه — پس Restart ظرف
# باعث اجرای دوباره در همان روز نمی‌شود.
#
# ⚠️ ساعت این حلقه محلی است (TZ ظرف). خودِ منطق مالی «امروز» را از
#    تنظیم `platform.timezone` می‌خواند، نه از اینجا.
# =====================================================================
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"
CLOSE_HOUR="${CLOSE_HOUR:-3}"          # ساعت بستن دوره کانال آنلاین
BACKUP_HOUR="${BACKUP_HOUR:-4}"        # ساعت بکاپ
STATE_DIR="${STATE_DIR:-/var/lib/labelmod-scheduler}"
export PGCLIENTENCODING=UTF8

mkdir -p "$STATE_DIR"

log () { echo "── $(date '+%Y-%m-%d %H:%M:%S %Z') $*"; }

# یک کار در روز، یک بار. برگشت ۰ یعنی «باید اجرا شود».
due () {
  local name="$1" hour="$2" today marker
  [ "$(date +%-H)" = "$hour" ] || return 1
  today=$(date +%Y-%m-%d)
  marker="$STATE_DIR/$name"
  [ -f "$marker" ] && [ "$(cat "$marker")" = "$today" ] && return 1
  return 0
}
done_today () { date +%Y-%m-%d > "$STATE_DIR/$1"; }

log "زمان‌بند بالا آمد — بستن دوره ساعت ${CLOSE_HOUR}، بکاپ ساعت ${BACKUP_HOUR}"

while true; do
  if due close "$CLOSE_HOUR"; then
    log "بستن دوره‌های سررسیدشده"
    # شکست اینجا نباید حلقه را بکشد: فردا دوباره تلاش می‌شود و
    # `sales.unposted_revenue` همچنان زنگ خطر است.
    if /app/ops/close-due-days.sh; then done_today close
    else log "⚠️  بستن دوره شکست خورد — sales.unposted_revenue را ببینید"; fi
  fi

  if due backup "$BACKUP_HOUR"; then
    log "بکاپ"
    if /app/ops/db.sh backup; then
      done_today backup
      # نگهداری ۳۰ روز روی همین سرور. نسخه هفتگی و ماهانه کار
      # مقصد بیرونی است، نه اینجا (بند ۴ SECURITY.md).
      find "${BACKUP_DIR:-/backup}" -name 'labelmod-*.dump' -mtime +30 -delete 2>/dev/null || true
      log "⚠️  این دامپ رمزنشده است و باید خارج از این سرور کپی شود."
    else log "⚠️  بکاپ شکست خورد"; fi
  fi

  sleep 3600
done
