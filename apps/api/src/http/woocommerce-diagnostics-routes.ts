import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { testWooConnection } from "../platform/woocommerce-diagnostics.ts";

export function registerWooDiagnosticsRoutes(app: FastifyInstance, db: Db, secret: string | undefined) {
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
      mapping: q.sku ? { skuFound: !!variation, active: variation?.status === "active",
        matchesVariation: q.variationId ? variation?.id === q.variationId : null } : null,
    };
  });

  async function config() {
    const rows = await db.selectFrom("platform.setting").select(["key", "value"])
      .where("key", "in", ["web.site_url", "web.push_enabled", "web.stock_warehouse", "web.price_list"]).execute();
    const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { siteUrl: typeof values["web.site_url"] === "string" ? values["web.site_url"] : "",
      pushEnabled: values["web.push_enabled"] === true,
      warehouseId: typeof values["web.stock_warehouse"] === "string" ? values["web.stock_warehouse"] : "",
      priceList: typeof values["web.price_list"] === "string" ? values["web.price_list"] : "",
      signingConfigured: !!secret,
    };
  }
  app.get("/settings/woocommerce", async (req, reply) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.view");
    reply.header("cache-control", "no-store");
    return config();
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
