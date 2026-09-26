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
if [[ ! "$APP_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "✗ نام نقش نامعتبر" >&2; exit 1
fi

DBNAME=$(psql -tAc 'SELECT current_database()' -d "$DATABASE_URL")

# نام سفارشی برنامه نباید نقش مالک/ابزار را تغییر دهد، حتی با پیکربندی اشتباه.
OWNER_ROLE=$(psql -tA -v ON_ERROR_STOP=1 -v app_role="$APP_ROLE" -d "$DATABASE_URL" <<'SQL'
SELECT EXISTS (
  SELECT 1 FROM pg_roles r WHERE r.rolname=:'app_role'
    AND (r.rolname IN (current_user,session_user) OR r.oid=(SELECT datdba FROM pg_database WHERE datname=current_database())
      OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid
        AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema')
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relowner=r.oid AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema')
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE p.proowner=r.oid AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'))
);
SQL
)
if [ "$OWNER_ROLE" = t ]; then
  echo "✗ نقش برنامه باید مستقل از مالک دیتابیس و اشیای برنامه باشد؛ نقش مالک تغییر نکرد." >&2
  exit 1
fi

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

# ⚠️ **در بدنهٔ دو heredoc زیر (`<<SQL`، بی نقل‌قول) Backtick نگذار.**
#    آن‌ها برای `$APP_ROLE` و `$SCHEMAS` عمداً بی‌نقل‌قول‌اند، پس bash
#    محتوایشان را بسط می‌دهد و یک Backtick در **کامنت SQL** تبدیل به
#    Command Substitution می‌شود. نسخهٔ قبلی همین فایل ۱۳ سطر کامنت با
#    Backtick داشت و خروجی‌اش ۹ خط `command not found` به‌علاوهٔ یک
#    `syntax error: unexpected end of file` بود — یعنی متنی که به psql
#    می‌رسید **همان چیزی نبود که در فایل نوشته شده**. اینجا کامنت بود و
#    بی‌ضرر؛ یک Backtick در خودِ دستور REVOKE بی‌صدا حذفش می‌کرد.
#    داخل heredoc از « » استفاده کن. کامنت‌های `#` بیرون heredoc آزادند.
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

-- ۴. و «public» — که در فهرست اسکیماهای بالا **نیست** و باید باشد.
--    هر شش تابع «SECURITY DEFINER» این پروژه «public» را در
--    «search_path» پین‌شدهٔ خود دارند (چون «pgcrypto» آنجاست و
--    «platform.uuid_v7()» به «gen_random_bytes()» نیاز دارد). اگر نقش
--    برنامه بتواند در «public» شیء بسازد، می‌تواند تابعی هم‌نام
--    بگذارد که **به‌نام مالک** اجرا شود — یعنی دقیقاً همان ارتقای
--    دسترسی که پین‌کردن search_path قرار بود ببندد.
--
--    پستگرس ۱۵ به بعد این را پیش‌فرض بسته، ولی «پیش‌فرضِ درست» یک
--    دفاع نیست: دیتابیسی که از نسخهٔ قدیمی‌تر ارتقا داده شده باشد
--    هنوز بازش دارد، و یک «GRANT» سهوی هم کافی است.
REVOKE CREATE ON SCHEMA public FROM $APP_ROLE;

-- ۵. و سه **کمکیِ درونیِ** Push سایت. این‌ها «SECURITY DEFINER»اند —
--    یعنی به‌نام **مالک** اجرا می‌شوند و روی «platform.outbox_message»
--    می‌نویسند بی‌آنکه حق جدولِ فراخوان سنجیده شود. هیچ مسیر برنامه‌ای
--    صدایشان نمی‌زند؛ «apply_movement» و «set_price» از **داخل**
--    دیتابیس می‌زنندشان و آنجا فراخوان همان مالک است.
--
--    ⚠️ مهاجرت ۰۶۰ «EXECUTE» را از «PUBLIC» گرفت و **آن کافی نیست**:
--       «GRANT EXECUTE ON ALL FUNCTIONS» بالای همین فایل — که پس از
--       مهاجرت اجرا می‌شود — آن را برای نقش برنامه دوباره باز می‌کند.
--       پس REVOKE باید **اینجا** باشد، دقیقاً مثل سه جدول بند ۳.
--
--    خطرش اندازه‌گیری شد (FND-R60-04): نقشی با فقط
--    «USAGE ON SCHEMA platform» می‌توانست
--    «enqueue_web_push('web.stock_push', '{"onHand":9999,…}')» بزند،
--    Worker امضایش می‌کرد، و موجودی واقعی سایت ۹۹۹۹ می‌شد.
REVOKE EXECUTE ON FUNCTION platform.enqueue_web_push(text, jsonb) FROM $APP_ROLE;
REVOKE EXECUTE ON FUNCTION inventory.push_web_stock(uuid, uuid)   FROM $APP_ROLE;
REVOKE EXECUTE ON FUNCTION catalog.push_web_price(uuid)           FROM $APP_ROLE;
SQL

# ⚠️ اینجا عمداً `ALTER DEFAULT PRIVILEGES … REVOKE … IN SCHEMA inventory`
#    **نیست**، و یک بار بود و اشتباه بود.
#
#    پیش‌فرض به **نام جدول** کار نمی‌کند، به **اسکیما** کار می‌کند. پس آن
#    سطر، حق نوشتن را از هر جدول تازه‌ای در `inventory` می‌گرفت — از
#    جمله `stock_count`، `transfer` و هر چیزی که مهاجرت بعدی بسازد — در
#    حالی که چند سطر بالاتر همین اسکریپت وعده داده «جدولی که مهاجرت
#    بعدی بسازد خودبه‌خود پوشیده شود».
#
#    اندازه‌گیری شد: یک `CREATE TABLE inventory.probe(...)` به‌نام مالک،
#    و بعد `has_table_privilege('labelmod_app', …, 'INSERT')` = false،
#    در حالی که همان جدول در `sales` = true. یعنی اولین نوشتن روی آن
#    جدول تازه، **پس از استقرار** و روی سیستم زنده، ۵۰۰ می‌داد.
#
#    سه جدول تغییرناپذیر با نامشان بسته شده‌اند، مثل `audit_log` — یک
#    تصمیم صریح به‌ازای هر جدول، نه یک قاعدهٔ نانوشته روی کل اسکیما.
#    `db/test/db-roles.sh` هر دو جهت را می‌سنجد.

echo
echo "✓ نقش $APP_ROLE آماده است."
echo
echo "قدم بعدی — و تا انجام نشود هیچ محدودیتی فعال نیست:"
echo "  DATABASE_URL برنامه را به این نقش عوض کنید."
echo "  مهاجرت‌ها با همان نقش مالک قبلی اجرا می‌شوند."
echo "  سپس یک بار بسنجید:  DATABASE_URL='…app…' ops/deploy.sh status"
