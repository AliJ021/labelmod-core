import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { hashApiKey, newApiKey } from "../src/auth/api-key.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const BR = "00000000-0000-7000-8000-000000000001", WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM = "00000000-0000-7000-8000-0000000000f1";
describe("107 sale quantity policy: real writes, restricted role and toggle ordering", { skip: !process.env.DATABASE_URL }, () => {
  let disposable: DisposableDb | null, db: DbHandle, owner: DbHandle, app: FastifyInstance;
  let variation: string, adminId: string;
  const password = "quantity-policy-synthetic-fixture-only", tag = randomUUID().slice(0, 8), sku = `QTY-${tag}`;
  const key = newApiKey();
  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
  const call = (method: "GET" | "POST" | "PATCH", url: string, who: string, payload?: object) => app.inject({
    method, url, ...sessions.get(who)!, ...(payload ? { payload } : {}),
    headers: { ...sessions.get(who)!.headers, "idempotency-key": randomUUID() },
  });
  async function toggle(value: boolean) {
    const r = await call("PATCH", "/settings/sales.allow_fractional_qty", "admin", { value });
    assert.equal(r.statusCode, 200, r.body);
  }
  async function draft(channel = "pos") {
    const r = await call("POST", "/invoices", "admin", { branchId: BR, warehouseId: WH, channel });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  }
  const line = (invoice: string, qty: string) => sql<{ id: string }>`INSERT INTO sales.invoice_line
    (invoice_id,line_no,variation_id,qty,unit_price,net_amount) VALUES
    (${invoice}::uuid,1,${variation}::uuid,${qty}::numeric,1000000,round(${qty}::numeric*1000000)) RETURNING id`.execute(db.db);
  before(async () => {
    disposable = createDisposableDb(process.env.DATABASE_URL!);
    assert.ok(disposable);
    db = createDb(disposable.url, 6); owner = createDb(disposable.ownerUrl, 4);
    const hash = await hashSecret(password);
    for (const role of ["admin", "cashier", "web"]) {
      const u = await sql<{ id: string }>`INSERT INTO identity.app_user(username,full_name,password_hash,is_active)
        VALUES (${`qty_${role}_${tag}`},${role},${hash},true) RETURNING id`.execute(owner.db);
      const id = u.rows[0]!.id;
      await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES (${id}::uuid,${role},${BR}::uuid)`.execute(owner.db);
      if (role === "admin") adminId = id;
      if (role === "web") await sql`INSERT INTO identity.api_client(name,user_id,key_hash,created_by)
        VALUES ('quantity-test',${id}::uuid,${hashApiKey(key)},${SYSTEM}::uuid)`.execute(owner.db);
    }
    const p = await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal) VALUES (${sku},'کالای آزمون تعداد') RETURNING id`.execute(owner.db);
    variation = (await sql<{ id: string }>`INSERT INTO catalog.variation(product_id,color,size,sku)
      VALUES (${p.rows[0]!.id}::uuid,'آبی','M',${sku}) RETURNING id`.execute(owner.db)).rows[0]!.id;
    await sql`INSERT INTO catalog.price(variation_id,price_list,amount) VALUES (${variation}::uuid,'default',1000000)`.execute(owner.db);
    await sql`SELECT inventory.apply_movement(${variation}::uuid,${WH}::uuid,100,'opening',NULL,NULL,${SYSTEM}::uuid,400000)`.execute(owner.db);
    app = await buildApp({ db: db.db, auth: new AuthService(db.db), config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    for (const who of ["admin", "cashier"]) {
      const r = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: who === "admin" ? "10.27.1.1" : "10.27.1.2",
        payload: { username: `qty_${who}_${tag}`, password, deviceFingerprint: `qty-${who}-${tag}` } });
      assert.equal(r.statusCode, 200, r.body);
      const cookie = (name: string) => r.cookies.find(c => c.name === name)!.value;
      sessions.set(who, { cookies: { labelmod_session: cookie("labelmod_session"), labelmod_csrf: cookie("labelmod_csrf") }, headers: { "x-csrf-token": cookie("labelmod_csrf") } });
    }
    const shift = await call("POST", "/shifts", "admin", { branchId: BR, openingCash: "0" });
    assert.equal(shift.statusCode, 201, shift.body);
  });
  after(async () => { await app?.close(); await db?.close(); await owner?.close(); disposable?.drop(); });

  test("default false, settings permission/audit, POS+IG add/scan/set, stale client and historical non-qty edit", async () => {
    const policy = await call("GET", `/pos/policy?branchId=${BR}`, "admin");
    assert.equal(policy.json().allowFractionalQty, false);
    const denied = await call("PATCH", "/settings/sales.allow_fractional_qty", "cashier", { value: true });
    assert.equal(denied.statusCode, 403, denied.body);
    for (const channel of ["pos", "instagram"]) {
      const id = await draft(channel);
      const fail = await call("POST", `/invoices/${id}/lines`, "admin", { variationId: variation, qty: "1.125" });
      assert.equal(fail.statusCode, 409, fail.body); assert.match(fail.body, /عدد صحیح/);
      await toggle(true);
      const scan = await call("POST", `/invoices/${id}/scan`, "admin", { variationId: variation, qty: "1.125" });
      assert.equal(scan.statusCode, 200, scan.body);
      const inv = await call("GET", `/invoices/${id}`, "admin"); const row = inv.json().lines[0];
      assert.equal(row.qty, "1.125");
      const update = await call("PATCH", `/invoices/${id}/lines/${row.id}`, "admin", { qty: "1.5" });
      assert.equal(update.statusCode, 200, update.body);
      await toggle(false);
      const stale = await call("PATCH", `/invoices/${id}/lines/${row.id}`, "admin", { qty: "1.125" });
      assert.equal(stale.statusCode, 409, stale.body);
      const delta = await call("POST", `/invoices/${id}/scan`, "admin", { variationId: variation, qty: "0.5" });
      assert.equal(delta.statusCode, 409, delta.body); // otherwise legacy1.5 +0.5 bypasses final-line guard
      const same = await call("PATCH", `/invoices/${id}/lines/${row.id}`, "admin", { qty: "1.500" });
      assert.equal(same.statusCode, 200, same.body);
      const price = await call("PATCH", `/invoices/${id}/lines/${row.id}/price`, "admin", { unitPrice: "1000000" });
      assert.equal(price.statusCode, 200, price.body);
      assert.equal(price.json().lines[0].qty, "1.500");
      const payment = await call("POST", `/invoices/${id}/payments`, "admin", {
        methodCode: channel === "instagram" ? "transfer" : "cash", amount: "1500000", refNo: `quantity-${channel}-${tag}`,
      });
      assert.equal(payment.statusCode, 201, payment.body);
      const finalized = await call("POST", `/invoices/${id}/finalize`, "admin", {});
      assert.equal(finalized.statusCode, 200, finalized.body);
      assert.equal(finalized.json().lines[0].qty, "1.500", "turning policy off does not freeze or rewrite prior drafts");
    }
    const audit = await sql<{ n: string }>`SELECT count(*)::text n FROM platform.audit_log
      WHERE entity_id = 'sales.allow_fractional_qty'`.execute(owner.db);
    assert.ok(BigInt(audit.rows[0]!.n) >= 4n, "toggles retain audit evidence");
  });

  test("direct restricted writes across channels: integer zeros, fractional move guard and rollback", async () => {
    await toggle(false);
    const rawDraft = async (channel: string) => channel === "instagram" ? draft(channel)
      : (await sql<{ id: string }>`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,created_by)
        VALUES (${BR}::uuid,${WH}::uuid,${channel},${adminId}::uuid) RETURNING id`.execute(db.db)).rows[0]!.id;
    for (const channel of ["pos", "instagram", "phone", "web"]) {
      // Raw app-role LINE insert bypasses HTTP validation, retaining IG's existing invoice gate.
      const id = await rawDraft(channel);
      await assert.rejects(line(id, "1.001"), /عدد صحیح/);
      await toggle(true); const l = (await line(id, "1.001")).rows[0]!.id; await toggle(false);
      await sql`UPDATE sales.invoice_line SET qty=qty, returned_qty=0 WHERE id=${l}::uuid`.execute(db.db);
      const next = await rawDraft(channel);
      await assert.rejects(sql`UPDATE sales.invoice_line SET invoice_id=${next}::uuid WHERE id=${l}::uuid`.execute(db.db), /عدد صحیح/);
      const one = await line(next, "1.000"); assert.ok(one.rows[0]!.id);
    }
    const c = await owner.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT platform.set_setting('sales.allow_fractional_qty','true',NULL,$1::uuid)", [adminId]);
      await c.query("SELECT sales.assert_sale_quantity(0.001)");
      await c.query("ROLLBACK");
      assert.equal((await call("GET", `/pos/policy?branchId=${BR}`, "admin")).json().allowFractionalQty, false);
    } finally { c.release(); }
  });

  test("two real connections: toggle waits for admitted write; a waiting writer sees committed false", async () => {
    await toggle(true);
    const invoice = await draft();
    const a = await db.pool.connect(), b = await owner.pool.connect();
    try {
      await a.query("BEGIN");
      const inserted = await a.query("INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount) VALUES ($1,1,$2,1.5,1000000,1500000) RETURNING id", [invoice, variation]);
      const lineId = inserted.rows[0].id;
      await b.query("BEGIN");
      const pid = (await b.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      const pending = b.query("SELECT platform.set_setting('sales.allow_fractional_qty','false',NULL,$1::uuid)", [adminId]);
      for (let attempt = 0; ; attempt++) {
        const r = await owner.pool.query("SELECT cardinality(pg_blocking_pids($1)) n", [pid]);
        if (r.rows[0].n > 0) break;
        assert.ok(attempt < 40, "toggle never waited on quantity-policy shared lock");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await a.query("COMMIT"); await pending; await b.query("COMMIT");
      await assert.rejects(a.query("UPDATE sales.invoice_line SET qty=1.75 WHERE id=$1", [lineId]), /عدد صحیح/);

      await toggle(true); await b.query("BEGIN");
      await b.query("SELECT platform.set_setting('sales.allow_fractional_qty','false',NULL,$1::uuid)", [adminId]);
      const aPid = (await a.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      const rejected = assert.rejects(a.query("UPDATE sales.invoice_line SET qty=1.75 WHERE id=$1", [lineId]), /عدد صحیح/);
      for (let attempt = 0; ; attempt++) {
        const r = await owner.pool.query("SELECT cardinality(pg_blocking_pids($1)) n", [aPid]);
        if (r.rows[0].n > 0) break;
        assert.ok(attempt < 40, "quantity write never waited on setting update");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await b.query("COMMIT"); await rejected;
      assert.equal((await a.query("SELECT qty::text FROM sales.invoice_line WHERE id=$1", [lineId])).rows[0].qty, "1.500");
    } finally { await Promise.all([a.query("ROLLBACK"), b.query("ROLLBACK")]); a.release(); b.release(); }
  });

  test("Woo fractional order obeys policy, replay survives toggle without another stock movement", async () => {
    const payload = { branchId: BR, warehouseId: WH, externalId: `qty-${tag}`,
      lines: [{ sku, qty: "0.125", unitPrice: "1000000" }], paymentMethod: "gateway", paymentRef: `qty-${tag}`, paidAmount: "125000" };
    const woo = () => app.inject({ method: "POST", url: "/web/orders", headers: { authorization: `Bearer ${key}` }, payload });
    await toggle(false); const no = await woo(); assert.equal(no.statusCode, 409, no.body);
    await toggle(true); const yes = await woo(); assert.ok([200, 201].includes(yes.statusCode), yes.body);
    const before = (await sql<{ n: string }>`SELECT count(*)::text n FROM inventory.stock_movement WHERE variation_id=${variation}::uuid`.execute(db.db)).rows[0]!.n;
    await toggle(false); const replay = await woo(); assert.ok([200, 201].includes(replay.statusCode), replay.body);
    const after = (await sql<{ n: string }>`SELECT count(*)::text n FROM inventory.stock_movement WHERE variation_id=${variation}::uuid`.execute(db.db)).rows[0]!.n;
    assert.equal(after, before);
  });
});
