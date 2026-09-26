import type { Db } from "../db/client.ts";
import { can, requireForSession } from "../auth/permission.ts";

/** خواندن سند برای بازیابی صندوق یا شروع مرجوعی؛ دامنه شعبه جداگانه سنجیده می‌شود. */
export async function requireInvoiceRead(
  db: Db,
  session: { userId: string; pinUnlocked: boolean },
): Promise<void> {
  for (const operation of ["sale.create", "return.same_day"]) {
    const decision = await can(db, { userId: session.userId, operation, viaPin: session.pinUnlocked });
    if (decision.verdict === "allow") return;
  }
  await requireForSession(db, session, "return.late");
}
