import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { AuthService } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { hashApiKey } from "../auth/api-key.ts";
import { withActor } from "../db/actor.ts";
import type { Db } from "../db/client.ts";
import { getOrCreatePrivateKey, wooSigningKey } from "../lib/private-key-file.ts";
import { readWooSite } from "../platform/woocommerce-site.ts";
import { SettingError } from "../platform/settings.ts";
import { branchesOf } from "../sales/scope.ts";

export function registerWooCredentials(app: FastifyInstance, db: Db, auth: AuthService, cookie: string, legacy?: string) {
  app.post("/settings/woocommerce/credentials", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const session = req.session;
    if (!session || session.pinUnlocked || session.enrollmentOnly || "apiClientId" in session || !req.cookies[cookie]) {
      throw new SettingError("human_required", "برای مدیریت کلید با رمز حساب وارد شوید.", 403);
    }
    await requireForSession(db, session, "settings.security");
    if (await branchesOf(db, session.userId) !== "all") throw new SettingError("global_scope", "دسترسی به همه شعب لازم است.", 403);
    const { kind, password } = z.object({ kind: z.enum(["api", "push"]), password: z.string().min(1).max(256) }).strict().parse(req.body);
    await auth.reauthenticate(req.cookies[cookie]!, password);
    const site = await readWooSite(db, legacy);
    if (!site.branchId) throw new SettingError("woo_scope", "ابتدا انبار سایت را در تنظیمات انتخاب کنید.", 409);
    return withActor(db, { userId: session.userId, ip: req.ip }, async trx => {
      let key: string | undefined;
      if (kind === "push") {
        key = await wooSigningKey(legacy, true);
      } else {
        const path = process.env.WOO_SIGNING_KEY_FILE;
        if (!path) throw new SettingError("woo_key_storage", "فضای خصوصی کلیدهای اتصال در این نصب آماده نیست.", 503);
        const master = await getOrCreatePrivateKey(path + ".api");
        const note = "woocommerce-panel:" + site.branchId;
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${note}, 0))`.execute(trx);
        const client = await trx.selectFrom("identity.api_client").select(["id", "key_hash"])
          .where("note", "=", note).where("is_active", "=", true).executeTakeFirst();
        const id = client?.id ?? randomUUID();
        key = "lmk_" + createHmac("sha256", master).update(id).digest("base64url");
        if (client && hashApiKey(key) !== client.key_hash) throw new SettingError("woo_key_mismatch", "کلید این نصب با سابقهٔ اتصال تطبیق ندارد.", 409);
        if (!client) {
          const user = await trx.insertInto("identity.app_user").values({
            username: "api:woo:" + id, full_name: "سایت ووکامرس", mobile: null, password_hash: null,
            pin_hash: null, totp_secret: null, is_active: false,
          }).returning("id").executeTakeFirstOrThrow();
          await trx.insertInto("identity.user_role").values({ user_id: user.id, role_code: "web", branch_id: site.branchId }).execute();
          await trx.insertInto("identity.api_client").values({ id, name: "ووکامرس", key_hash: hashApiKey(key),
            user_id: user.id, created_by: session.userId, note, last_used_at: null }).execute();
        }
      }
      if (!key) throw new SettingError("woo_key_storage", "فضای خصوصی کلیدهای اتصال در این نصب آماده نیست.", 503);
      await sql`SELECT platform.audit('credential.access', 'woocommerce', ${kind}, '{}'::jsonb, ${session.userId}::uuid)`.execute(trx);
      return { key };
    });
  });
}
