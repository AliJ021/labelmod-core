import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret, verifySecret } from "../src/auth/password.ts";
import { UserService } from "../src/people/user.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const OLD = `old-policy-fixture-${randomUUID()}`;
const BRANCH = "00000000-0000-7000-8000-000000000001";

describe("سیاست رمز در همه مسیرهای نوشتن", { skip: DATABASE_URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let auth: AuthService;
  let users: UserService;
  let app: FastifyInstance;
  let adminId: string;
  let adminSession: { cookies: Record<string, string>; headers: Record<string, string> };

  async function fixture(role = "cashier") {
    const username = `policy_${randomUUID().slice(0, 8)}`;
    const user = await handle.db.insertInto("identity.app_user").values({
      username, full_name: "کاربر سیاست آزمایشی", password_hash: await hashSecret(OLD),
      is_active: true, mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: user.id, role_code: role, branch_id: null }).execute();
    return { ...user, username };
  }

  async function storedHash(id: string) {
    return (await handle.db.selectFrom("identity.app_user").select("password_hash")
      .where("id", "=", id).executeTakeFirstOrThrow()).password_hash;
  }

  before(async () => {
    const made = createDisposableDb(DATABASE_URL!);
    assert.ok(made);
    disposable = made;
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);
    users = new UserService(handle.db);
    const admin = await fixture("admin");
    adminId = admin.id;
    app = await buildApp({ db: handle.db, auth, config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    const login = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: "127.0.0.31",
      payload: { username: admin.username, password: OLD } });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = Object.fromEntries(login.cookies.map(c => [c.name, c.value]));
    adminSession = { cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
    await sql`SELECT platform.set_setting('auth.min_password_length','64'::jsonb,'آزمون سیاست',${adminId}::uuid)`.execute(handle.db);
  });

  after(async () => { await app?.close(); await handle?.close(); disposable?.drop(); });

  test("بازنشانی کوتاه هیچ hash، نشست یا audit را تغییر نمی‌دهد؛ مرز دقیق مجاز است", async () => {
    const target = await fixture();
    const login = await auth.login({ username: target.username, password: OLD });
    assert.equal(login.kind, "session", "افزایش سیاست نباید ورود رمز قدیمی را ببندد");
    if (login.kind !== "session") throw new Error("نشست لازم است");
    const beforeHash = await storedHash(target.id);
    const auditCount = async () => (await sql<{ n: number }>`SELECT count(*)::int n FROM platform.audit_log
      WHERE action='user.reset_password'`.execute(handle.db)).rows[0]!.n;
    const beforeAudit = await auditCount();
    const rejected = await app.inject({ method: "POST", url: `/users/${target.id}/reset-password`, ...adminSession,
      payload: { password: "x".repeat(63) } });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error.code, "invalid_input");
    for (const plain of ["", "x".repeat(11), "x".repeat(63), "x".repeat(257)]) {
      await assert.rejects(() => users.resetPassword(target.id, adminId, plain));
    }
    assert.equal(await storedHash(target.id), beforeHash);
    assert.ok(await auth.resolve(login.session.token));
    assert.equal(await auditCount(), beforeAudit);
    const chosen = "ر".repeat(64);
    const accepted = await app.inject({ method: "POST", url: `/users/${target.id}/reset-password`, ...adminSession,
      payload: { password: chosen } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().password, chosen);
    assert.ok(await verifySecret(await storedHash(target.id), chosen));
    assert.equal(await auth.resolve(login.session.token), null);
  });

  test("رمزهای تصادفی ساخت و بازنشانی، حداقل تنظیم‌شده را رعایت می‌کنند", async () => {
    const username = `policy_new_${randomUUID().slice(0, 8)}`;
    const created = await users.create({ username, fullName: "کاربر تولید رمز", actorId: adminId,
      roles: [{ roleCode: "cashier", branchId: BRANCH }] });
    assert.equal(created.password.length, 64);
    assert.ok(await verifySecret(await storedHash(created.id), created.password));
    assert.equal((await auth.login({ username, password: created.password })).kind, "session");
    const reset = await users.resetPassword(created.id, adminId);
    assert.equal(reset.length, 64);
    assert.notEqual(reset, created.password);
    assert.ok(await verifySecret(await storedHash(created.id), reset));
    assert.equal((await auth.login({ username, password: reset })).kind, "session");
  });

  test("CLI واقعی هم سیاست دیتابیس یک‌بارمصرف را می‌خواند", async () => {
    const username = `policy_cli_${randomUUID().slice(0, 8)}`;
    const out = execFileSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../src/cli/create-user.ts", import.meta.url)),
      "--username", username, "--name", "کاربر CLI آزمایشی", "--role", "cashier", "--branch", "MAIN"],
    { env: { ...process.env, DATABASE_URL: disposable.url }, encoding: "utf8", timeout: 30000 });
    const password = out.match(/رمز عبور\s*:\s*(\S+)/u)?.[1];
    assert.ok(password, "CLI باید رمز را پس از موفقیت برگرداند");
    assert.equal(password.length, 64);
    const row = await handle.db.selectFrom("identity.app_user").select("password_hash").where("username", "=", username).executeTakeFirstOrThrow();
    assert.ok(await verifySecret(row.password_hash, password));
  });

  test("تغییر شخصی و setter همان سیاست را دارند؛ PIN چهاررقمی مستقل می‌ماند", async () => {
    const target = await fixture();
    const login = await auth.login({ username: target.username, password: OLD });
    assert.equal(login.kind, "session");
    if (login.kind !== "session") throw new Error("نشست لازم است");
    await assert.rejects(() => auth.changePassword(login.session.token, OLD, "x".repeat(63)));
    await assert.rejects(() => auth.setPassword(target.id, "x".repeat(63), adminId));
    await assert.rejects(() => auth.setPassword(target.id, "x".repeat(257), adminId));
    assert.ok(await auth.resolve(login.session.token));
    await auth.setPin(target.id, "4321", adminId);
    const pin = await handle.db.selectFrom("identity.app_user").select("pin_hash").where("id", "=", target.id).executeTakeFirstOrThrow();
    assert.ok(await verifySecret(pin.pin_hash, "4321"));
    await auth.changePassword(login.session.token, OLD, "س".repeat(64));
    assert.ok(await verifySecret(await storedHash(target.id), "س".repeat(64)));
    assert.equal(await auth.resolve(login.session.token), null);
    await auth.setPassword(target.id, "x".repeat(256), adminId);
    assert.ok(await verifySecret(await storedHash(target.id), "x".repeat(256)));
  });

  test("تغییر سیاست میان بررسی اولیه و ثبت، رمز کوتاه را وارد دیتابیس نمی‌کند", async () => {
    const target = await fixture();
    const login = await auth.login({ username: target.username, password: OLD });
    assert.equal(login.kind, "session");
    if (login.kind !== "session") throw new Error("نشست لازم است");
    await sql`SELECT platform.set_setting('auth.min_password_length','32'::jsonb,'آزمون رقابت',${adminId}::uuid)`.execute(handle.db);
    const isolatedAuth = new AuthService(handle.db);
    const reauthenticate = isolatedAuth.reauthenticate.bind(isolatedAuth);
    isolatedAuth.reauthenticate = async (token, current) => {
      await reauthenticate(token, current);
      await sql`SELECT platform.set_setting('auth.min_password_length','64'::jsonb,'آزمون رقابت',${adminId}::uuid)`.execute(handle.db);
    };
    try {
      await assert.rejects(() => isolatedAuth.changePassword(login.session.token, OLD, "z".repeat(32)));
      assert.ok(await verifySecret(await storedHash(target.id), OLD));
      assert.ok(await auth.resolve(login.session.token));
    } finally {
      await sql`SELECT platform.set_setting('auth.min_password_length','64'::jsonb,'پایان آزمون رقابت',${adminId}::uuid)`.execute(handle.db);
    }
  });
});
