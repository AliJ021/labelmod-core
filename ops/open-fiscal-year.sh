#!/usr/bin/env bash
# =====================================================================
# بازکردن سال مالی بعد — `ledger.open_fiscal_year()` (مهاجرت ۱۱۷)
# =====================================================================
#     ops/open-fiscal-year.sh 1406 2027-03-21 2028-03-19
#
# سال و شمارنده‌های سندش را در **یک** تراکنش می‌سازد. درج دستی یک سطر در
# `ledger.fiscal_year` کافی نیست: بی شمارنده، اولین سند همان سال با
# «شمارنده سند … تعریف نشده است» رد می‌شود.
#
# ⚠️ تاریخ‌ها میلادی‌اند و فراخوان می‌دهدشان: سال شمسی کبیسه دارد و این
#    اسکریپت تقویم حساب نمی‌کند. تابع فقط پیوستگی با سال قبل و طول
#    ۳۶۵/۳۶۶ روز را می‌سنجد؛ تاریخ شروع و پایان را با حسابدار تأیید کنید.
# ⚠️ اختتام سال قبل را انجام نمی‌دهد؛ سال قبل «باز» می‌ماند.
#
# کاربر عامل پیش‌فرض «سیستم» است؛ برای ثبت به نام یک مدیر:
#     LABELMOD_ACTOR=<شناسه کاربر> ops/open-fiscal-year.sh …
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"
LABELMOD_ACTOR="${LABELMOD_ACTOR:-00000000-0000-7000-8000-0000000000f1}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

usage () {
  echo "استفاده: ops/open-fiscal-year.sh <سال> <شروع YYYY-MM-DD> <پایان YYYY-MM-DD>"
  echo "نمونه:   ops/open-fiscal-year.sh 1406 2027-03-21 2028-03-19"
}

YEAR="${1:-}"; STARTS="${2:-}"; ENDS="${3:-}"
DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
UUID_RE='^[0-9a-fA-F-]{36}$'
if ! [[ "$YEAR" =~ ^[0-9]{4}$ && "$STARTS" =~ $DATE_RE && "$ENDS" =~ $DATE_RE ]]; then
  usage; exit 1
fi
if ! [[ "$LABELMOD_ACTOR" =~ $UUID_RE ]]; then
  echo "✗ LABELMOD_ACTOR شناسه معتبر نیست."; exit 1
fi

echo "── بازکردن سال مالی $YEAR از $STARTS تا $ENDS"

psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL" \
     -v actor="$LABELMOD_ACTOR" -v year="$YEAR" -v starts="$STARTS" -v ends="$ENDS" <<'SQL'
BEGIN;
SELECT platform.set_actor(:'actor'::uuid);
SELECT ledger.open_fiscal_year(:'year'::smallint, :'starts'::date, :'ends'::date);
COMMIT;
\pset format aligned
SELECT y.id AS "سال", y.starts_on AS "شروع", y.ends_on AS "پایان", y.status AS "وضعیت",
       (SELECT count(*) FROM platform.document_counter c WHERE c.fiscal_year = y.id) AS "شمارنده‌ها"
  FROM ledger.fiscal_year y ORDER BY y.id;
SQL

echo "✓ سال مالی $YEAR باز شد."
