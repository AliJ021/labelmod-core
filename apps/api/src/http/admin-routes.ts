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
}
