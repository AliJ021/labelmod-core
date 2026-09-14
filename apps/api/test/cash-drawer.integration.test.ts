/**
 * دروازه کشو — یک تعریف، و هر دو مسیری که از آن می‌گذرند.
 *
 * ── چرا این پرونده هست ──────────────────────────────────────────────
 *
 * هر ریال نقدی که از کشو خارج می‌شود باید به یک شیفت **باز** بچسبد،
 * وگرنه شمارش پایان شیفت مغایرت کاذب می‌دهد. دیتابیس نمی‌تواند اجبارش
 * کند — نمی‌داند کدام کاربر کدام کشو را باز دارد — پس دروازه در لایه
 * HTTP است و باید تست HTTP داشته باشد.
 *
 * این منطق **دو نسخه** داشت و یکی‌شان غلط بود:
 *
 *     treasury-routes.ts   shifts.openInBranch(branchId)   ✔ شعبه
 *     return-routes.ts     shifts.current(userId, branch)  ✘ کاربر
 *
 * و چون `refund.cash` را **صندوق‌دار ندارد** (Seed: فقط سرپرست و مدیر)،
 * نسخه دوم یعنی در یک روز عادی با یک کشو **هیچ‌کس** نمی‌توانست بازپرداخت
 * نقدی بزند — اندازه‌گیری شد، نه استنتاج:
 *
 *     صندوق‌دار (صاحب کشو)        → ۴۰۳ deny
 *     سرپرست (مجوزدار، بی‌کشو)    → ۴۲۲ no_open_shift
 *
 * و راه دور زدنش (سرپرست کشوی دومی باز کند) بدتر بود: بازپرداخت روی
 * کشوی **سرپرست** می‌نشست و دو مغایرت کاذب می‌ساخت، از جمله یک «کشوی
 * منفی» با انتظار نقد ‎−۱٬۰۰۰٬۰۰۰.
 *
 * حالا هر دو مسیر از `treasury/cash-drawer.ts` می‌گذرند.
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
const CASH_BOX = "00000000-0000-7000-8000-000000000201";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

describe("دروازه کشو: بازپرداخت نقدی و حرکت نقد غیرفروشی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `cd${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-دروازه-کشو-و-به‌قدر-کافی-بلند";
  const cashier = `cash_${suffix}`;
  const supervisor = `sup_${suffix}`;
  let variationId = "";

  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const c = (n: string) => r.cookies.find((x) => x.name === n)?.value ?? "";
    const out = {
      cookies: { labelmod_session: c("labelmod_session"), labelmod_csrf: c("labelmod_csrf") },
      headers: { "x-csrf-token": c("labelmod_csrf") },
    };
    sessions.set(username, out);
    return out;
  }
  async function call(
    method: "POST" | "GET" | "PATCH" | "PUT",
    url: string,
    who: string,
    payload?: object,
    idem?: string,
  ) {
    const s = await loginAs(who);
    return await app.inject({
      method,
      url,
      cookies: s.cookies,
      headers: { ...s.headers, ...(idem ? { "idempotency-key": idem } : {}) },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  /** فروش نقدی تازه؛ شناسه فاکتور و شناسه سطرش را برمی‌گرداند. */
  async function cashSale(qty: string) {
    const inv = await call("POST", "/invoices", cashier, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      channel: "pos",
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const id = (inv.json() as { id: string }).id;
    const l = await call("POST", `/invoices/${id}/lines`, cashier, { variationId, qty });
    assert.equal(l.statusCode, 201, l.body);
    const lineId = (l.json() as { lines: Array<{ id: string }> }).lines.at(-1)!.id;
    const view = await call("GET", `/invoices/${id}`, cashier);
    const payable = (view.json() as { payableAmount: string }).payableAmount;
    await call("POST", `/invoices/${id}/payments`, cashier, {
      methodCode: "cash",
      amount: payable,
    });
    const fin = await call("POST", `/invoices/${id}/finalize`, cashier, {}, `fin-${id}`);
    assert.equal(fin.statusCode, 200, fin.body);
    return { id, lineId, payable };
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 6);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [cashier, "صندوق‌دار دروازه", "cashier"],
      [supervisor, "سرپرست دروازه", "supervisor"],
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
        .values({ user_id: u.id, role_code: role, branch_id: BRANCH })
        .execute();
    }

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'کالای دروازه کشو') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${prod.rows[0]!.id}, 'سبز', 'M', ${`SKU-${suffix}`}) RETURNING id`.execute(handle.db);
    variationId = v.rows[0]!.id;
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 1000000)`.execute(handle.db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 60, 'purchase_receipt',
                'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${SYSTEM_USER}::uuid, 600000)`.execute(handle.db);

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("بی هیچ کشوی باز، بازپرداخت نقدی ۴۲۲ می‌گیرد", async () => {
    // کشویی باز نیست — ولی فروش نقدی هم بی‌کشو ممکن نیست، پس یک شیفت
    // باز می‌کنیم، می‌فروشیم، می‌بندیم، و بعد مرجوعی می‌زنیم.
    const sh = await call("POST", "/shifts", cashier, {
      branchId: BRANCH,
      openingCash: "10000000",
    });
    const shiftId = (sh.json() as { id: string }).id;
    const sale = await cashSale("2");

    const counted = 10000000n + BigInt(sale.payable);
    const closed = await call("POST", `/shifts/${shiftId}/close`, supervisor, {
      countedCash: counted.toString(),
    });
    assert.equal(closed.statusCode, 200, closed.body);

    const r = await call("POST", "/returns", supervisor, {
      invoiceId: sale.id,
      reasonCode: "size_small",
      refundAmount: "1000000",
      refundMethod: "cash",
      lines: [{ invoiceLineId: sale.lineId, qty: "1" }],
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal((r.json() as { error: { code: string } }).error.code, "no_open_shift");
  });

  test("یک کشوی باز: سرپرست بازپرداخت می‌زند و پول از همان کشو کم می‌شود", async () => {
    const sh = await call("POST", "/shifts", cashier, {
      branchId: BRANCH,
      openingCash: "10000000",
    });
    assert.equal(sh.statusCode, 201, sh.body);
    const shiftId = (sh.json() as { id: string }).id;

    const sale = await cashSale("2");

    // صاحب کشو مجوز ندارد — این عمدی است (`refund.cash` در Seed)
    const byCashier = await call("POST", "/returns", cashier, {
      invoiceId: sale.id,
      reasonCode: "size_small",
      refundAmount: "1000000",
      refundMethod: "cash",
      lines: [{ invoiceLineId: sale.lineId, qty: "1" }],
    });
    assert.equal(byCashier.statusCode, 403, `صندوق‌دار نباید بازپرداخت بزند: ${byCashier.body}`);

    // مجوزدارِ بی‌کشو **باید بتواند** — پول از کشوی شعبه بیرون می‌آید
    const draft = await call("POST", "/returns", supervisor, {
      invoiceId: sale.id,
      reasonCode: "size_small",
      refundAmount: "1000000",
      refundMethod: "cash",
      lines: [{ invoiceLineId: sale.lineId, qty: "1" }],
    });
    assert.equal(draft.statusCode, 201, `سرپرست باید بتواند بازپرداخت بزند: ${draft.body}`);
    const rid = (draft.json() as { id: string }).id;
    const posted = await call("POST", `/returns/${rid}/post`, supervisor, {}, `ret-${rid}`);
    assert.equal(posted.statusCode, 200, posted.body);

    // و روی کشوی **صندوق‌دار** نشست، نه کشوی سرپرست (که وجود ندارد)
    const pay = await sql<{ s: string | null }>`
      SELECT shift_id::text AS s FROM treasury.payment WHERE return_id = ${rid}::uuid`
      .execute(handle.db);
    assert.equal(pay.rows[0]!.s, shiftId, "بازپرداخت باید به کشوی باز شعبه بچسبد");

    // ── و شمارش فیزیکی باید مغایرت صفر بدهد ─────────────────────────
    // این نقطهٔ اصلی است: با نسخهٔ قبلی، انتظار کشو ۱٬۰۰۰٬۰۰۰ بیشتر از
    // پول واقعی می‌شد و صندوق‌دار یک کسری غیرقابل توضیح می‌گرفت.
    const real = 10000000n + BigInt(sale.payable) - 1000000n;
    const closed = await call("POST", `/shifts/${shiftId}/close`, supervisor, {
      countedCash: real.toString(),
    });
    assert.equal(closed.statusCode, 200, closed.body);
    const cb = closed.json() as { expectedCash: string; variance: string };
    assert.equal(cb.expectedCash, real.toString(), "انتظار کشو باید با پول واقعی بخواند");
    assert.equal(cb.variance, "0", "شمارش درست یعنی مغایرت صفر");
  });

  test("دو کشوی باز: دروازه حدس نمی‌زند، ۴۲۲ می‌دهد", async () => {
    const a = await call("POST", "/shifts", cashier, { branchId: BRANCH, openingCash: "5000000" });
    assert.equal(a.statusCode, 201, a.body);
    const sale = await cashSale("2");

    const b = await call("POST", "/shifts", supervisor, { branchId: BRANCH, openingCash: "0" });
    assert.equal(b.statusCode, 201, `دو کاربر می‌توانند دو کشو داشته باشند: ${b.body}`);

    const r = await call("POST", "/returns", supervisor, {
      invoiceId: sale.id,
      reasonCode: "size_small",
      refundAmount: "1000000",
      refundMethod: "cash",
      lines: [{ invoiceLineId: sale.lineId, qty: "1" }],
    });
    assert.equal(r.statusCode, 422, `با دو کشوی باز باید ۴۲۲ بدهد: ${r.body}`);
    assert.equal((r.json() as { error: { code: string } }).error.code, "ambiguous_shift");

    // حرکت نقد غیرفروشی هم همان پاسخ را می‌گیرد — **یک** دروازه
    const t = await call("POST", "/treasury/transactions", supervisor, {
      branchId: BRANCH,
      purpose: "expense",
      amount: "1000000",
      fromAccountId: CASH_BOX,
      expenseAccountCode: "6102",
      note: "کرایه پیک",
    });
    assert.equal(t.statusCode, 422, `مسیر خزانه هم باید ۴۲۲ بدهد: ${t.body}`);
    assert.equal((t.json() as { error: { code: string } }).error.code, "ambiguous_shift");

    // پاک‌سازی: هر دو کشو بسته می‌شوند تا تست بعدی به ترتیب اجرا
    // وابسته نباشد (بند ۷۲ الحاقیه).
    for (const id of [(a.json() as { id: string }).id, (b.json() as { id: string }).id]) {
      const c = await call("POST", `/shifts/${id}/close`, supervisor, { countedCash: "0" });
      assert.equal(c.statusCode, 200, c.body);
    }
  });

  test("بازپرداخت غیرنقدی کشو نمی‌خواهد", async () => {
    // واریز بانکی از کشو رد نمی‌شود، پس نبودِ کشوی باز مانعش نیست.
    const sh = await call("POST", "/shifts", cashier, {
      branchId: BRANCH,
      openingCash: "10000000",
    });
    const shiftId = (sh.json() as { id: string }).id;
    const sale = await cashSale("2");
    const counted = 10000000n + BigInt(sale.payable);
    await call("POST", `/shifts/${shiftId}/close`, supervisor, {
      countedCash: counted.toString(),
    });

    const draft = await call("POST", "/returns", supervisor, {
      invoiceId: sale.id,
      reasonCode: "size_small",
      refundAmount: "1000000",
      refundMethod: "transfer",
      lines: [{ invoiceLineId: sale.lineId, qty: "1" }],
    });
    assert.equal(draft.statusCode, 201, `بازپرداخت غیرنقدی نباید کشو بخواهد: ${draft.body}`);
    const rid = (draft.json() as { id: string }).id;
    const pay = await sql<{ s: string | null }>`
      SELECT shift_id::text AS s FROM treasury.payment WHERE return_id = ${rid}::uuid`
      .execute(handle.db);
    assert.ok(
      pay.rows.length === 0 || pay.rows[0]!.s === null,
      "بازپرداخت غیرنقدی نباید shift_id بگیرد",
    );
  });
});
