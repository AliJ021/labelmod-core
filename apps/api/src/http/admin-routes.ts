/**
 * کدینگ حساب و سقف مجوزها — از صفحه، نه از psql.
 *
 * مالک خواست «برای هر تغییر کوچک نیاز به کد زدن نباشد». تنظیمات
 * ساده از قبل این را داشتند، چون صفحه‌شان خودکار از `platform.setting`
 * ساخته می‌شود. ولی این دو **کلید تنظیم نیستند، جدول‌اند**:
 *
 *   کدینگ حساب  → `ledger.account`          (درخت چهارسطحی)
 *   سقف مجوزها  → `identity.permission_rule` (به‌ازای هر نقش)
 *
 * پس صفحه خودکار جوابشان نمی‌داد و مسیر واقعی لازم داشتند.
 *
 * ── مجوز ────────────────────────────────────────────────────────────
 *
 * هر دو پشت `settings.security` می‌نشینند، نه `settings.manage`:
 *
 * کدینگ حساب تعیین می‌کند فروش به کدام حساب می‌رود. سقف مجوز تعیین
 * می‌کند صندوق‌دار چقدر تخفیف می‌دهد. هیچ‌کدام «تنظیم عملیاتی» نیستند
 * — اشتباهشان هر روز در دفتر تکرار می‌شود بی‌آنکه چیزی قرمز شود.
 *
 * ── چرا اعتبارسنجی اینجا نیست ───────────────────────────────────────
 *
 * همان دلیلی که صفحه تنظیمات دارد: قاعده در دیتابیس است
 * (`ledger.upsert_account`، `identity.set_permission_rule`). اگر Zod
 * هم می‌سنجید، دو نسخه از یک قاعده داشتیم و آن که در psql دور زده
 * می‌شود همان است که اهمیت دارد. Zod اینجا فقط **شکل** بدنه را
 * می‌گیرد، نه معنایش.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { withActor } from "../db/actor.ts";
import type { Db } from "../db/client.ts";
import { serializeMoney } from "../lib/money.ts";

const accountBody = z.object({
  name: z.string().trim().min(1, "نام حساب لازم است").max(120),
  level: z.enum(["group", "kol", "moin", "tafsili"]),
  parentCode: z.string().regex(/^\d+$/, "کد والد فقط رقم").nullable(),
  nature: z.enum(["debit", "credit"]),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense", "contra_revenue"]),
  isPostable: z.boolean(),
});

const accountCode = z.string().regex(/^\d{1,12}$/, "کد حساب فقط رقم است");

/**
 * نگاشت حساب.
 *
 * تنها میدانِ نوشتنی `accountCode` است — و این عمدی است.
 * `event_type`/`leg`/`side` قرارداد کدند نه تصمیم حسابدار
 * (`sales.post_batch()` مؤلفه را به نام می‌خواند)، پس در مسیر
 * می‌نشینند نه در بدنه: چیزی که عوض نمی‌شود، جای عوض‌شدن هم ندارد.
 *
 * `reason` اختیاری **نیست**. دیتابیس هم اجبارش می‌کند، ولی گرفتنش در
 * Zod یعنی کاربر پیام فارسی فرم را می‌بیند نه ۴۰۹ سرور.
 */
const postingRuleBody = z.object({
  accountCode,
  reason: z.string().trim().min(3, "دلیل تغییر نگاشت لازم است").max(500),
});

/** یک قطعه از کلید قاعده. حروف و زیرخط — نه هر چیزی. */
const ruleKeyPart = z.string().regex(/^[a-z_]{1,40}$/, "کلید قاعده نامعتبر است");

/**
 * سقف مجوز.
 *
 * `maxAmount` **رشته** است چون پول است — همان قاعده‌ای که کل پروژه
 * دارد. `maxPercent` عدد است چون درصد است نه ریال، و `numeric(5,2)`
 * در محدوده امن `number` می‌ماند.
 */
const ruleBody = z.object({
  allowed: z.boolean(),
  maxAmount: z.string().regex(/^\d+$/, "سقف مبلغی رقم است").nullable(),
  maxPercent: z.number().min(0).max(100).nullable(),
  needsApprovalFrom: z.string().trim().min(1).max(40).nullable(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * سند افتتاحیه.
 *
 * مبالغ **رشته**‌اند چون پول‌اند. مؤلفه‌های مجاز از `posting_rule`
 * می‌آیند و همان‌جا سنجیده می‌شوند — اینجا فقط شکل بدنه گرفته می‌شود.
 */
const openingBody = z.object({
  branchId: z.string().uuid("شناسه شعبه نامعتبر"),
  fiscalYear: z.number().int().min(1300).max(1500),
  legs: z
    .array(
      z.object({
        leg: z.string().trim().min(1).max(40),
        amount: z.string().regex(/^\d+$/, "مبلغ باید رقم باشد"),
      }),
    )
    .min(1, "سند افتتاحیه بدون سطر معنا ندارد"),
});

export interface AdminRouteDeps {
  db: Db;
}

interface AccountRow {
  code: string;
  parent_code: string | null;
  name: string;
  level: string;
  nature: string;
  type: string;
  is_postable: boolean;
  is_active: boolean;
  has_children: boolean;
  has_entries: boolean;
}

interface TafsiliRow {
  parent_code: string;
  parent_name: string;
  code: string;
  party_type: string;
  party_id: string;
  party_name: string | null;
  debit: string;
  credit: string;
  balance: string;
}

interface PostingRuleRow {
  id: number;
  event_type: string;
  leg: string;
  side: string;
  account_code: string;
  account_name: string;
  account_type: string;
  account_nature: string;
  party_type: string | null;
  description: string;
  sort_order: number;
  is_active: boolean;
  allow_account_override: boolean;
  entry_count: string;
}

interface MatrixRow {
  role_code: string;
  role_name: string;
  operation: string;
  allowed: boolean;
  max_amount: string | null;
  max_percent: string | null;
  needs_approval_from: string | null;
  has_rule: boolean;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { db } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as { userId: string; pinUnlocked: boolean } | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  // ── کدینگ حساب ────────────────────────────────────────────────────

  /**
   * درخت کامل حساب‌ها.
   *
   * `hasChildren` و `hasEntries` هم می‌آیند چون صفحه بدون آن‌ها
   * نمی‌داند اجازه چه تغییری بدهد: حسابی که سند خورده ماهیتش قفل است
   * و حسابی که فرزند دارد نمی‌تواند سند بپذیرد.
   */
  app.get("/accounts", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");

    const rows = await sql<AccountRow>`
      SELECT * FROM ledger.account_tree ORDER BY code`.execute(db);

    return {
      accounts: rows.rows.map((a) => ({
        code: a.code,
        parentCode: a.parent_code,
        name: a.name,
        level: a.level,
        nature: a.nature,
        type: a.type,
        isPostable: a.is_postable,
        isActive: a.is_active,
        hasChildren: a.has_children,
        hasEntries: a.has_entries,
      })),
    };
  });

  app.put("/accounts/:code", async (req) => {
    const s = session(req);
    const { code } = z.object({ code: accountCode }).parse(req.params);
    const body = accountBody.parse(req.body);
    await requireForSession(db, s, "settings.security");

    const row = await withActor(db, { userId: s.userId, ip: req.ip }, async (trx) => {
      const r = await sql<AccountRow>`
        SELECT * FROM ledger.upsert_account(
          ${code}, ${body.name}, ${body.level}, ${body.parentCode},
          ${body.nature}, ${body.type}, ${body.isPostable}, ${s.userId}::uuid)`.execute(trx);
      return r.rows[0];
    });

    if (!row) throw new Error("ledger.upsert_account سطری برنگرداند");
    return {
      code: row.code,
      parentCode: row.parent_code,
      name: row.name,
      level: row.level,
      nature: row.nature,
      type: row.type,
      isPostable: row.is_postable,
      isActive: row.is_active,
    };
  });

  /**
   * فعال یا غیرفعال — **حذف نداریم**.
   *
   * حساب حذف نمی‌شود: اگر سند خورده باشد حذفش دفتر را می‌شکند، و اگر
   * نخورده باشد هم فردا کسی دنبال کدش می‌گردد و نمی‌فهمد چه شد. هلو
   * هم همین کار را می‌کند.
   */
  app.patch("/accounts/:code/active", async (req) => {
    const s = session(req);
    const { code } = z.object({ code: accountCode }).parse(req.params);
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    await requireForSession(db, s, "settings.security");

    const row = await withActor(db, { userId: s.userId, ip: req.ip }, async (trx) => {
      const r = await sql<AccountRow>`
        SELECT * FROM ledger.set_account_active(${code}, ${isActive}, ${s.userId}::uuid)`
        .execute(trx);
      return r.rows[0];
    });

    if (!row) throw new Error("ledger.set_account_active سطری برنگرداند");
    return { code: row.code, isActive: row.is_active };
  });

  // ── نگاشت حساب ────────────────────────────────────────────────────

  /**
   * «درآمد به کدام حساب بخورد، بهای تمام‌شده به کدام.»
   *
   * `ledger.account` از قبل صفحه داشت، این نداشت — یعنی حسابدار
   * می‌توانست حساب بسازد ولی نمی‌توانست سند را به آن وصل کند. آن یک
   * `UPDATE` دستی در psql بود، بی ردّ حسابرسی و بی نگهبان.
   *
   * ⚠️ مجوزش `ledger.mapping` است، نه `settings.security`. دلیلش
   *    عملی است: این کارِ **حسابدار** است، ولی نرخ مالیات و روش بهای
   *    تمام‌شده کارِ مالک. یک عملیات جدا یعنی مالک می‌تواند نگاشت را به
   *    حسابدار بدهد بی‌آنکه کلیدهای امنیتی تنظیمات را هم داده باشد.
   *    در Seed فقط مدیر داردش؛ دادنش به حسابدار یک ردیف در صفحهٔ
   *    «مجوزها» است.
   */
  app.get("/posting-rules", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");

    const rows = await sql<PostingRuleRow>`
      SELECT * FROM ledger.posting_rule_overview
       ORDER BY event_type, sort_order, leg`.execute(db);

    /*
     * فهرست حساب‌های **مجاز برای هر قاعده** هم می‌رود، چون قاعده‌اش
     * همان است که تابع اجبار می‌کند: هم‌نوع، قابل ثبت، فعال. اگر صفحه
     * فهرست را خودش می‌ساخت، دو تعریف از یک قاعده داشتیم.
     */
    const choices = await sql<{
      code: string;
      name: string;
      type: string;
    }>`
      SELECT code, name, type FROM ledger.account
       WHERE is_postable AND is_active
       ORDER BY code`.execute(db);

    return {
      rules: rows.rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        leg: r.leg,
        side: r.side,
        accountCode: r.account_code,
        accountName: r.account_name,
        accountType: r.account_type,
        accountNature: r.account_nature,
        partyType: r.party_type,
        description: r.description,
        isActive: r.is_active,
        allowAccountOverride: r.allow_account_override,
        // شمار سطرهای سند روی همان حساب — عدد است نه پول، پس رشته‌سازی
        // پول به آن ربطی ندارد؛ ولی `bigint` پستگرس از درایور رشته
        // می‌آید و `Number` امن است (شمار سطر سند از حد `number` بیرون
        // نمی‌زند).
        entryCount: Number(r.entry_count),
      })),
      accounts: choices.rows.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
      })),
    };
  });

  /**
   * تغییر نگاشت.
   *
   * کلید قاعده در مسیر است و فقط `accountCode` در بدنه — همان تفکیکی
   * که تابع دیتابیس دارد. هفت نگهبانش هم آنجاست (نوع حساب، قابل ثبت
   * بودن، فعال بودن، دلیل اجباری و …)، نه اینجا: قاعده‌ای که در psql
   * دور زده می‌شود همان است که اهمیت دارد.
   */
  app.put("/posting-rules/:eventType/:leg/:side", async (req) => {
    const s = session(req);
    const { eventType, leg, side } = z
      .object({
        eventType: ruleKeyPart,
        leg: ruleKeyPart,
        side: z.enum(["debit", "credit"]),
      })
      .parse(req.params);
    const body = postingRuleBody.parse(req.body);
    await requireForSession(db, s, "ledger.mapping");

    const row = await withActor(db, { userId: s.userId, ip: req.ip }, async (trx) => {
      const r = await sql<{ account_code: string }>`
        SELECT account_code FROM ledger.set_posting_rule(
          ${eventType}, ${leg}, ${side}, ${body.accountCode},
          ${body.reason}, ${s.userId}::uuid)`.execute(trx);
      return r.rows[0];
    });

    if (!row) throw new Error("ledger.set_posting_rule سطری برنگرداند");
    return { eventType, leg, side, accountCode: row.account_code };
  });

  // ── سقف مجوزها ────────────────────────────────────────────────────

  /**
   * ماتریس نقش × عملیات.
   *
   * فهرست عملیات از خودِ قواعد موجود درمی‌آید، نه از آرایه‌ای در کد.
   * اگر فردا عملیات تازه‌ای اضافه شود، صفحه بدون یک خط تغییر می‌بیندش —
   * همان قاعده‌ای که صفحه تنظیمات دارد.
   */
  app.get("/permission-rules", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.security");

    const rows = await sql<MatrixRow>`
      SELECT * FROM identity.permission_matrix
       ORDER BY operation, role_code`.execute(db);

    return {
      rules: rows.rows.map((r) => ({
        roleCode: r.role_code,
        roleName: r.role_name,
        operation: r.operation,
        allowed: r.allowed,
        // پول در JSON رشته است. `null` یعنی بی‌سقف — که با صفر یکی
        // نیست: صفر یعنی «هیچ مبلغی مجاز نیست».
        maxAmount: r.max_amount === null ? null : serializeMoney(BigInt(r.max_amount)),
        maxPercent: r.max_percent === null ? null : Number(r.max_percent),
        needsApprovalFrom: r.needs_approval_from,
        hasRule: r.has_rule,
      })),
    };
  });

  app.put("/permission-rules/:role/:operation", async (req) => {
    const s = session(req);
    const { role, operation } = z
      .object({
        role: z.string().trim().min(1).max(40),
        operation: z.string().trim().min(1).max(60),
      })
      .parse(req.params);
    const body = ruleBody.parse(req.body);
    await requireForSession(db, s, "settings.security");

    const row = await withActor(db, { userId: s.userId, ip: req.ip }, async (trx) => {
      const r = await sql<MatrixRow>`
        SELECT role_code, operation, allowed, max_amount, max_percent, needs_approval_from
          FROM identity.set_permission_rule(
            ${role}, ${operation}, ${body.allowed},
            ${body.maxAmount}::platform.money, ${body.maxPercent}::numeric,
            ${body.needsApprovalFrom}, ${body.reason ?? null}, ${s.userId}::uuid)`
        .execute(trx);
      return r.rows[0];
    });

    if (!row) throw new Error("identity.set_permission_rule سطری برنگرداند");
    return {
      roleCode: row.role_code,
      operation: row.operation,
      allowed: row.allowed,
      maxAmount: row.max_amount === null ? null : serializeMoney(BigInt(row.max_amount)),
      maxPercent: row.max_percent === null ? null : Number(row.max_percent),
      needsApprovalFrom: row.needs_approval_from,
    };
  });

  // ── تفصیلی اشخاص ─────────────────────────────────────────────────

  /**
   * مانده هر شخص، زیر حساب معین خودش.
   *
   * این همان چیزی است که در هلو زیر «بدهکاران» دیده می‌شود. ولی
   * **حساب جدا نیست** — از `party_id` سطر سند ساخته می‌شود، تا مانده
   * هر مشتری دو منبع پیدا نکند و دیر یا زود از هم جدا نیفتند.
   */
  app.get("/tafsili", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");

    const rows = await sql<TafsiliRow>`
      SELECT * FROM ledger.party_tafsili ORDER BY parent_code, tafsili_no`.execute(db);

    return {
      rows: rows.rows.map((r) => ({
        parentCode: r.parent_code,
        parentName: r.parent_name,
        code: r.code,
        partyType: r.party_type,
        partyId: r.party_id,
        partyName: r.party_name,
        debit: serializeMoney(BigInt(r.debit)),
        credit: serializeMoney(BigInt(r.credit)),
        balance: serializeMoney(BigInt(r.balance)),
      })),
    };
  });

  // ── سند افتتاحیه ─────────────────────────────────────────────────

  /**
   * مانده اول دوره — همان چیزی که موقع کوچ از سیستم قبلی لازم است.
   *
   * پشت `settings.security`: این سند پایه همه گزارش‌های سال است.
   */
  app.post("/opening-balance", async (req) => {
    const s = session(req);
    const body = openingBody.parse(req.body);
    await requireForSession(db, s, "settings.security");

    const entry = await withActor(db, { userId: s.userId, ip: req.ip }, async (trx) => {
      const r = await sql<{ post_opening_balance: string }>`
        SELECT ledger.post_opening_balance(
          ${body.branchId}::uuid, ${body.fiscalYear}::smallint,
          ${JSON.stringify(body.legs)}::jsonb, ${s.userId}::uuid)`.execute(trx);
      return r.rows[0]?.post_opening_balance ?? null;
    });

    if (!entry) throw new Error("ledger.post_opening_balance سندی برنگرداند");
    return { entryId: entry };
  });
}
