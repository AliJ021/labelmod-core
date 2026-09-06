/**
 * مسیرهای تنظیمات.
 *
 * دیدن و تغییر «تصمیم‌های باز» پروژه — همان‌هایی که CLAUDE.md می‌گوید
 * باید داده باشند نه کد، تا تغییرشان UPDATE باشد نه Deploy. تا امروز
 * آن UPDATE فقط با psql ممکن بود، یعنی در عمل مالک نمی‌توانست انجامش
 * دهد.
 *
 * **مجوز اینجا سه‌لایه است و هیچ لایه‌ای شرطِ کد نیست:**
 *
 *   ۱. `settings.view` برای دیدن صفحه
 *   ۲. عملیاتِ نوشته‌شده در ستون `permission` همان تنظیم، برای تغییرش
 *   ۳. `is_editable = false` روی تنظیمی که اصلاً نباید از API عوض شود
 *      (Retry خودکار پرداخت، واحد مبنای ذخیره‌سازی)
 *
 * لایه دوم مهم‌ترین است: کدام تنظیم «امنیتی» است و کدام «عملیاتی»، در
 * داده نوشته شده. جابه‌جا کردنش یک UPDATE است، نه یک Deploy.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import { withActor } from "../db/actor.ts";
import type { Db } from "../db/client.ts";
import { SettingError, type SettingService } from "../platform/settings.ts";

/**
 * بدنه تغییر یک تنظیم.
 *
 * `value` عمداً `unknown` است و اینجا سنجیده نمی‌شود: نوع، گزینه و
 * بازه را `platform.set_setting()` می‌سنجد. اگر Zod هم می‌سنجید، دو
 * نسخه از یک قاعده داشتیم و آن که در psql دور زده می‌شود همان است که
 * اهمیت دارد. تنها چیزی که اینجا رد می‌شود، نبودِ میدان است.
 */
const patchBody = z.object({
  value: z.unknown().refine((v) => v !== undefined, { message: "مقدار لازم است" }),
  reason: z.string().trim().max(500, "دلیل حداکثر ۵۰۰ نویسه").optional(),
});

const settingKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, "کلید تنظیم نامعتبر است");

/**
 * شرایط تسویه پایانه.
 *
 * کارمزد **رشته** است، نه عدد: `numeric(5,3)` اعشار دارد و
 * `number` جاوااسکریپت ۰٫۲۳۵ را دقیق نگه نمی‌دارد. همان قاعده پول،
 * به همان دلیل.
 */
const termsBody = z.object({
  settlementDays: z.number().int().min(0).max(90),
  feePercent: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/, "کارمزد باید عدد با حداکثر سه رقم اعشار باشد"),
  reason: z.string().trim().max(500).optional(),
});

export interface SettingsRouteDeps {
  db: Db;
  settings: SettingService;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const { db, settings } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * صفحه تنظیمات — فراداده کامل، تا رابط کاربری چیزی را hardcode نکند.
   *
   * `canEdit` هر تنظیم از `identity.can()` می‌آید، ولی برای هر عملیات
   * **متمایز** یک بار — نه یک بار برای هر تنظیم. با سی تنظیم و سه
   * عملیات، سه فراخوان به‌جای سی‌تا.
   */
  app.get("/settings", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");

    const perms = await db
      .selectFrom("platform.setting")
      .select("permission")
      .distinct()
      .execute();

    const allowed = new Set<string>();
    for (const p of perms) {
      const d = await can(db, {
        userId: s.userId,
        operation: p.permission,
        viaPin: s.pinUnlocked,
      });
      if (d.verdict === "allow") allowed.add(p.permission);
    }

    return { groups: await settings.list(allowed) };
  });

  /**
   * تغییر یک تنظیم.
   *
   * عمداً `Idempotency-Key` نمی‌گیرد: نشاندن یک مقدار مشخص روی یک کلید
   * مشخص از پایه تکرارپذیر است، و `set_setting` وقتی مقدار عوض نشود
   * حتی سطر حسابرسی تازه هم نمی‌سازد. کلید Idempotency اینجا فقط
   * پیچیدگی بود بدون تضمین تازه.
   */
  app.patch("/settings/:key", async (req) => {
    const s = session(req);
    const key = settingKey.parse((req.params as { key: string }).key);
    const body = patchBody.parse(req.body);

    // ترتیب اهمیت دارد: اول وجود کلید، بعد مجوزِ **همان** کلید. اگر
    // مجوز عمومی می‌گرفتیم، کسی که settings.manage دارد می‌توانست نرخ
    // مالیات را هم عوض کند.
    const row = await settings.find(key);
    if (!row) {
      throw new SettingError("setting_not_found", `تنظیم «${key}» وجود ندارد`, 404);
    }
    await requireForSession(db, s, row.permission);

    const out = await withActor(db, { userId: s.userId, ip: req.ip }, (trx) =>
      settings.setIn(trx, key, body.value, body.reason ?? null),
    );
    return out;
  });

  /**
   * شرایط تسویه کارت‌خوان و درگاه — دوره و کارمزد.
   *
   * جدا از `/settings` است چون شکلش جدول است نه کلید/مقدار، و
   * **به‌ازای هر پایانه** معنا دارد: کارت‌خوان فروشگاه و درگاه سایت
   * معمولاً قرارداد متفاوت دارند.
   */
  /**
   * درایورهای شناخته‌شده دستگاه.
   *
   * ⚠️ `isImplemented` بخش اصلی پاسخ است، نه یک جزئیات.
   *
   * ثبت یک درایور در جدول یعنی «مستنداتش را داریم»، نه «کار می‌کند».
   * صفحه باید این را صریح نشان دهد، وگرنه مالک یک کارت‌خوان را
   * انتخاب می‌کند و اولین پرداخت واقعی در سکوت شکست می‌خورد — یا
   * بدتر، معلق می‌ماند و پول مشتری بلاتکلیف.
   */
  app.get("/device-drivers", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");
    const q = z
      .object({ includeRetired: z.enum(["0", "1"]).optional() })
      .parse(req.query);
    return { drivers: await settings.deviceDrivers(q.includeRetired === "1") };
  });

  /**
   * افزودن یا ویرایش یک درایور و **مستندات SDK** آن.
   *
   * ── چرا `PUT` و چرا بدون `Idempotency-Key` ────────────────────────
   *
   * هویت این عملیات خودِ `code` است و بدنه، حالت **مطلق** درایور را
   * می‌گوید — نه یک تغییر افزایشی. ارسال دوباره همان بدنه دقیقاً
   * همان نتیجه را می‌دهد، پس کلیدی لازم نیست که تکرار را بگیرد.
   * همان دلیلی که مسیر انبارگردانی `PUT` است.
   *
   * پشت `settings.security` مثل اتصال پایانه به درایور، و به همان
   * دلیل: این فهرست تعیین می‌کند مالک از میان چه چیزهایی کارت‌خوان
   * فروشگاه را انتخاب کند.
   *
   * ⚠️ `isImplemented` در بدنه پذیرفته نمی‌شود. اگر کسی بفرستدش،
   * Zod ردش نمی‌کند — ولی هیچ‌جا خوانده هم نمی‌شود، و دیتابیس آن
   * ستون را از این مسیر اصلاً دست نمی‌زند.
   */
  app.put("/device-drivers/:code", async (req) => {
    const s = session(req);
    const { code } = z
      .object({ code: z.string().trim().min(2).max(40) })
      .parse(req.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(100),
        // ⚠️ فهرست نوع اینجا **تکرار نشده**. دیتابیس می‌سنجدش و
        //    پیام فارسی می‌دهد؛ دو نسخه از یک قاعده یعنی آن که در
        //    psql دور زده می‌شود همان است که اهمیت دارد.
        deviceKind: z.string().trim().min(1).max(20),
        vendor: z.string().trim().max(100).nullable().default(null),
        sdkDocUrl: z.string().trim().max(500).nullable().default(null),
        notes: z.string().max(2000).nullable().default(null),
        sortOrder: z.number().int().min(0).max(9999).default(100),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);
    await requireForSession(db, s, "settings.security");

    await withActor(db, { userId: s.userId, ip: req.ip }, (trx) =>
      settings.upsertDriverIn(
        trx,
        { code, ...body, vendor: body.vendor, sdkDocUrl: body.sdkDocUrl },
        body.reason ?? null,
        s.userId,
      ),
    );
    const list = await settings.deviceDrivers(true);
    return list.find((d) => d.code === code.trim().toLowerCase()) ?? null;
  });

  /**
   * بازنشستگی یا بازگرداندن یک درایور.
   *
   * حذف نیست — `treasury.account.driver_code` به آن ارجاع دارد و
   * `audit_log` تاریخچه‌اش را نگه داشته. درایوری که پایانه‌ای به آن
   * وصل است بازنشسته نمی‌شود؛ دیتابیس ردش می‌کند و پیامش می‌گوید
   * اول پایانه را جدا کنید.
   */
  app.patch("/device-drivers/:code/active", async (req) => {
    const s = session(req);
    const { code } = z
      .object({ code: z.string().trim().min(2).max(40) })
      .parse(req.params);
    const body = z
      .object({
        isActive: z.boolean(),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);
    await requireForSession(db, s, "settings.security");

    await withActor(db, { userId: s.userId, ip: req.ip }, (trx) =>
      settings.setDriverActiveIn(
        trx, code, body.isActive, body.reason ?? null, s.userId,
      ),
    );
    const list = await settings.deviceDrivers(true);
    return list.find((d) => d.code === code.trim().toLowerCase()) ?? null;
  });

  app.get("/terminal-drivers", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");
    const d = await can(db, {
      userId: s.userId,
      operation: "settings.security",
      viaPin: s.pinUnlocked,
    });
    return { terminals: await settings.terminalDrivers(d.verdict === "allow") };
  });

  /**
   * اتصال یک پایانه به یک درایور.
   *
   * پشت `settings.security` مثل شرایط تسویه، و به همان دلیل: این
   * تنظیم تعیین می‌کند پول از کدام مسیر به سیستم گزارش شود.
   *
   * ⚠️ راز اینجا نمی‌آید. کلید و رمز API از متغیر محیطی می‌آیند، مثل
   * `SMS_API_KEY` — چون مقدار این ستون در `audit_log` می‌نشیند و
   * صفحه تنظیمات نشانش می‌دهد. دیتابیس هم مستقل ردش می‌کند.
   */
  app.patch("/terminal-drivers/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: z.string().uuid("شناسه نامعتبر") }).parse(req.params);
    const body = z
      .object({
        driverCode: z.string().trim().min(1).max(40).nullable(),
        // ⚠️ `unknown` عمدی است: اعتبارسنجی در دیتابیس است. اگر Zod هم
        // می‌سنجید، دو نسخه از یک قاعده داشتیم — و آن که در psql دور
        // زده می‌شود همان است که اهمیت دارد.
        config: z.record(z.string(), z.unknown()).default({}),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);
    await requireForSession(db, s, "settings.security");

    await withActor(db, { userId: s.userId, ip: req.ip }, (trx) =>
      settings.setDriverIn(
        trx, id, body.driverCode, body.config, body.reason ?? null, s.userId,
      ),
    );
    const list = await settings.terminalDrivers(true);
    return list.find((t) => t.accountId === id) ?? null;
  });

  app.get("/settlement-terms", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");
    const d = await can(db, {
      userId: s.userId,
      operation: "settings.security",
      viaPin: s.pinUnlocked,
    });
    return { terms: await settings.settlementTerms(d.verdict === "allow") };
  });

  /**
   * تغییر دوره تسویه و کارمزد یک پایانه.
   *
   * پشت `settings.security`، نه `settings.manage`: این نرخ مستقیم در
   * سند تسویه ضرب می‌شود. یک اشتباه اینجا هر روز در دفتر تکرار
   * می‌شود بی‌آنکه چیزی قرمز شود.
   */
  app.patch("/settlement-terms/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: z.string().uuid("شناسه نامعتبر") }).parse(req.params);
    const body = termsBody.parse(req.body);
    await requireForSession(db, s, "settings.security");

    return withActor(db, { userId: s.userId, ip: req.ip }, (trx) =>
      settings.setTermsIn(trx, id, body.settlementDays, body.feePercent, body.reason ?? null),
    );
  });
}
