/**
 * «سفارش‌های سایت» — خواندن فقط‌خواندنی و امضاشده از افزونه (`POST /wp-json/lmc/v1/orders`، قرارداد ۳).
 *
 * - **دروازه:** همان دروازهٔ تست اتصال (`signedWooPost`): نشانی سنجیده، اتصال پین‌شده، HMAC با Nonce تازه،
 *   بی تغییر مسیر.
 * - **قرارداد:** پاسخ با قرارداد سخت سنجیده می‌شود و میدان اضافهٔ افزونه دور ریخته می‌شود. پاسخ فقط وقتی
 *   پذیرفته است که هویت سایت (مبدأ و مسیر نصب)، شعبه و انبار افزونه با تنظیمات Core یکی باشند و صفحه،
 *   لنگر و فیلترِ برگشتی همان درخواست‌شده باشد.
 *
 * ── پول: ارز خودِ سفارش، تبدیل فقط با کد شناخته‌شده ─────────────────
 *
 * افزونه عدد ذخیره‌شدهٔ ووکامرس را با ارز همان سفارش می‌فرستد. تبدیل به ریال **فقط اینجا** و فقط برای
 * کدهای `IRR` (×۱) و `IRT` (×۱۰) است، با حساب صحیح `bigint`. حاصلی که ریالِ صحیح نشود `null` است.
 * هر ارز دیگر (دلار، کد ناشناخته، رشتهٔ خالی) هم بی تبدیل و `null` می‌ماند و مبلغ اصلی با کد ارزش نشان
 * داده می‌شود. تنظیم سراسری «واحد پول» افزونه ارز سفارش تاریخی را نمی‌داند و اینجا به کار نمی‌رود؛ بازبینی
 * ریشه روی b363e0a نشان داد که IRR و USD با آن تنظیم هر دو ×۱۰ می‌شدند.
 */
import { z } from "zod";
import { sameWooSite, signedWooPost, type WooCallDeps } from "./woocommerce-diagnostics.ts";

export const WOO_ORDERS_PER_PAGE = 20;
export const WOO_ORDERS_PAGE_MAX = 100_000;
export const WOO_STATUS_SLUG = /^[a-z0-9_-]{1,40}$/;
export const WOO_PAYMENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** شناسهٔ نوع روش ارسال ووکامرس (`flat_rate`، `local_pickup`، …). */
export const WOO_SHIPPING_ID = WOO_PAYMENT_ID;

/** ضریب ریالی هر ارز؛ هر کد دیگری تبدیل ندارد. تنها تعریف. */
export const RIAL_FACTOR: Readonly<Record<string, bigint>> = { IRR: 1n, IRT: 10n };

/** مبلغ اعشاری دقیق × ضریب ارز → ریال صحیح، یا `null` اگر ارز ناشناخته یا حاصل کسری از ریال باشد. */
export function toRial(amount: string | null, currency: string): string | null {
  const factor = RIAL_FACTOR[currency];
  if (amount === null || factor === undefined) return null;
  const m = /^(-?)(\d{1,18})(?:\.(\d{1,8}))?$/.exec(amount);
  if (!m) return null;
  const frac = m[3] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const scaled = (BigInt(m[2]!) * scale + BigInt(frac === "" ? "0" : frac)) * factor;
  if (scaled % scale !== 0n) return null;
  const rial = scaled / scale;
  return (m[1] === "-" && rial !== 0n ? "-" : "") + rial.toString();
}

const dec = z.string().regex(/^-?\d{1,18}(?:\.\d{1,8})?$/).nullable();
const text = (max: number) => z.string().max(max);
const iso = z.iso.datetime().nullable();
const coreState = z.object({
  paymentConfirmed: z.boolean(), recorded: z.boolean(), invoiceNumber: text(40).nullable(),
  attempts: z.number().int().nonnegative(), hasError: z.boolean(), stopped: z.boolean(),
});
const rawSummary = z.object({
  id: z.number().int().positive(), number: text(40),
  status: z.string().regex(WOO_STATUS_SLUG).or(z.literal("unknown")), statusLabel: text(100),
  createdAt: iso, currency: z.string().regex(/^(?:[A-Z]{3,4})?$/), total: dec,
  itemCount: z.number().int().nonnegative(), customerName: text(100), customerType: z.enum(["guest", "registered"]),
  paymentMethodId: text(100), paymentMethod: text(100), core: coreState,
});
const address = z.object({
  firstName: text(200), lastName: text(200), company: text(200), address1: text(200), address2: text(200),
  city: text(200), state: text(200), postcode: text(200), country: text(200), phone: text(200),
});
const rawDetail = rawSummary.extend({
  core: coreState.extend({
    // وضعیت صف همان سفارش از LMC_Queue::state: نشان معوق ماندگار و ثبت مرده هم دیده می‌شوند؛ شکست خواندن `unknown`/`null` است.
    queue: z.object({
      scheduler: z.enum(["action-scheduler", "wp-cron"]),
      state: z.enum(["running", "scheduled", "deferred", "dead", "idle", "unknown"]),
      deferred: z.enum(["send", "stop", "recover"]).nullable(), dead: z.boolean().nullable(),
    }).strict(),
    missingSku: z.number().int().nonnegative(), missingMapping: z.number().int().nonnegative(),
  }),
  billing: address.extend({ email: text(200) }),
  shipping: address,
  customerNote: text(1000),
  completedAt: iso, modifiedAt: iso,
  tracking: z.array(z.object({ provider: text(100), number: text(100), shippedAt: iso,
    url: z.string().max(500).refine(v => v === "" || /^https:\/\//.test(v)) })).max(20),
  payment: z.object({ methodId: text(100), method: text(100), transactionId: text(100), paidAt: iso }),
  totals: z.object({ subtotal: dec, discount: dec, discountTax: dec, shipping: dec, shippingTax: dec, tax: dec, total: dec, refunded: dec }),
  items: z.object({
    page: z.number().int().positive(), perPage: z.number().int().positive(), total: z.number().int().nonnegative(),
    rows: z.array(z.object({
      id: z.number().int().nonnegative(), name: text(200), sku: text(64), quantity: z.number().int().nonnegative(),
      attributes: z.array(z.object({ key: text(100), value: text(200) })).max(20),
      subtotal: dec, subtotalTax: dec, total: dec, tax: dec, productExists: z.boolean(), mapped: z.boolean(),
    })).max(50),
  }),
  fees: z.array(z.object({ name: text(200), total: dec, tax: dec })).max(200),
  shippingLines: z.array(z.object({ method: text(200), total: dec, tax: dec })).max(50),
  coupons: z.array(z.object({ code: text(100), discount: dec, discountTax: dec })).max(100),
  refunds: z.array(z.object({ id: z.number().int().positive(), createdAt: iso, amount: dec, reason: text(500) })).max(50),
  refundsTruncated: z.boolean(),
  notes: z.object({
    page: z.number().int().positive(), perPage: z.number().int().positive(), hasMore: z.boolean(),
    rows: z.array(z.object({ id: z.number().int().positive(), createdAt: iso, content: text(1000), customerNote: z.boolean(), addedBy: text(100) })).max(50),
  }),
});
const envelope = z.object({
  protocol: z.literal(3), siteUrl: z.string().url().max(500),
  branchId: z.string().max(36), warehouseId: z.string().max(36),
});
const listResponse = envelope.extend({
  page: z.number().int().positive(), perPage: z.number().int().positive(), until: z.number().int().positive(),
  filters: z.object({
    status: z.string().nullable(), search: z.boolean(), dateFrom: z.string().nullable(), dateTo: z.string().nullable(),
    paymentMethod: z.string().nullable(), shippingMethod: z.string().nullable(),
  }),
  statuses: z.array(z.object({ slug: z.string().regex(WOO_STATUS_SLUG), label: text(100) })).max(100),
  paymentMethods: z.array(z.object({ id: z.string().regex(WOO_PAYMENT_ID), title: text(100) })).max(100),
  shippingMethods: z.array(z.object({ id: z.string().regex(WOO_SHIPPING_ID), title: text(100) })).max(100),
  total: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), orders: z.array(rawSummary).max(50),
});
const detailResponse = envelope.extend({ order: rawDetail });

/** پول در پاسخ Core: عدد دقیق سایت با ارز خودش، و ریال فقط وقتی تبدیل دقیق ممکن است. */
export interface WooMoney { amount: string | null; rial: string | null }
const money = (amount: string | null, currency: string): WooMoney => ({ amount, rial: toRial(amount, currency) });

type RawSummary = z.infer<typeof rawSummary>;
type RawDetail = z.infer<typeof rawDetail>;
export type WooOrderSummary = Omit<RawSummary, "total"> & { total: WooMoney };
export type WooOrderDetail = Omit<RawDetail, "total" | "totals" | "items" | "fees" | "shippingLines" | "coupons" | "refunds"> & {
  total: WooMoney;
  totals: Record<keyof RawDetail["totals"], WooMoney>;
  items: Omit<RawDetail["items"], "rows"> & { rows: (Omit<RawDetail["items"]["rows"][number], "subtotal" | "subtotalTax" | "total" | "tax"> &
    { subtotal: WooMoney; subtotalTax: WooMoney; total: WooMoney; tax: WooMoney; discount: WooMoney })[] };
  fees: { name: string; total: WooMoney; tax: WooMoney }[];
  shippingLines: { method: string; total: WooMoney; tax: WooMoney }[];
  coupons: { code: string; discount: WooMoney; discountTax: WooMoney }[];
  refunds: { id: number; createdAt: string | null; amount: WooMoney; reason: string }[];
};

function mapSummary(o: RawSummary): WooOrderSummary {
  return { ...o, total: money(o.total, o.currency) };
}

/** تخفیف سطر = جمع پیش از تخفیف − جمع پس از تخفیف، با همان دقت اعشاری؛ هر کدام نامعلوم باشد، نامعلوم. */
export function lineDiscount(subtotal: string | null, total: string | null): string | null {
  if (subtotal === null || total === null) return null;
  const parse = (v: string) => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v)!;
    return { neg: m[1] === "-", int: m[2]!, frac: m[3] ?? "" };
  };
  const a = parse(subtotal), b = parse(total);
  const places = Math.max(a.frac.length, b.frac.length);
  const big = (p: ReturnType<typeof parse>) => (p.neg ? -1n : 1n) * BigInt(p.int + p.frac.padEnd(places, "0"));
  const diff = big(a) - big(b);
  const abs = (diff < 0n ? -diff : diff).toString().padStart(places + 1, "0");
  const out = places === 0 ? abs : `${abs.slice(0, -places)}.${abs.slice(-places)}`;
  return (diff < 0n ? "-" : "") + out;
}

function mapDetail(o: RawDetail): WooOrderDetail {
  const c = o.currency;
  const m = (v: string | null) => money(v, c);
  return {
    ...o,
    total: m(o.total),
    totals: Object.fromEntries(Object.entries(o.totals).map(([k, v]) => [k, m(v)])) as WooOrderDetail["totals"],
    items: { ...o.items, rows: o.items.rows.map(r => ({ ...r, subtotal: m(r.subtotal), subtotalTax: m(r.subtotalTax), total: m(r.total), tax: m(r.tax),
      discount: m(lineDiscount(r.subtotal, r.total)) })) },
    fees: o.fees.map(f => ({ name: f.name, total: m(f.total), tax: m(f.tax) })),
    shippingLines: o.shippingLines.map(s => ({ method: s.method, total: m(s.total), tax: m(s.tax) })),
    coupons: o.coupons.map(x => ({ code: x.code, discount: m(x.discount), discountTax: m(x.discountTax) })),
    refunds: o.refunds.map(r => ({ id: r.id, createdAt: r.createdAt, reason: r.reason, amount: m(r.amount) })),
  };
}

type Unavailable = { state: "unavailable"; code: string; message: string };
export interface WooOrdersQuery {
  page: number; status: string | null; search: string | null; dateFrom: string | null; dateTo: string | null;
  paymentMethod: string | null; shippingMethod: string | null; until: number | null;
}
export type WooOrdersPage = {
  state: "ready"; page: number; perPage: number; until: number; total: number; pages: number;
  statuses: { slug: string; label: string }[]; paymentMethods: { id: string; title: string }[];
  shippingMethods: { id: string; title: string }[]; orders: WooOrderSummary[];
} | Unavailable;
export type WooOrderView = { state: "ready"; order: WooOrderDetail } | { state: "not_found" } | Unavailable;

export interface WooOrdersSite { siteUrl: string; secret: string | undefined; branchId: string; warehouseId: string }

/** فهرست ۵۰ سفارش حدود ۴۰ کیلوبایت است و جزئیات با ۲۵ قلم و ۲۰ یادداشت حدود ۱۰۰؛ سقف‌ها با حاشیه. */
const LIST_BYTES = 131072;
const DETAIL_BYTES = 262144;

export interface WooOrdersReader {
  page(site: WooOrdersSite, query: WooOrdersQuery): Promise<WooOrdersPage>;
  order(site: WooOrdersSite, orderId: number, itemsPage: number, notesPage: number): Promise<WooOrderView>;
}

const unavailable = (code: string, message: string): Unavailable => ({ state: "unavailable", code, message });

function checkEnvelope(site: WooOrdersSite, body: z.infer<typeof envelope>): Unavailable | null {
  if (!sameWooSite(site.siteUrl, body.siteUrl)) {
    return unavailable("site_mismatch", "هویت سایت پاسخ‌دهنده با نشانی تنظیم‌شده یکسان نیست؛ دامنه و مسیر نصب را بررسی کنید.");
  }
  if (body.branchId !== site.branchId || body.warehouseId !== site.warehouseId) {
    return unavailable("scope_mismatch", "شعبه یا انبار افزونه با انبار سایت در Core یکسان نیست.");
  }
  return null;
}

const ROUTE_MISSING = "مسیر سفارش‌های سایت (قرارداد ۳) در افزونه پیدا نشد؛ نسخهٔ تازهٔ افزونه را نصب کنید.";
const BAD_CONTRACT = "پاسخ سفارش‌ها با قرارداد سازگار نیست؛ نسخهٔ افزونه را بررسی کنید.";

export function makeWooOrdersReader(deps: WooCallDeps = {}): WooOrdersReader {
  return {
    async page(site, q) {
      const body = {
        page: q.page, perPage: WOO_ORDERS_PER_PAGE,
        ...(q.status === null ? {} : { status: q.status }), ...(q.search === null ? {} : { search: q.search }),
        ...(q.dateFrom === null ? {} : { dateFrom: q.dateFrom }), ...(q.dateTo === null ? {} : { dateTo: q.dateTo }),
        ...(q.paymentMethod === null ? {} : { paymentMethod: q.paymentMethod }),
        ...(q.shippingMethod === null ? {} : { shippingMethod: q.shippingMethod }), ...(q.until === null ? {} : { until: q.until }),
      };
      const r = await signedWooPost(site, "orders", body, deps, LIST_BYTES);
      if (!r.ok) return unavailable(r.code, r.message);
      // ۴۰۰ (مثلاً وضعیتی که دیگر ثبت نیست) در دروازه `bad_query` شده است؛ ۴۰۴ فهرست یعنی مسیر نیست.
      if (r.status === 404) return unavailable("plugin_route", ROUTE_MISSING);
      const parsed = listResponse.safeParse(r.body);
      if (!parsed.success) return unavailable("invalid_response", BAD_CONTRACT);
      const d = parsed.data;
      const f = d.filters;
      if (d.page !== q.page || d.perPage !== WOO_ORDERS_PER_PAGE || (q.until !== null && d.until !== q.until)
        || f.status !== q.status || f.search !== (q.search !== null) || f.dateFrom !== q.dateFrom || f.dateTo !== q.dateTo
        || f.paymentMethod !== q.paymentMethod || f.shippingMethod !== q.shippingMethod) {
        return unavailable("invalid_response", BAD_CONTRACT);
      }
      const bad = checkEnvelope(site, d);
      if (bad) return bad;
      return { state: "ready", page: d.page, perPage: d.perPage, until: d.until, total: d.total, pages: d.pages,
        statuses: d.statuses, paymentMethods: d.paymentMethods, shippingMethods: d.shippingMethods, orders: d.orders.map(mapSummary) };
    },
    async order(site, orderId, itemsPage, notesPage) {
      const r = await signedWooPost(site, "orders", {
        orderId, ...(itemsPage === 1 ? {} : { itemsPage }), ...(notesPage === 1 ? {} : { notesPage }),
      }, deps, DETAIL_BYTES);
      if (!r.ok) return unavailable(r.code, r.message);
      if (r.status === 404) {
        // ۴۰۴ دو معنا دارد: «سفارش نیست» از خود افزونه، یا «مسیر نیست» از وردپرس.
        const code = z.object({ code: z.string() }).safeParse(r.body);
        return code.success && code.data.code === "lmc_order_not_found" ? { state: "not_found" } : unavailable("plugin_route", ROUTE_MISSING);
      }
      const parsed = detailResponse.safeParse(r.body);
      if (!parsed.success || parsed.data.order.id !== orderId || parsed.data.order.items.page !== itemsPage
        || parsed.data.order.notes.page !== notesPage) {
        return unavailable("invalid_response", BAD_CONTRACT);
      }
      const bad = checkEnvelope(site, parsed.data);
      if (bad) return bad;
      return { state: "ready", order: mapDetail(parsed.data.order) };
    },
  };
}
