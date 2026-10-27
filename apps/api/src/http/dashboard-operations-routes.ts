/**
 * کارهای عملیاتی داشبورد (دستهٔ D، مصوب مالک) — فقط‌خواندنی، برای یک شعبه.
 *
 * سه بخش، هر کدام با دروازهٔ مجوز **خودش** (`identity.can`)؛ بخشی که این نقش نمی‌بیند `denied` است، نه
 * صفر — و دادهٔ آن بخش اصلاً خوانده نمی‌شود:
 *
 *   شیفت‌ها    `report.view` (همان دروازهٔ مغایرت‌گیری نقد): شیفت‌های باز این شعبه — با «از روز قبل باز
 *              مانده» — و شمار شیفت‌های بسته‌شدهٔ امروز و آن‌هایی که مغایرت دارند.
 *   چک‌ها      `cheque.manage` (همان دروازهٔ `/cheques/due`): سررسیدگذشته و نزدیک‌به‌سررسید، دریافتی جدا از
 *              پرداختی، شمار و جمع دقیق در SQL — نه جمع فهرست سقف‌دار ۵۰۰تایی.
 *   دریافتنی   `report.view`: ماندهٔ خالص هر مشتری در **همین شعبه** با همان تعریف خلاصهٔ مشتری
 *              (`people/customer.ts`): جمع بدهکار − بستانکار سطرهای دفتر با `party_type = 'customer'` — فقط سند
 *              ثبت‌شده (`confirmed`/`final`)، مثل تراز آزمایشی؛ پیش‌نویس هنوز در دفتر نیست. مثبت
 *              = طلب ما، منفی = اعتبار مشتری؛ دو عدد جدا، هیچ‌کدام از دیگری کم نمی‌شود. «مانده» است، نه
 *              «سررسید گذشته» — سن طلب در این PR ساخته نمی‌شود.
 *   کمبود      `report.view`: شمار دقیق سطرهای (تنوع، انبار) کمبود در انبارهای فروشِ همین شعبه، از همان تعریفی که
 *              گزارش «کمبود موجودی» فهرستش را می‌دهد (`inventory.low_stock`، مهاجرت ۱۰۴). آستانه از
 *              `inventory.low_stock_threshold` می‌آید؛ نبودنش `unknown` است، نه صفر.
 *
 * دامنهٔ شعبه پیش از هر خواندن سنجیده می‌شود (`assertBranch`). پول رشته است.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError } from "../auth/service.ts";
import { can } from "../auth/permission.ts";
import { assertBranch } from "../sales/scope.ts";

/** نمونهٔ شیفت‌های باز: سقف صریح؛ شمار کل جدا می‌آید. */
export const OPEN_SHIFT_SAMPLE = 10;

type Denied = { state: "denied" };
type CountAmount = { count: number; amount: string };

export function registerDashboardOperationsRoutes(app: FastifyInstance, db: Db): void {
  app.get("/dashboard/operations", async (req, reply) => {
    const s = req.session as { userId: string; pinUnlocked: boolean } | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    const { branchId } = z.object({ branchId: z.string().uuid() }).parse(req.query);
    await assertBranch(db, s.userId, branchId);
    const allowed = async (operation: string) =>
      (await can(db, { userId: s.userId, operation, viaPin: s.pinUnlocked })).verdict === "allow";
    const [reportView, chequeManage] = await Promise.all([allowed("report.view"), allowed("cheque.manage")]);

    const day = await sql<{ business_date: string }>`SELECT platform.business_date()::text AS business_date`.execute(db);
    const businessDate = day.rows[0]!.business_date;

    reply.header("cache-control", "no-store");
    return {
      businessDate,
      branchId,
      shifts: reportView ? await readShifts(db, branchId) : ({ state: "denied" } satisfies Denied),
      cheques: chequeManage ? await readCheques(db, branchId) : ({ state: "denied" } satisfies Denied),
      receivables: reportView ? await readReceivables(db, branchId) : ({ state: "denied" } satisfies Denied),
      lowStock: reportView ? await readLowStock(db, branchId) : ({ state: "denied" } satisfies Denied),
    };
  });
}

async function readShifts(db: Db, branchId: string) {
  const open = await sql<{ id: string; user_name: string; opened_at: Date; carried_over: boolean }>`
    SELECT s.id::text, u.full_name AS user_name, s.opened_at,
           s.opened_at < platform.business_day_start(platform.business_date()) AS carried_over
      FROM sales.cash_shift s
      JOIN identity.app_user u ON u.id = s.user_id
     WHERE s.branch_id = ${branchId}::uuid AND s.status = 'open'
     ORDER BY s.opened_at, s.id
     LIMIT ${OPEN_SHIFT_SAMPLE}`.execute(db);
  const counts = await sql<{ open: string; carried_over: string; closed_today: string; variance_today: string }>`
    SELECT count(*) FILTER (WHERE status = 'open')::text AS open,
           count(*) FILTER (WHERE status = 'open'
                              AND opened_at < platform.business_day_start(platform.business_date()))::text AS carried_over,
           count(*) FILTER (WHERE status <> 'open'
                              AND closed_at >= platform.business_day_start(platform.business_date())
                              AND closed_at <  platform.business_day_start(platform.business_date() + 1))::text AS closed_today,
           count(*) FILTER (WHERE status <> 'open' AND variance <> 0
                              AND closed_at >= platform.business_day_start(platform.business_date())
                              AND closed_at <  platform.business_day_start(platform.business_date() + 1))::text AS variance_today
      FROM sales.cash_shift
     WHERE branch_id = ${branchId}::uuid`.execute(db);
  const c = counts.rows[0]!;
  return {
    state: "ready" as const,
    openCount: Number(c.open),
    carriedOverCount: Number(c.carried_over),
    closedToday: Number(c.closed_today),
    varianceToday: Number(c.variance_today),
    open: open.rows.map(r => ({ id: r.id, userName: r.user_name, openedAt: r.opened_at.toISOString(), carriedOver: r.carried_over })),
  };
}

async function readCheques(db: Db, branchId: string) {
  // همان نمای `treasury.cheque_due` (۰۰۵) با همان مرز `cheque.due_warning_days`؛ دامنهٔ شعبه با Join به
  // خودِ چک، چون نما `branch_id` ندارد.
  const rows = await sql<{ direction: "received" | "issued"; urgency: "overdue" | "due_soon"; n: string; amount: string; next_due: string }>`
    SELECT d.direction, d.urgency, count(*)::text AS n, sum(d.amount)::text AS amount, min(d.due_on)::text AS next_due
      FROM treasury.cheque_due d
      JOIN treasury.cheque c ON c.id = d.id
     WHERE c.branch_id = ${branchId}::uuid AND d.urgency IN ('overdue', 'due_soon')
     GROUP BY d.direction, d.urgency`.execute(db);
  // همان عبارت نما، تا مرز «نزدیک» در هر دو یکی باشد.
  const days = await sql<{ v: number | null }>`
    SELECT (SELECT value FROM platform.setting WHERE key = 'cheque.due_warning_days')::int AS v`.execute(db);
  const cell = (direction: "received" | "issued", urgency: "overdue" | "due_soon"): CountAmount & { nextDue: string | null } => {
    const r = rows.rows.find(x => x.direction === direction && x.urgency === urgency);
    return r ? { count: Number(r.n), amount: r.amount, nextDue: r.next_due } : { count: 0, amount: "0", nextDue: null };
  };
  return {
    state: "ready" as const,
    warningDays: days.rows[0]?.v ?? null,
    received: { overdue: cell("received", "overdue"), dueSoon: cell("received", "due_soon") },
    issued: { overdue: cell("issued", "overdue"), dueSoon: cell("issued", "due_soon") },
  };
}

async function readReceivables(db: Db, branchId: string) {
  const r = await sql<{ owed_n: string; owed: string; credit_n: string; credit: string }>`
    WITH p AS (
      SELECT l.party_id, sum(l.debit - l.credit) AS net
        FROM ledger.journal_line l
        JOIN ledger.journal_entry e ON e.id = l.entry_id
       WHERE l.party_type = 'customer' AND e.branch_id = ${branchId}::uuid
         AND e.status IN ('confirmed', 'final')
       GROUP BY l.party_id)
    SELECT count(*) FILTER (WHERE net > 0)::text AS owed_n,
           coalesce(sum(net) FILTER (WHERE net > 0), 0)::text AS owed,
           count(*) FILTER (WHERE net < 0)::text AS credit_n,
           coalesce(-sum(net) FILTER (WHERE net < 0), 0)::text AS credit
      FROM p`.execute(db);
  const x = r.rows[0]!;
  return {
    state: "ready" as const,
    owed: { count: Number(x.owed_n), amount: x.owed } satisfies CountAmount,
    credit: { count: Number(x.credit_n), amount: x.credit } satisfies CountAmount,
  };
}

async function readLowStock(db: Db, branchId: string) {
  const t = await sql<{ v: string | null }>`SELECT platform.setting_num('inventory.low_stock_threshold')::text AS v`.execute(db);
  const threshold = t.rows[0]?.v ?? null;
  if (threshold === null) return { state: "unknown" as const, reason: "آستانهٔ کمبود موجودی تعریف نشده است." };
  // هر انبار فروشِ فعال این شعبه یک ردیف دارد، حتی با شمار صفر؛ صفرِ واقعی از «نخوانده» جداست.
  const r = await sql<{ id: string; name: string; n: string }>`
    SELECT w.id::text, w.name, count(l.variation_id)::text AS n
      FROM inventory.warehouse w
      LEFT JOIN inventory.low_stock(${threshold}::numeric) l ON l.warehouse_id = w.id
     WHERE w.branch_id = ${branchId}::uuid AND w.is_active AND w.kind IN ('store', 'stock', 'outlet')
     GROUP BY w.id, w.name
     ORDER BY w.name, w.id`.execute(db);
  const warehouses = r.rows.map(x => ({ id: x.id, name: x.name, count: Number(x.n) }));
  return {
    state: "ready" as const,
    threshold,
    total: warehouses.reduce((a, w) => a + w.count, 0),
    warehouses,
  };
}
