#!/usr/bin/env bash
# =====================================================================
# نقش واقعی دیتابیس — آنچه بند ۳ SECURITY.md وعده داده بود
# =====================================================================
# این تست با **نقش برنامه** حمله می‌کند، نه با مالک و نه با superuser.
# تستی که با مالک اجرا شود، دربارهٔ GRANT هیچ‌چیز اثبات نمی‌کند: مالک
# همه‌چیز را می‌تواند و همهٔ حمله‌ها «موفق» می‌شوند.
#
# چهار ادعای بند ۳ به‌علاوهٔ یکی که سند نگفته بود ولی خطرش بیشتر است:
# نوشتن **مستقیم** روی `stock_balance`. آن جدول Projection است و
# Trigger تغییرناپذیری نمی‌تواند داشته باشد، پس تا مهاجرت ۰۵۰ تنها
# دفاعش یک **نما** بود که کسی باید نگاهش می‌کرد.
#
# ⚠️ حمله‌ها روی **سطر موجود** و تا **COMMIT** اجرا می‌شوند: یک
#    `UPDATE … WHERE true` روی جدول خالی هیچ Triggerی را صدا نمی‌زند و
#    هیچ حقی را نمی‌سنجد — «موفقیت»ش بی‌معناست.
# =====================================================================
set -uo pipefail
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
CONN="${DATABASE_URL:?DATABASE_URL لازم است}"
PSQL="psql -v ON_ERROR_STOP=1 -q -t -A -d"
run () { $PSQL "$CONN" "$@"; }

RID="r$$$(date +%s)"
ROLE="lmc_roletest_$RID"
FAIL=0

# ساخت نقش به CREATEROLE نیاز دارد. اگر نشد، **صریح شکست** می‌دهیم و
# Skip گزارش نمی‌کنیم — نبودِ توان سنجش، «پاس» نیست.
if ! run -c "CREATE ROLE \"$ROLE\" LOGIN PASSWORD 'roletest';" >/dev/null 2>&1; then
  echo "  ✗ ساخت نقش آزمون ممکن نشد — این تست به CREATEROLE نیاز دارد و Skip نمی‌شود"
  exit 1
fi
cleanup () {
  run -c "REASSIGN OWNED BY \"$ROLE\" TO CURRENT_USER;" >/dev/null 2>&1
  run -c "DROP OWNED BY \"$ROLE\";" >/dev/null 2>&1
  run -c "DROP ROLE IF EXISTS \"$ROLE\";" >/dev/null 2>&1
}
trap cleanup EXIT

SCHEMAS="platform,identity,catalog,inventory,purchasing,sales,treasury,ledger"
DBNAME=$(run -c "SELECT current_database();")

run >/dev/null 2>&1 <<SQL
GRANT CONNECT ON DATABASE "$DBNAME" TO "$ROLE";
GRANT USAGE ON SCHEMA $SCHEMAS TO "$ROLE";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA $SCHEMAS TO "$ROLE";
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA $SCHEMAS TO "$ROLE";
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA $SCHEMAS TO "$ROLE";
REVOKE CREATE ON SCHEMA $SCHEMAS FROM "$ROLE";
REVOKE UPDATE, DELETE         ON platform.audit_log       FROM "$ROLE";
REVOKE INSERT, UPDATE, DELETE ON inventory.stock_movement FROM "$ROLE";
REVOKE INSERT, UPDATE, DELETE ON inventory.stock_balance  FROM "$ROLE";
REVOKE INSERT, UPDATE, DELETE ON inventory.cost_layer     FROM "$ROLE";
SQL

# دادهٔ واقعی، تا حمله روی سطر موجود بیفتد.
IDS=$(run <<SQL
INSERT INTO identity.app_user (username, full_name)
VALUES ('roletest-$RID','تست نقش') RETURNING id;
SQL
)
USER_ID=$(echo "$IDS" | head -1)
VAR_ID=$(run <<SQL
WITH p AS (
  INSERT INTO catalog.product (code, name_internal)
  VALUES ('RT-$RID','کالای تست نقش') RETURNING id
)
INSERT INTO catalog.variation (product_id, sku, color, size)
SELECT id, 'RT-$RID-M', 'آبی', 'M' FROM p RETURNING id;
SQL
)
run -c "SELECT inventory.apply_movement('$VAR_ID'::uuid,
  '00000000-0000-7000-8000-000000000101'::uuid, 5, 'purchase_receipt', NULL, NULL,
  '$USER_ID'::uuid, 1000);" >/dev/null

MOVES=$(run -c "SELECT count(*) FROM inventory.stock_movement;")
[ "$MOVES" -ge 1 ] || { echo "  ✗ آماده‌سازی نشد — حمله روی جدول خالی بی‌معناست"; exit 1; }

APP_CONN="postgresql://$ROLE:roletest@localhost:5432/$DBNAME"

echo "═══ حمله با نقش برنامه، روی سطر موجود، تا COMMIT ═══"
attack () {
  local label="$1" sql="$2"
  if psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" -c "BEGIN;" -c "$sql" -c "COMMIT;" >/dev/null 2>&1; then
    echo "  ✗ $label — موفق شد، یعنی راه باز است"; FAIL=1
  else
    echo "  ✓ $label — رد شد"
  fi
}

attack "UPDATE روی حرکت انبار"              "UPDATE inventory.stock_movement SET qty = qty + 1;"
attack "DELETE از حرکت انبار"               "DELETE FROM inventory.stock_movement;"
attack "INSERT مستقیم در حرکت انبار"        "INSERT INTO inventory.stock_movement (variation_id, warehouse_id, qty, kind) SELECT variation_id, warehouse_id, 1, 'purchase_receipt' FROM inventory.stock_balance LIMIT 1;"
attack "UPDATE روی لاگ حسابرسی"             "UPDATE platform.audit_log SET action = 'tampered';"
attack "DELETE از لاگ حسابرسی"              "DELETE FROM platform.audit_log;"
attack "DDL در اسکیمای مالی"                "CREATE TABLE identity.evil (x int);"
# ⚠️ این یکی تا مهاجرت ۰۵۰ **موفق می‌شد** و CLAUDE.md اعتراف کرده بود
#    که «دیتابیس جلویش را نمی‌گیرد».
attack "UPDATE مستقیم روی مانده موجودی"     "UPDATE inventory.stock_balance SET on_hand = 999;"

echo
echo "═══ و دروازهٔ قانونی باید هنوز کار کند ═══"
# بی‌این ادعا، تست بالا با یک REVOKE بی‌رویه هم «پاس» می‌شد و فروش را
# می‌شکست. قفل بی‌دروازه، امنیت نیست.
if psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" -tAc \
   "SELECT inventory.apply_movement('$VAR_ID'::uuid,
      '00000000-0000-7000-8000-000000000101'::uuid, 3, 'purchase_receipt', NULL, NULL,
      '$USER_ID'::uuid, 1000);" >/dev/null 2>&1; then
  echo "  ✓ apply_movement با نقش برنامه کار کرد"
else
  echo "  ✗ apply_movement با نقش برنامه شکست — دروازه هم بسته شد"; FAIL=1
fi

ONHAND=$(run -c "SELECT on_hand FROM inventory.stock_balance WHERE variation_id='$VAR_ID';")
[ "${ONHAND%%.*}" = "8" ] \
  && echo "  ✓ موجودی از دروازه درست عوض شد (۸ = ۵+۳)" \
  || { echo "  ✗ موجودی: $ONHAND (انتظار ۸)"; FAIL=1; }

DIVERGED=$(run -c "SELECT count(*) FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0;")
[ "$DIVERGED" = "0" ] \
  && echo "  ✓ بدون واگرایی مانده از حرکت‌ها" \
  || { echo "  ✗ واگرایی: $DIVERGED"; FAIL=1; }

echo
if [ $FAIL -eq 0 ]; then
  echo "╔══════════════════════════════════════╗"
  echo "║   تست نقش دیتابیس پاس شد            ║"
  echo "╚══════════════════════════════════════╝"
else
  echo "✗✗✗ تست نقش دیتابیس رد شد ✗✗✗"
  exit 1
fi
