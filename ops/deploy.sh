#!/usr/bin/env bash
# =====================================================================
# استقرار — up | migrate | seed | logs | backup | down | status
# =====================================================================
# لایه نازکی روی docker compose، فقط برای اینکه ترتیب درست فراموش
# نشود: اول دیتابیس سالم، بعد مهاجرت، بعد seed، بعد سرویس‌ها.
#
#   ops/deploy.sh up          # اولین بار یا بعد از هر تغییر کد
#   ops/deploy.sh migrate     # بعد از افزودن مهاجرت
#   ops/deploy.sh seed        # بعد از هر مهاجرتی که حساب یا قاعده ثبت می‌خواهد
#   ops/deploy.sh user --username ali --name '…' --role admin
#   ops/deploy.sh status
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.prod.yml)

[ -f .env ] || { echo "✗ فایل .env نیست. اول: cp .env.example .env"; exit 1; }

# مهاجرت و seed داخل ظرف scheduler اجرا می‌شوند: تنها ظرفی که هم psql
# دارد، هم مخزن را می‌بیند، هم روی شبکه داخلی به db می‌رسد. یعنی هیچ
# پورت پستگرسی لازم نیست روی میزبان باز باشد.
in_db_tools () { "${COMPOSE[@]}" run --rm --entrypoint bash scheduler -lc "$1"; }

case "${1:-}" in
  up)
    "${COMPOSE[@]}" up -d --build
    echo "✓ بالا آمد. وضعیت:  ops/deploy.sh status"
    echo "⚠️  اگر اولین بار است:  ops/deploy.sh migrate && ops/deploy.sh seed"
    ;;
  migrate) in_db_tools "cd /app && ops/db.sh migrate" ;;
  # فقط یک بار، روی سروری که پیش از آمدنِ دفتر مهاجرت بالا آمده.
  # شماره آخرین مهاجرتِ اجراشده اجباری است — بدون آن، مهاجرت‌های
  # اجرانشده هم «اجراشده» ثبت می‌شوند و هرگز اجرا نمی‌شوند.
  #     ops/deploy.sh baseline 031
  baseline)
    [ -n "${2:-}" ] || { echo "استفاده: ops/deploy.sh baseline <شماره آخرین مهاجرت اجراشده>"; exit 1; }
    in_db_tools "cd /app && ops/db.sh baseline $2" ;;
  seed)    in_db_tools "cd /app && ops/db.sh seed" ;;
  user)
    # seed هیچ حساب انسانی نمی‌سازد و نباید بسازد — رمز پیش‌فرضِ
    # کامیت‌شده دقیقاً همان چیزی است که بند ۸ SECURITY.md ممنوع کرده.
    # پس اولین مدیر از اینجا ساخته می‌شود، با رمز تصادفی که یک بار
    # چاپ می‌شود.
    shift
    "${COMPOSE[@]}" run --rm --no-deps api \
      node --experimental-strip-types apps/api/src/cli/create-user.ts "$@"
    ;;
  api-client)
    # کلید ماشینی — افزونه ووکامرس و مانند آن.
    #
    # مثل `user` رمز تصادفی چاپ می‌کند، ولی کاربر پشتی‌اش **غیرفعال**
    # است و هرگز نمی‌تواند وارد شود: کلید تنها راه اوست. کلید یک بار
    # چاپ می‌شود و از آن به بعد فقط هشش در دیتابیس می‌ماند.
    shift
    "${COMPOSE[@]}" run --rm --no-deps api \
      node --experimental-strip-types apps/api/src/cli/create-api-client.ts "$@"
    ;;
  psql)    "${COMPOSE[@]}" exec db psql -U labelmod -d labelmod ;;
  backup)  in_db_tools "cd /app && BACKUP_DIR=/backup ops/db.sh backup" ;;
  logs)    "${COMPOSE[@]}" logs -f --tail=100 "${2:-}" ;;
  status)
    "${COMPOSE[@]}" ps
    echo
    echo "── درآمد ثبت‌نشده (باید خالی باشد) ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT * FROM sales.unposted_revenue LIMIT 20'" || true
    # ⚠️ نامه مرده همان نقشی را دارد که «درآمد ثبت‌نشده» برای دفتر
    #    دارد: خالی‌نبودنش یعنی پیامی هست که هرگز نرفت و کسی هم خبر
    #    ندارد. زنگ خطری که دیده نشود، زنگ خطر نیست.
    echo "── پیام‌های نرفته (باید خالی باشد) ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT id, topic, attempts, left(last_error,60) AS error, age FROM platform.outbox_dead LIMIT 20'" || true
    # ⚠️ «بکاپی که Restore آن تست نشده، بکاپ نیست» تا امروز فقط یک
    #    جمله در سند بود: تنظیم `backup.restore_drill_days` وجود داشت
    #    و هیچ‌جا خوانده نمی‌شد. حالا زنگش اینجاست، جایی که دیده
    #    می‌شود — زنگی که کسی نبیند، زنگ نیست.
    # ⚠️ قوی‌ترین ثابتِ انبار: مانده باید با **جمع حرکت‌ها** بخواند.
    #    این در CI سنجیده می‌شود ولی روی سیستم زنده هیچ‌کس نمی‌دیدش —
    #    و `stock_balance` تنها جدول مالی است که Trigger تغییرناپذیری
    #    ندارد (نمی‌تواند داشته باشد؛ `apply_movement` خودش می‌نویسدش).
    #    پس اگر روزی واگرا شود — از یک باگ، یک psql دستی، یا یک خرابی
    #    نیمه‌کاره — تنها راه فهمیدنش همین است.
    echo "── مغایرت مانده انبار با حرکت‌ها (باید خالی باشد) ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT * FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0 LIMIT 20'" || true

  echo "── واگرایی دفتر با ارزش واقعی انبار ──"
  # balance_check انبار را با حرکت‌هایش می‌سنجد؛ این یکی انبار را با **دفتر**.
  in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT * FROM inventory.ledger_check WHERE diff <> 0'" || true
    # ⚠️ دست‌کاری دفتر حسابرسی روی سیستم زنده هیچ نگاه‌کننده‌ای نداشت.
    #    زنجیره هش از روز اول بود ولی هیچ‌جا **بازمحاسبه** نمی‌شد، پس
    #    تغییر محتوای یک سطر بی‌صدا رد می‌شد (مهاجرت ۰۵۱).
    # ⚠️ `party_id` کلید خارجی ندارد (چندریختی است)، پس شناسه‌ای که به
    #    هیچ‌کس اشاره کند، مانده‌ای در گردش اشخاص می‌سازد که مالک ندارد.
    echo "── سطر سند با شخص ناموجود (باید خالی باشد) ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT entry_id, account_code, party_type, problem FROM ledger.party_check LIMIT 20'" || true
    echo "── دست‌کاری دفتر حسابرسی (باید خالی باشد) ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT id, at, action, entity_id, problem FROM platform.audit_check LIMIT 20'" || true
    echo "── تمرین بازیابی (never یا overdue یعنی اقدام لازم است) ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c 'SELECT * FROM platform.restore_drill_status'" || true
    echo "── چک سررسیدشده ──"
    in_db_tools "psql -d \"\$DATABASE_URL\" -c \"SELECT * FROM treasury.cheque_due WHERE urgency <> 'future' LIMIT 20\"" || true
    ;;
  down)    "${COMPOSE[@]}" down ;;
  *) echo "استفاده: ops/deploy.sh {up|migrate|seed|user|api-client|psql|backup|logs|status|down}"; exit 1 ;;
esac
