import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../db/types.ts";
import { AuthError } from "./service.ts";

/** قفل مشترک مراسم ثبت؛ نشست رمزی قدیمی حق افزودن عامل تازه پس از ثبت عامل اول ندارد. */
export async function lockEnrollment(trx: Transaction<Database>, userId: string, sessionId: string): Promise<void> {
  await trx.selectFrom("identity.app_user").select("id").where("id", "=", userId).forUpdate().executeTakeFirstOrThrow();
  const result = await sql<{ method: string; enrolled: boolean }>`
    SELECT s.auth_method AS method, identity.needs_second_factor(s.user_id) AS enrolled
      FROM identity.session s WHERE s.id = ${sessionId}::uuid AND s.user_id = ${userId}::uuid
        AND s.revoked_at IS NULL AND s.expires_at > now() FOR UPDATE
  `.execute(trx);
  const row = result.rows[0];
  if (!row || (row.method === "password" && row.enrolled)) {
    throw new AuthError("no_session", "برای ثبت عامل دوم دوباره وارد شوید.");
  }
}

export async function proveEnrollment(trx: Transaction<Database>, userId: string, sessionId: string, method: "totp" | "webauthn" | "otp"): Promise<void> {
  await trx.updateTable("identity.session").set({ auth_method: method }).where("id", "=", sessionId).execute();
  await sql`UPDATE identity.session SET revoked_at = now()
    WHERE user_id = ${userId}::uuid AND id <> ${sessionId}::uuid
      AND auth_method = 'password' AND revoked_at IS NULL`.execute(trx);
}
