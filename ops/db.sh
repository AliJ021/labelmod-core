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

PSQL="psql -X -v ON_ERROR_STOP=1 -q"

# ---------------------------------------------------------------------
# migrate — فقط مهاجرت‌های اجرانشده
# ---------------------------------------------------------------------
# تا امروز این تابع کورکورانه هر فایل را از ۰۰۱ دوباره اجرا می‌کرد. روی
# دیتابیس خالی کار می‌کرد، ولی روی دیتابیسی که یک بار مهاجرت شده بود
# سرِ اولین فایل می‌شکست:
#
#     ERROR:  schema "platform" already exists
#
# یعنی **هیچ مهاجرت تازه‌ای هرگز به سرور واقعی نمی‌رسید** — و
# `ops/deploy.sh migrate` که همین را صدا می‌زند، از روز اول بی‌اثر بود.
# تا وقتی هر استقرار از صفر بود، کسی متوجه نمی‌شد.
#
# حالا یک دفتر ساده: هر فایلِ اجراشده با هش محتوایش ثبت می‌شود.
#
# ⚠️ هش برای **گرفتن ویرایشِ مهاجرتِ اجراشده** است، نه برای امنیت.
#    قاعده پروژه می‌گوید مهاجرت موجود ویرایش نمی‌شود؛ این همان قاعده را
#    از حرف به اجبار تبدیل می‌کند.
#
# ⚠️ دفتر در `public` می‌نشیند، نه `platform`: ساختن اسکیمای `platform`
#    اینجا باعث می‌شد مهاجرت ۰۰۱ روی `CREATE SCHEMA platform` بشکند.
#    دفتر مهاجرت زیرساخت است، نه دامنه.
# ---------------------------------------------------------------------
# نسخه‌های تاریخیِ مهاجرت‌هایی که پس از اجرا ویرایش شدند (FND33/34)
# ---------------------------------------------------------------------
# مهاجرت اجراشده ویرایش نمی‌شود و `migrate` روی ویرایش می‌ایستد — درست
# است. ولی ۰۶۵ و ۰۷۰ پیش از این قاعده ویرایش شدند و نصبی که نسخهٔ اولیه‌شان
# را اجرا کرده بود، برای همیشه پشت آن توقف می‌ماند.
#
# فقط همین **سه‌تایی‌های دقیق** پذیرفته‌اند: نام فایل + هش نسخهٔ اولیه که
# اجرا شد + هش نسخهٔ جاری که ترمیم برایش نوشته شد — و فقط چون مهاجرت
# ترمیمیِ نام‌برده همان تفاوت را افزایشی اعمال می‌کند. بدون هش جاری،
# ویرایشِ بعدیِ ۰۶۵ یا ۰۷۰ روی همین نصب‌ها بی‌صدا رد می‌شد.
# ⚠️ ویرایش تازه هرگز به این فهرست اضافه نمی‌شود — برایش مهاجرت تازه
#    بسازید. این فهرست راه دورزدن نگهبان نیست، اثبات یک ترمیم است.
superseded_by () {
  case "$1:$2:$3" in
    065_audit_timezone.sql:cbfa185bb3ca87930c6ab568bdec4a9b58b1f9db0a13c22b6ecd6792fa502096:37f268a42aaf90c74c4c6965ba25b24c764e2f557623b859b7cc5c7db222c7b4) echo 090_repair_edited_migrations.sql ;;
    070_committed_journal_guard.sql:ceb8ed7d9c2caf7d2032ea947f28ead10fcadd52b5c2b09bab20560e6c7e41e4:23d22f8d680610b8a13688d83e22ebf1c42f33466515c328114290b6ea68ff2d) echo 090_repair_edited_migrations.sql ;;
    *) return 1 ;;
  esac
}

migrate () {
  local url="$1" f name sum applied repair

  $PSQL -d "$url" -c "
    BEGIN; SELECT pg_advisory_xact_lock(1668509553, 2); SET LOCAL client_min_messages = warning;
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    ); COMMIT;" >/dev/null

  # دیتابیسی که از قبل مهاجرت شده ولی دفتر ندارد — یعنی نصبی که پیش از
  # این تغییر بالا آمده. حدس‌زدن اینکه کدام مهاجرت‌ها اجرا شده‌اند کار
  # خطرناکی است، پس اپراتور را صریح راهنمایی می‌کنیم.
  if [ "$($PSQL -Aqt -d "$url" -c "SELECT NOT EXISTS (SELECT FROM public.schema_migration) AND EXISTS (SELECT FROM pg_namespace WHERE nspname='platform')")" = "t" ]; then
    echo "⚠️  این دیتابیس از قبل مهاجرت شده ولی دفتر مهاجرت ندارد."
    echo "    یک بار وضعیت فعلی را ثبت کنید (هیچ SQLی اجرا نمی‌شود):"
    echo "        ops/db.sh baseline 031    # شماره آخرین مهاجرتِ اجراشده"
    echo "    و بعد:  ops/db.sh migrate"
    return 1
  fi

  for f in db/migrations/*.sql; do
    name=$(basename "$f")
    sum=$(sha256sum "$f" | cut -d' ' -f1)
    applied=$($PSQL -Aqt -d "$url" -c \
      "SELECT checksum FROM public.schema_migration WHERE filename = '$name'")

    if [ -n "$applied" ]; then
      if [ "$applied" != "$sum" ]; then
        if repair=$(superseded_by "$name" "$applied" "$sum") && [ -f "db/migrations/$repair" ]; then
          echo "↺ $name: نسخهٔ تاریخیِ شناخته‌شده اجرا شده است؛ تفاوتش را $repair اعمال می‌کند."
          continue
        fi
        echo "✗ $name پس از اجرا ویرایش شده است."
        echo "  مهاجرت اجراشده ویرایش نمی‌شود — مهاجرت تازه بسازید."
        return 1
      fi
      continue
    fi

    echo "→ $f"
    # قفل و دفتر در همان تراکنش DDL هستند. نصب هم‌زمان پس از قفل دوباره می‌خواند.
    {
      cat <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(1668509553, 2);
SELECT EXISTS (SELECT FROM public.schema_migration WHERE filename=:'migration') AS done,
       EXISTS (SELECT FROM public.schema_migration WHERE filename=:'migration' AND checksum=:'checksum') AS matches
\gset
\if :done
  \if :matches
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Migration checksum changed during installation'; END $$;
  \endif
\else
SQL
      # فقط مرزهای بیرونی نسخه‌های شناخته‌شده برداشته می‌شوند؛ فایل اصلی و هش آن ثابت‌اند.
      awk -v file="$name" '
        /^BEGIN;[[:space:]]*$/ { starts++; start[starts]=NR }
        /^COMMIT;[[:space:]]*$/ { ends++; finish[ends]=NR }
        { line[NR]=$0 }
        END {
          multi=(file=="005_cheques.sql" || file=="006_sessions.sql" || file=="007_device_trust.sql")
          if (starts!=ends || (!multi && starts>1)) exit 2
          for (j=1;j<=starts;j++) { if (start[j]>=finish[j]) exit 2; delete line[start[j]]; delete line[finish[j]] }
          for (j=1;j<=NR;j++) if (j in line) print line[j]
        }' "$f" || return 1
      cat <<'SQL'
INSERT INTO public.schema_migration(filename,checksum) VALUES (:'migration',:'checksum');
\endif
COMMIT;
SQL
    } | $PSQL -X -d "$url" -v migration="$name" -v checksum="$sum" >/dev/null
  done
}

# ---------------------------------------------------------------------
# baseline — ثبت وضعیت فعلی بدون اجرای چیزی
# ---------------------------------------------------------------------
# فقط یک بار، روی دیتابیسی که پیش از آمدنِ دفتر مهاجرت بالا آمده.
#
# ⚠️ **شماره آخرین مهاجرتِ اجراشده اجباری است.** نسخه اول این تابع همه
#    فایل‌ها را «اجراشده» علامت می‌زد — یعنی روی سروری که تا ۰۳۱ مهاجرت
#    شده، مهاجرت ۰۳۲ هم اجراشده ثبت می‌شد و **هرگز اجرا نمی‌شد**. بدون
#    هیچ خطایی؛ فقط تابعی که وجود ندارد و اولین فراخوانی‌اش می‌شکند.
#
# شماره را از نسخه‌ای که آخرین بار Deploy شده بردارید، حدس نزنید.
baseline () {
  local url="$1" upto="${2:-}" f name sum num n=0

  if [ -z "$upto" ]; then
    echo "✗ شماره آخرین مهاجرتِ اجراشده لازم است."
    echo "      ops/db.sh baseline 031"
    echo "  یعنی «۰۰۱ تا ۰۳۱ اجرا شده‌اند؛ بقیه را اجرا کن»."
    return 1
  fi
  case "$upto" in
    ''|*[!0-9]*) echo "✗ شماره نامعتبر: $upto"; return 1 ;;
  esac
  upto=$((10#$upto))

  $PSQL -d "$url" -c "
    SET client_min_messages = warning;
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );" >/dev/null

  for f in db/migrations/*.sql; do
    name=$(basename "$f")
    num=$((10#${name%%_*}))
    [ "$num" -le "$upto" ] || continue
    sum=$(sha256sum "$f" | cut -d' ' -f1)
    $PSQL -d "$url" -c "INSERT INTO public.schema_migration (filename, checksum)
                        VALUES ('$name', '$sum') ON CONFLICT (filename) DO NOTHING" >/dev/null
    n=$((n + 1))
  done

  echo "✓ $n مهاجرت (تا شماره $upto) به‌عنوان «اجراشده» ثبت شد. هیچ SQLی اجرا نشد."
  echo "  حالا:  ops/db.sh migrate   — بقیه را اجرا می‌کند."
}
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
# مشترک اجرا شوند، همان داده Commit‌شیازده ادعاهای مقدارِ مشخصِ سناریوی
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
  # سال‌های مالی تا «امروز» — فقط دیتابیس آزمون. بی این، از ۲۰۲۷/۰۳/۲۱ (پایان سال
  # ۱۴۰۵ Seed) هر آزمون سندزن قرمز می‌شد بی‌آنکه کدی خراب شده باشد.
  $PSQL -d "$TESTURL" -f db/fixture/fiscal-years-to-today.sql >/dev/null

  local fail=0
  local out
  for f in db/test/*.sql; do
    echo; echo "═══ $f ═══"
    if out=$($PSQL -d "$TESTURL" -f "$f" 2>&1); then :; else fail=1; fi
    sed 's/psql:[^ ]*: \(NOTICE\|ERROR\):  //' <<<"$out"
    grep -q '✗' <<<"$out" && fail=1 || true
  done

  # تست‌های پوسته‌ای: آن‌هایی که به **دو نشست مجزا** یا به نقش دیگری
  # نیاز دارند و داخل یک تراکنش psql بیان‌شدنی نیستند.
  # ⚠️ حلقه است، نه نام ثابت: پیش از این فقط `concurrency.sh` صدا زده
  #    می‌شد، پس تست پوسته‌ای تازه **بی‌صدا** اجرا نمی‌شد.
  for f in db/test/*.sh; do
    [ -f "$f" ] || continue
    echo; echo "═══ $f ═══"
    DATABASE_URL="$TESTURL" bash "$f" || fail=1
  done

  cleanup; trap - EXIT
  echo
  if [ $fail -eq 0 ]; then
    echo "✓ همه تست‌ها پاس شدند"
  else
    echo "✗ تست ناموفق"; exit 1
  fi
}

backup () {
  local dir="${BACKUP_DIR:-./backup}"
  # دامپ دادهٔ مشتری، هش رمز و راز TOTP دارد؛ فقط مالک فرایند بخواندش (LM-09).
  # umask در زیرپوسته می‌ماند تا بقیهٔ اسکریپت را عوض نکند.
  ( umask 077 && mkdir -p "$dir" )
  local f="$dir/labelmod-$(date +%Y%m%d-%H%M%S).dump"
  ( umask 077 && pg_dump -Fc -d "$DATABASE_URL" -f "$f" )
  chmod 600 "$f"
  echo "✓ بکاپ: $f"
  # سابقهٔ بکاپ (مهاجرت ۱۲۲) فقط **پس از** دامپ موفق؛ شکست بالا با `set -e` به
  # اینجا نمی‌رسد، پس زنگ «بکاپ تازه نیست» با بکاپ ناموفق خاموش نمی‌شود.
  # شکست ثبت، بکاپ را باطل نمی‌کند ولی زنگ روشن می‌ماند — هشدار کاذب، نه سکوت.
  local bytes sha
  bytes=$(wc -c < "$f" | tr -d ' ')
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  if ! printf '%s\n' "SELECT platform.record_backup_event('created', 'scheduler', :'ref', :'bytes'::bigint, :'sha');" \
       | $PSQL -d "$DATABASE_URL" -v ref="$(basename "$f")" -v bytes="$bytes" -v sha="$sha" >/dev/null; then
    echo "⚠️  بکاپ ساخته شد ولی در سابقه ثبت نشد؛ زنگ «بکاپ تازه نیست» روشن می‌ماند."
  fi
  echo "⚠️  این فایل باید به جایی خارج از همین سرور کپی شود."
  echo "⚠️  بکاپی که Restore آن تست نشده، بکاپ نیست."
}

case "${1:-}" in
  migrate) migrate "$DATABASE_URL" ;;
  baseline) baseline "$DATABASE_URL" "${2:-}" ;;
  seed)    seed    "$DATABASE_URL" ;;
  test)    run_tests ;;
  reset)   $PSQL -d "$DATABASE_URL" -c "DROP SCHEMA IF EXISTS platform,identity,catalog,inventory,purchasing,sales,treasury,ledger CASCADE;
                                        DROP TABLE IF EXISTS public.schema_migration;"
           migrate "$DATABASE_URL"; seed "$DATABASE_URL"; echo "✓ بازسازی شد" ;;
  backup)  backup ;;
  *) echo "استفاده: ops/db.sh {migrate|baseline <شماره>|seed|test|reset|backup}"; exit 1 ;;
esac
