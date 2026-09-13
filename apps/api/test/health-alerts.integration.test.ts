/**
 * تست یکپارچه سلامت سیستم — روی پستگرس واقعی.
 *
 * ادعای اولش مهم‌ترین است و جای دیگری سنجیده نمی‌شود:
 *
 *   **فهرست گزینه‌های `notify.health_alert_codes` باید دقیقاً برابر
 *   کدهای `platform.health_alerts()` باشد.** دو تعریف از یک فهرست
 *   یعنی زنگ تازه‌ای اضافه شود که هیچ‌کس نتواند روشن یا خاموشش کند — و
 *   بی‌صدا، چون نبودِ یک گزینه در صفحهٔ تنظیمات شبیه «این زنگ وجود
 *   ندارد» به نظر می‌رسد.
 *
 * و دو ادعای دیگر که فقط از راه HTTP دیده می‌شوند: مجوز `outbox.requeue`
 * و اینکه خطای نگهبان دیتابیس ۴۰۹ فارسی می‌شود نه ۵۰۰.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";

interface AlertView {
  code: string;
  severity: string;
  title: string;
  count: number;
  detail: string;
}
interface DeadView {
  id: string;
  topic: string;
  attempts: number;
  lastError: string | null;
  age: string;
}

describe("سلامت سیستم از مسیر API", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `h${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-سلامت-سیستم-و-به‌قدر-کافی-بلند";
  const admin = `hadmin_${suffix}`;
  const cashier = `hcash_${suffix}`;

  const sessions = new Map<
    string,
    { cookies: Record<string, string>; headers: Record<string, string> }
  >();

  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const out = {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
    sessions.set(username, out);
    return out;
  }

  /** یک پیام که واقعاً مرده — نه یک سطر با `status='dead'` دستی. */
  async function killAMessage(): Promise<string> {
    const ins = await sql<{ id: string }>`
      INSERT INTO platform.outbox_message (topic, payload)
      VALUES ('cheque.due', jsonb_build_object('cheque_id', gen_random_uuid()::text))
      RETURNING id`.execute(handle.db);
    const id = ins.rows[0]?.id;
    assert.ok(id);
    // سه دور واقعی: برداشتن، شکست، و شبیه‌سازی گذر زمان — چون Backoff
    // نمایی `next_attempt_at` را جلو می‌برد و دور بعد چیزی برنمی‌داشت.
    for (let i = 0; i < 3; i++) {
      await sql`
        UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second'
         WHERE id = ${id}::bigint`.execute(handle.db);
      await sql`SELECT platform.claim_outbox(10, 'test', 60)`.execute(handle.db);
      await sql`
        SELECT platform.fail_outbox(${id}::bigint, 'خطای ساختگی', 3, false)`
        .execute(handle.db);
    }
    const st = await sql<{ status: string }>`
      SELECT status FROM platform.outbox_message WHERE id = ${id}::bigint`
      .execute(handle.db);
    assert.equal(st.rows[0]?.status, "dead", "پیام واقعاً نمرد — تست بی‌معنا می‌شد");
    return id;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر سلامت", "admin"],
      [cashier, "صندوق‌دار سلامت", "cashier"],
    ] as const) {
      const u = await handle.db
        .insertInto("identity.app_user")
        .values({
          username,
          full_name: name,
          password_hash: hash,
          is_active: true,
          mobile: null,
          pin_hash: null,
          totp_secret: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await handle.db
        .insertInto("identity.user_role")
        .values({ user_id: u.id, role_code: role, branch_id: BRANCH })
        .execute();
    }

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("گزینه‌های تنظیم دقیقاً همان کدهای تابع‌اند", async () => {
    const fromFn = await sql<{ code: string }>`
      SELECT code FROM platform.health_alerts() ORDER BY code`.execute(handle.db);
    const fromSetting = await sql<{ value: string }>`
      SELECT jsonb_array_elements(options)->>'value' AS value
        FROM platform.setting WHERE key = 'notify.health_alert_codes'
       ORDER BY 1`.execute(handle.db);

    const codes = fromFn.rows.map((r) => r.code);
    const options = fromSetting.rows.map((r) => r.value);

    assert.ok(codes.length >= 8, `شمار زنگ: ${codes.length}`);
    /*
     * هر دو جهت سنجیده می‌شود، و این عمدی است:
     *   • کدی که گزینه ندارد → قابل خاموش‌کردن نیست و کاربر نمی‌داند
     *     وجود دارد.
     *   • گزینه‌ای که کد ندارد → کاربر چیزی را روشن می‌کند که هیچ‌وقت
     *     پیامی نمی‌سازد، و منتظر هشداری می‌ماند که نمی‌آید.
     */
    assert.deepEqual(options, codes);
  });

  test("زنگ‌ها از مسیر API می‌آیند و مرتب‌اند", async () => {
    const s = await loginAs(admin);
    const r = await app.inject({ method: "GET", url: "/health/alerts", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const { alerts } = JSON.parse(r.body) as { alerts: AlertView[] };

    assert.ok(alerts.length >= 8);
    for (const a of alerts) {
      assert.ok(a.title.length > 0, `${a.code} عنوان ندارد`);
      assert.ok(["critical", "warn"].includes(a.severity), `${a.code}: ${a.severity}`);
      assert.equal(typeof a.count, "number");
    }
    // بحرانی‌ها اول — صفحه‌ای که هشدار بحرانی را پایین جدول بگذارد،
    // همان را پنهان کرده است.
    const firstWarn = alerts.findIndex((a) => a.severity === "warn");
    const lastCrit = alerts.map((a) => a.severity).lastIndexOf("critical");
    assert.ok(firstWarn === -1 || lastCrit < firstWarn, "ترتیب شدت رعایت نشده");

    // ضد‌پوچی: روی دیتابیس تازه، «تمرین بازیابی» روشن است.
    const drill = alerts.find((a) => a.code === "restore_drill");
    assert.equal(drill?.count, 1, "زنگ تمرین بازیابی باید روی دیتابیس تازه روشن باشد");
  });

  test("نامهٔ مرده دیده می‌شود و فقط با مجوز زنده می‌شود", async () => {
    const id = await killAMessage();

    const s = await loginAs(admin);
    const list = await app.inject({ method: "GET", url: "/health/dead-letters", ...s });
    assert.equal(list.statusCode, 200, list.body);
    const { messages } = JSON.parse(list.body) as { messages: DeadView[] };
    const mine = messages.find((m) => m.id === id);
    assert.ok(mine, "پیام مرده در فهرست نبود");
    assert.equal(mine.attempts, 3);
    assert.match(mine.lastError ?? "", /خطای ساختگی/);
    // ⚠️ شناسه **رشته** است: `bigint` صف می‌تواند از حد امن `number`
    //    بگذرد و کلاینت کاری جز برگرداندنش ندارد.
    assert.equal(typeof mine.id, "string");

    // صندوق‌دار `outbox.requeue` ندارد.
    const denied = await app.inject({
      method: "POST",
      url: `/health/dead-letters/${id}/requeue`,
      ...(await loginAs(cashier)),
      payload: { reason: "تلاش بی‌مجوز" },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    // و دلیلِ کوتاه هم رد می‌شود — این یکی Zod است، پس ۴۰۰.
    const noReason = await app.inject({
      method: "POST",
      url: `/health/dead-letters/${id}/requeue`,
      ...s,
      payload: { reason: " " },
    });
    assert.equal(noReason.statusCode, 400, noReason.body);

    const ok = await app.inject({
      method: "POST",
      url: `/health/dead-letters/${id}/requeue`,
      ...s,
      payload: { reason: "قطعی شبکه رفع شد" },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const done = JSON.parse(ok.body) as { status: string; attempts: number };
    assert.equal(done.status, "pending");
    // بی صفرشدن `attempts`، اولین شکستِ بعدی همان لحظه دوباره می‌کشتش.
    assert.equal(done.attempts, 0);

    // و بار دوم ۴۰۹ می‌گیرد، چون دیگر مرده نیست.
    const again = await app.inject({
      method: "POST",
      url: `/health/dead-letters/${id}/requeue`,
      ...s,
      payload: { reason: "تلاش دوباره" },
    });
    assert.equal(again.statusCode, 409, again.body);
    const body = JSON.parse(again.body) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "rule_violation");
    assert.match(body.error.message, /مرده/);
  });
});
