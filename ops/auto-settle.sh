#!/usr/bin/env bash
# =====================================================================
# تسویهٔ خودکار شبانهٔ کارت‌خوان و درگاه — `treasury.auto_settle_due()` (مهاجرت ۱۲۱)
# =====================================================================
# برای هر پایانهٔ فعال با بانک تسویه، فروش روزهایی که موعد واریزشان رسیده را
# با کارمزد قراردادی همان پایانه از حساب «وجوه در راه» به بانک می‌برد.
# زمان‌بند (`ops/deploy/scheduler.sh`) هر شب صدایش می‌زند؛ اجرای دستی هم بی‌خطر
# است: پرداخت تسویه‌شده دوباره تسویه نمی‌شود.
#
# ⚠️ کم‌واریزی پذیرنده را کشف نمی‌کند؛ فرض می‌کند طبق قرارداد واریز شده.
# ⚠️ پایانه‌ای که تسویه‌اش رد شد (جمع خالص صفر یا منفی، دورهٔ بسته، …) دلیلش
#    چاپ می‌شود و به اجرای بعد می‌ماند؛ کد خروج ۱ می‌دهد تا در لاگ دیده شود.
#
# کلید خاموش/روشن: تنظیمات ← خزانه و چک ← «تسویهٔ خودکار کارت‌خوان و درگاه».
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"
LABELMOD_ACTOR="${LABELMOD_ACTOR:-00000000-0000-7000-8000-0000000000f1}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

if ! [[ "$LABELMOD_ACTOR" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "✗ LABELMOD_ACTOR شناسه معتبر نیست."; exit 1
fi

echo "── $(date '+%Y-%m-%d %H:%M:%S') — تسویهٔ خودکار کارت‌خوان و درگاه"

OUT=$(psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL" -v actor="$LABELMOD_ACTOR" <<'SQL'
\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'
BEGIN;
SELECT platform.set_actor(:'actor'::uuid) \g /dev/null
SELECT account_code, period_from, period_to, coalesce(gross::text, ''), coalesce(fee::text, ''),
       coalesce(net::text, ''), coalesce(skipped, '')
  FROM treasury.auto_settle_due(:'actor'::uuid);
COMMIT;
SQL
)

OUT=$(printf '%s\n' "$OUT" | grep -v '^$' || true)
failed=0
if [ -z "$OUT" ]; then
  echo "✓ چیزی برای تسویه نبود (یا تسویهٔ خودکار خاموش است)."
fi
while IFS='|' read -r code from to gross fee net skipped; do
  [ -z "${code:-}" ] && continue
  if [ -n "$skipped" ]; then
    # پایانهٔ مشترک یک وضعیت پیکربندی است، نه شکست اجرا: اگر هر شب کد ۱ می‌داد،
    # زمان‌بند هر شب «ناموفق» می‌دید و شکست واقعی در همان صدا گم می‌شد. پرداخت‌هایش
    # تسویه‌نشده می‌مانند و زنگ «پرداخت کارتی یا درگاهی تسویه‌نشده» نشانشان می‌دهد.
    case "$skipped" in
      "پایانهٔ مشترک"*) echo "ℹ️  $code: $skipped" ;;
      *) echo "⚠️  $code ($from تا $to): $skipped"; failed=1 ;;
    esac
  else
    echo "✓ $code ($from تا $to): ناخالص $gross، کارمزد $fee، واریز $net ریال"
  fi
done <<< "$OUT"
exit "$failed"
