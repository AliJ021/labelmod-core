import { sql, type Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import type { ResolvedSession } from "./service.ts";
import { ScopeError } from "../sales/scope.ts";

/** نشست ساختگی کلید API شاهد تصمیم انسانی نیست؛ قفل تا پایان اثر نگه داشته می‌شود. */
export async function requireHumanSession(db: Db | Transaction<Database>, session: ResolvedSession): Promise<void> {
  if ("apiClientId" in session || session.pinUnlocked || session.enrollmentOnly) {
    throw new ScopeError("این تصمیم به ورود کامل یک کاربر انسانی نیاز دارد");
  }
  const result = await sql<{ id: string }>`
    SELECT s.id FROM identity.session s JOIN identity.app_user u ON u.id=s.user_id
    WHERE s.id=${session.sessionId}::uuid AND s.user_id=${session.userId}::uuid
      AND s.subject='staff' AND u.is_active AND s.revoked_at IS NULL AND s.locked_at IS NULL
      AND NOT s.pin_unlocked AND s.expires_at>clock_timestamp()
      AND s.auth_method IN ('password','totp','webauthn','otp')
      AND (s.auth_method<>'password' OR (NOT identity.needs_second_factor(u.id)
           AND NOT identity.should_have_second_factor(u.id)))
    FOR SHARE OF s,u
  `.execute(db);
  if (!result.rows.length) throw new ScopeError("نشست انسانی معتبر و کامل برای این تصمیم یافت نشد");
}

/** مسیر مرجوعی دستی هم نباید راه جایگزین یک کلید سایت باشد. */
export async function requireWebReturnHuman(db: Db | Transaction<Database>, session: ResolvedSession, invoiceId: string): Promise<void> {
  const invoice = await db.selectFrom("sales.invoice").select(["id", "channel"]).where("id", "=", invoiceId).executeTakeFirst();
  if (invoice?.channel !== "web") return;
  await requireHumanSession(db, session);
  const own = await sql`SELECT 1 FROM platform.inbox_message WHERE source='api.web.order'
    AND result_ref=${invoice.id} AND payload->>'actorId'=${session.userId}`.execute(db);
  if (own.rows.length) throw new ScopeError("تأییدکننده باید مستقل از هویت ارسال‌کنندهٔ سفارش باشد");
}

/** مرجوعی فروش سایت فقط از تصمیم درخواست بررسی به سند تبدیل می‌شود. */
export async function requireManualReturnChannel(db: Db | Transaction<Database>, invoiceId: string): Promise<void> {
  const invoice = await db.selectFrom("sales.invoice").select("channel").where("id", "=", invoiceId).executeTakeFirst();
  if (invoice?.channel === "web") {
    throw new ScopeError("مرجوعی فروش سایت باید از درخواست بررسی مرجوعی و تأیید مستقل ثبت شود");
  }
}
