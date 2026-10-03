import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه برگشت از فروش و دوره ثبت — روی پستگرس واقعی.
 *
 * دو ادعای مرکزی:
 *
 * ۱. **پولی که گرفته نشده، پس داده نمی‌شود** — و لایه API نمی‌تواند
 *    دور بزندش، چون سقف در `sales.post_return` است.
 * ۲. **درآمد کانال آنلاین بدون بستن دوره به دفتر نمی‌رسد** — و حالا
 *    راهی برای دیدن و بستنش هست.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const DEFECT_WH = "00000000-0000-7000-8000-000000000103";

describe("برگشت از فروش و دوره ثبت", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `r${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-مرجوعی-و-به‌قدر-کافی-بلند";
  const cashier = `rcashier_${suffix}`;
  const supervisor = `rsup_${suffix}`;
  const admin = `radmin_${suffix}`;
  const ids: Record<string, string> = {};
  let variationId = "";
  let customerId = "";
  let supervisorShift = "";

  const sessions = new Map<
    string,
    { cookies: Record<string, string>; headers: Record<string, string> }
  >();

  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: {
        username,
        password: PASSWORD,
        deviceFingerprint: `fp-${suffix}-${username}`,
      },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const out = {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
    sessions.set(username, out);
    return out;
  }

  /** یک فروش نقدی کامل و نهایی‌شده. برمی‌گرداند: شناسه فاکتور. */
  async function soldInvoice(opts: {
    who: string;
    qty: string;
    paid: string;
    channel?: "pos" | "web";
    withCustomer?: boolean;
    method?: string;
    refNo?: string;
    variation?: string;
  }): Promise<{ invoiceId: string; lineId: string }> {
    const s = await loginAs(opts.who);
    const channel = opts.channel ?? "pos";
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: {
        branchId: BRANCH,
        warehouseId: STORE_WH,
        channel,
        ...(opts.withCustomer ? { customerId } : {}),
      },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const invoiceId = inv.json().id as string;

    const line = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId: opts.variation ?? variationId, qty: opts.qty },
    });
    assert.equal(line.statusCode, 201, line.body);
    const lineId = line.json().lines[0].id as string;

    if (opts.paid !== "0") {
      const pay = await app.inject({
        method: "POST",
        url: `/invoices/${invoiceId}/payments`,
        ...s,
        payload: { methodCode: opts.method ?? "cash", amount: opts.paid, refNo: opts.refNo },
      });
      assert.equal(pay.statusCode, 201, pay.body);
    }

    const fin = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
    });
    assert.equal(fin.statusCode, 200, fin.body);
    return { invoiceId, lineId };
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [cashier, "صندوق‌دار مرجوعی", "cashier"],
      [supervisor, "سرپرست مرجوعی", "supervisor"],
      [admin, "مدیر مرجوعی", "admin"],
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
      ids[role] = u.id;
    }

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'شلوار تست') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku, barcode)
      VALUES (${prod.rows[0]!.id}, 'مشکی', '32', ${`SKU-${suffix}`}, ${`BC-${suffix}`})
      RETURNING id`.execute(handle.db);
    variationId = v.rows[0]!.id;

    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 1000000)`.execute(handle.db);

    await sql`SELECT platform.set_actor(${ids["admin"]}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 200, 'purchase_receipt',
                'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${ids["admin"]}::uuid, 400000)`.execute(handle.db);

    const c = await sql<{ id: string }>`
      INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
      VALUES (${`0913${suffix.slice(-7)}`}, 'مشتری مرجوعی', 900000000) RETURNING id`
      .execute(handle.db);
    customerId = c.rows[0]!.id;

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    // شیفت باز برای سرپرست و صندوق‌دار.
    //
    // ⚠️ **دو کشوی باز عمدی است** و یادگارِ دروازهٔ قدیمی نیست: فاکتور
    //    صندوق به شیفتِ خودِ فروشنده می‌چسبد، پس هر دو نفر برای فروش
    //    کشو لازم دارند. ولی بازپرداخت نقدی از **شعبه** کشو می‌گیرد، و
    //    با دو کشوی باز حدس‌زدن ممنوع است — پس هر بازپرداخت نقدیِ این
    //    پرونده `shiftId` را صریح می‌فرستد، همان‌طور که رابط واقعی
    //    می‌فرستد. (`treasury/cash-drawer.ts`)
    for (const who of [supervisor, cashier]) {
      const s = await loginAs(who);
      const r = await app.inject({
        method: "POST",
        url: "/shifts",
        ...s,
        payload: { branchId: BRANCH, openingCash: "10000000" },
      });
      assert.equal(r.statusCode, 201, r.body);
      if (who === supervisor) supervisorShift = (r.json() as { id: string }).id;
    }
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  function exchangeBody(invoiceId: string, lineId: string, returned = "1", replaced = "1") {
    return { invoiceId, warehouseId: STORE_WH, returnWarehouseId: STORE_WH,
      lines: [{ invoiceLineId: lineId, qty: returned }], replacements: [{ variationId, qty: replaced }], reasonCode: "changed_mind" };
  }
  async function exchangeQuote(body: ReturnType<typeof exchangeBody>, who = supervisor) {
    return app.inject({ method: "POST", url: "/exchanges/quote", ...await loginAs(who), payload: body });
  }
  async function policy(value: string) {
    const s = await loginAs(admin);
    const r = await app.inject({ method: "PATCH", url: "/settings/exchange.debt_policy", ...s,
      payload: { value, reason: "آزمون سیاست تعویض" } });
    assert.equal(r.statusCode, 200, r.body);
  }
  async function publicInvoice(invoiceId: string) {
    const result = await sql<{ token: string }>`SELECT sales.ensure_public_token(${invoiceId}::uuid) token`.execute(handle.db);
    const response = await app.inject({ method: "GET", url: `/i/${result.rows[0]!.token}` });
    assert.equal(response.statusCode, 200, response.body);
    return response.body;
  }

  test("تعویض هم‌قیمت اتمیک، replay هم‌زمان، بازیابی پاسخ و سقف مرجوعی جایگزین", async () => {
    const s = await loginAs(supervisor);
    const sold = await soldInvoice({ who: supervisor, qty: "2", paid: "2000000" });
    const body = exchangeBody(sold.invoiceId, sold.lineId);
    const preview = await exchangeQuote(body);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().collectAmount, "0");
    const key = randomUUID();
    const request = { method: "POST" as const, url: "/exchanges", ...s,
      headers: { ...s.headers, "idempotency-key": key }, payload: { ...body, token: preview.json().token, confirmed: true } };
    const [a, b] = await Promise.all([app.inject(request), app.inject(request)]);
    assert.equal(a.statusCode, 200, a.body); assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().id, b.json().id);
    const posted = a.json();
    const status = await app.inject({ method: "GET", url: `/exchanges/status/${key}`, ...s });
    assert.equal(status.json().id, posted.id);
    const changed = await app.inject({ ...request, payload: { ...request.payload, reasonNote: "بدنه دیگر" } });
    assert.equal(changed.statusCode, 409, changed.body);
    const evidence = await sql<{ payments: string; movements: string; credit: string }>`SELECT
      (SELECT count(*)::text FROM treasury.payment WHERE invoice_id=${posted.replacementInvoiceId}::uuid) payments,
      (SELECT count(*)::text FROM inventory.stock_movement WHERE ref_id IN (${posted.returnId}::uuid,${posted.replacementInvoiceId}::uuid)) movements,
      (SELECT credit_applied::text FROM sales.sale_return WHERE id=${posted.returnId}::uuid) credit`.execute(handle.db);
    assert.deepEqual(evidence.rows[0], { payments: "0", movements: "2", credit: "0" });
    const replacement = await app.inject({ method: "GET", url: `/invoices/${posted.replacementInvoiceId}`, ...s });
    assert.equal(replacement.json().settlement.dueAmount, "0");
    const receipt = await publicInvoice(posted.replacementInvoiceId);
    assert.match(receipt, /تسویه از تعویض/);
    assert.doesNotMatch(receipt, /class="due"/);
    const refund = await app.inject({ method: "POST", url: "/returns/commit", ...s,
      headers: { ...s.headers, "idempotency-key": randomUUID() }, payload: {
        invoiceId: posted.replacementInvoiceId, reasonCode: "changed_mind", refundAmount: "1000000", shiftId: supervisorShift,
        lines: [{ invoiceLineId: replacement.json().lines[0].id, qty: "1" }], confirmed: true } });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(refund.json().creditApplied, "0");
  });

  test("تعویض بدهکار: تنظیم فقط مدیر، unset مسدود و دو سیاست صریح", async () => {
    const s = await loginAs(supervisor);
    const denied = await app.inject({ method: "PATCH", url: "/settings/exchange.debt_policy", ...s,
      payload: { value: "carry_debt", reason: "تغییر غیرمجاز" } });
    assert.equal(denied.statusCode, 403, denied.body);
    const sold = await soldInvoice({ who: supervisor, qty: "1", paid: "400000", withCustomer: true });
    const body = exchangeBody(sold.invoiceId, sold.lineId, "1", "1.2");
    const unset = await exchangeQuote(body); assert.equal(unset.statusCode, 409, unset.body);
    await policy("debt_first");
    const first = await exchangeQuote(body);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().debtApplied, "600000"); assert.equal(first.json().collectAmount, "800000");
    await policy("carry_debt");
    const carry = await exchangeQuote(body);
    assert.equal(carry.statusCode, 200, carry.body);
    assert.equal(carry.json().debtApplied, "0"); assert.equal(carry.json().collectAmount, "200000");
    assert.equal(carry.json().fundedTransfer, "400000");
    const post = await app.inject({ method: "POST", url: "/exchanges", ...s, headers: { ...s.headers, "idempotency-key": randomUUID() },
      payload: { ...body, token: carry.json().token, confirmed: true, collectMethod: "cash" } });
    assert.equal(post.statusCode, 200, post.body);
    const amounts = await sql<{ amount: string }>`SELECT sum(amount)::text amount FROM treasury.payment
      WHERE invoice_id=${post.json().replacementInvoiceId}::uuid AND direction='in'`.execute(handle.db);
    assert.equal(amounts.rows[0]!.amount, "200000", "فقط وجه واقعی اختلاف، بدون پرداخت ناخالص ساختگی");
    const replacementReceipt = await publicInvoice(post.json().replacementInvoiceId);
    assert.match(replacementReceipt, /تسویه از تعویض/);
    assert.doesNotMatch(replacementReceipt, /class="due"/);
    const originalReceipt = await publicInvoice(sold.invoiceId);
    assert.match(originalReceipt, /class="due"/);
    assert.ok(originalReceipt.includes((60000n).toLocaleString("fa-IR")), "بدهی واقعی شصت هزار تومان حفظ شده است");
    await policy("unset");
  });

  test("تعویض ارزان‌ترِ پرداخت‌نشده اعتبار یا پول ساختگی نمی‌سازد", async () => {
    await policy("carry_debt");
    const sold = await soldInvoice({ who: supervisor, qty: "1", paid: "0", withCustomer: true });
    const quote = await exchangeQuote(exchangeBody(sold.invoiceId, sold.lineId, "1", "0.5"));
    assert.equal(quote.statusCode, 409, quote.body);
    assert.match(quote.body, /وجه واقعی/);
    await policy("debt_first");
    const body = exchangeBody(sold.invoiceId, sold.lineId);
    const q = await exchangeQuote(body); assert.equal(q.statusCode, 200, q.body);
    assert.equal(q.json().debtApplied, "1000000"); assert.equal(q.json().collectAmount, "1000000");
    const s = await loginAs(supervisor);
    const result = await app.inject({ method: "POST", url: "/exchanges", ...s,
      headers: { ...s.headers, "idempotency-key": randomUUID() }, payload: { ...body, token: q.json().token, confirmed: true, collectMethod: "cash" } });
    assert.equal(result.statusCode, 200, result.body);
    await policy("unset");
  });

  test("rollback تعویض در کسری موجودی و جلوگیری از ارسال دیررس پس از تعیین تکلیف", async () => {
    const sold = await soldInvoice({ who: supervisor, qty: "1", paid: "1000000" });
    const body = exchangeBody(sold.invoiceId, sold.lineId, "1", "10000");
    const q = await exchangeQuote(body); assert.equal(q.statusCode, 200, q.body);
    const s = await loginAs(supervisor), key = randomUUID();
    const request = { method: "POST" as const, url: "/exchanges", ...s, headers: { ...s.headers, "idempotency-key": key },
      payload: { ...body, token: q.json().token, confirmed: true, collectMethod: "cash" } };
    const failed = await app.inject(request); assert.equal(failed.statusCode, 409, failed.body);
    const row = await handle.db.selectFrom("sales.invoice_line").select("returned_qty").where("id", "=", sold.lineId).executeTakeFirstOrThrow();
    assert.equal(Number(row.returned_qty), 0, "حرکت مرجوعی در همان تراکنش rollback شد");
    const status = await app.inject({ method: "GET", url: `/exchanges/status/${key}`, ...s });
    assert.equal(status.json().status, "not_found");
    await app.inject({ method: "POST", url: `/exchanges/status/${key}/abandon`, ...s, payload: { noExternalPayment: true } });
    const late = await app.inject(request); assert.equal(late.statusCode, 409, late.body);
    const after = await app.inject({ method: "GET", url: `/exchanges/status/${key}`, ...s });
    assert.equal(after.json().status, "abandoned");
  });

  test("تعویض ارزان‌ترِ تسویه‌شده فقط اختلاف واقعی را پس می‌دهد", async () => {
    const s = await loginAs(supervisor);
    const sold = await soldInvoice({ who: supervisor, qty: "1", paid: "1000000" });
    const body = exchangeBody(sold.invoiceId, sold.lineId, "1", "0.5");
    const q = await exchangeQuote(body); assert.equal(q.statusCode, 200, q.body);
    assert.equal(q.json().refundAmount, "500000"); assert.equal(q.json().fundedTransfer, "500000");
    const post = await app.inject({ method: "POST", url: "/exchanges", ...s,
      headers: { ...s.headers, "idempotency-key": randomUUID() },
      payload: { ...body, token: q.json().token, confirmed: true, refundMethod: "cash" } });
    assert.equal(post.statusCode, 200, post.body);
    const replacement = await app.inject({ method: "GET", url: `/invoices/${post.json().replacementInvoiceId}`, ...s });
    const returned = await app.inject({ method: "POST", url: "/returns/commit", ...s,
      headers: { ...s.headers, "idempotency-key": randomUUID() }, payload: {
        invoiceId: post.json().replacementInvoiceId, reasonCode: "changed_mind", refundAmount: "500000", shiftId: supervisorShift,
        lines: [{ invoiceLineId: replacement.json().lines[0].id, qty: "0.5" }], confirmed: true } });
    assert.equal(returned.statusCode, 200, returned.body);
    const money = await sql<{ received: string; refunded: string; credit: string }>`SELECT
      (SELECT coalesce(sum(amount),0)::text FROM treasury.payment WHERE invoice_id IN (${sold.invoiceId}::uuid,${post.json().replacementInvoiceId}::uuid) AND direction='in') received,
      (SELECT coalesce(sum(refund_amount),0)::text FROM sales.sale_return WHERE invoice_id IN (${sold.invoiceId}::uuid,${post.json().replacementInvoiceId}::uuid) AND status='posted') refunded,
      (SELECT coalesce(sum(credit_applied),0)::text FROM sales.sale_return WHERE invoice_id IN (${sold.invoiceId}::uuid,${post.json().replacementInvoiceId}::uuid) AND status='posted') credit`.execute(handle.db);
    assert.deepEqual(money.rows[0], { received: "1000000", refunded: "1000000", credit: "0" });
  });

  test("تعویض همان تنوع با موجودی صفر فقط از برگشت سالم قابل فروش تأمین می‌شود", async () => {
    const s = await loginAs(supervisor);
    const product = await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal)
      VALUES (${`ONE-${suffix}`},'تنها موجودی تعویض') RETURNING id`.execute(handle.db);
    const variant = await sql<{ id: string }>`INSERT INTO catalog.variation(product_id,sku,barcode)
      VALUES (${product.rows[0]!.id}::uuid,${`ONE-${suffix}`},${`ONE-${suffix}`}) RETURNING id`.execute(handle.db);
    const only = variant.rows[0]!.id;
    await sql`INSERT INTO catalog.price(variation_id,price_list,amount) VALUES (${only}::uuid,'default',1000000)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(${only}::uuid,${STORE_WH}::uuid,1,'purchase_receipt','test_receipt',${only}::uuid,${ids["admin"]}::uuid,400000)`.execute(handle.db);
    const sold = await soldInvoice({ who: supervisor, qty: "1", paid: "1000000", variation: only });
    for (const quality of [{ condition: "defective" }, { restock: false }, { condition: "sellable" }]) {
      const body = { ...exchangeBody(sold.invoiceId, sold.lineId), lines: [{ invoiceLineId: sold.lineId, qty: "1", ...quality }], replacements: [{ variationId: only, qty: "1" }] };
      const q = await app.inject({ method: "POST", url: "/exchanges/quote", ...s, payload: body });
      assert.equal(q.statusCode, 200, q.body);
      const post = await app.inject({ method: "POST", url: "/exchanges", ...s,
        headers: { ...s.headers, "idempotency-key": randomUUID() }, payload: { ...body, token: q.json().token, confirmed: true } });
      assert.equal(post.statusCode, quality.condition === "sellable" ? 200 : 409, post.body);
      const line = await handle.db.selectFrom("sales.invoice_line").select("returned_qty").where("id", "=", sold.lineId).executeTakeFirstOrThrow();
      assert.equal(Number(line.returned_qty), quality.condition === "sellable" ? 1 : 0);
    }
  });

  test("مرجوعی جایگزین اسنپ به پرداخت اصلی و سقف همان پرداخت متصل می‌ماند", async () => {
    const globalName = `${admin}_global`;
    const u = await handle.db.insertInto("identity.app_user").values({ username: globalName, full_name: "مدیر تنظیمات آزمایشی",
      password_hash: await hashSecret(PASSWORD), is_active: true, mobile: null, pin_hash: null, totp_secret: null }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: "admin", branch_id: null }).execute();
    const a = await loginAs(globalName), s = await loginAs(supervisor);
    const accounts = await sql<{ id: string }>`SELECT id FROM treasury.account WHERE kind='gateway' AND is_active ORDER BY id`.execute(handle.db);
    const config = await app.inject({ method: "PUT", url: "/snappay/config", ...a, payload: { accountId: accounts.rows[0]!.id } });
    assert.equal(config.statusCode, 200, config.body);
    try {
      const sold = await soldInvoice({ who: supervisor, qty: "2", paid: "2000000", method: "snappay", refNo: `SNAP-${suffix}` });
      const source = await app.inject({ method: "GET", url: `/invoices/${sold.invoiceId}/refund-sources`, ...s });
      assert.equal(source.statusCode, 200, source.body);
      const paymentId = source.json().payments[0].id;
      const body = exchangeBody(sold.invoiceId, sold.lineId, "2", "1");
      const q = await exchangeQuote(body); assert.equal(q.statusCode, 200, q.body);
      const post = await app.inject({ method: "POST", url: "/exchanges", ...s,
        headers: { ...s.headers, "idempotency-key": randomUUID() }, payload: { ...body, token: q.json().token, confirmed: true,
          refundMethod: "snappay", refundPaymentId: paymentId, refundReference: `SNAP-DIFF-${suffix}` } });
      assert.equal(post.statusCode, 200, post.body);
      const linked = await app.inject({ method: "GET", url: `/invoices/${post.json().replacementInvoiceId}/refund-sources`, ...s });
      assert.deepEqual(linked.json().payments, [{ id: paymentId, methodCode: "snappay", reference: `SNAP-${suffix}`, remaining: "1000000" }]);
      assert.equal((await app.inject({ method: "PUT", url: "/snappay/config", ...a, payload: { accountId: "" } })).statusCode, 200);
      const replacement = await app.inject({ method: "GET", url: `/invoices/${post.json().replacementInvoiceId}`, ...s });
      const result = await app.inject({ method: "POST", url: "/returns/commit", ...s,
        headers: { ...s.headers, "idempotency-key": randomUUID() }, payload: {
          invoiceId: post.json().replacementInvoiceId, reasonCode: "changed_mind", refundAmount: "1000000",
          refundMethod: "snappay", refundPaymentId: paymentId, refundReference: `SNAP-LAST-${suffix}`,
          lines: [{ invoiceLineId: replacement.json().lines[0].id, qty: "1" }], confirmed: true } });
      assert.equal(result.statusCode, 200, result.body);
      const exhausted = await app.inject({ method: "GET", url: `/invoices/${post.json().replacementInvoiceId}/refund-sources`, ...s });
      assert.equal(exhausted.json().payments.length, 0);
      const provenance = await sql<{ total: string; accounts: string }>`SELECT sum(p.amount)::text total,count(DISTINCT p.account_id)::text accounts
        FROM treasury.payment p JOIN sales.sale_return r ON r.id=p.return_id WHERE r.refund_payment_id=${paymentId}::uuid`.execute(handle.db);
      assert.deepEqual(provenance.rows[0], { total: "2000000", accounts: "1" });
    } finally { await app.inject({ method: "PUT", url: "/snappay/config", ...a, payload: { accountId: "" } }); }
  });

  test("تلفن دقیق نرمال‌شده، صفحه‌بندی و ممنوعیت عبور از شعبه", async () => {
    await soldInvoice({ who: supervisor, qty: "1", paid: "1000000", withCustomer: true });
    await soldInvoice({ who: supervisor, qty: "1", paid: "1000000", withCustomer: true });
    const customer = await handle.db.selectFrom("sales.customer").select("mobile_normalized").where("id", "=", customerId).executeTakeFirstOrThrow();
    const s = await loginAs(supervisor);
    const uri = `/invoices/by-phone?branchId=${BRANCH}&phone=${encodeURIComponent(customer.mobile_normalized)}&limit=1`;
    const first = await app.inject({ method: "GET", url: uri, ...s });
    assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().invoices.length, 1);
    const next = await app.inject({ method: "GET", url: `${uri}&before=${first.json().next}`, ...s });
    assert.notEqual(next.json().invoices[0].id, first.json().invoices[0].id);
    const bad = await app.inject({ method: "GET", url: `/invoices/by-phone?branchId=${randomUUID()}&phone=${customer.mobile_normalized}`, ...s });
    assert.equal(bad.statusCode, 403, bad.body);
  });

  test("بهای مرجوعی در تمام پاسخ‌ها و replay فقط با cost.view دیده می‌شود", async () => {
    const s = await loginAs(cashier);
    const allowed = await loginAs(admin);
    const { invoiceId, lineId } = await soldInvoice({ who: cashier, qty: "2", paid: "2000000", withCustomer: true });
    const payload = {
      invoiceId, reasonCode: "changed_mind", refundAmount: "0",
      lines: [{ invoiceLineId: lineId, qty: "1" }],
    };
    const cancelledDraft = await app.inject({ method: "POST", url: "/returns", ...s, payload });
    assert.equal(cancelledDraft.statusCode, 201, cancelledDraft.body);
    assert.equal(cancelledDraft.json().cogsAmount, null);
    const cancelled = await app.inject({
      method: "POST", url: `/returns/${cancelledDraft.json().id}/cancel`, ...s, payload: {},
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().cogsAmount, null);

    const draft = await app.inject({ method: "POST", url: "/returns", ...s, payload });
    assert.equal(draft.statusCode, 201, draft.body);
    assert.equal(draft.json().cogsAmount, null);
    const id = draft.json().id as string;
    const moved = await app.inject({
      method: "PUT", url: `/returns/${id}/warehouse`, ...s, payload: { warehouseId: STORE_WH },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().cogsAmount, null);
    const post = { method: "POST" as const, url: `/returns/${id}/post`, ...s,
      headers: { ...s.headers, "idempotency-key": `return-cost-${id}` }, payload: {} };
    const posted = await app.inject(post);
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json().cogsAmount, null);
    assert.equal(posted.json().replayed, false);
    const replayed = await app.inject(post);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(replayed.json().cogsAmount, null);
    assert.equal(replayed.json().replayed, true);
    const hidden = await app.inject({ method: "GET", url: `/returns/${id}`, ...s });
    assert.equal(hidden.statusCode, 200, hidden.body);
    assert.equal(hidden.json().cogsAmount, null);
    const visible = await app.inject({ method: "GET", url: `/returns/${id}`, ...allowed });
    assert.equal(visible.statusCode, 200, visible.body);
    assert.equal(visible.json().cogsAmount, "400000");
    const visibleReplay = await app.inject({ ...post, ...allowed,
      headers: { ...allowed.headers, "idempotency-key": `return-cost-${id}` } });
    assert.equal(visibleReplay.statusCode, 200, visibleReplay.body);
    assert.equal(visibleReplay.json().cogsAmount, "400000");
    assert.equal(visibleReplay.json().replayed, true);
    const stored = await sql<{ cost: string }>`SELECT cogs_amount::text AS cost
      FROM sales.sale_return WHERE id = ${id}::uuid`.execute(handle.db);
    assert.equal(stored.rows[0]!.cost, "400000", "پوشاندن پاسخ محاسبه مالی را تغییر نمی‌دهد");
  });

  test("مهلت ۴۸ ساعته با شمارش روز بیان‌شدنی نیست", async () => {
    // چرا این تست وجود دارد: با کلید قدیمیِ روزشمار و مقدار ۲،
    // فاکتور ۷۱ ساعته `floor(71/24) = 2` می‌داد و «داخل مهلت» شمرده
    // می‌شد — یعنی مهلت واقعی ۷۲ ساعت بود، نه ۴۸.
    const s = await loginAs(supervisor);
    const { invoiceId } = await soldInvoice({ who: supervisor, qty: "1", paid: "1000000" });

    // فاکتور را ۷۱ ساعت به عقب می‌بریم — زیر ۷۲، بالای ۴۸.
    await sql`
      UPDATE sales.invoice SET finalized_at = now() - interval '71 hours'
       WHERE id = ${invoiceId}::uuid`.execute(handle.db);

    const r = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/returnable`, ...s });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.hoursSinceSale, 71);
    assert.equal(body.daysSinceSale, 2, "روزشمار هنوز ۲ می‌گوید");
    assert.equal(body.late, true, "ولی با مهلت ۴۸ ساعته، دیرهنگام است");
  });

  test("پیش‌نمایش مرجوعی، باقی‌مانده هر قلم را می‌دهد", async () => {
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "5",
      paid: "5000000",
    });

    const r = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/returnable`, ...s });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.late, false, "فروش همین حالا، دیرهنگام نیست");
    assert.equal(body.hoursSinceSale, 0, "مهلت به ساعت شمرده می‌شود");
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].invoiceLineId, lineId);
    // «5.000» نه «5»: تعداد از SQL می‌آید و همان دقت `platform.qty`
    // را نگه می‌دارد — مثل onHand در /stock.
    assert.equal(body.lines[0].remainingQty, "5.000");
    assert.equal(typeof body.lines[0].unitPrice, "string", "پول باید رشته باشد");
  });

  test("صندوق‌دار بازپرداخت نمی‌دهد — refund.cash ندارد", async () => {
    const s = await loginAs(cashier);
    const { invoiceId, lineId } = await soldInvoice({
      who: cashier,
      qty: "2",
      paid: "2000000",
    });

    const r = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "size_small",
        refundAmount: "1000000",
        refundMethod: "cash",
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(r.statusCode, 403, `انتظار ۴۰۳: ${r.body}`);

    // و هیچ برگ مرجوعی‌ای نوشته نشده — مجوز پیش از نوشتن گرفته می‌شود
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.sale_return WHERE invoice_id = ${invoiceId}::uuid`
      .execute(handle.db);
    assert.equal(count.rows[0]!.n, "0", "برگ ردشده نباید نوشته شده باشد");
  });

  test("چرخه کامل مرجوعی — کالا برمی‌گردد، پول برمی‌گردد، Idempotent است", async () => {
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "4",
      paid: "4000000",
    });

    const before = await stockOf(STORE_WH);

    const draft = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "color_mismatch",
        reasonNote: "رنگ با عکس سایت فرق داشت",
        refundAmount: "2000000",
        refundMethod: "cash",
        shiftId: supervisorShift,
        lines: [{ invoiceLineId: lineId, qty: "2" }],
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const returnId = draft.json().id as string;
    assert.equal(draft.json().status, "draft");
    assert.ok(draft.json().shiftId, "بازپرداخت نقدی باید به شیفت بچسبد");

    const key = `ret-${suffix}`;
    const first = await app.inject({
      method: "POST",
      url: `/returns/${returnId}/post`,
      cookies: s.cookies,
      headers: { ...s.headers, "idempotency-key": key },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().status, "posted");
    assert.ok(first.json().number, "شماره برگ مرجوعی باید تخصیص یابد");
    assert.equal(first.json().replayed, false);
    assert.equal(first.json().netAmount, "2000000");
    assert.equal(first.json().refundAmount, "2000000");
    assert.equal(first.json().receivableApplied, "0");
    assert.equal(first.json().creditApplied, "0");

    assert.equal(await stockOf(STORE_WH), before + 2, "دو قلم باید به انبار برگردد");

    // تکرار: نه کالای دوباره، نه پول دوباره
    const replay = await app.inject({
      method: "POST",
      url: `/returns/${returnId}/post`,
      cookies: s.cookies,
      headers: { ...s.headers, "idempotency-key": key },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().number, first.json().number);
    assert.equal(await stockOf(STORE_WH), before + 2, "موجودی نباید دوباره اضافه شود");

    // بازپرداخت در خزانه رد دارد و به همان شیفت چسبیده
    const pay = await sql<{ n: string; shift: string | null }>`
      SELECT count(*)::text AS n, max(shift_id::text) AS shift
        FROM treasury.payment
       WHERE return_id = ${returnId}::uuid AND direction = 'out'`.execute(handle.db);
    assert.equal(pay.rows[0]!.n, "1", "دقیقاً یک بازپرداخت در خزانه");
    assert.ok(pay.rows[0]!.shift, "بازپرداخت نقدی بدون شیفت، شمارش صندوق را می‌شکند");

    // باقی‌مانده قابل برگشت، دو تا شده
    const left = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/returnable`, ...s });
    assert.equal(left.json().lines[0].remainingQty, "2.000");
  });

  test("بازپرداخت بیش از پول دریافت‌شده رد می‌شود — ۴۰۹ نه ۵۰۰", async () => {
    const s = await loginAs(supervisor);
    // فروش نسیه کامل: هیچ پولی نیامده
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "2",
      paid: "0",
      withCustomer: true,
    });

    const draft = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "quality",
        refundAmount: "2000000",
        refundMethod: "cash",
        shiftId: supervisorShift,
        lines: [{ invoiceLineId: lineId, qty: "2" }],
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);

    const posted = await app.inject({
      method: "POST",
      url: `/returns/${draft.json().id}/post`,
      ...s,
    });
    assert.notEqual(posted.statusCode, 500, "نگهبان نباید شبیه خرابی سرور گزارش شود");
    assert.equal(posted.statusCode, 409, posted.body);
    assert.equal(posted.json().error.code, "rule_violation");
    assert.match(posted.json().error.message, /پس داده نمی‌شود/);
  });

  test("مرجوعی نسیه، اول بدهی همان فاکتور را صفر می‌کند", async () => {
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "3",
      paid: "0",
      withCustomer: true,
    });

    const draft = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "changed_mind",
        refundAmount: "0",
        lines: [{ invoiceLineId: lineId, qty: "3" }],
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);

    const posted = await app.inject({
      method: "POST",
      url: `/returns/${draft.json().id}/post`,
      ...s,
    });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json().refundAmount, "0");
    assert.equal(
      posted.json().receivableApplied,
      "3000000",
      "ارزش کالا باید اول بدهی همان فاکتور را صفر کند، نه اعتبار بسازد",
    );
    assert.equal(posted.json().creditApplied, "0");
  });

  test("کالای معیوب به انبار ضایعات می‌رود، نه به فروشگاه", async () => {
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "2",
      paid: "2000000",
    });

    const store = await stockOf(STORE_WH);
    const defect = await stockOf(DEFECT_WH);

    const draft = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "quality",
        refundAmount: "1000000",
        refundMethod: "cash",
        shiftId: supervisorShift,
        lines: [{ invoiceLineId: lineId, qty: "1", condition: "defective" }],
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const posted = await app.inject({
      method: "POST",
      url: `/returns/${draft.json().id}/post`,
      ...s,
    });
    assert.equal(posted.statusCode, 200, posted.body);

    assert.equal(await stockOf(STORE_WH), store, "کالای معیوب نباید به فروشگاه برگردد");
    assert.equal(await stockOf(DEFECT_WH), defect + 1, "کالای معیوب به انبار ضایعات");
  });

  test("سطر فاکتور دیگر، و سطر تکراری، هر دو رد می‌شوند", async () => {
    const s = await loginAs(supervisor);
    const a = await soldInvoice({ who: supervisor, qty: "2", paid: "2000000" });
    const b = await soldInvoice({ who: supervisor, qty: "2", paid: "2000000" });

    // سطر فاکتور B روی برگ مرجوعی فاکتور A
    const foreign = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId: a.invoiceId,
        reasonCode: "wrong_item",
        refundAmount: "0",
        lines: [{ invoiceLineId: b.lineId, qty: "1" }],
      },
    });
    assert.equal(foreign.statusCode, 422, foreign.body);
    assert.equal(foreign.json().error.code, "line_not_in_invoice");

    // یک قلم، دو بار — سقف «بیش از باقی‌مانده» را دور می‌زد
    const dup = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId: a.invoiceId,
        reasonCode: "wrong_item",
        refundAmount: "0",
        lines: [
          { invoiceLineId: a.lineId, qty: "2" },
          { invoiceLineId: a.lineId, qty: "2" },
        ],
      },
    });
    assert.equal(dup.statusCode, 422, dup.body);
    assert.equal(dup.json().error.code, "duplicate_line");
  });

  test("علت خارج از فهرست، و روش بازپرداخت نامعتبر، رد می‌شوند", async () => {
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "1",
      paid: "1000000",
    });

    // کدِ بدشکل حتی به منطق نمی‌رسد — Zod سر مرز ردش می‌کند، تا چیزی
    // برای بازتاب در پیام خطا نماند.
    const malformed = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "<script>alert(1)</script>",
        refundAmount: "0",
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.equal(malformed.json().error.code, "invalid_input");
    assert.ok(
      !malformed.body.includes("<script>"),
      "ورودی خام نباید در پاسخ بازتاب شود",
    );

    // کدِ خوش‌شکل ولی خارج از فهرست، به منطق می‌رسد و ۴۲۲ می‌گیرد
    const badReason = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "because_i_felt_like_it",
        refundAmount: "0",
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(badReason.statusCode, 422, badReason.body);
    assert.equal(badReason.json().error.code, "bad_reason_code");

    // «نسیه» روش بازپرداخت نیست — وگرنه یک پرداخت نقدیِ ساختگی ثبت می‌شد
    const badMethod = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "quality",
        refundAmount: "1000000",
        refundMethod: "credit",
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(badMethod.statusCode, 422, badMethod.body);
    assert.equal(badMethod.json().error.code, "bad_refund_method");
  });

  /**
   * ⚠️ این تست پیش از این ادعا می‌کرد «مدیرِ بی‌کشو نمی‌تواند بازپرداخت
   *    بدهد» و ۴۲۲ `no_open_shift` انتظار داشت. **همان باگ بود**: کشو
   *    از شعبه پیدا می‌شود نه از کاربر عامل، و چون `refund.cash` را
   *    صندوق‌دار ندارد، آن ادعا یعنی «بازپرداخت نقدی هرگز».
   *
   *    ادعای درست: مجوزدارِ بی‌کشو **می‌تواند**، و پول از کشوی نام‌برده
   *    کم می‌شود. «هیچ کشوی بازی در شعبه نیست» جای دیگری سنجیده
   *    می‌شود: `cash-drawer.integration.test.ts`.
   */
  test("مدیرِ بی‌کشو بازپرداخت می‌دهد و پول از کشوی نام‌برده کم می‌شود", async () => {
    const s = await loginAs(admin);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "1",
      paid: "1000000",
    });

    const r = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "quality",
        refundAmount: "1000000",
        refundMethod: "cash",
        shiftId: supervisorShift,
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const rid = (r.json() as { id: string }).id;

    const posted = await app.inject({
      method: "POST",
      url: `/returns/${rid}/post`,
      ...s,
      headers: { ...s.headers, "idempotency-key": `admin-refund-${rid}` },
    });
    assert.equal(posted.statusCode, 200, posted.body);

    const pay = await sql<{ s: string | null }>`
      SELECT shift_id::text AS s FROM treasury.payment WHERE return_id = ${rid}::uuid`
      .execute(handle.db);
    assert.equal(pay.rows[0]!.s, supervisorShift, "پول باید از همان کشوی نام‌برده کم شود");
  });

  test("کشویی که در این شعبه باز نیست، رد می‌شود", async () => {
    const s = await loginAs(admin);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "1",
      paid: "1000000",
    });

    const r = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "quality",
        refundAmount: "1000000",
        refundMethod: "cash",
        shiftId: "00000000-0000-7000-8000-0000000000ee",
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "wrong_shift");
  });

  test("با دو کشوی باز، نام‌نبردنِ کشو ۴۲۲ می‌گیرد — حدس ممنوع", async () => {
    const s = await loginAs(admin);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor,
      qty: "1",
      paid: "1000000",
    });

    const r = await app.inject({
      method: "POST",
      url: "/returns",
      ...s,
      payload: {
        invoiceId,
        reasonCode: "quality",
        refundAmount: "1000000",
        refundMethod: "cash",
        lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "ambiguous_shift");
  });

  test("بستن خودکار: موجودی دست نمی‌خورد، فقط سند بسته می‌شود", async () => {
    // پاسخ سؤال مالک: «وقتی الان در سایت سفارش ثبت بشه تا شب از
    // موجودی کم نمیشه؟» — چرا، همان لحظه. آنچه شبانه بسته می‌شود
    // فقط سند حسابداری است.
    //
    // با مدیر وارد می‌شویم چون بستن دوره `period.close` می‌خواهد، نه
    // `shift.close`: بستن کشو کار صندوق است و بستن دوره کار حسابدار.
    // سرپرست عمداً این مجوز را ندارد.
    const s = await loginAs(admin);

    const before = await sql<{ on_hand: string }>`
      SELECT on_hand FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);

    // فاکتور کانال آنلاین با تاریخ **دو روز پیش**، نه دیروز.
    //
    // ⚠️ «دیروز» کافی نیست و این تست را روزی دو ساعت قرمز می‌کرد.
    //    بستن خودکار یک مهلت دارد (`sales.auto_close_after_hours`،
    //    پیش‌فرض ۲) که از **نیمه‌شب تهران** شمرده می‌شود. میان ۰۰:۰۰ و
    //    ۰۲:۰۰ به وقت تهران، دوره دیروز هنوز سررسید نشده — رفتار
    //    درستِ تابع، نه یک باگ.
    //
    //    با دو روز، مهلت در هر ساعتی از شبانه‌روز گذشته است. تستی که
    //    به ساعت اجرا وابسته باشد، دیر یا زود در CI قرمز می‌شود و
    //    کسی هم نمی‌فهمد چرا — یک بار همین شد.
    const inv = await sql<{ id: string }>`
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel,
                                 occurred_at, created_by)
      VALUES (${BRANCH}::uuid, ${STORE_WH}::uuid, NULL, 'web',
              now() - interval '2 days', ${ids["supervisor"]}::uuid)
      RETURNING id`.execute(handle.db);
    const invoiceId = inv.rows[0]!.id;
    await sql`
      INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                      unit_price, net_amount)
      VALUES (${invoiceId}::uuid, 1, ${variationId}::uuid, 1, 1200000, 1200000)`
      .execute(handle.db);
    // فروش ناشناس نمی‌تواند نسیه بماند — یک قاعده واقعی که موقع بستن
    // دوره می‌گیردش. پس پرداخت درگاه را هم ثبت می‌کنیم، همان‌طور که
    // یک سفارش واقعی سایت دارد.
    await sql`
      INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, ref_no)
      VALUES (${invoiceId}::uuid, NULL, 'gateway', 1200000, ${`GW-${suffix}`})`
      .execute(handle.db);

    // کاربر عامل صریح پاس داده می‌شود، نه از راه `set_actor`:
    // `set_config` با is_local=true فقط داخل تراکنش زنده است و اینجا
    // هر دستور تراکنش خودش است.
    await sql`SELECT sales.finalize_invoice(${invoiceId}::uuid, ${ids["supervisor"]}::uuid)`
      .execute(handle.db);

    const afterSale = await sql<{ on_hand: string }>`
      SELECT on_hand FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);
    assert.equal(
      Number(afterSale.rows[0]!.on_hand),
      Number(before.rows[0]!.on_hand) - 1,
      "موجودی باید همان لحظه فروش کم شود، نه شب",
    );

    const r = await app.inject({
      method: "POST",
      url: "/posting-batches/close-due",
      ...s,
      payload: {},
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as {
      closed: Array<{ channel: string; saleEntry: string | null; businessDate: string }>;
    };
    const web = body.closed.find((c) => c.channel === "web");
    assert.ok(web, `دوره web بسته نشد: ${r.body}`);
    assert.ok(web.saleEntry, "سند فروش باید زده شده باشد");
    assert.match(web.businessDate, /^\d{4}-\d{2}-\d{2}$/, "تاریخ کاری باید YYYY-MM-DD باشد");

    // و موجودی پس از بستن سند، دست‌نخورده
    const afterClose = await sql<{ on_hand: string }>`
      SELECT on_hand FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);
    assert.equal(
      afterClose.rows[0]!.on_hand,
      afterSale.rows[0]!.on_hand,
      "بستن سند نباید موجودی را عوض کند",
    );
  });

  test("درآمد کانال آنلاین تا بستن دوره، ثبت‌نشده می‌ماند", async () => {
    const a = await loginAs(admin);
    const { invoiceId } = await soldInvoice({
      who: supervisor,
      qty: "2",
      paid: "2000000",
      channel: "web",
    });

    const batch = await sql<{ id: string; d: string; status: string }>`
      SELECT b.id, b.business_date::text AS d, b.status
        FROM ledger.posting_batch b
        JOIN sales.invoice i ON i.posting_batch_id = b.id
       WHERE i.id = ${invoiceId}::uuid`.execute(handle.db);
    assert.equal(batch.rows.length, 1, "فاکتور آنلاین باید به دوره کانال-روز بچسبد");
    const { d: date, status } = batch.rows[0]!;
    assert.equal(status, "open");

    // دیده می‌شود
    const before = await app.inject({ method: "GET", url: "/posting-batches/unposted", ...a });
    assert.equal(before.statusCode, 200, before.body);
    const row = (before.json().rows as Array<Record<string, string>>).find(
      (x) => x.channel === "web" && x.businessDate === date,
    );
    assert.ok(row, "فروش آنلاین ثبت‌نشده باید در فهرست بیاید");
    assert.equal(typeof row.payableAmount, "string", "پول باید رشته باشد");

    // صندوق‌دار نمی‌تواند ببیندش (cost.view ندارد) و نمی‌تواند ببنددش
    const c = await loginAs(cashier);
    const denied = await app.inject({ method: "GET", url: "/posting-batches/unposted", ...c });
    assert.equal(denied.statusCode, 403, denied.body);
    const cantClose = await app.inject({
      method: "POST",
      url: "/posting-batches/close-channel-day",
      ...c,
      payload: { branchId: BRANCH, channel: "web", date },
    });
    assert.equal(cantClose.statusCode, 403, cantClose.body);

    // مدیر می‌بندد — سند فروش و COGS زده می‌شود
    const closed = await app.inject({
      method: "POST",
      url: "/posting-batches/close-channel-day",
      ...a,
      payload: { branchId: BRANCH, channel: "web", date },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.ok(closed.json().saleEntry, "سند فروش باید ساخته شود");
    assert.ok(closed.json().cogsEntry, "سند بهای تمام‌شده باید ساخته شود");
    assert.equal(closed.json().replayed, false);

    // بار دوم: سند دوباره ساخته نمی‌شود
    const again = await app.inject({
      method: "POST",
      url: "/posting-batches/close-channel-day",
      ...a,
      payload: { branchId: BRANCH, channel: "web", date },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().saleEntry, closed.json().saleEntry, "همان سند، نه سند تازه");
    assert.equal(again.json().replayed, true);

    // و هدر Idempotency-Key نمی‌تواند قفل را دور بزند: هویت این عملیات
    // خودِ (شعبه، کانال، تاریخ) است، نه چیزی که فراخوان می‌فرستد.
    const forged = await app.inject({
      method: "POST",
      url: "/posting-batches/close-channel-day",
      cookies: a.cookies,
      headers: { ...a.headers, "idempotency-key": `forged-${suffix}` },
      payload: { branchId: BRANCH, channel: "web", date },
    });
    assert.equal(forged.statusCode, 200, forged.body);
    assert.equal(forged.json().replayed, true, "هدر دلخواه نباید اجرای دوم بسازد");
    assert.equal(forged.json().saleEntry, closed.json().saleEntry);

    const entries = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ledger.journal_entry
       WHERE ref_type = 'posting_batch' AND ref_id = ${batch.rows[0]!.id}::uuid`
      .execute(handle.db);
    assert.ok(Number(entries.rows[0]!.n) <= 2, "حداکثر دو سند: فروش و COGS");

    // و دیگر در فهرست ثبت‌نشده‌ها نیست
    const after = await app.inject({ method: "GET", url: "/posting-batches/unposted", ...a });
    const still = (after.json().rows as Array<Record<string, string>>).find(
      (x) => x.channel === "web" && x.businessDate === date,
    );
    assert.equal(still, undefined, "دوره بسته‌شده نباید ثبت‌نشده بماند");
  });

  test("دوره‌ای که وجود ندارد، ۴۰۴ می‌گیرد نه ۵۰۰", async () => {
    const a = await loginAs(admin);
    const r = await app.inject({
      method: "POST",
      url: "/posting-batches/close-channel-day",
      ...a,
      payload: { branchId: BRANCH, channel: "phone", date: "2026-01-01" },
    });
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(r.json().error.code, "batch_not_found");
  });

  test("تاریخِ خوش‌شکل ولی ناموجود ۴۰۰ می‌گیرد، نه ۵۰۰", async () => {
    // «۲۰۲۶-۱۳-۴۵» شکل درستی دارد ولی تاریخ نیست. الگوی قبلی ردش
    // نمی‌کرد و رشته تا `${input.date}::date` می‌رفت؛ آنجا SQLSTATE
    // 22008 می‌گرفت که `errors.ts` نگاشتی برایش ندارد، پس یک ورودی
    // نامعتبر کاربر به‌شکل «خطای داخلی» بیرون می‌آمد.
    const a = await loginAs(admin);
    for (const date of ["2026-13-45", "2026-02-30", "2025-02-29"]) {
      const r = await app.inject({
        method: "POST",
        url: "/posting-batches/close-channel-day",
        ...a,
        payload: { branchId: BRANCH, channel: "web", date },
      });
      assert.equal(r.statusCode, 400, `${date} → ${r.body}`);
      assert.equal(r.json().error.code, "invalid_input", date);
    }
  });

  async function stockOf(warehouseId: string): Promise<number> {
    const r = await sql<{ on_hand: string }>`
      SELECT coalesce(on_hand, 0)::text AS on_hand FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${warehouseId}::uuid`
      .execute(handle.db);
    return Number(r.rows[0]?.on_hand ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // مقصد کالای برگشتی — قفسه یا آوتلت
  // ═══════════════════════════════════════════════════════════════════

  test("کالای سالم به آوتلت می‌رود، نه به قفسه", async () => {
    const s = await loginAs(supervisor);
    const outlet = await sql<{ id: string }>`
      SELECT id FROM inventory.warehouse WHERE code = 'OUTLET'
    `.execute(handle.db);
    const outletId = outlet.rows[0]?.id;
    assert.ok(outletId, "انبار آوتلت باید در Seed باشد");

    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor, qty: "2", paid: "2000000",
    });
    const shelfBefore = await stockOf(STORE_WH);

    const draft = await app.inject({
      method: "POST", url: "/returns", ...s,
      payload: {
        invoiceId, reasonCode: "color_mismatch", refundAmount: "1000000",
        refundMethod: "cash", shiftId: supervisorShift, lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const id = draft.json().id as string;

    const put = await app.inject({
      method: "PUT", url: `/returns/${id}/warehouse`, ...s,
      payload: { warehouseId: outletId },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().warehouseId, outletId);

    const post = await app.inject({
      method: "POST", url: `/returns/${id}/post`,
      cookies: s.cookies,
      headers: { ...s.headers, "idempotency-key": `out-${suffix}-${Date.now()}` },
    });
    assert.equal(post.statusCode, 200, post.body);

    // ادعای واقعی: کالا در آوتلت است و قفسه **دست‌نخورده** مانده.
    // اگر مقصد نادیده گرفته می‌شد، هر دو عدد عوض می‌شدند.
    const outletQty = await stockOf(outletId);
    assert.ok(outletQty >= 1, `آوتلت باید کالا بگیرد، واقعی ${outletQty}`);
    assert.equal(await stockOf(STORE_WH), shelfBefore, "قفسه نباید تکان بخورد");
  });

  test("پس از ثبت، مقصد قفل است — ۴۰۹ نه ۵۰۰", async () => {
    // حرکت انبار تغییرناپذیر است؛ جابه‌جایی پس از ثبت یعنی موجودی
    // جایی بنشیند که حرکتش جای دیگری ثبت شده.
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor, qty: "2", paid: "2000000",
    });
    const draft = await app.inject({
      method: "POST", url: "/returns", ...s,
      payload: {
        invoiceId, reasonCode: "color_mismatch", refundAmount: "1000000",
        refundMethod: "cash", shiftId: supervisorShift, lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    const id = draft.json().id as string;
    await app.inject({
      method: "POST", url: `/returns/${id}/post`,
      cookies: s.cookies,
      headers: { ...s.headers, "idempotency-key": `lock-${suffix}-${Date.now()}` },
    });

    const outlet = await sql<{ id: string }>`
      SELECT id FROM inventory.warehouse WHERE code = 'OUTLET'
    `.execute(handle.db);
    const r = await app.inject({
      method: "PUT", url: `/returns/${id}/warehouse`, ...s,
      payload: { warehouseId: outlet.rows[0]!.id },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.body, /ثبت‌شده/, "پیام باید فارسی و برای کاربر باشد");
  });

  test("انبار شعبه دیگر رد می‌شود", async () => {
    const s = await loginAs(supervisor);
    const { invoiceId, lineId } = await soldInvoice({
      who: supervisor, qty: "2", paid: "2000000",
    });
    const draft = await app.inject({
      method: "POST", url: "/returns", ...s,
      payload: {
        invoiceId, reasonCode: "color_mismatch", refundAmount: "1000000",
        refundMethod: "cash", shiftId: supervisorShift, lines: [{ invoiceLineId: lineId, qty: "1" }],
      },
    });
    const id = draft.json().id as string;

    const other = await sql<{ id: string }>`
      INSERT INTO platform.branch (code, name)
      VALUES (${`BR-${suffix}`}, 'شعبه دیگر')
      RETURNING id
    `.execute(handle.db);
    const wh = await sql<{ id: string }>`
      INSERT INTO inventory.warehouse (branch_id, code, name, kind)
      VALUES (${other.rows[0]!.id}::uuid, ${`WH-${suffix}`}, 'انبار شعبه دیگر', 'outlet')
      RETURNING id
    `.execute(handle.db);

    const r = await app.inject({
      method: "PUT", url: `/returns/${id}/warehouse`, ...s,
      payload: { warehouseId: wh.rows[0]!.id },
    });
    // ۴۰۳ از دامنه شعبه، پیش از آنکه به دیتابیس برسد.
    assert.ok([403, 409].includes(r.statusCode), `${r.statusCode}: ${r.body}`);
  });

  test("فصل‌ها از دیتابیس می‌آیند، با تفکیک گرم و سرد", async () => {
    const s = await loginAs(supervisor);
    const r = await app.inject({ method: "GET", url: "/seasons", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const seasons = (JSON.parse(r.body) as {
      seasons: Array<{ code: string; label: string; climate: string }>;
    }).seasons;
    assert.ok(seasons.length >= 7, `انتظار دست‌کم ۷ فصل، واقعی ${seasons.length}`);
    const climates = new Set(seasons.map((x) => x.climate));
    for (const c of ["warm", "cold", "all"]) {
      assert.ok(climates.has(c), `اقلیم «${c}» باید باشد`);
    }
    const winter = seasons.find((x) => x.code === "winter");
    assert.equal(winter?.climate, "cold", "زمستان باید فصل سرد باشد");
    assert.equal(winter?.label, "زمستان", "برچسب فارسی از دیتابیس می‌آید");
  });
});
