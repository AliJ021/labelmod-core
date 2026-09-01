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

// شناسه‌ها از **کد کسب‌وکاری** پیدا می‌شوند، نه UUID رونویسی‌شده از
// Seed. اگر روزی `040_reference.sql` شناسه‌ها را عوض کند، تست باید
// همچنان کار کند — وگرنه همان «حدس‌زدن شناسه» را می‌کند که ادعای
// مرکزی این پرونده می‌گوید صندوق نباید بکند.
let BRANCH = "";
let STORE_WH = "";

describe("آمادگی API صندوق", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `r${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-آمادگی-صندوق-و-به‌قدر-کافی-بلند";
  const cashier = `pos_cashier_${suffix}`;
  const outsider = `pos_outsider_${suffix}`;
  const supervisor = `pos_sup_${suffix}`;
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

    const seeded = await sql<{ branch_id: string; warehouse_id: string }>`
      SELECT b.id AS branch_id, w.id AS warehouse_id
        FROM platform.branch b
        JOIN inventory.warehouse w ON w.branch_id = b.id AND w.code = 'STORE'
       WHERE b.code = 'MAIN'`.execute(handle.db);
    const seedRow = seeded.rows[0];
    if (!seedRow) throw new Error("شعبه MAIN یا انبار STORE در Seed پیدا نشد");
    BRANCH = seedRow.branch_id;
    STORE_WH = seedRow.warehouse_id;

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
    for (const [username, name, branch, role] of [
      [cashier, "صندوق‌دار آمادگی", BRANCH, "cashier"],
      [outsider, "صندوق‌دار شعبه دوم", otherBranchId, "cashier"],
      [supervisor, "سرپرست آمادگی", BRANCH, "supervisor"],
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
        .values({ user_id: u.id, role_code: role, branch_id: branch })
        .execute();
      if (username === cashier) cashierId = u.id;
      else if (username === outsider) outsiderId = u.id;
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

  // ── Idempotency ایجاد فاکتور ────────────────────────────────────

  test("همان کلید و همان Payload، همان فاکتور را برمی‌گرداند", async () => {
    const s = await loginAs(cashier);
    const key = `create-${suffix}-1`;
    const payload = { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" };

    const a = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload,
    });

    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().replayed, false);
    assert.equal(b.json().replayed, true);
    assert.equal(a.json().id, b.json().id, "پیش‌نویس دوم ساخته نشد");

    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.invoice WHERE id = ${a.json().id}`.execute(handle.db);
    assert.equal(n.rows[0]!.n, "1");
  });

  test("همان کلید با Payload متفاوت، Conflict می‌دهد", async () => {
    const s = await loginAs(cashier);
    const key = `create-${suffix}-2`;
    await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    const clash = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "phone" },
    });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error.code, "idempotency_key_reused");
  });

  test("همان کلید از کاربر دیگر، فاکتور کسی را لو نمی‌دهد", async () => {
    const s = await loginAs(cashier);
    const key = `create-${suffix}-3`;
    await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });

    const other = await loginAs(outsider);
    const r = await app.inject({
      method: "POST",
      url: "/invoices",
      ...other,
      headers: { ...other.headers, "idempotency-key": key },
      payload: { branchId: otherBranchId, warehouseId: otherWarehouseId, channel: "pos" },
    });
    // یا Conflict (چون actorId در Payload است) یا ۴۰۳/۴۲۲ — ولی هرگز
    // فاکتور شعبه اول.
    assert.notEqual(r.statusCode, 200);
    assert.notEqual(r.statusCode, 201);
  });

  test("دو درخواست هم‌زمان با یک کلید، دو فاکتور نمی‌سازند", async () => {
    const s = await loginAs(cashier);
    const key = `create-${suffix}-race`;
    const payload = { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" };
    const send = () =>
      app.inject({
        method: "POST",
        url: "/invoices",
        ...s,
        headers: { ...s.headers, "idempotency-key": key },
        payload,
      });

    const [a, b] = await Promise.all([send(), send()]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.ok(
      codes.every((c) => c === 200 || c === 201 || c === 409),
      `وضعیت‌های غیرمنتظره: ${codes.join(",")}`,
    );
    assert.ok(
      codes.every((c) => c < 500),
      "هیچ‌کدام نباید خطای سرور بدهد",
    );

    // Payload هر دو یکسان است؛ پس ۴۰۹ فقط می‌تواند «هنوز در جریان»
    // باشد. «کلید برای درخواست دیگری استفاده شده» اینجا یعنی مقایسه
    // Payload دو درخواست یکسان را متفاوت دیده — باگ، نه مسابقه.
    for (const r of [a, b]) {
      if (r.statusCode === 409) {
        assert.equal(r.json().error.code, "idempotency_in_flight", `کد غیرمنتظره: ${r.body}`);
      }
    }

    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.inbox_message
       WHERE source = 'api.invoice.create' AND event_id = ${key}`.execute(handle.db);
    assert.equal(rows.rows[0]!.n, "1", "فقط یک رکورد Inbox");

    const ids = new Set(
      [a, b].filter((r) => r.statusCode < 300).map((r) => r.json().id as string),
    );
    assert.equal(ids.size, 1, "هر دو پاسخ موفق باید همان فاکتور باشند");
  });

  test("بدون کلید، رفتار قبلی دست‌نخورده می‌ماند", async () => {
    const s = await loginAs(cashier);
    const payload = { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" };
    const a = await app.inject({ method: "POST", url: "/invoices", ...s, payload });
    const b = await app.inject({ method: "POST", url: "/invoices", ...s, payload });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.notEqual(a.json().id, b.json().id);
  });

  // ── خلاصه روز ───────────────────────────────────────────────────

  test("صندوق‌دار فروش و دریافتی را می‌بیند، ولی سود را نه", async () => {
    // `cost.view` طبق `040_reference.sql` فقط حسابدار و مدیر دارند.
    // ولی «چقدر پول در کشوست» را صندوق‌دار آخر شب لازم دارد، پس کل
    // مسیر ۴۰۳ نمی‌شود.
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: `/reports/daily?branchId=${BRANCH}`,
      ...s,
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(typeof body.salesAmount, "string", "پول در JSON رشته است");
    assert.equal(typeof body.receivedAmount, "string");
    assert.equal(body.profitAmount, null, "سود بدون cost.view دیده نمی‌شود");
  });

  test("سود `null` است، نه صفر", async () => {
    // صفر یک ادعای مالی است («امروز سودی نبود»)؛ «اجازه نداری» ادعای
    // دیگری است. یکی‌کردنشان یعنی صندوق‌دار فکر کند فروشگاه ضرر کرده.
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: `/reports/daily?branchId=${BRANCH}`,
      ...s,
    });
    assert.notEqual(r.json().profitAmount, "0");
    assert.equal(r.json().profitAmount, null);
  });

  test("خلاصه روز شعبه دیگر ۴۰۳ می‌گیرد", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: `/reports/daily?branchId=${otherBranchId}`,
      ...s,
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  test("تاریخ نامعتبر رد می‌شود", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: `/reports/daily?branchId=${BRANCH}&date=دیروز`,
      ...s,
    });
    assert.equal(r.statusCode, 400, r.body);
  });

  test("بدون نشست، خلاصه روز بیرون نمی‌رود", async () => {
    const r = await app.inject({ method: "GET", url: `/reports/daily?branchId=${BRANCH}` });
    assert.equal(r.statusCode, 401);
  });

  // ── تخفیف روی سطر موجود ─────────────────────────────────────────

  test("تخفیف روی سطر موجود، Snapshot قیمت را دست نمی‌زند", async () => {
    // تنها راه دیگر حذف و افزودن دوباره بود — و آن قیمت را از
    // catalog.price دوباره می‌خواند.
    const { s, invoiceId, body } = await newCart("2");
    const lineId = body.lines[0]!.id;

    // قیمت فهرست را عوض می‌کنیم: اگر تخفیف باعث بازقیمت‌گذاری شود،
    // ادعای بعدی می‌شکند.
    await sql`UPDATE catalog.price SET amount = 9999999 WHERE variation_id = ${variationId}::uuid`
      .execute(handle.db);

    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}/discount`,
      ...s,
      payload: { discountAmount: "100000", discountReason: "مشتری قدیمی" },
    });

    await sql`UPDATE catalog.price SET amount = 1000001 WHERE variation_id = ${variationId}::uuid`
      .execute(handle.db);

    assert.equal(r.statusCode, 200, r.body);
    const line = (r.json().lines as Array<Record<string, string>>)[0]!;
    assert.equal(line.unitPrice, "1000001", "قیمت لحظه فروش دست‌نخورده");
    assert.equal(line.discountAmount, "100000");
    assert.equal(line.netAmount, "1900002", "۲×۱۰۰۰۰۰۱ منهای تخفیف");
    assert.equal(r.json().netAmount, "1900002", "جمع فاکتور بازساخته شد");
  });

  test("تخفیف بیشتر از مبلغ قلم، همان خطای مسیر افزودن قلم را می‌دهد", async () => {
    // ادعای واقعی این تست «۴۲۲» نیست، «**همان**» است: هر دو مسیر از
    // یک دروازه رد می‌شوند، پس باید یک کد بدهند. اگر روزی از هم جدا
    // شوند، اینجا قرمز می‌شود.
    const { s, invoiceId, body } = await newCart("1");
    const lineId = body.lines[0]!.id;

    const viaPatch = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}/discount`,
      ...s,
      payload: { discountAmount: "99999999" },
    });
    const viaAdd = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { barcode: BARCODE, qty: "1", discountAmount: "99999999" },
    });

    assert.equal(viaPatch.statusCode, 422, viaPatch.body);
    assert.equal(viaPatch.json().error.code, "discount_exceeds_line");
    assert.equal(viaAdd.statusCode, viaPatch.statusCode, "دو مسیر، یک کد وضعیت");
    assert.equal(viaAdd.json().error.code, viaPatch.json().error.code, "دو مسیر، یک کد خطا");

    // لایه دوم هم سر جایش است: نگهبان دیتابیس مستقیماً هم رد می‌کند.
    await assert.rejects(
      sql`SELECT sales.set_line_discount(${invoiceId}::uuid, ${lineId}::uuid, 99999999)`.execute(
        handle.db,
      ),
    );
  });

  test("سطری که در این فاکتور نیست رد می‌شود", async () => {
    const { s, invoiceId } = await newCart("1");
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/00000000-0000-7000-8000-0000000009ff/discount`,
      ...s,
      payload: { discountAmount: "1000" },
    });
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(r.json().error.code, "line_not_found");
  });

  test("تخفیف بالای سقف صندوق‌دار، تأیید می‌خواهد نه رد خاموش", async () => {
    // همان نردبان `sale.discount` → `sale.discount_high` که مسیر
    // افزودن قلم دارد — چون هر دو از یک دروازه رد می‌شوند.
    const { s, invoiceId, body } = await newCart("1");
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${body.lines[0]!.id}/discount`,
      ...s,
      payload: { discountAmount: "900000" },
    });
    assert.ok(r.statusCode === 403 || r.statusCode === 428, `کد غیرمنتظره: ${r.body}`);
  });

  test("تخفیف روی فاکتور شعبه دیگر ممکن نیست", async () => {
    const { invoiceId, body } = await newCart("1");
    const other = await loginAs(outsider);
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${body.lines[0]!.id}/discount`,
      ...other,
      payload: { discountAmount: "1000" },
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  // ── یافتن فاکتور از روی شماره رسید ──────────────────────────────

  test("فاکتور نهایی‌شده از روی شماره رسید پیدا می‌شود", async () => {
    // مرجوعی از روی رسیدِ دست مشتری شروع می‌شود و روی آن شماره چاپ
    // شده، نه UUID.
    const { s, invoiceId } = await newCart("1");
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "1000001" },
    });
    const done = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/finalize`, ...s });
    assert.equal(done.statusCode, 200, done.body);
    const number = done.json().number as string;
    assert.ok(number, "شماره تخصیص یافت");

    const found = await app.inject({
      method: "GET",
      url: `/invoices/lookup?number=${encodeURIComponent(number)}&branchId=${BRANCH}`,
      ...s,
    });
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().id, invoiceId, "همان فاکتور");
    assert.equal(found.json().receivedAmount, "1000001", "دریافتی هم می‌آید");
  });

  test("مسیر lookup را مسیریاب شناسه نمی‌خواند", async () => {
    // این چیزی است که با یک جابه‌جایی بی‌ربط در همین فایل می‌شکند:
    // اگر `/invoices/:id` زودتر ثبت شود، «lookup» یک شناسه نامعتبر
    // حساب می‌شود و ۴۰۰ می‌گیرد نه ۴۰۴.
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: `/invoices/lookup?number=NOPE-${suffix}&branchId=${BRANCH}`,
      ...s,
    });
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(r.json().error.code, "invoice_not_found");
  });

  test("رسید شعبه دیگر پیدا نمی‌شود", async () => {
    // شماره در سطح شعبه یکتاست، نه سراسری. بدون دامنه، صندوق‌دار
    // شعبه A رسید شعبه B را می‌دید.
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: `/invoices/lookup?number=F-1405-000001&branchId=${otherBranchId}`,
      ...s,
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  test("بدون نشست، جست‌وجوی رسید کار نمی‌کند", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/invoices/lookup?number=X&branchId=${BRANCH}`,
    });
    assert.equal(r.statusCode, 401);
  });

  // ── علت‌های مرجوعی ──────────────────────────────────────────────

  test("صندوق‌دار علت‌های مرجوعی را با برچسب فارسی می‌گیرد", async () => {
    // از راه `GET /settings` ممکن نبود: آن `settings.view` می‌خواهد و
    // صندوق‌دار ندارد. تنها راه دیگر نوشتن فهرست در کد بود.
    const s = await loginAs(cashier);
    const r = await app.inject({ method: "GET", url: "/return-reasons", ...s });
    assert.equal(r.statusCode, 200, r.body);

    const reasons = r.json().reasons as Array<{ code: string; label: string }>;
    assert.ok(reasons.length > 0, "فهرست خالی نیست");
    for (const x of reasons) {
      assert.deepEqual(Object.keys(x).sort(), ["code", "label"], "فقط کد و برچسب بیرون می‌رود");
    }

    const small = reasons.find((x) => x.code === "size_small");
    assert.ok(small, "کد نمونه هست");
    assert.equal(small.label, "سایز کوچک بود", "برچسب فارسی، نه خودِ کد");
  });

  test("علتی که در فهرست مجاز نیست بیرون نمی‌رود", async () => {
    // `options` برچسب همه کدهای شناخته‌شده را دارد، ولی `value` فهرست
    // مجازهاست. نشان‌دادن علتی که سرور بعداً ردش می‌کند، بدتر از
    // ندیدنش است.
    const s = await loginAs(cashier);
    const r = await app.inject({ method: "GET", url: "/return-reasons", ...s });
    const codes = (r.json().reasons as Array<{ code: string }>).map((x) => x.code);
    assert.ok(codes.includes("size_small"));
    assert.ok(!codes.includes("late_delivery"), "برچسب دارد ولی مجاز نیست");
  });

  test("بدون نشست، علت‌ها بیرون نمی‌روند", async () => {
    const r = await app.inject({ method: "GET", url: "/return-reasons" });
    assert.equal(r.statusCode, 401, r.body);
  });

  // ── دریافتی روی خودِ فاکتور ──────────────────────────────────────

  test("GET فاکتور، دریافتی تا این لحظه را هم می‌دهد", async () => {
    // بدون این میدان، صندوقی که وسط فروش Reload شده هیچ راهی نداشت
    // بفهمد مشتری قبلاً بخشی از پول را داده — سبد را با «دریافتی
    // صفر» بازمی‌ساخت و همان مبلغ دوباره گرفته می‌شد.
    const { s, invoiceId } = await newCart("2");

    const before = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().receivedAmount, "0");
    assert.equal(typeof before.json().receivedAmount, "string", "پول در JSON رشته است");

    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "700000" },
    });

    const after = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    assert.equal(after.json().receivedAmount, "700000");
    // `paidAmount` روی پیش‌نویس عمداً صفر می‌ماند — آن ستون را
    // finalize_invoice می‌نویسد. دو عدد، دو معنا.
    assert.equal(after.json().paidAmount, "0", "paidAmount روی پیش‌نویس دست‌نخورده");
  });

  test("دریافتی فاکتور، جمع چند پرداخت است", async () => {
    const { s, invoiceId } = await newCart("2");
    for (const amount of ["300000", "400000"]) {
      await app.inject({
        method: "POST",
        url: `/invoices/${invoiceId}/payments`,
        ...s,
        payload: { methodCode: "cash", amount },
      });
    }
    const r = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    assert.equal(r.json().receivedAmount, "700000");
  });

  // ── پرداخت Idempotent ───────────────────────────────────────────

  test("Retry پرداخت همان paymentId را Replay می‌کند و پول دوباره ثبت نمی‌شود", async () => {
    const { s, invoiceId } = await newCart("1");
    const key = `pay-${suffix}-${invoiceId}`;
    const payload = { methodCode: "cash", amount: "1000001" };

    const a = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload,
    });

    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().replayed, false);
    assert.equal(b.json().replayed, true);
    assert.equal(a.json().paymentId, b.json().paymentId, "همان paymentId");
    assert.equal(b.json().receivedAmount, "1000001", "پول دوبار شمرده نشد");

    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM treasury.payment WHERE invoice_id = ${invoiceId}::uuid`
      .execute(handle.db);
    assert.equal(n.rows[0]!.n, "1", "فقط یک ردیف پرداخت");
  });

  test("پاسخ پرداخت، نمای فعلی سرور را حمل می‌کند", async () => {
    const { s, invoiceId } = await newCart("2");
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": `pay2-${suffix}-${invoiceId}` },
      payload: { methodCode: "cash", amount: "500000" },
    });
    assert.equal(r.statusCode, 201, r.body);
    const out = r.json() as {
      paymentId: string;
      replayed: boolean;
      receivedAmount: string;
      invoice: { payableAmount: string; paidAmount: string };
    };
    assert.ok(out.paymentId);
    assert.equal(out.invoice.payableAmount, "2000002");
    assert.equal(out.receivedAmount, "500000", "دریافتی تا این لحظه");
    assert.equal(out.invoice.paidAmount, "0", "paid_amount را finalize می‌نویسد، نه پرداخت");
    assert.equal(typeof out.receivedAmount, "string");
  });

  test("همان کلید پرداخت با مبلغ متفاوت، Conflict می‌دهد نه پرداخت دوم", async () => {
    const { s, invoiceId } = await newCart("1");
    const key = `pay3-${suffix}-${invoiceId}`;
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { methodCode: "cash", amount: "400000" },
    });
    const clash = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { methodCode: "cash", amount: "900000" },
    });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error.code, "idempotency_key_reused");

    const paid = await sql<{ t: string }>`
      SELECT coalesce(sum(amount),0)::text AS t FROM treasury.payment
       WHERE invoice_id = ${invoiceId}::uuid`.execute(handle.db);
    assert.equal(paid.rows[0]!.t, "400000", "مبلغ دوم ثبت نشد");
  });

  test("کلید یکسان روی فاکتور دیگر هم Conflict است، نه پرداخت جابه‌جا", async () => {
    const first = await newCart("1");
    const second = await newCart("1");
    const key = `pay4-${suffix}`;
    await app.inject({
      method: "POST",
      url: `/invoices/${first.invoiceId}/payments`,
      ...first.s,
      headers: { ...first.s.headers, "idempotency-key": key },
      payload: { methodCode: "cash", amount: "100000" },
    });
    const clash = await app.inject({
      method: "POST",
      url: `/invoices/${second.invoiceId}/payments`,
      ...second.s,
      headers: { ...second.s.headers, "idempotency-key": key },
      payload: { methodCode: "cash", amount: "100000" },
    });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error.code, "idempotency_key_reused");
  });

  test("دو پرداخت هم‌زمان با یک کلید، پول را دو بار ثبت نمی‌کنند", async () => {
    const { s, invoiceId } = await newCart("1");
    const key = `pay5-${suffix}-${invoiceId}`;
    const send = () =>
      app.inject({
        method: "POST",
        url: `/invoices/${invoiceId}/payments`,
        ...s,
        headers: { ...s.headers, "idempotency-key": key },
        payload: { methodCode: "cash", amount: "300000" },
      });

    const [a, b] = await Promise.all([send(), send()]);
    assert.ok(a.statusCode < 500 && b.statusCode < 500, "هیچ‌کدام خطای سرور نمی‌دهد");
    for (const r of [a, b]) {
      if (r.statusCode >= 300) {
        // `idempotency_key_reused` عمداً در این فهرست **نیست**: هر دو
        // درخواست Payload یکسان دارند، پس اگر سرور بگوید «کلید برای
        // درخواست دیگری استفاده شده»، یعنی نرمال‌سازی Payload خراب
        // است — یک باگ، نه یک نتیجه مشروعِ مسابقه.
        assert.ok(
          ["idempotency_in_flight", "duplicate_client_event"].includes(
            r.json().error.code as string,
          ),
          `کد غیرمنتظره: ${r.body}`,
        );
      }
    }

    const paid = await sql<{ t: string }>`
      SELECT coalesce(sum(amount),0)::text AS t FROM treasury.payment
       WHERE invoice_id = ${invoiceId}::uuid`.execute(handle.db);
    assert.equal(paid.rows[0]!.t, "300000", "پول دقیقاً یک بار ثبت شد");
  });

  test("پرداخت تکراری با کلید رویدادِ از پیش مصرف‌شده، ۴۰۹ می‌دهد نه ۵۰۰", async () => {
    // کلید یکسان روی دو منبع مختلف: Inbox جلویش را نمی‌گیرد، ولی قید
    // یکتایی treasury.payment می‌گیرد. باید ۴۰۹ باشد، نه خطای سرور.
    const { s, invoiceId } = await newCart("1");
    const key = `pay6-${suffix}`;
    const first = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { methodCode: "cash", amount: "200000" },
    });
    assert.equal(first.statusCode, 201, first.body);

    // ردّ Inbox را پاک می‌کنیم تا فقط قید دیتابیس بماند.
    await sql`DELETE FROM platform.inbox_message
               WHERE source = 'api.invoice.payment' AND event_id = ${key}`.execute(handle.db);

    const again = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { methodCode: "cash", amount: "200000" },
    });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error.code, "duplicate_client_event");
  });

  // ── اسکن با ادغام سمت سرور ──────────────────────────────────────

  test("اسکن دوباره همان بارکد، تعداد همان سطر را بالا می‌برد", async () => {
    const s = await loginAs(cashier);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    const invoiceId = inv.json().id as string;

    const a = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE },
    });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().invoice.lines.length, 1);
    assert.equal(a.json().invoice.lines[0].qty, "1.000");

    const b = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE },
    });
    assert.equal(b.statusCode, 200, b.body);
    const invB = b.json().invoice as {
      netAmount: string;
      lines: Array<{ id: string; qty: string; netAmount: string }>;
    };
    assert.equal(invB.lines.length, 1, "سطر دوم ساخته نشد");
    assert.equal(invB.lines[0]!.qty, "2.000");
    assert.equal(invB.lines[0]!.id, a.json().invoice.lines[0].id, "همان سطر");
    assert.equal(invB.netAmount, "2000002");
  });

  test("POST /lines هنوز ادغام نمی‌کند — رفتار قبلی نشکست", async () => {
    const { s, invoiceId } = await newCart("1");
    const again = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { barcode: BARCODE, qty: "1" },
    });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.json().lines.length, 2, "مسیر افزودن قلم باید سطر تازه بسازد");
  });

  test("اسکن با تعداد بیشتر از یک", async () => {
    const s = await loginAs(cashier);
    const invoiceId = (
      await app.inject({
        method: "POST",
        url: "/invoices",
        ...s,
        payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
      })
    ).json().id as string;
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE, qty: "3" },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().invoice.lines[0].qty, "3.000");
    assert.equal(r.json().invoice.netAmount, "3000003");
  });

  test("سطری که قیمتش با قیمت‌گذاری امروز یکی نیست، ادغام نمی‌شود", async () => {
    const s = await loginAs(cashier);
    const invoiceId = (
      await app.inject({
        method: "POST",
        url: "/invoices",
        ...s,
        payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
      })
    ).json().id as string;
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE },
    });

    // قیمت عوض می‌شود. قرارداد واقعی قیمت‌گذاری این است که
    // `currentPrice` ردیف معتبر در `occurred_at` را می‌خواند — پس
    // قیمت حل‌شده هم عوض می‌شود و دیگر با Snapshot سطر یکی نیست.
    await sql`UPDATE catalog.price SET amount = 2000000 WHERE variation_id = ${variationId}`
      .execute(handle.db);
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE },
    });
    await sql`UPDATE catalog.price SET amount = 1000001 WHERE variation_id = ${variationId}`
      .execute(handle.db);

    assert.equal(r.statusCode, 200, r.body);
    const lines = r.json().invoice.lines as Array<{ unitPrice: string }>;
    assert.equal(lines.length, 2, "بازقیمت‌گذاری بی‌صدا رخ نداد");
    assert.deepEqual(
      lines.map((l) => l.unitPrice).sort(),
      ["1000001", "2000000"],
      "هر سطر قیمت لحظه خودش را نگه داشت",
    );
  });

  test("سطر تخفیف‌دار سازگار نیست و ادغام نمی‌شود", async () => {
    const { s, invoiceId, body } = await newCart("1");
    await sql`UPDATE sales.invoice_line
                 SET discount_amount = 1000, net_amount = net_amount - 1000
               WHERE id = ${body.lines[0]!.id}`.execute(handle.db);
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().invoice.lines.length, 2);
  });

  test("Retry اسکن با همان کلید، عدد سوم نمی‌سازد", async () => {
    const s = await loginAs(cashier);
    const invoiceId = (
      await app.inject({
        method: "POST",
        url: "/invoices",
        ...s,
        payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
      })
    ).json().id as string;
    const key = `scan-${suffix}-${invoiceId}`;

    const a = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { barcode: BARCODE },
    });
    const b = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { barcode: BARCODE },
    });
    assert.equal(a.json().replayed, false);
    assert.equal(b.json().replayed, true);
    assert.equal(b.json().invoice.lines[0].qty, "1.000", "Retry تعداد را بالا نبرد");

    // ولی اسکن عمدی بعدی، با کلید تازه، شمرده می‌شود.
    const c = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      headers: { ...s.headers, "idempotency-key": `${key}-2` },
      payload: { barcode: BARCODE },
    });
    assert.equal(c.json().invoice.lines[0].qty, "2.000");
  });

  test("دو اسکن هم‌زمان با کلیدهای متفاوت، هر دو شمرده می‌شوند", async () => {
    const s = await loginAs(cashier);
    const invoiceId = (
      await app.inject({
        method: "POST",
        url: "/invoices",
        ...s,
        payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
      })
    ).json().id as string;

    const scan = (k: string) =>
      app.inject({
        method: "POST",
        url: `/invoices/${invoiceId}/scan`,
        ...s,
        headers: { ...s.headers, "idempotency-key": k },
        payload: { barcode: BARCODE },
      });
    const [a, b] = await Promise.all([scan(`c1-${invoiceId}`), scan(`c2-${invoiceId}`)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);

    const inv = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    const lines = inv.json().lines as Array<{ qty: string }>;
    const total = lines.reduce((t, l) => t + Number(l.qty), 0);
    assert.equal(total, 2, "هیچ اسکنی گم نشد");
    assert.equal(inv.json().netAmount, String(1000001 * 2));
  });

  test("بارکد ناشناخته ۴۰۴ می‌دهد و سبد دست‌نخورده می‌ماند", async () => {
    const { s, invoiceId } = await newCart("1");
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: "NOPE-000" },
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error.code, "variation_not_found");
    const inv = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    assert.equal(inv.json().lines.length, 1);
  });

  test("اسکن روی فاکتور نهایی‌شده رد می‌شود", async () => {
    const { s, invoiceId } = await newCart("1");
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      headers: { ...s.headers, "idempotency-key": `payf-${invoiceId}` },
      payload: { methodCode: "cash", amount: "1000001" },
    });
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
      headers: { ...s.headers, "idempotency-key": `finf-${invoiceId}` },
    });
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...s,
      payload: { barcode: BARCODE },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "invoice_not_draft");
  });

  test("کاربر شعبه دیگر نمی‌تواند در این سبد اسکن کند", async () => {
    const { invoiceId } = await newCart("1");
    const other = await loginAs(outsider);
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/scan`,
      ...other,
      payload: { barcode: BARCODE },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, "branch_forbidden");
  });

  // ── بستن شیفت ───────────────────────────────────────────────────

  test("بستن شیفت با Draft باز، ۴۰۹ فارسی می‌دهد", async () => {
    const c = await loginAs(cashier);
    await newCart("1"); // یک پیش‌نویس باز می‌گذاریم
    const mine = await app.inject({
      method: "GET",
      url: `/shifts/current?branchId=${BRANCH}`,
      ...c,
    });
    const shiftId = mine.json().id as string;

    const sup = await loginAs(supervisor);
    const r = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...sup,
      payload: { countedCash: "0" },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "rule_violation");
    assert.match(r.json().error.message as string, /نهایی‌نشده/);
  });

  test("صندوق‌دار مجوز بستن شیفت ندارد", async () => {
    const sup = await loginAs(supervisor);
    await app.inject({
      method: "POST",
      url: "/shifts",
      ...sup,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
    const own = await app.inject({
      method: "GET",
      url: `/shifts/current?branchId=${BRANCH}`,
      ...sup,
    });
    const shiftId = own.json().id as string;

    const c = await loginAs(cashier);
    const r = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...c,
      payload: { countedCash: "0" },
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  test("Retry بستن شیفت همان نتیجه را Replay می‌کند، نه ۴۰۹", async () => {
    const sup = await loginAs(supervisor);
    const shiftId = (
      await app.inject({ method: "GET", url: `/shifts/current?branchId=${BRANCH}`, ...sup })
    ).json().id as string;
    const key = `close-${suffix}-${shiftId}`;

    const a = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...sup,
      headers: { ...sup.headers, "idempotency-key": key },
      payload: { countedCash: "0" },
    });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().status, "closed");
    assert.equal(a.json().replayed, false);
    assert.equal(typeof a.json().countedCash, "string", "پول در JSON رشته است");
    assert.equal(a.json().variance, "0");

    const b = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...sup,
      headers: { ...sup.headers, "idempotency-key": key },
      payload: { countedCash: "0" },
    });
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(b.json().replayed, true);
    assert.equal(b.json().id, shiftId);

    // بدون کلید، رفتار قبلی سر جایش است: شیفت بسته دوباره بسته نمی‌شود.
    const c = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...sup,
      payload: { countedCash: "0" },
    });
    assert.equal(c.statusCode, 409, c.body);
    assert.equal(c.json().error.code, "shift_not_open");
  });

  test("همان کلید بستن با مبلغ شمارش متفاوت، Conflict می‌دهد", async () => {
    const sup = await loginAs(supervisor);
    await app.inject({
      method: "POST",
      url: "/shifts",
      ...sup,
      payload: { branchId: BRANCH, openingCash: "100000" },
    });
    const shiftId = (
      await app.inject({ method: "GET", url: `/shifts/current?branchId=${BRANCH}`, ...sup })
    ).json().id as string;
    const key = `close2-${suffix}-${shiftId}`;

    const a = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...sup,
      headers: { ...sup.headers, "idempotency-key": key },
      payload: { countedCash: "100000" },
    });
    assert.equal(a.statusCode, 200, a.body);

    const clash = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...sup,
      headers: { ...sup.headers, "idempotency-key": key },
      payload: { countedCash: "90000" },
    });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error.code, "idempotency_key_reused");
  });
});
