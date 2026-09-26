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
import {
  BASKET_COLUMNS,
  COMPARE_COLUMNS,
  CUSTOMER_BASKET_COLUMNS,
  HOURLY_COLUMNS,
  LEDGER_COLUMNS,
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
      a.name AS "accountName",coalesce(i.number,ri.number) AS "invoiceNumber",coalesce(i.status,ri.status) AS "invoiceStatus",
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
