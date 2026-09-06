/**
 * دامنه کاربر — شعبه، انبار و روش‌های پرداخت.
 *
 * چرا یک مسیر جدا و نه غنی‌کردن `/auth/me`: آن Endpoint امروز هیچ
 * Queryای نمی‌زند و فقط نشست را برمی‌گرداند. افزودن شعبه و انبار به
 * آن، دو Join به پرمصرف‌ترین مسیر اضافه می‌کرد برای داده‌ای که فقط
 * صندوق لازم دارد — و معنایش هم فرق دارد: `/auth/me` می‌گوید «نشست
 * چیست»، این می‌گوید «چه چیزی در دسترس است».
 *
 * چرا اصلاً لازم است: بدون این، کلاینت برای ساختن فاکتور باید
 * `branchId` و `warehouseId` را از جایی می‌گرفت — و تنها «جای» موجود،
 * Hardcode کردن UUID از Seed بود.
 */
import type { FastifyInstance } from "fastify";
import { AuthError } from "../auth/service.ts";
import type { Db } from "../db/client.ts";
import { assertBranch, branchesOf } from "../sales/scope.ts";
import { can } from "../auth/permission.ts";
import { serializeMoney } from "../lib/money.ts";
import { sql } from "kysely";
import { z } from "zod";

export interface ScopeRouteDeps {
  db: Db;
}

export function registerScopeRoutes(app: FastifyInstance, deps: ScopeRouteDeps): void {
  const { db } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as { userId: string } | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * شعبه‌های کاربر، با انبارهای هرکدام.
   *
   * دامنه از همان `branchesOf` می‌آید که `assertBranch` هم از آن
   * می‌خواند — یعنی این فهرست دقیقاً همان چیزی است که سرور بعداً
   * می‌پذیرد. اگر دو منبع می‌داشتند، کلاینت شعبه‌ای می‌دید که فروش
   * رویش ۴۰۳ می‌گرفت.
   *
   * دسترسی نداشتن به هیچ شعبه‌ای **۴۰۳ نیست**: کاربر معتبر است و
   * پاسخ درست، فهرست خالی است. ۴۰۳ را برای «به این شعبه دسترسی
   * نداری» نگه می‌داریم که یک ادعای مشخص است.
   *
   * `kind` انبار عمداً برمی‌گردد: صندوق باید انبار فروشگاه را از
   * انبار ضایعات جدا کند و تنها راه سالمش همین ستون است، نه یک UUID
   * ثابت در کد.
   */
  app.get("/branches", async (req) => {
    const s = session(req);
    const scope = await branchesOf(db, s.userId);
    if (scope !== "all" && scope.length === 0) return { branches: [] };

    let q = db
      .selectFrom("platform.branch")
      .select(["id", "code", "name"])
      .where("is_active", "=", true);
    if (scope !== "all") q = q.where("id", "in", scope);
    const branches = await q.orderBy("code").execute();

    if (branches.length === 0) return { branches: [] };

    const warehouses = await db
      .selectFrom("inventory.warehouse")
      .select(["id", "branch_id", "code", "name", "kind"])
      .where("is_active", "=", true)
      .where(
        "branch_id",
        "in",
        branches.map((b) => b.id),
      )
      .orderBy("code")
      .execute();

    return {
      branches: branches.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        warehouses: warehouses
          .filter((w) => w.branch_id === b.id)
          .map((w) => ({ id: w.id, code: w.code, name: w.name, kind: w.kind })),
      })),
    };
  });

  /**
   * روش‌های پرداخت فعال.
   *
   * صندوق باید بداند «نقدی» چه کدی دارد. تنها جای این کد امروز
   * `db/seed/040_reference.sql` است — یعنی بدون این مسیر، کلاینت باید
   * رشته «cash» را در خودش می‌نوشت.
   *
   * `kind` برمی‌گردد چون یک مقدار **اسکیما** است (در CHECK جدول
   * `payment_method`)، نه یک ردیف Seed. کلاینت با `kind === 'cash'`
   * روش نقدی را پیدا می‌کند؛ اگر بیش از یکی بود، از کاربر می‌پرسد.
   *
   * `fee_percent` و `settlement_days` عمداً بیرون نمی‌روند: قرارداد
   * PSP داده داخلی است و کارمزد واقعی **به‌ازای هر پایانه** در
   * `treasury.account` می‌نشیند، نه اینجا. `requires_ref` برمی‌گردد
   * چون ستون واقعی همین جدول است و فرم پرداخت بدون آن نمی‌داند شماره
   * پیگیری بخواهد یا نه.
   */
  app.get("/payment-methods", async (req) => {
    session(req);
    const rows = await db
      .selectFrom("treasury.payment_method")
      .select(["code", "name", "kind", "requires_ref"])
      .where("is_active", "=", true)
      .orderBy("code")
      .execute();

    return {
      methods: rows.map((m) => ({
        code: m.code,
        name: m.name,
        kind: m.kind,
        requiresRef: m.requires_ref,
      })),
    };
  });

  /**
   * خلاصه یک روز کاری: فروش، وجه دریافتی، سود.
   *
   * هر سه در SQL حساب می‌شوند (`sales.daily_summary`) — نه اینجا.
   * جمع پول در TypeScript با جمع دیتابیس یکی درنمی‌آید.
   *
   * ── چرا `profitAmount` می‌تواند `null` باشد ──────────────────────
   *
   * سود داده مدیریتی است و `cost.view` را می‌خواهد — که طبق
   * `040_reference.sql` فقط حسابدار و مدیر دارند، نه صندوق‌دار و نه
   * سرپرست.
   *
   * ولی «فروش امروز چقدر بود» و «چقدر پول در کشوست» را صندوق‌دار
   * **باید** ببیند؛ آخر شب با همان‌ها کشو را می‌شمارد. پس کل مسیر
   * ۴۰۳ نمی‌شود و فقط همان یک عدد `null` می‌آید.
   *
   * `null` است نه صفر: صفر یک ادعای مالی است («امروز سودی نبود») و
   * «اجازه دیدنش را نداری» ادعای دیگری است.
   */
  app.get("/reports/daily", async (req) => {
    const s = session(req) as { userId: string; pinUnlocked: boolean };
    const q = z
      .object({
        branchId: z.string().uuid("شناسه نامعتبر"),
        // بدون تاریخ یعنی «امروز» — و «امروز» را
        // `platform.business_date()` تعریف می‌کند، نه منطقه زمانی سرور.
        // `z.iso.date()` و نه یک Regex: الگوی `\d{4}-\d{2}-\d{2}` به
        // «۲۰۲۶-۱۳-۴۵» هم اجازه عبور می‌داد و آن رشته تا `::date` در SQL
        // می‌رفت. آنجا SQLSTATE 22008 می‌گرفت که هیچ نگاشتی ندارد، پس
        // یک **ورودی نامعتبر کاربر** به‌شکل «خطای داخلی ۵۰۰» گزارش
        // می‌شد — همان الگویی که برای محدودیت نرخ و P0001 دو بار اصلاح
        // شد. این نسخه تقویم واقعی را می‌سنجد، کبیسه هم.
        date: z.iso.date("تاریخ نامعتبر").optional(),
      })
      .parse(req.query);
    await assertBranch(db, s.userId, q.branchId);

    const row = await sql<{
      business_date: string;
      sales_amount: string;
      received_amount: string;
      profit_amount: string;
      invoice_count: string;
      return_count: string;
      // ⚠️ `business_date::text` — و این «سلیقه» نیست.
      //
      // درایور، ستون `date` را به `Date` جاوااسکریپت تبدیل می‌کند و
      // `JSON.stringify` آن را «۲۰۲۶-۰۹-۰۵T۰۰:۰۰:۰۰.۰۰۰Z» می‌نویسد،
      // نه «۲۰۲۶-۰۹-۰۵». دو اثر داشت و هر دو بی‌صدا بودند: داشبورد
      // یک برچسب زشت نشان می‌داد، و مقایسه «آیا این دوره مالِ امروز
      // است؟» **هیچ‌وقت** برابر نمی‌شد — یعنی دکمه بستن دوره برای
      // دوره امروز هم ظاهر می‌شد، دقیقاً همان چیزی که آن نگهبان
      // برای جلوگیری‌اش هست.
      //
      // `posting-batch.ts` از قبل همین Cast را داشت با همین دلیل.
    }>`SELECT business_date::text, sales_amount, received_amount,
              profit_amount, invoice_count, return_count
         FROM sales.daily_summary(
           ${q.branchId}::uuid,
           coalesce(${q.date ?? null}::date, platform.business_date()))`.execute(db);

    // `daily_summary` یک CROSS JOIN از سه CTE تک‌سطری است، پس همیشه
    // **دقیقاً** یک سطر می‌دهد — حتی برای روزی که هیچ فروشی نداشته
    // (سه صفر). نبودن سطر یعنی خودِ تابع عوض شده، که یک خطای برنامه
    // است نه یک حالت کاربر: پیام عمومی ۵۰۰ درست‌ترین پاسخ است.
    const r = row.rows[0];
    if (!r) throw new Error("sales.daily_summary سطری برنگرداند");

    const costs = await can(db, {
      userId: s.userId,
      operation: "cost.view",
      viaPin: s.pinUnlocked,
    });

    return {
      businessDate: r.business_date,
      salesAmount: serializeMoney(BigInt(r.sales_amount)),
      receivedAmount: serializeMoney(BigInt(r.received_amount)),
      profitAmount:
        costs.verdict === "allow" ? serializeMoney(BigInt(r.profit_amount)) : null,
      invoiceCount: Number(r.invoice_count),
      returnCount: Number(r.return_count),
    };
  });

  /**
   * علت‌های مجاز مرجوعی، با برچسب فارسی.
   *
   * چرا یک مسیر جدا و نه `GET /settings`: آن `settings.view` می‌خواهد
   * و صندوق‌دار **ندارد** (`040_reference.sql` — فقط سرپرست، حسابدار
   * و مدیر). یعنی صفحه مرجوعی از آن راه هیچ‌وقت برچسب‌ها را
   * نمی‌دید.
   *
   * تنها راه دیگر، نوشتن فهرست در کد React بود — که همان چیزی است که
   * `CLAUDE.md` صریح ممنوع کرده: «تصمیم‌های باز داده‌اند، نه کد».
   * علت مرجوعی سوخت موتور پیشنهاد سایز است و مالک باید بتواند با یک
   * `UPDATE` عوضش کند، نه با یک Deploy.
   *
   * دقیقاً همان الگوی `GET /payment-methods`: فقط آنچه فرم لازم دارد
   * (`value` و `label`) بیرون می‌رود — نه خودِ ردیف تنظیم با
   * `permission`، `help` و ردّ حسابرسی‌اش.
   */
  /**
   * فصل‌های مجاز کالا — با تفکیک گرم و سرد.
   *
   * از `catalog.season` می‌آید نه از یک فهرست در کد: افزودن فصل یک
   * `INSERT` در Seed است. متن آزاد بودنِ قبلی یعنی «پاییز»، «پاييز»
   * (با ی عربی) و «Autumn» سه فصل متفاوت شوند و فیلتر انبار هیچ‌کدام
   * را کامل نگیرد.
   */
  app.get("/seasons", async (req) => {
    session(req);
    const r = await db
      .selectFrom("catalog.season")
      .select(["code", "label", "climate", "sort_order"])
      .where("is_active", "=", true)
      .orderBy("sort_order")
      .execute();
    return {
      seasons: r.map((x) => ({
        code: x.code,
        label: x.label,
        climate: x.climate,
      })),
    };
  });

  app.get("/return-reasons", async (req) => {
    session(req);
    const row = await db
      .selectFrom("platform.setting")
      .select(["value", "options"])
      .where("key", "=", "return.reason_codes")
      .executeTakeFirst();
    if (!row) return { reasons: [] };

    // `value` فهرست کدهای **مجاز** است؛ `options` برچسب همه کدهای
    // شناخته‌شده. برچسبی که کدش در `value` نیست نباید نشان داده شود —
    // وگرنه صندوق‌دار علتی را می‌بیند که سرور بعداً ردش می‌کند.
    const allowed = new Set(
      Array.isArray(row.value) ? row.value.map((v) => String(v)) : [],
    );
    const labels = new Map<string, string>();
    if (Array.isArray(row.options)) {
      for (const o of row.options) {
        if (o !== null && typeof o === "object") {
          const rec = o as { value?: unknown; label?: unknown };
          const code = String(rec.value);
          labels.set(code, typeof rec.label === "string" ? rec.label : code);
        }
      }
    }

    return {
      reasons: [...allowed].map((code) => ({
        code,
        label: labels.get(code) ?? code,
      })),
    };
  });
}
