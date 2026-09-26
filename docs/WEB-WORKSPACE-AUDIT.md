# ممیزی و اجرای بازطراحی وب

مبنای محلی: PR #101، commit `1196a252f76b869c6c68708c9f97628e6a872ae0`؛ اصلاحات #94 تا #100 حفظ شده‌اند.
این سند ممیزی اولیه است؛ وضعیت استقرار و نتیجه‌های جدید در [تحویل ۲۶ سپتامبر](HANDOFF-2026-09-26-FA.md) ثبت شده است. بازدید تعاملی همهٔ عملیات هنوز کامل نشده است.

## قابلیت‌ها و وضعیت مبنا

| قابلیت | وضعیت قبل از تغییر | مسیر | معیار پذیرش |
|---|---|---|---|
| پیشخوان و گزارش روز | قابل‌دسترسی | داشبورد | داده واقعی، بدون ادعای بازبودن شیفت از روی گزارش |
| صندوق و پرداخت ترکیبی | قابل‌دسترسی | صندوق | ورودی واحد، کنترل موجودی، تکرار ایمن |
| جست‌وجوی نام محصول | موجود با تعامل نامناسب | صندوق / فیلد جدا | یک ورودی برای نام، کد و بارکد |
| مرجوعی و تأیید مرجوعی سایت | محدود به مجوز | مرجوعی | تأیید مستقل و حفظ سابقه |
| موجودی و چاپ لیبل | موجود ولی دشوار برای پیدا کردن | کالا / جزئیات | ورودی آشکار فهرست و جزئیات |
| چاپ فاکتور عمومی | موجود با لینک رسید مشتری | API عمومی | چاپ احراز‌شده از فاکتورها و پس از فروش |
| PIN و تغییر آن | موجود ولی دشوار برای پیدا کردن | تنظیمات / PIN من | جست‌وجو و نشانی مستقل |
| دومرحله‌ای و پیامک | قابل‌دسترسی / نیازمند تنظیم سرویس | تنظیمات / دومرحله‌ای | عدم ارسال واقعی بدون مجوز |
| مرکز فاکتورها و پیش‌نویس‌ها | فاقد رابط یکپارچه | جدید: فاکتورها | فهرست سرور، مالکیت، شیفت، بدون حذف خودکار |
| فروش بر اساس نهایی‌کننده | هنوز پیاده‌نشده | گزارش‌ها | ثبت هویت جدید، نامعلوم برای سابقه بی‌شاهد |
| اسنپ‌پی دستی | هنوز پیاده‌نشده | روش پرداخت / خزانه | حساب معتبر، مرجع اجباری، تطبیق دفتر |
| پشتیبان‌گیری و بازیابی اصلی | ابزار مدیریتی، فاقد رابط کامل | تنظیمات | سرویس جدا، عامل دوم، rehearsal و rollback |

## کنترل‌های انتشار

- [x] تطبیق شاخه‌های #94 تا #101 و ایجاد شاخه مستقل.
- [x] پیاده‌سازی اولیه URL و چیدمان مشترک در نسخه محلی.
- [x] ورودی واحد و کنترل زودهنگام موجودی در سرویس صندوق.
- [x] محدودسازی صف و ادامهٔ پیش‌نویس؛ نگهداری اسکن نامشخص.
- [x] مرکز فاکتورها، هویت نهایی‌کننده و مسیر چاپ احراز‌شده (پیاده‌سازی اولیه).
- [ ] بازدید تعاملی تمام صفحات با نقش‌های مجاز و ثبت شواهد.
- [x] تطبیق archive کد runtime با imageهای نسخهٔ مستقر؛ شناسه‌ها در سند تحویل.
- [x] پیاده‌سازی گزارش کاربران و ثبت دستی اسنپ‌پی؛ پذیرش عملیاتی مستقل هنوز باز است.
- [ ] نصب و پذیرش عملیاتی سرویس بکاپ/بازیابی؛ کد و آزمون PG آماده، نصب نشده است.
- [ ] پوشش مرورگر در شش عرض، دو موتور، دو تم؛ CI روی 9098598 برابر 1127 موفق/1 ناموفق بود و مانع lock/logout باز است؛ صفحه‌کلید و بزرگ‌نمایی و پذیرش زنده نیز باید تکمیل شوند.
- [x] SQL، API با دو نقش (847 در هر نقش)، واحد وب، افزونه و ساخت ایمیج candidate؛ نتیجهٔ مرورگر جداست.
- [x] بازبینی مستقل اصلاحات مرز صندوق و posting و انتشار candidate دقیق؛ این مورد به معنای بسته‌شدن تمام یافته‌های قدیمی نیست.

## فهرست صفحات موجود در کد

- `Accounts.tsx`
- `Appearance.tsx`
- `Backups.tsx`
- `Catalog.tsx`
- `Customers.tsx`
- `Dashboard.tsx`
- `Devices.tsx`
- `Health.tsx`
- `Invoices.tsx`
- `Login.tsx`
- `MeliPayamakSettings.tsx`
- `Opening.tsx`
- `Permissions.tsx`
- `PersonalPin.tsx`
- `Pos.tsx`
- `PostingRules.tsx`
- `PurchaseOrder.tsx`
- `PurchaseReturn.tsx`
- `Purchasing.tsx`
- `Reports.tsx`
- `Returns.tsx`
- `Settings.tsx`
- `SmsTwoFactor.tsx`
- `SnappaySettings.tsx`
- `Staff.tsx`
- `StockCount.tsx`
- `Terminals.tsx`
- `Transfer.tsx`
- `Treasury.tsx`
- `TwoFactor.tsx`
- `Warehouse.tsx`
- `WebRefundRequests.tsx`

## فهرست عملیات HTTP موجود در کد

فهرست ایستا از ثبت‌های صریح `app.get/post/put/patch/delete/head/options` در فایل‌های HTTP است؛ به معنی دسترسی همهٔ نقش‌ها، ثبت runtime همهٔ افزونه‌ها یا آزمون موفق همهٔ عملیات نیست. پیشوند نصب API در این جدول نیامده است. نسخهٔ نهایی شامل مسیرهای بکاپ، اسنپ‌پی، گزارش کاربران و منابع برگشت نیز هست.

| فایل | روش | مسیر |
|---|---|---|
| `admin-routes.ts` | GET | `/accounts` |
| `admin-routes.ts` | PUT | `/accounts/:code` |
| `admin-routes.ts` | PATCH | `/accounts/:code/active` |
| `admin-routes.ts` | GET | `/posting-rules` |
| `admin-routes.ts` | PUT | `/posting-rules/:eventType/:leg/:side` |
| `admin-routes.ts` | GET | `/permission-rules` |
| `admin-routes.ts` | PUT | `/permission-rules/:role/:operation` |
| `admin-routes.ts` | GET | `/tafsili` |
| `admin-routes.ts` | POST | `/opening-balance` |
| `app.ts` | GET | `/health` |
| `auth-routes.ts` | GET | `/auth/pin` |
| `auth-routes.ts` | POST | `/auth/pin` |
| `auth-routes.ts` | GET | `/auth/2fa/sms/status` |
| `auth-routes.ts` | POST | `/auth/2fa/sms/enroll` |
| `auth-routes.ts` | POST | `/auth/2fa/sms/confirm` |
| `auth-routes.ts` | POST | `/auth/2fa/sms/disable` |
| `auth-routes.ts` | POST | `/auth/2fa/sms/request` |
| `auth-routes.ts` | POST | `/auth/login` |
| `auth-routes.ts` | POST | `/auth/2fa/totp` |
| `auth-routes.ts` | POST | `/auth/2fa/sms` |
| `auth-routes.ts` | POST | `/auth/2fa/recovery` |
| `auth-routes.ts` | GET | `/auth/2fa` |
| `auth-routes.ts` | POST | `/auth/2fa/totp/begin` |
| `auth-routes.ts` | POST | `/auth/2fa/totp/confirm` |
| `auth-routes.ts` | POST | `/auth/2fa/recovery/regenerate` |
| `auth-routes.ts` | GET | `/auth/2fa/webauthn` |
| `auth-routes.ts` | POST | `/auth/2fa/webauthn/register/begin` |
| `auth-routes.ts` | POST | `/auth/2fa/webauthn/register/finish` |
| `auth-routes.ts` | DELETE | `/auth/2fa/webauthn/:id` |
| `auth-routes.ts` | POST | `/auth/2fa/webauthn/begin` |
| `auth-routes.ts` | POST | `/auth/2fa/webauthn/verify` |
| `auth-routes.ts` | DELETE | `/auth/2fa` |
| `auth-routes.ts` | DELETE | `/users/:id/2fa` |
| `auth-routes.ts` | POST | `/auth/logout` |
| `auth-routes.ts` | POST | `/auth/lock` |
| `auth-routes.ts` | POST | `/auth/unlock` |
| `auth-routes.ts` | POST | `/auth/reauth` |
| `auth-routes.ts` | POST | `/auth/change-password` |
| `auth-routes.ts` | GET | `/auth/me` |
| `auth-routes.ts` | GET | `/auth/can` |
| `auth-routes.ts` | POST | `/auth/revoke-all` |
| `auth-routes.ts` | GET | `/devices` |
| `auth-routes.ts` | POST | `/devices/:id/approve` |
| `auth-routes.ts` | POST | `/devices/:id/revoke` |
| `auth-routes.ts` | GET | `/sessions` |
| `auth-routes.ts` | POST | `/users/:id/revoke-sessions` |
| `backup-routes.ts` | GET | `/backups` |
| `backup-routes.ts` | POST | `/backups` |
| `backup-routes.ts` | GET | `/backups/:id/download` |
| `backup-routes.ts` | POST | `/backups/restore` |
| `catalog-routes.ts` | POST | `/products/:id/variations/generate` |
| `catalog-routes.ts` | POST | `/labels` |
| `catalog-routes.ts` | GET | `/products/:id/stock-matrix` |
| `health-routes.ts` | GET | `/health/alerts` |
| `health-routes.ts` | GET | `/health/dead-letters` |
| `health-routes.ts` | POST | `/health/dead-letters/:id/requeue` |
| `invoice-workspace-routes.ts` | GET | `/invoices` |
| `invoice-workspace-routes.ts` | GET | `/invoices/:id/refund-sources` |
| `invoice-workspace-routes.ts` | GET | `/invoices/:id/print` |
| `invoice-workspace-routes.ts` | GET | `/invoices/:id/overview` |
| `melipayamak-routes.ts` | GET | `/settings/melipayamak-credential` |
| `melipayamak-routes.ts` | PUT | `/settings/melipayamak-credential` |
| `people-routes.ts` | GET | `/users` |
| `people-routes.ts` | GET | `/users/:id` |
| `people-routes.ts` | GET | `/roles` |
| `people-routes.ts` | POST | `/users` |
| `people-routes.ts` | PATCH | `/users/:id` |
| `people-routes.ts` | PUT | `/users/:id/roles` |
| `people-routes.ts` | POST | `/users/:id/reset-password` |
| `people-routes.ts` | PUT | `/users/:id/pin` |
| `people-routes.ts` | GET | `/customers` |
| `people-routes.ts` | GET | `/customers/:id` |
| `people-routes.ts` | POST | `/customers` |
| `people-routes.ts` | PATCH | `/customers/:id` |
| `people-routes.ts` | GET | `/customers/:id/fitting` |
| `people-routes.ts` | GET | `/measure-keys` |
| `people-routes.ts` | GET | `/customers/:id/measures` |
| `people-routes.ts` | PUT | `/customers/:id/measures` |
| `pos-catalog-routes.ts` | GET | `/pos/products` |
| `pos-catalog-routes.ts` | GET | `/pos/products/:id/variations` |
| `posting-routes.ts` | GET | `/posting-batches/unposted` |
| `posting-routes.ts` | POST | `/posting-batches/close-due` |
| `posting-routes.ts` | POST | `/posting-batches/close-channel-day` |
| `product-routes.ts` | GET | `/products` |
| `product-routes.ts` | GET | `/products/ref-data` |
| `product-routes.ts` | GET | `/products/:id` |
| `product-routes.ts` | GET | `/variations/:id/price-history` |
| `product-routes.ts` | POST | `/products` |
| `product-routes.ts` | PATCH | `/products/:id` |
| `product-routes.ts` | PATCH | `/products/:id/status` |
| `product-routes.ts` | PATCH | `/variations/:id/status` |
| `product-routes.ts` | PATCH | `/variations/:id` |
| `product-routes.ts` | PUT | `/variations/:id/price` |
| `product-routes.ts` | PUT | `/prices` |
| `public-routes.ts` | GET | `/i/:token` |
| `purchasing-routes.ts` | GET | `/suppliers` |
| `purchasing-routes.ts` | POST | `/suppliers` |
| `purchasing-routes.ts` | GET | `/purchasing/pay-accounts` |
| `purchasing-routes.ts` | GET | `/purchasing/expense-accounts` |
| `purchasing-routes.ts` | GET | `/receipts` |
| `purchasing-routes.ts` | GET | `/receipts/lookup` |
| `purchasing-routes.ts` | GET | `/receipts/:id` |
| `purchasing-routes.ts` | POST | `/receipts` |
| `purchasing-routes.ts` | PATCH | `/receipts/:id` |
| `purchasing-routes.ts` | POST | `/receipts/:id/lines` |
| `purchasing-routes.ts` | PATCH | `/receipts/:id/lines/:lineId` |
| `purchasing-routes.ts` | DELETE | `/receipts/:id/lines/:lineId` |
| `purchasing-routes.ts` | POST | `/receipts/:id/charges` |
| `purchasing-routes.ts` | DELETE | `/receipts/:id/charges/:chargeId` |
| `purchasing-routes.ts` | POST | `/receipts/:id/post` |
| `purchasing-routes.ts` | POST | `/receipts/:id/cancel` |
| `purchasing-routes.ts` | GET | `/stock-counts` |
| `purchasing-routes.ts` | GET | `/stock-counts/:id` |
| `purchasing-routes.ts` | POST | `/stock-counts` |
| `purchasing-routes.ts` | PUT | `/stock-counts/:id/lines` |
| `purchasing-routes.ts` | DELETE | `/stock-counts/:id/lines/:lineId` |
| `purchasing-routes.ts` | POST | `/stock-counts/:id/post` |
| `purchasing-routes.ts` | POST | `/stock-counts/:id/cancel` |
| `purchasing-routes.ts` | GET | `/receipts/:id/returnable` |
| `purchasing-routes.ts` | GET | `/purchase-returns/:id` |
| `purchasing-routes.ts` | POST | `/purchase-returns` |
| `purchasing-routes.ts` | GET | `/purchase-orders` |
| `purchasing-routes.ts` | GET | `/purchase-orders/:id` |
| `purchasing-routes.ts` | POST | `/purchase-orders` |
| `purchasing-routes.ts` | PUT | `/purchase-orders/:id/lines` |
| `purchasing-routes.ts` | DELETE | `/purchase-orders/:id/lines/:lineId` |
| `purchasing-routes.ts` | POST | `/purchase-orders/:id/send` |
| `purchasing-routes.ts` | POST | `/purchase-orders/:id/receipt` |
| `purchasing-routes.ts` | POST | `/purchase-orders/:id/close` |
| `report-routes.ts` | GET | `/reports/hourly` |
| `report-routes.ts` | GET | `/reports/compare` |
| `report-routes.ts` | GET | `/reports/basket` |
| `report-routes.ts` | GET | `/reports/customer-basket` |
| `report-routes.ts` | GET | `/reports/snappay` |
| `report-routes.ts` | GET | `/reports/staff-sales` |
| `report-routes.ts` | GET | `/reports/sales` |
| `report-routes.ts` | GET | `/reports/profit-by-product` |
| `report-routes.ts` | GET | `/reports/inventory-valuation` |
| `report-routes.ts` | GET | `/reports/stock-movements` |
| `report-routes.ts` | GET | `/reports/account-ledger` |
| `report-routes.ts` | GET | `/reports/trial-balance` |
| `report-routes.ts` | GET | `/reports/party-balances` |
| `report-routes.ts` | GET | `/reports/cash-reconciliation` |
| `return-routes.ts` | GET | `/invoices/:id/returnable` |
| `return-routes.ts` | POST | `/returns` |
| `return-routes.ts` | GET | `/returns/:id` |
| `return-routes.ts` | PUT | `/returns/:id/warehouse` |
| `return-routes.ts` | POST | `/returns/:id/post` |
| `return-routes.ts` | POST | `/returns/:id/cancel` |
| `sales-routes.ts` | GET | `/shifts/open` |
| `sales-routes.ts` | GET | `/shifts/current` |
| `sales-routes.ts` | POST | `/shifts` |
| `sales-routes.ts` | POST | `/shifts/:id/close` |
| `sales-routes.ts` | POST | `/invoices` |
| `sales-routes.ts` | GET | `/invoices/lookup` |
| `sales-routes.ts` | GET | `/invoices/:id` |
| `sales-routes.ts` | POST | `/invoices/:id/lines` |
| `sales-routes.ts` | PATCH | `/invoices/:id/lines/:lineId` |
| `sales-routes.ts` | PATCH | `/invoices/:id/lines/:lineId/discount` |
| `sales-routes.ts` | PATCH | `/invoices/:id/lines/:lineId/price` |
| `sales-routes.ts` | PATCH | `/invoices/:id/customer` |
| `sales-routes.ts` | PATCH | `/invoices/:id/recipient` |
| `sales-routes.ts` | GET | `/gift-options` |
| `sales-routes.ts` | PUT | `/invoices/:id/gift` |
| `sales-routes.ts` | POST | `/invoices/:id/scan` |
| `sales-routes.ts` | DELETE | `/invoices/:id/lines/:lineId` |
| `sales-routes.ts` | POST | `/invoices/:id/cancel` |
| `sales-routes.ts` | GET | `/invoices/:id/draft-payments` |
| `sales-routes.ts` | GET | `/invoices/:id/payments` |
| `sales-routes.ts` | POST | `/invoices/:id/refund-draft` |
| `sales-routes.ts` | POST | `/invoices/:id/payments` |
| `sales-routes.ts` | POST | `/invoices/:id/finalize` |
| `sales-routes.ts` | GET | `/stock/:variationId` |
| `scope-routes.ts` | GET | `/branches` |
| `scope-routes.ts` | GET | `/payment-methods` |
| `scope-routes.ts` | GET | `/reports/daily` |
| `scope-routes.ts` | GET | `/seasons` |
| `scope-routes.ts` | GET | `/return-reasons` |
| `settings-routes.ts` | GET | `/settings` |
| `settings-routes.ts` | PATCH | `/settings/:key` |
| `settings-routes.ts` | GET | `/device-drivers` |
| `settings-routes.ts` | PUT | `/device-drivers/:code` |
| `settings-routes.ts` | PATCH | `/device-drivers/:code/active` |
| `settings-routes.ts` | GET | `/terminal-drivers` |
| `settings-routes.ts` | PATCH | `/terminal-drivers/:id` |
| `settings-routes.ts` | GET | `/settlement-terms` |
| `settings-routes.ts` | PATCH | `/settlement-terms/:id` |
| `snappay-routes.ts` | GET | `/snappay/config` |
| `snappay-routes.ts` | PUT | `/snappay/config` |
| `transfer-routes.ts` | GET | `/transfers` |
| `transfer-routes.ts` | GET | `/transfers/:id` |
| `transfer-routes.ts` | POST | `/transfers` |
| `transfer-routes.ts` | POST | `/transfers/:id/lines` |
| `transfer-routes.ts` | PATCH | `/transfers/:id/lines/:lineId` |
| `transfer-routes.ts` | DELETE | `/transfers/:id/lines/:lineId` |
| `transfer-routes.ts` | DELETE | `/transfers/:id` |
| `transfer-routes.ts` | POST | `/transfers/:id/post` |
| `treasury-routes.ts` | GET | `/treasury/accounts` |
| `treasury-routes.ts` | GET | `/treasury/transactions` |
| `treasury-routes.ts` | POST | `/treasury/transactions` |
| `treasury-routes.ts` | GET | `/cheques` |
| `treasury-routes.ts` | GET | `/cheques/due` |
| `treasury-routes.ts` | GET | `/cheques/:id` |
| `treasury-routes.ts` | POST | `/cheques` |
| `treasury-routes.ts` | POST | `/cheques/:id/events` |
| `web-refund-review-routes.ts` | GET | `/web-refund-requests` |
| `web-refund-review-routes.ts` | POST | `/web-refund-requests/:id/decision` |
| `web-refund-routes.ts` | POST | `/web/refunds` |
| `web-routes.ts` | POST | `/web/orders` |
| `web-routes.ts` | GET | `/web/stock` |
| `web-routes.ts` | GET | `/web/instore-purchases` |
