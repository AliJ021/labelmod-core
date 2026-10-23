import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { testWooConnection } from "../platform/woocommerce-diagnostics.ts";
import { readWooSite } from "../platform/woocommerce-site.ts";
import { readCoreToWoo, readWooToCore, type WooToCore } from "../platform/stock-sync.ts";

export function registerWooDiagnosticsRoutes(app: FastifyInstance, db: Db, secret: string | undefined,
  deps: { test?: typeof testWooConnection } = {}) {
  // همان مجوز و دامنهٔ سفارش، بدون ساخت فاکتور یا حرکت انبار.
  app.get("/web/connection", async (req, reply) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    const q = z.object({ branchId: z.string().uuid(), warehouseId: z.string().uuid(),
      sku: z.string().trim().min(1).max(64).optional(), variationId: z.string().uuid().optional(),
    }).strict().parse(req.query);
    await requireForSession(db, req.session, "sale.create");
    await assertBranch(db, req.session.userId, q.branchId);
    await assertWarehouseInBranch(db, q.warehouseId, q.branchId);
    const variation = q.sku ? await db.selectFrom("catalog.variation").select(["id", "status"])
      .where("sku", "=", q.sku).executeTakeFirst() : undefined;
    reply.header("cache-control", "no-store");
    return { protocol: 1, authenticated: true, auth: "apiClientId" in req.session ? "api_key" : "session",
      branchId: q.branchId, warehouseId: q.warehouseId, orderIdentity: "sku", stockIdentity: "variationId",
      features: { explicitLineDiscount: true, codReservations: true },
      mapping: q.sku ? { skuFound: !!variation, active: variation?.status === "active",
        matchesVariation: q.variationId ? variation?.id === q.variationId : null } : null,
    };
  });

  // پاسخ صفحهٔ تنظیمات همان شکل قبلی است؛ شعبهٔ انبار فقط برای دامنه خوانده می‌شود.
  async function config() {
    const { branchId: _branch, ...site } = await readWooSite(db, secret);
    return site;
  }
  app.get("/settings/woocommerce", async (req, reply) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.view");
    reply.header("cache-control", "no-store");
    return config();
  });
  /**
   * کارت همگام‌سازی سایت در داشبورد (دستهٔ C) — فقط‌خواندنی، پشت `settings.view` مثل سلامت سیستم.
   * Core → سایت از همین پایگاه داده و دقیق؛ سایت → Core از تله‌متری امضاشدهٔ افزونه (کش ۳۰ ثانیه).
   * دامنهٔ شعبهٔ انبار سایت **پیش از** هر درخواست بیرونی سنجیده می‌شود (همان قاعدهٔ تست اتصال).
   */
  app.get("/dashboard/stock-sync", async (req, reply) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.view");
    const local = await config();
    const health = await sql<{ enabled: boolean; misconfigured: boolean; minutes: number }>`
      SELECT enabled, misconfigured, minutes FROM platform.web_push_health`.execute(db);
    const h = health.rows[0]!;
    const coreToWoo = await readCoreToWoo(db);
    const checkedAt = new Date().toISOString();
    const wh = z.string().uuid().safeParse(local.warehouseId).success ? await db.selectFrom("inventory.warehouse").select("branch_id")
      .where("id", "=", local.warehouseId).executeTakeFirst() : undefined;
    let wooToCore: WooToCore;
    if (!local.siteUrl) {
      wooToCore = { state: "unknown", code: "not_configured", message: "نشانی سایت در تنظیمات تعیین نشده است.", fetchedAt: checkedAt };
    } else if (!wh) {
      wooToCore = { state: "unknown", code: "warehouse", message: "انبار سایت تعیین نشده یا معتبر نیست؛ web.stock_warehouse را بررسی کنید.", fetchedAt: checkedAt };
    } else {
      await assertBranch(db, req.session.userId, wh.branch_id);
      wooToCore = await readWooToCore({ siteUrl: local.siteUrl, secret, warehouseId: local.warehouseId, branchId: wh.branch_id },
        deps.test ? { test: deps.test } : {});
    }
    reply.header("cache-control", "no-store");
    return {
      checkedAt,
      coreToWoo: { enabled: h.enabled, misconfigured: h.misconfigured, reconcileMinutes: Number(h.minutes), ...coreToWoo },
      wooToCore,
    };
  });

  app.post("/settings/woocommerce/test", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.view");
    const body = z.object({ orderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict().parse(req.body ?? {});
    const local = await config();
    // دامنهٔ انبار سایت پیش از درخواست بیرونی بررسی می‌شود.
    const wh = z.string().uuid().safeParse(local.warehouseId).success ? await db.selectFrom("inventory.warehouse").select("branch_id")
      .where("id", "=", local.warehouseId).executeTakeFirst() : undefined;
    if (!wh) return { ok: false, code: "warehouse", message: "انبار سایت تعیین نشده یا معتبر نیست؛ web.stock_warehouse را بررسی کنید.", remote: null };
    await assertBranch(db, req.session.userId, wh.branch_id);
    const result = await testWooConnection({ siteUrl: local.siteUrl, secret }, body.orderId);
    reply.header("cache-control", "no-store");
    if (result.remote && (result.remote.warehouseId !== local.warehouseId || result.remote.branchId !== wh.branch_id)) {
      return { ok: false, code: "scope_mismatch", message: "شعبه یا انبار افزونه با انبار سایت در Core یکسان نیست.", remote: null };
    }
    return result;
  });
}
