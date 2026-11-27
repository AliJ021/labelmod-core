#!/usr/bin/env bash
# تمیز بودن نصب پس از قطع وسط DDL، و تکرار هم‌زمان انتشار روی همان پایگاه.
set -euo pipefail
: "${DATABASE_URL:?}"
cd "$(dirname "$0")/.."
root=$(mktemp -d)
name="labelmod_migration_test_${$}_$(date +%s)"
admin="${DATABASE_URL%/*}/postgres"
test_url="${DATABASE_URL%/*}/$name"
psql -X -v ON_ERROR_STOP=1 -d "$admin" -c "CREATE DATABASE $name" >/dev/null
cleanup(){
  psql -X -q -d "$admin" -c "DROP DATABASE $name" >/dev/null
  rm -f "$root/ops/db.sh" "$root/db/migrations/005_cheques.sql" "$root/a.log" "$root/b.log"
  rmdir "$root/ops" "$root/db/migrations" "$root/db" "$root"
}
trap cleanup EXIT
mkdir -p "$root/ops" "$root/db/migrations"
cp ops/db.sh "$root/ops/db.sh"
migration="$root/db/migrations/005_cheques.sql"
cat > "$migration" <<'SQL'
BEGIN;
CREATE TABLE atomic_marker(id int PRIMARY KEY);
COMMIT;
BEGIN;
INSERT INTO atomic_marker VALUES (1),(1);
COMMIT;
SQL
apply(){ DATABASE_URL="$test_url" bash "$root/ops/db.sh" migrate; }
read_db(){ psql -X -v ON_ERROR_STOP=1 -At -d "$test_url" -c "$1"; }
if apply > "$root/a.log" 2>&1; then exit 1; fi
[[ "$(read_db "SELECT to_regclass('atomic_marker') IS NULL AND NOT EXISTS (SELECT FROM public.schema_migration)")" = t ]]
cat > "$migration" <<'SQL'
BEGIN;
CREATE TABLE atomic_marker(id int PRIMARY KEY);
COMMIT;
BEGIN;
SELECT pg_sleep(0.3);
INSERT INTO atomic_marker VALUES (1);
COMMIT;
SQL
apply > "$root/a.log" 2>&1 & first=$!
apply > "$root/b.log" 2>&1 & second=$!
wait "$first" && wait "$second"
[[ "$(read_db 'SELECT count(*) FROM atomic_marker')" = 1 ]]
[[ "$(read_db 'SELECT count(*) FROM public.schema_migration')" = 1 ]]
echo 'Migration rollback, retry, concurrent application and checksum journal passed.'
