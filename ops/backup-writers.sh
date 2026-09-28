#!/usr/bin/env bash
# نصب با مالک root در /usr/local/sbin/labelmod-backup-writers؛ ورودی فقط یکی از سه عمل ثابت است.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ ${EUID} -eq 0 && $# -eq 1 ]] || exit 64
case "$1" in stop|resume-original|resume-restored) ;; *) exit 64 ;; esac
cd /srv/labelmod/app
control=/var/lib/labelmod-backup-control
install -d -m 0700 "$control"
exec 9>"$control/writers.lock"
flock -n 9 || exit 75
state="$control/writers.state"
compose=(/usr/bin/docker compose --env-file /srv/labelmod/app/.env -f /srv/labelmod/app/docker-compose.prod.yml -f /srv/labelmod/app/docker-compose.backup.yml)
services=(api worker scheduler)
if [[ "$1" == stop ]]; then
  if [[ ! -f "$state" ]] || grep -qx 'phase=done' "$state"; then
    temporary=$(mktemp "$control/writers.XXXXXXXX")
    chmod 0600 "$temporary"
    printf 'phase=active\n' >"$temporary"
    for service in "${services[@]}"; do
      running=0
      while IFS= read -r container; do
        [[ -z "$container" ]] && continue
        if [[ $(/usr/bin/docker inspect --format '{{.State.Running}}' "$container") == true ]]; then running=1; fi
      done < <("${compose[@]}" ps -aq "$service")
      printf '%s=%s\n' "$service" "$running" >>"$temporary"
    done
    mv -f -- "$temporary" "$state"
  fi
  "${compose[@]}" stop --timeout 90 api worker scheduler
  for service in "${services[@]}"; do
    while IFS= read -r container; do
      [[ -z "$container" ]] && continue
      [[ $(/usr/bin/docker inspect --format '{{.State.Running}}' "$container") == false ]] || exit 70
    done < <("${compose[@]}" ps -aq "$service")
  done
else
  [[ -f "$state" ]] || exit 70
  for service in "${services[@]}"; do
    grep -Eq "^${service}=[01]$" "$state" || exit 70
    if [[ "$1" == resume-restored && "$service" != api ]]; then continue; fi
    if grep -qx "${service}=1" "$state"; then "${compose[@]}" start "$service"; fi
  done
  # پس از شروع، هر نتیجهٔ نامعلوم به رسیدگی دستی می‌رود؛ آغاز مجدد خودکار نیست.
  temporary=$(mktemp "$control/writers.XXXXXXXX")
  sed 's/^phase=.*/phase=done/' "$state" >"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$state"
fi
