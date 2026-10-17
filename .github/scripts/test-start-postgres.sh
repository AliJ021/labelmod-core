#!/usr/bin/env bash
# Behavioural guard for start-postgres.sh with a mock docker: the Hub fallback runs only after an
# ECR download limit, exactly once, and every other failure keeps its exit code.
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -f "$scratch/docker" "$scratch/calls" "$scratch/output"; rmdir "$scratch"' EXIT
export PG_TEST_CALLS="$scratch/calls" PG_START_SLEEP=0 PG_START_WAIT=3
export PGDATABASE=labelmod PGUSER=labelmod PGPASSWORD=ci_only_not_a_real_secret
cat > "$scratch/docker" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$PG_TEST_CALLS"
case "$1" in
  pull)
    if [[ "$2" == public.ecr.aws/* ]]; then
      case "$PG_TEST_CASE" in
        ecr_limit|fallback_failure)
          echo 'Error response from daemon: toomanyrequests: Data limit exceeded'; exit 20 ;;
        ecr_429)
          echo 'Error response from daemon: Head "https://public.ecr.aws/v2/docker/library/postgres/manifests/16-alpine": 429 Too Many Requests'; exit 21 ;;
        unrelated)
          echo 'Error response from daemon: manifest for public.ecr.aws/docker/library/postgres:16-alpine not found: manifest unknown'; exit 22 ;;
      esac
    elif [ "$PG_TEST_CASE" = fallback_failure ]; then
      echo 'Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.'; exit 23
    fi
    exit 0 ;;
  run) [ "$PG_TEST_CASE" = run_failure ] && exit 24; exit 0 ;;
  inspect) [ "$PG_TEST_CASE" = unhealthy ] && echo unhealthy || echo healthy; exit 0 ;;
  logs) exit 0 ;;
esac
exit 99
MOCK
chmod +x "$scratch/docker"
export PATH="$scratch:$PATH"
ECR=public.ecr.aws/docker/library/postgres:16-alpine
HUB=docker.io/library/postgres:16-alpine
for scenario in success ecr_limit ecr_429 unrelated fallback_failure run_failure unhealthy; do
  export PG_TEST_CASE="$scenario"
  : > "$scratch/calls"
  rc=0
  bash .github/scripts/start-postgres.sh > "$scratch/output" 2>&1 || rc=$?
  expected=0; pulls="$ECR"; ran="$ECR"
  case "$scenario" in
    ecr_limit|ecr_429) pulls="$ECR $HUB"; ran="$HUB" ;;
    unrelated) expected=22; ran="" ;;
    fallback_failure) expected=23; pulls="$ECR $HUB"; ran="" ;;
    run_failure) expected=24 ;;
    unhealthy) expected=1 ;;
  esac
  got_pulls=$(grep '^pull ' "$scratch/calls" | cut -d' ' -f2 | paste -sd' ' -)
  got_ran=$(grep '^run ' "$scratch/calls" | awk '{print $NF}' || true)
  [ "$rc" -eq "$expected" ] || { cat "$scratch/output"; echo "$scenario: exit $rc != $expected"; exit 1; }
  [ "$got_pulls" = "$pulls" ] || { cat "$scratch/calls"; echo "$scenario: pulls «$got_pulls» != «$pulls»"; exit 1; }
  [ "$got_ran" = "$ran" ] || { cat "$scratch/calls"; echo "$scenario: ran «$got_ran» != «$ran»"; exit 1; }
  if [ -n "$ran" ]; then
    grep -q -- '-e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD -p 5432:5432' "$scratch/calls"
  fi
  echo "$scenario: PASS"
done

