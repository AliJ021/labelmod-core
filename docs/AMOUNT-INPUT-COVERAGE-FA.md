# پوشش ورودی و نمایش پول (R07)

**مبنا:** main = `1d855c1`.
**دامنه:** فقط لایهٔ وب. API، SQL و منطق مالی تغییر نکرده‌اند.

## قاعده

هر کادری که کاربر در آن مبلغ تومانی تایپ می‌کند، `components/ui/AmountInput.tsx` است. این مؤلفه سه کار می‌کند:

- جداکنندهٔ هزارگان را نمایش می‌دهد.
- جای مکان‌نما را پس از گروه‌بندی نگه می‌دارد.
- رقم فارسی و عربی را به لاتین برمی‌گرداند.

مقدار state و بدنهٔ API همان رشتهٔ بی‌جداکننده می‌ماند. تبدیل تومان به ریال فقط در مرزهای `lib/money.ts` و `lib/instagram-orders.ts` انجام می‌شود:

- `rialFromTomanInput`: فقط عدد صحیح.
- `rialFromExactTomanInput` و `rialFromToman`: یک رقم اعشار، یعنی همان ریال.

درصد (سقف درصدی مجوز، کارمزد پایانه) و تعداد پول نیستند. به این مرزها نمی‌روند و `AmountInput` نمی‌گیرند.

**نگهبان:** `apps/web/test/amount-input-coverage.test.ts`. هر `<input value={x}>` که `x` آن به یکی از سه مرز بالا داده شود، رد می‌شود.
- کنترل منفی: همین نگهبان روی نسخهٔ main سه کادر اینستاگرام را گرفت.
- محدودیت: اگر متن کادر با نام دیگری به تابع کمکی برسد، این نگهبان ایستا آن را نمی‌بیند.

## ورودی‌های پولی (۲۳ کادر)

| صفحه / مؤلفه | کادر | مرز تبدیل | مؤلفه | وضعیت |
|---|---|---|---|---|
| `pos/PaymentSelector` | مبلغ پرداخت (تومان) | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Pos` | موجودی اولیهٔ شیفت | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Pos` | پول شمرده‌شده در کشو | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Pos` | قیمت واحد دستی | `rialFromTomanInput` | AmountInput | پوشش داشت؛ صحیح، یادداشت ۱ |
| `Pos` | تخفیف سطر (تومان) | `rialFromTomanInput` | AmountInput | پوشش داشت؛ صحیح، یادداشت ۱ |
| `Returns` | مبلغ بازپرداخت | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Treasury` | مبلغ حرکت نقد / خزانه | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Catalog` | قیمت فروش | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Purchasing` | قیمت خرید سطر | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Purchasing` | مبلغ هزینهٔ رسید | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `ReceiptBulkAdd` | قیمت خرید گروهی | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `PurchaseOrder` | قیمت توافقی | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Opening` | مانده‌های افتتاحیه | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Customers` | سقف اعتبار | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `Permissions` | سقف مبلغی مجوز | `rialFromTomanInput` | AmountInput | پوشش داشت |
| `SettingKeys` | تنظیم از نوع `money` | سرور (`set_setting`) | AmountInput | پوشش داشت |
| `MyWithdrawals` | مبلغ برداشت | `lib/withdrawals` | AmountInput | پوشش داشت |
| `WithdrawalLog` | مبلغ درست (اصلاح) | `rialFromExactTomanInput` | AmountInput | پوشش داشت |
| `BonusLog` | مبلغ پاداش | `lib/withdrawals` | AmountInput | پوشش داشت |
| `MyBonuses` | مبلغ پاداش | `lib/withdrawals` | AmountInput | پوشش داشت |
| `InstagramOrders` | کرایهٔ دریافتی، فرم سفارش تازه | `rialFromToman` | **AmountInput** | **اصلاح شد**: پیش‌تر `<input>` ساده بود |
| `InstagramOrders` | کرایهٔ دریافتی، ویرایش سرآیند | `rialFromToman` | **AmountInput** | **اصلاح شد** |
| `InstagramOrders` | مبلغ واریز در تأیید | `rialFromToman` | **AmountInput** | **اصلاح شد** |

`screens/dev/UiKit.tsx` فقط نمونهٔ Build آزمون است و در شمار بالا نیست.

### کادرهای عددی‌ای که پول نیستند و عمداً `AmountInput` نمی‌گیرند

- تعدادها: صندوق، رسید، سفارش خرید، انبارگردانی، انتقال، تعویض، لیبل.
- درصد: سقف درصدی مجوز، کارمزد پایانه.
- روز تسویه، کد حساب، سال افتتاحیه.
- میلی‌متر لیبل، تاریخ‌ها، موبایل، کد پستی، OTP و PIN.

## نمایش پول

| ابزار | رفتار | جاها |
|---|---|---|
| `<Money rial exact>` | ریال باقی‌مانده را به‌شکل اعشار تومان نشان می‌دهد | مبلغ‌های اینستاگرام، چک و دریافتنی داشبورد، صندوق، … |
| `<Money rial>` (بی `exact`) | تومان صحیح؛ ریال باقی‌مانده در **نمایش** دیده نمی‌شود | `<Money>` روی هم ۱۲۶ کاربرد در ۲۶ فایل دارد (شمارش خطی، بی UI Kit). ۶۲ کاربرد در ۱۲ فایل `exact` دارند؛ بقیه بی `exact`اند |
| `toman(rial)` | تومان صحیح با جداکنندهٔ هزارگان | ۵۵ جا در ۱۴ فایل (فهرست‌ها و جدول‌های خرید، انبار و فاکتور) |

**یادداشت ۱:** دو کادر صندوق، «قیمت واحد دستی» و «تخفیف سطر»، با `toman()` پیش‌پر می‌شوند و پارسر صحیح دارند. این تصمیم ثبت‌شده است: «POS integer-only parser remains unchanged» در `lib/money.ts`.
- اگر مبلغ فعلی سطر ریالِ باقی‌مانده داشته باشد (مثلاً از گرد کردن تخفیف درصدی)، مقدار پیش‌پرشده تا تومان صحیح بریده می‌شود.
- ثبت دوبارهٔ همان مقدار، مبلغ را تا ۹ ریال تغییر می‌دهد.
- این PR آن را عوض نمی‌کند، چون رفتار مالی صندوق است و تصمیم مالک لازم دارد. گزینهٔ پیشنهادی: همان `rialFromExactTomanInput` که در اصلاح برداشت به کار رفته.

**یادداشت ۲:** نمایش تومان صحیح در جدول‌ها قرارداد نمایش است، نه تغییر داده. ریال در دفتر و API دست‌نخورده می‌ماند.
- جاهایی که باید یک ریال هم دیده شود (مبلغ قابل واریز، واریز، دریافت و پرداخت داشبورد) از `exact` استفاده می‌کنند.
- اینکه فهرست فاکتورها یا خرید هم باید دقیق شوند، تصمیم نمایش است و جدا ثبت شده است.
