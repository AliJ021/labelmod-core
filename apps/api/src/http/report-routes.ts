import { sql } from "kysely";
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
 *
 * ── خروجی CSV از **همان** مسیر می‌آید، نه از مسیری جدا ─────────────
 *
 * `?format=csv` روی همان Endpoint. یک مسیر جدا برای دانلود یعنی دو
 * نسخه از همان دروازه‌ها — و آن که عقب می‌ماند همان است که دور زده
 * می‌شود. اینجا دامنه شعبه، `report.view` و پوشاندن بها **پیش از**
 * تصمیمِ قالب انجام شده‌اند، پس فایل دانلودی دقیقاً همان چیزی است که
 * صفحه نشان می‌دهد.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { assertBranch, branchesOf, ScopeError } from "../sales/scope.ts";
import type {
  MovementRow,
  Period,
  ReportService,
  SalesRow,
  CompareRow,
} from "../reports/service.ts";
import { contentDisposition, rowsToCsv } from "../lib/csv.ts";
import { serializeMoney } from "../lib/money.ts";
import {
  BASKET_COLUMNS,
  COMPARE_COLUMNS,
  CUSTOMER_BASKET_COLUMNS,
  HOURLY_COLUMNS,
  LEDGER_COLUMNS,
  LOW_STOCK_COLUMNS,
  MOVEMENT_COLUMNS,
  PARTY_COLUMNS,
  PROFIT_COLUMNS,
  SALES_COLUMNS,
  SHIFT_COLUMNS,
  TRIAL_COLUMNS,
  VALUATION_COLUMNS,
  type Columns,
} from "../reports/columns.ts";

const uuid = z.string().uuid("شناسه نامعتبر");
/** سقف فهرست کمبود موجودی؛ شمار کل جدا می‌آید. */
export const LOW_STOCK_LIMIT = 2000;
const isoDate = z.iso.date("تاریخ باید یک تاریخ معتبر YYYY-MM-DD باشد");

/**
 * بازه — و دو نگهبانی که یک گزارش را از یک حمله جدا می‌کنند.
 *
 * `to < from` یک بازه تهی است و خطای تایپی؛ پیامش باید بگوید چه شده،
 * نه اینکه یک جدول خالی نشان بدهد.
 */
/**
 * ستون‌هایی که ممکن است پوشانده شوند، `null` هم می‌گیرند.
 *
 * پوشاندن یعنی مقدار **برداشته** شود، نه صفر شود — و تایپ باید همان
 * را بگوید، وگرنه مصرف‌کننده فکر می‌کند همیشه رشته‌ای هست.
 */
type Masked<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

/** قالب خروجی — پیش‌فرض JSON، و CSV از همان مسیر. */
const formatQuery = z.object({ format: z.enum(["json", "csv"]).default("json") });

const periodQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    branchId: uuid.optional(),
  })
  .refine((v) => v.from <= v.to, {
    message: "تاریخ پایان نمی‌تواند پیش از تاریخ شروع باشد",
  });

/**
 * دوره مبنای مقایسه — **صریح از کلاینت**، نه محاسبه در سرور.
 *
 * وسوسه‌اش این بود که سرور «ماه قبل» را خودش حساب کند. ولی این
 * فروشگاه تاریخ را جلالی می‌بیند و «یک ماه قبلِ» میلادی با آن
 * نمی‌خواند: ۳۱ مرداد منهای یک ماه میلادی وسط تیر می‌افتد. مالک عددی
 * می‌دید که با تقویم خودش نمی‌خواند و هیچ خطایی هم نمی‌گرفت.
 *
 * پس مرزهای تقویمی جایی حساب می‌شوند که تقویم را می‌فهمد — مرورگر با
 * `Intl` — و اینجا فقط جمع مالی انجام می‌شود.
 */
const compareQuery = periodQuery
  .extend({ prevFrom: isoDate, prevTo: isoDate })
  .refine((v: { prevFrom: string; prevTo: string }) => v.prevFrom <= v.prevTo, {
    message: "تاریخ پایان دوره مبنا نمی‌تواند پیش از شروعش باشد",
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

  /**
   * فیلتر انباری که می‌توانیم ایمن به توابع گزارش بدهیم.
   *
   * این توابع `NULL` را «همه انبارها» می‌فهمند و فیلتر شعبه ندارند.
   * پس برای کاربر محدود حذف `warehouseId` نباید به `NULL` تبدیل شود:
   * انبار باید صریح انتخاب شود. فقط دامنهٔ سراسری می‌تواند `NULL`
   * بفرستد.
   */
  async function resolveWarehouse(
    userId: string,
    asked: string | undefined,
  ): Promise<string | undefined> {
    if (asked !== undefined) {
      const warehouse = await db
        .selectFrom("inventory.warehouse")
        .select("branch_id")
        .where("id", "=", asked)
        .executeTakeFirst();
      if (!warehouse) throw new ScopeError("انبار یافت نشد");
      await assertBranch(db, userId, warehouse.branch_id);
      return asked;
    }

    const scope = await branchesOf(db, userId);
    if (scope === "all") return undefined;
    if (scope.length === 0) throw new ScopeError("به هیچ شعبه‌ای دسترسی ندارید");
    throw new ScopeError("انبار را مشخص کنید");
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

  /**
   * پاسخ — JSON یا CSV، از یک منبع.
   *
   * ⚠️ `rows` که به اینجا می‌رسد **قبلاً** پوشانده شده: ستون بهایی که
   *    کاربر اجازه‌اش را ندارد `null` است. پس فایل CSV نمی‌تواند چیزی
   *    را لو بدهد که صفحه نمی‌دهد — و همین دلیل وجود این تابع است،
   *    به‌جای یک مسیر دانلود جدا.
   */
  function respond<T extends object>(
    reply: FastifyReply,
    format: "json" | "csv",
    name: { fa: string; ascii: string },
    columns: Columns,
    rows: readonly T[],
  ): { rows: readonly T[] } | undefined {
    if (format !== "csv") return { rows };

    // `text/csv` با charset صریح: بدون آن بعضی مرورگرها فایل را با
    // کدگذاری محلی باز می‌کنند و BOM هم نجاتش نمی‌دهد.
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", contentDisposition(name.fa, name.ascii))
      // فایل مالی نباید در حافظه پنهان مرورگر یا Proxy بماند.
      .header("cache-control", "no-store")
      // ⚠️ Cast لازم است چون تایپ‌های گزارش رابط‌های صریح‌اند و
      //    Index Signature ندارند — که **درست** است: رابط باز یعنی
      //    یک غلط تایپی در نام ستون، بی‌صدا از تایپ‌چکر رد شود.
      .send(rowsToCsv(columns, rows as readonly Record<string, unknown>[]));
    return undefined;
  }

  // ── فروش دوره‌ای ────────────────────────────────────────────────

  /**
   * فروش به تفکیک ساعتِ کاری.
   *
   * پشت `report.view` مثل بقیه، و بها ندارد — پس دروازه دوم لازم
   * نیست. پرسشش «چه ساعتی شلوغ است؟» است، نه «چقدر سود کردیم؟».
   */
  app.get("/reports/hourly", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.hourly(await period(s.userId, q));
    return respond(reply, format, { fa: "فروش ساعتی", ascii: "hourly" }, HOURLY_COLUMNS, rows);
  });

  /**
   * مقایسه دو دوره.
   *
   * سود در این گزارش یک ستون است نه ستون اصلی، پس بدون `cost.view`
   * همان ستون‌ها `null` می‌شوند — نه صفر. صفر یعنی «سودی نبود».
   */
  app.get("/reports/compare", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = compareQuery.parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const raw = await reports.compare(await period(s.userId, q), {
      from: q.prevFrom,
      to: q.prevTo,
    });

    const rows: readonly Masked<CompareRow, "profitAmount" | "prevProfitAmount">[] =
      (await seesCost(s))
        ? raw
        : raw.map((r) => ({ ...r, profitAmount: null, prevProfitAmount: null }));

    return respond(reply, format, { fa: "مقایسه دوره", ascii: "compare" }, COMPARE_COLUMNS, rows);
  });

  /**
   * خلاصهٔ دوره‌ای داشبورد (دستهٔ B؛ مهاجرت ۰۹۹) — بازه و دورهٔ مبنا کنار هم.
   *
   * - **هر عدد از SQL:** کانال‌ها از `sales.dashboard_period`، روش‌های پرداخت از
   *   `sales.dashboard_payment_mix`؛ جمع کل، میانگین کل و تفاضل دو دوره هم در
   *   همین کوئری‌ها (bigint دقیق، رشته در JSON). **درصدی ساخته نمی‌شود**:
   *   تفاضل مطلق است، و درصدِ مبنای صفر یا منفی ادعایی است که هیچ‌کس نکرده.
   * - **مرجوعی ≠ بازپرداخت:** `returnAmount` ارزش کالای برگشتی است و
   *   `refundedAmount` پولی که واقعاً پس داده شد؛ هر دو جدا می‌آیند.
   * - **دامنه:** شعبه از `resolveBranch` — دامنهٔ «همه» بی `branchId` یعنی همهٔ
   *   شعبه‌ها، تک‌شعبه همان شعبه، چندشعبه بی انتخاب ۴۲۲، شعبهٔ بیرونی ۴۰۳.
   *   `report.view` لازم است؛ سود بی `cost.view` در **همهٔ** سطرها `null`.
   * - **دورهٔ مبنا صریح از کلاینت** (همان دلیل `/reports/compare`: ماه جلالی را
   *   مرورگر می‌فهمد) و باید **پیش از** دوره باشد؛ هم‌پوشانی دو بار شمردن است.
   *   آینده داده نیست: پایانِ پس از امروز ۴۰۰ می‌گیرد، نه صفر.
   */
  app.get("/reports/dashboard/period", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = compareQuery
      .refine((v: { prevTo: string; from: string }) => v.prevTo < v.from, {
        message: "دورهٔ مبنا باید پیش از دوره تمام شود",
        path: ["prevTo"],
      })
      .parse(req.query);
    const branchId = (await resolveBranch(s.userId, q.branchId)) ?? null;
    const profitVisible = await seesCost(s);

    const check = await sql<{ today: string; span: number; prev_span: number }>`
      SELECT platform.business_date()::text AS today,
             (${q.to}::date - ${q.from}::date) AS span,
             (${q.prevTo}::date - ${q.prevFrom}::date) AS prev_span`.execute(db);
    const { today, span, prev_span } = check.rows[0]!;
    const invalid = (path: string, message: string) =>
      new z.ZodError([{ code: "custom", path: [path], message, input: q }]);
    if (span >= 400 || prev_span >= 400) throw invalid("from", "هر دوره حداکثر ۴۰۰ روز است");
    if (q.to > today) throw invalid("to", "پایان دوره از امروز جلوتر است");

    // یک سطر برای هر کانال و یک سطر جمع (`channel` تهی)؛ هر سطر دورهٔ جاری،
    // دورهٔ مبنا و تفاضل را کنار هم دارد — همه در SQL و دقیق.
    const channels = await sql<Record<string, string | null>>`
      WITH ch AS (
        SELECT 1 AS sign, c.* FROM sales.dashboard_period(${branchId}::uuid, ${q.from}::date, ${q.to}::date) c
        UNION ALL
        SELECT -1, p.* FROM sales.dashboard_period(${branchId}::uuid, ${q.prevFrom}::date, ${q.prevTo}::date) p
      ),
      g AS (
        SELECT CASE WHEN GROUPING(channel) = 1 THEN NULL ELSE channel END AS channel,
               GROUPING(channel) AS is_total,
               min(CASE channel WHEN 'pos' THEN 0 WHEN 'web' THEN 1 ELSE 2 END) AS ord,
               sum(invoice_count) FILTER (WHERE sign = 1)  AS c_n,  sum(invoice_count) FILTER (WHERE sign = -1)  AS p_n,
               sum(gross_amount)  FILTER (WHERE sign = 1)  AS c_g,  sum(gross_amount)  FILTER (WHERE sign = -1)  AS p_g,
               sum(return_count)  FILTER (WHERE sign = 1)  AS c_rn, sum(return_count)  FILTER (WHERE sign = -1)  AS p_rn,
               sum(return_amount) FILTER (WHERE sign = 1)  AS c_r,  sum(return_amount) FILTER (WHERE sign = -1)  AS p_r,
               sum(sales_amount)  FILTER (WHERE sign = 1)  AS c_s,  sum(sales_amount)  FILTER (WHERE sign = -1)  AS p_s,
               sum(profit_amount) FILTER (WHERE sign = 1)  AS c_p,  sum(profit_amount) FILTER (WHERE sign = -1)  AS p_p
          FROM ch
         GROUP BY GROUPING SETS ((channel), ())
      ),
      a AS (
        -- میانگین از جمع‌ها، نه میانگینِ میانگین‌ها؛ بی فاکتور تهی.
        SELECT g.*,
               CASE WHEN coalesce(c_n, 0) = 0 THEN NULL ELSE round(c_g / c_n) END AS c_avg,
               CASE WHEN coalesce(p_n, 0) = 0 THEN NULL ELSE round(p_g / p_n) END AS p_avg
          FROM g
      )
      SELECT channel,
             coalesce(c_n, 0)::text  AS c_invoice_count,  coalesce(p_n, 0)::text  AS p_invoice_count,
             coalesce(c_g, 0)::text  AS c_gross_amount,   coalesce(p_g, 0)::text  AS p_gross_amount,
             coalesce(c_rn, 0)::text AS c_return_count,   coalesce(p_rn, 0)::text AS p_return_count,
             coalesce(c_r, 0)::text  AS c_return_amount,  coalesce(p_r, 0)::text  AS p_return_amount,
             coalesce(c_s, 0)::text  AS c_sales_amount,   coalesce(p_s, 0)::text  AS p_sales_amount,
             coalesce(c_p, 0)::text  AS c_profit_amount,  coalesce(p_p, 0)::text  AS p_profit_amount,
             c_avg::text AS c_average_invoice, p_avg::text AS p_average_invoice,
             (coalesce(c_n, 0) - coalesce(p_n, 0))::text   AS d_invoice_count,
             (coalesce(c_g, 0) - coalesce(p_g, 0))::text   AS d_gross_amount,
             (coalesce(c_rn, 0) - coalesce(p_rn, 0))::text AS d_return_count,
             (coalesce(c_r, 0) - coalesce(p_r, 0))::text   AS d_return_amount,
             (coalesce(c_s, 0) - coalesce(p_s, 0))::text   AS d_sales_amount,
             (coalesce(c_p, 0) - coalesce(p_p, 0))::text   AS d_profit_amount,
             (c_avg - p_avg)::text AS d_average_invoice
        FROM a
       ORDER BY is_total, ord, channel`.execute(db);

    // همان شکل برای روش‌های پرداخت. روشی که فقط در یکی از دو دوره پول داشته،
    // در دیگری صفر است (پرداخت موفقی نبود)، نه «نامعلوم».
    const payments = await sql<Record<string, string | null>>`
      WITH pm AS (
        SELECT 1 AS sign, c.* FROM sales.dashboard_payment_mix(${branchId}::uuid, ${q.from}::date, ${q.to}::date) c
        UNION ALL
        SELECT -1, p.* FROM sales.dashboard_payment_mix(${branchId}::uuid, ${q.prevFrom}::date, ${q.prevTo}::date) p
      ),
      g AS (
        SELECT CASE WHEN GROUPING(method_code) = 1 THEN NULL ELSE method_code END AS method_code,
               max(method_name) AS method_name,
               GROUPING(method_code) AS is_total,
               coalesce(sum(received_amount) FILTER (WHERE sign = 1), 0)  AS c_in,
               coalesce(sum(received_amount) FILTER (WHERE sign = -1), 0) AS p_in,
               coalesce(sum(refunded_amount) FILTER (WHERE sign = 1), 0)  AS c_out,
               coalesce(sum(refunded_amount) FILTER (WHERE sign = -1), 0) AS p_out,
               coalesce(sum(net_amount) FILTER (WHERE sign = 1), 0)       AS c_net,
               coalesce(sum(net_amount) FILTER (WHERE sign = -1), 0)      AS p_net,
               coalesce(sum(payment_count) FILTER (WHERE sign = 1), 0)    AS c_n,
               coalesce(sum(payment_count) FILTER (WHERE sign = -1), 0)   AS p_n,
               coalesce(sum(refund_count) FILTER (WHERE sign = 1), 0)     AS c_rn,
               coalesce(sum(refund_count) FILTER (WHERE sign = -1), 0)    AS p_rn
          FROM pm
         GROUP BY GROUPING SETS ((method_code), ())
      )
      SELECT method_code, method_name,
             c_in::text AS c_received_amount, p_in::text AS p_received_amount,
             c_out::text AS c_refunded_amount, p_out::text AS p_refunded_amount,
             c_net::text AS c_net_amount, p_net::text AS p_net_amount,
             c_n::text AS c_payment_count, p_n::text AS p_payment_count,
             c_rn::text AS c_refund_count, p_rn::text AS p_refund_count,
             (c_in - p_in)::text AS d_received_amount, (c_out - p_out)::text AS d_refunded_amount,
             (c_net - p_net)::text AS d_net_amount,
             (c_n - p_n)::text AS d_payment_count, (c_rn - p_rn)::text AS d_refund_count
        FROM g
       ORDER BY is_total DESC, c_in DESC, method_code`.execute(db);

    const money = (v: string | null | undefined) => serializeMoney(BigInt(v ?? "0"));
    const optMoney = (v: string | null | undefined) => (v === null || v === undefined ? null : money(v));
    type Side = "c" | "p" | "d";
    const salesView = (r: Record<string, string | null>, x: Side) => ({
      invoiceCount: Number(r[`${x}_invoice_count`]),
      grossAmount: money(r[`${x}_gross_amount`]),
      returnCount: Number(r[`${x}_return_count`]),
      returnAmount: money(r[`${x}_return_amount`]),
      salesAmount: money(r[`${x}_sales_amount`]),
      profitAmount: profitVisible ? money(r[`${x}_profit_amount`]) : null,
      averageInvoice: optMoney(r[`${x}_average_invoice`]),
    });
    const payView = (r: Record<string, string | null>, x: Side) => ({
      receivedAmount: money(r[`${x}_received_amount`]),
      refundedAmount: money(r[`${x}_refunded_amount`]),
      netAmount: money(r[`${x}_net_amount`]),
      paymentCount: Number(r[`${x}_payment_count`]),
      refundCount: Number(r[`${x}_refund_count`]),
    });
    // جمع سطرِ تهی است و همیشه وجود دارد (GROUPING SETS با () حتی بی سطر، یک سطر می‌دهد).
    const salesTotal = channels.rows.find((r) => r.channel === null);
    const payTotal = payments.rows.find((r) => r.method_code === null);
    if (!salesTotal || !payTotal) throw new Error("خلاصهٔ دوره سطر جمع برنگرداند");
    const salesRows = channels.rows.filter((r) => r.channel !== null);
    const payRows = payments.rows.filter((r) => r.method_code !== null);
    const side = (x: Side) => ({
      totals: salesView(salesTotal, x),
      channels: salesRows.map((r) => ({ channel: r.channel as string, ...salesView(r, x) })),
      payments: {
        totals: payView(payTotal, x),
        methods: payRows.map((r) => ({
          methodCode: r.method_code as string,
          methodName: r.method_name as string,
          ...payView(r, x),
        })),
      },
    });

    return {
      businessDate: today,
      branchId,
      profitVisible,
      current: { from: q.from, to: q.to, partial: q.to === today, ...side("c") },
      previous: { from: q.prevFrom, to: q.prevTo, ...side("p") },
      delta: side("d"),
    };
  });

  /**
   * تحلیل سبد — «ده قلم را یک نفر برد یا ده نفر؟»
   *
   * ⚠️ پشت `report.customer_insight` است، نه `report.view`.
   *
   * دلیلش رفتار مشتری است، نه عدد فروش: این گزارش می‌گوید چه کسی چه
   * چیزی خریده. صندوق‌دار برای کارش لازمش ندارد و سرپرست هم. مالک
   * می‌تواند در صفحه «مجوزها» به هر نقشی بدهدش — همان‌طور که هر
   * مجوز دیگری. **هیچ شرط دسترسی در کد نیست**؛ این یک ردیف در
   * `permission_rule` است.
   */
  app.get("/reports/basket", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.customer_insight");
    const q = periodQuery.parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.basket(await period(s.userId, q));
    return respond(reply, format, { fa: "تحلیل سبد", ascii: "basket" }, BASKET_COLUMNS, rows);
  });

  /**
   * همان پرسش، در سطح شخص — با نام و موبایل مشتری.
   *
   * پشت همان دروازه، و به همان دلیل: این داده **شخصی** است.
   */
  app.get("/reports/customer-basket", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.customer_insight");
    const q = periodQuery
      .extend({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.customerBasket(await period(s.userId, q), q.limit);
    return respond(
      reply,
      format,
      { fa: "خرید هر مشتری", ascii: "customer-basket" },
      CUSTOMER_BASKET_COLUMNS,
      rows,
    );
  });

  app.get("/reports/snappay", async req => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.extend({page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(req.query);
    const p = await period(s.userId, q);
    const filter = sql`pay.method_code='snappay' AND pay.status IN ('succeeded','settled','reconciled')
      AND platform.business_date(pay.occurred_at) BETWEEN ${p.from}::date AND ${p.to}::date
      AND (${p.branchId ?? null}::uuid IS NULL OR coalesce(i.branch_id,r.branch_id)=${p.branchId ?? null}::uuid)`;
    const rows=await sql`SELECT pay.id,pay.occurred_at AS "occurredAt",pay.direction,pay.amount::text,pay.ref_no AS reference,
      a.name AS "accountName",coalesce(sales.invoice_display_number(i.id),sales.invoice_display_number(ri.id)) AS "invoiceNumber",coalesce(i.status,ri.status) AS "invoiceStatus",
      r.number AS "returnNumber",pay.status,coalesce(i.branch_id,r.branch_id) AS "branchId"
      FROM treasury.payment pay LEFT JOIN sales.invoice i ON i.id=pay.invoice_id
      LEFT JOIN sales.sale_return r ON r.id=pay.return_id LEFT JOIN sales.invoice ri ON ri.id=r.invoice_id
      LEFT JOIN treasury.account a ON a.id=pay.account_id WHERE ${filter}
      ORDER BY pay.occurred_at DESC,pay.id DESC LIMIT 50 OFFSET ${(q.page-1)*50}`.execute(db);
    const totals=await sql<{total:number;received:string;refunded:string;net:string}>`SELECT count(*)::int AS total,
      coalesce(sum(pay.amount) FILTER(WHERE pay.direction='in'),0)::text AS received,
      coalesce(sum(pay.amount) FILTER(WHERE pay.direction='out'),0)::text AS refunded,
      coalesce(sum(CASE WHEN pay.direction='in' THEN pay.amount ELSE -pay.amount END),0)::text AS net
      FROM treasury.payment pay LEFT JOIN sales.invoice i ON i.id=pay.invoice_id
      LEFT JOIN sales.sale_return r ON r.id=pay.return_id WHERE ${filter}`.execute(db);
    return {rows:rows.rows, ...totals.rows[0], page:q.page};
  });

  app.get("/reports/staff-sales", async req => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.extend({ basis: z.enum(["finalizer", "creator"]).default("finalizer") }).parse(req.query);
    const p = await period(s.userId, q);
    const actor = q.basis === "creator" ? sql`i.created_by` : sql`i.finalized_by`;
    const rows = await sql`
      WITH events AS (
        SELECT ${actor} AS actor,1::bigint AS count,i.gross_amount AS gross,i.discount_amount AS discount,0::numeric AS returned
        FROM sales.invoice i WHERE i.finalized_at IS NOT NULL AND i.status IN ('finalized','paid','partially_returned','returned')
          AND platform.business_date(i.occurred_at) BETWEEN ${p.from}::date AND ${p.to}::date
          AND (${p.branchId ?? null}::uuid IS NULL OR i.branch_id=${p.branchId ?? null}::uuid)
        UNION ALL
        SELECT ${actor},0,0,0,r.net_amount FROM sales.sale_return r JOIN sales.invoice i ON i.id=r.invoice_id
        WHERE r.status='posted' AND platform.business_date(r.occurred_at) BETWEEN ${p.from}::date AND ${p.to}::date
          AND (${p.branchId ?? null}::uuid IS NULL OR r.branch_id=${p.branchId ?? null}::uuid)
      ) SELECT e.actor AS "userId",u.full_name AS "userName",sum(e.count)::text AS "invoiceCount",
        sum(e.gross)::text AS "grossAmount",sum(e.discount)::text AS "discountAmount",sum(e.returned)::text AS "returnedAmount",
        (sum(e.gross)-sum(e.discount)-sum(e.returned))::text AS "netSalesAmount"
      FROM events e LEFT JOIN identity.app_user u ON u.id=e.actor GROUP BY e.actor,u.full_name
      ORDER BY sum(e.gross)-sum(e.discount)-sum(e.returned) DESC,e.actor NULLS LAST`.execute(db);
    return { rows: rows.rows, basis: q.basis };
  });

  app.get("/reports/sales", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const raw = await reports.sales(await period(s.userId, q));

    // بها و سود برداشته می‌شوند، نه صفر می‌شوند — و **پیش از** تصمیم
    // قالب، تا فایل CSV همان چیزی باشد که صفحه نشان می‌دهد.
    const rows: readonly Masked<SalesRow, "cogsAmount" | "profitAmount">[] =
      (await seesCost(s))
        ? raw
        : raw.map((r) => ({ ...r, cogsAmount: null, profitAmount: null }));

    return respond(reply, format, { fa: "فروش دوره‌ای", ascii: "sales" }, SALES_COLUMNS, rows);
  });

  // ── سود به تفکیک کالا — کلاً پشت `cost.view` ─────────────────────

  app.get("/reports/profit-by-product", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    await requireForSession(db, s, "cost.view");
    const q = periodQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.profitByProduct(await period(s.userId, q), q.limit);
    return respond(reply, format, { fa: "سود کالا", ascii: "profit" }, PROFIT_COLUMNS, rows);
  });

  // ── موجودی و ارزش ───────────────────────────────────────────────

  app.get("/reports/inventory-valuation", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    await requireForSession(db, s, "cost.view");
    const q = z.object({ warehouseId: uuid.optional() }).parse(req.query);
    const warehouseId = await resolveWarehouse(s.userId, q.warehouseId);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.valuation(warehouseId);
    return respond(
      reply,
      format,
      { fa: "ارزش موجودی", ascii: "valuation" },
      VALUATION_COLUMNS,
      rows,
    );
  });

  // ── کمبود موجودی ────────────────────────────────────────────────

  /**
   * فهرست (تنوع، انبار)های کمبود — همان تعریفِ شمار داشبورد (`inventory.low_stock`، ۱۰۴).
   *
   * بها ندارد، پس فقط `report.view`. دامنه مثل بقیه: انبار انتخابی باید در دامنهٔ کاربر باشد و بی آن،
   * `resolveBranch` شعبه را تعیین می‌کند (دامنهٔ سراسری = همه). شمار کل جدا و دقیق است؛ فهرست سقف دارد
   * و `truncated` آن را صریح می‌گوید. آستانهٔ نامعلوم `null` است و CSV نمی‌گیرد — فایل خالی شبیه «کمبودی نیست» بود.
   */
  app.get("/reports/low-stock", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = z.object({ branchId: uuid.optional(), warehouseId: uuid.optional() }).parse(req.query);
    const { format } = formatQuery.parse(req.query);
    let branchId: string | undefined;
    if (q.warehouseId !== undefined) {
      const w = await db.selectFrom("inventory.warehouse").select("branch_id").where("id", "=", q.warehouseId).executeTakeFirst();
      if (!w) throw new ScopeError("انبار یافت نشد");
      await assertBranch(db, s.userId, w.branch_id);
      if (q.branchId !== undefined && q.branchId !== w.branch_id) throw new ScopeError("انبار در این شعبه نیست");
      branchId = w.branch_id;
    } else {
      branchId = await resolveBranch(s.userId, q.branchId);
    }
    const out = await reports.lowStock({ branchId, warehouseId: q.warehouseId, limit: LOW_STOCK_LIMIT });
    reply.header("cache-control", "no-store");
    if (out.threshold === null) {
      if (format === "csv") return reply.code(409).send({ error: { code: "threshold_unknown", message: "آستانهٔ کمبود موجودی تعریف نشده است." } });
      return out;
    }
    if (format === "csv") return respond(reply, format, { fa: "کمبود موجودی", ascii: "low-stock" }, LOW_STOCK_COLUMNS, out.rows);
    return out;
  });

  // ── کاردکس یک کالا ──────────────────────────────────────────────

  app.get("/reports/stock-movements", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery
      .extend({ variationId: uuid, warehouseId: uuid.optional() })
      .parse(req.query);
    const warehouseId = await resolveWarehouse(s.userId, q.warehouseId);

    const rows = await reports.movements({
      variationId: q.variationId,
      from: q.from,
      to: q.to,
      ...(warehouseId === undefined ? {} : { warehouseId }),
    });

    const { format } = formatQuery.parse(req.query);
    const masked: readonly Masked<MovementRow, "unitCost" | "valueDelta">[] =
      (await seesCost(s))
        ? rows
        : rows.map((r) => ({ ...r, unitCost: null, valueDelta: null }));
    return respond(reply, format, { fa: "کاردکس", ascii: "kardex" }, MOVEMENT_COLUMNS, masked);
  });

  // ── دفتر یک حساب ────────────────────────────────────────────────

  app.get("/reports/account-ledger", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.extend({ code: z.string().min(1).max(32) }).parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.accountLedger(q.code, await period(s.userId, q));
    return respond(reply, format, { fa: "دفتر حساب", ascii: "ledger" }, LEDGER_COLUMNS, rows);
  });

  // ── تراز آزمایشی ────────────────────────────────────────────────

  app.get("/reports/trial-balance", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.trialBalance(await period(s.userId, q));
    return respond(reply, format, { fa: "تراز آزمایشی", ascii: "trial-balance" }, TRIAL_COLUMNS, rows);
  });

  // ── دریافتنی و پرداختنی ─────────────────────────────────────────

  app.get("/reports/party-balances", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = z
      .object({ partyType: z.enum(["customer", "supplier"]).optional() })
      .parse(req.query);
    // مانده اشخاص شعبه ندارد: بدهی یک مشتری به فروشگاه است، نه به یک
    // شعبه. پس دامنه شعبه اینجا اعمال نمی‌شود و `report.view` تنها
    // دروازه است — همان‌طور که در `party_tafsili` هم شعبه‌ای نیست.
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.partyBalances(q.partyType);
    return respond(reply, format, { fa: "مانده اشخاص", ascii: "parties" }, PARTY_COLUMNS, rows);
  });

  // ── مغایرت‌گیری نقد ─────────────────────────────────────────────

  app.get("/reports/cash-reconciliation", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "report.view");
    const q = periodQuery.parse(req.query);
    const { format } = formatQuery.parse(req.query);
    const rows = await reports.cashReconciliation(await period(s.userId, q));
    return respond(reply, format, { fa: "مغایرت نقد", ascii: "cash" }, SHIFT_COLUMNS, rows);
  });
}
