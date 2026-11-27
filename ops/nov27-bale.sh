#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
base=/run/lmrelease244
cd "$base"
case "$1" in
 key)
  if ! test -s bale-provision.key; then
   docker run --rm --network none --entrypoint age-keygen lm244-panel-backup > bale-provision.key
  fi
  docker run --rm -i --network none --entrypoint age-keygen lm244-panel-backup -y < bale-provision.key
  ;;
 piece)
  [[ "$2" =~ ^[0-9]{2}$ && "$3" =~ ^[0-9a-f]{2,120}$ ]]
  printf '%s' "$3" > "part$2"
  ;;
 install)
  [[ "$2" =~ ^[0-9a-f]{64}$ ]]
  cat part[0-9][0-9] | xxd -r -p > config.age
  printf '%s  config.age\n' "$2" | sha256sum -c -
  dir=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/labelmod-bale"}}{{.Source}}{{end}}{{end}}' labelmod-panel-backup-1)
  test -n "$dir" && test -d "$dir" && test ! -e "$dir/token"
  docker run --rm -i --network none -u 0 -v "$base/bale-provision.key:/key:ro" --entrypoint age lm244-panel-backup -d -i /key < config.age | python3 -c '
import json,os,re,sys
d=sys.argv[1]; v=json.load(sys.stdin)
assert set(v)=={"token","chat","recipient"}
assert re.fullmatch(r"[0-9]+:[a-zA-Z0-9_-]+",v["token"]) and re.fullmatch(r"[1-9][0-9]*",v["chat"]) and re.fullmatch(r"age1[a-z0-9]{58}",v["recipient"])
for k in ("chat","recipient","token"):
 with open(os.path.join(d,k),"x") as f:
  f.write(v[k]+"\n"); os.fchmod(f.fileno(),0o400); os.fchown(f.fileno(),1000,1000)
' "$dir"
  docker exec labelmod-panel-backup-1 sh -ec 'for n in token chat recipient; do test -r /run/labelmod-bale/$n; done'
  rm -f bale-provision.key config.age part[0-9][0-9]
  echo 'Configuration installed.'
  ;;
 restore)
  f=$(find /var/backups/labelmod-release -maxdepth 1 -type f -name 'pre244-*.dump' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
  test -f "$f.sha256"
  sha256sum -c "$f.sha256"
  db=lm_quiescent_$(date +%s)
  docker exec labelmod-db-1 createdb -U labelmod "$db"
  trap 'docker exec labelmod-db-1 dropdb -U labelmod "$db"' EXIT
  docker exec -i labelmod-db-1 pg_restore -1 -e -U labelmod -d "$db" < "$f"
  source <(sed '/^case "${1:-}"/,$d' /run/lm244runner/ops/nov27-release.sh)
  fingerprint "$db" > "$state/restored-cutover"
  diff -u "$state/live.before" "$state/restored-cutover"
  echo 'Cutover backup restored and eight fingerprints verified.'
  ;;
esac
