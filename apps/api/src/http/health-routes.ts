/**
 * سلامت سیستم — زنگ‌های خطر و صف پیامِ خطادار، از صفحه.
 *
 * ── چرا این مسیر وجود دارد ──────────────────────────────────────────
 *
 * هشت زنگ خطر از قبل بودند و کار می‌کردند. مشکل جای دیگری بود: همه
 * فقط وقتی دیده می‌شدند که کسی روی سرور `ops/deploy.sh status` را
 * بزند. یعنی درآمدی که به دفتر نرفته، تا روزی که آدمی یادش بیفتد
 * فرمانی را اجرا کند، ندیده می‌ماند.
 *
 * و «نامهٔ مرده» بدتر بود: **دیده** می‌شد ولی هیچ راهی برای زنده‌کردنش
 * جز یک `UPDATE` دستی در psql نبود — بی ردّ حسابرسی، و بی‌اثر، چون
 * `attempts` روی سقف می‌ماند و اولین شکستِ بعدی همان لحظه دوباره
 * می‌کشتش. معیار پذیرش ۱۱ سند «اجرای مجدد **کنترل‌شده**» می‌خواست.
 *
 * ── مجوز ────────────────────────────────────────────────────────────
 *
 * دیدن زنگ‌ها `settings.view` است — هر کسی که به تنظیمات دسترسی دارد
 * باید بداند سیستم سالم است یا نه. **زنده‌کردن** پیام مجوز جدای
 * `outbox.requeue` دارد، چون یک اثر بیرونی دارد: پیامک دوباره به
 * مشتری می‌رود.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { withActor } from "../db/actor.ts";
import type { Db } from "../db/client.ts";

export interface HealthRouteDeps {
  db: Db;
}

interface AlertRow {
  code: string;
  severity: string;
  title: string;
  n: string;
  detail: string;
}

interface DeadRow {
  id: string;
  topic: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  age: string;
}

const requeueBody = z.object({
  reason: z.string().trim().min(3, "دلیل اجرای مجدد لازم است").max(500),
});

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const { db } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as { userId: string; pinUnlocked: boolean } | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * هشت زنگ خطر.
   *
   * فهرست از `platform.health_alerts()` می‌آید، نه از هشت کوئری اینجا —
   * سه مصرف‌کننده دارد (این مسیر، تولیدکنندهٔ هشدار،
   * `ops/deploy.sh status`) و هشت کوئری در سه جا یعنی هر زنگ تازه دو
   * جا را عقب می‌گذارد. و عقب‌ماندنشان **بی‌صدا**ست: نبودِ یک هشدار
   * شبیه «همه‌چیز خوب است» به نظر می‌رسد.
   */
  app.get("/health/alerts", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");

    const r = await sql<AlertRow>`
      SELECT code, severity, title, n, detail FROM platform.health_alerts()
       ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, code`.execute(db);

    return {
      alerts: r.rows.map((a) => ({
        code: a.code,
        severity: a.severity,
        title: a.title,
        // شمار سطر است، نه پول — پس عدد می‌رود. `bigint` پستگرس از
        // درایور رشته می‌آید و شمار سطرِ مشکل‌دار از حد `number` بیرون
        // نمی‌زند.
        count: Number(a.n),
        detail: a.detail,
      })),
    };
  });

  /** پیام‌هایی که پس از سقف تلاش نرفتند. */
  app.get("/health/dead-letters", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "settings.view");

    const r = await sql<DeadRow>`
      SELECT id, topic, attempts, last_error, created_at, age::text AS age
        FROM platform.outbox_dead LIMIT 100`.execute(db);

    return {
      messages: r.rows.map((m) => ({
        // ⚠️ `bigint` است و **رشته** می‌ماند: شناسهٔ صف می‌تواند از حد
        //    امن `number` جاوااسکریپت بگذرد و کلاینت هم کاری جز
        //    برگرداندنش ندارد.
        id: m.id,
        topic: m.topic,
        attempts: m.attempts,
        lastError: m.last_error,
        createdAt: m.created_at,
        age: m.age,
      })),
    };
  });

  /**
   * زنده‌کردن یک پیام.
   *
   * `POST` و نه `PUT`: هویت عملیات «همین پیام، همین حالا» نیست — هر
   * فراخوان یک تلاش تازه است و ردّ حسابرسی خودش را می‌سازد. پس
   * `Idempotency-Key` هم نمی‌گیرد.
   *
   * ⚠️ یکی‌یکی و نه دسته‌ای: هر پیام دلیل مرگ خودش را دارد و «همه را
   *    دوباره بفرست» یعنی شمارهٔ غلط هم دوباره تلاش کند و یک دلیل برای
   *    همه ثبت شود. صف مردهٔ یک فروشگاه چند سطر است، نه چند هزار.
   */
  app.post("/health/dead-letters/:id/requeue", async (req) => {
    const s = session(req);
    const { id } = z
      .object({ id: z.string().regex(/^\d{1,19}$/, "شناسه پیام نامعتبر است") })
      .parse(req.params);
    const body = requeueBody.parse(req.body);
    await requireForSession(db, s, "outbox.requeue");

    const row = await withActor(db, { userId: s.userId, ip: req.ip }, async (trx) => {
      const r = await sql<{ id: string; status: string; attempts: number }>`
        SELECT id, status, attempts FROM platform.requeue_dead_letter(
          ${id}::bigint, ${body.reason}, ${s.userId}::uuid)`.execute(trx);
      return r.rows[0];
    });

    if (!row) throw new Error("platform.requeue_dead_letter سطری برنگرداند");
    return { id: row.id, status: row.status, attempts: row.attempts };
  });
}
