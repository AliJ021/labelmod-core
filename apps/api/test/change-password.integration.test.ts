import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService, type LoginOutcome } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { newTotpSecret } from "../src/auth/totp.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const OLD = "current-fixture-" + randomUUID();
const NEXT = "next-fixture-" + randomUUID();
const WRONG = "wrong-fixture-" + randomUUID();
const CSRF = "csrf-fixture-" + randomUUID();

function live(outcome: LoginOutcome) {
  assert.equal(outcome.kind, "session");
  if (outcome.kind !== "session") throw new Error("نشست آزمایشی لازم است");
  return outcome.session;
}

describe("تغییر رمز شخصی و رگرسیون نشست", { skip: DATABASE_URL ? false : "DATABASE_URL تنظیم نشده" }, () => {
  let disposable: DisposableDb | null;
  let handle: DbHandle;
  let auth: AuthService;
  before(() => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("دیتابیس یک‌بارمصرف ساخته نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);
  });
  after(async () => { await handle?.close(); disposable?.drop(); });

  async function fixture() {
    const username = `password_${randomUUID().slice(0, 8)}`;
    const user = await handle.db.insertInto("identity.app_user").values({
      username, full_name: "کاربر آزمایشی", password_hash: await hashSecret(OLD),
      is_active: true, mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: user.id, role_code: "cashier", branch_id: null }).execute();
    const session = live(await auth.login({ username, password: OLD }));
    const app = await buildApp({ db: handle.db, auth, config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    const request = (payload: Record<string, unknown>, csrf = true) => app.inject({
      method: "POST", url: "/auth/change-password", payload,
      cookies: { labelmod_session: session.token, labelmod_csrf: CSRF },
      headers: csrf ? { "x-csrf-token": CSRF } : {},
    });
    return { user, username, session, app, request };
  }

  test("رمز اشتباه، رمز کوتاه و درخواست بی CSRF هیچ رمز یا نشستی را عوض نمی‌کنند", async () => {
    const f = await fixture();
    try {
      const wrong = await f.request({ currentPassword: WRONG, password: NEXT });
      assert.equal(wrong.statusCode, 401);
      assert.equal((await f.request({ currentPassword: OLD, password: "short" })).statusCode, 400);
      assert.equal((await f.request({ currentPassword: OLD, password: NEXT }, false)).statusCode, 403);
      assert.ok(await auth.resolve(f.session.token));
      live(await auth.login({ username: f.username, password: OLD }));
      const attempt = await handle.db.selectFrom("identity.auth_attempt").select("succeeded").where("user_id", "=", f.user.id).where("succeeded", "=", false).executeTakeFirst();
      assert.ok(attempt, "تلاش ناموفق باید ثبت شود");
    } finally { await f.app.close(); }
  });

  test("تغییر موفق همه نشست‌ها را باطل می‌کند؛ رمز تازه وارد می‌شود و عامل دوم دست‌نخورده است", async () => {
    const f = await fixture();
    try {
      const second = live(await auth.login({ username: f.username, password: OLD }));
      const response = await f.request({ currentPassword: OLD, password: NEXT });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { ok: true });
      assert.ok(response.cookies.some((c) => c.name === "labelmod_session" && c.value === ""));
      assert.equal(await auth.resolve(f.session.token), null);
      assert.equal(await auth.resolve(second.token), null);
      await assert.rejects(() => auth.login({ username: f.username, password: OLD }));
      live(await auth.login({ username: f.username, password: NEXT }));
      const unchanged = await handle.db.selectFrom("identity.app_user").select(["is_active", "totp_secret"]).where("id", "=", f.user.id).executeTakeFirstOrThrow();
      assert.deepEqual(unchanged, { is_active: true, totp_secret: null });
      const audit = await sql<{ n: string }>`SELECT count(*)::text AS n FROM platform.audit_log WHERE action = 'user.change_password' AND actor_id = ${f.user.id}::uuid`.execute(handle.db);
      assert.equal(audit.rows[0]?.n, "1");
    } finally { await f.app.close(); }
  });

  test("نشست غایب، شناسه کاربر دلخواه و رمز تکراری رد می‌شوند", async () => {
    const f = await fixture();
    try {
      assert.equal((await f.app.inject({ method: "POST", url: "/auth/change-password", payload: { currentPassword: OLD, password: NEXT } })).statusCode, 401);
      assert.equal((await f.request({ currentPassword: OLD, password: NEXT, userId: randomUUID() })).statusCode, 400);
      assert.equal((await f.request({ currentPassword: OLD, password: OLD })).statusCode, 400);
      assert.ok(await auth.resolve(f.session.token));
    } finally { await f.app.close(); }
  });

  test("نشست باطل یا قفل‌شده از سرویس هم نمی‌تواند رمز را عوض کند", async () => {
    const f = await fixture();
    try {
      await auth.lock(f.session.token);
      await assert.rejects(() => auth.changePassword(f.session.token, OLD, NEXT));
      live(await auth.login({ username: f.username, password: OLD }));
    } finally { await f.app.close(); }
  });

  test("Authenticator فعال پس از تغییر رمز همچنان برای ورود لازم است", async () => {
    const f = await fixture();
    try {
      const secret = newTotpSecret();
      await handle.db.updateTable("identity.app_user").set({ totp_secret: secret }).where("id", "=", f.user.id).execute();
      assert.equal((await f.request({ currentPassword: OLD, password: NEXT })).statusCode, 200);
      const user = await handle.db.selectFrom("identity.app_user").select("totp_secret").where("id", "=", f.user.id).executeTakeFirstOrThrow();
      assert.equal(user.totp_secret, secret);
      const login = await auth.login({ username: f.username, password: NEXT });
      assert.equal(login.kind, "second_factor");
    } finally { await f.app.close(); }
  });

  test("بازنشانی هم‌زمان پس از بررسی رمز فعلی، با رمز قدیمی بازنویسی نمی‌شود", async () => {
    const f = await fixture();
    const isolatedAuth = new AuthService(handle.db);
    const original = isolatedAuth.reauthenticate.bind(isolatedAuth);
    isolatedAuth.reauthenticate = async (token, current) => {
      await original(token, current);
      // جابه‌جایی قطعی دو درخواست در همان فاصله‌ای که باید محافظت شود.
      await auth.setPassword(f.user.id, NEXT, f.user.id);
    };
    try {
      await assert.rejects(() => isolatedAuth.changePassword(f.session.token, OLD, WRONG));
      live(await auth.login({ username: f.username, password: NEXT }));
      await assert.rejects(() => auth.login({ username: f.username, password: WRONG }));
    } finally { await f.app.close(); }
  });
});
