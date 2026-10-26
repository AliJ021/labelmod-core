/**
 * کارهای عملیاتی داشبورد (دستهٔ D) — قرارداد `GET /dashboard/operations`.
 *
 * هر بخش یا `denied` است (این نقش نمی‌بیند؛ پنهان، نه صفر) یا `ready` با شمار دقیق. پول رشته است.
 */
import { api, type RequestOptions } from "./api.ts";

export type Denied = { state: "denied" };
export interface CountAmount { count: number; amount: string }
export interface ChequeCell extends CountAmount { nextDue: string | null }

export interface ShiftsReady {
  state: "ready";
  openCount: number; carriedOverCount: number; closedToday: number; varianceToday: number;
  open: { id: string; userName: string; openedAt: string; carriedOver: boolean }[];
}
export interface ChequesReady {
  state: "ready";
  warningDays: number | null;
  received: { overdue: ChequeCell; dueSoon: ChequeCell };
  issued: { overdue: ChequeCell; dueSoon: ChequeCell };
}
export interface ReceivablesReady { state: "ready"; owed: CountAmount; credit: CountAmount }
/** کمبود موجودی (۱۰۴): شمار دقیق سطرهای (تنوع، انبار) در هر انبار فروش فعال شعبه؛ آستانه رشته است. */
export interface LowStockReady {
  state: "ready"; threshold: string; total: number;
  warehouses: { id: string; name: string; count: number }[];
}
/** آستانه تعریف نشده: شماری خوانده نشده — نه صفر. */
export interface LowStockUnknown { state: "unknown"; reason: string }

export interface DashboardOperations {
  businessDate: string; branchId: string;
  shifts: ShiftsReady | Denied;
  cheques: ChequesReady | Denied;
  receivables: ReceivablesReady | Denied;
  lowStock: LowStockReady | LowStockUnknown | Denied;
}

export const dashboardOperations = {
  read: (branchId: string, opts?: RequestOptions) =>
    api.get<DashboardOperations>(`/dashboard/operations?branchId=${encodeURIComponent(branchId)}`, opts),
};

/** پیوندهای ادامهٔ کار — فقط وقتی مقصد برای این نقش باز است (همان رجیستری ناوبری). */
export const DRILL = {
  shifts: "/?page=reports&reports.tab=cash",
  cheques: "/?page=treasury&treasury.tab=due",
  receivables: "/?page=reports&reports.tab=parties",
} as const;

/** فهرست همان کمبود، برای همان شعبه — شمار کارت و فهرست از یک تعریف می‌آیند. */
export const lowStockLink = (branchId: string) =>
  `/?page=reports&reports.tab=lowstock&reports.branch=${encodeURIComponent(branchId)}`;

/** چکِ سررسیدگذشته (هر جهت) رسیدگی می‌خواهد؛ نزدیک‌به‌سررسید فقط اطلاع است. */
export function chequesNeedAttention(c: ChequesReady): boolean {
  return c.received.overdue.count > 0 || c.issued.overdue.count > 0;
}
