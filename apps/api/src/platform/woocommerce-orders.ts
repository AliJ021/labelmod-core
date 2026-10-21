/**
 * «سفارش‌های سایت» — خواندن فقط‌خواندنی و امضاشده از افزونه (`POST /wp-json/lmc/v1/orders`).
 *
 * همان دروازهٔ تست اتصال (`signedWooPost`): نشانی سنجیده، اتصال پین‌شده، HMAC با Nonce تازه، بی تغییر مسیر.
 * پاسخ با قرارداد سخت سنجیده می‌شود. میدان اضافهٔ افزونه دور ریخته می‌شود و به مرورگر نمی‌رسد.
 *
 * پاسخ فقط وقتی پذیرفته می‌شود که سه چیز با تنظیمات Core یکی باشد:
 * - هویت سایت (مبدأ و مسیر نصب)
 * - شعبهٔ افزونه
 * - انبار افزونه
 *
 * پول ریالِ رشته‌ای است. «ریالِ دقیق نشد» `null` است، نه صفر.
 */
import { z } from "zod";
import { sameWooSite, signedWooPost, type WooCallDeps } from "./woocommerce-diagnostics.ts";

export const WOO_ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;
export type WooOrderStatus = (typeof WOO_ORDER_STATUSES)[number];
export const WOO_ORDERS_PER_PAGE = 20;
export const WOO_ORDERS_PAGE_MAX = 200;

const rial = z.string().regex(/^(?:0|[1-9]\d{0,17})$/).nullable();
const text = (max: number) => z.string().max(max);
const summary = z.object({
  id: z.number().int().positive(),
  number: text(40),
  status: z.enum([...WOO_ORDER_STATUSES, "unknown"]),
  createdAt: z.iso.datetime().nullable(),
  totalRial: rial,
  itemCount: z.number().int().nonnegative(),
  customerName: text(100),
  paymentMethod: text(100),
  core: z.object({
    paymentConfirmed: z.boolean(), recorded: z.boolean(), invoiceNumber: text(40).nullable(),
    attempts: z.number().int().nonnegative(), hasError: z.boolean(), stopped: z.boolean(),
  }),
});
const detail = summary.extend({
  items: z.array(z.object({ name: text(200), sku: text(64), quantity: z.number().int().nonnegative(), totalRial: rial })).max(100),
  itemsTruncated: z.boolean(),
  shippingRial: rial,
  discountRial: rial,
});
const envelope = z.object({
  protocol: z.literal(1), siteUrl: z.string().url().max(500),
  branchId: z.string().max(36), warehouseId: z.string().max(36),
});
const listResponse = envelope.extend({
  page: z.number().int().positive(), perPage: z.number().int().positive(), status: z.enum(WOO_ORDER_STATUSES).nullable(),
  total: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), orders: z.array(summary).max(50),
});
const detailResponse = envelope.extend({ order: detail });

export type WooOrderSummary = z.infer<typeof summary>;
export type WooOrderDetail = z.infer<typeof detail>;
type Unavailable = { state: "unavailable"; code: string; message: string };
export type WooOrdersPage = { state: "ready"; page: number; perPage: number; status: WooOrderStatus | null; total: number; pages: number; orders: WooOrderSummary[] } | Unavailable;
export type WooOrderView = { state: "ready"; order: WooOrderDetail } | { state: "not_found" } | Unavailable;

export interface WooOrdersSite { siteUrl: string; secret: string | undefined; branchId: string; warehouseId: string }

/** فهرست ۵۰ سفارش با نام‌های فارسی حدود ۴۰ کیلوبایت است؛ سقف ۱۲۸ کیلوبایت با حاشیه. */
const MAX_BYTES = 131072;

export interface WooOrdersReader {
  page(site: WooOrdersSite, page: number, status: WooOrderStatus | null): Promise<WooOrdersPage>;
  order(site: WooOrdersSite, orderId: number): Promise<WooOrderView>;
}

const unavailable = (code: string, message: string): Unavailable => ({ state: "unavailable", code, message });

async function call(site: WooOrdersSite, payload: object, deps: WooCallDeps) {
  const r = await signedWooPost(site, "orders", payload, deps, MAX_BYTES);
  if (!r.ok) return unavailable(r.code, r.message);
  return r;
}

function checkEnvelope(site: WooOrdersSite, body: z.infer<typeof envelope>): Unavailable | null {
  if (!sameWooSite(site.siteUrl, body.siteUrl)) {
    return unavailable("site_mismatch", "هویت سایت پاسخ‌دهنده با نشانی تنظیم‌شده یکسان نیست؛ دامنه و مسیر نصب را بررسی کنید.");
  }
  if (body.branchId !== site.branchId || body.warehouseId !== site.warehouseId) {
    return unavailable("scope_mismatch", "شعبه یا انبار افزونه با انبار سایت در Core یکسان نیست.");
  }
  return null;
}

const ROUTE_MISSING = "مسیر سفارش‌های سایت در افزونه پیدا نشد؛ نسخهٔ تازهٔ افزونه را نصب کنید.";
const BAD_CONTRACT = "پاسخ سفارش‌ها با قرارداد سازگار نیست؛ نسخهٔ افزونه را بررسی کنید.";

export function makeWooOrdersReader(deps: WooCallDeps = {}): WooOrdersReader {
  return {
    async page(site, page, status) {
      const r = await call(site, { page, perPage: WOO_ORDERS_PER_PAGE, ...(status === null ? {} : { status }) }, deps);
      if ("state" in r) return r;
      if (r.status === 404) return unavailable("plugin_route", ROUTE_MISSING);
      const parsed = listResponse.safeParse(r.body);
      if (!parsed.success || parsed.data.page !== page || parsed.data.status !== status) return unavailable("invalid_response", BAD_CONTRACT);
      const bad = checkEnvelope(site, parsed.data);
      if (bad) return bad;
      const { total, pages, orders, perPage } = parsed.data;
      return { state: "ready", page, perPage, status, total, pages, orders };
    },
    async order(site, orderId) {
      const r = await call(site, { orderId }, deps);
      if ("state" in r) return r;
      if (r.status === 404) {
        // ۴۰۴ دو معنا دارد: «سفارش نیست» از خود افزونه، یا «مسیر نیست» از وردپرس.
        const code = z.object({ code: z.string() }).safeParse(r.body);
        return code.success && code.data.code === "lmc_order_not_found" ? { state: "not_found" } : unavailable("plugin_route", ROUTE_MISSING);
      }
      const parsed = detailResponse.safeParse(r.body);
      if (!parsed.success || parsed.data.order.id !== orderId) return unavailable("invalid_response", BAD_CONTRACT);
      const bad = checkEnvelope(site, parsed.data);
      if (bad) return bad;
      return { state: "ready", order: parsed.data.order };
    },
  };
}
