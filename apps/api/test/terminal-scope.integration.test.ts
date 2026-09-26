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
type Terminal = { id?: string; accountId?: string; canEdit: boolean; settlesTo?: string | null };

describe("دامنه شعبه در تنظیمات پایانه", { skip: DATABASE_URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let app: FastifyInstance;
  let branchB: string;
  let limited: Actor;
  let global: Actor;
  let viewer: Actor;
  let own: string;
  let foreign: string;
  let shared: string;
  let foreignBank: string;
  let serial = 0;

  async function account(branch: string | null, kind = "card_terminal") {
    return (await sql<{ id: string }>`INSERT INTO treasury.account(code,name,kind,branch_id,ledger_account_code)
      VALUES(${`scope-${randomUUID()}`},${`حساب آزمایشی ${++serial}`},${kind},${branch}::uuid,
        ${kind === "bank" ? "1102" : "1103"}) RETURNING id`.execute(handle.db)).rows[0]!.id;
  }

  async function actor(branch: string | null, role = "admin") {
    const username = `terminal_${randomUUID().slice(0, 8)}`;
    const password = `terminal-fixture-${randomUUID()}`;
    const user = await handle.db.insertInto("identity.app_user").values({ username, full_name: "کاربر آزمون پایانه",
      password_hash: await hashSecret(password), is_active: true, mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: user.id, role_code: role, branch_id: branch }).execute();
    const login = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: `127.0.1.${++serial}`,
      payload: { username, password } });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = Object.fromEntries(login.cookies.map(c => [c.name, c.value]));
    return { id: user.id, cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
  }

  before(async () => {
    const made = createDisposableDb(DATABASE_URL!);
    assert.ok(made); disposable = made;
    handle = createDb(disposable.url, 6);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    branchB = (await handle.db.insertInto("platform.branch").values({ code: `scope-${randomUUID()}`,
      name: "شعبه دوم آزمون", is_active: true }).returning("id").executeTakeFirstOrThrow()).id;
    limited = await actor(A); global = await actor(null); viewer = await actor(A, "accountant");
    own = await account(A); foreign = await account(branchB); shared = await account(null);
    foreignBank = await account(branchB, "bank");
  });
  after(async () => { await app?.close(); await handle?.close(); disposable?.drop(); });

  function payload(path: string) {
    return path === "/settlement-terms" ? { settlementDays: 2, feePercent: "0.235", reason: "آزمون" }
      : { driverCode: null, config: { terminalLabel: "آزمون" }, reason: "آزمون" };
  }
  async function list(path: string, who: Actor) {
    const response = await app.inject({ method: "GET", url: path, ...who });
    assert.equal(response.statusCode, 200, response.body);
    return (path === "/settlement-terms" ? response.json().terms : response.json().terminals) as Terminal[];
  }
  const idOf = (row: Terminal) => row.id ?? row.accountId;
  async function stored(id: string) {
    return (await sql<{ data: unknown }>`SELECT to_jsonb(a) data FROM treasury.account a WHERE id=${id}::uuid`
      .execute(handle.db)).rows[0]!.data;
  }
  async function audits() {
    return (await sql<{ n: number }>`SELECT count(*)::int n FROM platform.audit_log
      WHERE action IN ('treasury.set_driver','treasury.settlement_terms')`.execute(handle.db)).rows[0]!.n;
  }

  for (const path of ["/settlement-terms", "/terminal-drivers"]) {
    test(`${path}: خواندن own/shared، رد foreign و تغییر مجاز با همان دامنه`, async () => {
      const visible = await list(path, limited);
      assert.ok(visible.some(r => idOf(r) === own && r.canEdit));
      assert.ok(!visible.some(r => idOf(r) === foreign));
      assert.ok(visible.some(r => idOf(r) === shared && !r.canEdit));
      const all = await list(path, global);
      assert.ok(all.some(r => idOf(r) === foreign && r.canEdit));
      assert.ok(all.some(r => idOf(r) === shared && r.canEdit));
      for (const id of [foreign, shared]) {
        const before = await stored(id); const count = await audits();
        const denied = await app.inject({ method: "PATCH", url: `${path}/${id}`, ...limited, payload: payload(path) });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.equal(denied.json().error.code, "branch_forbidden");
        assert.deepEqual(await stored(id), before); assert.equal(await audits(), count);
      }
      for (const [who, id] of [[limited, own], [global, foreign], [global, shared]] as const) {
        const changed = await app.inject({ method: "PATCH", url: `${path}/${id}`, ...who, payload: payload(path) });
        assert.equal(changed.statusCode, 200, changed.body);
        assert.equal(idOf(changed.json()), id);
      }
      assert.ok((await list(path, viewer)).every(r => !r.canEdit));
      const deniedViewer = await app.inject({ method: "PATCH", url: `${path}/${own}`, ...viewer, payload: payload(path) });
      assert.equal(deniedViewer.statusCode, 403, deniedViewer.body);
      await handle.db.updateTable("identity.session").set({ pin_unlocked: true }).where("user_id", "=", limited.id).execute();
      try {
        assert.ok((await list(path, limited)).every(r => !r.canEdit));
        const deniedPin = await app.inject({ method: "PATCH", url: `${path}/${own}`, ...limited, payload: payload(path) });
        assert.equal(deniedPin.statusCode, 403, deniedPin.body);
      } finally {
        await handle.db.updateTable("identity.session").set({ pin_unlocked: false }).where("user_id", "=", limited.id).execute();
      }
    });
  }

  test("نام بانک مقصد خارجی از طریق پایانه مجاز افشا نمی‌شود", async () => {
    await sql`UPDATE treasury.account SET settlement_account_id=${foreignBank}::uuid
      WHERE id IN (${own}::uuid,${shared}::uuid)`.execute(handle.db);
    const limitedRows = await list("/settlement-terms", limited);
    for (const id of [own, shared]) assert.equal(limitedRows.find(r => idOf(r) === id)?.settlesTo, null);
    const globalRows = await list("/settlement-terms", global);
    assert.equal(typeof globalRows.find(r => idOf(r) === own)?.settlesTo, "string");
    for (const branch of [A, null]) {
      const bank = await account(branch, "bank");
      await sql`UPDATE treasury.account SET settlement_account_id=${bank}::uuid WHERE id=${own}::uuid`.execute(handle.db);
      assert.equal(typeof (await list("/settlement-terms", limited)).find(r => idOf(r) === own)?.settlesTo, "string");
    }
  });

  for (const path of ["/settlement-terms", "/terminal-drivers"]) {
    for (const moved of ["account", "actor"] as const) {
    test(`${path}: تغییر دامنه ${moved} هنگام انتظار قفل، مجوز قدیمی را معتبر نمی‌کند`, async () => {
      const id = await account(A);
      const gate = new Client({ connectionString: disposable.ownerUrl });
      let request: Promise<{ statusCode: number; body: string }> | undefined;
      try {
        await gate.connect(); await gate.query("BEGIN");
        if (moved === "account") {
          await gate.query("UPDATE treasury.account SET branch_id=$1 WHERE id=$2", [branchB, id]);
        } else {
          await gate.query("SELECT id FROM identity.app_user WHERE id=$1 FOR UPDATE", [limited.id]);
          await gate.query("UPDATE identity.user_role SET branch_id=$1 WHERE user_id=$2", [branchB, limited.id]);
        }
        request = app.inject({ method: "PATCH", url: `${path}/${id}`, ...limited, payload: payload(path) });
        const pending = Promise.resolve(request);
        let waiting = false;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          await gate.query("SELECT pg_stat_clear_snapshot()");
          const check = await gate.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock') waiting`);
          if (check.rows[0]!.waiting) { waiting = true; break; }
          await pause(20);
        }
        await gate.query("COMMIT");
        const response = await pending;
        assert.ok(waiting, "درخواست واقعاً باید منتظر قفل حساب شده باشد");
        assert.equal(response.statusCode, 403, response.body);
        const row = (await sql<{ fee: string; config: unknown }>`SELECT fee_percent::text fee,driver_config config
          FROM treasury.account WHERE id=${id}::uuid`.execute(handle.db)).rows[0]!;
        assert.equal(row.fee, "0.000"); assert.deepEqual(row.config, {});
      } finally {
        await gate.query("ROLLBACK").catch(() => {}); await request; await gate.end();
        if (moved === "actor") await sql`UPDATE identity.user_role SET branch_id=${A}::uuid
          WHERE user_id=${limited.id}::uuid`.execute(handle.db);
      }
    });
    }
  }
});
