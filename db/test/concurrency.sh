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
  v_shift uuid; v_inv1 uuid; v_inv2 uuid; v_inv3 uuid; v_line3 uuid;
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

  -- Both contenders are paid; only stock availability should decide the race.
  INSERT INTO treasury.payment (invoice_id,shift_id,method_code,amount,status)
  SELECT id,shift_id,'cash',2000000,'succeeded' FROM sales.invoice WHERE id IN(v_inv1,v_inv2);

  -- فاکتور سوم عمداً پیش‌نویس می‌ماند: سناریوی دوم تغییر هم‌زمان
  -- تعداد را می‌سنجد، نه نهایی‌سازی هم‌زمان را.
  INSERT INTO sales.invoice (branch_id,warehouse_id,shift_id,occurred_at,created_by,channel)
    VALUES (BR,WH,v_shift,'2026-06-02 10:00+03:30',v_user,'pos') RETURNING id INTO v_inv3;
  INSERT INTO sales.invoice_line (invoice_id,line_no,variation_id,qty,unit_price,net_amount)
    VALUES (v_inv3,1,v_var,1,2000000,2000000) RETURNING id INTO v_line3;

  INSERT INTO platform.setting (key,value,description)
    VALUES ('_conc_test_'||current_setting('test.rid'),
            jsonb_build_object('inv1',v_inv1,'inv2',v_inv2,'var',v_var,'user',v_user,
                               'inv3',v_inv3,'line3',v_line3),
            'داده موقت تست همزمانی');
END $$;
SELECT (value->>'inv1')||' '||(value->>'inv2')||' '||(value->>'var')||' '||(value->>'user')
       ||' '||(value->>'inv3')||' '||(value->>'line3')
  FROM platform.setting WHERE key='_conc_test_'||current_setting('test.rid');
SQL
)

# خط آخر خروجی شناسه‌هاست؛ خط اول را set_config تولید می‌کند
read -r INV1 INV2 VAR USR INV3 LINE3 <<< "$(printf '%s\n' "$IDS" | tail -1)"
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

echo
echo "═══ سناریوی دوم: دو اسکن هم‌زمان روی یک سطر سبد ═══"
# همان کاری که مسیر اسکن می‌کند: قفل فاکتور، خواندن تعداد، افزودن یک.
# اگر خواندن پیش از قفل بود، یکی از دو افزایش گم می‌شد و صندوق‌دار
# دو بار اسکن می‌کرد ولی یک عدد می‌دید.
scan_once () {
  psql -q -t -A -d "$CONN" <<SQL 2>&1 | tr '\n' ' '
BEGIN;
SELECT 1 FROM sales.invoice WHERE id='$INV3'::uuid FOR UPDATE;
SELECT pg_sleep($1);
SELECT sales.set_line_qty('$INV3'::uuid, '$LINE3'::uuid,
  (SELECT qty FROM sales.invoice_line WHERE id='$LINE3'::uuid) + 1);
COMMIT;
SQL
}

scan_once 0.4 > /tmp/c3.out &
Q1=$!
scan_once 0.4 > /tmp/c4.out &
Q2=$!
wait $Q1 $Q2

QTY=$(run -c "SELECT qty FROM sales.invoice_line WHERE id='$LINE3';" | tr -d ' ')
TOTAL=$(run -c "SELECT i.net_amount - (SELECT sum(l.net_amount) FROM sales.invoice_line l
                  WHERE l.invoice_id=i.id) FROM sales.invoice i WHERE i.id='$INV3';" | tr -d ' ')

[ "${QTY%%.*}" = "3" ] && echo "  ✓ هر دو اسکن شمرده شدند (تعداد ۳)" || { echo "  ✗ تعداد: $QTY (انتظار ۳ — یک افزایش گم شد)"; FAIL=1; }
[ "${TOTAL%%.*}" = "0" ] && echo "  ✓ جمع فاکتور با جمع سطرها یکی ماند" || { echo "  ✗ اختلاف جمع: $TOTAL"; FAIL=1; }

echo
echo "═══ سناریوی سوم: دو سند افتتاحیه هم‌زمان ═══"
# ⚠️ این باگ واقعاً اتفاق افتاد و در دفتر دیده شد. قاعده «یک سند
# افتتاحیه باز در هر (شعبه، سال)» با یک SELECT بدون قفل اجبار می‌شد،
# پس دو تراکنش هم‌زمان هر دو NULL می‌دیدند و هر دو سند می‌زدند:
# نقد و سرمایه **دو برابر** می‌شدند و هیچ آشکارسازی نمی‌گرفتش.
#
# قید معوق این را نمی‌گیرد (هر دو در COMMIT «۱» می‌شمارند — Write Skew)،
# پس شاهدِ درست، قفل مشورتی تراکنشی داخل post_opening_balance است.
#
# سال مالی تازه لازم است: سال ۱۴۰۵ در تست‌های دیگر سند خورده و
# post_opening_balance عمداً جانشینی روی سالِ دارای سند را رد می‌کند.
OPEN_USER=$(run -v rid="$RID" <<'SQL' | tr -d ' '
INSERT INTO identity.app_user (username, full_name)
VALUES ('conc-open-'||:'rid', 'تست افتتاحیه همزمان') RETURNING id;
SQL
)
OPEN_YEAR=$(run <<'SQL' | tr -d ' '
INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status)
SELECT y, make_date(2030, 3, 21), make_date(2031, 3, 20), 'open'
  FROM (SELECT coalesce(max(id), 1405) + 1 AS y FROM ledger.fiscal_year) n
RETURNING id;
SQL
)
run -c "INSERT INTO identity.user_role (user_id, role_code, branch_id)
        VALUES ('$OPEN_USER'::uuid, 'admin', '00000000-0000-7000-8000-000000000001');" > /dev/null
# سال تازه شمارندهٔ سند خودش را لازم دارد؛ Seed فقط ۱۴۰۵ را می‌سازد.
run -c "INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
        VALUES ('00000000-0000-7000-8000-000000000001','journal',$OPEN_YEAR,'J-$OPEN_YEAR-')
        ON CONFLICT DO NOTHING;" > /dev/null

open_once () {
  psql -q -t -A -d "$CONN" <<SQL 2>&1 | tr '\n' ' '
BEGIN;
SELECT platform.set_actor('$OPEN_USER'::uuid);
SELECT ledger.post_opening_balance(
  '00000000-0000-7000-8000-000000000001'::uuid, $OPEN_YEAR::smallint,
  '[{"leg":"cash","amount":"1000000"},{"leg":"equity","amount":"1000000"}]'::jsonb,
  '$OPEN_USER'::uuid);
SELECT pg_sleep($1);
COMMIT;
SQL
}

open_once 0.6 > /tmp/c5.out &
O1=$!
open_once 0.6 > /tmp/c6.out &
O2=$!
wait $O1 $O2

# مانده **خالص** باید یک برابر باشد، نه دو برابر. جانشینی مجاز است
# (سند اول معکوس می‌شود)، تکرار نه.
OPEN_N=$(run -c "SELECT count(*) FROM ledger.journal_entry e
  WHERE e.kind='opening' AND e.fiscal_year=$OPEN_YEAR
    AND e.reverses_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ledger.journal_entry r WHERE r.reverses_id=e.id);" | tr -d ' ')
CASH_NET=$(run -c "SELECT coalesce(sum(l.debit-l.credit),0) FROM ledger.journal_line l
  JOIN ledger.journal_entry e ON e.id=l.entry_id
 WHERE e.kind='opening' AND e.fiscal_year=$OPEN_YEAR AND l.account_code='1101';" | tr -d ' ')

[ "$OPEN_N" = "1" ] && echo "  ✓ دقیقاً ۱ سند افتتاحیه باز ماند" || { echo "  ✗ سند افتتاحیه باز: $OPEN_N (انتظار ۱ — افتتاحیه تکرار شد)"; FAIL=1; }
[ "$CASH_NET" = "1000000" ] && echo "  ✓ مانده خالص نقد یک برابر است، نه دو برابر" || { echo "  ✗ مانده خالص نقد: $CASH_NET (انتظار 1000000)"; FAIL=1; }

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
