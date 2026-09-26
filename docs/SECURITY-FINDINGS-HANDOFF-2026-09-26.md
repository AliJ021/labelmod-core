# دفتر تحویل یافته‌های امنیتی — ۲۶ سپتامبر ۲۰۲۶

این جدول برای جلوگیری از حذف یا اجرای دوبارهٔ کار است؛ اسکن امنیتی جدید یا تأیید مستقل همهٔ یافته‌ها نیست. شماره‌ها ردیف ledger تحویل قبلی‌اند، نه شمارهٔ PR یا شمارهٔ فهرست لینک‌های چت. ۴۹ ردیف وجود دارد؛ ردیف ۴۹ از نظر موضوع تکرار ۲۵ است. عنوان‌ها از ledger قبلی حفظ شده‌اند. وضعیت تاریخی با پیشرفت PR #105 تکمیل شده، اما وضعیت سرویس Codex Security تغییر داده نشده است.

منبع اولیه: `findings-transfer.json` در بستهٔ تحویل ۲۰۲۶/۰۹/۲۶؛ خلاصهٔ لازم اینجا آمده و برای ادامه به ZIP نیاز نیست. «اصلاح قبلی» یعنی در PR نام‌برده ادغام شده و کد آن در candidate مستقر حاضر است؛ به معنی بازآزمایی مستقل تک‌تک این ردیف‌ها در ممیزی نهایی نیست.

| ردیف | عنوان اولیه | وضعیت تحویل / مرجع |
|---|---|---|
| 1 | Woo API keys can forge posted refunds and stock returns | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 2 | Required roles can log in without a second factor | مهار موجود روی نسخهٔ تاریخی fef5f5f بررسی شده؛ تغییر کد جدید لازم دانسته نشد؛ ادعای پوشش همهٔ سناریوها نیست |
| 3 | Persistent queue replays arbitrary POSTs as the next user | اصلاح candidate در PR #105؛ آزمون هدفمند و API موفق؛ merge و پذیرش کامل باز |
| 4 | Paid gift options can be finalized without being charged | باز؛ مبلغ برگشت صریح و سقف مبلغ ذخیره‌شده تأیید شده؛ حساب/مالیات هدیه منتظر تصمیم |
| 5 | Customer PII report remains available after PIN unlock | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 6 | Cashiers can dump branch-wide customer purchase data | اصلاح قبلی PR #96؛ ادغام‌شده و در کد release تست حاضر |
| 7 | Transfer routes bypass cost.view and disclose inventory costs | اصلاح قبلی PR #95؛ ادغام‌شده و در کد release تست حاضر |
| 8 | Device administration ignores branch scope | اصلاح قبلی PR #100؛ ادغام‌شده و در کد release تست حاضر |
| 9 | Open drafts bypass later catalog price increases | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 10 | Purchase returns can be duplicated without an idempotency key | اصلاح قبلی PR #98؛ ادغام‌شده و در کد release تست حاضر |
| 11 | PIN sessions bypass reauthentication for stock adjustments | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 12 | Production API runs with the PostgreSQL superuser | اصلاح قبلی PR #101 ادغام شد؛ نقش محدود در release تست مستقر است |
| 13 | FIFO switch reuses layers for inventory already sold | مهار موجود روی نسخهٔ تاریخی fef5f5f بررسی شده؛ تغییر کد جدید لازم دانسته نشد؛ ادعای پوشش همهٔ سناریوها نیست |
| 14 | Daily sales reports lack an operation-permission check | اصلاح قبلی PR #96؛ ادغام‌شده و در کد release تست حاضر |
| 15 | Predictable receipt lookup bypasses role authorization | اصلاح قبلی PR #96؛ ادغام‌شده و در کد release تست حاضر |
| 16 | Untrusted cart state can resume an invoice from another shift | اصلاح candidate در PR #105؛ آزمون هدفمند و API موفق؛ merge و پذیرش کامل باز |
| 17 | Lost scan responses can duplicate sale lines and stock | اصلاح candidate در PR #105؛ آزمون هدفمند و API موفق؛ merge و پذیرش کامل باز |
| 18 | Failed lock or logout silently leaves the session active | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 19 | Barcode scans can exhaust the PostgreSQL connection pool | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 20 | Bulk period close bypasses branch scope | اصلاح candidate در PR #105؛ آزمون هدفمند و API موفق؛ merge و پذیرش کامل باز |
| 21 | Settlement terms bypass branch authorization | اصلاح قبلی PR #99؛ ادغام‌شده و در کد release تست حاضر |
| 22 | Stale drafts bypass manual-price markdown approval | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 23 | Label count validation permits process-wide resource exhaustion | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 24 | Stored stock-matrix keys enable prototype pollution | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 25 | Channel-day close can omit concurrent finalized invoices | اصلاح candidate در PR #105؛ آزمون هدفمند و API موفق؛ merge و پذیرش کامل باز |
| 26 | Crafted .npmrc filename executes commands in pre-push hook | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 27 | Production webhooks are sent without authentication | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 28 | Terminal-driver APIs ignore branch scope | اصلاح قبلی PR #99؛ ادغام‌شده و در کد release تست حاضر |
| 29 | Receipt links can corrupt purchase orders across branches | باز؛ شرح معیار ادامه در سند HANDOFF |
| 30 | Hourly flooring leaves a one-hour late-return bypass | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 31 | Return responses disclose COGS without cost.view permission | اصلاح قبلی PR #95؛ ادغام‌شده و در کد release تست حاضر |
| 32 | Reauthentication clears lockout before checking it | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 33 | Edited migration prevents the journal guard fix from deploying | باز؛ شرح معیار ادامه در سند HANDOFF |
| 34 | Editing migration 065 blocks existing database upgrades | باز؛ شرح معیار ادامه در سند HANDOFF |
| 35 | ZXing version mismatch breaks fallback barcode scanning | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 36 | Chosen passwords bypass the configured password policy | اصلاح قبلی PR #97؛ ادغام‌شده و در کد release تست حاضر |
| 37 | Web push SSRF validation is not bound to the fetched address | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 38 | Failed restores can be recorded as successful | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 39 | WebAuthn verification rejects the browser's valid payload | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 40 | Amount reformatting bypasses treasury retry deduplication | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 41 | Log SMS provider exposes invoice tokens and financial PII | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 42 | Migration fails when the deprecated posting mode is in use | باز؛ شرح معیار ادامه در سند HANDOFF |
| 43 | Approval-gated security rule bypasses the last-admin guard | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 44 | Detector failure leaves the camera track running | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 45 | Shift close can deadlock and exhaust the database pool | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 46 | Secret scanning fails open when sha256sum is unavailable | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 47 | Duplicate receipt lines make revaluation order-dependent | اصلاح قبلی PR #94؛ ادغام‌شده و در کد release تست حاضر |
| 48 | Concurrent settlements can post the same payments twice | مهار موجود روی نسخهٔ تاریخی fef5f5f بررسی شده؛ تغییر کد جدید لازم دانسته نشد؛ ادعای پوشش همهٔ سناریوها نیست |
| 49 | Batch-close race silently drops finalized sales from the ledger | تکرار موضوع 25؛ همان اصلاح PR #105، مستقل دوباره اجرا نشود |

## قواعد ادامه

- ردیف‌های 3، 16، 17، 20 و 25 را به صرف وجود کد بسته اعلام نکن؛ PR #105 هنوز مانع مرورگر و پذیرش دارد.
- برای 33/34/42 نصب تازه کافی نیست؛ snapshot نصب قدیمی و checksum اصلی باید در ارتقای آزمایشی بررسی شود.
- برای 29، قیود واقعی سفارش/رسید را حفظ کن و پیش‌فرض مالی تازه اختراع نکن.
- برای 4، برگشت مبلغ هدیه تابع سقف همان فاکتور و مجموع مرجوعی‌های قبلی است؛ تعیین سرفصل و مالیات را از حسابدار بگیر.
- شرح اثبات‌های تاریخی بدون تغییر (2/13/48) به‌ترتیب دربارهٔ مسیر مجاز MFA، حفظ ارزش FIFO و هم‌زمانی تسویه است. نتیجهٔ محدود آن‌ها را به همهٔ مسیرهای فعلی تعمیم نده.
- [راهنمای اصلی](HANDOFF-2026-09-26-FA.md) و تست‌های همان PR را مبنا قرار بده؛ برای جزئیات تأییدنشده، گزارش اصلی را از اتصال مجاز بخوان.
