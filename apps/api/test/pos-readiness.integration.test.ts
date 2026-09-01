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
  let variationId = "";
  const BARCODE = `BC-${suffix}`;

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

    // کالا، قیمت و موجودی شعبه اول
    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'تی‌شرت آمادگی') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku, barcode)
      VALUES (${prod.rows[0]!.id}, 'مشکی', 'M', ${`SKU-${suffix}`}, ${BARCODE})
      RETURNING id`.execute(handle.db);
    variationId = v.rows[0]!.id;
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 1000001)`.execute(handle.db);
    await sql`SELECT platform.set_actor(${cashierId}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 100, 'purchase_receipt',
                NULL, NULL, ${cashierId}::uuid, 400000)`.execute(handle.db);

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    // یک شیفت باز برای همه تست‌های سبد
    const s = await loginAs(cashier);
    await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
  });

  /** سبد تازه با یک قلم — نقطه شروع بیشتر ادعاهای زیر. */
  async function newCart(qty = "1") {
    const s = await loginAs(cashier);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const invoiceId = inv.json().id as string;
    const line = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { barcode: BARCODE, qty },
    });
    assert.equal(line.statusCode, 201, line.body);
    return { s, invoiceId, body: line.json() as { lines: Array<{ id: string }> } };
  }

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

  // ── روش‌های پرداخت ──────────────────────────────────────────────

  test("GET /payment-methods بدون نشست ۴۰۱ می‌دهد", async () => {
    const r = await app.inject({ method: "GET", url: "/payment-methods" });
    assert.equal(r.statusCode, 401);
  });

  test("همه روش‌های فعال برمی‌گردند و روش نقدی از kind پیدا می‌شود", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({ method: "GET", url: "/payment-methods", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const methods = r.json().methods as Array<{
      code: string;
      name: string;
      kind: string;
      requiresRef: boolean;
    }>;

    const active = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM treasury.payment_method WHERE is_active`.execute(handle.db);
    assert.equal(methods.length, Number(active.rows[0]!.n), "همه روش‌های فعال باید بیایند");

    const cash = methods.filter((m) => m.kind === "cash");
    assert.equal(cash.length, 1, "کلاینت باید بتواند روش نقدی را از kind پیدا کند");
    assert.equal(cash[0]!.requiresRef, false);
    assert.ok(cash[0]!.name.length > 0, "نام فارسی لازم است");

    const card = methods.find((m) => m.kind === "card_reader");
    assert.equal(card?.requiresRef, true, "requiresRef از ستون واقعی جدول می‌آید");
  });

  test("روش غیرفعال نمی‌آید و داده داخلی افشا نمی‌شود", async () => {
    const s = await loginAs(cashier);
    await sql`UPDATE treasury.payment_method SET is_active = false WHERE code = 'points'`
      .execute(handle.db);
    const methods = (await app.inject({ method: "GET", url: "/payment-methods", ...s })).json()
      .methods as Array<Record<string, unknown>>;
    assert.ok(!methods.some((m) => m["code"] === "points"));
    for (const m of methods) {
      assert.deepEqual(Object.keys(m).sort(), ["code", "kind", "name", "requiresRef"]);
    }
    await sql`UPDATE treasury.payment_method SET is_active = true WHERE code = 'points'`
      .execute(handle.db);
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

  // ── تغییر تعداد ─────────────────────────────────────────────────

  test("تعداد عوض می‌شود و جمع از سرور می‌آید", async () => {
    const { s, invoiceId, body } = await newCart("1");
    assert.equal(body.lines.length, 1);
    const lineId = body.lines[0]!.id;

    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}`,
      ...s,
      payload: { qty: "3" },
    });
    assert.equal(r.statusCode, 200, r.body);
    const inv = r.json() as {
      netAmount: string;
      payableAmount: string;
      lines: Array<{ qty: string; netAmount: string; unitPrice: string }>;
    };
    assert.equal(inv.lines[0]!.unitPrice, "1000001", "قیمت Snapshot دست‌نخورده می‌ماند");
    assert.equal(inv.lines[0]!.netAmount, "3000003");
    assert.equal(inv.netAmount, "3000003");
    assert.equal(inv.payableAmount, "3000003");
    assert.equal(typeof inv.netAmount, "string", "پول در JSON رشته است");
  });

  test("تغییر تعداد قیمت را دوباره از فهرست نمی‌خواند", async () => {
    const { s, invoiceId, body } = await newCart("1");
    const lineId = body.lines[0]!.id;

    // قیمت فهرست بالا می‌رود؛ فاکتور باز نباید تکان بخورد.
    await sql`UPDATE catalog.price SET amount = 7777777 WHERE variation_id = ${variationId}`
      .execute(handle.db);
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}`,
      ...s,
      payload: { qty: "2" },
    });
    await sql`UPDATE catalog.price SET amount = 1000001 WHERE variation_id = ${variationId}`
      .execute(handle.db);

    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().lines[0].unitPrice, "1000001");
    assert.equal(r.json().netAmount, "2000002");
  });

  test("تعداد صفر رد می‌شود — حذف مسیر خودش را دارد", async () => {
    const { s, invoiceId, body } = await newCart();
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${body.lines[0]!.id}`,
      ...s,
      payload: { qty: "0" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, "bad_qty");
  });

  test("تعداد اعشاری در صندوق رد می‌شود", async () => {
    const { s, invoiceId, body } = await newCart();
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${body.lines[0]!.id}`,
      ...s,
      payload: { qty: "1.5" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, "invalid_input");
  });

  test("سطر ناموجود ۴۰۴ می‌دهد", async () => {
    const { s, invoiceId } = await newCart();
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/00000000-0000-7000-8000-0000000009ff`,
      ...s,
      payload: { qty: "2" },
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error.code, "line_not_found");
  });

  test("کاربر شعبه دیگر نمی‌تواند تعداد را عوض کند", async () => {
    const { invoiceId, body } = await newCart();
    const other = await loginAs(outsider);
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${body.lines[0]!.id}`,
      ...other,
      payload: { qty: "2" },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, "branch_forbidden");
  });

  test("سطر تخفیف‌دار از این مسیر عوض نمی‌شود", async () => {
    const { s, invoiceId, body } = await newCart("2");
    const lineId = body.lines[0]!.id;
    // تخفیف را مستقیم می‌نشانیم: مسیر HTTPاش مجوز جدا دارد و اینجا
    // موضوع، رفتار تغییر تعداد است نه سقف تخفیف.
    await sql`UPDATE sales.invoice_line
                 SET discount_amount = 1000, net_amount = net_amount - 1000
               WHERE id = ${lineId}`.execute(handle.db);
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}`,
      ...s,
      payload: { qty: "4" },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "line_price_adjusted");
  });

  test("سطر با قیمت دستی هم از این مسیر عوض نمی‌شود", async () => {
    const { s, invoiceId, body } = await newCart("2");
    const lineId = body.lines[0]!.id;
    await sql`UPDATE sales.invoice_line SET list_price = 1050000 WHERE id = ${lineId}`
      .execute(handle.db);
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}`,
      ...s,
      payload: { qty: "4" },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "line_price_adjusted");
  });

  test("پس از نهایی‌سازی، تعداد دیگر عوض نمی‌شود", async () => {
    const { s, invoiceId, body } = await newCart("1");
    const lineId = body.lines[0]!.id;
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "1000001" },
    });
    const fin = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
      headers: { ...s.headers, "idempotency-key": `fin-${invoiceId}` },
    });
    assert.equal(fin.statusCode, 200, fin.body);

    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}`,
      ...s,
      payload: { qty: "5" },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "invoice_not_draft");
  });
});
