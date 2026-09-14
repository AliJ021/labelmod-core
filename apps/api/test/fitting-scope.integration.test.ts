import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const url = process.env.DATABASE_URL;
const BRANCH = "00000000-0000-7000-8000-000000000001";
const WH = "00000000-0000-7000-8000-000000000101";
const ACTOR = "00000000-0000-7000-8000-0000000000f1";

describe("دامنه موجودی پیشنهاد سایز با ورود واقعی", {
  skip: url ? false : "DATABASE_URL موجود نیست؛ آزمون اجرا نشده است",
}, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let app: FastifyInstance;
  let otherBranch: string, otherWh: string, customer: string, shared: string, user: string;
  const sessions = new Map<string, Record<string, string>>();

  before(async () => {
    const created = createDisposableDb(url!);
    assert.ok(created, "ساخت دیتابیس یک‌بارمصرف ناموفق بود");
    disposable = created;
    handle = createDb(disposable.url, 5);
    const db = handle.db;
    const password = randomBytes(24).toString("hex");
    const hash = await hashSecret(password);
    for (const [name, role, branch] of [
      ["fitting_scope_user", "supervisor", BRANCH],
      ["fitting_scope_admin", "admin", null],
    ] as const) {
      const r = await sql<{ id: string }>`INSERT INTO identity.app_user(username,full_name,password_hash)
        VALUES(${name},'کاربر مصنوعی',${hash}) RETURNING id`.execute(db);
      if (branch) user = r.rows[0]!.id;
      await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id)
        VALUES(${r.rows[0]!.id},${role},${branch}::uuid)`.execute(db);
    }
    const b = await sql<{ id: string }>`INSERT INTO platform.branch(code,name)
      VALUES('FIT-B2','شعبه دوم مصنوعی') RETURNING id`.execute(db);
    otherBranch = b.rows[0]!.id;
    const w = await sql<{ id: string }>`INSERT INTO inventory.warehouse(branch_id,code,name,kind)
      VALUES(${otherBranch},'FIT-W2','انبار دوم مصنوعی','store') RETURNING id`.execute(db);
    otherWh = w.rows[0]!.id;
    const c = await sql<{ id: string }>`INSERT INTO sales.customer(full_name)
      VALUES('مشتری مصنوعی') RETURNING id`.execute(db);
    customer = c.rows[0]!.id;
    // کالای فقط شعبه دوم پیش از کالای مجاز مرتب می‌شود؛ scope باید قبل از LIMIT باشد.
    for (const [code, name, quantities] of [
      ["FIT-HIDDEN", "AAA", [[otherWh, 999]]],
      ["FIT-SHARED", "ZZZ", [[WH, 5], [otherWh, 77]]],
    ] as const) {
      const p = await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal)
        VALUES(${code},${name}) RETURNING id`.execute(db);
      const v = await sql<{ id: string }>`INSERT INTO catalog.variation(product_id,color,size,sku)
        VALUES(${p.rows[0]!.id},'آبی','M',${code}) RETURNING id`.execute(db);
      if (code === "FIT-SHARED") shared = v.rows[0]!.id;
      for (const [warehouse, qty] of quantities) {
        await sql`SELECT inventory.apply_movement(${v.rows[0]!.id}::uuid,${warehouse}::uuid,
          ${qty}::numeric,'purchase_receipt','test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid,${ACTOR}::uuid,1000)`.execute(db);
      }
    }
    app = await buildApp({ db, auth: new AuthService(db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    for (const username of ["fitting_scope_user", "fitting_scope_admin"]) {
      const response = await app.inject({ method: "POST", url: "/auth/login",
        payload: { username, password, deviceFingerprint: `device-${username}` } });
      assert.equal(response.statusCode, 200, "ورود از مسیر واقعی باید موفق باشد");
      sessions.set(username, Object.fromEntries(response.cookies.map(c => [c.name, c.value])));
    }
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  function get(query = "", actor = "fitting_scope_user") {
    return app.inject({ method: "GET", url: `/customers/${customer}/fitting${query}`,
      cookies: sessions.get(actor)! });
  }

  test("انبار موجود شعبه دیگر با خطای دامنه رد می‌شود", async () => {
    const own = await get(`?warehouseId=${WH}`);
    assert.equal(own.statusCode, 200, "مجوز اولیه برقرار است");
    assert.equal(own.json().variations[0].onHand, "5.000");
    const other = await get(`?warehouseId=${otherWh}`);
    assert.equal(other.statusCode, 403);
    assert.equal(other.json().error.code, "branch_forbidden");
  });

  test("حذف فیلتر انبار فقط موجودی شعبه مجاز را جمع می‌کند", async () => {
    const r = await get();
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().variations.map((v: {variationId: string; onHand: string}) =>
      [v.variationId, v.onHand]), [[shared, "5.000"]]);
  });

  test("کالای شعبه دیگر ظرفیت LIMIT را مصرف نمی‌کند", async () => {
    const r = await get("?limit=1");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().variations[0]?.variationId, shared);
    assert.equal(r.json().variations[0]?.onHand, "5.000");
  });

  test("مدیر سراسری جمع مجاز هر دو شعبه را می‌بیند", async () => {
    const r = await get("", "fitting_scope_admin");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().variations.length, 2);
    assert.equal(r.json().variations.find((v: {variationId: string}) =>
      v.variationId === shared)?.onHand, "82.000");
  });

  test("تغییر شعبه نقش با همان نشست در درخواست بعدی اعمال می‌شود", async () => {
    const db = handle.db;
    try {
      await sql`UPDATE identity.user_role SET branch_id=${otherBranch}::uuid WHERE user_id=${user}::uuid`.execute(db);
      const old = await get(`?warehouseId=${WH}`);
      assert.equal(old.statusCode, 403);
      const r = await get();
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().variations.find((v: {variationId: string}) =>
        v.variationId === shared)?.onHand, "77.000");
    } finally {
      await sql`UPDATE identity.user_role SET branch_id=${BRANCH}::uuid WHERE user_id=${user}::uuid`.execute(db);
    }
  });
});
