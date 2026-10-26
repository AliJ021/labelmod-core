import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * فروش اینستاگرام از همان صندوق (۱۰۵) — از راه HTTP و روی پستگرس واقعی.
 *
 * بخش اول قرارداد را می‌سنجد: کانالی که سرور تعیین می‌کند، مجوز از کانال فاکتور، بی شیفت، فقط پرداخت کامل،
 * روش‌های رد‌شده، مالکیت پیش‌نویس، پایداری کانال پس از تغییر نقش، گزارش و مرجوعی به تفکیک منبع، و بسته‌بودن
 * ساخت سفارش چندمرحله‌ای.
 *
 * بخش دوم رقابت **واقعی** است، نه فراخوان پشت‌سرهم ماک‌شده: دو صندوق‌دار حضوری (هر کدام شیفت و سبد خودش)،
 * یک اپراتور اینستاگرام و سفارش Woo، همه از راه HTTP و با Pool ده اتصالی، نهایی‌سازی‌شان هم‌زمان شلیک می‌شود
 * روی آخرین واحدهای **همان تنوع**. چند دور با موجودی متفاوت. ادعا: فروش موفق از موجودی بیشتر نیست، قابل‌فروش
 * منفی نمی‌شود، هر برنده دقیقاً یک خروج کالا دارد، هیچ پرداختی دوبار ثبت نمی‌شود، بازنده پیام خوانا می‌گیرد و
 * پرداختش روی پیش‌نویس خودش می‌ماند (نه گم، نه منتقل). سمت Core مرز Woo: Push مقدار مطلق و واترمارک یکنوا، و
 * Replay سفارش سایت. اینکه سایت تا رسیدن Push عدد کهنه نشان می‌دهد ریسک checkout ناهم‌زمان است و اینجا ادعا نمی‌شود.
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

describe("فروش اینستاگرام از صندوق: قرارداد و رقابت واقعی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;

  const suffix = `igp${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-فروش-اینستاگرام-از-صندوق-بلند";
  const u = {
    op: `igpo_${suffix}`, op2: `igpp_${suffix}`, far: `igpf_${suffix}`, admin: `igpa_${suffix}`,
    c1: `igc1_${suffix}`, c2: `igc2_${suffix}`, c3: `igc3_${suffix}`,
  };
  const ids: Record<string, string> = {};
  const siteKey = newApiKey();
  let otherBranch = "";
  let n = 0;

  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    // هر کاربر از نشانی خودش: سقف «۵ ورود در دقیقه برای هر IP» برای شش کاربر یک ایستگاه نیست.
    const r = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: `10.20.0.${sessions.size + 10}`,
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` } });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const c = (k: string) => r.cookies.find((x) => x.name === k)?.value ?? "";
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
  const key = () => crypto.randomUUID();
  const balance = async (variationId: string) => (await sql<{ on_hand: string; reserved: string; rev: string }>`
    SELECT trim_scale(on_hand)::text AS on_hand, trim_scale(reserved)::text AS reserved, row_version::text AS rev
      FROM inventory.stock_balance WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`
    .execute(handle.db)).rows[0]!;

  /** تنوع تازه با `qty` موجودی و قیمت ۱٬۰۰۰٬۰۰۰ ریال. */
  async function variation(qty: number): Promise<{ id: string; sku: string }> {
    n += 1;
    const sku = `IGP-${suffix}-${n}`;
    const prod = await sql<{ id: string }>`INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${sku}`}, ${`پیراهن ${n}`}) RETURNING id`.execute(owner.db);
    const v = await sql<{ id: string }>`INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${prod.rows[0]!.id}::uuid, 'آبی', 'M', ${sku}) RETURNING id`.execute(owner.db);
    const id = v.rows[0]!.id;
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount) VALUES (${id}::uuid, 'default', 1000000)`.execute(owner.db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(owner.db);
    if (qty > 0) {
      await sql`SELECT inventory.apply_movement(${id}::uuid, ${STORE_WH}::uuid, ${qty}, 'opening', NULL, NULL, ${SYSTEM_USER}::uuid, 400000)`.execute(owner.db);
    }
    return { id, sku };
  }

  /** سبد کامل و پرداخت‌شده؛ هنوز نهایی نشده. */
  async function cart(who: string, variationId: string, qty: number, pay: Array<{ methodCode: string; amount: string; refNo?: string; shiftId?: string }>,
    channel?: string): Promise<string> {
    const inv = await call("POST", "/invoices", who, { branchId: BRANCH, warehouseId: STORE_WH, ...(channel ? { channel } : {}) }, key());
    assert.equal(inv.statusCode, 201, inv.body);
    const id = inv.json().id as string;
    const scan = await call("POST", `/invoices/${id}/scan`, who, { variationId, qty: String(qty) }, key());
    assert.equal(scan.statusCode, 200, scan.body);
    for (const p of pay) {
      const r = await call("POST", `/invoices/${id}/payments`, who, p, key());
      assert.equal(r.statusCode, 201, r.body);
    }
    return id;
  }
  /** کشوی باز یک کاربر در شعبهٔ اصلی. */
  const drawerOf = async (who: string) => (await sql<{ id: string }>`SELECT id FROM sales.cash_shift
    WHERE user_id = ${ids[who]}::uuid AND branch_id = ${BRANCH}::uuid AND status = 'open'`.execute(handle.db)).rows[0]!.id;
  const invoice = async (id: string) => (await sql<{ status: string; channel: string; shift_id: string | null; paid: string; payable: string; batch: string | null }>`
    SELECT i.status, i.channel, i.shift_id::text, i.paid_amount::text AS paid, i.payable_amount::text AS payable,
           (SELECT b.kind || '/' || coalesce(b.channel, '-') FROM ledger.posting_batch b WHERE b.id = i.posting_batch_id) AS batch
      FROM sales.invoice i WHERE i.id = ${id}::uuid`.execute(handle.db)).rows[0]!;

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 10);
    owner = createDb(disposable.ownerUrl, 3);
    const db = handle.db;
    otherBranch = (await sql<{ id: string }>`INSERT INTO platform.branch (code, name) VALUES (${`B-${suffix}`}, 'شعبهٔ دیگر') RETURNING id`.execute(db)).rows[0]!.id;
    const hash = await hashSecret(PASSWORD);
    for (const [username, role, branch] of [
      [u.op, "instagram_operator", BRANCH], [u.op2, "instagram_operator", BRANCH], [u.far, "instagram_operator", otherBranch],
      [u.admin, "admin", BRANCH], [u.c1, "cashier", BRANCH], [u.c2, "cashier", BRANCH], [u.c3, "cashier", BRANCH],
    ] as const) {
      const row = await db.insertInto("identity.app_user").values({
        username, full_name: username, password_hash: hash, is_active: true, mobile: null, pin_hash: null, totp_secret: null,
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("identity.user_role").values({ user_id: row.id, role_code: role, branch_id: branch }).execute();
      ids[username] = row.id;
    }
    const site = await db.insertInto("identity.app_user").values({
      username: `api:site:${suffix}`, full_name: "سایت", password_hash: null, pin_hash: null, mobile: null, totp_secret: null, is_active: false,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("identity.user_role").values({ user_id: site.id, role_code: "web", branch_id: BRANCH }).execute();
    await db.insertInto("identity.api_client").values({
      name: "سایت", user_id: site.id, key_hash: hashApiKey(siteKey), created_by: SYSTEM_USER, note: null, last_used_at: null,
    }).execute();
    // Push موجودی روشن، انبار سایت = قفسه: سمت Core مرز Woo (مقدار مطلق + واترمارک) سنجیده شود.
    await sql`SELECT platform.set_setting('web.push_enabled', 'true'::jsonb, 'آزمون مرز', ${ids[u.admin]}::uuid)`.execute(owner.db);
    await sql`SELECT platform.set_setting('web.stock_warehouse', '"STORE"'::jsonb, 'آزمون مرز', ${ids[u.admin]}::uuid)`.execute(owner.db);
    app = await buildApp({ db, auth: new AuthService(db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", WEB_PUSH_SECRET: undefined }) });
    await app.ready();
    for (const c of [u.c1, u.c2, u.admin]) {
      const r = await call("POST", "/shifts", c, { branchId: BRANCH, openingCash: "0" }, key());
      assert.ok([200, 201].includes(r.statusCode), r.body);
    }
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  test("اپراتور: کانال را سرور می‌گذارد، بی شیفت؛ نقد و کارت‌خوان رد؛ مانده نهایی نمی‌شود؛ ترکیبی کامل نهایی می‌شود", async () => {
    const v = await variation(5);
    // اپراتور «pos» هم بفرستد، سرور «instagram» می‌گذارد: کانال تصمیم کلاینت نیست.
    const inv = await call("POST", "/invoices", u.op, { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" }, key());
    assert.equal(inv.statusCode, 201, inv.body);
    assert.equal(inv.json().channel, "instagram");
    assert.equal(inv.json().shiftId, null, "فروش اینستاگرام کشو ندارد");
    const id = inv.json().id as string;
    assert.equal((await call("POST", `/invoices/${id}/scan`, u.op, { variationId: v.id, qty: "2" }, key())).statusCode, 200);
    // نقد می‌ماند ولی باید به یک کشو برسد (۱۰۶): سه کشوی باز در شعبه و هیچ‌کدام نام برده نشده → ۴۲۲، نه حدس.
    const cash = await call("POST", `/invoices/${id}/payments`, u.op, { methodCode: "cash", amount: "500000" }, key());
    assert.equal(cash.statusCode, 422, cash.body);
    assert.equal(cash.json().error.code, "ambiguous_shift");
    const card = await call("POST", `/invoices/${id}/payments`, u.op, { methodCode: "card", amount: "500000", refNo: "T-1" }, key());
    assert.equal(card.statusCode, 409, card.body);
    const p1 = await call("POST", `/invoices/${id}/payments`, u.op, { methodCode: "transfer", amount: "1500000", refNo: `C2C-${suffix}-1` }, key());
    assert.equal(p1.statusCode, 201, p1.body);
    const partial = await call("POST", `/invoices/${id}/finalize`, u.op, {}, key());
    assert.equal(partial.statusCode, 422, partial.body);
    assert.equal(partial.json().error.code, "instagram_requires_full_payment");
    assert.equal((await balance(v.id)).on_hand, "5", "پرداخت ناقص کالا را بیرون نبرد");
    const p2 = await call("POST", `/invoices/${id}/payments`, u.op, { methodCode: "transfer", amount: "500000", refNo: `C2C-${suffix}-2` }, key());
    assert.equal(p2.statusCode, 201, p2.body);
    const fkey = key();
    const [f1, f2] = await Promise.all([
      call("POST", `/invoices/${id}/finalize`, u.op, {}, fkey),
      call("POST", `/invoices/${id}/finalize`, u.op, {}, fkey),
    ]);
    const codes = [f1.statusCode, f2.statusCode].sort();
    assert.ok(codes.every((c) => c === 200 || c === 409), JSON.stringify(codes));
    assert.ok(codes.includes(200), JSON.stringify([f1.body, f2.body]));
    const row = await invoice(id);
    assert.deepEqual({ status: row.status, channel: row.channel, shift: row.shift_id, paid: row.paid, payable: row.payable, batch: row.batch },
      { status: "finalized", channel: "instagram", shift: null, paid: "2000000", payable: "2000000", batch: "channel_day/instagram" });
    assert.equal((await balance(v.id)).on_hand, "3", "یک بار، دو عدد");
    const payments = await sql<{ n: string }>`SELECT count(*)::text AS n FROM treasury.payment WHERE invoice_id = ${id}::uuid`.execute(handle.db);
    assert.equal(payments.rows[0]!.n, "2", "نه کمتر، نه پرداخت تکراری");
  });

  test("مجوز و دامنه: صندوق‌دار اینستاگرام نمی‌سازد؛ مدیر هر دو؛ اپراتور شعبهٔ دیگر ۴۰۳؛ پیش‌نویس اپراتور دیگر ۴۰۳", async () => {
    const asked = await call("POST", "/invoices", u.c1, { branchId: BRANCH, warehouseId: STORE_WH, channel: "instagram" }, key());
    assert.equal(asked.statusCode, 403, asked.body);
    const adminIg = await call("POST", "/invoices", u.admin, { branchId: BRANCH, warehouseId: STORE_WH, channel: "instagram" }, key());
    assert.equal(adminIg.statusCode, 201, adminIg.body);
    assert.equal(adminIg.json().channel, "instagram");
    const adminPos = await call("POST", "/invoices", u.admin, { branchId: BRANCH, warehouseId: STORE_WH }, key());
    assert.equal(adminPos.statusCode, 201, adminPos.body);
    assert.equal(adminPos.json().channel, "pos", "پیش‌فرض مدیر حضوری است");
    const far = await call("POST", "/invoices", u.far, { branchId: BRANCH, warehouseId: STORE_WH }, key());
    assert.equal(far.statusCode, 403, far.body);
    const v = await variation(3);
    const mine = await call("POST", "/invoices", u.op, { branchId: BRANCH, warehouseId: STORE_WH }, key());
    const other = await call("POST", `/invoices/${mine.json().id}/scan`, u.op2, { variationId: v.id, qty: "1" }, key());
    assert.equal(other.statusCode, 403, other.body);
    // اپراتور به فاکتور حضوری دیگران هم دست نمی‌زند (مجوز از کانال همان فاکتور).
    const pos = await call("POST", `/invoices/${adminPos.json().id}/scan`, u.op, { variationId: v.id, qty: "1" }, key());
    assert.equal(pos.statusCode, 403, pos.body);
  });

  test("خواندن: اپراتور فقط فاکتور اینستاگرامِ خودش را می‌خواند و چاپ می‌کند؛ فهرست و فاکتور دیگران بسته", async () => {
    const v = await variation(4);
    const mine = await cart(u.op, v.id, 1, [{ methodCode: "transfer", amount: "1000000", refNo: `C2C-${suffix}-read` }]);
    assert.equal((await call("POST", `/invoices/${mine}/finalize`, u.op, {}, key())).statusCode, 200);
    const own = await call("GET", `/invoices/${mine}`, u.op);
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().channel, "instagram");
    assert.equal((await call("GET", `/invoices/${mine}/print`, u.op)).statusCode, 200, "رسید فروش خودش چاپ می‌شود");
    // اپراتور دیگرِ همان شعبه: همان پاسخ ۴۰۳ برای «مال دیگری» و «ناموجود» — وجود شناسه لو نمی‌رود.
    const peer = await call("GET", `/invoices/${mine}`, u.op2);
    const ghost = await call("GET", `/invoices/${crypto.randomUUID()}`, u.op2);
    assert.equal(peer.statusCode, 403, peer.body);
    assert.equal(ghost.statusCode, 403, ghost.body);
    assert.equal(peer.json().error.code, ghost.json().error.code);
    assert.equal((await call("GET", `/invoices/${mine}/print`, u.op2)).statusCode, 403);
    // فاکتور حضوری و فهرست فاکتورها برای نقش محدود باز نمی‌شوند.
    const store = await cart(u.c1, v.id, 1, [{ methodCode: "cash", amount: "1000000" }]);
    assert.equal((await call("GET", `/invoices/${store}`, u.op)).statusCode, 403);
    assert.equal((await call("GET", `/invoices?branchId=${BRANCH}`, u.op)).statusCode, 403);
    // کنترل مثبت: دروازهٔ عمومی دست‌نخورده است — صندوق‌دار فاکتور اینستاگرام را هم می‌خواند (مرجوعی، بازیابی).
    assert.equal((await call("GET", `/invoices/${mine}`, u.c1)).statusCode, 200);
  });

  test("تغییر نقش، کانال فاکتور نهایی را عوض نمی‌کند؛ گزارش و مرجوعی به تفکیک منبع", async () => {
    const v = await variation(4);
    const ig = await cart(u.op, v.id, 1, [{ methodCode: "transfer", amount: "1000000", refNo: `R-${suffix}-ig` }]);
    assert.equal((await call("PATCH", `/invoices/${ig}/customer`, u.op, { mobile: "09121234567", fullName: "مشتری دایرکت" })).statusCode, 200);
    assert.equal((await call("POST", `/invoices/${ig}/finalize`, u.op, {}, key())).statusCode, 200);
    const pos = await cart(u.c1, v.id, 1, [{ methodCode: "cash", amount: "1000000" }]);
    assert.equal((await call("POST", `/invoices/${pos}/finalize`, u.c1, {}, key())).statusCode, 200);

    await sql`UPDATE identity.user_role SET role_code = 'cashier' WHERE user_id = ${ids[u.op]}::uuid`.execute(owner.db);
    try {
      assert.equal((await invoice(ig)).channel, "instagram", "کانال در لحظهٔ ساخت ثابت شد");
      const day = (await sql<{ d: string }>`SELECT platform.business_date()::text AS d`.execute(handle.db)).rows[0]!.d;
      const rep = await call("GET", `/reports/sales?from=${day}&to=${day}&branchId=${BRANCH}`, u.admin);
      assert.equal(rep.statusCode, 200, rep.body);
      const rows = rep.json().rows as Array<{ channel: string; invoiceCount: number; netAmount: string }>;
      const sum = (ch: string) => rows.filter((r) => r.channel === ch).reduce((a, r) => a + BigInt(r.netAmount), 0n);
      const fromDb = async (ch: string) => BigInt((await sql<{ s: string }>`SELECT coalesce(sum(net_amount),0)::text AS s FROM sales.invoice
        WHERE channel = ${ch} AND branch_id = ${BRANCH}::uuid AND status IN ('finalized','paid','partially_returned','returned')
          AND platform.business_date(occurred_at) = ${day}::date`.execute(handle.db)).rows[0]!.s);
      assert.equal(sum("instagram"), await fromDb("instagram"), "گزارش اینستاگرام = فاکتورهای کانال اینستاگرام");
      assert.equal(sum("pos"), await fromDb("pos"));
    } finally {
      await sql`UPDATE identity.user_role SET role_code = 'instagram_operator' WHERE user_id = ${ids[u.op]}::uuid`.execute(owner.db);
    }

    // مرجوعی از همان مسیر موجود (مدیر): کالا برمی‌گردد، مبلغ به اعتبار مشتری (بی بازپرداخت نقدی).
    const line = (await sql<{ id: string }>`SELECT id::text FROM sales.invoice_line WHERE invoice_id = ${ig}::uuid`.execute(handle.db)).rows[0]!.id;
    const before = await balance(v.id);
    const draft = await call("POST", "/returns", u.admin, { invoiceId: ig, reasonCode: "changed_mind", refundAmount: "0",
      lines: [{ invoiceLineId: line, qty: "1" }] }, key());
    assert.equal(draft.statusCode, 201, draft.body);
    const posted = await call("POST", `/returns/${draft.json().id}/post`, u.admin, {}, key());
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(Number((await balance(v.id)).on_hand), Number(before.on_hand) + 1, "کالا برگشت");
    assert.equal((await invoice(ig)).channel, "instagram", "مرجوعی کانال را عوض نکرد");
  });

  test("ساخت سفارش چندمرحله‌ای (v1) پیش‌فرض بسته است", async () => {
    const r = await call("POST", "/instagram-orders", u.admin, { branchId: BRANCH, warehouseId: STORE_WH,
      customerMobile: "09121112233", shipAddress: "تهران" }, key());
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "legacy_create_closed");
  });

  test("رقابت واقعی روی آخرین واحدها: دو صندوق‌دار + اپراتور اینستاگرام + Woo، هم‌زمان، چند دور", async () => {
    const rounds = [1, 2, 2, 3, 1, 2, 1, 3];
    let winnersTotal = 0;
    for (const [round, stock] of rounds.entries()) {
      const v = await variation(stock);
      // هر بازیگر سبد مستقل خودش را دارد و کامل پرداخت کرده است؛ هنوز هیچ‌کس نهایی نکرده.
      const c1 = await cart(u.c1, v.id, 1, [{ methodCode: "cash", amount: "1000000" }]);
      const c2 = await cart(u.c2, v.id, 1, [{ methodCode: "card", amount: "1000000", refNo: `CARD-${suffix}-${round}` }]);
      // اپراتور ترکیبی می‌گیرد؛ در دورهای فرد بخشی نقد است و به کشوی صندوق‌دار اول می‌نشیند (۱۰۶).
      const ig = await cart(u.op, v.id, 1, [{ methodCode: "transfer", amount: "600000", refNo: `C2C-${suffix}-${round}-a` },
        round % 2 === 1 ? { methodCode: "cash", amount: "400000", shiftId: await drawerOf(u.c1) }
          : { methodCode: "transfer", amount: "400000", refNo: `C2C-${suffix}-${round}-b` }]);
      const paymentsBefore = await sql<{ n: string }>`SELECT count(*)::text AS n FROM treasury.payment
        WHERE invoice_id IN (${c1}::uuid, ${c2}::uuid, ${ig}::uuid)`.execute(handle.db);
      const woo = () => app.inject({ method: "POST", url: "/web/orders", headers: { authorization: `Bearer ${siteKey}` }, payload: {
        branchId: BRANCH, warehouseId: STORE_WH, externalId: `race-${suffix}-${round}`,
        lines: [{ sku: v.sku, qty: "1", unitPrice: "1000000" }], paymentMethod: "gateway",
        paymentRef: `gw-${suffix}-${round}`, paidAmount: "1000000" } });

      const results = await Promise.all([
        call("POST", `/invoices/${c1}/finalize`, u.c1, {}, key()),
        call("POST", `/invoices/${c2}/finalize`, u.c2, {}, key()),
        call("POST", `/invoices/${ig}/finalize`, u.op, {}, key()),
        woo(),
      ]);
      const codes = results.map((r) => r.statusCode);
      const won = codes.filter((c) => c === 200 || c === 201).length;
      winnersTotal += won;
      assert.ok(won <= stock, `دور ${round}: ${won} برنده با موجودی ${stock}: ${JSON.stringify(codes)}`);
      assert.ok(won >= Math.min(stock, 1), `دور ${round}: هیچ برنده‌ای با موجودی ${stock}`);
      for (const r of results) {
        if (r.statusCode === 200 || r.statusCode === 201) continue;
        assert.equal(r.statusCode, 409, `دور ${round}: بازنده باید تعارض خوانا بگیرد: ${r.body}`);
        assert.match(r.json().error.message, /موجودی/, `دور ${round}: پیام بازنده دربارهٔ موجودی است: ${r.body}`);
      }
      const b = await balance(v.id);
      assert.equal(Number(b.on_hand), stock - won, `دور ${round}: هر برنده دقیقاً یک خروج`);
      assert.ok(Number(b.on_hand) >= 0 && Number(b.reserved) <= Number(b.on_hand), `دور ${round}: ${JSON.stringify(b)}`);
      const exits = await sql<{ n: string }>`SELECT count(*)::text AS n FROM inventory.stock_movement
        WHERE variation_id = ${v.id}::uuid AND qty < 0`.execute(handle.db);
      assert.equal(Number(exits.rows[0]!.n), won, `دور ${round}: شمار خروج = شمار برنده`);
      const paymentsAfter = await sql<{ n: string }>`SELECT count(*)::text AS n FROM treasury.payment
        WHERE invoice_id IN (${c1}::uuid, ${c2}::uuid, ${ig}::uuid) AND direction = 'in'`.execute(handle.db);
      assert.equal(paymentsAfter.rows[0]!.n, paymentsBefore.rows[0]!.n, `دور ${round}: پرداخت تکراری یا گم‌شده نیست`);
      // بازنده‌های Core پیش‌نویس می‌مانند و پولشان روی همان فاکتور است (برای برگشت یا جایگزینی)، نه بی‌صدا رفته.
      for (const id of [c1, c2, ig]) {
        const row = await invoice(id);
        assert.ok(row.status === "finalized" || row.status === "draft", `دور ${round}: ${row.status}`);
        if (row.status === "finalized") assert.equal(row.paid, row.payable, `دور ${round}: برنده تمام‌پرداخت`);
      }
      // سمت Core مرز Woo: آخرین Push معلق همین تنوع مقدار مطلقِ نهایی و واترمارک همان ردیف را دارد.
      const push = await sql<{ on_hand: string; rev: string; n: string }>`
        SELECT (array_agg(payload->>'onHand' ORDER BY created_at DESC))[1] AS on_hand,
               (array_agg(payload->>'stockRev' ORDER BY created_at DESC))[1] AS rev,
               count(*) FILTER (WHERE status = 'pending')::text AS n
          FROM platform.outbox_message WHERE topic = 'web.stock_push' AND payload->>'variationId' = ${v.id}`.execute(handle.db);
      const p = push.rows[0]!;
      assert.equal(p.on_hand, String(Number(b.on_hand) - Number(b.reserved)), `دور ${round}: Push مقدار مطلق نهایی`);
      assert.equal(p.rev, b.rev, `دور ${round}: واترمارک Push = row_version`);
      assert.ok(Number(p.n) <= 1, `دور ${round}: حداکثر یک Push معلق برای هر تنوع (تجمیع)`);
      // Replay همان سفارش سایت (پاسخ گم‌شده و تلاش دوباره) فاکتور، خروج یا پرداخت دوم نمی‌سازد.
      const webCount = async () => (await sql<{ i: string; m: string }>`SELECT
          (SELECT count(*) FROM sales.invoice WHERE channel = 'web')::text AS i,
          (SELECT count(*) FROM inventory.stock_movement WHERE variation_id = ${v.id}::uuid)::text AS m`.execute(handle.db)).rows[0]!;
      const beforeReplay = await webCount();
      const again = await woo();
      assert.ok([200, 201, 409].includes(again.statusCode), again.body);
      assert.deepEqual(await webCount(), beforeReplay, `دور ${round}: Replay سفارش سایت اثر دوم نداشت`);
    }
    assert.ok(winnersTotal > 0);
  });

  test("نقد اینستاگرام: کشوی نام‌برده، نگهبان بستن، شمارش بی مغایرت و Replay پس از بستن", async () => {
    const opened = await call("POST", "/shifts", u.c3, { branchId: BRANCH, openingCash: "0" }, key());
    assert.ok([200, 201].includes(opened.statusCode), opened.body);
    const drawer = await drawerOf(u.c3);
    const v = await variation(2);
    const id = await cart(u.op, v.id, 1, []);
    const pay = (body: object, k = key()) => call("POST", `/invoices/${id}/payments`, u.op, body, k);
    const ambiguous = await pay({ methodCode: "cash", amount: "600000" });
    assert.equal(ambiguous.statusCode, 422, ambiguous.body);
    assert.equal(ambiguous.json().error.code, "ambiguous_shift");
    const cashKey = key();
    const cash = await pay({ methodCode: "cash", amount: "600000", shiftId: drawer }, cashKey);
    assert.equal(cash.statusCode, 201, cash.body);
    const row = (await sql<{ shift_id: string }>`SELECT shift_id::text FROM treasury.payment WHERE id = ${cash.json().paymentId}::uuid`
      .execute(handle.db)).rows[0]!;
    assert.equal(row.shift_id, drawer, "نقد به کشوی نام‌برده نشست");
    assert.equal((await invoice(id)).shift_id, null, "فاکتور بی شیفت ماند");
    const over = await pay({ methodCode: "cash", amount: "400001", shiftId: drawer });
    assert.equal(over.statusCode, 409, over.body);
    assert.match(over.json().error.message, /باقی پول ندارد/);
    // کشو با نقدِ پیش‌نویس اینستاگرام بسته نمی‌شود (بستن کشو `shift.close` است: مدیر، نه صندوق‌دار).
    const early = await call("POST", `/shifts/${drawer}/close`, u.admin, { countedCash: "600000" }, key());
    assert.equal(early.statusCode, 409, early.body);
    assert.match(early.json().error.message, /نقدِ فاکتور نهایی‌نشده/);
    assert.equal((await pay({ methodCode: "transfer", amount: "400000", refNo: `C2C-${suffix}-drawer` })).statusCode, 201);
    assert.equal((await call("POST", `/invoices/${id}/finalize`, u.op, {}, key())).statusCode, 200);
    const done = await invoice(id);
    assert.deepEqual({ status: done.status, shift: done.shift_id, batch: done.batch, paid: done.paid },
      { status: "finalized", shift: null, batch: "channel_day/instagram", paid: "1000000" });
    const closed = await call("POST", `/shifts/${drawer}/close`, u.admin, { countedCash: "600000" }, key());
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().variance, "0", "نقد اینستاگرام در شمارش همان کشو آمد");
    // پاسخ گم‌شدهٔ همان پرداخت نقد پس از بستن کشو: Replay، نه ۴۲۲ و نه ردیف دوم.
    const replay = await pay({ methodCode: "cash", amount: "600000", shiftId: drawer }, cashKey);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
  });

  test("نیمه‌شب و دورهٔ بسته: سبد دیروز با زمان نهایی‌سازی ثبت می‌شود؛ Replay پاسخ گم‌شده اثر دوم ندارد", async () => {
    const v = await variation(3);
    const id = await cart(u.op, v.id, 1, [{ methodCode: "transfer", amount: "1000000", refNo: `C2C-${suffix}-midnight` }]);
    // گذر نیمه‌شب: پیش‌نویس و پرداختش «دیروز» ساخته شده‌اند و دورهٔ اینستاگرامِ دیروز شبانه بسته شده است.
    await sql`UPDATE sales.invoice SET occurred_at = now() - interval '1 day' WHERE id = ${id}::uuid`.execute(owner.db);
    await sql`UPDATE treasury.payment SET occurred_at = now() - interval '1 day' WHERE invoice_id = ${id}::uuid`.execute(owner.db);
    await sql`INSERT INTO ledger.posting_batch (branch_id, kind, channel, business_date, status, posted_at)
      VALUES (${BRANCH}::uuid, 'channel_day', 'instagram', platform.business_date(now()) - 1, 'posted', now())
      ON CONFLICT DO NOTHING`.execute(owner.db);
    const k = key();
    const first = await call("POST", `/invoices/${id}/finalize`, u.op, {}, k);
    assert.equal(first.statusCode, 200, first.body);
    const row = (await sql<{ d: string; today: string; paid_day: string; y_status: string; y_count: string }>`
      SELECT b.business_date::text AS d, platform.business_date(now())::text AS today,
             (SELECT platform.business_date(occurred_at)::text FROM treasury.payment WHERE invoice_id = i.id LIMIT 1) AS paid_day,
             y.status AS y_status, (SELECT count(*) FROM sales.invoice WHERE posting_batch_id = y.id)::text AS y_count
        FROM sales.invoice i JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
        JOIN ledger.posting_batch y ON y.kind = 'channel_day' AND y.channel = 'instagram' AND y.branch_id = i.branch_id
                                   AND y.business_date = platform.business_date(now()) - 1
       WHERE i.id = ${id}::uuid`.execute(handle.db)).rows[0]!;
    assert.equal(row.d, row.today, "دورهٔ ثبت = روز نهایی‌سازی، نه روز ساخت سبد");
    assert.deepEqual({ status: row.y_status, invoices: row.y_count }, { status: "posted", invoices: "0" }, "دورهٔ بستهٔ دیروز باز نشد");
    assert.notEqual(row.paid_day, row.today, "زمان پرداخت بازنویسی نشد");
    const moves = async () => (await sql<{ n: string }>`SELECT count(*)::text AS n FROM inventory.stock_movement
      WHERE ref_type = 'invoice' AND ref_id = ${id}::uuid`.execute(handle.db)).rows[0]!.n;
    const before = await moves();
    // پاسخ اول گم شد؛ صف آفلاین با همان کلید دوباره می‌فرستد.
    const replay = await call("POST", `/invoices/${id}/finalize`, u.op, {}, k);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().number, first.json().number, "همان شماره");
    assert.equal(await moves(), before, "خروج کالای دوم نیست");
    // کنترل منفی در همین مسیر: سبد «دیروزِ» دیگری که از راه SQL بی تازه‌سازی نهایی شود، رد می‌شود.
    const other = await cart(u.op, v.id, 1, [{ methodCode: "transfer", amount: "1000000", refNo: `C2C-${suffix}-midnight-2` }]);
    await sql`UPDATE sales.invoice SET occurred_at = now() - interval '1 day' WHERE id = ${other}::uuid`.execute(owner.db);
    await assert.rejects(sql`SELECT sales.finalize_invoice(${other}::uuid, ${ids[u.op]}::uuid)`.execute(owner.db),
      /دوره ثبت این فاکتور قبلاً بسته شده است|زمان فروش اینستاگرام/);
  });

  test("برگشت کامل چندسطری: یک سطر بی‌موجودی کل نهایی‌سازی را برمی‌گرداند", async () => {
    const ok = await variation(5);
    const none = await variation(1);
    const id = await cart(u.op, ok.id, 1, []);
    assert.equal((await call("POST", `/invoices/${id}/scan`, u.op, { variationId: none.id, qty: "1" }, key())).statusCode, 200);
    assert.equal((await call("POST", `/invoices/${id}/payments`, u.op,
      { methodCode: "transfer", amount: "2000000", refNo: `ML-${suffix}` }, key())).statusCode, 201);
    // آخرین واحد سطر دوم را صندوق‌دار زودتر می‌برد.
    const steal = await cart(u.c1, none.id, 1, [{ methodCode: "cash", amount: "1000000" }]);
    assert.equal((await call("POST", `/invoices/${steal}/finalize`, u.c1, {}, key())).statusCode, 200);
    const fail = await call("POST", `/invoices/${id}/finalize`, u.op, {}, key());
    assert.equal(fail.statusCode, 409, fail.body);
    assert.equal((await balance(ok.id)).on_hand, "5", "سطر اول هم برنگشته نماند: کل تراکنش برگشت");
    assert.equal((await invoice(id)).status, "draft");
  });
});
