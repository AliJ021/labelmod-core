import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { requireHumanSession } from "../auth/human-session.ts";
import { branchesOf, ScopeError } from "../sales/scope.ts";
import type { PaymentProviderRuntime } from "../payments/providers/runtime.ts";

export function registerPaymentProviderRoutes(app: FastifyInstance, db: Db, runtime: PaymentProviderRuntime): void {
  async function guard(raw: unknown, diagnostic: boolean) {
    const session = raw as ResolvedSession | null;
    if (!session) throw new AuthError("no_session","وارد نشده‌اید");
    await requireHumanSession(db,session);
    await requireForSession(db,session,diagnostic ? "settings.security" : "settings.view");
    if (await branchesOf(db,session.userId)!=="all") throw new ScopeError("بررسی اتصال سراسری فقط برای مدیر همه شعب است");
  }
  app.get("/payment-providers/readiness", async req => {
    await guard(req.session,false);
    const result = await sql<{ enabled: boolean }>`SELECT treasury.snappay_account() IS NOT NULL
      AND EXISTS(SELECT 1 FROM treasury.payment_method WHERE code='snappay' AND is_active) enabled`.execute(db);
    return runtime.readiness(result.rows[0]?.enabled ?? false);
  });
  // این درخواست فقط احراز اتصال را می‌سنجد؛ هیچ قصد یا ثبت مالی نمی‌سازد.
  app.post("/payment-providers/:provider/diagnose", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async req => {
    await guard(req.session,true);
    const { provider } = z.object({ provider: z.enum(["snappay","digipay"]) }).parse(req.params);
    z.object({ confirmed: z.literal(true) }).strict().parse(req.body);
    return runtime.diagnose(provider);
  });
}
