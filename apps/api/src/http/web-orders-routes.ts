/**
 * «سفارش‌های سایت» برای مدیر — فقط‌خواندنی.
 *
 *   GET /web/orders?page=&status=&q=&from=&to=&payment=&until=   فهرست ۲۰تایی، تازه‌ترین اول
 *   GET /web/orders/:orderId?items=&notes=                      جزئیات یک سفارش، اقلام و یادداشت صفحه‌بندی‌شده
 *
 * - **مجوز:** `web.orders.view` از `identity.can()`. در Seed فقط مدیر آن را دارد (مهاجرت ۱۰۱).
 * - **دامنه:** دامنهٔ شعبهٔ انبار سایت **پیش از** هر درخواست بیرونی سنجیده می‌شود، همان قاعدهٔ تست اتصال.
 * - **مسیر خواندن:** هیچ چیزی در Core یا سایت نوشته نمی‌شود. خواندن از راه دروازهٔ امضاشدهٔ
 *   `signedWooPost` است. هر شکست اتصال یا قرارداد `unavailable` با دلیل است؛ «فهرست خالی» گفته نمی‌شود.
 * - **پاسخ:** `no-store`، و سقف نرخ دارد چون هر درخواست به سایت بیرونی می‌رود.
 * - **عبارت جست‌وجو** (`q`، شاید تلفن یا ایمیل) در لاگ API نمی‌نشیند (لاگ فقط الگوی مسیر را دارد) و
 *   صفحهٔ وب آن را در نشانی صفحه نگه نمی‌دارد.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { assertBranch } from "../sales/scope.ts";
import { readWooSite } from "../platform/woocommerce-site.ts";
import { hasControlChars } from "../lib/text.ts";
import {
  makeWooOrdersReader, WOO_ORDERS_PAGE_MAX, WOO_PAYMENT_ID, WOO_STATUS_SLUG, type WooOrdersReader, type WooOrdersSite,
} from "../platform/woocommerce-orders.ts";

const RATE = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export function registerWebOrdersRoutes(app: FastifyInstance, db: Db, secret: string | undefined,
  reader: WooOrdersReader = makeWooOrdersReader()) {
  /** مجوز، سپس دامنه، سپس سایت — هیچ‌کدام پس از درخواست بیرونی نیست. */
  async function site(req: FastifyRequest): Promise<WooOrdersSite | { state: "unavailable"; code: string; message: string }> {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "web.orders.view");
    const local = await readWooSite(db, secret);
    if (!local.warehouseId) {
      return { state: "unavailable", code: "warehouse", message: "انبار سایت تعیین نشده یا معتبر نیست؛ web.stock_warehouse را بررسی کنید." };
    }
    await assertBranch(db, req.session.userId, local.branchId);
    if (!local.siteUrl) return { state: "unavailable", code: "site_url", message: "نشانی سایت (web.site_url) تنظیم نشده است." };
    return { siteUrl: local.siteUrl, secret, branchId: local.branchId, warehouseId: local.warehouseId };
  }

  app.get("/web/orders", RATE, async (req, reply) => {
    const q = z.object({
      page: z.coerce.number().int().min(1).max(WOO_ORDERS_PAGE_MAX).default(1),
      status: z.string().regex(WOO_STATUS_SLUG).optional(),
      q: z.string().trim().min(1).max(100).refine(v => !hasControlChars(v)).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      payment: z.string().regex(WOO_PAYMENT_ID).optional(),
      until: z.coerce.number().int().min(1).max(4102444800).optional(),
    }).strict().refine(v => !v.from || !v.to || v.from <= v.to).parse(req.query);
    const s = await site(req);
    reply.header("cache-control", "no-store");
    const fetchedAt = new Date().toISOString();
    if ("state" in s) return { ...s, fetchedAt };
    return { ...(await reader.page(s, {
      page: q.page, status: q.status ?? null, search: q.q ?? null, dateFrom: q.from ?? null, dateTo: q.to ?? null,
      paymentMethod: q.payment ?? null, until: q.until ?? null,
    })), fetchedAt };
  });

  app.get("/web/orders/:orderId", RATE, async (req, reply) => {
    const p = z.object({ orderId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(req.params);
    const q = z.object({
      items: z.coerce.number().int().min(1).max(10000).default(1),
      notes: z.coerce.number().int().min(1).max(10000).default(1),
    }).strict().parse(req.query);
    const s = await site(req);
    reply.header("cache-control", "no-store");
    const fetchedAt = new Date().toISOString();
    if ("state" in s) return { ...s, fetchedAt };
    return { ...(await reader.order(s, p.orderId, q.items, q.notes)), fetchedAt };
  });
}
