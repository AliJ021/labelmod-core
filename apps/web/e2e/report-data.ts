/**
 * دادهٔ ساختگی گزارش‌ها برای آزمون مرورگر — شکل همان پاسخ API (`lib/reports.ts`).
 * همهٔ مبالغ رشتهٔ ریالی‌اند؛ هیچ عددی از دادهٔ واقعی نیست.
 */
const d1 = "2026-09-10", d2 = "2026-09-11";
export const REPORT_DATA: Record<string, unknown> = {
  "GET /reports/sales": { rows: [
    { businessDate: d1, channel: "pos", invoiceCount: 14, grossAmount: "48250000", discountAmount: "1250000", netAmount: "47000000", returnCount: 1, returnAmount: "2300000", cogsAmount: "29100000", profitAmount: "15600000" },
    { businessDate: d1, channel: "web", invoiceCount: 3, grossAmount: "9900000", discountAmount: "0", netAmount: "9900000", returnCount: 0, returnAmount: "0", cogsAmount: "6100000", profitAmount: "3800000" },
    { businessDate: d2, channel: "pos", invoiceCount: 9, grossAmount: "31200000", discountAmount: "700000", netAmount: "30500000", returnCount: 0, returnAmount: "0", cogsAmount: "19800000", profitAmount: "10700000" },
  ] },
  "GET /reports/profit-by-product": { rows: [
    { variationId: "v1", sku: "TR-1405-NAVY-XL", productName: "شلوار پارچه‌ای رگولار", color: "سرمه‌ای", size: "XL", qtySold: "6", qtyReturned: "1", netAmount: "11700000", cogsAmount: "7200000", profitAmount: "4500000", marginPercent: 38.5 },
    { variationId: "v2", sku: "SH-2210-WHT-M", productName: "پیراهن آستین‌بلند نخی", color: "سفید", size: "M", qtySold: "4", qtyReturned: "0", netAmount: "6400000", cogsAmount: "7000000", profitAmount: "-600000", marginPercent: -9.4 },
  ] },
  "GET /reports/trial-balance": { rows: [
    { code: "1101", name: "صندوق", accountType: "asset", openingBalance: "50000000", debit: "56900000", credit: "2300000", closingBalance: "104600000" },
    { code: "1301", name: "موجودی کالا", accountType: "asset", openingBalance: "820000000", debit: "0", credit: "55000000", closingBalance: "765000000" },
    { code: "4101", name: "فروش کالا", accountType: "revenue", openingBalance: "0", debit: "2300000", credit: "56900000", closingBalance: "-54600000" },
    { code: "5101", name: "بهای تمام‌شده", accountType: "expense", openingBalance: "0", debit: "55000000", credit: "0", closingBalance: "55000000" },
  ] },
  "GET /reports/cash-reconciliation": { rows: [
    { shiftId: "s1", branchName: "شعبه آزمایشی", userName: "صندوق‌دار آزمایشی", openedAt: "2026-09-10T05:30:00Z", closedAt: "2026-09-10T17:30:00Z", openingCash: "5000000", cashSales: "21000000", cashRefunds: "2300000", cashIn: "0", cashOut: "400000", expectedCash: "23300000", countedCash: "23250000", variance: "-50000", status: "closed" },
    { shiftId: "s2", branchName: "شعبه آزمایشی", userName: "صندوق‌دار دوم", openedAt: "2026-09-11T05:30:00Z", closedAt: null, openingCash: "5000000", cashSales: "8000000", cashRefunds: "0", cashIn: "0", cashOut: "0", expectedCash: null, countedCash: null, variance: null, status: "open" },
  ] },
  "GET /reports/compare": { rows: [
    { channel: "pos", invoiceCount: 23, netAmount: "77500000", profitAmount: "26300000", prevInvoiceCount: 19, prevNetAmount: "64100000", prevProfitAmount: "20000000", deltaAmount: "13400000", deltaPercent: 20.9, direction: "up" },
    { channel: "web", invoiceCount: 3, netAmount: "9900000", profitAmount: "3800000", prevInvoiceCount: 5, prevNetAmount: "12800000", prevProfitAmount: "4100000", deltaAmount: "-2900000", deltaPercent: -22.7, direction: "down" },
  ] },
  "GET /reports/hourly": { rows: [
    { businessDate: d1, hourOfDay: 10, channel: "pos", invoiceCount: 2, itemQty: "3", netAmount: "6200000" },
    { businessDate: d1, hourOfDay: 12, channel: "pos", invoiceCount: 4, itemQty: "6", netAmount: "14800000" },
    { businessDate: d1, hourOfDay: 18, channel: "pos", invoiceCount: 6, itemQty: "9", netAmount: "21000000" },
    { businessDate: d1, hourOfDay: 18, channel: "web", invoiceCount: 1, itemQty: "1", netAmount: "3300000" },
    { businessDate: d2, hourOfDay: 20, channel: "pos", invoiceCount: 3, itemQty: "4", netAmount: "9500000" },
  ] },
  "GET /reports/basket": { rows: [
    { businessDate: d1, channel: "pos", invoiceCount: 14, knownCustomers: 9, anonymousCount: 5, itemQty: "21", lineCount: 19, netAmount: "47000000", qtyPerInvoice: "1.5" },
  ] },
  "GET /reports/customer-basket": { rows: [
    { customerId: "c1", fullName: "مشتری آزمایشی با نام بلند", mobile: "09120000000", invoiceCount: 3, itemQty: "5", netAmount: "15400000", lastPurchase: d2 },
  ] },
};
