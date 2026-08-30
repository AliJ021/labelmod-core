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
}
