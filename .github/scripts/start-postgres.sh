#!/usr/bin/env bash
# Postgres for db-tests. A `services:` container is pulled before any step runs, so a registry
# limit failed the job before checkout with no possible fallback. This step pulls the same
# Docker Official Image from the ECR Public mirror first; only a confirmed image-download rate or
# data limit gets one Docker Hub fallback. Every other failure keeps its original exit code.
set -uo pipefail
ECR_REF=public.ecr.aws/docker/library/postgres:16-alpine
HUB_REF=docker.io/library/postgres:16-alpine
log=$(mktemp)
trap 'rm -f "$log"' EXIT
ref=$ECR_REF
if docker pull "$ECR_REF" 2>&1 | tee "$log"; then
  :
else
  statuses=("${PIPESTATUS[@]}")
  # A logging failure is not an image-download failure.
  if [ "${statuses[1]}" -ne 0 ]; then exit "${statuses[1]}"; fi
  # Only ECR was contacted, so a limit in this log is ECR's.
  if ! grep -Eq '429 Too Many Requests|toomanyrequests|Data limit exceeded' "$log"; then exit "${statuses[0]}"; fi
  echo 'ECR image download was limited; trying the Docker Official Image on Docker Hub once.' >&2
  docker pull "$HUB_REF" || exit "$?"
  ref=$HUB_REF
fi
# Same database, user, port and health check as the former service container.
export POSTGRES_DB="$PGDATABASE" POSTGRES_USER="$PGUSER" POSTGRES_PASSWORD="$PGPASSWORD"
docker run -d --name postgres -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD -p 5432:5432 \
  --health-cmd "pg_isready -U $PGUSER -d $PGDATABASE" \
  --health-interval 2s --health-timeout 5s --health-retries 50 "$ref" || exit "$?"
# Bounded wait for readiness (not a retry): about 100 seconds, like 10 x 10s before.
for _ in $(seq 1 "${PG_START_WAIT:-50}"); do
  status=$(docker inspect -f '{{.State.Health.Status}}' postgres) || exit "$?"
  case "$status" in
    healthy) echo "postgres ready from $ref"; exit 0 ;;
    unhealthy) break ;;
  esac
  sleep "${PG_START_SLEEP:-2}"
done
docker logs postgres >&2 || true
echo "postgres did not become healthy ($ref)" >&2
exit 1

