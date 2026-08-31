#!/usr/bin/env bash
# =====================================================================
# بستن خودکار دوره ثبت فروش سایت — برای اجرای شبانه با cron
# =====================================================================
# **این اسکریپت موجودی را دست نمی‌زند.** کالا در همان لحظه فروش از
# انبار خارج شده؛ آنچه اینجا بسته می‌شود فقط سند حسابداری درآمد و
# بهای تمام‌شده است.
#
# نصب روی سرور (هر شب ساعت ۳ بامداد به وقت تهران):
#
#   0 3 * * *  DATABASE_URL='…' \
#              /srv/labelmod/ops/close-due-days.sh >> /var/log/labelmod-close.log 2>&1
#
# ساعت را با منطقه زمانی سرور هماهنگ کنید؛ خودِ تابع «امروز» را از
# تنظیم `platform.timezone` می‌خواند، نه از ساعت cron.
#
# `LABELMOD_ACTOR` لازم نیست ست شود: پیش‌فرضش کاربر «سیستم» است که
# `db/seed/040_reference.sql` می‌سازد و هرگز نمی‌تواند وارد شود (نه
# رمز، نه PIN، غیرفعال). نام همان کاربر کنار هر سند شبانه می‌ماند.
#
# اگر `sales.auto_close_channel_day` خاموش باشد، این اسکریپت هیچ کاری
# نمی‌کند و بی‌سروصدا برمی‌گردد — کلید در تنظیمات است، نه در cron.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL تنظیم نشده است}"
# کاربر «سیستم» که seed می‌سازد. شناسه‌اش ثابت است تا cron بتواند
# بدون جست‌وجو صدایش بزند. اگر کاربر دیگری می‌خواهید، متغیر را ست کنید.
LABELMOD_ACTOR="${LABELMOD_ACTOR:-00000000-0000-7000-8000-0000000000f1}"

export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

echo "── $(date '+%Y-%m-%d %H:%M:%S') — بستن دوره‌های سررسیدشده"

# کل اجرا در یک تراکنش: یا همه دوره‌های واجد شرایط بسته می‌شوند یا
# هیچ‌کدام. `set_actor` با is_local=true ست می‌شود، پس باید در همان
# تراکنش باشد.
psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL" <<SQL
BEGIN;
SELECT platform.set_actor('${LABELMOD_ACTOR}'::uuid);
\\pset format aligned
SELECT business_date AS "تاریخ",
       channel       AS "کانال",
       coalesce(skipped, 'بسته شد') AS "نتیجه"
  FROM sales.close_due_channel_days('${LABELMOD_ACTOR}'::uuid)
 ORDER BY business_date, channel;
COMMIT;
SQL

# زنگ خطر: اگر درآمدی از روزهای گذشته هنوز ثبت نشده، یعنی چیزی رد شده
# و کسی باید نگاهش کند.
LEFT=$(psql -tA -d "$DATABASE_URL" -c \
  "SELECT count(*) FROM sales.unposted_revenue WHERE business_date < now()::date")
if [ "${LEFT:-0}" -gt 0 ]; then
  echo "⚠️  $LEFT فاکتور از روزهای گذشته هنوز به دفتر نرفته — بررسی کنید:"
  psql -d "$DATABASE_URL" -c \
    "SELECT number, channel, business_date, payable_amount
       FROM sales.unposted_revenue WHERE business_date < now()::date
      ORDER BY business_date LIMIT 20"
  exit 1
fi

echo "✓ درآمد ثبت‌نشده‌ای از روزهای گذشته نمانده"
