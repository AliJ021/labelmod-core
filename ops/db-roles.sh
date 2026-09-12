#!/usr/bin/env bash
# =====================================================================
# db-roles.sh — لایه دوم دفاع: نقش برنامه بدون حق نوشتن مستقیم
# =====================================================================
# بند ۳ `docs/SECURITY.md` این را **الزام** کرده و تا امروز فقط یک
# جمله در سند بود: نه نقشی ساخته می‌شد، نه REVOKEای اجرا.
# `docker-compose.yml` یک کاربر می‌سازد که **مالک** دیتابیس است، پس
# همه‌چیز را می‌تواند — از جمله `UPDATE` مستقیم روی `stock_balance`.
#
# این اسکریپت آن جمله را به یک فرمان تبدیل می‌کند. Idempotent است.
#
#   ops/db-roles.sh                      # با DATABASE_URL مالک
#   APP_PASSWORD='…' ops/db-roles.sh     # رمز نقش برنامه
#
# سپس `DATABASE_URL` **برنامه** به نقش تازه عوض می‌شود، و مهاجرت‌ها با
# همان نقش مالک قبلی اجرا می‌شوند. جزئیات در docs/DEPLOYMENT.md.
#
# ⚠️ این اسکریپت نقشِ مالک را عوض نمی‌کند و هیچ‌چیز را نمی‌اندازد.
#    اجرایش روی سیستم زنده، تا وقتی DATABASE_URL برنامه عوض نشود،
#    هیچ اثر رفتاری ندارد.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

APP_ROLE="${APP_ROLE:-labelmod_app}"
APP_PASSWORD="${APP_PASSWORD:-}"

PSQL="psql -v ON_ERROR_STOP=1 -q -d $DATABASE_URL"
SCHEMAS="platform,identity,catalog,inventory,purchasing,sales,treasury,ledger"

if [ -z "$APP_PASSWORD" ]; then
  echo "⚠️  APP_PASSWORD داده نشد — نقش بدون تغییر رمز ساخته/به‌روز می‌شود."
  echo "    برای نقش تازه، رمز لازم است:  APP_PASSWORD='…' ops/db-roles.sh"
fi

# نام نقش، شناسه است و در SQL درج می‌شود — پس شکلش سنجیده می‌شود.
case "$APP_ROLE" in
  [a-z_][a-z0-9_]*) : ;;
  *) echo "✗ نام نقش نامعتبر: $APP_ROLE" >&2; exit 1 ;;
esac

DBNAME=$(psql -tAc 'SELECT current_database()' -d "$DATABASE_URL")

echo "── ساخت یا به‌روزرسانی نقش $APP_ROLE ─────────────────────────"
# ⚠️ رمز با `:'pw'` می‌رود، نه با درج رشته در SQL: psql خودش نقل‌قولش
#    می‌کند. رمزی که یک آپاستروف داشته باشد وگرنه اسکریپت را می‌شکست.
#    و `DO $$ … current_setting('my.pw') …$$` هم کار نمی‌کند — psql
#    داخل رشته‌های Dollar-Quoted متغیر را جانشین **نمی‌کند**.
if [ -z "$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE'" -d "$DATABASE_URL")" ]; then
  if [ -z "$APP_PASSWORD" ]; then
    echo "✗ نقش $APP_ROLE وجود ندارد و بدون APP_PASSWORD ساختنی نیست." >&2
    exit 1
  fi
  # ⚠️ از stdin، نه با `-c`: psql متغیر را در `-c` **جانشین نمی‌کند**.
  $PSQL -v pw="$APP_PASSWORD" -v r="$APP_ROLE" <<'SQL'
CREATE ROLE :"r" LOGIN PASSWORD :'pw';
SQL
  echo "  نقش ساخته شد"
elif [ -n "$APP_PASSWORD" ]; then
  $PSQL -v pw="$APP_PASSWORD" -v r="$APP_ROLE" <<'SQL'
ALTER ROLE :"r" PASSWORD :'pw';
SQL
  echo "  رمز عوض شد"
else
  echo "  نقش از قبل هست؛ رمز دست‌نخورده ماند"
fi

# نقش برنامه هرگز مالک نیست و هرگز DDL نمی‌زند.
$PSQL -c "ALTER ROLE \"$APP_ROLE\" NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;"

echo "── حق‌های عادی DML ───────────────────────────────────────────"
$PSQL <<SQL
GRANT CONNECT ON DATABASE "$DBNAME" TO $APP_ROLE;
GRANT USAGE ON SCHEMA $SCHEMAS TO $APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA $SCHEMAS TO $APP_ROLE;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA $SCHEMAS TO $APP_ROLE;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA $SCHEMAS TO $APP_ROLE;
-- جدول یا تابعی که مهاجرت بعدی بسازد هم خودبه‌خود پوشیده شود، وگرنه
-- هر مهاجرت یک اجرای دستی این اسکریپت را لازم می‌کرد و یک بار فراموش
-- می‌شد.
ALTER DEFAULT PRIVILEGES IN SCHEMA $SCHEMAS
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP_ROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA $SCHEMAS
  GRANT USAGE, SELECT ON SEQUENCES TO $APP_ROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA $SCHEMAS
  GRANT EXECUTE ON FUNCTIONS TO $APP_ROLE;
SQL

echo "── و آنچه گرفته می‌شود ───────────────────────────────────────"
$PSQL <<SQL
-- ۱. بدون DDL
REVOKE CREATE ON SCHEMA $SCHEMAS FROM $APP_ROLE;

-- ۲. جدول‌های تغییرناپذیر — علاوه بر Trigger، یعنی دو لایه
REVOKE UPDATE, DELETE ON platform.audit_log       FROM $APP_ROLE;
REVOKE UPDATE, DELETE ON inventory.stock_movement FROM $APP_ROLE;

-- ۳. و آنچه SECURITY.md نگفته بود ولی خطرش از هر دو بیشتر است:
--    نوشتن **مستقیم** روی موجودی. «stock_balance» یک Projection است و
--    Trigger تغییرناپذیری نمی‌تواند داشته باشد (چون apply_movement
--    خودش می‌نویسدش)، پس تا امروز تنها دفاعش یک **نما** بود که کسی
--    باید نگاهش می‌کرد.
--
--    مهاجرت ۰۵۰ آن تابع را SECURITY DEFINER کرد، پس حالا می‌شود حق
--    نوشتن را گرفت و دروازه باز بماند. «INSERT» هم گرفته می‌شود:
--    قاعده پروژه می‌گوید هیچ‌جا INSERT مستقیم در stock_movement.
REVOKE INSERT, UPDATE, DELETE ON inventory.stock_movement FROM $APP_ROLE;
REVOKE INSERT, UPDATE, DELETE ON inventory.stock_balance  FROM $APP_ROLE;
REVOKE INSERT, UPDATE, DELETE ON inventory.cost_layer     FROM $APP_ROLE;

-- پیش‌فرض‌های آینده هم همین را بگیرند.
ALTER DEFAULT PRIVILEGES IN SCHEMA inventory
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM $APP_ROLE;
SQL

echo
echo "✓ نقش $APP_ROLE آماده است."
echo
echo "قدم بعدی — و تا انجام نشود هیچ محدودیتی فعال نیست:"
echo "  DATABASE_URL برنامه را به این نقش عوض کنید."
echo "  مهاجرت‌ها با همان نقش مالک قبلی اجرا می‌شوند."
echo "  سپس یک بار بسنجید:  DATABASE_URL='…app…' ops/deploy.sh status"
