#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || exit 64
case "$1" in stop|resume-original|resume-restored) ;; *) exit 64 ;; esac
exec /usr/bin/sudo -n /usr/local/sbin/labelmod-backup-writers "$1"
