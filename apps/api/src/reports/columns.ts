/**
 * ستون‌های CSV هر گزارش — **ترتیب و برچسب**، در یک جا.
 *
 * ── چرا اینجا و نه در مسیر ─────────────────────────────────────────
 *
 * اگر هر مسیر ستون‌هایش را خودش می‌نوشت، افزودن یک ستون به گزارش یعنی
 * دو جا عوض شود — و آن که عقب می‌ماند همان خروجی CSV است، چون کسی هر
 * روز بازش نمی‌کند.
 *
 * ── چرا ترتیب صریح است، نه ترتیب کلیدهای شیء ──────────────────────
 *
 * تکیه به ترتیب کلیدها یعنی یک بازآرایی بی‌ربط در `service.ts`
 * ستون‌های فایلی را که حسابدار هر ماه باز می‌کند جابه‌جا کند، بی‌آنکه
 * هیچ تستی قرمز شود.
 *
 * ⚠️ ستون‌های بها و سود در فهرست **می‌مانند** حتی برای کاربری که
 *    `cost.view` ندارد — چون مسیر مقدارشان را `null` کرده و سلول
 *    خالی می‌شود. حذف ستون یعنی دو شکل فایل با یک نام، که مقایسه دو
 *    خروجی را غیرممکن می‌کند.
 */

export type Columns = readonly (readonly [key: string, label: string])[];

export const SALES_COLUMNS: Columns = [
  ["businessDate", "تاریخ"],
  ["channel", "کانال"],
  ["invoiceCount", "تعداد فاکتور"],
  ["grossAmount", "فروش ناخالص (ریال)"],
  ["discountAmount", "تخفیف (ریال)"],
  ["netAmount", "فروش خالص (ریال)"],
  ["returnCount", "تعداد مرجوعی"],
  ["returnAmount", "مبلغ مرجوعی (ریال)"],
  ["cogsAmount", "بهای تمام‌شده (ریال)"],
  ["profitAmount", "سود ناخالص (ریال)"],
];

export const PROFIT_COLUMNS: Columns = [
  ["sku", "SKU"],
  ["productName", "کالا"],
  ["color", "رنگ"],
  ["size", "سایز"],
  ["qtySold", "فروش‌رفته"],
  ["qtyReturned", "برگشتی"],
  ["netAmount", "فروش خالص (ریال)"],
  ["cogsAmount", "بهای تمام‌شده (ریال)"],
  ["profitAmount", "سود (ریال)"],
  ["marginPercent", "حاشیه ٪"],
];

export const VALUATION_COLUMNS: Columns = [
  ["warehouseName", "انبار"],
  ["sku", "SKU"],
  ["productName", "کالا"],
  ["color", "رنگ"],
  ["size", "سایز"],
  ["onHand", "موجودی"],
  ["unitCost", "بهای واحد (ریال)"],
  ["totalValue", "ارزش کل (ریال)"],
];

export const MOVEMENT_COLUMNS: Columns = [
  ["occurredAt", "زمان"],
  ["warehouseName", "انبار"],
  ["kind", "نوع"],
  ["qty", "تعداد"],
  ["runningQty", "مانده"],
  ["unitCost", "بهای واحد (ریال)"],
  ["valueDelta", "تغییر ارزش (ریال)"],
  ["refType", "مرجع"],
  ["note", "یادداشت"],
];

export const LEDGER_COLUMNS: Columns = [
  ["entryDate", "تاریخ"],
  ["entryNumber", "شماره سند"],
  ["description", "شرح"],
  ["partyName", "طرف حساب"],
  ["debit", "بدهکار (ریال)"],
  ["credit", "بستانکار (ریال)"],
  ["running", "مانده (ریال)"],
];

export const TRIAL_COLUMNS: Columns = [
  ["code", "کد حساب"],
  ["name", "نام حساب"],
  ["accountType", "نوع"],
  ["openingBalance", "مانده اول دوره (ریال)"],
  ["debit", "بدهکار (ریال)"],
  ["credit", "بستانکار (ریال)"],
  ["closingBalance", "مانده پایان دوره (ریال)"],
];

export const PARTY_COLUMNS: Columns = [
  ["partyType", "نوع"],
  ["partyName", "نام"],
  ["code", "کد تفصیلی"],
  ["parentName", "سرفصل"],
  ["debit", "بدهکار (ریال)"],
  ["credit", "بستانکار (ریال)"],
  ["balance", "مانده (ریال)"],
];

export const SHIFT_COLUMNS: Columns = [
  ["branchName", "شعبه"],
  ["userName", "صندوق‌دار"],
  ["openedAt", "باز شده"],
  ["closedAt", "بسته شده"],
  ["openingCash", "نقد اول (ریال)"],
  ["cashSales", "فروش نقدی (ریال)"],
  ["cashRefunds", "بازپرداخت نقدی (ریال)"],
  ["cashIn", "دریافت نقد (ریال)"],
  ["cashOut", "پرداخت نقد (ریال)"],
  ["expectedCash", "نقد مورد انتظار (ریال)"],
  ["countedCash", "نقد شمرده‌شده (ریال)"],
  ["variance", "مغایرت (ریال)"],
  ["status", "وضعیت"],
];

export const HOURLY_COLUMNS: Columns = [
  ["businessDate", "تاریخ"],
  ["hourOfDay", "ساعت"],
  ["channel", "کانال"],
  ["invoiceCount", "تعداد فاکتور"],
  ["itemQty", "تعداد قلم"],
  ["netAmount", "فروش خالص (ریال)"],
];

export const COMPARE_COLUMNS: Columns = [
  ["channel", "کانال"],
  ["invoiceCount", "تعداد فاکتور"],
  ["netAmount", "فروش خالص (ریال)"],
  ["profitAmount", "سود ناخالص (ریال)"],
  ["prevInvoiceCount", "تعداد فاکتور دوره مبنا"],
  ["prevNetAmount", "فروش خالص دوره مبنا (ریال)"],
  ["prevProfitAmount", "سود ناخالص دوره مبنا (ریال)"],
  ["deltaAmount", "تفاوت (ریال)"],
  ["deltaPercent", "تفاوت (٪)"],
  ["direction", "جهت"],
];

export const BASKET_COLUMNS: Columns = [
  ["businessDate", "تاریخ"],
  ["channel", "کانال"],
  ["invoiceCount", "تعداد فاکتور"],
  ["knownCustomers", "مشتری شناخته‌شده"],
  ["anonymousCount", "فاکتور بی‌شماره"],
  ["itemQty", "تعداد قلم"],
  ["lineCount", "تعداد سطر"],
  ["netAmount", "فروش خالص (ریال)"],
  ["qtyPerInvoice", "میانگین قلم در فاکتور"],
];

export const CUSTOMER_BASKET_COLUMNS: Columns = [
  ["fullName", "نام"],
  ["mobile", "موبایل"],
  ["invoiceCount", "تعداد فاکتور"],
  ["itemQty", "تعداد قلم"],
  ["netAmount", "مبلغ خرید (ریال)"],
  ["lastPurchase", "آخرین خرید"],
];
