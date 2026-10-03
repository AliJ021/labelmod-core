#!/usr/bin/env bash
# =====================================================================
# رقابت اتصال رسید به سفارش با تغییر هم‌زمان والد (FND29، مهاجرت ۰۸۹)
# =====================================================================
# نگهبان‌های ۰۸۹ دو سمت دارند: درج رسید/سطر رسید والد را می‌خواند، و
# تغییر والد دنبال فرزند وصل‌شده می‌گردد. هر دو `EXISTS`/خواندن ساده
# بودند و FK فقط FOR KEY SHARE می‌گیرد؛ پس دو تراکنش هم‌زمان هر کدام
# نسخهٔ Commitشدهٔ قبلی دیگری را می‌دیدند و هر دو رد می‌شدند — همان
# پیوند نادرستی که ۰۸۹ برای بستنش آمده بود.
#
# نشست «نگه‌دار» تغییرش را می‌زند و تراکنش را باز نگه می‌دارد؛ نشست دوم
# فقط وقتی شروع می‌شود که نگه‌دار در `pg_sleep` دیده شود (ترتیب از
# pg_stat_activity می‌آید، نه از زمان‌بندی). انتظار: دقیقاً یکی رد شود و
# هیچ پیوند ناسازگاری Commit نشود.
# =====================================================================
set -u
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
CONN="${DATABASE_URL:-}"
if [ -z "$CONN" ]; then CONN="dbname=${PGDATABASE:-labelmod}"; fi
run() { psql -v ON_ERROR_STOP=1 -q -t -A -d "$CONN" "$@"; }

# داده Commit می‌شود (دو نشست مجزا)، پس در هر اجرا یکتاست.
RID="$$$(date +%s)"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

IDS=$(run -v rid="$RID" <<'SQL'
SELECT set_config('test.rid', :'rid', false);
DO $$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  r text := current_setting('test.rid');
  v_sup uuid; v_sup2 uuid; v_prod uuid; v_v1 uuid; v_v2 uuid;
  o1 uuid; ol1 uuid; rc1 uuid; o2 uuid; ol2 uuid; rc2 uuid; o3 uuid;
BEGIN
  INSERT INTO purchasing.supplier (code,name) VALUES ('RACE1-'||r,'تأمین ۱') RETURNING id INTO v_sup;
  INSERT INTO purchasing.supplier (code,name) VALUES ('RACE2-'||r,'تأمین ۲') RETURNING id INTO v_sup2;
  INSERT INTO catalog.product (code,name_internal) VALUES ('P-RACE-'||r,'کالای رقابت') RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id,color,size,sku) VALUES (v_prod,'آبی','M','RACE-M-'||r) RETURNING id INTO v_v1;
  INSERT INTO catalog.variation (product_id,color,size,sku) VALUES (v_prod,'آبی','L','RACE-L-'||r) RETURNING id INTO v_v2;

  -- ۱ و ۲: سفارش با یک قلم و رسید پیش‌نویسِ وصل به آن (هنوز بی‌سطر)
  INSERT INTO purchasing.purchase_order (branch_id,supplier_id,warehouse_id) VALUES (BR,v_sup,WH) RETURNING id INTO o1;
  INSERT INTO purchasing.purchase_order_line (order_id,variation_id,qty,unit_price) VALUES (o1,v_v1,2,1000) RETURNING id INTO ol1;
  INSERT INTO purchasing.receipt (branch_id,supplier_id,warehouse_id,order_id,occurred_at)
    VALUES (BR,v_sup,WH,o1,'2026-07-11') RETURNING id INTO rc1;
  INSERT INTO purchasing.purchase_order (branch_id,supplier_id,warehouse_id) VALUES (BR,v_sup,WH) RETURNING id INTO o2;
  INSERT INTO purchasing.purchase_order_line (order_id,variation_id,qty,unit_price) VALUES (o2,v_v1,2,1000) RETURNING id INTO ol2;
  INSERT INTO purchasing.receipt (branch_id,supplier_id,warehouse_id,order_id,occurred_at)
    VALUES (BR,v_sup,WH,o2,'2026-07-11') RETURNING id INTO rc2;
  -- ۳: سفارشی که هنوز هیچ رسیدی ندارد
  INSERT INTO purchasing.purchase_order (branch_id,supplier_id,warehouse_id) VALUES (BR,v_sup,WH) RETURNING id INTO o3;

  PERFORM set_config('test.ids', concat_ws(' ', v_sup, v_sup2, v_v1, v_v2, ol1, rc1, ol2, rc2, o3), false);
END $$;
SELECT current_setting('test.ids');
SQL
)
IDS=$(echo "$IDS" | tail -1)
read -r SUP SUP2 V1 V2 OL1 RC1 OL2 RC2 O3 <<<"$IDS"
[ -n "${O3:-}" ] || { echo "  ✗ آماده‌سازی داده ناموفق بود"; exit 1; }

# نگه‌دار: تغییرش را می‌زند، تا پایان pg_sleep تراکنش را باز نگه می‌دارد.
hold() {
  PGAPPNAME="race_hold_$RID" psql -q -t -A -d "$CONN" <<SQL >"$OUT/$2" 2>&1
\set ON_ERROR_STOP 1
BEGIN;
$1;
SELECT pg_sleep(2);
COMMIT;
SQL
  echo "exit=$?" >>"$OUT/$2"
}
# نشست دوم، بی‌مکث
other() {
  PGAPPNAME="race_other_$RID" psql -q -t -A -d "$CONN" -v ON_ERROR_STOP=1 -c "$1" >"$OUT/$2" 2>&1
  echo "exit=$?" >>"$OUT/$2"
}
# تا نگه‌دار به pg_sleep برسد (یعنی تغییرش انجام شده و قفلش نشسته)
wait_hold() {
  for _ in $(seq 1 100); do
    [ "$(run -c "SELECT count(*) FROM pg_stat_activity
                  WHERE application_name='race_hold_$RID' AND query LIKE '%pg_sleep%'
                    AND state='active'")" = "1" ] && return 0
    sleep 0.05
  done
  echo "  ✗ نشست نگه‌دار به نقطهٔ قفل نرسید"; return 1
}

FAIL=0
scenario() {  # عنوان، فرمان نگه‌دار، فرمان دوم
  echo "═══ $1 ═══"
  hold "$2" a.out & local P=$!
  wait_hold || { FAIL=1; wait $P; return; }
  other "$3" b.out
  wait $P
  local a b; a=$(grep -o 'exit=[0-9]*' "$OUT/a.out"); b=$(grep -o 'exit=[0-9]*' "$OUT/b.out")
  echo "  نگه‌دار: $a · نشست دوم: $b $(grep -h -m1 ERROR "$OUT/b.out" "$OUT/a.out" | cut -c1-110 | tr '\n' ' ')"
  if [ "$a" = "exit=0" ] && [ "$b" != "exit=0" ]; then
    echo "  ✓ دقیقاً یکی رد شد: نشست دوم پشت قفل ماند و نسخهٔ تازه را دید"
  else
    echo "  ✗ انتظار: نگه‌دار موفق، نشست دوم رد"; FAIL=1
  fi
}

scenario "۱. تغییر کالای سطر سفارش ← درج هم‌زمان سطر رسید با کالای قبلی" \
  "UPDATE purchasing.purchase_order_line SET variation_id='$V2' WHERE id='$OL1'" \
  "INSERT INTO purchasing.receipt_line (receipt_id,variation_id,qty,unit_price,line_amount,order_line_id)
     VALUES ('$RC1','$V1',1,1000,1000,'$OL1')"

scenario "۲. درج سطر رسید ← تغییر هم‌زمان کالای همان سطر سفارش" \
  "INSERT INTO purchasing.receipt_line (receipt_id,variation_id,qty,unit_price,line_amount,order_line_id)
     VALUES ('$RC2','$V1',1,1000,1000,'$OL2')" \
  "UPDATE purchasing.purchase_order_line SET variation_id='$V2' WHERE id='$OL2'"

scenario "۳. تغییر تأمین‌کنندهٔ سفارش ← درج هم‌زمان رسید با تأمین‌کنندهٔ قبلی" \
  "UPDATE purchasing.purchase_order SET supplier_id='$SUP2' WHERE id='$O3'" \
  "INSERT INTO purchasing.receipt (branch_id,supplier_id,warehouse_id,order_id,occurred_at)
     VALUES ('00000000-0000-7000-8000-000000000001','$SUP','00000000-0000-7000-8000-000000000101','$O3','2026-07-11')"

echo "═══ ثابت: هیچ پیوند ناسازگاری Commit نشده ═══"
BAD=$(run -c "
  SELECT (SELECT count(*) FROM purchasing.receipt_line rl
            JOIN purchasing.receipt r ON r.id = rl.receipt_id
            JOIN purchasing.purchase_order_line ol ON ol.id = rl.order_line_id
           WHERE ol.variation_id <> rl.variation_id OR ol.order_id IS DISTINCT FROM r.order_id)
       + (SELECT count(*) FROM purchasing.receipt r
            JOIN purchasing.purchase_order o ON o.id = r.order_id
           WHERE o.branch_id <> r.branch_id OR o.supplier_id <> r.supplier_id)")
if [ "$BAD" = "0" ]; then echo "  ✓ صفر پیوند ناسازگار"; else echo "  ✗ $BAD پیوند ناسازگار Commit شد"; FAIL=1; fi

exit $FAIL
