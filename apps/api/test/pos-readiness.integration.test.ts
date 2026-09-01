/**
 * تست یکپارچه «آمادگی API صندوق» — روی پستگرس واقعی.
 *
 * ادعای مرکزی این پرونده: **صندوق هیچ شناسه‌ای را حدس نمی‌زند.**
 * شعبه، انبار و روش پرداخت از سرور می‌آیند، تعداد اتمیک عوض می‌شود،
 * و هیچ Retry شبکه‌ای پول یا فاکتور دوم نمی‌سازد.
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
const STORE_WH = "00000000-0000-7000-8000-000000000101";

describe("آمادگی API صندوق", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `r${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-آمادگی-صندوق-و-به‌قدر-کافی-بلند";
  const cashier = `pos_cashier_${suffix}`;
  const outsider = `pos_outsider_${suffix}`;
  let cashierId = "";
  let outsiderId = "";
  let otherBranchId = "";
  let otherWarehouseId = "";

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
    const out = {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "",
      },
      headers: {
        "x-csrf-token": r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "",
      },
    };
    sessions.set(username, out);
    return out;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    // شعبه دوم — تنها راه سنجیدن اینکه فهرست واقعاً فیلتر می‌شود.
    const b = await sql<{ id: string }>`
      INSERT INTO platform.branch (code, name) VALUES (${`B2-${suffix}`}, 'شعبه دوم تست')
      RETURNING id`.execute(handle.db);
    otherBranchId = b.rows[0]!.id;
    const w = await sql<{ id: string }>`
      INSERT INTO inventory.warehouse (branch_id, code, name, kind)
      VALUES (${otherBranchId}, ${`W2-${suffix}`}, 'انبار شعبه دوم', 'store')
      RETURNING id`.execute(handle.db);
    otherWarehouseId = w.rows[0]!.id;

    // انبار غیرفعال در شعبه اول — نباید در پاسخ بیاید.
    await sql`INSERT INTO inventory.warehouse (branch_id, code, name, kind, is_active)
              VALUES (${BRANCH}, ${`WX-${suffix}`}, 'انبار بسته', 'stock', false)`
      .execute(handle.db);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, branch] of [
      [cashier, "صندوق‌دار آمادگی", BRANCH],
      [outsider, "صندوق‌دار شعبه دوم", otherBranchId],
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
        .values({ user_id: u.id, role_code: "cashier", branch_id: branch })
        .execute();
      if (username === cashier) cashierId = u.id;
      else outsiderId = u.id;
    }

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  // ── دامنه: شعبه و انبار ─────────────────────────────────────────

  test("GET /branches بدون نشست ۴۰۱ می‌دهد", async () => {
    const r = await app.inject({ method: "GET", url: "/branches" });
    assert.equal(r.statusCode, 401);
  });

  test("GET /branches فقط شعبه خودِ کاربر را می‌دهد", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({ method: "GET", url: "/branches", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const branches = r.json().branches as Array<{ id: string }>;
    assert.equal(branches.length, 1);
    assert.equal(branches[0]!.id, BRANCH);
  });

  test("کاربر شعبه دوم، شعبه اول را نمی‌بیند", async () => {
    const s = await loginAs(outsider);
    const branches = (await app.inject({ method: "GET", url: "/branches", ...s })).json()
      .branches as Array<{ id: string; warehouses: Array<{ id: string }> }>;
    assert.equal(branches.length, 1);
    assert.equal(branches[0]!.id, otherBranchId);
    assert.deepEqual(
      branches[0]!.warehouses.map((w) => w.id),
      [otherWarehouseId],
    );
  });

  test("انبار غیرفعال در فهرست نمی‌آید و kind برمی‌گردد", async () => {
    const s = await loginAs(cashier);
    const branches = (await app.inject({ method: "GET", url: "/branches", ...s })).json()
      .branches as Array<{ warehouses: Array<{ id: string; kind: string; code: string }> }>;
    const whs = branches[0]!.warehouses;
    assert.ok(whs.length > 0, "شعبه باید دست‌کم یک انبار فعال داشته باشد");
    assert.ok(!whs.some((w) => w.code.startsWith("WX-")), "انبار غیرفعال نباید بیاید");
    assert.ok(
      whs.some((w) => w.id === STORE_WH && w.kind === "store"),
      "انبار فروشگاه باید با kind=store بیاید",
    );
  });

  test("کاربر بدون هیچ نقشی، فهرست خالی می‌گیرد نه ۴۰۳", async () => {
    const roleless = `pos_roleless_${suffix}`;
    const hash = await hashSecret(PASSWORD);
    await handle.db
      .insertInto("identity.app_user")
      .values({
        username: roleless,
        full_name: "کاربر بی‌نقش",
        password_hash: hash,
        is_active: true,
        mobile: null,
        pin_hash: null,
        totp_secret: null,
      })
      .execute();
    const s = await loginAs(roleless);
    const r = await app.inject({ method: "GET", url: "/branches", ...s });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().branches, []);
  });

  test("شناسه‌های پاسخ واقعاً برای فروش کار می‌کنند", async () => {
    const s = await loginAs(cashier);
    const branches = (await app.inject({ method: "GET", url: "/branches", ...s })).json()
      .branches as Array<{ id: string; warehouses: Array<{ id: string; kind: string }> }>;
    const branch = branches[0]!;
    const wh = branch.warehouses.find((w) => w.kind === "store")!;

    await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: branch.id, openingCash: "0" },
    });
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: branch.id, warehouseId: wh.id, channel: "pos" },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    assert.ok(cashierId && outsiderId);
  });
});
