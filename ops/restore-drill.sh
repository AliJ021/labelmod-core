#!/usr/bin/env bash
# =====================================================================
# تمرین بازیابی — بکاپ را واقعاً برمی‌گرداند و ادعاهای مالی را می‌راند
# =====================================================================
#
#   ops/restore-drill.sh <فایل.dump>
#   ops/restore-drill.sh              # آخرین دامپ در $BACKUP_DIR
#
# ── چرا این اسکریپت وجود دارد ─────────────────────────────────────────
#
# بند ۴ `docs/SECURITY.md`: «بکاپی که Restore آن تست نشده، بکاپ نیست —
# یک فایل است با یک فرض.»
#
# تا امروز آن جمله فقط یک جمله بود: تنظیم `backup.restore_drill_days`
# وجود داشت و **هیچ‌جا خوانده نمی‌شد**. سند وعده هشدار می‌داد و کد
# هشداری نمی‌ساخت.
#
# ── چه چیزی واقعاً سنجیده می‌شود ──────────────────────────────────────
#
# «فایل باز شد» کافی نیست. یک دامپ می‌تواند بی‌خطا بازیابی شود و باز هم
# بی‌فایده باشد: جدولی خالی، سندی نامتوازن، یا زنجیره حسابرسی شکسته.
# پس پس از بازیابی، **همان ادعاهایی** که CI روی دیتابیس زنده می‌راند
# اینجا هم رانده می‌شوند.
#
# ⚠️ بازیابی در یک دیتابیس **یک‌بارمصرف** انجام می‌شود که در پایان
#    انداخته می‌شود. این اسکریپت هرگز روی دیتابیس عملیاتی نمی‌نویسد —
#    یک تمرین بازیابی که داده واقعی را خراب کند، از نداشتنش بدتر است.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

PSQL="psql -v ON_ERROR_STOP=1 -qtA"

# ── انتخاب فایل ──────────────────────────────────────────────────────
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DIR="${BACKUP_DIR:-./backup}"

  # ⚠️ `|| true` اجباری است و یک اصلاح است، نه احتیاط.
  #
  #    با `set -euo pipefail` (سطر بالای همین فایل)، اگر پوشهٔ بکاپ
  #    **وجود نداشته باشد** `find` کد ۱ می‌دهد، `pipefail` آن را به کل
  #    لوله می‌برد، و `set -e` اسکریپت را همان‌جا می‌کشد — **پیش از**
  #    رسیدن به پیام خطای پایین.
  #
  #    یعنی پیام وجود داشت و هرگز چاپ نمی‌شد: خروجی **صفر بایت** و کد ۱.
  #    روی سرور، یک cron شبانه هر شب شکست می‌خورد و هیچ‌کس یک کلمه
  #    نمی‌دید. (`head -1` هم می‌تواند به `sort` سیگنال SIGPIPE بدهد و
  #    همان اثر را بسازد.)
  #
  #    اندازه‌گیری شد: با پوشهٔ **موجود ولی خالی** پیام چاپ می‌شد، با
  #    پوشهٔ **ناموجود** نه. `db/test/restore-drill-guard.sh` هر دو حالت
  #    را قفل کرده، به‌علاوهٔ کنترل مثبت.
  #
  #    جدیدترین دامپ. `ls -t` روی نام فایل با فاصله می‌شکند، پس `find`.
  DUMP="$(find "$DIR" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' 2>/dev/null \
          | sort -rn | head -1 | cut -d' ' -f2- || true)"

  if [ -z "$DUMP" ]; then
    if [ ! -d "$DIR" ]; then
      echo "✗ پوشهٔ بکاپ «$DIR» وجود ندارد." >&2
    else
      echo "✗ هیچ فایل «*.dump» در «$DIR» پیدا نشد." >&2
    fi
    echo "  اول یک بکاپ بگیرید:  ops/db.sh backup" >&2
    echo "  یا مسیر را بدهید:     ops/restore-drill.sh <فایل.dump>" >&2
    echo "  یا پوشه را تعیین کنید: BACKUP_DIR=... ops/restore-drill.sh" >&2
    exit 1
  fi
fi
if [ ! -f "$DUMP" ]; then
  echo "✗ فایل بکاپ «$DUMP» پیدا نشد." >&2
  echo "  اول یک بکاپ بگیرید:  ops/db.sh backup" >&2
  exit 1
fi

BYTES=$(stat -c%s "$DUMP" 2>/dev/null || echo 0)
echo "── تمرین بازیابی ──────────────────────────────────────────"
echo "  فایل: $DUMP"
echo "  حجم: $BYTES بایت"
echo

# ── دیتابیس یک‌بارمصرف ───────────────────────────────────────────────
# نامش تصادفی است تا دو اجرای هم‌زمان به هم نخورند.
TARGET="labelmod_drill_$$_$(date +%s)"
ADMIN_URL="${DATABASE_URL%/*}/postgres"

cleanup () {
  psql -q -d "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$TARGET\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "  ساخت دیتابیس یک‌بارمصرف: $TARGET"
psql -q -d "$ADMIN_URL" -c "CREATE DATABASE \"$TARGET\"" >/dev/null

DRILL_URL="${DATABASE_URL%/*}/$TARGET"

echo "  بازیابی…"
# ⚠️ بدون `--exit-on-error`: یک دامپ سالم هم ممکن است روی نقش‌ها و
#    افزونه‌هایی که در این دیتابیس نیستند هشدار بدهد. آنچه اهمیت دارد
#    ادعاهای زیر است، نه بی‌صدا بودن pg_restore.
RESTORE_LOG="$(mktemp)"
if ! pg_restore --no-owner --no-privileges -d "$DRILL_URL" "$DUMP" >"$RESTORE_LOG" 2>&1; then
  echo "  ⚠️ pg_restore هشدار داد (چند سطر آخر):"
  tail -5 "$RESTORE_LOG" | sed 's/^/     /'
fi
rm -f "$RESTORE_LOG"

# ── ادعاها روی داده بازیابی‌شده ──────────────────────────────────────
PASSED=0
FAILED=0

check () {                       # check "توضیح" "SQL که یک عدد می‌دهد" "مقدار انتظار"
  local label="$1" sql="$2" want="$3" got
  got="$($PSQL -d "$DRILL_URL" -c "$sql" 2>/dev/null || echo "ERR")"
  if [ "$got" = "$want" ]; then
    echo "  ✓ $label"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ $label — انتظار «$want»، واقعی «$got»"
    FAILED=$((FAILED + 1))
  fi
}

at_least () {                    # at_least "توضیح" "SQL" حداقل
  local label="$1" sql="$2" min="$3" got
  got="$($PSQL -d "$DRILL_URL" -c "$sql" 2>/dev/null || echo "ERR")"
  if [ "$got" != "ERR" ] && [ "$got" -ge "$min" ] 2>/dev/null; then
    echo "  ✓ $label = $got"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ $label — انتظار دست‌کم $min، واقعی «$got»"
    FAILED=$((FAILED + 1))
  fi
}

echo
echo "── ادعاها روی داده بازیابی‌شده ─────────────────────────────"

# ۱. اسکیما آمده است. دامپی که جدول‌ها را نیاورد، بی‌خطا هم که باشد
#    بی‌فایده است.
at_least "جدول‌های مالی برگشته‌اند" \
  "SELECT count(*) FROM information_schema.tables
    WHERE table_schema IN ('platform','identity','catalog','inventory',
                           'purchasing','sales','treasury','ledger')" 40

# ۲. کدینگ حساب و قواعد ثبت — بدون این‌ها هیچ سندی ساختنی نیست.
at_least "کدینگ حساب برگشته" "SELECT count(*) FROM ledger.account" 10
at_least "قواعد ثبت برگشته"  "SELECT count(*) FROM ledger.posting_rule" 5
at_least "تنظیمات برگشته"    "SELECT count(*) FROM platform.setting" 20

# ۳. همان ادعاهای پایداری که CI روی دیتابیس زنده می‌راند.
check "هیچ سند نامتوازنی نیست" \
  "SELECT count(*) FROM (SELECT entry_id FROM ledger.journal_line
     GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x" 0

check "هیچ موجودی منفی‌ای نیست" \
  "SELECT count(*) FROM inventory.stock_balance WHERE on_hand < 0" 0

# ⚠️ قوی‌ترین ثابتِ انبار، و تنها راه دیدن واگراییِ مانده از حرکت‌ها.
#    `stock_balance` یک Projection است و Trigger تغییرناپذیری ندارد —
#    نمی‌تواند داشته باشد، چون `apply_movement` خودش می‌نویسدش. پس
#    بکاپی که مانده‌اش با حرکت‌هایش نخواند، بکاپِ یک خرابی است، نه یک
#    بکاپ سالم. بازیابی‌اش هم بی‌خطا انجام می‌شود و هیچ‌کس نمی‌فهمد.
check "مانده انبار با جمع حرکت‌ها می‌خواند" \
  "SELECT count(*) FROM inventory.balance_check
    WHERE qty_diff <> 0 OR value_diff <> 0" 0

# ⚠️ و ثابتِ دیگری که تا مهاجرت ۰۴۹ هیچ‌جا سنجیده نمی‌شد: ارزش موجودی
#    در **دفتر** با ارزش واقعی انبار. `balance_check` این را نمی‌گیرد —
#    آن `stock_balance` را با `stock_movement` می‌سنجد و هر دو درون
#    ماژول انبارند. بکاپی که دفترش با انبارش واگرا باشد، ترازنامهٔ
#    غلط را هم با خودش برمی‌گرداند.
check "ارزش موجودی در دفتر با انبار می‌خواند" \
  "SELECT count(*) FROM inventory.ledger_check WHERE diff <> 0" 0

# ۴. زنجیره هش لاگ حسابرسی — **پیوند و محتوا**، از `platform.audit_check`.
#
#    ⚠️ نسخهٔ قبلی این بند فقط `prev_hash = lag(hash)` را می‌سنجید، یعنی
#    فقط **پیوند**ها. اندازه‌گیری شد که تغییر **محتوای** یک سطر از آن
#    بی‌صدا رد می‌شود: با عوض‌کردن `after` یک سطر، این بند ۰ گسست
#    گزارش می‌کرد و بازمحاسبهٔ واقعی هش ۱ سطر دست‌کاری‌شده. یعنی «تنها
#    ادعایی که دستکاری تاریخچه را می‌گیرد» فقط درج و حذف را می‌گرفت.
#
#    مهاجرت ۰۵۱ نمای `audit_check` را آورد که هش را **بازمحاسبه**
#    می‌کند (نسخه‌آگاه) و `before` و `reason` را هم می‌پوشاند — دقیقاً
#    دو میدانی که جعلشان پیش از آن دیده نمی‌شد.
check "دفتر حسابرسی دست‌نخورده است (پیوند و محتوا)" \
  "SELECT count(*) FROM platform.audit_check" 0

# ۵. گردش حساب اشخاص مالک دارد. `party_id` کلید خارجی ندارد (چندریختی
#    است: مشتری یا تأمین‌کننده)، پس دامپی که سطر سندش به شخصِ ازدست‌رفته
#    اشاره کند، ترازنامه را درست نشان می‌دهد و گردش اشخاص را نه.
check "هر سطر سند به شخصی موجود اشاره می‌کند" \
  "SELECT count(*) FROM ledger.party_check" 0

# ۵. توابع مالی هم آمده‌اند، نه فقط جدول‌ها. دامپ فقط-داده اینجا رد
#    می‌شود — و آن دقیقاً همان بکاپی است که در روز بد به درد نمی‌خورد.
at_least "توابع مالی برگشته‌اند" \
  "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('platform','sales','inventory','treasury','ledger')" 30

echo
if [ "$FAILED" -gt 0 ]; then
  echo "✗ تمرین بازیابی ناموفق: $FAILED ادعا شکست خورد ($PASSED پاس)"
  OK=false
else
  echo "✓ تمرین بازیابی موفق — $PASSED ادعا پاس شد"
  OK=true
fi

# ── ثبت در دیتابیس **عملیاتی** ───────────────────────────────────────
# ⚠️ تنها نوشتنِ این اسکریپت روی دیتابیس واقعی، همین یک سطر است.
NOTE="$(basename "$DUMP")"
psql -q -d "$DATABASE_URL" -c \
  "SELECT platform.record_restore_drill(
     \$\$$NOTE\$\$, $OK, $PASSED, $BYTES, NULL, NULL)" >/dev/null

echo
echo "── وضعیت مهلت ─────────────────────────────────────────────"
psql -d "$DATABASE_URL" -c "SELECT * FROM platform.restore_drill_status"

[ "$FAILED" -eq 0 ]
