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
run -c "DROP ROLE \"$ROLE\";" >/dev/null 2>&1
cleanup () {
  run -c "DROP ROLE IF EXISTS \"lmc_probe_$RID\";" >/dev/null 2>&1
  run -c "REASSIGN OWNED BY \"$ROLE\" TO CURRENT_USER;" >/dev/null 2>&1
  run -c "DROP OWNED BY \"$ROLE\";" >/dev/null 2>&1
  run -c "DROP ROLE IF EXISTS \"$ROLE\";" >/dev/null 2>&1
}
trap cleanup EXIT

# ⚠️ حق‌ها از **خودِ `ops/db-roles.sh`** گرفته می‌شوند، نه از یک کپی
#    در همین فایل. نسخهٔ اول اینجا GRANT و REVOKE را دوباره می‌نوشت و
#    نتیجه‌اش این بود که تست دربارهٔ اسکریپتِ تولیدی **هیچ‌چیز** ثابت
#    نمی‌کرد: اگر آن اسکریپت یک GRANT کم می‌گذاشت یا یکی زیادی
#    می‌گرفت، این تست همچنان سبز بود.
APP_PASSWORD='roletest' APP_ROLE="$ROLE" DATABASE_URL="$CONN" \
  bash "$(dirname "$0")/../../ops/db-roles.sh" >/dev/null 2>&1 \
  || { echo "  ✗ ops/db-roles.sh شکست خورد"; exit 1; }

DBNAME=$(run -c "SELECT current_database();")

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
# مرجع مصنوعی اجباری است (مهاجرت ۰۵۹): حرکتِ بی سند از دروازه هم رد
# می‌شود، نه فقط از درج مستقیم.
run -c "SELECT inventory.apply_movement('$VAR_ID'::uuid,
  '00000000-0000-7000-8000-000000000101'::uuid, 5, 'purchase_receipt',
  'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid,
  '$USER_ID'::uuid, 1000);" >/dev/null

MOVES=$(run -c "SELECT count(*) FROM inventory.stock_movement;")
[ "$MOVES" -ge 1 ] || { echo "  ✗ آماده‌سازی نشد — حمله روی جدول خالی بی‌معناست"; exit 1; }

TEST_HOST=$(run -c "SELECT coalesce(host(inet_server_addr()),'127.0.0.1');")
TEST_PORT=$(run -c "SHOW port;")
APP_CONN="host=$TEST_HOST port=$TEST_PORT dbname=$DBNAME user=$ROLE password=roletest"

echo "═══ حمله با نقش برنامه، روی سطر موجود، تا COMMIT ═══"
# ⚠️ «شکست خورد» کافی نیست — **دلیلِ** شکست سنجیده می‌شود.
#    نسخهٔ اول فقط Exit Code را می‌دید، و یک حملهٔ تازه که ستونش را
#    اشتباه نوشته بودم (`qty_remaining` به‌جای `qty_left`) با
#    «column does not exist» شکست خورد و تست **سبز** شد: یعنی ادعایی
#    که هیچ‌وقت هیچ حقی را نسنجیده بود. حالا SQLSTATE باید 42501
#    (insufficient_privilege) باشد.
attack () {
  local label="$1" sql="$2" out rc
  out=$(psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" \
        -c "BEGIN;" -c "$sql" -c "COMMIT;" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "  ✗ $label — موفق شد، یعنی راه باز است"; FAIL=1
  elif printf '%s' "$out" | grep -q "permission denied"; then
    echo "  ✓ $label — رد شد"
  else
    echo "  ✗ $label — شکست خورد ولی نه از بابت دسترسی:"
    printf '      %s\n' "$(printf '%s' "$out" | grep -m1 -i "ERROR")"
    FAIL=1
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
# `cost_layer` هم در همان REVOKE هست ولی تا امروز سنجیده نمی‌شد — یعنی
# یک‌سومِ ادعای اسکریپت بی‌شاهد بود. FIFO لایه‌هایش را همان‌جا نگه می‌دارد.
attack "INSERT مستقیم در لایه بهای تمام‌شده" "INSERT INTO inventory.cost_layer (variation_id, warehouse_id, qty_in, qty_left, unit_cost, occurred_at) SELECT variation_id, warehouse_id, 1, 1, 1000, now() FROM inventory.stock_balance LIMIT 1;"
attack "UPDATE روی لایه بهای تمام‌شده"      "UPDATE inventory.cost_layer SET qty_left = 0;"
# ⚠️ `public` در `search_path` پین‌شدهٔ هر شش تابع `SECURITY DEFINER`
#    هست. اگر نقش برنامه بتواند آنجا شیء بسازد، می‌تواند تابعی هم‌نام
#    بگذارد که به‌نام **مالک** اجرا شود — یعنی پین‌کردن search_path
#    بی‌اثر می‌شد.
attack "DDL در اسکیمای public"              "CREATE TABLE public.evil (x int);"

# ⚠️ یافتهٔ FND-R60-04 — سه **کمکیِ درونیِ** Push سایت.
#    این‌ها `SECURITY DEFINER`اند، یعنی به‌نام مالک روی
#    `platform.outbox_message` می‌نویسند و حق جدولِ فراخوان سنجیده
#    نمی‌شود. تا مهاجرت ۰۶۰ ACL پیش‌فرض داشتند (EXECUTE برای PUBLIC) و
#    نقش برنامه — و هر نقش دیگری با `USAGE` روی اسکیما — می‌توانست یک
#    پیام دلخواه در صف بگذارد. Worker امضایش می‌کرد و موجودی واقعی
#    سایت عوض می‌شد.
attack "enqueue_web_push با نقش برنامه" \
  "SELECT platform.enqueue_web_push('web.stock_push','{\"variationId\":\"$VAR_ID\",\"onHand\":9999}'::jsonb);"
attack "push_web_stock با نقش برنامه" \
  "SELECT inventory.push_web_stock('$VAR_ID'::uuid,'00000000-0000-7000-8000-000000000101'::uuid);"
attack "push_web_price با نقش برنامه" \
  "SELECT catalog.push_web_price('$VAR_ID'::uuid);"

echo
echo "═══ و نقشی که فقط USAGE روی یک اسکیما دارد ═══"
# ⚠️ این همان بازتولید یافته است، عیناً: نقشی **بی هیچ حقی روی هیچ
#    جدولی**. پیش از ۰۶۰ درج مستقیمش رد می‌شد و فراخوان تابع قبول —
#    یعنی ACL تابع تنها چیزی بود که آن نقش را بیرون نگه می‌داشت، و
#    نداشتش.
PROBE="lmc_probe_$RID"
run -c "CREATE ROLE \"$PROBE\" LOGIN PASSWORD 'probetest';" >/dev/null
run -c "GRANT CONNECT ON DATABASE \"$DBNAME\" TO \"$PROBE\";" >/dev/null
run -c "GRANT USAGE ON SCHEMA platform TO \"$PROBE\";" >/dev/null
PROBE_CONN="host=$TEST_HOST port=$TEST_PORT dbname=$DBNAME user=$PROBE password=probetest"

probe_denied () {
  local label="$1" sql="$2" out rc
  out=$(psql -v ON_ERROR_STOP=1 -q -d "$PROBE_CONN" -tAc "$sql" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "  ✗ $label — موفق شد، یعنی ارتقای دسترسی باز است"; FAIL=1
  elif printf '%s' "$out" | grep -q "permission denied"; then
    echo "  ✓ $label — رد شد"
  else
    echo "  ✗ $label — شکست خورد ولی نه از بابت دسترسی:"
    printf '      %s\n' "$(printf '%s' "$out" | grep -m1 -i 'ERROR')"
    FAIL=1
  fi
}

# کنترل مثبت: درج مستقیم هم باید رد شود. بی این، اگر روزی نقش probe
# سهواً حق جدول بگیرد، ادعای پایین دربارهٔ **تابع** چیزی ثابت نمی‌کند.
probe_denied "درج مستقیم در صف پیام" \
  "INSERT INTO platform.outbox_message (topic, payload) VALUES ('web.stock_push','{}'::jsonb);"
probe_denied "enqueue_web_push با نقشِ فقط-USAGE" \
  "SELECT platform.enqueue_web_push('web.stock_push','{\"variationId\":\"$VAR_ID\",\"onHand\":9999,\"version\":999999999}'::jsonb);"

run -c "DROP ROLE IF EXISTS \"$PROBE\";" >/dev/null 2>&1

echo
echo "═══ و دروازهٔ قانونی باید هنوز کار کند ═══"
# بی‌این ادعا، تست بالا با یک REVOKE بی‌رویه هم «پاس» می‌شد و فروش را
# می‌شکست. قفل بی‌دروازه، امنیت نیست.
if psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" -tAc \
   "SELECT inventory.apply_movement('$VAR_ID'::uuid,
      '00000000-0000-7000-8000-000000000101'::uuid, 3, 'purchase_receipt',
      'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid,
      '$USER_ID'::uuid, 1000);" >/dev/null 2>&1; then
  echo "  ✓ apply_movement با نقش برنامه کار کرد"
else
  echo "  ✗ apply_movement با نقش برنامه شکست — دروازه هم بسته شد"; FAIL=1
fi

# دو دروازهٔ دیگر که تا مهاجرت ۰۵۸ `SECURITY DEFINER` نبودند و با نقش
# برنامه می‌شکستند. `revalue_to_cost` را `purchasing.post_receipt()`
# صدا می‌زند و `costing.method` **پیش‌فرض** `last_purchase` است — یعنی
# بی این، هیچ رسید خریدی ثبت نمی‌شد.
if psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" -tAc \
   "SELECT inventory.revalue_to_cost('$VAR_ID'::uuid,
      '00000000-0000-7000-8000-000000000101'::uuid, 1200, '$USER_ID'::uuid,
      'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid);" >/dev/null 2>&1; then
  echo "  ✓ revalue_to_cost با نقش برنامه کار کرد"
else
  echo "  ✗ revalue_to_cost با نقش برنامه شکست — رسید خرید در تولید می‌شکند"; FAIL=1
fi

# ⚠️ و دروازهٔ سوم: `catalog.set_price()`. مهاجرت ۰۶۰ آن را DEFINER کرد
#    چون `catalog.push_web_price()` را از نقش برنامه گرفت — و بی آن،
#    **هر تغییر قیمتی در تولید ۵۰۰ می‌داد**:
#        permission denied for function push_web_price
#    این ادعا همان شکست را قفل می‌کند.
if psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" -tAc \
   "SELECT platform.set_actor('$USER_ID'::uuid, NULL, NULL, NULL);
    SELECT catalog.set_price('$VAR_ID'::uuid, 250000, 'regular', 'تست نقش');" >/dev/null 2>&1; then
  echo "  ✓ set_price با نقش برنامه کار کرد"
else
  echo "  ✗ set_price با نقش برنامه شکست — تغییر قیمت در تولید می‌شکند"; FAIL=1
fi


# ⚠️ و جدولی که **مهاجرت بعدی** بسازد باید نوشتنی بماند. نسخهٔ اول
#    `ops/db-roles.sh` یک `ALTER DEFAULT PRIVILEGES … REVOKE` روی کل
#    اسکیمای inventory داشت؛ پیش‌فرض به **اسکیما** کار می‌کند نه به
#    **نام جدول**، پس هر جدول تازه‌ای بی‌صدا فقط‌خواندنی می‌شد و اولین
#    نوشتن روی آن، پس از استقرار، ۵۰۰ می‌داد.
run -c "CREATE TABLE inventory.roletest_future (id int);" >/dev/null 2>&1
FUTURE=$(run -c "SELECT has_table_privilege('$ROLE','inventory.roletest_future','INSERT');")
run -c "DROP TABLE inventory.roletest_future;" >/dev/null 2>&1
[ "$FUTURE" = "t" ] \
  && echo "  ✓ جدول تازه در inventory برای نقش برنامه نوشتنی است" \
  || { echo "  ✗ جدول تازه در inventory فقط‌خواندنی شد — پیش‌فرض بیش از حد بسته است"; FAIL=1; }

ONHAND=$(run -c "SELECT on_hand FROM inventory.stock_balance WHERE variation_id='$VAR_ID';")
[ "${ONHAND%%.*}" = "8" ] \
  && echo "  ✓ موجودی از دروازه درست عوض شد (۸ = ۵+۳)" \
  || { echo "  ✗ موجودی: $ONHAND (انتظار ۸)"; FAIL=1; }

DIVERGED=$(run -c "SELECT count(*) FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0;")
[ "$DIVERGED" = "0" ] \
  && echo "  ✓ بدون واگرایی مانده از حرکت‌ها" \
  || { echo "  ✗ واگرایی: $DIVERGED"; FAIL=1; }

# ⚠️ و Push سایت باید از **همان دروازه** پر شود. مهاجرت ۰۶۰ حق فراخوانِ
#    مستقیمِ سه کمکی را از نقش برنامه گرفت؛ اگر همین‌جا نسنجیم که Push
#    از داخل `apply_movement` هنوز کار می‌کند، یک REVOKE بیش از حد
#    می‌توانست همگام‌سازی سایت را **بی‌صدا** خاموش کند و هر سیزده حملهٔ
#    بالا همچنان سبز بمانند.
#
# ⚠️ عمداً **پس از** ادعای موجودی است: این بند یک حرکت دیگر می‌زند و
#    اگر بالاتر می‌بود، ادعای «۸ = ۵+۳» را ۱۰ می‌خواند.
#
# ⚠️ و تنظیم از `platform.set_setting()` عوض می‌شود، نه با UPDATE:
#    یک Trigger روی `platform.setting` جلوی UPDATE مستقیم را می‌گیرد.
#    نسخهٔ اول این بند UPDATE می‌زد و دو خطای فارسی گرفت.
run -c "SELECT platform.set_setting('web.push_enabled', 'true'::jsonb,
          'تست نقش', '$USER_ID'::uuid);" >/dev/null
run -c "SELECT platform.set_setting('web.stock_warehouse', '\"STORE\"'::jsonb,
          'تست نقش', '$USER_ID'::uuid);" >/dev/null

MAX_Q=$(run -c "SELECT coalesce(max(id),0) FROM platform.outbox_message;")
psql -v ON_ERROR_STOP=1 -q -d "$APP_CONN" -tAc \
  "SELECT inventory.apply_movement('$VAR_ID'::uuid,
     '00000000-0000-7000-8000-000000000101'::uuid, 2, 'purchase_receipt',
     'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid,
     '$USER_ID'::uuid, 1000);" >/dev/null 2>&1
NEW_Q=$(run -c "SELECT count(*) FROM platform.outbox_message
                 WHERE id > $MAX_Q AND topic = 'web.stock_push';")
[ "$NEW_Q" -ge 1 ] \
  && echo "  ✓ Push سایت از داخل apply_movement پر شد (نقش برنامه)" \
  || { echo "  ✗ Push سایت پر نشد — REVOKE بیش از حد، همگام‌سازی سایت خاموش"; FAIL=1; }

# و نسخه از **دنباله** می‌آید. ادعا روی سطرِ تازه است، نه آخرین سطر:
# سطر قدیمی‌تر می‌تواند نسخهٔ دلخواه یک مهاجمِ قبلی را داشته باشد.
SEQ_NOW=$(run -c "SELECT last_value FROM platform.web_push_version;")
PUSH_VER=$(run -c "SELECT payload->>'version' FROM platform.outbox_message
                    WHERE id > $MAX_Q AND topic = 'web.stock_push'
                    ORDER BY id DESC LIMIT 1;")
[ -n "$PUSH_VER" ] && [ "$PUSH_VER" -le "$SEQ_NOW" ] 2>/dev/null \
  && echo "  ✓ نسخهٔ Push از دنباله آمد ($PUSH_VER ≤ $SEQ_NOW)" \
  || { echo "  ✗ نسخهٔ Push از دنباله نیامد: '$PUSH_VER' (دنباله: $SEQ_NOW)"; FAIL=1; }

run -c "SELECT platform.set_setting('web.push_enabled', 'false'::jsonb,
          'تست نقش', '$USER_ID'::uuid);" >/dev/null


echo
if [ $FAIL -eq 0 ]; then
  echo "╔══════════════════════════════════════╗"
  echo "║   تست نقش دیتابیس پاس شد            ║"
  echo "╚══════════════════════════════════════╝"
else
  echo "✗✗✗ تست نقش دیتابیس رد شد ✗✗✗"
  exit 1
fi
