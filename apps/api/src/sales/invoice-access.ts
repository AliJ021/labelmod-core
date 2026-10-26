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

/**
 * خواندن **یک** فاکتور مشخص (بازیابی سبد، چاپ رسید).
 *
 * اپراتور اینستاگرام (مهاجرت ۱۰۵) فقط `instagram.pos.sell` دارد و دروازهٔ عمومی بالا را
 * نمی‌گذرد؛ ولی صندوقِ خودش باید فاکتوری را که خودش در کانال اینستاگرام ساخته بخواند. پس
 * فقط وقتی دروازهٔ عمومی رد شد، و فقط برای فاکتور کانال اینستاگرام با همان سازنده، باز است.
 * فهرست و جست‌وجوی فاکتور (`/invoices`، `by-phone`، `lookup`) برایش باز نمی‌شود.
 *
 * ⚠️ مجوز **پیش از** بارگذاری فاکتور سنجیده می‌شود و ردِ استثنا همان خطای دروازهٔ عمومی
 *    است — چه فاکتور نباشد، چه مال دیگری باشد — تا وجود شناسه از پاسخ لو نرود.
 */
export async function requireInvoiceReadOf(
  db: Db,
  session: { userId: string; pinUnlocked: boolean },
  load: () => Promise<{ channel: string; createdBy: string | null } | null>,
): Promise<void> {
  try {
    await requireInvoiceRead(db, session);
  } catch (err) {
    const ig = await can(db, { userId: session.userId, operation: "instagram.pos.sell", viaPin: session.pinUnlocked });
    if (ig.verdict !== "allow") throw err;
    const inv = await load();
    if (inv?.channel === "instagram" && inv.createdBy === session.userId) return;
    throw err;
  }
}
