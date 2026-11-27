#!/bin/bash
set -Eeuo pipefail
cd /run/lm244runner
source <(sed '/^case "${1:-}"/,$d' ops/nov27-release.sh)
engine=/var/cache/labelmod-engine-244
services=(api worker panel-backup caddy scheduler)
target=569fb37df03e056c02456b9d4ba100d63e725b9f
old=$(git -C "$app" rev-parse '0896572^{commit}')
startdb(){
 docker start labelmod-db-1 >/dev/null
 for _ in $(seq 1 45); do if docker exec labelmod-db-1 pg_isready -q -U labelmod -d labelmod; then return; fi; sleep 1; done
 return 1
}
fallback(){
 trap - ERR; set +e
 echo "Recovery at line $1"
 systemctl start containerd docker
 if ! docker info >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive dpkg --force-confold -i "$engine"/current/*.deb >"$state/engine-recovery.log" 2>&1
  systemctl start containerd docker
 fi
 startdb || return 1
 git -C "$app" checkout --detach "$old" || return 1
 for svc in "${services[@]}"; do docker tag "local/lmpre244-$svc:saved" "labelmod-$svc"; done
 compose "$app" up -d --no-build --no-deps "${services[@]}"
 health && echo 'Original shop recovered'
 exit 1
}
trap 'fallback $LINENO' ERR
test -s "$state/live.before"
test "$(cat "$state/stage.ok")" = "$tested"
git -C "$app" diff --quiet "$tested" "$target"
test "$(git -C "$app" rev-parse HEAD)" = "$old"
(cd "$engine"; sha256sum -c debs.sha256 >/dev/null)
echo 'Verified staged packages. Resuming configuration.'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
dpkg --force-confold -i "$engine"/next/*.deb > "$state/engine-resume.log" 2>&1
systemctl start containerd docker
for deb in "$engine"/next/*.deb; do
 p=$(dpkg-deb -f "$deb" Package); test "$(dpkg-query -W -f='${Version}' "$p")" = "$(dpkg-deb -f "$deb" Version)"
done
startdb
docker version --format '{{.Server.Version}}'
fingerprint labelmod > "$state/resume.before"
diff -u "$state/live.before" "$state/resume.before"
git -C "$app" checkout --detach "$target"
for svc in "${services[@]}"; do docker tag "lm244-$svc" "labelmod-$svc"; done
migrate "$app" labelmod > "$state/live.migration" 2>&1
compose "$app" run --rm --no-deps --entrypoint bash scheduler -ec 'cd /app; export DATABASE_URL="$MIGRATION_DATABASE_URL"; bash ops/db-roles.sh' > "$state/roles.log" 2>&1
fingerprint labelmod > "$state/live.after"
diff -u "$state/live.before" "$state/live.after"
compose "$app" up -d --no-build --no-deps "${services[@]}"
health
for svc in "${services[@]}"; do test "$(docker inspect -f '{{.State.Running}}' "labelmod-$svc-1")" = true; done
echo "$target" > "$state/production.ok"
trap - ERR
echo 'New release healthy. Eight core financial and stock table fingerprints verified.'
