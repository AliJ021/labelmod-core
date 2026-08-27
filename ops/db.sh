#!/usr/bin/env bash
# =====================================================================
# ابزار پایگاه داده — migrate | seed | test | reset | backup
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"

# psql روی ویندوز client_encoding را از Code Page کنسول برمی‌دارد (اغلب
# WIN1252) و آن‌وقت اولین کامنت فارسی مهاجرت با خطای encoding رد می‌شود.
# کل این مخزن UTF-8 است؛ صریح اعلامش می‌کنیم.
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

PSQL="psql -v ON_ERROR_STOP=1 -q"

migrate () { for f in db/migrations/*.sql; do echo "→ $f"; $PSQL -d "$1" -f "$f"; done; }
seed    () { for f in db/seed/*.sql;       do echo "→ $f"; $PSQL -d "$1" -f "$f"; done; }

# جایگزینی نام دیتابیس در رشته اتصال، بدون دست‌زدن به بقیه پارامترها.
# شل خالص و بدون وابستگی بیرونی: روی ویندوز/Git Bash هم python3 ممکن است
# فقط یک Stub فروشگاه مایکروسافت باشد که ساکت شکست می‌خورد.
swap_db () {
  local url="$1" newdb="$2" base query rest out kv
  case "$url" in
    postgres://*|postgresql://*)
      base="${url%%\?*}"
      query=""
      [ "$base" != "$url" ] && query="?${url#*\?}"
      rest="${base#*://}"
      case "$rest" in
        */*) printf '%s/%s%s\n' "${base%/*}" "$newdb" "$query" ;;
        *)   printf '%s/%s%s\n' "$base"      "$newdb" "$query" ;;
      esac
      ;;
    *)                                  # فرم key=value
      out=""
      for kv in $url; do
        case "$kv" in dbname=*) ;; *) out="$out $kv" ;; esac
      done
      printf '%s dbname=%s\n' "${out# }" "$newdb"
      ;;
  esac
}

# ---------------------------------------------------------------------
# test — روی یک دیتابیس یک‌بارمصرف تازه
# ---------------------------------------------------------------------
# چرا دیتابیس تازه: تست همزمانی به‌ناچار Commit واقعی می‌کند (به دو نشست
# مجزا نیاز دارد و نمی‌تواند Rollback شود). اگر تست‌ها روی یک دیتابیس
# مشترک اجرا شوند، همان داده Commit‌شده ادعاهای مقدارِ مشخصِ سناریوی
# طلایی را در اجرای بعدی می‌شکند. دیتابیس تازه، هر اجرا را قطعی می‌کند.
run_tests () {
  TESTDB="labelmod_test_$$"          # سراسری، نه local — trap بعد از خروج از scope اجرا می‌شود
  TESTURL=$(swap_db "$DATABASE_URL" "$TESTDB")

  cleanup () {
    [ -n "${TESTDB:-}" ] || return 0
    $PSQL -d "$DATABASE_URL" -c "DROP DATABASE IF EXISTS \"$TESTDB\" WITH (FORCE);" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  echo "→ ساخت دیتابیس تست: $TESTDB"
  $PSQL -d "$DATABASE_URL" -c "DROP DATABASE IF EXISTS \"$TESTDB\" WITH (FORCE);" >/dev/null 2>&1 || true
  $PSQL -d "$DATABASE_URL" -c "CREATE DATABASE \"$TESTDB\";" >/dev/null

  migrate "$TESTURL" >/dev/null
  seed    "$TESTURL" >/dev/null

  local fail=0
  local out
  for f in db/test/*.sql; do
    echo; echo "═══ $f ═══"
    if out=$($PSQL -d "$TESTURL" -f "$f" 2>&1); then :; else fail=1; fi
    sed 's/psql:[^ ]*: \(NOTICE\|ERROR\):  //' <<<"$out"
    grep -q '✗' <<<"$out" && fail=1 || true
  done

  if [ -f db/test/concurrency.sh ]; then
    echo; echo "═══ db/test/concurrency.sh ═══"
    DATABASE_URL="$TESTURL" bash db/test/concurrency.sh || fail=1
  fi

  cleanup; trap - EXIT
  echo
  if [ $fail -eq 0 ]; then
    echo "✓ همه تست‌ها پاس شدند"
  else
    echo "✗ تست ناموفق"; exit 1
  fi
}

backup () {
  local dir="${BACKUP_DIR:-./backup}"; mkdir -p "$dir"
  local f="$dir/labelmod-$(date +%Y%m%d-%H%M%S).dump"
  pg_dump -Fc -d "$DATABASE_URL" -f "$f"
  echo "✓ بکاپ: $f"
  echo "⚠️  این فایل باید به جایی خارج از همین سرور کپی شود."
  echo "⚠️  بکاپی که Restore آن تست نشده، بکاپ نیست."
}

case "${1:-}" in
  migrate) migrate "$DATABASE_URL" ;;
  seed)    seed    "$DATABASE_URL" ;;
  test)    run_tests ;;
  reset)   $PSQL -d "$DATABASE_URL" -c "DROP SCHEMA IF EXISTS platform,identity,catalog,inventory,purchasing,sales,treasury,ledger CASCADE;"
           migrate "$DATABASE_URL"; seed "$DATABASE_URL"; echo "✓ بازسازی شد" ;;
  backup)  backup ;;
  *) echo "استفاده: ops/db.sh {migrate|seed|test|reset|backup}"; exit 1 ;;
esac
