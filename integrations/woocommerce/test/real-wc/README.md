# بازتولید با پردازه‌های واقعی ووکامرس

فقط محلی و با دادهٔ مصنوعی. نه کلید، نه سفارش زنده، نه استقرار. در CI اجرا نمی‌شود چون وردپرس، ووکامرس و MariaDB
را از شبکه می‌گیرد. نتیجه و جدول در `docs/STOCK-SYNC-PROTOCOL.md` («بازتولید با پردازه‌های واقعی») است.

```bash
# MariaDB محلی روی سوکت، پایگاه wpr و کاربر wp (رمز مصنوعی setup.sh)
setup.sh  <work> <plugins>/new <socket>      # وردپرس 7.0.7 + ووکامرس 11.1.1؛ نسخه‌ها سنجیده می‌شوند
# <plugins>/old = افزونه در 757a1c4 ، <plugins>/new = افزونهٔ جاری
python3 run.py <work> <plugins> old new > result.jsonl
```

- `mu-repro.php`: فایل‌مانع؛ پردازه با `LMC_ROLE` در مرحلهٔ `LMC_PAUSE` می‌ایستد تا `run.py` اجازه دهد.
- `actor.php`: یک فرمان در یک پردازهٔ PHP (`prep`، `reduce`، `adjust`، `apply`، `ack`، `read`).
- `run.py`: دو پردازهٔ هم‌زمان، SIGKILL در نقطه‌های بحرانی، و `over_truth_in` = سناریوهایی که عدد سایت از
  «Core − کسرهای واقعی» بیشتر شد.
