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
import { branchesOf } from "../sales/scope.ts";

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
