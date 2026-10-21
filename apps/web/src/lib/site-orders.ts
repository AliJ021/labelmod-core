/**
 * «سفارش‌های سایت» — قرارداد `GET /web/orders` و `GET /web/orders/:id` (فقط‌خواندنی).
 *
 * پاسخ یا `ready` است، یا `unavailable` با دلیل (هرگز «فهرست خالی» به‌جای «نامعلوم»)، یا برای جزئیات
 * `not_found`. پول ریالِ رشته‌ای است و «ریالِ دقیق نشد» `null` است، نه صفر.
 */
import { api, type RequestOptions } from "./api.ts";
import type { StatusState } from "./status.ts";

export const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus | "unknown", string> = {
  pending: "در انتظار پرداخت", processing: "در حال انجام", "on-hold": "معلق", completed: "تکمیل‌شده",
  cancelled: "لغوشده", refunded: "مسترد", failed: "ناموفق", unknown: "نامعلوم",
};
const ORDER_STATUS_STATE: Record<OrderStatus | "unknown", StatusState> = {
  pending: "pending", processing: "active", "on-hold": "warning", completed: "completed",
  cancelled: "cancelled", refunded: "archived", failed: "failed", unknown: "unknown",
};
export const orderStatusState = (s: OrderStatus | "unknown"): StatusState => ORDER_STATUS_STATE[s];

export interface OrderCore {
  paymentConfirmed: boolean; recorded: boolean; invoiceNumber: string | null;
  attempts: number; hasError: boolean; stopped: boolean;
}
export interface OrderSummary {
  id: number; number: string; status: OrderStatus | "unknown"; createdAt: string | null;
  totalRial: string | null; itemCount: number; customerName: string; paymentMethod: string; core: OrderCore;
}
export interface OrderDetail extends OrderSummary {
  items: { name: string; sku: string; quantity: number; totalRial: string | null }[];
  itemsTruncated: boolean; shippingRial: string | null; discountRial: string | null;
}
type Unavailable = { state: "unavailable"; code: string; message: string; fetchedAt: string };
export type OrdersPage =
  | { state: "ready"; page: number; perPage: number; status: OrderStatus | null; total: number; pages: number; orders: OrderSummary[]; fetchedAt: string }
  | Unavailable;
export type OrderView = { state: "ready"; order: OrderDetail; fetchedAt: string } | { state: "not_found"; fetchedAt: string } | Unavailable;

export const siteOrders = {
  list: (page: number, status: OrderStatus | null, opts?: RequestOptions) =>
    api.get<OrdersPage>(`/web/orders?page=${page}${status ? `&status=${encodeURIComponent(status)}` : ""}`, opts),
  get: (id: number, opts?: RequestOptions) => api.get<OrderView>(`/web/orders/${id}`, opts),
};

export const isOrderStatus = (v: string): v is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(v);

/**
 * وضعیت ثبت در Core از متای افزونه — یک برچسب، یک حالت.
 * ترتیب مهم است: متوقف و خطا پیش از «در انتظار ثبت» می‌آیند، چون سفارش پرداخت‌شده‌ای که خطا دارد
 * «در انتظار» نیست. سفارش پرداخت‌نشده هیچ‌وقت «ثبت‌نشده = مشکل» گفته نمی‌شود.
 */
export function coreState(core: OrderCore): { state: StatusState; label: string } {
  if (core.recorded) return { state: "completed", label: core.invoiceNumber ? `ثبت در Core: ${core.invoiceNumber}` : "ثبت در Core" };
  if (core.stopped) return { state: "attention", label: "ارسال به Core متوقف شده" };
  if (core.hasError) return { state: "warning", label: `خطا در ارسال به Core (${core.attempts} تلاش)` };
  if (core.paymentConfirmed) return { state: "pending", label: "در انتظار ثبت در Core" };
  return { state: "draft", label: "پرداخت تأیید نشده" };
}
