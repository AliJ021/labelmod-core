/**
 * مجوز — نازک عمداً.
 *
 * تمام تصمیم در identity.can() گرفته می‌شود که permission_rule را
 * می‌خواند. این فایل فقط ترجمه است. **هیچ شرط دسترسی اینجا نوشته
 * نمی‌شود** — نه یک if روی نام نقش، نه یک فهرست ثابت.
 *
 * اگر وسوسه شدی اینجا شرطی بنویسی، یعنی یک ردیف در permission_rule کم
 * است. ردیف را اضافه کن، نه شرط را.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { serializeMoney } from "../lib/money.ts";

export type Verdict = "allow" | "deny" | "needs_approval";

export interface Decision {
  verdict: Verdict;
  approver: string | null;
  reason: string;
}

export interface PermissionQuery {
  userId: string;
  operation: string;
  amount?: bigint | undefined;
  percent?: number | undefined;
  /** نشست از مسیر PIN باز شده؟ اگر بله، عملیات حساس بسته‌اند. */
  viaPin?: boolean | undefined;
}

export async function can(db: Db, q: PermissionQuery): Promise<Decision> {
  const r = await sql<Decision>`
    SELECT verdict, approver, reason
      FROM identity.can(
        ${q.userId}::uuid,
        ${q.operation},
        ${q.amount === undefined ? null : serializeMoney(q.amount)}::numeric,
        ${q.percent ?? null}::numeric,
        ${q.viaPin ?? false})
  `.execute(db);

  const row = r.rows[0];
  if (!row) {
    return { verdict: "deny", approver: null, reason: "پاسخی از موتور مجوز نیامد" };
  }
  return row;
}

export class ForbiddenError extends Error {
  readonly decision: Decision;
  readonly operation: string;

  constructor(decision: Decision, operation: string) {
    super(
      decision.verdict === "needs_approval"
        ? `این عملیات نیازمند تأیید «${decision.approver}» است: ${decision.reason}`
        : `دسترسی لازم را ندارید: ${decision.reason}`,
    );
    this.name = "ForbiddenError";
    this.decision = decision;
    this.operation = operation;
  }
}

/** مجوز یا خطا. عبور از سقف هم خطاست — ولی خطای «نیازمند تأیید». */
export async function requirePermission(db: Db, q: PermissionQuery): Promise<Decision> {
  const decision = await can(db, q);
  if (decision.verdict !== "allow") throw new ForbiddenError(decision, q.operation);
  return decision;
}
