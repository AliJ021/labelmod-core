# لوگوی رسید

`receipt-logo.png` در همین پوشه، لوگوی **اصیل و منتشرشدهٔ** لیبل مد است که
`receipt-logo.ts` در رسید ۸۰mm جاسازی می‌کند (data:، بی وابستگی شبکه در چاپ).
تا این فایل نباشد، رسید نام شعبه را به‌صورت نشان متنی چاپ می‌کند.

منبع‌های مجاز (سایت آزمایشی مالک):

- `https://alja0.ir/wp-content/plugins/labelmod-theme-mode/assets/images/labelmod-logo-light-on-dark.png` (سربرگ سایت)
- `https://alja0.ir/wp-content/plugins/labelmod-liquid-footer-v4/assets/img/labelmod-logo.png` (پابرگ سایت)

قرار دادن (همان فایل، بدون ویرایش یا بازسازی):

```bash
curl -fsSL -o apps/api/src/sales/assets/receipt-logo.png '<یکی از نشانی‌های بالا>'
node --experimental-strip-types -e 'import("./apps/api/src/sales/receipt-logo.ts").then(m=>console.log(m.receiptLogo()?.treatment, m.receiptLogo()?.width, m.receiptLogo()?.height))'
```

شرط‌ها: PNG هشت‌بیتی بدون Interlace، حداکثر ۲۰۰KB. درمان چاپ از پیکسل‌ها
تعیین می‌شود: شفاف → تمام‌سیاه (`brightness(0)`)؛ پس‌زمینهٔ مات → خاکستری.
