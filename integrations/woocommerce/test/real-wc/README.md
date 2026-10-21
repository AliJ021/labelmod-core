# بازتولید با پردازه‌های واقعی ووکامرس

فقط محلی و با دادهٔ مصنوعی. نه کلید، نه سفارش زنده، نه استقرار. در CI اجرا نمی‌شود چون وردپرس، ووکامرس و MariaDB
را از شبکه می‌گیرد. نتیجه و جدول در `docs/STOCK-SYNC-PROTOCOL.md` («بازتولید با پردازه‌های واقعی») است.

```bash
# MariaDB محلی روی سوکت، پایگاه wpr و کاربر wp (رمز مصنوعی setup.sh)
setup.sh  <work> <plugins>/new <socket>      # وردپرس 7.0.7 + ووکامرس 11.1.1؛ نسخه‌ها سنجیده می‌شوند
# <plugins>/<نسخه> = افزونه در همان commit (757a1c4، bbae0d1) و <plugins>/new = افزونهٔ جاری
python3 run.py <work> <plugins> new bbae0d1 > result.jsonl
```

- `mu-repro.php`: فایل‌مانع؛ پردازه با `LMC_ROLE` در مرحلهٔ `LMC_PAUSE` می‌ایستد تا `run.py` اجازه دهد.
- `actor.php`: یک فرمان در یک پردازهٔ PHP (`prep`، `reduce`، `adjust`، `apply`، `ack`، `read`).
- `run.py`: دو پردازهٔ هم‌زمان (نشاندن عکس، و کسر/ویرایش دستی/لغو/استرداد ووکامرس)، سه حالت through/complete/crash،
  SIGKILL در نقطه‌های بحرانی، و `over_truth_in` = سناریوهایی که عدد سایت از «درستِ همان لحظه» بیشتر شد.
- `run_reset.py`: بازنشانی پس از سنجش دوره و خواندن کسرها (دو پردازه، با و بی کشتن نویسنده).
- `run_reset_crash.py`: مرگ پردازهٔ بازنشانی پس از Commit دوره، بازنشانی دوباره پس از آن، و Pull نسل قبل که مکان‌نمایش را پس از بازنشانی
  می‌نویسد؛ `LMC_Stock_Sync::run` واقعی با Core جعلی محلی (`LMC_FAKE_FEED` در `mu-repro.php`).
- `results/`: خروجی خام اجراها (فقط دادهٔ مصنوعی).
- `orders_view.php <wp-root> hpos|legacy`: «سفارش‌های سایت» روی ووکامرس واقعی.
  - **ساخت سفارش:** سفارش مصنوعی با CRUD خود ووکامرس ساخته می‌شود. محل واقعی ذخیره (`wc_orders` یا `posts`) با SQL سنجیده می‌شود؛ این SQL فقط در آزمون است و افزونه SQL نمی‌زند.
  - **فراخوان:** کلاس یک بار مستقیم و یک بار از راه `rest_do_request` امضاشده صدا زده می‌شود. امضای غلط، Nonce تکراری، `perPage=-1`، سفارش ناموجود و نشت تلفن، ایمیل و نشانی هم سنجیده می‌شوند. خواندن نباید هیچ سفارشی را عوض کند.
  - **کنترل منفی:** سفارش همگام‌نشدهٔ انبارهٔ دیگر نباید دیده شود. برای همین، انبارهٔ فعال مستقیم در جدول گزینه‌ها جابه‌جا می‌شود؛ ووکامرس جابه‌جایی با سفارش همگام‌نشده را عمداً رد می‌کند.
  - **نتیجهٔ ۲۰ اکتبر:** `results/2026-10-20-orders-view.jsonl`، چهار اجرای متناوب hpos/legacy/hpos/legacy، هر کدام ۲۳/۲۳.
  - **جهش:** جایگزینی `wc_get_orders` با `get_posts(post_type=shop_order)` روی HPOS در «هر سه، تازه‌ترین اول» و روی legacy در «فیلتر وضعیت» شکست خورد.
- `run_queue.py` + `mu-queue.php` + `queue-actor.php`: صف بحرانی ۱٫۵٫۰ با اجراکنندهٔ واقعی WP-CLI
  (`wp labelmod queue run`)، Core جعلی برای `POST /api/web/orders` (ok، ۵۰۳/۴۲۹ با Retry-After، hang):
  تأخیر صف تا تلاش، دو اجراکنندهٔ هم‌زمان، تخلیهٔ انباشت، SIGKILL و بازیابی، کنترل منفی با Hook بازیابی
  خاموش و با افزونهٔ main، و سقف شش تلاش. نتیجه در `results/2026-10-18-queue.jsonl`.

  ```bash
  python3 run_queue.py <wp-root> <plugin-new> <plugin-old> <wp-cli.phar> <lab-dir> [scenario...]
  ```
- `run_queue_race.py` + `mu-queue-probe.php`: رقابت‌های صف با مانع روی پرسش SQL واقعی (TOCTOU «صف کن»، گم‌شدن
  شمارنده و ثبت مرده، اجرای هم‌زمان دو سطرِ یک سفارش)؛ با یک افزونهٔ داده‌شده اجرا می‌شود تا پیش/پس مقایسه شود.
  نتیجه در `results/2026-10-19-queue-race.jsonl`.

  ```bash
  python3 run_queue_race.py <wp-root> <plugin-dir> <label> <wp-cli.phar> <lab-dir> [scenario...]
  ```
