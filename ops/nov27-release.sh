#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
app=/srv/labelmod/app
prep=/srv/labelmod/prep244final
state=/run/lmrelease244
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/lock"
flock -n 9
tested=c47c8cdbf9e200cb1611e6ee3077c603d7394b47
compose(){ docker compose -p labelmod --env-file "$app/.env" -f "$1/docker-compose.prod.yml" "${@:2}"; }
psql_db(){ docker exec labelmod-db-1 psql -XAt -v ON_ERROR_STOP=1 -U labelmod -d "$1" -c "$2"; }
fingerprint(){
 for t in sales.invoice sales.invoice_line sales.invoice_number treasury.payment inventory.stock_movement inventory.stock_balance ledger.journal_entry ledger.journal_line; do
  printf '%s ' "$t"
  psql_db "$1" "SELECT count(*)||':'||md5(coalesce(string_agg(h,'' ORDER BY h),'')) FROM (SELECT md5(row_to_json(r)::text) h FROM $t r) s"
 done
}
migrate(){
 compose "$1" run --rm --no-deps --entrypoint bash scheduler -ec '
  dst=$1; case "$dst" in labelmod|lm_pre244_*) ;; *) exit 2;; esac
  export DATABASE_URL="${DATABASE_URL%/*}/$dst" MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL%/*}/$dst"
  cd /app; bash ops/db.sh migrate
 ' bash "$2"
}
backup_now(){
 docker exec labelmod-scheduler-1 bash ops/db.sh backup > "$state/backup.log"
 dump=$(grep -oE '/backup/labelmod-[0-9]{8}-[0-9]{6}\.dump' "$state/backup.log" | head -1)
 test -n "$dump"
 docker exec labelmod-scheduler-1 sha256sum "$dump"
 docker exec labelmod-scheduler-1 bash ops/restore-drill.sh "$dump" > "$state/drill.log"
 echo "Restore drill passed: $dump"
}
stage(){
 test "$(git -C "$prep" rev-parse HEAD)" = "$tested"
 backup_now
 db=lm_pre244_$(date +%s)
 docker exec labelmod-db-1 createdb -U labelmod "$db"
 trap 'docker exec labelmod-db-1 dropdb -U labelmod "$db"' EXIT
 docker exec labelmod-scheduler-1 cat "$dump" | docker exec -i labelmod-db-1 pg_restore -1 -e -U labelmod -d "$db"
 fingerprint "$db" > "$state/stage.before"
 migrate "$prep" "$db" > "$state/stage.migration" 2>&1
 fingerprint "$db" > "$state/stage.after"
 diff -u "$state/stage.before" "$state/stage.after"
 n=$(psql_db "$db" "SELECT count(*) FROM public.schema_migration WHERE filename BETWEEN '134' AND '145'")
 test "$n" = 11
 echo "$tested" > "$state/stage.ok"
 echo "All 11 new migrations passed and eight core table fingerprints matched."
}
health(){
 for i in $(seq 1 40); do
  if curl -fsS --max-time 3 https://hesab.labelmod.com/api/health >/dev/null && test "$(docker inspect -f '{{.State.Health.Status}}' labelmod-api-1)" = healthy; then return 0; fi
  sleep 2
 done
 return 1
}
publish(){
 cd "$app"
 test "$(cat "$state/stage.ok")" = "$tested"
 test -z "$(git status --porcelain --untracked-files=no)"
 git fetch origin main
 target=$(git rev-parse FETCH_HEAD)
 git merge-base --is-ancestor "$tested" "$target"
 git diff --quiet "$tested" "$target"
 old=$(git rev-parse HEAD)
 test "$old" != "$target"
 services=(api worker panel-backup caddy scheduler)
 for svc in "${services[@]}"; do
  docker image inspect "lm244-$svc" >/dev/null
  docker tag "$(docker inspect -f '{{.Image}}' "labelmod-$svc-1")" "local/lmpre244-$svc:saved"
 done
 backup_now
 rollback(){
  trap - ERR
  cd "$app"
  git checkout --detach "$old" && for svc in "${services[@]}"; do docker tag "local/lmpre244-$svc:saved" "labelmod-$svc"; done
  compose "$app" up -d --no-build --no-deps "${services[@]}"
  echo "Application rollback triggered; database preserved." >&2
  exit 1
 }
 trap rollback ERR
 compose "$app" stop worker api scheduler
 # Read-only standby backup captured after writers have stopped, outside the app checkout.
 dir=/var/backups/labelmod-release
 install -m700 -d "$dir"
 f=$(mktemp "$dir/pre244-XXXXXXXX.dump")
 docker exec labelmod-db-1 pg_dump -Fc -U labelmod -d labelmod > "$f"
 docker exec -i labelmod-db-1 pg_restore -l < "$f" >/dev/null
 sha256sum "$f" > "$f.sha256"
 fingerprint labelmod > "$state/live.before"
 git checkout --detach "$target"
 for svc in "${services[@]}"; do docker tag "lm244-$svc" "labelmod-$svc"; done
 migrate "$app" labelmod > "$state/live.migration" 2>&1
 compose "$app" run --rm --no-deps --entrypoint bash scheduler -ec 'cd /app; export DATABASE_URL="$MIGRATION_DATABASE_URL"; bash ops/db-roles.sh' > "$state/roles.log" 2>&1
 fingerprint labelmod > "$state/live.after"
 diff -u "$state/live.before" "$state/live.after"
 compose "$app" up -d --no-build --no-deps "${services[@]}"
 health
 for svc in "${services[@]}"; do test "$(docker inspect -f '{{.State.Running}}' "labelmod-$svc-1")" = true; done
 trap - ERR
 echo "$target" > "$state/production.ok"
 echo "Live commit $target; transactions and inventory matched. Backup $f"
}
case "${1:-}" in
 stage) stage;;
 publish) publish;;
 *) exit 2;;
esac
