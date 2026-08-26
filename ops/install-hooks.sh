#!/usr/bin/env bash
# نصب هوک‌های git — یک بار روی هر کلون اجرا شود
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for h in ops/hooks/*; do
  n=$(basename "$h")
  cp "$h" ".git/hooks/$n"
  chmod +x ".git/hooks/$n"
  echo "✓ نصب شد: .git/hooks/$n"
done
echo
echo "برای اجرای تست‌ها هنگام Push، DATABASE_URL را در محیط ست کنید."
