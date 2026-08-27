#!/usr/bin/env bash
# =====================================================================
# تست همزمانی: دو فروش هم‌زمان روی آخرین قلم موجودی
# =====================================================================
# این سناریو در فروشگاه واقعی رخ می‌دهد: صندوق و سایت هم‌زمان
# آخرین سایز را می‌فروشند. انتظار: یکی موفق، یکی با خطای قابل فهم.
# اگر هر دو موفق شوند، موجودی منفی می‌شود و باگ داریم.
# =====================================================================
set -u
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
# اتصال: DATABASE_URL اولویت دارد، وگرنه متغیرهای PG* محیط
CONN="${DATABASE_URL:-}"
if [ -z "$CONN" ]; then CONN="dbname=${PGDATABASE:-labelmod}"; fi
PSQL="psql -v ON_ERROR_STOP=1 -q -t -A -d"
run() { $PSQL "$CONN" "$@"; }

# این تست به‌ناچار Commit واقعی می‌کند (دو نشست مجزا لازم دارد)، پس
# داده‌اش در هر اجرا یکتاست تا اجرای مکرر روی یک دیتابیس به محدودیت
# یکتایی نخورد. برای پاک‌کردن کامل:  ops/db.sh reset
RID="$$$(date +%s)"

echo "═══ آماده‌سازی: دقیقاً ۱ عدد موجودی ═══"

IDS=$(run -v rid="$RID" <<'SQL'
SELECT set_config('test.rid', :'rid', false);
DO $$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  WH uuid := '00000000-0000-7000-8000-000000000101';
  v_user uuid; v_sup uuid; v_prod uuid; v_var uuid; v_rcpt uuid;
  v_shift uuid; v_inv1 uuid; v_inv2 uuid;
BEGIN
  DELETE FROM platform.setting WHERE key = '_conc_test_'||current_setting('test.rid');

  INSERT INTO identity.app_user (username, full_name) VALUES ('conc-'||current_setting('test.rid'),'تست همزمانی')
    RETURNING id INTO v_user;
  INSERT INTO purchasing.supplier (code,name) VALUES ('SC-'||current_setting('test.rid'),'تأمین') RETURNING id INTO v_sup;
  INSERT INTO catalog.product (code,name_internal) VALUES ('P-CONC-'||current_setting('test.rid'),'کالای همزمانی')
    RETURNING id INTO v_prod;
  INSERT INTO catalog.variation (product_id,color,size,sku)
    VALUES (v_prod,'آبی','M','CONC-M-'||current_setting('test.rid')) RETURNING id INTO v_var;

  INSERT INTO purchasing.receipt (number,branch_id,supplier_id,warehouse_id,occurred_at)
    VALUES (platform.next_document_no(BR,'purchase',1405::smallint),BR,v_sup,WH,'2026-06-01')
    RETURNING id INTO v_rcpt;
  INSERT INTO purchasing.receipt_line (receipt_id,variation_id,qty,unit_price,line_amount)
    VALUES (v_rcpt,v_var,1,1000000,1000000);
  PERFORM purchasing.post_receipt(v_rcpt,v_user);

  INSERT INTO sales.cash_shift (branch_id,user_id,opening_cash,opened_at)
    VALUES (BR,v_user,0,'2026-06-02 09:00+03:30') RETURNING id INTO v_shift;

  INSERT INTO sales.invoice (branch_id,warehouse_id,shift_id,occurred_at,created_by,channel)
    VALUES (BR,WH,v_shift,'2026-06-02 10:00+03:30',v_user,'pos') RETURNING id INTO v_inv1;
  INSERT INTO sales.invoice_line (invoice_id,line_no,variation_id,qty,unit_price,net_amount)
    VALUES (v_inv1,1,v_var,1,2000000,2000000);

  -- فاکتور سایت شیفت صندوق ندارد — همان‌طور که سفارش واقعی ووکامرس ندارد.
  -- این مسیر دوره ثبت «کانال-روز» را هم زیر فشار همزمانی می‌برد.
  INSERT INTO sales.invoice (branch_id,warehouse_id,shift_id,occurred_at,created_by,channel)
    VALUES (BR,WH,NULL,'2026-06-02 10:00+03:30',v_user,'web') RETURNING id INTO v_inv2;
  INSERT INTO sales.invoice_line (invoice_id,line_no,variation_id,qty,unit_price,net_amount)
    VALUES (v_inv2,1,v_var,1,2000000,2000000);

  INSERT INTO platform.setting (key,value,description)
    VALUES ('_conc_test_'||current_setting('test.rid'),
            jsonb_build_object('inv1',v_inv1,'inv2',v_inv2,'var',v_var,'user',v_user),
            'داده موقت تست همزمانی');
END $$;
SELECT (value->>'inv1')||' '||(value->>'inv2')||' '||(value->>'var')||' '||(value->>'user')
  FROM platform.setting WHERE key='_conc_test_'||current_setting('test.rid');
SQL
)

# خط آخر خروجی شناسه‌هاست؛ خط اول را set_config تولید می‌کند
read -r INV1 INV2 VAR USR <<< "$(printf '%s\n' "$IDS" | tail -1)"
echo "  فاکتور صندوق: $INV1"
echo "  فاکتور سایت : $INV2"

echo
echo "═══ اجرای هم‌زمان دو تراکنش ═══"

run_sale () {
  # تراکنش کامل: قفل می‌گیرد، مکث می‌کند تا همپوشانی تضمین شود، ثبت می‌کند
  psql -q -t -A -d "$CONN" <<SQL 2>&1 | tr '\n' ' '
BEGIN;
SELECT pg_sleep($2);
SELECT sales.finalize_invoice('$1'::uuid, '$USR'::uuid);
COMMIT;
SQL
}

run_sale "$INV1" 0 > /tmp/c1.out &
P1=$!
run_sale "$INV2" 0 > /tmp/c2.out &
P2=$!
wait $P1 $P2

R1=$(cat /tmp/c1.out); R2=$(cat /tmp/c2.out)
echo "  نتیجه ۱: ${R1:0:90}"
echo "  نتیجه ۲: ${R2:0:90}"

echo
echo "═══ بررسی ═══"

FINAL=$(run -c "
  SELECT (SELECT count(*) FROM sales.invoice
           WHERE id IN ('$INV1','$INV2') AND status='finalized')
      || '|' ||
         (SELECT on_hand FROM inventory.stock_balance WHERE variation_id='$VAR')
      || '|' ||
         (SELECT count(*) FROM inventory.stock_movement
           WHERE variation_id='$VAR' AND kind='sale');")

SOLD=$(echo "$FINAL" | cut -d'|' -f1)
ONHAND=$(echo "$FINAL" | cut -d'|' -f2)
MOVES=$(echo "$FINAL" | cut -d'|' -f3)

FAIL=0
[ "$SOLD" = "1" ] && echo "  ✓ دقیقاً ۱ فاکتور نهایی شد" || { echo "  ✗ تعداد فاکتور نهایی‌شده: $SOLD (انتظار ۱)"; FAIL=1; }
[ "${ONHAND%%.*}" = "0" ] && echo "  ✓ موجودی صفر شد، نه منفی" || { echo "  ✗ موجودی: $ONHAND (انتظار ۰)"; FAIL=1; }
[ "$MOVES" = "1" ] && echo "  ✓ فقط ۱ حرکت انبار ثبت شد" || { echo "  ✗ تعداد حرکت: $MOVES (انتظار ۱)"; FAIL=1; }

run -c "DELETE FROM platform.setting WHERE key LIKE '_conc_test_%';" > /dev/null 2>&1 || true

echo
if [ $FAIL -eq 0 ]; then
  echo "╔══════════════════════════════════╗"
  echo "║   تست همزمانی پاس شد            ║"
  echo "╚══════════════════════════════════╝"
else
  echo "✗✗✗ تست همزمانی رد شد ✗✗✗"
  exit 1
fi
