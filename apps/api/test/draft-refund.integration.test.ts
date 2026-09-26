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
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { InvoiceService } from "../src/sales/invoice.ts";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const WH = "00000000-0000-7000-8000-000000000101";
describe("بازیابی پیش‌نویس پرداخت‌شده", { skip: !process.env.DATABASE_URL }, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let app: FastifyInstance;
  let variationId: string;
  let actorId: string;
  let shiftId: string;
  let admin: { cookies: Record<string, string>; headers: Record<string, string> };
  let cashier: typeof admin;
  const password = "draft-refund-test-password-only";
  before(async () => {
    const created = createDisposableDb(process.env.DATABASE_URL!);
    assert.ok(created, "دیتابیس واقعی آزمون باید ساخته شود");
    disposable = created;
    handle = createDb(disposable.url, 8);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    for (const role of ["admin", "cashier"]) {
      const username = `refund_${role}_${randomUUID().slice(0, 8)}`;
      const u = await sql<{ id: string }>`INSERT INTO identity.app_user(username,full_name,password_hash)
        VALUES (${username},'کاربر آزمون برگشت',${await hashSecret(password)}) RETURNING id`.execute(handle.db);
      await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id)
        VALUES (${u.rows[0]!.id}::uuid,${role},${BRANCH}::uuid)`.execute(handle.db);
      const r = await loginWithMfa(app, { method: "POST", url: "/auth/login",
        payload: { username, password, deviceFingerprint: username } });
      assert.equal(r.statusCode, 200, r.body);
      const cookies = Object.fromEntries(r.cookies.map((c) => [c.name, c.value]));
      const session = { cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
      if (role === "admin") { admin = session; actorId = u.rows[0]!.id; } else cashier = session;
    }
    const p = await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal)
      VALUES ('draft-refund-product','کالای بدون موجودی آزمون') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`INSERT INTO catalog.variation(product_id,color,size,sku)
      VALUES (${p.rows[0]!.id}::uuid,'آبی','M','draft-refund-sku') RETURNING id`.execute(handle.db);
    variationId = v.rows[0]!.id;
    await sql`INSERT INTO catalog.price(variation_id,price_list,amount) VALUES (${variationId}::uuid,'default',200000)`.execute(handle.db);
    const shift = await app.inject({ method: "POST", url: "/shifts", ...admin, payload: { branchId: BRANCH, openingCash: "0" } });
    assert.equal(shift.statusCode, 201, shift.body); shiftId = shift.json().id;
  });
  after(async () => { await app?.close(); await handle?.close(); disposable?.drop(); });

  async function draft(methodCode = "cash", refNo?: string) {
    // ورود قلم و دریافت وجه اکنون کسری شناخته‌شده را زود رد می‌کنند.
    // موجودی واقعی آزمون را پیش از فروش فراهم می‌کنیم؛ کسریِ بعد از دریافت
    // در آزمون مربوط، مانند فروش هم‌زمان صندوق دیگر، جدا ایجاد می‌شود.
    const balance = await sql<{qty:string}>`SELECT coalesce((SELECT on_hand FROM inventory.stock_balance
      WHERE variation_id=${variationId}::uuid AND warehouse_id=${WH}::uuid),0)::text qty`.execute(handle.db);
    if (Number(balance.rows[0]!.qty) < 1) await handle.db.transaction().execute(async trx => {
      await sql`SELECT platform.set_actor(${actorId}::uuid)`.execute(trx);
      await sql`SELECT inventory.apply_movement(${variationId}::uuid,${WH}::uuid,1,'opening',NULL,NULL,${actorId}::uuid,100000)`.execute(trx);
    });
    const d = await app.inject({ method: "POST", url: "/invoices", ...admin,
      payload: { branchId: BRANCH, warehouseId: WH, shiftId, channel: "pos" } });
    assert.equal(d.statusCode, 201, d.body);
    const id = d.json().id as string;
    const line = await app.inject({ method: "POST", url: `/invoices/${id}/lines`, ...admin, payload: { variationId, qty: "1" } });
    assert.equal(line.statusCode, 201, line.body);
    const pay = await app.inject({ method: "POST", url: `/invoices/${id}/payments`, ...admin,
      payload: { methodCode, amount: "200000", ...(refNo ? { refNo } : {}) } });
    assert.equal(pay.statusCode, 201, pay.body);
    return { id, paymentId: pay.json().paymentId as string };
  }
  function refund(d: { id: string; paymentId: string }, key = randomUUID(), extra = {}, session = admin) {
    return app.inject({ method: "POST", url: `/invoices/${d.id}/refund-draft`, ...session,
      headers: { ...session.headers, "idempotency-key": key },
      payload: { reason: "برگشت وجه آزمایشی", confirmed: true, paymentIds: [d.paymentId], ...extra } });
  }
  test("کمبود موجودی، برگشت صریح و replay بدون اثر دوم؛ سند تغییر نمی‌کند", async () => {
    const d = await draft();
    await handle.db.transaction().execute(async trx => {
      await sql`SELECT platform.set_actor(${actorId}::uuid)`.execute(trx);
      await sql`SELECT inventory.apply_movement(${variationId}::uuid,${WH}::uuid,-1,'sale','test_doc',${randomUUID()}::uuid,${actorId}::uuid,NULL)`.execute(trx);
    });
    const before = await sql<{ n: string }>`SELECT count(*)::text n FROM ledger.journal_entry`.execute(handle.db);
    const finalized = await app.inject({ method: "POST", url: `/invoices/${d.id}/finalize`, ...admin, payload: {} });
    assert.equal(finalized.statusCode, 409, finalized.body);
    const cancel = await app.inject({ method: "POST", url: `/invoices/${d.id}/cancel`, ...admin, payload: {} });
    assert.equal(cancel.json().error.code, "invoice_has_payment");
    const key = randomUUID();
    const out = await refund(d, key); assert.equal(out.statusCode, 200, out.body);
    assert.equal(out.json().invoice.status, "cancelled");
    const again = await refund(d, key); assert.equal(again.statusCode, 200, again.body); assert.equal(again.json().replayed, true);
    const data = await sql<{ status: string; audits: string; paid: string }>`SELECT p.status,
      (SELECT count(*)::text FROM platform.audit_log WHERE entity_id=${d.paymentId} AND action='payment.reverse_draft') audits,
      (SELECT count(*)::text FROM treasury.payment WHERE invoice_id=${d.id}::uuid) paid
      FROM treasury.payment p WHERE p.id=${d.paymentId}::uuid`.execute(handle.db);
    assert.equal(data.rows[0]!.status, "reversed"); assert.equal(data.rows[0]!.audits, "1"); assert.equal(data.rows[0]!.paid, "1");
    assert.equal((await new InvoiceService(handle.db).paidSoFar(d.id)), 0n);
    const after = await sql<{ n: string }>`SELECT count(*)::text n FROM ledger.journal_entry`.execute(handle.db);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
    const late = await app.inject({ method: "POST", url: `/invoices/${d.id}/payments`, ...admin, payload: { methodCode: "cash", amount: "1" } });
    assert.equal(late.statusCode, 409, late.body);
    await assert.rejects(sql`INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES (${d.id}::uuid,'cash',1)`.execute(handle.db), /پیش‌نویس/);
  });
  test("مجوز، تأیید، دلیل و snapshot پرداخت اجباری‌اند", async () => {
    const d = await draft();
    assert.equal((await refund(d, randomUUID(), {}, cashier)).statusCode, 403);
    assert.equal((await refund(d, randomUUID(), { confirmed: false })).statusCode, 400);
    assert.equal((await refund(d, randomUUID(), { reason: "" })).statusCode, 400);
    const stale = await refund(d, randomUUID(), { paymentIds: [randomUUID()] });
    assert.equal(stale.json().error.code, "payments_changed");
    assert.equal(await new InvoiceService(handle.db).paidSoFar(d.id), 200000n);
    assert.equal((await refund(d)).statusCode, 200);
  });
  test("پرداخت نامشخص، در انتظار یا تسویه‌شده fail-closed باقی می‌ماند", async () => {
    for (const status of ["unknown", "pending", "settled", "reconciled"]) {
      const d = await draft();
      await sql`UPDATE treasury.payment SET status=${status} WHERE id=${d.paymentId}::uuid`.execute(handle.db);
      const out = await refund(d);
      assert.equal(out.statusCode, 409, out.body); assert.equal(out.json().error.code, "payment_review_required");
      const cancel = await app.inject({ method: "POST", url: `/invoices/${d.id}/cancel`, ...admin, payload: {} });
      assert.equal(cancel.statusCode, 409, cancel.body);
      // داده آزمون مستقل به موفق برمی‌گردد؛ هیچ PSP واقعی در این آزمون نیست.
      await sql`UPDATE treasury.payment SET status='succeeded' WHERE id=${d.paymentId}::uuid`.execute(handle.db);
      assert.equal((await refund(d)).statusCode, 200);
    }
  });
  test("برگشت بانکی بدون شماره پیگیری تأیید نمی‌شود", async () => {
    const m = await sql<{ code: string }>`SELECT code FROM treasury.payment_method WHERE kind='transfer' LIMIT 1`.execute(handle.db);
    const d = await draft(m.rows[0]!.code, "original-ref");
    const noRef = await refund(d); assert.equal(noRef.json().error.code, "refund_reference_required");
    assert.equal((await refund(d, randomUUID(), { refundReference: "manual-bank-return-123" })).statusCode, 200);
  });
  test("سقف مبلغ مجوز برگشت از پرداخت‌های قفل‌شده سنجیده می‌شود", async () => {
    const d = await draft();
    await sql`UPDATE identity.permission_rule SET max_amount=1000 WHERE role_code='admin' AND operation='invoice.cancel'`.execute(handle.db);
    try {
      const out = await refund(d); assert.equal(out.statusCode,403,out.body);
      assert.equal(await new InvoiceService(handle.db).paidSoFar(d.id),200000n);
    } finally {
      await sql`UPDATE identity.permission_rule SET max_amount=NULL WHERE role_code='admin' AND operation='invoice.cancel'`.execute(handle.db);
    }
    assert.equal((await refund(d)).statusCode,200);
  });
  test("دو برگشت هم‌زمان فقط یک اثر دارند", async () => {
    const d = await draft();
    const results = await Promise.all([refund(d), refund(d)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const audit = await sql<{ n: string }>`SELECT count(*)::text n FROM platform.audit_log
      WHERE entity_id=${d.paymentId} AND action='payment.reverse_draft'`.execute(handle.db);
    assert.equal(audit.rows[0]!.n, "1");
  });
  test("رقابت پرداخت تازه با برگشت؛ نه پرداخت گم می‌شود نه به فاکتور لغوشده اضافه می‌شود", async () => {
    const d = await draft();
    const [back, pay] = await Promise.all([refund(d), app.inject({ method: "POST", url: `/invoices/${d.id}/payments`, ...admin,
      payload: { methodCode: "cash", amount: "1" } })]);
    assert.ok((back.statusCode === 200 && pay.statusCode === 409) || (back.statusCode === 409 && pay.statusCode === 201), `${back.body} / ${pay.body}`);
    if (pay.statusCode === 201) {
      const out = await refund(d, randomUUID(), { paymentIds: [d.paymentId, pay.json().paymentId] });
      assert.equal(out.statusCode, 200, out.body);
    }
  });
  test("پس از برگشت همه پیش‌نویس‌ها شیفت با مانده و مغایرت صفر بسته می‌شود", async () => {
    const closed = await app.inject({ method: "POST", url: `/shifts/${shiftId}/close`, ...admin, payload: { countedCash: "0" } });
    assert.equal(closed.statusCode, 200, closed.body); assert.equal(closed.json().variance, "0");
    const check = await sql<{ n: string }>`SELECT count(*)::text n FROM platform.audit_check`.execute(handle.db);
    assert.equal(check.rows[0]!.n, "0");
  });
  test("رقابت نهایی‌سازی با برگشت؛ فقط یکی موفق و کالا با پرداخت سازگار است", async () => {
    const opened = await app.inject({ method: "POST", url: "/shifts", ...admin, payload: { branchId: BRANCH, openingCash: "0" } });
    assert.equal(opened.statusCode, 201, opened.body); shiftId = opened.json().id;
    await handle.db.transaction().execute(async trx => {
      await sql`SELECT platform.set_actor(${actorId}::uuid)`.execute(trx);
      const balance = await sql<{qty:string}>`SELECT on_hand::text qty FROM inventory.stock_balance
        WHERE variation_id=${variationId}::uuid AND warehouse_id=${WH}::uuid`.execute(trx);
      await sql`SELECT inventory.apply_movement(${variationId}::uuid,${WH}::uuid,${2-Number(balance.rows[0]?.qty??0)},'opening',NULL,NULL,${actorId}::uuid,100000)`.execute(trx);
    });
    const d = await draft();
    const [back, finish] = await Promise.all([refund(d), app.inject({ method: "POST", url: `/invoices/${d.id}/finalize`, ...admin, payload: {} })]);
    assert.deepEqual([back.statusCode, finish.statusCode].sort(), [200,409]);
    const sold = finish.statusCode === 200;
    const state = await sql<{ status: string; qty: string }>`SELECT p.status, b.on_hand::text qty
      FROM treasury.payment p CROSS JOIN inventory.stock_balance b
      WHERE p.id=${d.paymentId}::uuid AND b.variation_id=${variationId}::uuid AND b.warehouse_id=${WH}::uuid`.execute(handle.db);
    assert.equal(state.rows[0]!.status, sold ? "succeeded" : "reversed");
    assert.equal(Number(state.rows[0]!.qty), sold ? 1 : 2);
    const closed = await app.inject({ method: "POST", url: `/shifts/${shiftId}/close`, ...admin, payload: { countedCash: sold ? "200000" : "0" } });
    assert.equal(closed.statusCode,200,closed.body); assert.equal(closed.json().variance,"0");
  });

});
