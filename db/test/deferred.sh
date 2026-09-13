#!/usr/bin/env bash
# =====================================================================
# قیدهای معوق — تا لحظهٔ COMMIT
# =====================================================================
# `CONSTRAINT TRIGGER` معوق تا `COMMIT` بررسی **نمی‌شود**. پس تستی که
# فقط `INSERT` بزند و خطا نبیند، هیچ‌چیز اثبات نکرده.
#
# ⚠️ و این دقیقاً وضعیت مجموعهٔ SQL بود: **هیچ‌کدام** از پرونده‌های
#    `db/test/*.sql` کلمهٔ `COMMIT` را ندارند — همه با `ROLLBACK` تمام
#    می‌شوند. پس این سه قید معوق هرگز در تست‌ها **شلیک نمی‌کردند**:
#
#      entry_balanced                on ledger.journal_line
#      cheque_status_matches_events  on treasury.cheque
#      single_open_opening_t         on ledger.journal_entry
#
#    ادعاهای موجود سبز بودند چون بررسی **فوری** داخل `post_entry` و
#    `post_cheque_event` زودتر خطا می‌دهد. یعنی آخرین لایهٔ دفاع —
#    همان که جلوی `INSERT` مستقیمِ دور‌زننده را می‌گیرد — سنجیده نمی‌شد.
#    یک قید معوقِ خراب (مثلاً تابعی که هرگز RAISE نکند) در آن مجموعه
#    دقیقاً شبیه یک قید سالم به‌نظر می‌رسید.
#
# این تست از دروازه‌ها **عبور می‌کند** و مستقیم درج می‌زند، سپس COMMIT.
#
# ⚠️ کنترل مثبت اجباری است: یک درج **متوازن** باید COMMIT شود. بی‌آن،
#    قیدی که همیشه خطا بدهد هم «پاس» می‌شد و کل فروش را می‌شکست.
# =====================================================================
set -uo pipefail
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
CONN="${DATABASE_URL:?DATABASE_URL لازم است}"
BR='00000000-0000-7000-8000-000000000001'
FAIL=0
RID="d$$$(date +%s)"

run () { psql -v ON_ERROR_STOP=1 -q -t -A -d "$CONN" "$@"; }

USER_ID=$(run <<SQL
INSERT INTO identity.app_user (username, full_name)
VALUES ('deferred-$RID','تست قید معوق') RETURNING id;
SQL
)

# ── ابزار: یک تراکنش کامل که باید در COMMIT بشکند ────────────────────
must_fail_at_commit () {
  local label="$1" body="$2" out
  out=$(psql -v ON_ERROR_STOP=1 -q -d "$CONN" 2>&1 <<SQL
BEGIN;
$body
COMMIT;
SQL
)
  if [ $? -ne 0 ]; then
    echo "  ✓ $label — در COMMIT رد شد"
    echo "      $(printf '%s' "$out" | grep -iE 'ERROR' | head -1 | cut -c1-100)"
  else
    echo "  ✗ $label — COMMIT موفق شد، یعنی قید معوق شلیک نکرد"
    FAIL=1
  fi
}

must_pass_at_commit () {
  local label="$1" body="$2"
  if psql -v ON_ERROR_STOP=1 -q -d "$CONN" >/dev/null 2>&1 <<SQL
BEGIN;
$body
COMMIT;
SQL
  then echo "  ✓ $label — COMMIT شد"
  else echo "  ✗ $label — COMMIT شکست، قید بی‌رویه است"; FAIL=1; fi
}

echo "═══ ۱. توازن سند: entry_balanced روی journal_line ═══"

must_fail_at_commit "سند یک‌طرفه (بدهکار بدون بستانکار)" "
INSERT INTO ledger.journal_entry (number, fiscal_year, branch_id, entry_date,
  kind, status, description, created_by)
VALUES (platform.next_document_no('$BR','journal',1405::smallint), 1405, '$BR',
  '2026-06-10', 'sale_shift', 'final', 'نامتوازن $RID', '$USER_ID');
INSERT INTO ledger.journal_line (entry_id, line_no, account_code, debit, credit, description)
SELECT id, 1, '1101', 1000, 0, 'نقد بدون طرف حساب'
  FROM ledger.journal_entry WHERE description = 'نامتوازن $RID';"

must_fail_at_commit "سند با اختلاف یک ریال" "
INSERT INTO ledger.journal_entry (number, fiscal_year, branch_id, entry_date,
  kind, status, description, created_by)
VALUES (platform.next_document_no('$BR','journal',1405::smallint), 1405, '$BR',
  '2026-06-10', 'sale_shift', 'final', 'یک‌ریال $RID', '$USER_ID');
INSERT INTO ledger.journal_line (entry_id, line_no, account_code, debit, credit, description)
SELECT id, 1, '1101', 1000, 0, 'بدهکار'   FROM ledger.journal_entry WHERE description = 'یک‌ریال $RID'
UNION ALL
SELECT id, 2, '3102', 0,     999, 'بستانکار' FROM ledger.journal_entry WHERE description = 'یک‌ریال $RID';"

# کنترل مثبت — بی‌این، دو ادعای بالا با یک قیدِ «همیشه خطا» هم پاس می‌شدند.
must_pass_at_commit "سند متوازن (کنترل مثبت)" "
INSERT INTO ledger.journal_entry (number, fiscal_year, branch_id, entry_date,
  kind, status, description, created_by)
VALUES (platform.next_document_no('$BR','journal',1405::smallint), 1405, '$BR',
  '2026-06-10', 'sale_shift', 'final', 'متوازن $RID', '$USER_ID');
INSERT INTO ledger.journal_line (entry_id, line_no, account_code, debit, credit, description)
SELECT id, 1, '1101', 1000, 0, 'بدهکار'   FROM ledger.journal_entry WHERE description = 'متوازن $RID'
UNION ALL
SELECT id, 2, '3102', 0,    1000, 'بستانکار' FROM ledger.journal_entry WHERE description = 'متوازن $RID';"

echo
echo "═══ ۲. وضعیت چک: cheque_status_matches_events روی cheque ═══"
# `status` یک Projection از زنجیره رویداد است. UPDATE مستقیم رویش باید
# در COMMIT رد شود، وگرنه چکِ وصول‌نشده می‌توانست «وصول‌شده» بنشیند.
# ⚠️ چک «received» باید طرفش **مشتری** باشد، نه تأمین‌کننده — قید
#    `cheque_party_matches_direction`. بار اول تأمین‌کننده گذاشتم، درج
#    شکست، چکی ساخته نشد، و آن‌وقت `UPDATE … WHERE cheque_no = …` روی
#    **صفر سطر** افتاد و بی‌سروصدا «موفق» شد. کنترل مثبت گرفتش.
CUST=$(run <<SQL
INSERT INTO sales.customer (mobile_normalized, full_name)
VALUES ('0912' || substr('$RID' || '0000000', 1, 7), 'مشتری قید معوق') RETURNING id;
SQL
)
run -c "INSERT INTO treasury.cheque (direction,branch_id,cheque_no,bank_name,amount,
  issued_on,due_on,party_type,party_id,created_by)
  VALUES ('received','$BR','CHD-$RID','ملت',1000,'2026-04-01','2026-05-01',
          'customer','$CUST','$USER_ID');" >/dev/null

must_fail_at_commit "UPDATE مستقیم روی وضعیت چک" "
UPDATE treasury.cheque SET status = 'cleared' WHERE cheque_no = 'CHD-$RID';"

must_pass_at_commit "چک تازه در وضعیت draft (کنترل مثبت)" "
INSERT INTO treasury.cheque (direction,branch_id,cheque_no,bank_name,amount,
  issued_on,due_on,party_type,party_id,created_by)
VALUES ('received','$BR','CHD2-$RID','ملت',1000,'2026-04-01','2026-05-01',
        'customer','$CUST','$USER_ID');"

echo
echo "═══ ۳. سند افتتاحیه: single_open_opening_t روی journal_entry ═══"
# مهاجرت ۰۴۹. درج **مستقیم** یک سند افتتاحیه دوم، بدون معکوس‌کردن اولی.
YEAR=$(run <<SQL
INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status)
SELECT y, make_date(2032,3,21), make_date(2033,3,20), 'open'
  FROM (SELECT coalesce(max(id),1405)+1 AS y FROM ledger.fiscal_year) n
RETURNING id;
SQL
)
run -c "INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
        VALUES ('$BR','journal',$YEAR,'J-$YEAR-') ON CONFLICT DO NOTHING;" >/dev/null
run -c "SELECT platform.set_actor('$USER_ID'::uuid);
        SELECT ledger.post_opening_balance('$BR'::uuid, $YEAR::smallint,
          '[{\"leg\":\"cash\",\"amount\":\"1000\"},{\"leg\":\"equity\",\"amount\":\"1000\"}]'::jsonb,
          '$USER_ID'::uuid);" >/dev/null

must_fail_at_commit "سند افتتاحیه دوم با درج مستقیم" "
INSERT INTO ledger.journal_entry (number, fiscal_year, branch_id, entry_date,
  kind, status, description, created_by)
VALUES (platform.next_document_no('$BR','journal',$YEAR::smallint), $YEAR, '$BR',
  '2032-03-21', 'opening', 'final', 'افتتاحیه دوم $RID', '$USER_ID');
INSERT INTO ledger.journal_line (entry_id, line_no, account_code, debit, credit, description)
SELECT id, 1, '1101', 1000, 0, 'بدهکار'   FROM ledger.journal_entry WHERE description = 'افتتاحیه دوم $RID'
UNION ALL
SELECT id, 2, '3102', 0,    1000, 'بستانکار' FROM ledger.journal_entry WHERE description = 'افتتاحیه دوم $RID';"

echo
if [ $FAIL -eq 0 ]; then
  echo "╔══════════════════════════════════════╗"
  echo "║   تست قیدهای معوق پاس شد            ║"
  echo "╚══════════════════════════════════════╝"
else
  echo "✗✗✗ تست قیدهای معوق رد شد ✗✗✗"
  exit 1
fi
