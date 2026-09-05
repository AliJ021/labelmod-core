/**
 * لایه داده گزارش‌ها — تایپ‌ها و تماس‌ها، بدون منطق UI.
 *
 * ── سه چیزی که این لایه نگه می‌دارد ────────────────────────────────
 *
 * **پول رشته است.** هر مبلغی `string` است. تنها عدد واقعی
 * `marginPercent` است — یک درصد، نه یک مبلغ.
 *
 * **`null` یعنی «اجازه دیدنش را نداری»، نه صفر.** ستون‌های بها و سود
 * برای کاربری که `cost.view` ندارد `null` برمی‌گردند. صفحه باید «—»
 * نشان بدهد، نه «۰» — صفر یک ادعای مالی است.
 *
 * **شعبه را کلاینت تحمیل نمی‌کند.** `branchId` اختیاری است؛ اگر
 * نفرستیم، سرور خودش شعبه کاربر را می‌گذارد. برای کاربری که به چند
 * شعبه دسترسی دارد، سرور ۴۲۲ «شعبه را مشخص کنید» می‌دهد.
 */
import { api } from "./api.ts";

export interface SalesRow {
  businessDate: string;
  channel: string;
  invoiceCount: number;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  returnCount: number;
  returnAmount: string;
  /** `null` یعنی `cost.view` ندارد — نه اینکه بها صفر بوده. */
  cogsAmount: string | null;
  profitAmount: string | null;
}

export interface ProfitRow {
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  qtySold: string;
  qtyReturned: string;
  netAmount: string;
  cogsAmount: string;
  profitAmount: string;
  /** `null` یعنی فروش خالص صفر شده؛ درصد بی‌معناست. */
  marginPercent: number | null;
}

export interface ValuationRow {
  warehouseId: string;
  warehouseName: string;
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  onHand: string;
  totalValue: string;
  unitCost: string | null;
}

export interface MovementRow {
  occurredAt: string;
  warehouseName: string;
  kind: string;
  qty: string;
  unitCost: string | null;
  valueDelta: string | null;
  runningQty: string;
  refType: string | null;
  refId: string | null;
  note: string | null;
}

export interface LedgerRow {
  entryDate: string;
  entryNumber: string;
  description: string | null;
  partyName: string | null;
  debit: string;
  credit: string;
  running: string;
}

export interface TrialRow {
  code: string;
  name: string;
  accountType: string;
  openingBalance: string;
  debit: string;
  credit: string;
  closingBalance: string;
}

export interface PartyRow {
  partyType: string;
  partyId: string;
  partyName: string | null;
  code: string;
  parentName: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface ShiftRow {
  shiftId: string;
  branchName: string;
  userName: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  cashSales: string;
  cashRefunds: string;
  cashIn: string;
  cashOut: string;
  /** شیفت باز هنوز شمرده نشده — `null` است، نه صفر. */
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  status: string;
}

export interface Period {
  from: string;
  to: string;
  branchId?: string | undefined;
}

/** حرکت انبار — برچسب فارسی، چون `kind` یک کد است. */
export const MOVEMENT_KIND: Record<string, string> = {
  purchase_receipt: "رسید خرید",
  purchase_return: "برگشت از خرید",
  sale: "فروش",
  sale_return: "مرجوعی فروش",
  transfer_in: "انتقال ورودی",
  transfer_out: "انتقال خروجی",
  adjustment: "تعدیل",
  stock_count: "انبارگردانی",
  revaluation: "تجدید ارزیابی",
  opening: "افتتاحیه",
};

export const CHANNEL_LABEL: Record<string, string> = {
  pos: "صندوق",
  web: "سایت",
  phone: "تلفنی",
};

export const PARTY_LABEL: Record<string, string> = {
  customer: "مشتری",
  supplier: "تأمین‌کننده",
};

function qs(p: Period, extra: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams({ from: p.from, to: p.to });
  if (p.branchId) q.set("branchId", p.branchId);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

export const reports = {
  sales: (p: Period) => api.get<{ rows: SalesRow[] }>(`/reports/sales?${qs(p)}`),

  profitByProduct: (p: Period, limit = 50) =>
    api.get<{ rows: ProfitRow[] }>(`/reports/profit-by-product?${qs(p, { limit })}`),

  valuation: (warehouseId?: string) =>
    api.get<{ rows: ValuationRow[] }>(
      `/reports/inventory-valuation${warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : ""}`,
    ),

  movements: (p: Period, variationId: string, warehouseId?: string) =>
    api.get<{ rows: MovementRow[] }>(
      `/reports/stock-movements?${qs(p, { variationId, warehouseId })}`,
    ),

  accountLedger: (p: Period, code: string) =>
    api.get<{ rows: LedgerRow[] }>(`/reports/account-ledger?${qs(p, { code })}`),

  trialBalance: (p: Period) =>
    api.get<{ rows: TrialRow[] }>(`/reports/trial-balance?${qs(p)}`),

  partyBalances: (partyType?: string) =>
    api.get<{ rows: PartyRow[] }>(
      `/reports/party-balances${partyType ? `?partyType=${encodeURIComponent(partyType)}` : ""}`,
    ),

  cashReconciliation: (p: Period) =>
    api.get<{ rows: ShiftRow[] }>(`/reports/cash-reconciliation?${qs(p)}`),
};

/**
 * بازه پیش‌فرض: از اول همین ماه میلادی تا امروز.
 *
 * ⚠️ «امروز» **از سرور** می‌آید، نه از `new Date()` مرورگر. تبلتی که
 *    ساعتش عقب باشد، بازه‌ای می‌ساخت که فروش امروز را نداشت — و
 *    گزارشِ ناقص از گزارشِ نبوده بدتر است.
 *
 * تقویم شمسی نیست و عمداً: بازه‌ها به سرور به‌شکل ISO می‌روند و
 * `platform.business_date()` مرجع است. نمایش شمسی کار لایه نمایش
 * است و امروز هیچ‌جای این پروژه تبدیل تقویم ندارد.
 */
export function defaultPeriod(today: string): { from: string; to: string } {
  const from = `${today.slice(0, 7)}-01`;
  return { from, to: today };
}
