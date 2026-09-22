import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه فروش و صندوق — روی پستگرس واقعی، دیتابیس یک‌بارمصرف.
 *
 * ادعای مرکزی: **قیمت از دیتابیس می‌آید، نه از کلاینت** — و هر مسیری
 * که پول جابه‌جا می‌کند، پیش از نوشتن مجوز می‌گیرد.
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

describe("فروش و صندوق روی دیتابیس واقعی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `s${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-فروش-و-به‌قدر-کافی-بلند";
  const cashier = `cashier_${suffix}`;
  const supervisor = `sup_${suffix}`;

  let supervisorId = "";
  let variationId = "";
  let customerId = "";
  const BARCODE = `BC-${suffix}`;

  /**
   * ورود و برگرداندن کوکی‌ها + سرآیند CSRF، آماده برای inject.
   *
   * نتیجه Cache می‌شود: `/auth/login` سقف ۵ در دقیقه دارد و اگر هر
   * تست دوباره وارد شود، تست‌های بعدی ۴۲۹ می‌گیرند — یعنی تست به
   * ترتیب اجرا وابسته می‌شود، نه به رفتار کد.
   */
  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();

  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const sessionCookie = r.cookies.find((c) => c.name === "labelmod_session");
    const csrfCookie = r.cookies.find((c) => c.name === "labelmod_csrf");
    const out = {
      cookies: {
        labelmod_session: sessionCookie?.value ?? "",
        labelmod_csrf: csrfCookie?.value ?? "",
      },
      headers: { "x-csrf-token": csrfCookie?.value ?? "" },
    };
    sessions.set(username, out);
    return out;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [cashier, "صندوق‌دار تست", "cashier"],
      [supervisor, "سرپرست تست", "supervisor"],
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

      if (role !== "cashier") supervisorId = u.id;
    }

    // کالا، قیمت، موجودی و مشتری
    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'پیراهن تست') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku, barcode)
      VALUES (${prod.rows[0]!.id}, 'آبی', 'L', ${`SKU-${suffix}`}, ${BARCODE})
      RETURNING id`.execute(handle.db);
    variationId = v.rows[0]!.id;

    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 1200000)`.execute(handle.db);

    // موجودی از مسیر مجاز: apply_movement، نه INSERT مستقیم
    await sql`SELECT platform.set_actor(${supervisorId}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 20, 'purchase_receipt',
                'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${supervisorId}::uuid, 700000)`.execute(handle.db);

    const c = await sql<{ id: string }>`
      INSERT INTO sales.customer (mobile_normalized, full_name, credit_limit)
      VALUES (${`0912${suffix.slice(-7)}`}, 'مشتری تست', 900000000) RETURNING id`
      .execute(handle.db);
    customerId = c.rows[0]!.id;

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("فروش صندوق بدون شیفت باز ممکن نیست", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error.code, "no_open_shift");
  });

  test("قیمت از دیتابیس می‌آید — کلاینت نمی‌تواند تعیینش کند", async () => {
    const s = await loginAs(cashier);
    await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: BRANCH, openingCash: "500000" },
    });

    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    assert.equal(inv.statusCode, 201);
    const invoiceId = inv.json().id as string;

    // کلاینت قیمت دلخواه می‌فرستد.
    //
    // تا پیش از مهاجرت ۰۱۰ این میدان **بی‌صدا نادیده گرفته می‌شد**.
    // حالا که قیمت دستی وجود دارد، صریح رد می‌شود — و این قوی‌تر است،
    // نه ضعیف‌تر: تلاش دیده می‌شود به‌جای اینکه ساکت بیفتد. خودِ
    // تضمین عوض نشده؛ صندوق‌دار همچنان نمی‌تواند قیمت را تعیین کند،
    // چون `sale.price_override` را ندارد.
    const denied = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { barcode: BARCODE, qty: "2", unitPrice: "1" },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    // و بدون آن میدان، قیمت همچنان از `catalog.price` می‌آید — میدان
    // ناشناخته `price` هم مثل قبل نادیده گرفته می‌شود.
    const line = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { barcode: BARCODE, qty: "2", price: "1" },
    });
    assert.equal(line.statusCode, 201);
    const body = line.json();
    assert.equal(body.lines[0].unitPrice, "1200000", "قیمت باید از catalog.price بیاید");
    assert.equal(body.lines[0].listPrice, null, "سطر دست‌نخورده listPrice ندارد");
    assert.equal(body.grossAmount, "2400000");
    assert.equal(body.payableAmount, "2400000");
  });

  test("پول در JSON رشته است، نه عدد", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({ method: "GET", url: `/stock/${variationId}?warehouseId=${STORE_WH}`, ...s });
    assert.equal(r.statusCode, 200);
    assert.equal(typeof r.json().unitPrice, "string");

    // عدد در ورودی رد می‌شود
    const inv = await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: BRANCH, openingCash: 500000 },
    });
    assert.equal(inv.statusCode, 400, "مبلغ عددی باید رد شود");
  });

  test("تخفیف بالای سقف نقش، «نیازمند تأیید» می‌شود نه «ممنوع»", async () => {
    const s = await loginAs(cashier);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    const invoiceId = inv.json().id as string;

    // ۸٪ زیر سقف ۱۰٪ صندوق‌دار
    const ok = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "1", discountAmount: "96000", discountReason: "مشتری قدیمی" },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().discountAmount, "96000");

    // ۵۰٪ بالای سقف → ۴۲۸ نیازمند تأیید
    const high = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "1", discountAmount: "600000" },
    });
    assert.equal(high.statusCode, 428, `انتظار ۴۲۸، دریافت ${high.statusCode}: ${high.body}`);
    assert.equal(high.json().error.code, "needs_approval");

    // و سطر دوم نوشته نشده — مجوز پیش از نوشتن گرفته می‌شود
    const after = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    assert.equal(after.json().lines.length, 1, "سطر ردشده نباید نوشته شده باشد");
  });

  test("تخفیف بیشتر از خودِ قلم رد می‌شود", async () => {
    const s = await loginAs(supervisor);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "web" },
    });
    const invoiceId = inv.json().id as string;
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "1", discountAmount: "5000000" },
    });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error.code, "discount_exceeds_line");
  });

  test("فروش نسیه بدون مشتری ممکن نیست، و مجوز جدا می‌خواهد", async () => {
    const s = await loginAs(cashier);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    const invoiceId = inv.json().id as string;
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "1" },
    });

    // بدون پرداخت و بدون مشتری
    const noCustomer = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
    });
    assert.equal(noCustomer.statusCode, 422);
    assert.equal(noCustomer.json().error.code, "credit_needs_customer");

    // با مشتری ولی بدون مجوز نسیه (صندوق‌دار sale.credit ندارد)
    await sql`UPDATE sales.invoice SET customer_id = ${customerId}::uuid
              WHERE id = ${invoiceId}::uuid`.execute(handle.db);
    const noPermission = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
    });
    assert.equal(noPermission.statusCode, 403, `انتظار ۴۰۳: ${noPermission.body}`);
    const creditMarker = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/payments`, ...s,
      payload: { methodCode: "credit", amount: "200000" } });
    assert.equal(creditMarker.statusCode, 403, creditMarker.body);
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM treasury.payment
      WHERE invoice_id=${invoiceId}::uuid AND method_code='credit'`.execute(handle.db)).rows[0]!.n, 0);
  });

  test("چرخه کامل فروش نقدی — و Idempotency روی نهایی‌سازی", async () => {
    const s = await loginAs(supervisor);
    await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: BRANCH, openingCash: "0" },
    });

    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    const invoiceId = inv.json().id as string;

    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "3" },
    });
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "3600000" },
    });

    const key = `finalize-${suffix}`;
    const first = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      cookies: s.cookies,
      headers: { ...s.headers, "idempotency-key": key },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().status, "finalized");
    assert.ok(first.json().number, "شماره فاکتور باید تخصیص یابد");
    assert.equal(first.json().replayed, false);

    // موجودی دقیقاً ۳ تا کم شده
    const stock = await app.inject({
      method: "GET",
      url: `/stock/${variationId}?warehouseId=${STORE_WH}`,
      ...s,
    });
    assert.equal(Number(stock.json().onHand), 17);

    // تکرار با همان کلید: نه فاکتور دوم، نه کسر دوباره موجودی
    const replay = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      cookies: s.cookies,
      headers: { ...s.headers, "idempotency-key": key },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().number, first.json().number, "شماره باید همان باشد");
    assert.equal(replay.json().replayed, true);

    const stockAfter = await app.inject({
      method: "GET",
      url: `/stock/${variationId}?warehouseId=${STORE_WH}`,
      ...s,
    });
    assert.equal(Number(stockAfter.json().onHand), 17, "موجودی نباید دوباره کم شود");

    // فاکتور نهایی‌شده دیگر تغییر نمی‌کند
    const late = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "1" },
    });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.code, "invoice_not_draft");
  });

  test("موجودی ناکافی، نگهبان دیتابیس را می‌زند — ۴۰۹ نه ۵۰۰", async () => {
    const s = await loginAs(supervisor);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "web" },
    });
    const invoiceId = inv.json().id as string;
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "999" },
    });
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "1198800000" },
    });

    const r = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
    });
    assert.notEqual(r.statusCode, 500, "نگهبان نباید شبیه خرابی سرور گزارش شود");
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, "rule_violation");
    assert.match(r.json().error.message, /موجودی کافی نیست/);
  });

  test("کالای بدون قیمت فروخته نمی‌شود", async () => {
    const s = await loginAs(supervisor);
    const p = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`NOPRICE-${suffix}`}, 'کالای بی‌قیمت') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${p.rows[0]!.id}, 'سبز', 'M', ${`NP-${suffix}`}) RETURNING id`.execute(handle.db);

    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "web" },
    });
    const r = await app.inject({
      method: "POST",
      url: `/invoices/${inv.json().id}/lines`,
      ...s,
      payload: { variationId: v.rows[0]!.id, qty: "1" },
    });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error.code, "no_price");
  });

  test("سبد رهاشده، بستن شیفت را برای همیشه بلاک نمی‌کند", async () => {
    const c = await loginAs(cashier);
    const cur = await app.inject({
      method: "GET",
      url: `/shifts/current?branchId=${BRANCH}`,
      ...c,
    });
    const shiftId = cur.json()?.id as string;
    assert.ok(shiftId, "صندوق‌دار باید شیفت باز داشته باشد");

    const denied = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...c,
      payload: { countedCash: "500000" },
    });
    assert.equal(denied.statusCode, 403, "صندوق‌دار مجوز shift.close ندارد");

    const s = await loginAs(supervisor);

    // نگهبان دیتابیس: سبد نیمه‌کاره شیفت را نمی‌بندد. این درست است —
    // ولی راه خروجی هم لازم دارد، وگرنه صندوق‌دار وسط شیفت گیر می‌کند.
    const blocked = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...s,
      payload: { countedCash: "500000" },
    });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().error.message, /فاکتور نهایی‌نشده/);

    // رها کردن سبدهای باز
    const drafts = await sql<{ id: string }>`
      SELECT id FROM sales.invoice WHERE shift_id = ${shiftId}::uuid AND status = 'draft'
    `.execute(handle.db);
    assert.ok(drafts.rows.length > 0, "باید سبد رهاشده وجود داشته باشد");
    for (const d of drafts.rows) {
      const r = await app.inject({
        method: "POST",
        url: `/invoices/${d.id}/cancel`,
        ...c,
        payload: { reason: "مشتری رفت" },
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().status, "cancelled");
    }

    const ok = await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      ...s,
      payload: { countedCash: "500000" },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().status, "closed");
    assert.equal(typeof ok.json().variance, "string", "مغایرت باید رشته باشد");
  });

  test("سبدی که پول رویش نشسته، بی‌سروصدا رها نمی‌شود", async () => {
    const s = await loginAs(supervisor);
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "web" },
    });
    const id = inv.json().id as string;
    await app.inject({
      method: "POST",
      url: `/invoices/${id}/lines`,
      ...s,
      payload: { variationId, qty: "1" },
    });
    await app.inject({
      method: "POST",
      url: `/invoices/${id}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "1200000" },
    });

    const r = await app.inject({ method: "POST", url: `/invoices/${id}/cancel`, ...s, payload: {} });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, "invoice_has_payment");
  });

  test("کاربر شعبه دیگر نمی‌تواند بفروشد", async () => {
    // یافته بازبینی امنیتی: ستون user_role.branch_id وجود داشت و لایه
    // API کاملاً نادیده‌اش می‌گرفت — هر کاربری می‌توانست branchId و
    // warehouseId دلخواه بفرستد.
    //
    // امروز یک شعبه بیشتر نیست، پس اثر عملی نداشت. ولی الگویی که ستون
    // دسترسی را نادیده بگیرد، با شعبه دوم بی‌صدا به نشت تبدیل می‌شود.
    const other = await sql<{ id: string }>`
      INSERT INTO platform.branch (code, name)
      VALUES (${`BR2-${suffix}`}, 'شعبه دوم') RETURNING id`.execute(handle.db);
    const otherBranch = other.rows[0]!.id;
    const otherWh = await sql<{ id: string }>`
      INSERT INTO inventory.warehouse (branch_id, code, name, kind)
      VALUES (${otherBranch}, ${`WH2-${suffix}`}, 'انبار شعبه دوم', 'store')
      RETURNING id`.execute(handle.db);

    const s = await loginAs(cashier);

    // شعبه‌ای که نقشِ کاربر رویش نیست
    const foreign = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: otherBranch, warehouseId: otherWh.rows[0]!.id, channel: "web" },
    });
    assert.equal(foreign.statusCode, 403, foreign.body);
    assert.equal(foreign.json().error.code, "branch_forbidden");

    // و انبار شعبه دیگر، حتی با شعبه خودی — وگرنه موجودی شعبه دوم
    // بی‌آنکه کسی بفهمد کم می‌شد
    const crossed = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: otherWh.rows[0]!.id, channel: "web" },
    });
    assert.equal(crossed.statusCode, 403, crossed.body);
    assert.match(crossed.json().error.message, /متعلق به این شعبه نیست/);

    // مدیر (نقش بدون شعبه) به همه شعب دسترسی دارد
    await sql`INSERT INTO identity.user_role (user_id, role_code, branch_id)
              VALUES (${supervisorId}::uuid, 'admin', NULL)`.execute(handle.db);
    // نقش تازه الزام MFA دارد؛ نشست قدیمی نباید خودکار ارتقا یابد.
    const limited = await app.inject({ method: "GET", url: "/auth/can?operation=sale.create", ...(await loginAs(supervisor)) });
    assert.equal(limited.statusCode, 403, limited.body);
    assert.equal(limited.json().error.code, "second_factor_enrollment_required");
    sessions.delete(supervisor);
    const asAdmin = await app.inject({
      method: "POST",
      url: "/invoices",
      ...(await loginAs(supervisor)),
      payload: { branchId: otherBranch, warehouseId: otherWh.rows[0]!.id, channel: "web" },
    });
    assert.equal(asAdmin.statusCode, 201, "نقش با branch_id تهی یعنی همه شعب");
  });

  test("همه مسیرهای فروش پشت نشست‌اند", async () => {
    for (const [method, url] of [
      ["GET", `/shifts/current?branchId=${BRANCH}`],
      ["POST", "/shifts"],
      ["POST", "/invoices"],
      ["GET", `/stock/${variationId}?warehouseId=${STORE_WH}`],
    ] as const) {
      const r = await app.inject({ method, url, payload: {} });
      assert.equal(r.statusCode, 401, `${method} ${url} بدون نشست باید ۴۰۱ بدهد`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // خرید برای دیگری، و بسته‌بندی هدیه
  // ═══════════════════════════════════════════════════════════════════

  /** یک فاکتور باز با شیفت باز — پایه تست‌های زیر. */
  async function openInvoice(sess: Awaited<ReturnType<typeof loginAs>>) {
    await app.inject({
      method: "POST", url: "/shifts", ...sess,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
    const inv = await app.inject({
      method: "POST", url: "/invoices", ...sess,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    return inv.json().id as string;
  }

  test("گزینه‌های هدیه از دیتابیس می‌آیند، با دسته", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({ method: "GET", url: "/gift-options", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const opts = (JSON.parse(r.body) as {
      options: Array<{ code: string; kind: string; label: string; price: string }>;
    }).options;
    for (const k of ["wrap", "color", "flower"]) {
      assert.ok(opts.some((o) => o.kind === k), `دسته «${k}» باید باشد`);
    }
    // پول رشته است، حتی وقتی صفر است.
    assert.equal(typeof opts[0]!.price, "string");
  });

  test("گیرنده یک مشتری واقعی می‌شود، نه چند ستون روی فاکتور", async () => {
    const s = await loginAs(cashier);
    const id = await openInvoice(s);

    const r = await app.inject({
      method: "PATCH", url: `/invoices/${id}/recipient`, ...s,
      payload: { mobile: "۰۹۱۲۳۰۰۰۰۰۱", fullName: "گیرنده هدیه" },
    });
    assert.equal(r.statusCode, 200, r.body);
    const recipientId = r.json().recipientId as string;
    assert.ok(recipientId, "گیرنده باید شناسه بگیرد");

    // ⚠️ ادعای واقعی: گیرنده در **پرونده مشتری** نشسته، پس اندازه‌اش
    // سال بعد که خودش آمد پیدا می‌شود. با ستون روی فاکتور، هرگز.
    const c = await sql<{ mobile: string }>`
      SELECT mobile_normalized AS mobile FROM sales.customer WHERE id = ${recipientId}::uuid
    `.execute(handle.db);
    assert.equal(c.rows[0]?.mobile, "09123000001", "شماره فارسی باید در دیتابیس نرمال شود");
  });

  test("گیرنده نمی‌تواند خودِ خریدار باشد — ۴۰۹ نه ۵۰۰", async () => {
    const s = await loginAs(cashier);
    const id = await openInvoice(s);
    const mob = `09124${String(Date.now()).slice(-6)}`;
    await app.inject({
      method: "PATCH", url: `/invoices/${id}/customer`, ...s,
      payload: { mobile: mob, fullName: "خریدار" },
    });
    const r = await app.inject({
      method: "PATCH", url: `/invoices/${id}/recipient`, ...s, payload: { mobile: mob },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.body, /خودِ خریدار/);
  });

  test("شماره گیرنده‌ی نامعتبر مشتری بی‌شماره نمی‌سازد", async () => {
    const s = await loginAs(cashier);
    const id = await openInvoice(s);
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer
    `.execute(handle.db);
    const r = await app.inject({
      method: "PATCH", url: `/invoices/${id}/recipient`, ...s, payload: { mobile: "سلام" },
    });
    assert.equal(r.statusCode, 400, r.body);
    const after = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer
    `.execute(handle.db);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, "نباید مشتری تازه ساخته باشد");
  });

  test("بسته‌بندی هدیه ثبت می‌شود و قیمت پیش‌فرض پنهان است", async () => {
    const s = await loginAs(cashier);
    const id = await openInvoice(s);
    const r = await app.inject({
      method: "PUT", url: `/invoices/${id}/gift`, ...s,
      payload: {
        wrapCode: "wrap_box", colorCode: "color_gold",
        flowerCode: "flower_rose", note: "تولدت مبارک",
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    const g = r.json().gift as {
      wrapCode: string; note: string; hidePrices: boolean;
    };
    assert.equal(g.wrapCode, "wrap_box");
    assert.equal(g.note, "تولدت مبارک");
    assert.equal(g.hidePrices, true, "قیمت روی برگه هدیه پیش‌فرض پنهان است");
  });

  test("کد از دسته اشتباه رد می‌شود — «گل رز» شیوه بسته‌بندی نیست", async () => {
    const s = await loginAs(cashier);
    const id = await openInvoice(s);
    const r = await app.inject({
      method: "PUT", url: `/invoices/${id}/gift`, ...s,
      payload: { wrapCode: "flower_rose" },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.body, /شیوه بسته‌بندی نیست/);
  });

  test("نویسه کنترلی در یادداشت رد می‌شود، نه بی‌صدا پاک", async () => {
    // یادداشت روی کارت چاپ می‌شود. پاک‌کردن خاموش یعنی متنی چاپ شود
    // که کاربر ننوشته.
    const s = await loginAs(cashier);
    const id = await openInvoice(s);
    const r = await app.inject({
      method: "PUT", url: `/invoices/${id}/gift`, ...s,
      payload: { note: "تولدت\u202eمبارک" },
    });
    assert.equal(r.statusCode, 400, r.body);
  });

  test("isGift=false سطر هدیه را پاک می‌کند", async () => {
    const s = await loginAs(cashier);
    const id = await openInvoice(s);
    await app.inject({
      method: "PUT", url: `/invoices/${id}/gift`, ...s, payload: { wrapCode: "wrap_bag" },
    });
    const r = await app.inject({
      method: "PUT", url: `/invoices/${id}/gift`, ...s, payload: { isGift: false },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().gift, null, "فاکتور معمولی سطر هدیه ندارد");
  });
});
