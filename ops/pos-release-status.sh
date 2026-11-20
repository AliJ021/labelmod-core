#!/usr/bin/env bash
# گزارش کوتاه برای مقایسهٔ نسخهٔ نصب فروشگاه با نسخهٔ آزموده‌شده
set -eu
for service in api caddy db; do
  ids=$(docker ps -q --filter label=com.docker.compose.project=labelmod --filter "label=com.docker.compose.service=$service")
  set -- $ids
  if [ "$#" -ne 1 ]; then
    echo "Cannot uniquely find running service: $service"
    docker ps --format '{{.Names}}'
    exit 1
  fi
  image=$(docker inspect -f '{{.Image}}' "$1")
  echo "$service image=$image"
  docker image inspect -f 'revision={{with .Config.Labels}}{{index . "org.opencontainers.image.revision"}}{{end}}' "$image"
  if [ "$service" = db ]; then dbid=$1; fi
done
repo=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$dbid")
printf 'checkout='
git -C "$repo" rev-parse HEAD 2>/dev/null || echo unavailable
docker exec -i "$dbid" psql -X -w -v ON_ERROR_STOP=1 -P pager=off -U labelmod -d labelmod <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='4s';
SET LOCAL lock_timeout='1s';
SELECT filename, applied_at FROM public.schema_migration ORDER BY applied_at DESC, filename DESC LIMIT 1;
SELECT last_value AS invoice_counter FROM sales.invoice_number_counter WHERE singleton;
SELECT number AS recent_invoice_number FROM sales.invoice_number ORDER BY length(number) DESC, number COLLATE "C" DESC LIMIT 5;
ROLLBACK;
SQL
