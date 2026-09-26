import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { WebauthnService } from "../src/auth/webauthn.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { InvoiceService } from "../src/sales/invoice.ts";
import { ShiftService } from "../src/sales/shift.ts";
import { ReturnService } from "../src/sales/return.ts";
import { VariationService } from "../src/catalog/variation.ts";
import { makeSender } from "../src/worker/sms.ts";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const WAREHOUSE = "00000000-0000-7000-8000-000000000101";
const PASSWORD = "security-regression-fixture-only";

describe("یافته‌های امنیتی: مسیر واقعی و کنترل مجاز", () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;
  let userId: string;
  let variationId: string;
  let productId: string;

  async function user(tag: string) {
    const username = `security-${tag}-${randomUUID()}`;
    const row = await sql<{ id: string }>`INSERT INTO identity.app_user
      (username,full_name,password_hash,is_active) VALUES
      (${username},'آزمون امنیتی',${await hashSecret(PASSWORD)},true) RETURNING id`.execute(owner.db);
    const id = row.rows[0]!.id;
    await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id)
      VALUES(${id}::uuid,'supervisor',${BRANCH}::uuid)`.execute(owner.db);
    return { id, username };
  }

  async function draft(db = handle.db) {
    return new InvoiceService(db).createDraft({ branchId: BRANCH, warehouseId: WAREHOUSE,
      channel: "web", actorId: userId });
  }

  before(async () => {
    assert.ok(process.env.DATABASE_URL, "این آزمون به دیتابیس یک‌بارمصرف واقعی نیاز دارد");
    const created = createDisposableDb(process.env.DATABASE_URL);
    assert.ok(created, "ساخت دیتابیس آزمون شکست خورد");
    disposable = created;
    handle = createDb(disposable.url, 3);
    owner = createDb(disposable.ownerUrl, 2);
    auth = new AuthService(handle.db);
    userId = (await user("fixture")).id;
    const product = await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal)
      VALUES('SEC-REG','کالای آزمون امنیتی') RETURNING id`.execute(owner.db);
    productId = product.rows[0]!.id;
    const variants = await new VariationService(handle.db).generate({ productId,
      colors: ["آبی"], sizes: ["M"], price: 100000n, actorId: userId });
    variationId = variants.created[0]!.id;
    app = await buildApp({ db: handle.db, auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  test("اسکن با یک اتصال، بدون رزرو اتصال دوم اجرا می‌شود", { timeout: 15000 }, async () => {
    const single = createDb(disposable.url, 1);
    try {
      const invoices = new InvoiceService(single.db);
      const inv = await draft(single.db);
      for (let i = 0; i < 2; i++) {
        await single.db.transaction().execute(trx => invoices.scanIn(trx, {
          invoiceId: inv.id, variationId, qty: "1", actorId: userId,
        }));
      }
      const result = await invoices.byId(inv.id);
      assert.equal(result!.lines.length, 1);
      assert.equal(Number(result!.lines[0]!.qty), 2);
    } finally { await single.close(); }
  });

  test("بستن شیفت با یک اتصال و رد بستن مجدد", { timeout: 15000 }, async () => {
    const single = createDb(disposable.url, 1);
    try {
      const shifts = new ShiftService(single.db);
      const shift = await shifts.open({ userId, branchId: BRANCH, openingCash: 0n });
      const input = { shiftId: shift.id, countedCash: 0n, actorId: userId };
      await single.db.transaction().execute(trx => shifts.closeIn(trx, input));
      assert.equal((await shifts.byId(shift.id))!.status, "closed");
      await assert.rejects(single.db.transaction().execute(trx => shifts.closeIn(trx, input)),
        { code: "shift_not_open" });
    } finally { await single.close(); }
  });

  test("کلیدهای ذخیره‌شده ماتریس، prototype را تغییر نمی‌دهند", async () => {
    await new VariationService(handle.db).generate({ productId,
      colors: ["__proto__", "constructor"], sizes: ["discountAmount", "__proto__"], actorId: userId });
    try {
      const matrix = await new VariationService(handle.db).stockMatrix(productId, [WAREHOUSE]);
      assert.equal(Object.hasOwn(Object.prototype, "discountAmount"), false);
      assert.equal(Object.hasOwn(matrix.cells, "__proto__"), true);
      assert.equal(Object.hasOwn(matrix.cells["constructor"]!, "__proto__"), true);
      const json = JSON.parse(JSON.stringify(matrix));
      assert.ok(json.cells["آبی"].M.variationId);
      assert.ok(json.cells["__proto__"].discountAmount.variationId);
    } finally {
      // آلودگی نسخهٔ آسیب‌پذیر فقط در همین فرایند آزمون پاک می‌شود.
      Reflect.deleteProperty(Object.prototype, "discountAmount");
    }
  });

  test("مجموع برچسب‌ها پیش از ساخت صفحه محدود می‌شود", async () => {
    const u = await user("labels");
    const login = await auth.login({ username: u.username, password: PASSWORD });
    assert.equal(login.kind, "session");
    if (login.kind !== "session") throw new Error("نشست لازم است");
    const cookies = { labelmod_session: login.session.token, labelmod_csrf: login.session.csrfToken };
    const headers = { "x-csrf-token": login.session.csrfToken };
    const response = await app.inject({ method: "POST", url: "/labels", cookies, headers,
      payload: { items: Array.from({ length: 6 }, () => ({ variationId: randomUUID(), count: 100 })) } });
    assert.equal(response.statusCode, 400, response.body);
    const control = await app.inject({ method: "POST", url: "/labels", cookies, headers,
      payload: { items: [{ variationId, count: 2 }] } });
    assert.equal(control.statusCode, 200, control.body);
  });

  test("رمز درست هنگام lockout قفل را پاک نمی‌کند", async () => {
    const u = await user("reauth");
    const login = await auth.login({ username: u.username, password: PASSWORD });
    assert.equal(login.kind, "session");
    if (login.kind !== "session") throw new Error("نشست لازم است");
    await auth.reauthenticate(login.session.token, PASSWORD);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(auth.reauthenticate(login.session.token, "wrong-fixture"), { code: "bad_credentials" });
    }
    await assert.rejects(auth.reauthenticate(login.session.token, PASSWORD), { code: "locked" });
    const state = await sql<{ locked: boolean }>`SELECT identity.is_locked(${u.id}::uuid,NULL,'password') AS locked`.execute(owner.db);
    assert.equal(state.rows[0]!.locked, true);
  });

  test("بیش از ۴۸ ساعت با گردکردن به بازه مجاز برنمی‌گردد", async () => {
    const inv = await draft();
    const svc = new ReturnService(handle.db);
    await sql`UPDATE sales.invoice SET finalized_at=now()-interval '48 hours 1 second' WHERE id=${inv.id}::uuid`.execute(owner.db);
    assert.equal((await svc.returnWindow(inv.id)).late, true);
    await sql`UPDATE sales.invoice SET finalized_at=now()-interval '47 hours 59 minutes' WHERE id=${inv.id}::uuid`.execute(owner.db);
    assert.equal((await svc.returnWindow(inv.id)).late, false);
  });

  test("ورود Passkey بدنهٔ response را به اعتبارسنج می‌رساند و replay رد می‌شود", async t => {
    const u = await user("passkey");
    await sql`INSERT INTO identity.webauthn_credential(user_id,credential_id,public_key,counter,device_type,backed_up)
      VALUES(${u.id}::uuid,${randomUUID()},'fixture-public-key',0,'multiDevice',true)`.execute(owner.db);
    const login = await auth.login({ username: u.username, password: PASSWORD });
    assert.equal(login.kind, "second_factor");
    if (login.kind !== "second_factor") throw new Error("بلیت عامل دوم لازم است");
    const verifier = t.mock.method(WebauthnService.prototype, "finishAuthentication", async () => true);
    const request = { method: "POST" as const, url: "/auth/2fa/webauthn/verify",
      cookies: { labelmod_pending: login.pendingToken }, payload: { response: { id: "fixture" } } };
    const result = await app.inject(request);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(verifier.mock.callCount(), 1);
    assert.ok(result.cookies.some(c => c.name === "labelmod_session"));
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 401, replay.body);
    assert.equal(verifier.mock.callCount(), 1);
  });

  test("لاگ پیامک فاقد موبایل، متن، شماره چک و توکن فاکتور است", async t => {
    const lines: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => { lines.push(String(chunk)); return true; });
    const sender = makeSender({ provider: "log", sender: "", apiKey: "" });
    await sender.send("09123456789", "نام مشتری مبلغ 125000 شماره چک 99123 https://example.test/i/private-capability");
    assert.equal(lines.length, 1);
    for (const value of ["09123456789", "مشتری", "125000", "99123", "private-capability"]) {
      assert.equal(lines.join("").includes(value), false);
    }
  });
});
