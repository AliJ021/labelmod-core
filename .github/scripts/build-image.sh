#!/usr/bin/env bash
# Only a confirmed ECR image-download rate limit gets one Docker Hub fallback.
# Compiler, package-install and test failures must retain their original result.
set -uo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: build-image.sh DOCKERFILE IMAGE_TAG" >&2
  exit 64
fi
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if docker build --progress=plain --build-arg BASE_REGISTRY=public.ecr.aws/docker/library -f "$1" -t "$2" . 2>&1 | tee "$log"; then
  exit 0
else
  statuses=("${PIPESTATUS[@]}")
fi
# A logging failure is not an image-download failure.
if [ "${statuses[1]}" -ne 0 ]; then exit "${statuses[1]}"; fi
if grep -Eq 'ERROR:.*(failed to resolve source metadata|failed to copy: httpReadSeeker).*https://public\.ecr\.aws/.*(429 Too Many Requests|toomanyrequests)' "$log"; then
  echo 'ECR image download was rate limited; trying Docker Official Images on Docker Hub once.' >&2
  docker build --progress=plain --build-arg BASE_REGISTRY=docker.io/library -f "$1" -t "$2" .
  exit "$?"
fi
exit "${statuses[0]}"
