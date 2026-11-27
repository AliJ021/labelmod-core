#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
stage=/var/cache/labelmod-engine-244
mkdir -p "$stage"/{current,next}
cd "$stage"
arch=$(dpkg --print-architecture)
test "$arch" = amd64
key=/etc/apt/keyrings/docker.asc
if test -f "$key"; then gpg --batch --yes --dearmor --output ./vendor.gpg "$key"; else cp /etc/apt/keyrings/docker.gpg ./vendor.gpg; fi
fingerprint=$(gpg --batch --show-keys --with-colons ./vendor.gpg | awk -F: '$1=="fpr"{print $10;exit}')
test "$fingerprint" = 9DC858229FC7DD38854AE2D88D81803C0EBFCD88
sources=(https://download.docker.com/linux/ubuntu https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/ubuntu https://mirrors.aliyun.com/docker-ce/linux/ubuntu https://mirror.arvancloud.ir/docker-ce/linux/ubuntu)
req(){ curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 8 --max-time "$1" -o "$2" "$3"; }
for source in "${sources[@]}"; do
 echo "Checking $source"
 if ! req 25 InRelease.part "$source/dists/noble/InRelease"; then continue; fi
 if ! gpgv --keyring "$stage/vendor.gpg" --output Release.part InRelease.part 2>/dev/null; then rm -f Release.part; continue; fi
 idx=stable/binary-amd64/Packages.gz
 expected=$(awk -v idx="$idx" '$1=="SHA256:"{found=1;next} /^[^ ]/{found=0} found&&$3==idx{print $1;exit}' Release.part)
 if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then continue; fi
 if ! req 30 Packages.gz "$source/dists/noble/$idx" || ! echo "$expected  Packages.gz" | sha256sum --check --status; then continue; fi
 export source
 if python3 /run/lm244runner/ops/nov27-engine.py; then
  apt-get -s --no-remove install "$stage"/next/*.deb > plan.log
  grep -E 'upgraded, .*newly installed' plan.log
  echo READY > ready
  echo 'Signed current and replacement Docker packages are staged.'
  exit 0
 fi
 rm -f Release.part
done
echo 'Production sources unavailable or missing a verified package.' >&2
exit 1
