import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { withActor } from "../db/actor.ts";
import { AuthError } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import { SettingError } from "../platform/settings.ts";
import { encryptMeliKey } from "../platform/melipayamak-credential.ts";

const bodySchema = z.object({
  revision: z.number().int().nonnegative(),
  accountName: z.string().trim().max(100),
  apiKey: z.string().trim().min(1).max(2048).optional(),
  clearKey: z.boolean().optional(),
}).strict().refine((b) => !(b.clearKey && b.apiKey), { message: "حذف و جایگزینی هم‌زمان کلید مجاز نیست" });

export function registerMeliPayamakRoutes(app: FastifyInstance, db: Db, master: string | undefined): void {
  async function status() {
    const r = await sql<{ accountName: string; hasKey: boolean; revision: number; updatedAt: Date }>`
      SELECT account_name AS "accountName",encrypted_key IS NOT NULL AS "hasKey",revision,updated_at AS "updatedAt"
      FROM platform.melipayamak_credential WHERE singleton`.execute(db);
    if (!r.rows[0]) throw new SettingError("credential_missing", "تنظیم اتصال ملی‌پیامک آماده نیست", 503);
    return { ...r.rows[0], storageReady: Boolean(master) };
  }

  app.get("/settings/melipayamak-credential", async (req) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.view");
    const permission = await can(db, { userId: req.session.userId, viaPin: req.session.pinUnlocked, operation: "settings.security" });
    return { ...await status(), canEdit: permission.verdict === "allow" };
  });

  app.put("/settings/melipayamak-credential", async (req) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.security");
    const input = bodySchema.parse(req.body);
    const encrypted = input.apiKey ? encryptMeliKey(input.apiKey, master) : undefined;
    await withActor(db, { userId: req.session.userId, ip: req.ip }, async (trx) => {
      const r = await sql<{ revision: number; hasKey: boolean }>`
        UPDATE platform.melipayamak_credential
        SET account_name=${input.accountName},
            encrypted_key=CASE WHEN ${Boolean(input.clearKey)} THEN NULL
              WHEN ${encrypted !== undefined} THEN ${encrypted ? JSON.stringify(encrypted) : null}::jsonb ELSE encrypted_key END,
            revision=revision+1,updated_at=now(),updated_by=${req.session!.userId}::uuid
        WHERE singleton AND revision=${input.revision}
        RETURNING revision, encrypted_key IS NOT NULL AS "hasKey"`.execute(trx);
      if (!r.rows[0]) throw new SettingError("credential_conflict", "تنظیم اتصال هم‌زمان تغییر کرده؛ صفحه را تازه کنید", 409);
      await sql`INSERT INTO platform.audit_log(actor_id,action,entity,entity_id,"after",ip)
        VALUES(${req.session!.userId}::uuid,'credential.update','melipayamak','singleton',
          ${JSON.stringify({ revision: r.rows[0].revision, hasKey: r.rows[0].hasKey,
            keyChanged: encrypted !== undefined || Boolean(input.clearKey) })}::jsonb,${req.ip}::inet)`.execute(trx);
    });
    return { ...await status(), canEdit: true };
  });
}
