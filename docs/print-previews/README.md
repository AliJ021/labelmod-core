# پیش‌نمایش چاپ — رسید ۸۰mm و لیبل بارکد

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

پنج سناریو: `standard` (تخفیف قلم و مانده)، `rows32` (۳۲ قلم)، `zero100` (تخفیف ۱۰۰٪ و جمع صفر)،
`debtor` (کرایه، پرداخت جزئی، بدهکار)، `longnames` (نام بلند فارسی/لاتین، تسویه از تعویض).
در هر پنج سناریو هیچ عنصری از پهنای ۷۲mm بیرون نزد و هیچ عدد یا نامی بریده نشد (سنجش خودکار
روی DOM رندرشده). جای چاپ فیزیکی روی MEVA TP-UNW را نمی‌گیرد؛ مرورگر بی تأیید کاربر چاپ نمی‌کند.

| فایل | SHA-256 |
|---|---|
| `receipt-80mm-print.png` | `de07e603c1105ffb…` |
| `receipt-80mm.pdf` | `23a639b33c8a1a3e…` |
| `receipt-phone-screen.png` | `47519f498934c2a1…` |
| `receipt-sample.html` | `dfdda9bb9bc6bca5…` |
| `receipt/debtor-80mm.pdf` | `b7a4bcaba871eab3…` |
| `receipt/debtor-print.png` | `0d76f90e52352f89…` |
| `receipt/debtor-screen-phone.png` | `adf57867f1c460f8…` |
| `receipt/debtor.html` | `b506cd0e1f9078ef…` |
| `receipt/longnames-80mm.pdf` | `eb1ebecab416b4b7…` |
| `receipt/longnames-print.png` | `b73c7d04ee583b01…` |
| `receipt/longnames-screen-phone.png` | `4acf83f66da5b6f4…` |
| `receipt/longnames.html` | `2d22e60fff44158c…` |
| `receipt/rows32-80mm.pdf` | `da8753a6987294da…` |
| `receipt/rows32-print.png` | `8876cb3e00de8a94…` |
| `receipt/rows32-screen-phone.png` | `044f6b395e04d7e2…` |
| `receipt/rows32.html` | `55f1e73c039efa45…` |
| `receipt/standard-80mm.pdf` | `23a639b33c8a1a3e…` |
| `receipt/standard-print.png` | `de07e603c1105ffb…` |
| `receipt/standard-screen-desktop.png` | `de461e051ba908fd…` |
| `receipt/standard-screen-phone.png` | `47519f498934c2a1…` |
| `receipt/standard.html` | `dfdda9bb9bc6bca5…` |
| `receipt/zero100-80mm.pdf` | `db9c72dd6137e5e7…` |
| `receipt/zero100-print.png` | `ccb94e40ea71f73c…` |
| `receipt/zero100-screen-phone.png` | `bb99020132198640…` |
| `receipt/zero100.html` | `d5522a87970c4e95…` |
