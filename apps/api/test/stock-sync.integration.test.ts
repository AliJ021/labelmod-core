import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * کارت همگام‌سازی سایت (داشبورد C) — شمار دقیق Core → سایت از همان صف، و سایت → Core «نامعلوم»
 * وقتی پیکربندی نیست (نه صفر). روی پستگرس واقعی؛ فقط‌خواندنی.
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

describe("کارت همگام‌سازی سایت", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  let adminId = "";
  const suffix = `s${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-همگام‌سازی-و-به‌قدر-کافی-بلند";
  const users = { admin: `sadm_${suffix}`, supervisor: `ssup_${suffix}`, cashier: `scash_${suffix}` };
  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, { method: "POST", url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` } });
    assert.equal(r.statusCode, 200, r.body);
    const csrf = r.cookies.find(c => c.name === "labelmod_csrf")?.value ?? "";
    const out = { cookies: { labelmod_session: r.cookies.find(c => c.name === "labelmod_session")?.value ?? "", labelmod_csrf: csrf }, headers: { "x-csrf-token": csrf } };
    sessions.set(username, out);
    return out;
  }
  const get = async (username: string) => app.inject({ method: "GET", url: "/dashboard/stock-sync", ...(await loginAs(username)) });

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    owner = createDb(disposable.ownerUrl, 2);
    const hash = await hashSecret(PASSWORD);
    for (const [username, role] of [[users.admin, "admin"], [users.supervisor, "supervisor"], [users.cashier, "cashier"]] as const) {
      const u = await handle.db.insertInto("identity.app_user").values({ username, full_name: username, password_hash: hash,
        is_active: true, mobile: null, pin_hash: null, totp_secret: null }).returning("id").executeTakeFirstOrThrow();
      await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: role, branch_id: BRANCH }).execute();
      if (role === "admin") adminId = u.id;
    }
    // هر حالت صف یک یا چند پیام سایت؛ پیام غیرسایتی و پیام فرستاده‌شده شمرده نمی‌شوند.
    await sql`
      INSERT INTO platform.outbox_message (topic, payload, status, attempts, next_attempt_at, created_at, last_error, sent_at) VALUES
        ('web.stock_push',  '{}', 'pending', 0, now() - interval '1 minute', now() - interval '10 minutes', NULL, NULL),
        ('web.stock_push',  '{}', 'pending', 0, now() - interval '1 minute', now() - interval '9 minutes',  NULL, NULL),
        ('web.price_push',  '{}', 'pending', 0, now() + interval '5 minutes', now() - interval '8 minutes',  NULL, NULL),
        ('web.stock_push',  '{}', 'pending', 2, now() + interval '2 minutes', now() - interval '20 minutes', 'HTTP 503', NULL),
        ('web.stock_push',  '{}', 'sending', 1, now() + interval '90 seconds', now() - interval '1 minute', NULL, NULL),
        ('web.instore_push','{}', 'sending', 1, now() - interval '30 seconds', now() - interval '30 minutes', NULL, NULL),
        ('web.stock_push',  '{}', 'dead',    8, now(), now() - interval '2 hours', 'HTTP 500', NULL),
        ('web.unknown',     '{}', 'dead',    1, now(), now() - interval '3 hours', 'موضوع ناشناخته', NULL),
        ('web.stock_push',  '{}', 'sent',    1, now(), now() - interval '4 hours', NULL, now() - interval '3 hours'),
        ('web.price_push',  '{}', 'sent',    1, now(), now() - interval '50 minutes', NULL, '2026-09-16T08:00:00Z'),
        ('sms.invoice_link','{}', 'dead',    8, now(), now() - interval '5 hours', 'x', NULL),
        ('sms.invoice_link','{}', 'pending', 0, now() - interval '1 minute', now() - interval '6 hours', NULL, NULL)`.execute(owner.db);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  test("Core → سایت: هر حالت جدا و دقیق؛ پیام غیرسایتی و فرستاده‌شده شمرده نمی‌شوند؛ نمونه با برچسب «از کل»", async () => {
    const r = await get(users.admin);
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body);
    assert.deepEqual(body.coreToWoo.counts, { due: 2, scheduled: 1, retrying: 1, running: 1, leaseExpired: 1, deadExhausted: 1, deadRejected: 1 });
    assert.equal(body.coreToWoo.enabled, false, "Push پیش‌فرض خاموش است و همان گفته می‌شود");
    assert.equal(body.coreToWoo.lastSentAt, "2026-09-16T08:00:00.000Z", "آخرین پیام فرستاده‌شده به ترتیب شناسه");
    assert.ok(body.coreToWoo.oldestOpenSeconds >= 30 * 60 && body.coreToWoo.oldestOpenSeconds < 31 * 60, "قدیمی‌ترین پیام باز (sending با اجارهٔ گذشته)");
    assert.equal(body.coreToWoo.sample.total, 4);
    assert.deepEqual(body.coreToWoo.sample.items.map((i: { state: string }) => i.state), ["deadRejected", "deadExhausted", "leaseExpired", "retrying"]);
    for (const i of body.coreToWoo.sample.items) {
      assert.equal(typeof i.id, "string");
      assert.deepEqual(Object.keys(i).sort(), ["ageSeconds", "attempts", "hasError", "id", "state", "topic"], "نه payload، نه متن خطا");
    }
    assert.ok(!/HTTP 50|ناشناخته/.test(r.body), "متن خطای مقصد بیرون نمی‌رود");
    assert.equal(r.headers["cache-control"], "no-store");
  });

  test("سایت → Core بی نشانی سایت: «نامعلوم» با دلیل، هیچ شماره‌ای (نه صفر)", async () => {
    const body = JSON.parse((await get(users.admin)).body);
    assert.equal(body.wooToCore.state, "unknown");
    assert.equal(body.wooToCore.code, "not_configured");
    assert.ok(!("counts" in body.wooToCore));
  });

  test("فقط‌خواندنی و پشت settings.view: سرپرست می‌بیند، صندوق‌دار ۴۰۳، ناشناس ۴۰۱؛ صف دست نمی‌خورد", async () => {
    const before = (await sql<{ s: string }>`SELECT string_agg(id || ':' || status || ':' || attempts, ',' ORDER BY id) AS s FROM platform.outbox_message`.execute(owner.db)).rows[0]!.s;
    assert.equal((await get(users.supervisor)).statusCode, 200);
    assert.equal((await get(users.cashier)).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/dashboard/stock-sync" })).statusCode, 401);
    const afterRows = (await sql<{ s: string }>`SELECT string_agg(id || ':' || status || ':' || attempts, ',' ORDER BY id) AS s FROM platform.outbox_message`.execute(owner.db)).rows[0]!.s;
    assert.equal(afterRows, before);
  });

  test("انبار سایت بیرون از دامنهٔ کاربر: ۴۰۳ پیش از هر درخواست بیرونی", async () => {
    const other = await sql<{ id: string }>`INSERT INTO platform.branch (code, name) VALUES (${"SYNC-B2-" + suffix}, 'شعبهٔ دوم') RETURNING id`.execute(owner.db);
    const wh = await sql<{ code: string }>`INSERT INTO inventory.warehouse (branch_id, code, name, kind)
      VALUES (${other.rows[0]!.id}::uuid, ${"SYNC-W2-" + suffix}, 'انبار سایت', 'store') RETURNING code`.execute(owner.db);
    const set = (key: string, value: string) =>
      sql`SELECT platform.set_setting(${key}, to_jsonb(${value}::text), 'آزمون کارت همگام‌سازی', ${adminId}::uuid)`.execute(owner.db);
    await set("web.stock_warehouse", wh.rows[0]!.code);
    await set("web.site_url", "https://shop.example.test");
    try {
      const r = await get(users.admin);
      assert.equal(r.statusCode, 403, r.body);
    } finally {
      await set("web.site_url", "");
      await set("web.stock_warehouse", "");
    }
  });
});
