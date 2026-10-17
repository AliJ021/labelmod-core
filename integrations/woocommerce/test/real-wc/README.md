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
- `run_reset_crash.py`: مرگ پردازهٔ بازنشانی پس از Commit دوره، و Pull نسل قبل که مکان‌نمایش را پس از بازنشانی
  می‌نویسد؛ `LMC_Stock_Sync::run` واقعی با Core جعلی محلی (`LMC_FAKE_FEED` در `mu-repro.php`).
- `results/`: خروجی خام اجراها (فقط دادهٔ مصنوعی).
