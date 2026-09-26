import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const A = "00000000-0000-7000-8000-000000000001";
type Actor = { id: string; cookies: Record<string, string>; headers: Record<string, string> };

describe("دامنه مدیریت دستگاه و نشست", { skip: DATABASE_URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let app: FastifyInstance;
  let branchB: string;
  let limited: Actor;
  let global: Actor;
  let serial = 0;

  async function actor(branch: string | null, extraBranch?: string) {
    const username = `device_${randomUUID().slice(0, 8)}`;
    const password = `device-fixture-${randomUUID()}`;
    const u = await handle.db.insertInto("identity.app_user").values({ id: `a${randomUUID().slice(1)}`, username, full_name: "کاربر آزمون دستگاه",
      password_hash: await hashSecret(password), is_active: true, mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: "admin", branch_id: branch }).execute();
    if (extraBranch) await handle.db.insertInto("identity.user_role")
      .values({ user_id: u.id, role_code: "cashier", branch_id: extraBranch }).execute();
    const r = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: `127.0.2.${++serial}`,
      payload: { username, password } });
    assert.equal(r.statusCode, 200, r.body);
    const cookies = Object.fromEntries(r.cookies.map(c => [c.name, c.value]));
    return { id: u.id, cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
  }
  async function device(branch: string | null) {
    return (await sql<{ id: string }>`INSERT INTO identity.device(fingerprint,label,kind,branch_id)
      VALUES(${randomUUID()},'دستگاه آزمایشی','desktop',${branch}::uuid) RETURNING id`.execute(handle.db)).rows[0]!.id;
  }
  async function stored(id: string) {
    return (await sql<{ data: unknown }>`SELECT to_jsonb(d) data FROM identity.device d WHERE id=${id}::uuid`
      .execute(handle.db)).rows[0]!.data;
  }
  const post = (id: string, action: string, who: Actor, payload = {}) =>
    app.inject({ method: "POST", url: `/devices/${id}/${action}`, ...who, payload });

  before(async () => {
    const made = createDisposableDb(DATABASE_URL!); assert.ok(made); disposable = made;
    handle = createDb(disposable.url, 6);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    branchB = (await handle.db.insertInto("platform.branch").values({ id: "a0000000-0000-7000-8000-000000000002", code: `device-${randomUUID()}`,
      name: "شعبه دوم آزمون دستگاه", is_active: true }).returning("id").executeTakeFirstOrThrow()).id;
    limited = await actor(A); global = await actor(null);
  });
  after(async () => { await app?.close(); await handle?.close(); disposable?.drop(); });

  test("فهرست و pending فقط دستگاه شعبه مجاز؛ دستگاه بی‌شعبه فقط برای مدیر همه شعب", async () => {
    const own = await device(A); const foreign = await device(branchB); const fresh = await device(null);
    for (const suffix of ["", "?pending=true"]) {
      const r = await app.inject({ method: "GET", url: `/devices${suffix}`, ...limited });
      assert.equal(r.statusCode, 200, r.body);
      const ids = r.json().devices.map((d: { id: string }) => d.id);
      assert.ok(ids.includes(own)); assert.ok(!ids.includes(foreign)); assert.ok(!ids.includes(fresh));
      const all = await app.inject({ method: "GET", url: `/devices${suffix}`, ...global });
      for (const id of [own, foreign, fresh]) assert.ok(all.json().devices.some((d: { id: string }) => d.id === id));
    }
  });

  test("تأیید اولیه و تخصیص شعبه فقط سراسری؛ مدیر شعبه نمی‌تواند با تغییر مقصد مالکیت بگیرد", async () => {
    for (const branch of [null, branchB]) {
      const id = await device(branch); const before = await stored(id);
      const denied = await post(id, "approve", limited, { branchId: A, label: "تلاش انتقال" });
      assert.equal(denied.statusCode, 403, denied.body); assert.deepEqual(await stored(id), before);
    }
    const fresh = await device(null);
    const missing = await post(fresh, "approve", global);
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json().error.code, "device_branch_required");
    const approved = await post(fresh, "approve", global, { branchId: A, label: "صندوق شعبه" });
    assert.equal(approved.statusCode, 200, approved.body);
    const own = await post(fresh, "approve", limited, { label: "نام تازه" });
    assert.equal(own.statusCode, 200, own.body);
    const before = await stored(fresh);
    const moved = await post(fresh, "approve", limited, { branchId: branchB });
    assert.equal(moved.statusCode, 403, moved.body); assert.deepEqual(await stored(fresh), before);
    const absent = await post(fresh, "approve", global, { branchId: randomUUID() });
    assert.equal(absent.statusCode, 404, absent.body);
  });

  test("ابطال دستگاه خارجی یا بی‌شعبه بدون اثر؛ دستگاه شعبه خود قابل ابطال است", async () => {
    for (const branch of [null, branchB]) {
      const id = await device(branch); const before = await stored(id);
      const denied = await post(id, "revoke", limited);
      assert.equal(denied.statusCode, 403, denied.body); assert.deepEqual(await stored(id), before);
      assert.equal((await post(id, "revoke", global)).statusCode, 200);
    }
    assert.equal((await post(await device(A), "revoke", limited)).statusCode, 200);
  });

  test("UUID شعبه با حروف بزرگ همان شعبه مجاز را نشانی می‌دهد", async () => {
    // شناسه شعبه مرجع فقط رقم دارد؛ شعبه دوم حتماً حروف دارد تا این کنترل معنی داشته باشد.
    const branchActor = await actor(branchB);
    const id = await device(branchB);
    const approved = await post(id.toUpperCase(), "approve", branchActor, { branchId: branchB.toUpperCase() });
    assert.equal(approved.statusCode, 200, approved.body);
    const denied = await post(id.toUpperCase(), "approve", limited, { branchId: branchB.toUpperCase() });
    assert.equal(denied.statusCode, 403, denied.body);
  });
  test("UUID کاربر با حروف بزرگ همان کاربر مجاز را نشانی می‌دهد", async () => {
    const target = await actor(A);
    const revoked = await app.inject({ method: "POST", url: `/users/${target.id.toUpperCase()}/revoke-sessions`,
      ...limited, payload: {} });
    assert.equal(revoked.statusCode, 200, revoked.body); assert.ok(revoked.json().revoked >= 1);
    assert.notEqual((await app.inject({ method: "GET", url: "/auth/me", ...target })).statusCode, 200);
    const foreign = await actor(branchB);
    const denied = await app.inject({ method: "POST", url: `/users/${foreign.id.toUpperCase()}/revoke-sessions`,
      ...limited, payload: {} });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me", ...foreign })).statusCode, 200);
  });

  test("نشست‌ها هم به دامنه کامل کاربر و هم به دستگاه محدودند، حتی با userId صریح", async () => {
    const own = await actor(A); const foreign = await actor(branchB); const mixed = await actor(A, branchB);
    const ownDevice = await device(A); const foreignDevice = await device(branchB);
    for (const target of [foreign, mixed, global]) await handle.db.updateTable("identity.session")
      .set({ device_id: ownDevice }).where("user_id", "=", target.id).execute();
    for (const suffix of ["", `?userId=${foreign.id}`, `?userId=${mixed.id}`, `?userId=${global.id}`]) {
      const r = await app.inject({ method: "GET", url: `/sessions${suffix}`, ...limited });
      assert.equal(r.statusCode, 200, r.body);
      const ids = r.json().sessions.map((s: { userId: string }) => s.userId);
      for (const target of [foreign, mixed, global]) assert.ok(!ids.includes(target.id));
      if (suffix === "") assert.ok(ids.includes(own.id));
    }
    await handle.db.updateTable("identity.session").set({ device_id: foreignDevice }).where("user_id", "=", own.id).execute();
    const hidden = await app.inject({ method: "GET", url: `/sessions?userId=${own.id}`, ...limited });
    assert.deepEqual(hidden.json().sessions, []);
    const all = await app.inject({ method: "GET", url: "/sessions", ...global });
    for (const target of [own, foreign, mixed, global]) assert.ok(all.json().sessions.some((s: { userId: string }) => s.userId === target.id));
  });

  test("قطع همه نشست‌های کاربر خارجی، سراسری یا چندشعبه‌ای رد می‌شود؛ کاربر شعبه خود مجاز است", async () => {
    const own = await actor(A); const foreign = await actor(branchB); const mixed = await actor(A, branchB);
    for (const target of [foreign, mixed, global]) {
      const denied = await app.inject({ method: "POST", url: `/users/${target.id}/revoke-sessions`, ...limited, payload: {} });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal((await app.inject({ method: "GET", url: "/auth/me", ...target })).statusCode, 200);
    }
    for (const [by, target] of [[limited, own], [global, foreign]] as const) {
      const allowed = await app.inject({ method: "POST", url: `/users/${target.id}/revoke-sessions`, ...by, payload: {} });
      assert.equal(allowed.statusCode, 200, allowed.body); assert.ok(allowed.json().revoked >= 1);
      assert.notEqual((await app.inject({ method: "GET", url: "/auth/me", ...target })).statusCode, 200);
    }
  });

  for (const moved of ["device", "actor", "target"] as const) {
    test(`تغییر دامنه ${moved} در انتظار قفل بررسی نهایی را دور نمی‌زند`, async () => {
      const id = await device(A); const target = await actor(A);
      const gate = new Client({ connectionString: disposable.ownerUrl });
      let request: Promise<{ statusCode: number; body: string }> | undefined;
      try {
        await gate.connect(); await gate.query("BEGIN");
        if (moved === "device") await gate.query("UPDATE identity.device SET branch_id=$1 WHERE id=$2", [branchB, id]);
        else {
          const userId = moved === "actor" ? limited.id : target.id;
          await gate.query("SELECT id FROM identity.app_user WHERE id=$1 FOR UPDATE", [userId]);
          await gate.query("UPDATE identity.user_role SET branch_id=$1 WHERE user_id=$2", [branchB, userId]);
        }
        request = moved === "target"
          ? app.inject({ method: "POST", url: `/users/${target.id}/revoke-sessions`, ...limited, payload: {} })
          : post(id, "approve", limited);
        const pending = Promise.resolve(request);
        let waiting = false; const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          await gate.query("SELECT pg_stat_clear_snapshot()");
          const check = await gate.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock') waiting`);
          if (check.rows[0]!.waiting) { waiting = true; break; }
          await pause(20);
        }
        await gate.query("COMMIT"); const response = await pending;
        assert.ok(waiting, "درخواست واقعاً باید منتظر قفل دامنه شده باشد");
        assert.equal(response.statusCode, 403, response.body);
        assert.equal((await handle.db.selectFrom("identity.device").select("is_approved").where("id", "=", id).executeTakeFirstOrThrow()).is_approved, false);
        assert.equal((await app.inject({ method: "GET", url: "/auth/me", ...target })).statusCode, 200);
      } finally {
        await gate.query("ROLLBACK").catch(() => {}); await request; await gate.end();
        if (moved === "actor") await sql`UPDATE identity.user_role SET branch_id=${A}::uuid WHERE user_id=${limited.id}::uuid`.execute(handle.db);
      }
    });
  }
});
