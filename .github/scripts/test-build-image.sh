#!/usr/bin/env bash
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -f "$scratch/docker" "$scratch/calls" "$scratch/output"; rmdir "$scratch"' EXIT
export BUILD_TEST_CALLS="$scratch/calls"
cat > "$scratch/docker" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$BUILD_TEST_CALLS"
case "$BUILD_TEST_CASE" in
  success) exit 0 ;;
  compile) echo 'ERROR: process /bin/sh -c pnpm build did not complete successfully'; exit 17 ;;
  npm429) echo 'ERROR: https://registry.npmjs.org/example 429 Too Many Requests'; exit 18 ;;
  unrelated) echo 'ERROR: failed to copy: httpReadSeeker: https://example.test/v2/node 429 Too Many Requests'; exit 19 ;;
esac
if [[ "$*" == *BASE_REGISTRY=public.ecr.aws/docker/library* ]]; then
  echo '#2 ERROR: failed to copy: httpReadSeeker: failed open: unexpected status code https://public.ecr.aws/v2/docker/library/node/manifests/sha256:abc: 429 Too Many Requests - Server message: toomanyrequests: Data limit exceeded'
  exit 20
fi
if [ "$BUILD_TEST_CASE" = fallback_failure ]; then exit 23; fi
exit 0
MOCK
chmod +x "$scratch/docker"
export PATH="$scratch:$PATH"
for scenario in success compile npm429 unrelated ecr429 fallback_failure; do
  export BUILD_TEST_CASE="$scenario"
  : > "$scratch/calls"
  rc=0
  bash .github/scripts/build-image.sh 'apps/api/Dockerfile' 'labelmod-api:ci' > "$scratch/output" 2>&1 || rc=$?
  expected=0; count=1
  case "$scenario" in
    compile) expected=17 ;;
    npm429) expected=18 ;;
    unrelated) expected=19 ;;
    ecr429) count=2 ;;
    fallback_failure) expected=23; count=2 ;;
  esac
  [ "$rc" -eq "$expected" ] || { cat "$scratch/output"; echo "$scenario: exit $rc != $expected"; exit 1; }
  [ "$(wc -l < "$scratch/calls")" -eq "$count" ] || { cat "$scratch/calls"; exit 1; }
  grep -q -- 'BASE_REGISTRY=public.ecr.aws/docker/library -f apps/api/Dockerfile -t labelmod-api:ci .' "$scratch/calls"
  if [ "$count" -eq 2 ]; then
    tail -n 1 "$scratch/calls" | grep -q -- 'BASE_REGISTRY=docker.io/library -f apps/api/Dockerfile -t labelmod-api:ci .'
  fi
  echo "$scenario: PASS"
done
