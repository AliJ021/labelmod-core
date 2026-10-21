/**
 * «سفارش‌های سایت» — قرارداد `GET /web/orders` و `GET /web/orders/:id` (فقط‌خواندنی، قرارداد ۲ افزونه).
 *
 * پاسخ یا `ready` است، یا `unavailable` با دلیل (هرگز «فهرست خالی» به‌جای «نامعلوم»)، یا برای جزئیات
 * `not_found`.
 *
 * پول: هر مبلغ `{ amount, rial }` است. `amount` عدد دقیق ذخیره‌شده در ووکامرس با ارز خودِ سفارش است و
 * `rial` فقط وقتی Core تبدیل دقیق داشته (IRR و IRT). دلار یا ارز ناشناخته با مبلغ و کد خودش نشان داده
 * می‌شود و هرگز «ریال» خوانده نمی‌شود.
 *
 * وضعیت سفارش از خود سایت می‌آید (وضعیت‌های افزونه‌ای هم)؛ اینجا فقط اسلاگ سنجیده می‌شود و برچسب از پاسخ
 * است. فهرست بسته‌ای از وضعیت‌ها در مرورگر نیست، وگرنه وضعیت ثبت‌شدهٔ سفارشی دیده نمی‌شد.
 */
import { api, type RequestOptions } from "./api.ts";
import type { StatusState } from "./status.ts";

/** همان الگوی Core و افزونه. */
export const STATUS_SLUG = /^[a-z0-9_-]{1,40}$/;
export const PAYMENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const ORDERS_PAGE_MAX = 100_000;
export const isStatusSlug = (v: string) => STATUS_SLUG.test(v);
export const isPaymentId = (v: string) => PAYMENT_ID.test(v);

/** حالت معنایی وضعیت‌های هسته‌ای ووکامرس؛ وضعیت افزونه‌ای معنایش را این برنامه نمی‌داند. */
const CORE_STATUS_STATE: Record<string, StatusState> = {
  pending: "pending", processing: "active", "on-hold": "warning", completed: "completed",
  cancelled: "cancelled", refunded: "archived", failed: "failed", "checkout-draft": "draft",
};
export const orderStatusState = (slug: string): StatusState => CORE_STATUS_STATE[slug] ?? "unknown";

export interface WooMoney { amount: string | null; rial: string | null }
export interface OrderCore {
  paymentConfirmed: boolean; recorded: boolean; invoiceNumber: string | null;
  attempts: number; hasError: boolean; stopped: boolean;
}
export interface OrderSummary {
  id: number; number: string; status: string; statusLabel: string; createdAt: string | null;
  currency: string; total: WooMoney; itemCount: number; customerName: string; customerType: "guest" | "registered";
  paymentMethodId: string; paymentMethod: string; core: OrderCore;
}
export interface Address {
  firstName: string; lastName: string; company: string; address1: string; address2: string;
  city: string; state: string; postcode: string; country: string; phone: string;
}
export interface OrderItem {
  id: number; name: string; sku: string; quantity: number; attributes: { key: string; value: string }[];
  subtotal: WooMoney; subtotalTax: WooMoney; total: WooMoney; tax: WooMoney; discount: WooMoney;
  productExists: boolean; mapped: boolean;
}
export interface OrderNote { id: number; createdAt: string | null; content: string; customerNote: boolean; addedBy: string }
export interface OrderDetail extends OrderSummary {
  core: OrderCore & { scheduled: boolean; missingSku: number; missingMapping: number };
  billing: Address & { email: string }; shipping: Address; customerNote: string;
  payment: { methodId: string; method: string; transactionId: string; paidAt: string | null };
  totals: Record<"subtotal" | "discount" | "discountTax" | "shipping" | "shippingTax" | "tax" | "total" | "refunded", WooMoney>;
  items: { page: number; perPage: number; total: number; rows: OrderItem[] };
  fees: { name: string; total: WooMoney; tax: WooMoney }[];
  shippingLines: { method: string; total: WooMoney; tax: WooMoney }[];
  coupons: { code: string; discount: WooMoney; discountTax: WooMoney }[];
  refunds: { id: number; createdAt: string | null; amount: WooMoney; reason: string }[];
  refundsTruncated: boolean;
  notes: { page: number; perPage: number; hasMore: boolean; rows: OrderNote[] };
}
type Unavailable = { state: "unavailable"; code: string; message: string; fetchedAt: string };
export type OrdersPage =
  | { state: "ready"; page: number; perPage: number; until: number; total: number; pages: number;
      statuses: { slug: string; label: string }[]; paymentMethods: { id: string; title: string }[];
      orders: OrderSummary[]; fetchedAt: string }
  | Unavailable;
export type OrderView = { state: "ready"; order: OrderDetail; fetchedAt: string } | { state: "not_found"; fetchedAt: string } | Unavailable;

export interface OrdersQuery {
  page: number; status: string | null; search: string | null; from: string | null; to: string | null;
  payment: string | null; until: number | null;
}

/** نشانی درخواست فهرست؛ فیلتر خالی فرستاده نمی‌شود. */
export function ordersPath(q: OrdersQuery): string {
  const p = new URLSearchParams({ page: String(q.page) });
  if (q.status) p.set("status", q.status);
  if (q.search) p.set("q", q.search);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.payment) p.set("payment", q.payment);
  if (q.until !== null) p.set("until", String(q.until));
  return `/web/orders?${p.toString()}`;
}

export function orderPath(id: number, itemsPage: number, notesPage: number): string {
  const p = new URLSearchParams();
  if (itemsPage !== 1) p.set("items", String(itemsPage));
  if (notesPage !== 1) p.set("notes", String(notesPage));
  const s = p.toString();
  return `/web/orders/${id}${s ? `?${s}` : ""}`;
}

export const siteOrders = {
  list: (q: OrdersQuery, opts?: RequestOptions) => api.get<OrdersPage>(ordersPath(q), opts),
  get: (id: number, itemsPage: number, notesPage: number, opts?: RequestOptions) =>
    api.get<OrderView>(orderPath(id, itemsPage, notesPage), opts),
};

/** مبلغ برای نمایش: ریالِ دقیق، یا مبلغ اصلی با کد ارزش، یا نامعلوم. هیچ‌وقت حدس تبدیل. */
export function moneyView(m: WooMoney, currency: string):
  | { kind: "rial"; rial: string } | { kind: "foreign"; amount: string; currency: string } | { kind: "unknown" } {
  if (m.rial !== null) return { kind: "rial", rial: m.rial };
  if (m.amount !== null) return { kind: "foreign", amount: m.amount, currency: currency || "ارز نامعلوم" };
  return { kind: "unknown" };
}

/** نشانی چندسطری برای نمایش؛ میدان خالی حذف می‌شود و نشانی کاملاً خالی `[]` است. */
export function addressLines(a: Address): string[] {
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ");
  const place = [a.city, a.state, a.postcode].filter(Boolean).join("، ");
  return [name, a.company, a.address1, a.address2, place, a.country].filter(v => v !== "");
}

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
