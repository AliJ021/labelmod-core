/**
 * دامنه شعبه — چیزی که در بازبینی امنیتی جا افتاده بود.
 *
 * `identity.user_role` ستون `branch_id` دارد و لایه API کاملاً
 * نادیده‌اش می‌گرفت: هر کاربری می‌توانست `branchId` و `warehouseId`
 * دلخواه بفرستد و از انبار هر شعبه‌ای بفروشد.
 *
 * امروز یک شعبه بیشتر نیست، پس اثر عملی ندارد. ولی الگویی که ستون
 * دسترسی را نادیده بگیرد، با شعبه دوم بی‌صدا به نشت تبدیل می‌شود —
 * و آن‌وقت کسی باید همه مسیرها را دوباره پیدا کند.
 *
 * `branch_id = NULL` در نقش یعنی «همه شعب» — مدیر و حسابدار.
 */
import type { Db } from "../db/client.ts";

export class ScopeError extends Error {
  readonly statusCode = 403;
  readonly code = "branch_forbidden";

  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/** شعبه‌هایی که کاربر به آن‌ها دسترسی دارد. تهی یعنی همه. */
export async function branchesOf(db: Db, userId: string): Promise<string[] | "all"> {
  const rows = await db
    .selectFrom("identity.user_role")
    .select("branch_id")
    .where("user_id", "=", userId)
    .execute();

  if (rows.length === 0) return [];
  if (rows.some((r) => r.branch_id === null)) return "all";
  return rows.map((r) => r.branch_id as string);
}

export async function assertBranch(db: Db, userId: string, branchId: string): Promise<void> {
  const allowed = await branchesOf(db, userId);
  if (allowed === "all") return;
  if (!allowed.includes(branchId)) {
    throw new ScopeError("به این شعبه دسترسی ندارید");
  }
}

/**
 * انبار باید متعلق به همان شعبه باشد.
 *
 * بدون این، کاربرِ شعبه A می‌توانست فاکتور شعبه A بسازد ولی کالا را از
 * انبار شعبه B بردارد — و موجودی شعبه B بی‌آنکه کسی بفهمد کم می‌شد.
 */
export async function assertWarehouseInBranch(
  db: Db,
  warehouseId: string,
  branchId: string,
): Promise<void> {
  const wh = await db
    .selectFrom("inventory.warehouse")
    .select(["id", "branch_id", "code"])
    .where("id", "=", warehouseId)
    .executeTakeFirst();

  if (!wh) throw new ScopeError("انبار یافت نشد");
  if (wh.branch_id !== branchId) {
    throw new ScopeError(`انبار «${wh.code}» متعلق به این شعبه نیست`);
  }
}
