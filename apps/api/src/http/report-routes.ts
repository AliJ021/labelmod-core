/**
 * مسیرهای گزارش — هشت پرسش، سه دروازه.
 *
 * ── دامنه شعبه: نبودِ فیلتر یعنی «همه»، و آن یک نشت است ────────────
 *
 * توابع گزارش `p_branch IS NULL` را «همه شعبه‌ها» می‌فهمند. اگر مسیر
 * پارامتر نداشتِ کلاینت را مستقیم به دیتابیس می‌داد، صندوق‌دار شعبه A
 * با حذف یک Query String فروش شعبه B را می‌دید.
 *
 * پس `resolveBranch()` تصمیم می‌گیرد، نه کلاینت:
 *
 *   دامنه «همه» (مدیر و حسابدار)  → NULL، یعنی همه
 *   یک شعبه                        → همان، چه فرستاده باشد چه نه
 *   چند شعبه و بدون انتخاب         → ۴۲۲، نه حدس
 *   شعبه‌ای که مال او نیست          → ۴۰۳ از `assertBranch`
 *
 * ── سه دروازه، نه یکی ─────────────────────────────────────────────
 *
 * `report.view` اجازه دیدن گزارش است و `cost.view` اجازه دیدن **بها و
 * سود**. جدا هستند چون سرپرست فروشگاه باید فروش روزش را ببیند ولی
 * حاشیه سود کالا تصمیم مالک است.
 *
 * گزارشی که بها ستون اصلی‌اش است (سود کالا، ارزش موجودی) کلاً پشت
 * `cost.view` است. گزارشی که بها یک ستون از چند ستون است (فروش
 * دوره‌ای، کاردکس)، بدون آن مجوز همان ستون‌ها را `null` برمی‌گرداند —
 * **نه صفر**. صفر یک ادعای مالی است؛ «اجازه دیدنش را نداری» ادعای
 * دیگری، و یکی‌کردنشان یعنی مالک فکر کند سود صفر بوده.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { assertBranch, branchesOf, ScopeError } from "../sales/scope.ts";
import type { Period, ReportService } from "../reports/service.ts";

const uuid = z.string().uuid("شناسه نامعتبر");
const isoDate = z.iso.date("تاریخ باید یک تاریخ معتبر YYYY-MM-DD باشد");

/**
 * بازه — و دو نگهبانی که یک گزارش را از یک حمله جدا می‌کنند.
 *
 * `to < from` یک بازه تهی است و خطای تایپی؛ پیامش باید بگوید چه شده،
 * نه اینکه یک جدول خالی نشان بدهد.
 */
const periodQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    branchId: uuid.optional(),
  })
  .refine((v) => v.from <= v.to, {
    message: "تاریخ پایان نمی‌تواند پیش از تاریخ شروع باشد",
  });

export interface ReportRouteDeps {
  db: Db;
  reports: ReportService;
}

export function registerReportRoutes(app: FastifyInstance, deps: ReportRouteDeps): void {
  const { db, reports } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * کدام شعبه؟ — تصمیم سرور، نه کلاینت.
   *
   * `undefined` در خروجی یعنی «همه شعبه‌ها» و **فقط** برای کسی که
   * دامنه‌اش واقعاً همه است.
   */
  async function resolveBranch(
    userId: string,
    asked: string | undefined,
  ): Promise<string | undefined> {
    if (asked !== undefined) {
      await assertBranch(db, userId, asked);
      return asked;
    }
    const scope = await branchesOf(db, userId);
    if (scope === "all") return undefined;
    if (scope.length === 0) throw new ScopeError("به هیچ شعبه‌ای دسترسی ندارید");
    if (scope.length === 1) return scope[0] as string;
    throw new ScopeError("شعبه را مشخص کنید");
  }

  const period = async (userId: string, q: z.infer<typeof periodQuery>): Promise<Period> => ({
    from: q.from,
    to: q.to,
    branchId: await resolveBranch(userId, q.branchId),
  });

  /** آیا این کاربر بها و سود را می‌بیند؟ */
  const seesCost = async (s: { userId: string; pinUnlocked: boolean }): Promise<boolean> =>
    (
      await can(db, {
        userId: s.userId,
        operation: "cost.view",
        viaPin: s.pinUnlocked,
      })
    ).verdict === "allow";

  // ── فروش دوره‌ای ────────────────────────────────────────────────

  app.get("/reports/sales", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    const rows = await reports.sales(await period(s.userId, q));

    if (await seesCost(s)) return { rows };
    // بها و سود برداشته می‌شوند، نه صفر می‌شوند.
    return {
      rows: rows.map((r) => ({ ...r, cogsAmount: null, profitAmount: null })),
    };
  });

  // ── سود به تفکیک کالا — کلاً پشت `cost.view` ─────────────────────

  app.get("/reports/profit-by-product", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    await requireForSession(db, s, "cost.view");
    const q = periodQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    return { rows: await reports.profitByProduct(await period(s.userId, q), q.limit) };
  });

  // ── موجودی و ارزش ───────────────────────────────────────────────

  app.get("/reports/inventory-valuation", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    await requireForSession(db, s, "cost.view");
    const q = z.object({ warehouseId: uuid.optional() }).parse(req.query);
    // انبار به شعبه بسته است و `assertWarehouseInBranch` همان را
    // می‌سنجد؛ اینجا دامنه از راه شعبهٔ انبار اعمال می‌شود.
    if (q.warehouseId !== undefined) {
      const w = await db
        .selectFrom("inventory.warehouse")
        .select("branch_id")
        .where("id", "=", q.warehouseId)
        .executeTakeFirst();
      if (!w) throw new ScopeError("انبار یافت نشد");
      await assertBranch(db, s.userId, w.branch_id);
    } else {
      // بدون انتخاب انبار، فقط کسی که دامنه‌اش همه شعبه‌هاست می‌تواند
      // کل ارزش موجودی را ببیند.
      await resolveBranch(s.userId, undefined);
    }
    return {
      rows: await reports.valuation(q.warehouseId),
    };
  });

  // ── کاردکس یک کالا ──────────────────────────────────────────────

  app.get("/reports/stock-movements", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery
      .extend({ variationId: uuid, warehouseId: uuid.optional() })
      .parse(req.query);

    if (q.warehouseId !== undefined) {
      const w = await db
        .selectFrom("inventory.warehouse")
        .select("branch_id")
        .where("id", "=", q.warehouseId)
        .executeTakeFirst();
      if (!w) throw new ScopeError("انبار یافت نشد");
      await assertBranch(db, s.userId, w.branch_id);
    }

    const rows = await reports.movements({
      variationId: q.variationId,
      from: q.from,
      to: q.to,
      ...(q.warehouseId === undefined ? {} : { warehouseId: q.warehouseId }),
    });

    if (await seesCost(s)) return { rows };
    return { rows: rows.map((r) => ({ ...r, unitCost: null, valueDelta: null })) };
  });

  // ── دفتر یک حساب ────────────────────────────────────────────────

  app.get("/reports/account-ledger", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.extend({ code: z.string().min(1).max(32) }).parse(req.query);
    return { rows: await reports.accountLedger(q.code, await period(s.userId, q)) };
  });

  // ── تراز آزمایشی ────────────────────────────────────────────────

  app.get("/reports/trial-balance", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    return { rows: await reports.trialBalance(await period(s.userId, q)) };
  });

  // ── دریافتنی و پرداختنی ─────────────────────────────────────────

  app.get("/reports/party-balances", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = z
      .object({ partyType: z.enum(["customer", "supplier"]).optional() })
      .parse(req.query);
    // مانده اشخاص شعبه ندارد: بدهی یک مشتری به فروشگاه است، نه به یک
    // شعبه. پس دامنه شعبه اینجا اعمال نمی‌شود و `report.view` تنها
    // دروازه است — همان‌طور که در `party_tafsili` هم شعبه‌ای نیست.
    return { rows: await reports.partyBalances(q.partyType) };
  });

  // ── مغایرت‌گیری نقد ─────────────────────────────────────────────

  app.get("/reports/cash-reconciliation", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    return { rows: await reports.cashReconciliation(await period(s.userId, q)) };
  });
}
