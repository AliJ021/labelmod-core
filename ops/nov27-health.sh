#!/usr/bin/env bash
set -eu
for url in https://labelmod.com/ https://hesab.labelmod.com/api/health; do
  echo "$url"
  curl --head --silent --show-error --output /dev/null --max-time 12 --write-out 'status=%{http_code} http=%{http_version} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' "$url"
done
systemctl --failed --no-legend --plain
df -h /srv/labelmod
docker ps --format '{{.Names}} {{.Status}}'
dpkg --audit
if test -e /var/run/reboot-required; then echo REBOOT_REQUIRED; else echo NO_REBOOT_REQUESTED; fi
