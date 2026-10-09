# پیش‌نمایش چاپ — رسید ۸۰mm و لیبل بارکد

**آخرین بازطراحی فاکتور: [نسخهٔ دوم با کادر اقلام و خلاصهٔ حساب](receipt-v2/README.md).**
تصاویر فاکتور در پوشهٔ `receipt/` و فایل‌های قدیمی `receipt-*` در پایین، شواهد نسخهٔ قبل‌اند؛ برای ظاهر فعلی نسخهٔ دوم را ببینید.

ساخته‌شده با Chromium از `invoicePage` و `labelPage` با دادهٔ ساختگی؛ تصویرهای `ui-*` از رابط واقعی با **Mock API** آزمون e2e است (پیش‌نمایش iframe متن آزمایشی دارد). جای چاپ فیزیکی روی MEVA TP-UNW و لیبل‌زن واقعی را نمی‌گیرد.

مبنا: `d84ba0fb0e19364df0e6c7d39abd4f7d8ee0bafd` (main).

برچسب‌ها مطابق مرجع مالک (۵۰×۳۰mm پیش‌فرض: نام فروشگاه، بارکد، رقم‌ها، دو سطر شرح، قیمت درشت) دوباره گرفته شدند. رسید از بازطراحی ۱۴۰۵/۰۷ است (بخش پایین) و لوگوی اصیل را دارد. تصویرهای `ui-*` از دور قبل‌اند. بارکد نمونه EAN-13 است؛ سیاست بارکد قدیمی ۱۷ رقمی و Code128 در کار جداگانه است.

`label-50x30-code128-legacy.*`: کد ذخیره‌شدهٔ قدیمی ۱۷ رقمی `20514161201032064` با Code128 (۱۶۵ ماژول، ۴۱٫۲۵mm) — رشته عیناً حفظ شده؛ رمزگشای zxing-wasm در `apps/web/test/code128-decode.test.ts`.

| فایل | SHA-256 |
|---|---|
| `label-30x20.pdf` | `707a67149e02a8e4…` |
| `label-30x20.png` | `5c9623387f65c1f9…` |
| `label-40x25.pdf` | `378f34a9f55edea2…` |
| `label-40x25.png` | `895d7196d33b454f…` |
| `label-50x30-code128-legacy.pdf` | `733312a0be2521cf…` |
| `label-50x30-code128-legacy.png` | `f5e5b183c8ab6f65…` |
| `label-50x30.pdf` | `808885780a5e1ebb…` |
| `label-50x30.png` | `c907612f5030546c…` |
| `label-58x40.pdf` | `b3e7e9da4c659910…` |
| `label-58x40.png` | `0e7319fc5a61b938…` |
| `label-60x40.pdf` | `cd85295ef6fee0f3…` |
| `label-60x40.png` | `8377af449ca1d174…` |
| `label-a4.png` | `ba51635fc4750ffa…` |
| `ui-bulk-queue-chromium-dark-375.png` | `9a41f62f01902308…` |
| `ui-bulk-queue-chromium-light-1440.png` | `232cd0397cb3a6a5…` |
| `ui-product-labels-chromium-dark-375.png` | `b8ce20c6f64d14bc…` |
| `ui-product-labels-chromium-light-1440.png` | `3262d1c3b0623ef2…` |

## رسید ۸۰mm — بازطراحی ۱۴۰۵/۰۷ (`receipt-*` و پوشهٔ `receipt/`)

ساخته‌شده با Chromium از همان `invoicePage` شاخهٔ بازطراحی (لوگوی اصیل `assets/receipt-logo.png`،
دادهٔ ساختگی). `*-print.png` رندر رسانهٔ print با پهنای ۸۰mm است، `*-80mm.pdf` همان صفحه با کاغذ
۸۰mm (یک برگ پیوسته به طول محتوا، مثل رول)، و `*-screen-phone.png` نسخهٔ صفحهٔ مشتری در ۳۹۰px.

شش سناریو: `standard` (تخفیف قلم و مانده)، `rows32` (۳۲ قلم)، `zero100` (تخفیف ۱۰۰٪ و جمع صفر)،
`debtor` (کرایه، پرداخت جزئی، بدهکار)، `longnames` (نام بلند فارسی/لاتین، تسویه از تعویض)، و
`proforma` (پیش‌فاکتور با `documentKind: "proforma"`: همان اقلام و مبالغ `standard`، تیتر «پیش‌فاکتور»،
هشدار «فاکتور نهایی نیست»، «شمارهٔ مرجع» همان رشتهٔ فراخوان، بی وضعیت تسویه).
در هر شش سناریو هیچ عنصری از پهنای ۷۲mm بیرون نزد، هیچ عدد یا نامی بریده نشد و **هیچ رقم فارسی یا
عربی در متن صفحه نماند** (سنجش خودکار روی DOM رندرشده؛ نام کالای نمونه عمداً رقم فارسی دارد).

**رقم‌ها لاتین‌اند** (خواستهٔ مالک ۱۴۰۵/۰۷/۱۷): مبلغ، تعداد، شمارهٔ ردیف، شماره، تاریخ جلالی
(`numberingSystem: "latn"`)، ساعت، مهلت مرجوعی و رقم‌های فارسی/عربی متن ورودی. تقویم جلالی، متن
فارسی و RTL همان‌اند و فهرست فونت هیچ فونت «FD» ندارد. پیش‌نمایش لیبل در این سند جداست و تغییر نکرد.

این تصویرها جای چاپ فیزیکی روی MEVA TP-UNW را نمی‌گیرد؛ مرورگر بی تأیید کاربر چاپ نمی‌کند.

| فایل | SHA-256 |
|---|---|
| `receipt-80mm-print.png` | `d63bdf0cb2317610…` |
| `receipt-80mm.pdf` | `ae6dc963b2529ca2…` |
| `receipt-phone-screen.png` | `a885266e5faa8441…` |
| `receipt-sample.html` | `4074e84146d3d574…` |
| `receipt/debtor-80mm.pdf` | `55785e6458ca9cee…` |
| `receipt/debtor-print.png` | `22c7dfb9f0c2106b…` |
| `receipt/debtor-screen-phone.png` | `b470016a1724b353…` |
| `receipt/debtor.html` | `7c28b539723125fc…` |
| `receipt/longnames-80mm.pdf` | `d5fb0654a5f4b358…` |
| `receipt/longnames-print.png` | `f9db0cc8aaf7c56b…` |
| `receipt/longnames-screen-phone.png` | `8ded2e0d0ef0a3d8…` |
| `receipt/longnames.html` | `0e0113e7046302f0…` |
| `receipt/proforma-80mm.pdf` | `984722ca887f3463…` |
| `receipt/proforma-print.png` | `0bbd7d4f4d196dbd…` |
| `receipt/proforma-screen-desktop.png` | `b020562a512ed4e0…` |
| `receipt/proforma-screen-phone.png` | `f53243f903c010c5…` |
| `receipt/proforma.html` | `4e1a607d532909e7…` |
| `receipt/rows32-80mm.pdf` | `24813fae05df1705…` |
| `receipt/rows32-print.png` | `14386847f3ae5335…` |
| `receipt/rows32-screen-phone.png` | `38d46c2205712bd7…` |
| `receipt/rows32.html` | `e6e703524e29da51…` |
| `receipt/standard-80mm.pdf` | `ae6dc963b2529ca2…` |
| `receipt/standard-print.png` | `d63bdf0cb2317610…` |
| `receipt/standard-screen-desktop.png` | `c20ce5ee1e202694…` |
| `receipt/standard-screen-phone.png` | `a885266e5faa8441…` |
| `receipt/standard.html` | `4074e84146d3d574…` |
| `receipt/zero100-80mm.pdf` | `0994d9d64309efcb…` |
| `receipt/zero100-print.png` | `d6f3a4dac4d70664…` |
| `receipt/zero100-screen-phone.png` | `33858f143f5ea399…` |
| `receipt/zero100.html` | `bc372336acdb36d9…` |
