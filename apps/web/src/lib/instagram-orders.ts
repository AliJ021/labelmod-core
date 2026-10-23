/**
 * «سفارش اینستاگرام» — قرارداد `/instagram-orders` (docs/INSTAGRAM-ORDERS.md).
 *
 * سه محور وضعیت جدا نگه داشته می‌شوند و هیچ‌کدام از دیگری حدس زده نمی‌شود:
 * سفارش (پیش‌نویس، رزرو، منقضی، نهایی، لغو)، واریز (هیچ، ادعاشده، نیازمند رسیدگی، تأییدشده)
 * و ارسال. پول رشتهٔ ریالی است؛ تبدیل فقط در `Money`.
 *
 * - جست‌وجو با بدنهٔ POST است و در نشانی صفحه یا درخواست نمی‌نشیند (موبایل و نام کاربری مشتری).
 * - تأیید واریز کلید یکتای خودش را دارد و نسخهٔ دیده‌شدهٔ سفارش را می‌فرستد: اگر سبد یا قیمت پس از
 *   دیدن عوض شده باشد، سرور ۴۰۹ `stale_version` می‌دهد، نه تأییدِ مبلغی که اپراتور ندیده.
 */
import { api, type RequestOptions } from "./api.ts";
import type { StatusState } from "./status.ts";
import { normalizeDigits } from "./settings-value.ts";

export type OrderStatus = "draft" | "reserved" | "expired" | "confirming" | "finalized" | "cancelled";
export type PaymentState = "none" | "claimed" | "review" | "confirmed";
export type ShippingState = "not_started" | "packing" | "ready" | "shipped" | "delivered";
export type SyncState = "off" | "not_site_warehouse" | "none" | "queued" | "sent" | "error" | "unknown";

export const ORDER_STATUS: Record<OrderStatus, { label: string; state: StatusState }> = {
  draft: { label: "پیش‌نویس", state: "draft" },
  reserved: { label: "رزرو شده", state: "pending" },
  expired: { label: "رزرو منقضی", state: "warning" },
  confirming: { label: "در حال تأیید", state: "active" },
  finalized: { label: "نهایی (فروش ثبت شد)", state: "completed" },
  cancelled: { label: "لغو شده", state: "cancelled" },
};
export const PAYMENT_STATE: Record<PaymentState, { label: string; state: StatusState }> = {
  none: { label: "واریزی ثبت نشده", state: "draft" },
  claimed: { label: "مشتری می‌گوید واریز کرده", state: "attention" },
  review: { label: "نیازمند رسیدگی", state: "warning" },
  confirmed: { label: "واریز تطبیق و تأیید شد", state: "completed" },
};
/** وضعیت ناشناختهٔ سرور (نسخهٔ تازه‌تر) با نام خودش و «نامعلوم» نشان داده می‌شود، نه خطای صفحه. */
export function statusView<K extends string>(map: Record<K, { label: string; state: StatusState }>, key: string): { label: string; state: StatusState } {
  return (map as Record<string, { label: string; state: StatusState } | undefined>)[key] ?? { label: key, state: "unknown" };
}
export const SHIPPING_STATE: Record<ShippingState, string> = {
  not_started: "شروع نشده", packing: "در حال بسته‌بندی", ready: "آمادهٔ ارسال", shipped: "ارسال شد", delivered: "تحویل شد",
};
export const SHIPPING_ORDER: ShippingState[] = ["not_started", "packing", "ready", "shipped", "delivered"];

/** Push موجودی هر کالا به سایت — صادقانه؛ «نامعلوم» هرگز «سالم» خوانده نمی‌شود. */
export function syncView(s: { state: SyncState; at: string | null; error: string | null }): { state: StatusState; label: string } {
  switch (s.state) {
    case "off": return { state: "archived", label: "ارسال موجودی به سایت خاموش است" };
    case "not_site_warehouse": return { state: "archived", label: "این انبار موجودی سایت نیست" };
    case "none": return { state: "unknown", label: "هنوز پیامی برای سایت ساخته نشده" };
    case "queued": return { state: "pending", label: "در صف ارسال به سایت" };
    case "sent": return { state: "completed", label: "سایت پذیرفت" };
    case "error": return { state: "failed", label: "ارسال به سایت ناموفق" };
    default: return { state: "unknown", label: "وضعیت همگام‌سازی خوانده نشد" };
  }
}

export interface OrderSummary {
  id: string; orderNo: string; status: OrderStatus; paymentState: PaymentState; shippingState: ShippingState;
  instagramUsername: string | null; customerName: string | null; mobile: string | null;
  payable: string; reservedUntil: string | null; createdAt: string; branchId: string;
}
export interface OrderLine {
  id: string; variationId: string; sku: string; product: string; color: string | null; size: string | null;
  qty: number; unitPrice: string; discountAmount: string; netAmount: string; available: string;
  sync: { state: SyncState; at: string | null; error: string | null };
}
export interface OrderDetail {
  id: string; orderNo: string; status: OrderStatus; paymentState: PaymentState; paymentNote: string | null;
  shippingState: ShippingState; trackingCode: string | null; version: number; reservedUntil: string | null;
  cancelReason: string | null; createdAt: string; updatedAt: string;
  branch: { id: string; name: string }; warehouse: { id: string; name: string };
  customer: { id: string; name: string | null; mobile: string | null; instagramUsername: string | null };
  shipping: { address: string; method: string };
  receivingAccount: { id: string; name: string | null } | null;
  invoice: { id: string; number: string | null; status: string; gross: string; discount: string; shipping: string; payable: string };
  lines: OrderLine[];
  holds: { variationId: string; qty: string; expiresAt: string }[];
  payment: { accountId: string; accountName: string; amount: string; refNo: string; paidAt: string;
             verifiedBy: string | null; verifiedAt: string; paymentId: string | null } | null;
  returns: { id: string; number: string | null; status: string; kind: string; refundAmount: string }[];
  similarOpen: { id: string; orderNo: string; status: OrderStatus; createdAt: string }[];
  replayed?: boolean;
}
export interface OrdersPage { page: number; perPage: number; total: number; pages: number; orders: OrderSummary[] }
export interface ReceivingAccount { id: string; code: string; name: string; bankName: string | null; accountNo: string | null }

/** کدام کار در کدام وضعیت — همان قاعده‌ای که سرور اجبار می‌کند؛ اینجا فقط برای پنهان‌کردن دکمهٔ بی‌اثر. */
export function actionsFor(d: Pick<OrderDetail, "status" | "paymentState" | "lines" | "shippingState">): {
  editCart: boolean; reserve: boolean; unreserve: boolean; cancel: boolean; markPayment: boolean; confirm: boolean; ship: boolean;
} {
  const inReview = d.paymentState === "claimed" || d.paymentState === "review";
  return {
    editCart: d.status === "draft",
    reserve: (d.status === "draft" || d.status === "expired") && d.lines.length > 0,
    unreserve: (d.status === "reserved" || d.status === "expired") && !inReview,
    cancel: (d.status === "draft" || d.status === "reserved" || d.status === "expired") && !inReview,
    markPayment: d.status === "draft" || d.status === "reserved" || d.status === "expired",
    confirm: d.status === "reserved" || d.status === "expired",
    ship: d.status === "finalized" && d.shippingState !== "delivered",
  };
}

/** وضعیت ارسالِ بعدی (فقط رو به جلو)؛ تهی یعنی پایان. */
export function nextShipping(s: ShippingState): ShippingState | null {
  const i = SHIPPING_ORDER.indexOf(s);
  return i >= 0 && i < SHIPPING_ORDER.length - 1 ? SHIPPING_ORDER[i + 1]! : null;
}

/** نام کاربری اینستاگرام همان قاعدهٔ سرور: «@» و حروف بزرگ برداشته؛ خالی یعنی ندارد. */
export function normalizeUsername(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const v = raw.trim().replace(/^@+/, "").toLowerCase();
  if (v === "") return { ok: true, value: null };
  return /^[a-z0-9._]{1,30}$/.test(v) ? { ok: true, value: v }
    : { ok: false, message: "فقط حروف انگلیسی، عدد، نقطه و زیرخط (حداکثر ۳۰)." };
}

/** ریال از ورودی تومانیِ کاربر (رقم فارسی و جداکننده پذیرفته)؛ تهی یعنی نامعتبر. */
export function rialFromToman(input: string): string | null {
  const d = normalizeDigits(input).replace(/[,\s٬]/g, "");
  if (!/^\d{1,15}$/.test(d)) return null;
  return (BigInt(d) * 10n).toString();
}

/** تعداد سطر: عدد صحیح ۱ تا ۹۹۹ با رقم فارسی یا لاتین؛ اعشار و صفر تهی‌اند (قاعدهٔ سرور: پوشاک تکه‌ای است). */
export function parseQty(input: string): number | null {
  const d = normalizeDigits(input).trim();
  return /^[1-9]\d{0,2}$/.test(d) ? Number(d) : null;
}

/**
 * سنجش فرم تأیید واریز پیش از ارسال — همان قواعد سرور برای پیام فوری:
 * مبلغ دقیقاً برابر مبلغ کامل سفارش، مرجع لازم، زمان واریز نه در آینده.
 */
export function checkConfirm(input: { payable: string; amountRial: string | null; refNo: string; accountId: string; paidAt: Date | null; now: Date }):
  { ok: true } | { ok: false; field: "amount" | "ref" | "account" | "paidAt"; message: string } {
  if (!input.accountId) return { ok: false, field: "account", message: "حساب مقصد واریز را انتخاب کنید." };
  if (input.amountRial === null) return { ok: false, field: "amount", message: "مبلغ واریز را به تومان وارد کنید." };
  if (BigInt(input.amountRial) !== BigInt(input.payable)) {
    return { ok: false, field: "amount", message: "مبلغ واریز باید دقیقاً برابر مبلغ کامل سفارش و کرایه باشد. واریز ناقص یا اضافه را «نیازمند رسیدگی» علامت بزنید." };
  }
  if (input.refNo.trim() === "") return { ok: false, field: "ref", message: "شمارهٔ پیگیری واریز از صورت‌حساب بانک لازم است." };
  if (!input.paidAt || Number.isNaN(input.paidAt.getTime())) return { ok: false, field: "paidAt", message: "زمان واریز را وارد کنید." };
  if (input.paidAt.getTime() > input.now.getTime() + 5 * 60_000) return { ok: false, field: "paidAt", message: "زمان واریز در آینده است." };
  return { ok: true };
}

export const instagramOrders = {
  list: (q: { status: OrderStatus | null; attention: boolean; page: number }, opts?: RequestOptions) => {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.attention) p.set("attention", "1");
    if (q.page !== 1) p.set("page", String(q.page));
    const s = p.toString();
    return api.get<OrdersPage>(`/instagram-orders${s ? `?${s}` : ""}`, opts);
  },
  search: (q: string, opts?: RequestOptions) => api.post<OrdersPage>("/instagram-orders/search", { q }, opts),
  get: (id: string, opts?: RequestOptions) => api.get<OrderDetail>(`/instagram-orders/${id}`, opts),
  accounts: (branchId: string, opts?: RequestOptions) =>
    api.get<{ accounts: ReceivingAccount[] }>(`/instagram-orders/accounts?branchId=${branchId}`, opts),
  create: (body: Record<string, unknown>, key: string) => api.post<OrderDetail>("/instagram-orders", body, { idempotencyKey: key }),
  update: (id: string, body: Record<string, unknown>) => api.patch<OrderDetail>(`/instagram-orders/${id}`, body),
  addLine: (id: string, body: { variationId: string; qty: number; discountAmount?: string; discountReason?: string }) =>
    api.post<OrderDetail>(`/instagram-orders/${id}/lines`, body),
  setQty: (id: string, lineId: string, qty: number) => api.patch<OrderDetail>(`/instagram-orders/${id}/lines/${lineId}`, { qty }),
  removeLine: (id: string, lineId: string) => api.del<OrderDetail>(`/instagram-orders/${id}/lines/${lineId}`),
  reserve: (id: string) => api.post<OrderDetail>(`/instagram-orders/${id}/reserve`, {}),
  unreserve: (id: string) => api.post<OrderDetail>(`/instagram-orders/${id}/unreserve`, {}),
  cancel: (id: string, reason: string) => api.post<OrderDetail>(`/instagram-orders/${id}/cancel`, { reason }),
  markPayment: (id: string, state: "none" | "claimed" | "review", note: string | null) =>
    api.post<OrderDetail>(`/instagram-orders/${id}/payment-state`, { state, note }),
  shipping: (id: string, state: ShippingState, trackingCode: string | null) =>
    api.post<OrderDetail>(`/instagram-orders/${id}/shipping`, { state, trackingCode }),
  confirm: (id: string, body: { version: number; accountId: string; amount: string; refNo: string; paidAt: string }, key: string) =>
    api.post<OrderDetail>(`/instagram-orders/${id}/confirm`, body, { idempotencyKey: key }),
};
