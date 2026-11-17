#!/usr/bin/env bash
# =====================================================================
# تست هم‌زمانی نگه‌داشت پرداخت آنلاین (مهاجرت ۱۲۵) — دو نشست واقعی
# =====================================================================
# خواستهٔ مالک: کالای تک‌قلم را دو نفر نخرند. این تست همان لحظه را می‌سازد:
#   الف) دو مشتری آنلاین هم‌زمان قلم آخر را نگه می‌دارند.
#   ب)  مشتری آنلاین نگه می‌دارد و صندوق هم‌زمان همان قلم را می‌فروشد.
# هر دور کالای تازه با **یک** عدد. انتظار: دقیقاً یکی برنده، دیگری ردِ قابل فهم،
# و هرگز on_hand < reserved یا موجودی منفی.
#
# ⚠️ هر نشست پس از اقدامش ۰٫۳ ثانیه تراکنش را باز نگه می‌دارد تا دیگری واقعاً
#    پشت قفل سطر موجودی برسد؛ بی آن، دو فراخوان پشت سر هم اجرا می‌شدند و تست
#    فقط ترتیب را می‌سنجید، نه هم‌زمانی را.
# ⚠️ کنترل مثبت: در هر دور باید یکی **موفق** شود. اگر هر دو رد شوند (مثلاً قفلِ
#    بن‌بست)، تست قرمز است — «هیچ‌کس نخرید» هم باگ است.
# =====================================================================
set -u
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
CONN="${DATABASE_URL:-}"
if [ -z "$CONN" ]; then CONN="dbname=${PGDATABASE:-labelmod}"; fi
PSQL="psql -v ON_ERROR_STOP=1 -q -t -A -d"
run() { $PSQL "$CONN" "$@"; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

RID="$$$(date +%s)"
ROUNDS=8
BR='00000000-0000-7000-8000-000000000001'
WH='00000000-0000-7000-8000-000000000101'
fail=0

ACTOR=$(run -v rid="$RID" -v br="$BR" <<'SQL'
INSERT INTO identity.app_user(username,full_name,is_active)
  VALUES('race-hold-'||:'rid','آزمون هم‌زمانی نگه‌داشت',false) RETURNING id \gset
INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(:'id','web',:'br');
SELECT :'id';
SQL
)
ACTOR=$(echo "$ACTOR" | tail -1)

new_item () {   # $1 = sku ؛ یک عدد موجودی
  run -v sku="$1" -v wh="$WH" -v actor="$ACTOR" <<'SQL' >/dev/null
SELECT platform.set_actor(:'actor'::uuid);
WITH p AS (INSERT INTO catalog.product(code,name_internal) VALUES('P-'||:'sku','کالای هم‌زمانی') RETURNING id),
     v AS (INSERT INTO catalog.variation(product_id,sku,color,size) SELECT id,:'sku','سفید','M' FROM p RETURNING id)
SELECT inventory.apply_movement(v.id,:'wh'::uuid,1,'opening',NULL,NULL,:'actor'::uuid,1000000) FROM v;
SQL
}

hold () {   # $1 = sku ، $2 = شمارهٔ سفارش ، $3 = پروندهٔ خروجی
  run -v sku="$1" -v ext="$2" -v br="$BR" -v wh="$WH" -v actor="$ACTOR" > "$3" 2>&1 <<'SQL'
BEGIN;
SELECT inventory.web_checkout_hold(:'actor'::uuid,:'ext',:'br'::uuid,:'wh'::uuid,
  jsonb_build_array(jsonb_build_object('sku',:'sku','qty','1')))->>'status';
SELECT pg_sleep(0.3);
COMMIT;
SQL
}

pos_sale () {   # $1 = sku ، $2 = پروندهٔ خروجی ، $3 = تأخیر شروع (ثانیه) — همان دروازهٔ نهایی‌سازی صندوق
  run -v sku="$1" -v wh="$WH" -v actor="$ACTOR" -v delay="$3" > "$2" 2>&1 <<'SQL'
BEGIN;
SELECT pg_sleep(:'delay'::float8);
SELECT platform.set_actor(:'actor'::uuid);
SELECT inventory.apply_movement(v.id,:'wh'::uuid,-1,'sale','race',v.id,:'actor'::uuid)
  FROM catalog.variation v WHERE v.sku = :'sku';
SELECT 'sold';
SELECT pg_sleep(0.3);
COMMIT;
SQL
}

state () {   # «on_hand reserved»
  run -v sku="$1" -v wh="$WH" <<'SQL'
SELECT trim_scale(b.on_hand)||' '||trim_scale(b.reserved) FROM inventory.stock_balance b
  JOIN catalog.variation v ON v.id=b.variation_id WHERE v.sku=:'sku' AND b.warehouse_id=:'wh'::uuid;
SQL
}

echo "═══ الف) دو مشتری آنلاین، یک قلم — $ROUNDS دور ═══"
for i in $(seq 1 $ROUNDS); do
  sku="RH-A-$RID-$i"; new_item "$sku"
  hold "$sku" "A1-$RID-$i" "$TMP/a1" & p1=$!
  hold "$sku" "A2-$RID-$i" "$TMP/a2" & p2=$!
  wait $p1 $p2
  held=$(cat "$TMP/a1" "$TMP/a2" | grep -cx 'held')
  unav=$(cat "$TMP/a1" "$TMP/a2" | grep -cx 'unavailable')
  st=$(state "$sku")
  if [ "$held" = 1 ] && [ "$unav" = 1 ] && [ "$st" = "1 1" ]; then
    echo "  ✓ دور $i: یکی نگه داشت، دیگری رد شد (موجودی/رزرو = $st)"
  else
    echo "  ✗ دور $i: held=$held unavailable=$unav موجودی/رزرو=$st"; cat "$TMP/a1" "$TMP/a2"; fail=1
  fi
done

echo "═══ ب) مشتری آنلاین و صندوق، یک قلم — $ROUNDS دور ═══"
won_web=0; won_pos=0
for i in $(seq 1 $ROUNDS); do
  sku="RH-B-$RID-$i"; new_item "$sku"
  # دورهای زوج صندوق ۰٫۱ ثانیه دیرتر شروع می‌کند تا پشت قفلِ نگه‌داشتِ هنوز Commitنشده
  # منتظر بماند؛ دورهای فرد هم‌زمان. پس هر دو طرف هم برنده می‌شوند و هم می‌بازند.
  if [ $((i % 2)) = 0 ]; then d=0.1; else d=0; fi
  hold "$sku" "B-$RID-$i" "$TMP/w" & p1=$!; pos_sale "$sku" "$TMP/p" "$d" & p2=$!
  wait $p1 $p2
  web=$(grep -cx 'held' "$TMP/w"); sold=$(grep -cx 'sold' "$TMP/p")
  st=$(state "$sku")
  if [ "$web" = 1 ] && [ "$sold" = 0 ] && [ "$st" = "1 1" ] && grep -q 'رزرو شده' "$TMP/p"; then
    won_web=$((won_web + 1)); echo "  ✓ دور $i: سایت برد؛ صندوق با «رزرو سایت» رد شد"
  elif [ "$web" = 0 ] && [ "$sold" = 1 ] && [ "$st" = "0 0" ] && grep -qx 'unavailable' "$TMP/w"; then
    won_pos=$((won_pos + 1)); echo "  ✓ دور $i: صندوق برد؛ سایت پیش از پرداخت «ناموجود» گرفت"
  else
    echo "  ✗ دور $i: held=$web sold=$sold موجودی/رزرو=$st"; cat "$TMP/w" "$TMP/p"; fail=1
  fi
done
echo "  (سایت $won_web بار، صندوق $won_pos بار برد)"
# کنترل: هر دو مسیر رد واقعاً پیموده شده‌اند، نه فقط یکی.
if [ "$won_web" = 0 ] || [ "$won_pos" = 0 ]; then echo "  ✗ فقط یک طرف برد؛ هم‌زمانی هر دو جهت سنجیده نشد"; fail=1; fi

bad=$(run <<'SQL'
SELECT count(*) FROM inventory.stock_balance WHERE on_hand < 0 OR on_hand < reserved OR checkout_held > reserved;
SQL
)
if [ "$bad" = 0 ]; then echo "  ✓ هیچ موجودی منفی یا رزرو بیش از موجودی"; else echo "  ✗ $bad سطر ناسازگار"; fail=1; fi

[ "$fail" = 0 ] && echo "✔ هم‌زمانی نگه‌داشت — تک‌قلم هرگز دو بار فروخته نشد" || echo "✗ هم‌زمانی نگه‌داشت ناموفق"
exit "$fail"
