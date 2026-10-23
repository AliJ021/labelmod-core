import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * سفارش اینستاگرام از راه HTTP — قرارداد docs/INSTAGRAM-ORDERS.md.
 *
 * لایهٔ دیتابیس جدا در db/test/instagram-order.sql سنجیده شده؛ اینجا همان چیزی سنجیده می‌شود که
 * فقط در مسیر واقعی دیده می‌شود: مجوز و دامنهٔ شعبه، Idempotency-Key، نشست انسانی، رقابت واقعی
 * چند نشست (دو اپراتور؛ آخرین واحد میان اینستاگرام، صندوق و سایت؛ انقضا در برابر تأیید)، و اینکه
 * فروش اینستاگرام در گزارش کانال خودش می‌آید و دوبار شمرده نمی‌شود.
 *
 * ⚠️ هر ادعای «رد شد» کنار یک ادعای «پذیرفته شد» از همان مسیر است (کنترل منفی)، تا ردِ ناشی از
 *    خطای دیگری (داده، مجوز) جای نگهبان را سبز نکند.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { hashApiKey, newApiKey } from "../src/auth/api-key.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

describe("سفارش اینستاگرام: رزرو، تأیید واریز و ثبت روز از مسیر HTTP", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  /** اتصال مالک — فقط برای جلو بردن ساعتِ مهلت رزرو در آزمون؛ نقش برنامه حق این تغییر را ندارد (نگهبان وضعیت). */
  let owner: DbHandle;
  let app: FastifyInstance;

  const suffix = `ig${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-سفارش-اینستاگرام-به‌قدر-کافی-بلند";
  const opA = `iga_${suffix}`;
  const opB = `igb_${suffix}`;
  const cashier = `igc_${suffix}`;
  const farAdmin = `igf_${suffix}`;
  const siteKey = newApiKey();
  let otherBranch = "";
  let otherBank = "";
  let p2p = "";
  let bank1 = "";
  let many = "";      // ۱۰ عدد
  let last = "";      // یک عدد
  let lastSku = "";
  let spare = "";     // ۱۰ عدد، برای انقضا و لغو

  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, {
      method: "POST", url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const c = (n: string) => r.cookies.find((x) => x.name === n)?.value ?? "";
    const out = { cookies: { labelmod_session: c("labelmod_session"), labelmod_csrf: c("labelmod_csrf") },
      headers: { "x-csrf-token": c("labelmod_csrf") } };
    sessions.set(username, out);
    return out;
  }
  async function call(method: "POST" | "GET" | "PATCH" | "DELETE", url: string, who: string, payload?: object, idem?: string) {
    const s = await loginAs(who);
    return app.inject({ method, url, cookies: s.cookies,
      headers: { ...s.headers, ...(idem ? { "idempotency-key": idem } : {}) },
      ...(payload === undefined ? {} : { payload }) });
  }
  const balance = async (variationId: string) => (await sql<{ on_hand: string; reserved: string }>`
    SELECT trim_scale(on_hand)::text AS on_hand, trim_scale(reserved)::text AS reserved FROM inventory.stock_balance
     WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`.execute(handle.db)).rows[0]!;
  const count = async (q: string) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.raw(q)}`.execute(handle.db)).rows[0]!.n);

  async function newOrder(who: string, lines: Array<{ variationId: string; qty: number }>, extra: Record<string, unknown> = {}) {
    const r = await call("POST", "/instagram-orders", who, {
      branchId: BRANCH, warehouseId: STORE_WH, customerMobile: "09121112233", customerName: "مشتری دایرکت",
      shippingAmount: "50000", shipAddress: "تهران، خیابان آزمون", shipMethod: "پست پیشتاز",
      receivingAccountId: p2p, ...extra,
    }, `create-${Math.random()}`);
    assert.equal(r.statusCode, 201, r.body);
    const id = r.json().id as string;
    for (const l of lines) {
      const a = await call("POST", `/instagram-orders/${id}/lines`, who, l);
      assert.equal(a.statusCode, 201, a.body);
    }
    return id;
  }
  const detail = async (id: string, who = opA) => {
    const r = await call("GET", `/instagram-orders/${id}`, who);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const confirmBody = (d: { version: number; invoice: { payable: string } }, ref: string, account = p2p, paidAt = new Date()) => ({
    version: d.version, accountId: account, amount: d.invoice.payable, refNo: ref, paidAt: paidAt.toISOString(),
  });

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 10);
    owner = createDb(disposable.ownerUrl, 2);
    const db = handle.db;

    const br = await sql<{ id: string }>`INSERT INTO platform.branch (code, name) VALUES (${`B-${suffix}`}, 'شعبهٔ دیگر') RETURNING id`.execute(db);
    otherBranch = br.rows[0]!.id;
    p2p = (await sql<{ id: string }>`SELECT id FROM treasury.account WHERE code = 'P2P-1'`.execute(db)).rows[0]!.id;
    bank1 = (await sql<{ id: string }>`SELECT id FROM treasury.account WHERE code = 'BANK-1'`.execute(db)).rows[0]!.id;
    otherBank = (await sql<{ id: string }>`INSERT INTO treasury.account (code, name, kind, branch_id, ledger_account_code)
      VALUES (${`OB-${suffix}`}, 'بانک شعبهٔ دیگر', 'bank', ${otherBranch}::uuid, '1105') RETURNING id`.execute(db)).rows[0]!.id;

    const hash = await hashSecret(PASSWORD);
    for (const [username, role, branch] of [
      [opA, "admin", BRANCH], [opB, "admin", BRANCH], [cashier, "cashier", BRANCH], [farAdmin, "admin", otherBranch],
    ] as const) {
      const u = await db.insertInto("identity.app_user").values({
        username, full_name: username, password_hash: hash, is_active: true, mobile: null, pin_hash: null, totp_secret: null,
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("identity.user_role").values({ user_id: u.id, role_code: role, branch_id: branch }).execute();
    }
    const site = await db.insertInto("identity.app_user").values({
      username: `api:site:${suffix}`, full_name: "سایت", password_hash: null, pin_hash: null, mobile: null, totp_secret: null, is_active: false,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("identity.user_role").values({ user_id: site.id, role_code: "web", branch_id: BRANCH }).execute();
    await db.insertInto("identity.api_client").values({
      name: "سایت", user_id: site.id, key_hash: hashApiKey(siteKey), created_by: SYSTEM_USER, note: null, last_used_at: null,
    }).execute();

    const prod = await sql<{ id: string }>`INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'مانتو اینستاگرامی') RETURNING id`.execute(db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(db);
    for (const [tag, qty, price] of [["many", 10, 500000], ["last", 1, 1000000], ["spare", 10, 300000]] as const) {
      const code = `SKU-${suffix}-${tag}`;
      const v = await sql<{ id: string }>`INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (${prod.rows[0]!.id}::uuid, 'مشکی', ${tag}, ${code}) RETURNING id`.execute(db);
      const id = v.rows[0]!.id;
      await sql`INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (${id}::uuid, 'default', ${price})`.execute(db);
      await sql`SELECT inventory.apply_movement(${id}::uuid, ${STORE_WH}::uuid, ${qty}, 'opening', NULL, NULL, ${SYSTEM_USER}::uuid, 100000)`.execute(db);
      if (tag === "many") many = id; else if (tag === "last") { last = id; lastSku = code; } else spare = id;
    }

    app = await buildApp({
      db, auth: new AuthService(db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", WEB_PUSH_SECRET: undefined }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  test("مجوز و دامنه: صندوق‌دار نمی‌سازد، مدیر شعبهٔ دیگر نمی‌بیند؛ جست‌وجو در بدنه است نه نشانی", async () => {
    const denied = await call("POST", "/instagram-orders", cashier, {
      branchId: BRANCH, warehouseId: STORE_WH, customerMobile: "09121112233" }, "c-1");
    assert.equal(denied.statusCode, 403, denied.body);
    const id = await newOrder(opA, []);
    const far = await call("GET", `/instagram-orders/${id}`, farAdmin);
    assert.equal(far.statusCode, 403, far.body);
    assert.equal((await call("GET", `/instagram-orders/${id}`, opB)).statusCode, 200, "کنترل منفی: هم‌شعبه می‌بیند");
    const leak = await call("GET", "/instagram-orders?q=09121112233", opA);
    assert.equal(leak.statusCode, 400, "موبایل در نشانی پذیرفته نمی‌شود (لاگ دسترسی)");
    const found = await call("POST", "/instagram-orders/search", opA, { q: "0912 111 2233" });
    assert.equal(found.statusCode, 200, found.body);
    assert.ok((found.json().orders as Array<{ id: string }>).some((o) => o.id === id));
    const badAcct = await call("PATCH", `/instagram-orders/${id}`, opA, { receivingAccountId: otherBank });
    assert.equal(badAcct.statusCode, 422, "حساب بانکی شعبهٔ دیگر مجاز نیست");
    const okAcct = await call("PATCH", `/instagram-orders/${id}`, opA, { receivingAccountId: bank1, instagramUsername: "@Shop.Buyer" });
    assert.equal(okAcct.statusCode, 200, okAcct.body);
    assert.equal(okAcct.json().customer.instagramUsername, "shop.buyer");
  });

  test("پیش‌نویس هیچ اثری ندارد؛ مسیر عمومی /invoices پرداخت یا نهایی‌سازی را دور نمی‌زند؛ تعداد صحیح است", async () => {
    const before = await balance(many);
    const payments = await count("treasury.payment");
    const id = await newOrder(opA, [{ variationId: many, qty: 2 }]);
    const d = await detail(id);
    assert.equal(d.status, "draft");
    assert.equal(d.invoice.payable, "1050000", "دو قلم ۵۰۰٬۰۰۰ به‌علاوهٔ کرایه ۵۰٬۰۰۰");
    assert.deepEqual(await balance(many), before, "پیش‌نویس رزرو یا خروج نساخت");
    const pay = await call("POST", `/invoices/${d.invoice.id}/payments`, opA, { methodCode: "cash", amount: "1050000" }, `gp-${id}`);
    assert.ok(pay.statusCode >= 400, `دریافت از مسیر عمومی پذیرفته شد: ${pay.body}`);
    const fin = await call("POST", `/invoices/${d.invoice.id}/finalize`, opA, {}, `gf-${id}`);
    assert.ok(fin.statusCode >= 400, `نهایی‌سازی از مسیر عمومی پذیرفته شد: ${fin.body}`);
    const line = await call("POST", `/invoices/${d.invoice.id}/lines`, opA, { variationId: many, qty: "1" });
    assert.ok(line.statusCode >= 400, `افزودن قلم از مسیر عمومی پذیرفته شد: ${line.body}`);
    assert.equal(await count("treasury.payment"), payments, "هیچ دریافتی ثبت نشد");
    const frac = await call("POST", `/instagram-orders/${id}/lines`, opA, { variationId: many, qty: 1.5 });
    assert.equal(frac.statusCode, 400, frac.body);
    // هشدار سفارش باز مشابه، بی منع.
    const second = await newOrder(opA, []);
    assert.ok((await detail(second)).similarOpen.some((o: { id: string }) => o.id === id), "سفارش باز همان مشتری هشدار شد");
  });

  test("ویرایش‌ها کلید Idempotency می‌پذیرند؛ هشدار مشابه فقط در همان شعبه؛ بستن دستی دورهٔ کانال اینستاگرام", async () => {
    const id = await newOrder(opA, []);
    const qtyOf = async () => ((await detail(id)).lines as Array<{ variationId: string; qty: number }>)
      .filter((l) => l.variationId === many).reduce((a, l) => a + Number(l.qty), 0);
    // پاسخ گم‌شدهٔ «افزودن قلم» و تلاش دوباره با همان کلید: Replay، نه دو برابر شدن.
    const k = `line-${id}`;
    const a1 = await call("POST", `/instagram-orders/${id}/lines`, opA, { variationId: many, qty: 1 }, k);
    assert.equal(a1.statusCode, 201, a1.body);
    const a2 = await call("POST", `/instagram-orders/${id}/lines`, opA, { variationId: many, qty: 1 }, k);
    assert.equal(a2.statusCode, 200, a2.body);
    assert.equal(a2.json().replayed, true);
    assert.equal(await qtyOf(), 1, "همان کلید قلم دوم نساخت");
    // کنترل منفی: همان درخواست با کلید تازه واقعاً اضافه می‌کند (پس Replay بالا کار کلید بود).
    const a3 = await call("POST", `/instagram-orders/${id}/lines`, opA, { variationId: many, qty: 1 }, `${k}-b`);
    assert.equal(a3.statusCode, 201, a3.body);
    assert.equal(await qtyOf(), 2);
    // همان کلید با بدنهٔ دیگر خطاست، نه Replay بی‌صدای عمل دیگر.
    const clash = await call("POST", `/instagram-orders/${id}/lines`, opA, { variationId: many, qty: 3 }, k);
    assert.ok(clash.statusCode >= 400 && clash.statusCode < 500, clash.body);
    assert.equal(await qtyOf(), 2);

    // هشدار سفارش باز مشابه از شعبهٔ دیگر چیزی نشان نمی‌دهد.
    const other = await newOrder(opA, []);
    const seen = async () => ((await detail(id)).similarOpen as Array<{ id: string }>).some((o) => o.id === other);
    assert.equal(await seen(), true, "کنترل مثبت: همان شعبه و همان مشتری دیده می‌شود");
    await sql`UPDATE sales.instagram_order SET branch_id = ${otherBranch}::uuid WHERE id = ${other}::uuid`.execute(owner.db);
    assert.equal(await seen(), false, "سفارش شعبهٔ دیگر در هشدار این شعبه نیست");

    // بستن دستی دورهٔ کانال اینستاگرام از همان مسیر کانال‌های دیگر: کانال معتبر است (۴۰۴ «دوره نیست»، نه ۴۰۰).
    const close = await call("POST", "/posting-batches/close-channel-day", opA,
      { branchId: BRANCH, channel: "instagram", date: "2020-01-01" });
    assert.equal(close.statusCode, 404, close.body);
    const bad = await call("POST", "/posting-batches/close-channel-day", opA,
      { branchId: BRANCH, channel: "telegram", date: "2020-01-01" });
    assert.equal(bad.statusCode, 400, bad.body);
  });

  test("دو اپراتور هم‌زمان: یک رزرو، نه دو؛ سبد تغییرکرده تأیید کهنه را باطل می‌کند؛ مبلغ و حساب سنجیده می‌شوند", async () => {
    const id = await newOrder(opA, [{ variationId: many, qty: 2 }]);
    const before = await balance(many);
    const both = await Promise.all([call("POST", `/instagram-orders/${id}/reserve`, opA), call("POST", `/instagram-orders/${id}/reserve`, opB)]);
    assert.deepEqual(both.map((r) => r.statusCode), [200, 200], both.map((r) => r.body).join("\n"));
    assert.deepEqual(both.map((r) => r.json().replayed).sort(), [false, true]);
    assert.equal(Number((await balance(many)).reserved), Number(before.reserved) + 2, "دو اپراتور یک رزرو ساختند");

    const seen = await detail(id, opB);
    // اپراتور A سبد را عوض می‌کند: برگشت به پیش‌نویس، تعداد ۳، رزرو دوباره.
    assert.equal((await call("POST", `/instagram-orders/${id}/unreserve`, opA)).statusCode, 200);
    const lineId = seen.lines[0].id as string;
    assert.equal((await call("PATCH", `/instagram-orders/${id}/lines/${lineId}`, opA, { qty: 3 })).statusCode, 200);
    assert.equal((await call("POST", `/instagram-orders/${id}/reserve`, opA)).statusCode, 200);
    const payments = await count("treasury.payment");
    const stale = await call("POST", `/instagram-orders/${id}/confirm`, opB, confirmBody(seen, `STALE-${suffix}`), `stale-${id}`);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "stale_version");
    const fresh = await detail(id, opB);
    const short = await call("POST", `/instagram-orders/${id}/confirm`, opB,
      { ...confirmBody(fresh, `SHORT-${suffix}`), amount: String(BigInt(fresh.invoice.payable) - 1n) }, `short-${id}`);
    assert.equal(short.statusCode, 422, short.body);
    assert.equal(short.json().error.code, "amount_mismatch");
    const wrongAcct = await call("POST", `/instagram-orders/${id}/confirm`, opB, confirmBody(fresh, `ACCT-${suffix}`, otherBank), `acct-${id}`);
    assert.equal(wrongAcct.statusCode, 422, wrongAcct.body);
    const noKey = await call("POST", `/instagram-orders/${id}/confirm`, opB, confirmBody(fresh, `NOKEY-${suffix}`));
    assert.equal(noKey.statusCode, 400, "تأیید واریز بی Idempotency-Key پذیرفته نمی‌شود");
    assert.equal(await count("treasury.payment"), payments, "هیچ‌کدام از ردها دریافتی نساخت");
  });

  test("تأیید واریز: یک دریافت، یک کسر، یک فاکتور؛ تکرار با همان کلید و با کلید تازه هر دو Replay", async () => {
    const id = await newOrder(opA, [{ variationId: many, qty: 1 }]);
    assert.equal((await call("POST", `/instagram-orders/${id}/reserve`, opA)).statusCode, 200);
    const d = await detail(id);
    const before = await balance(many);
    const body = confirmBody(d, `REF-OK-${suffix}`);
    // دو درخواست هم‌زمان با یک کلید (پاسخ اول «گم شده» و کلاینت دوباره فرستاده).
    const twins = await Promise.all([
      call("POST", `/instagram-orders/${id}/confirm`, opA, body, `ok-${id}`),
      call("POST", `/instagram-orders/${id}/confirm`, opA, body, `ok-${id}`),
    ]);
    assert.ok(twins.every((r) => r.statusCode === 200 || r.statusCode === 409), twins.map((r) => r.body).join("\n"));
    assert.ok(twins.some((r) => r.statusCode === 200 && r.json().replayed === false), "یکی واقعاً تأیید کرد");
    const retry = await call("POST", `/instagram-orders/${id}/confirm`, opA, body, `ok-${id}`);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().replayed, true, "پاسخ گم‌شده با همان کلید حل شد");
    const again = await call("POST", `/instagram-orders/${id}/confirm`, opB, body, `ok2-${id}`);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().status, "finalized");
    const other = await call("POST", `/instagram-orders/${id}/confirm`, opB, { ...body, refNo: `OTHER-${suffix}` }, `ok3-${id}`);
    assert.equal(other.statusCode, 409, other.body);
    assert.equal(other.json().error.code, "already_confirmed");

    const after = await balance(many);
    assert.equal(Number(after.on_hand), Number(before.on_hand) - 1, "موجودی یک بار کم شد");
    assert.equal(Number(after.reserved), Number(before.reserved) - 1, "رزرو همان سفارش مصرف شد، نه دوباره کم");
    const row = (await sql<{ n: string; channel: string; status: string; batch: string; account: string }>`
      SELECT (SELECT count(*) FROM treasury.payment p WHERE p.invoice_id = i.id)::text AS n, i.channel, i.status,
             pb.kind || '/' || pb.channel AS batch, (SELECT account_id::text FROM treasury.payment p WHERE p.invoice_id = i.id) AS account
        FROM sales.invoice i JOIN ledger.posting_batch pb ON pb.id = i.posting_batch_id
       WHERE i.id = ${d.invoice.id}::uuid`.execute(handle.db)).rows[0]!;
    assert.deepEqual(row, { n: "1", channel: "instagram", status: row.status, batch: "channel_day/instagram", account: p2p });
    assert.ok(["finalized", "paid"].includes(row.status), row.status);
    const fd = await detail(id);
    assert.equal(fd.payment.refNo, `REF-OK-${suffix}`);
    assert.equal(fd.payment.amount, d.invoice.payable);

    // ارسال: رو به جلو، بی حرکت انبار.
    const moves = await count("inventory.stock_movement");
    assert.equal((await call("POST", `/instagram-orders/${id}/shipping`, opA, { state: "packing" })).statusCode, 200);
    assert.equal((await call("POST", `/instagram-orders/${id}/shipping`, opA, { state: "shipped" })).statusCode, 409, "بی کد رهگیری");
    assert.equal((await call("POST", `/instagram-orders/${id}/shipping`, opA, { state: "shipped", trackingCode: "PP123" })).statusCode, 200);
    assert.equal(await count("inventory.stock_movement"), moves, "ارسال حرکت انبار نساخت");
    const cancel = await call("POST", `/instagram-orders/${id}/cancel`, opA, { reason: "پشیمانی" });
    assert.equal(cancel.statusCode, 409, "پس از نهایی‌سازی فقط مرجوعی رسمی");
  });

  test("تأیید واریز تصمیم انسانیِ کامل است: نشست PIN و کلید سایت رد؛ همان اپراتور با ورود کامل پذیرفته", async () => {
    const id = await newOrder(opA, [{ variationId: spare, qty: 1 }]);
    assert.equal((await call("POST", `/instagram-orders/${id}/reserve`, opA)).statusCode, 200);
    const d = await detail(id);
    const uid = (await sql<{ id: string }>`SELECT id FROM identity.app_user WHERE username = ${opB}`.execute(handle.db)).rows[0]!.id;
    await sql`UPDATE identity.session SET pin_unlocked = true WHERE user_id = ${uid}::uuid`.execute(handle.db);
    try {
      const pin = await call("POST", `/instagram-orders/${id}/confirm`, opB, confirmBody(d, `PIN-${suffix}`), `pin-${id}`);
      assert.equal(pin.statusCode, 403, pin.body);
    } finally {
      await sql`UPDATE identity.session SET pin_unlocked = false WHERE user_id = ${uid}::uuid`.execute(handle.db);
    }
    const site = await app.inject({ method: "POST", url: `/instagram-orders/${id}/confirm`,
      headers: { authorization: `Bearer ${siteKey}`, "idempotency-key": `site-${id}` }, payload: confirmBody(d, `SITE-${suffix}`) });
    assert.equal(site.statusCode, 403, site.body);
    assert.equal((await detail(id)).status, "reserved", "هیچ‌کدام چیزی ثبت نکرد");
    const ok = await call("POST", `/instagram-orders/${id}/confirm`, opB, confirmBody(d, `PIN-${suffix}`), `pin-ok-${id}`);
    assert.equal(ok.statusCode, 200, `کنترل منفی: همان اپراتور با نشست کامل: ${ok.body}`);
  });

  test("مرجع بانکی: همان حساب و همان روز تکراری است؛ حساب دیگر نه", async () => {
    const a = await newOrder(opA, [{ variationId: spare, qty: 1 }]);
    const b = await newOrder(opA, [{ variationId: spare, qty: 1 }]);
    for (const id of [a, b]) assert.equal((await call("POST", `/instagram-orders/${id}/reserve`, opA)).statusCode, 200);
    const ref = `DUP-${suffix}`;
    const first = await call("POST", `/instagram-orders/${a}/confirm`, opA, confirmBody(await detail(a), ref), `dup-a-${suffix}`);
    assert.equal(first.statusCode, 200, first.body);
    const dup = await call("POST", `/instagram-orders/${b}/confirm`, opA, confirmBody(await detail(b), ` ${ref.toLowerCase()} `), `dup-b-${suffix}`);
    assert.equal(dup.statusCode, 409, dup.body);
    assert.equal(dup.json().error.code, "duplicate_bank_ref");
    const otherAccount = await call("POST", `/instagram-orders/${b}/confirm`, opA, confirmBody(await detail(b), ref, bank1), `dup-c-${suffix}`);
    assert.equal(otherAccount.statusCode, 200, `کنترل منفی: همان مرجع در حساب دیگر پذیرفته می‌شود: ${otherAccount.body}`);
  });

  test("آخرین واحد میان اینستاگرام، صندوق و سایت: فقط یکی می‌برد و موجودی منفی نمی‌شود", async () => {
    const ig = await newOrder(opA, [{ variationId: last, qty: 1 }]);
    // پیش‌نویس صندوق با دریافت کامل، آمادهٔ نهایی‌سازی در یک نشست جدا.
    const pos = (await sql<{ id: string }>`
      WITH sh AS (INSERT INTO sales.cash_shift (branch_id, user_id, opening_cash, opened_at)
                  VALUES (${BRANCH}::uuid, ${SYSTEM_USER}::uuid, 0, now()) RETURNING id),
           inv AS (INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, created_by)
                   SELECT ${BRANCH}::uuid, ${STORE_WH}::uuid, sh.id, ${SYSTEM_USER}::uuid FROM sh RETURNING id, shift_id)
      SELECT id FROM inv`.execute(handle.db)).rows[0]!.id;
    await sql`INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty, unit_price, net_amount)
              VALUES (${pos}::uuid, 1, ${last}::uuid, 1, 1000000, 1000000)`.execute(handle.db);
    await sql`SELECT sales.refresh_invoice_totals(${pos}::uuid)`.execute(handle.db);
    await sql`INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount)
              SELECT id, shift_id, 'cash', 1000000 FROM sales.invoice WHERE id = ${pos}::uuid`.execute(handle.db);

    const results = await Promise.allSettled([
      call("POST", `/instagram-orders/${ig}/reserve`, opA).then((r) => r.statusCode),
      sql`SELECT sales.finalize_invoice(${pos}::uuid, ${SYSTEM_USER}::uuid)`.execute(handle.db).then(() => 200),
      app.inject({ method: "POST", url: "/web/orders", headers: { authorization: `Bearer ${siteKey}` }, payload: {
        branchId: BRANCH, warehouseId: STORE_WH, externalId: `ig-race-${suffix}`,
        lines: [{ sku: lastSku, qty: "1", unitPrice: "1000000" }], paymentMethod: "gateway",
        paymentRef: `race-${suffix}`, paidAmount: "1000000" } }).then((r) => r.statusCode),
    ]);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value : 409));
    const winners = codes.filter((c) => c === 200 || c === 201).length;
    assert.equal(winners, 1, `بیش یا کم از یک برنده: ${JSON.stringify(codes)}`);
    const b = await balance(last);
    assert.ok(Number(b.on_hand) >= 0 && Number(b.reserved) <= Number(b.on_hand), JSON.stringify(b));
    assert.equal(Number(b.on_hand) - Number(b.reserved), 0, "آخرین واحد دقیقاً یک بار رفت");
    if ((await detail(ig)).status === "reserved") {
      assert.equal((await call("POST", `/instagram-orders/${ig}/cancel`, opA, { reason: "آزمون رقابت" })).statusCode, 200);
    }
  });

  test("انقضا در برابر تأیید هم‌زمان: یا تأیید یا انقضا و سپس فروش با سنجش دوباره؛ هرگز کسر دوگانه", async () => {
    const id = await newOrder(opA, [{ variationId: spare, qty: 1 }]);
    assert.equal((await call("POST", `/instagram-orders/${id}/reserve`, opA)).statusCode, 200);
    await sql`UPDATE sales.instagram_order SET reserved_until = now() - interval '1 second' WHERE id = ${id}::uuid`.execute(owner.db);
    const before = await balance(spare);
    const d = await detail(id);
    const [, confirm] = await Promise.all([
      sql<{ n: number }>`SELECT sales.instagram_expire_due(${SYSTEM_USER}::uuid) AS n`.execute(handle.db),
      call("POST", `/instagram-orders/${id}/confirm`, opA, confirmBody(d, `RACE-EXP-${suffix}`), `exp-${id}`),
    ]);
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal((await detail(id)).status, "finalized");
    const after = await balance(spare);
    assert.equal(Number(after.on_hand), Number(before.on_hand) - 1, "یک کسر");
    assert.equal(Number(after.reserved), Number(before.reserved) - 1, "رزرو یک بار آزاد شد");

    // ادعای واریز جلوی انقضا را می‌گیرد؛ «هیچ» دوباره بازش می‌کند.
    const held = await newOrder(opA, [{ variationId: spare, qty: 1 }]);
    assert.equal((await call("POST", `/instagram-orders/${held}/reserve`, opA)).statusCode, 200);
    assert.equal((await call("POST", `/instagram-orders/${held}/payment-state`, opA, { state: "claimed", note: "مشتری عکس رسید فرستاد" })).statusCode, 200);
    await sql`UPDATE sales.instagram_order SET reserved_until = now() - interval '1 second' WHERE id = ${held}::uuid`.execute(owner.db);
    await sql`SELECT sales.instagram_expire_due(${SYSTEM_USER}::uuid)`.execute(handle.db);
    assert.equal((await detail(held)).status, "reserved", "واریز در جریان، رزرو را نگه داشت");
    const attention = await call("GET", "/instagram-orders?attention=1", opA);
    assert.ok((attention.json().orders as Array<{ id: string }>).some((o) => o.id === held), "در فهرست «نیازمند رسیدگی» است");
    assert.equal((await call("POST", `/instagram-orders/${held}/cancel`, opA, { reason: "x" })).statusCode, 409, "واریز در بررسی لغو نمی‌شود");
    assert.equal((await call("POST", `/instagram-orders/${held}/payment-state`, opA, { state: "none" })).statusCode, 200);
    await sql`SELECT sales.instagram_expire_due(${SYSTEM_USER}::uuid)`.execute(handle.db);
    assert.equal((await detail(held)).status, "expired", "کنترل منفی: بی واریز در جریان منقضی شد");
    const r = await balance(spare);
    const cancel = await call("POST", `/instagram-orders/${held}/cancel`, opA, { reason: "مشتری پاسخ نداد" });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.deepEqual(await balance(spare), r, "لغو سفارش منقضی چیزی را دوباره آزاد نکرد");
  });

  test("نقش برنامه وضعیت سفارش یا تطبیق واریز را مستقیم نمی‌نویسد؛ مالک (مهاجرت و توابع DEFINER) می‌نویسد", async () => {
    const id = await newOrder(opA, []);
    if (process.env.LMC_TEST_DB_ROLE !== "app") {
      // اجرای نقش مالک: نگهبان وضعیت عمداً مالک را معاف می‌کند (همان مسیری که توابع DEFINER از آن
      // می‌نویسند). ادعا همین است، داخل تراکنشی که برمی‌گردد؛ ردِ نقش برنامه در اجرای app سنجیده می‌شود.
      await assert.rejects(handle.db.transaction().execute(async (trx) => {
        await sql`UPDATE sales.instagram_order SET status = 'cancelled' WHERE id = ${id}::uuid`.execute(trx);
        throw new Error("owner-ok");
      }), /owner-ok/);
      return;
    }
    await assert.rejects(sql`UPDATE sales.instagram_order SET status = 'finalized' WHERE id = ${id}::uuid`.execute(handle.db), /مسیر رسمی/);
    await assert.rejects(sql`INSERT INTO sales.instagram_payment (order_id, account_id, amount, ref_no, ref_key, paid_at, paid_date, order_version, verified_by)
      SELECT ${id}::uuid, ${p2p}::uuid, 1, 'X', 'x', now(), current_date, 1, created_by FROM sales.instagram_order WHERE id = ${id}::uuid`.execute(handle.db), /permission denied/);
    await assert.rejects(sql`SELECT sales.instagram_release_hold(${id}::uuid)`.execute(handle.db), /permission denied/);
    // کنترل منفی: سرآیند مجاز (روش ارسال) با همان نقش برنامه نوشته می‌شود؛ پس ردهای بالا از نگهبان است، نه از نبودِ حق جدول.
    await sql`UPDATE sales.instagram_order SET ship_method = 'پیک' WHERE id = ${id}::uuid`.execute(handle.db);
  });

  test("گزارش: فروش اینستاگرام کانال خودش را دارد و واریزها به تفکیک حساب‌اند", async () => {
    const today = (await sql<{ d: string }>`SELECT platform.business_date(now())::text AS d`.execute(handle.db)).rows[0]!.d;
    const summary = await sql<{ channel: string; invoice_count: string; net: string }>`
      SELECT channel, invoice_count::text, net_amount::text AS net FROM sales.report_summary(${today}::date, ${today}::date, ${BRANCH}::uuid)`.execute(handle.db);
    const ig = summary.rows.find((r) => r.channel === "instagram");
    const expected = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM sales.instagram_order WHERE status = 'finalized'`.execute(handle.db)).rows[0]!.n;
    assert.equal(ig?.invoice_count, expected, JSON.stringify(summary.rows));
    const igInvoicesOnShift = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM sales.invoice WHERE channel = 'instagram' AND shift_id IS NOT NULL`.execute(handle.db)).rows[0]!.n;
    assert.equal(igInvoicesOnShift, "0", "هیچ فاکتور اینستاگرام به شیفت صندوق نچسبید");
    const receipts = await call("GET", `/instagram-orders/receipts?from=${today}&to=${today}`, opA);
    assert.equal(receipts.statusCode, 200, receipts.body);
    const rows = receipts.json().receipts as Array<{ accountId: string; total: string; count: number }>;
    const dbTotals = await sql<{ account_id: string; total: string; n: string }>`
      SELECT p.account_id::text, sum(p.amount)::text AS total, count(*)::text AS n FROM treasury.payment p
        JOIN sales.invoice i ON i.id = p.invoice_id WHERE i.channel = 'instagram' GROUP BY 1`.execute(handle.db);
    for (const t of dbTotals.rows) {
      const r = rows.find((x) => x.accountId === t.account_id);
      assert.equal(r?.total, t.total, `جمع واریز حساب ${t.account_id}`);
      assert.equal(r?.count, Number(t.n));
    }
  });
});
