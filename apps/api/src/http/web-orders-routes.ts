/**
 * «سفارش‌های سایت» برای مدیر — فقط‌خواندنی.
 *
 *   GET /web/orders?page=&status=   فهرست ۲۰تایی، تازه‌ترین اول
 *   GET /web/orders/:orderId        جزئیات یک سفارش
 *
 * - **مجوز:** `web.orders.view` از `identity.can()`. در Seed فقط مدیر آن را دارد (مهاجرت ۱۰۱).
 * - **دامنه:** دامنهٔ شعبهٔ انبار سایت **پیش از** هر درخواست بیرونی سنجیده می‌شود، همان قاعدهٔ تست اتصال.
 * - **مسیر خواندن:** هیچ چیزی در Core یا سایت نوشته نمی‌شود. خواندن از راه دروازهٔ امضاشدهٔ
 *   `signedWooPost` است. هر شکست اتصال یا قرارداد `unavailable` با دلیل است؛ «فهرست خالی» گفته نمی‌شود.
 * - **پاسخ:** `no-store`، و سقف نرخ دارد چون هر درخواست به سایت بیرونی می‌رود.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { assertBranch } from "../sales/scope.ts";
import { readWooSite } from "../platform/woocommerce-site.ts";
import {
  makeWooOrdersReader, WOO_ORDER_STATUSES, WOO_ORDERS_PAGE_MAX, type WooOrdersReader, type WooOrdersSite,
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
      status: z.enum(WOO_ORDER_STATUSES).optional(),
    }).strict().parse(req.query);
    const s = await site(req);
    reply.header("cache-control", "no-store");
    const fetchedAt = new Date().toISOString();
    if ("state" in s) return { ...s, fetchedAt };
    return { ...(await reader.page(s, q.page, q.status ?? null)), fetchedAt };
  });

  app.get("/web/orders/:orderId", RATE, async (req, reply) => {
    const p = z.object({ orderId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(req.params);
    const s = await site(req);
    reply.header("cache-control", "no-store");
    const fetchedAt = new Date().toISOString();
    if ("state" in s) return { ...s, fetchedAt };
    return { ...(await reader.order(s, p.orderId)), fetchedAt };
  });
}
