# پیش‌نمایش چاپ — رسید ۸۰mm و لیبل بارکد

ساخته‌شده با Chromium از `invoicePage` و `labelPage` با دادهٔ ساختگی؛ تصویرهای `ui-*` از رابط واقعی با **Mock API** آزمون e2e است (پیش‌نمایش iframe متن آزمایشی دارد). جای چاپ فیزیکی روی MEVA TP-UNW و لیبل‌زن واقعی را نمی‌گیرد.

مبنا: `d84ba0fb0e19364df0e6c7d39abd4f7d8ee0bafd` (main).

برچسب‌ها مطابق مرجع مالک (۵۰×۳۰mm پیش‌فرض: نام فروشگاه، بارکد، رقم‌ها، دو سطر شرح، قیمت درشت) و رسید (نشان متنی از نام شعبه — هیچ فایل لوگوی اصیلی در مخزن نیست؛ مهلت مرجوعی از تنظیم `return.window_hours`) دوباره گرفته شدند. تصویرهای `ui-*` از دور قبل‌اند. بارکد نمونه EAN-13 است؛ سیاست بارکد قدیمی ۱۷ رقمی و Code128 در کار جداگانه است.

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
| `receipt-80mm-print.png` | `7ac93f2968bc3ff4…` |
| `receipt-80mm.pdf` | `29c777428f1c0277…` |
| `receipt-phone-screen.png` | `099326f27c55a2d1…` |
| `receipt-sample.html` | `cba35da830aec7d5…` |
| `ui-bulk-queue-chromium-dark-375.png` | `9a41f62f01902308…` |
| `ui-bulk-queue-chromium-light-1440.png` | `232cd0397cb3a6a5…` |
| `ui-product-labels-chromium-dark-375.png` | `b8ce20c6f64d14bc…` |
| `ui-product-labels-chromium-light-1440.png` | `3262d1c3b0623ef2…` |
