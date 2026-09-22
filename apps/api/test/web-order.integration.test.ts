import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه سفارش سایت — روی پستگرس واقعی.
 *
 * چهار ادعا که هیچ‌کدام را نمی‌شود بدون راندن مسیر واقعی سنجید:
 *
 * ۱. **کلید API یک راه دور زدن نیست.** بدون کلید ۴۰۱، با کلید باطل
 *    ۴۰۱، و با کوکیِ صندوق‌دار روی همین مسیر ۴۰۳ — چون نقش سایت را
 *    ندارد. مجوز از `permission_rule` می‌آید، نه از نوع احراز هویت.
 *
 * ۲. **دو Webhook یک فاکتور می‌سازد.** ووکامرس Retry می‌کند و باید
 *    بکند؛ کلید Idempotency از **شماره سفارش** ساخته می‌شود، نه از
 *    هدر. اگر روزی کسی هدر کلاینت را بپذیرد، همان لحظه فاکتور دوم
 *    ساخته می‌شود و کسی هم نمی‌فهمد.
 *
 * ۳. **قیمت سایت روی فاکتور می‌نشیند، نه قیمت فهرست.** مشتری همان را
 *    پرداخت کرده. سطر باید `listPrice` هم داشته باشد تا تفاوت در
 *    گزارش دیده شود.
 *
 * ۴. **سفارش سایت درآمدش را همان لحظه به دفتر نمی‌برد.** فاکتور نهایی
 *    می‌شود و کالا از انبار خارج، ولی سند درآمد کار بستن شبانه دوره
 *    کانال است (ADR-003). اگر روزی این دو یکی شوند، این ادعا قرمز
 *    می‌شود.
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

interface OrderResponse {
  invoiceId: string;
  number: string | null;
  status: string;
  payableAmount: string;
  replayed: boolean;
}

describe("سفارش سایت (ووکامرس)", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `w${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-سفارش-سایت-و-به‌قدر-کافی-بلند";
  const cashier = `wcash_${suffix}`;

  const key = newApiKey();
  const deadKey = newApiKey();
  let webUserId = "";
  let sku = "";
  let sku2 = "";

  const auth = () => ({ headers: { authorization: `Bearer ${key}` } });

  async function order(payload: Record<string, unknown>) {
    return await app.inject({
      method: "POST",
      url: "/web/orders",
      ...auth(),
      payload,
    });
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    // کاربر پشتی سایت — همان چیزی که `cli/create-api-client.ts`
    // می‌سازد: بدون رمز، بدون PIN، غیرفعال. کلید تنها راه اوست.
    const webUser = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: `api:site:${suffix}`,
        full_name: "سایت لیبل مد",
        password_hash: null,
        pin_hash: null,
        mobile: null,
        totp_secret: null,
        is_active: false,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    webUserId = webUser.id;

    await handle.db
      .insertInto("identity.user_role")
      .values({ user_id: webUserId, role_code: "web", branch_id: BRANCH })
      .execute();

    await handle.db
      .insertInto("identity.api_client")
      .values({
        name: "سایت لیبل مد",
        user_id: webUserId,
        key_hash: hashApiKey(key),
        created_by: SYSTEM_USER,
        note: null,
        last_used_at: null,
      })
      .execute();

    // کلید باطل‌شده — برای ادعای «باطل یعنی باطل».
    await handle.db
      .insertInto("identity.api_client")
      .values({
        name: "کلید باطل",
        user_id: webUserId,
        key_hash: hashApiKey(deadKey),
        is_active: false,
        created_by: SYSTEM_USER,
        note: null,
        last_used_at: null,
      })
      .execute();

    // یک صندوق‌دار عادی — تا ثابت شود دروازه، نقش است نه نوع احراز هویت.
    const hash = await hashSecret(PASSWORD);
    const u = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: cashier,
        full_name: "صندوق‌دار سایت",
        password_hash: hash,
        pin_hash: null,
        mobile: null,
        totp_secret: null,
        is_active: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await handle.db
      .insertInto("identity.user_role")
      .values({ user_id: u.id, role_code: "cashier", branch_id: BRANCH })
      .execute();

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'شومیز تست سایت') RETURNING id`.execute(handle.db);
    const productId = prod.rows[0]!.id;

    for (const [color, size, tag] of [
      ["آبی", "M", "a"],
      ["آبی", "L", "b"],
    ] as const) {
      const code = `SKU-${suffix}-${tag}`;
      const v = await sql<{ id: string }>`
        INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (${productId}, ${color}, ${size}, ${code}) RETURNING id`.execute(handle.db);
      const id = v.rows[0]!.id;
      if (tag === "a") sku = code;
      else sku2 = code;

      await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
                VALUES (${id}, 'default', 2000000)`.execute(handle.db);
      await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
      await sql`SELECT inventory.apply_movement(
                  ${id}::uuid, ${STORE_WH}::uuid, 10, 'purchase_receipt',
                  'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${SYSTEM_USER}::uuid, 800000)`.execute(handle.db);
    }

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

  // ── احراز هویت ──────────────────────────────────────────────────

  test("بدون کلید، ۴۰۱", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/web/orders",
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    assert.equal(r.statusCode, 401, r.body);
  });

  test("کلید باطل‌شده، ۴۰۱", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/web/orders",
      headers: { authorization: `Bearer ${deadKey}` },
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    assert.equal(r.statusCode, 401, r.body);
    const b = JSON.parse(r.body) as { error: { code: string } };
    assert.equal(b.error.code, "bad_api_key");
  });

  test("کلید ناشناخته و کلید باطل یک پاسخ می‌گیرند", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/web/orders",
      headers: { authorization: "Bearer lmk_something-that-was-never-issued" },
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    assert.equal(r.statusCode, 401, r.body);
    const b = JSON.parse(r.body) as { error: { message: string } };
    assert.match(b.error.message, /نامعتبر یا باطل/, "پیام نباید بگوید کدام‌یک");
  });

  test("کلید API نیازی به توکن CSRF ندارد", async () => {
    // اگر روزی CSRF روی این مسیر اعمال شود، همین‌جا ۴۰۳ می‌گیرد.
    // هدر Authorization را هیچ مرورگری خودکار نمی‌فرستد؛ اعمالش فقط
    // سایت را از کار می‌انداخت.
    const r = await order({
      branchId: BRANCH,
      warehouseId: STORE_WH,
      externalId: `csrf-${suffix}`,
      lines: [{ sku, qty: "1", unitPrice: "2000000" }],
      paymentMethod: "gateway",
      paymentRef: `ref-csrf-${suffix}`,
      paidAmount: "2000000",
    });
    assert.equal(r.statusCode, 201, r.body);
  });

  // ── مجوز ────────────────────────────────────────────────────────

  test("صندوق‌دار با کوکی خودش هم این مسیر را ندارد", async () => {
    const login = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: { username: cashier, password: PASSWORD, deviceFingerprint: `fp-${suffix}` },
    });
    assert.equal(login.statusCode, 200, login.body);
    const csrf = login.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";

    const r = await app.inject({
      method: "POST",
      url: "/web/orders",
      cookies: {
        labelmod_session:
          login.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
      payload: {
        branchId: BRANCH,
        warehouseId: STORE_WH,
        externalId: `cashier-${suffix}`,
        lines: [{ sku, qty: "1", unitPrice: "1500000" }],
        paymentMethod: "gateway",
        paymentRef: `ref-c-${suffix}`,
        paidAmount: "1500000",
      },
    });
    // صندوق‌دار `sale.price_override` ندارد — و سفارش سایت بدون قیمت
    // معنا ندارد. دروازه، نقش است نه نوع احراز هویت.
    assert.equal(r.statusCode, 403, r.body);
    const b = JSON.parse(r.body) as { error: { code: string } };
    assert.equal(b.error.code, "deny");
  });

  // ── ثبت سفارش ───────────────────────────────────────────────────

  test("سفارش سایت با قیمت کمپین ثبت می‌شود و همان قیمت می‌نشیند", async () => {
    const r = await order({
      branchId: BRANCH,
      warehouseId: STORE_WH,
      externalId: `wc-${suffix}-1`,
      customerMobile: "۰۹۱۲۳۴۵۶۷۸۹",
      customerName: "مشتری سایت",
      lines: [
        { sku, qty: "2", unitPrice: "1500000" },
        { sku: sku2, qty: "1", unitPrice: "2000000" },
      ],
      shippingAmount: "300000",
      paymentMethod: "gateway",
      paymentRef: `ref-${suffix}-1`,
      paidAmount: "5300000",
    });
    assert.equal(r.statusCode, 201, r.body);
    const body = JSON.parse(r.body) as OrderResponse;
    assert.equal(body.status, "finalized");
    assert.ok(body.number, "فاکتور نهایی شماره می‌گیرد");
    // ۲×۱٬۵۰۰٬۰۰۰ + ۲٬۰۰۰٬۰۰۰ + ۳۰۰٬۰۰۰ کرایه
    assert.equal(body.payableAmount, "5300000");

    const line = await sql<{ unit_price: string; list_price: string | null; reason: string | null }>`
      SELECT l.unit_price, l.list_price, l.price_override_reason AS reason
        FROM sales.invoice_line l
        JOIN catalog.variation v ON v.id = l.variation_id
       WHERE l.invoice_id = ${body.invoiceId}::uuid AND v.sku = ${sku}`.execute(handle.db);
    assert.equal(line.rows[0]!.unit_price, "1500000", "قیمت سایت روی سطر نشست");
    assert.equal(line.rows[0]!.list_price, "2000000", "قیمت فهرست هم ثبت شد");
    assert.equal(line.rows[0]!.reason, "قیمت سایت");

    // قیمت برابر فهرست، بازنویسی نیست — سطر دوم باید تمیز بماند.
    const clean = await sql<{ list_price: string | null }>`
      SELECT l.list_price
        FROM sales.invoice_line l
        JOIN catalog.variation v ON v.id = l.variation_id
       WHERE l.invoice_id = ${body.invoiceId}::uuid AND v.sku = ${sku2}`.execute(handle.db);
    assert.equal(clean.rows[0]!.list_price, null);
  });

  test("موبایل سایت و موبایل صندوق یک مشتری می‌سازند", async () => {
    // «۰۹۱۲…» فارسی از سفارش قبلی و «+98912…» از این یکی — یک سطر.
    const r = await order({
      branchId: BRANCH,
      warehouseId: STORE_WH,
      externalId: `wc-${suffix}-mobile`,
      customerMobile: "+989123456789",
      lines: [{ sku, qty: "1", unitPrice: "2000000" }],
      paymentMethod: "gateway",
      paymentRef: `ref-${suffix}-m`,
      paidAmount: "2000000",
    });
    assert.equal(r.statusCode, 201, r.body);

    const c = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer
       WHERE mobile_normalized = sales.normalize_mobile('09123456789')`.execute(handle.db);
    assert.equal(c.rows[0]!.n, "1", "یک مشتری، نه دو تا");
  });

  test("تلفن قلابی سفارش سایت، مشتری مشترک نمی‌سازد", async () => {
    // ⚠️ رگرسیون یک باگ اثبات‌شده. `sales.normalize_mobile` نرمال‌ساز
    //    است نه اعتبارسنج: هر چیزی بی‌رقم به رشته **خالی** تبدیل
    //    می‌شود، نه NULL — و رشته خالی NULL نیست، پس قید یکتایی رویش
    //    اعمال می‌شود.
    //
    //    نتیجه: پنج سفارش با تلفن قلابیِ **متفاوت** («-»، «abc»،
    //    «N/A»، «   .»، «ندارد») همه به **یک** پرونده با
    //    `mobile_normalized = ''` می‌چسبیدند، با نام هرکسی که اول
    //    آمده بود. سابقه خرید و مانده چند نفر بی‌ربط زیر یک پرونده.
    // ⚠️ SKU **اختصاصی** این ادعا، نه SKU مشترک: پنج فروش روی کالای
    //    مشترک، عددِ «موجودی در دسترس» را برای ادعای بعدی عوض می‌کرد و
    //    آن را قرمز می‌کرد. تستی که به ترتیب اجرا یا به باقی‌ماندهٔ
    //    تستِ دیگر وابسته باشد، خودش یک نقص است (بند ۷۲ الحاقیه).
    const junkSku = `SKU-${suffix}-junk`;
    const jv = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      SELECT p.id, 'سبز', 'XL', ${junkSku} FROM catalog.product p
       WHERE p.code = ${`P-${suffix}`} RETURNING id`.execute(handle.db);
    const jid = jv.rows[0]!.id;
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${jid}, 'default', 1000000)`.execute(handle.db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${jid}::uuid, ${STORE_WH}::uuid, 20, 'purchase_receipt',
                'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${SYSTEM_USER}::uuid, 500000)`.execute(handle.db);

    const junk = ["-", "abc", "N/A", "   .", "ندارد"];
    for (const [i, phone] of junk.entries()) {
      const r = await order({
        branchId: BRANCH,
        warehouseId: STORE_WH,
        externalId: `wc-${suffix}-junk-${i}`,
        customerMobile: phone,
        customerName: `مشتری ${phone}`,
        lines: [{ sku: junkSku, qty: "1", unitPrice: "1000000" }],
        paymentMethod: "gateway",
        paymentRef: `ref-${suffix}-j${i}`,
        paidAmount: "1000000",
      });
      // سفارش باید **ثبت شود** — تلفن بی‌معنا نباید سفارش سایت را
      // بشکند. قاعده حاکم افزونه: ارسال نباید Checkout را خراب کند.
      assert.equal(r.statusCode, 201, `تلفن «${phone}»: ${r.body}`);
    }

    const empty = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer
       WHERE mobile_normalized = ''`.execute(handle.db);
    assert.equal(empty.rows[0]!.n, "0",
      "هیچ مشتری‌ای با موبایل خالی ساخته نشود — آن پرونده مشترک می‌شد");

    // و آن فاکتورها باید **ناشناس** باشند، نه چسبیده به یک پرونده.
    // شناسه سفارش سایت روی **پرداخت** می‌نشیند، نه روی فاکتور.
    const anon = await sql<{ n: string }>`
      SELECT count(*)::text AS n
        FROM sales.invoice i
        JOIN treasury.payment p ON p.invoice_id = i.id
       WHERE p.client_event_id LIKE ${`woo:wc-${suffix}-junk-%`}
         AND i.customer_id IS NULL`
      .execute(handle.db);
    assert.equal(anon.rows[0]!.n, String(junk.length),
      "هر پنج فاکتور باید بدون مشتری بمانند");
  });

  test("Webhook تکراری فاکتور دوم نمی‌سازد", async () => {
    const payload = {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      externalId: `wc-${suffix}-dup`,
      lines: [{ sku, qty: "1", unitPrice: "1800000" }],
      paymentMethod: "gateway",
      paymentRef: `ref-${suffix}-dup`,
      paidAmount: "1800000",
    };

    const first = JSON.parse((await order(payload)).body) as OrderResponse;
    const second = await order(payload);

    assert.equal(second.statusCode, 200, second.body);
    const body = JSON.parse(second.body) as OrderResponse;
    assert.equal(body.replayed, true);
    assert.equal(body.invoiceId, first.invoiceId, "همان فاکتور، نه یکی تازه");

    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.invoice WHERE id = ${first.invoiceId}::uuid`
      .execute(handle.db);
    assert.equal(n.rows[0]!.n, "1");
  });

  test("کالای ناشناخته سفارش را رد می‌کند و چیزی جا نمی‌گذارد", async () => {
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.invoice`.execute(handle.db);

    const r = await order({
      branchId: BRANCH,
      warehouseId: STORE_WH,
      externalId: `wc-${suffix}-ghost`,
      lines: [{ sku: `SKU-${suffix}-ghost`, qty: "1", unitPrice: "1000000" }],
      paymentMethod: "gateway",
      paymentRef: `ref-${suffix}-g`,
      paidAmount: "1000000",
    });
    assert.equal(r.statusCode, 422, r.body);

    // ⚠️ هسته این ادعا: **پیش‌نویس نیمه‌کاره جا نماند.** همه‌چیز در یک
    //    تراکنش است؛ اگر روزی جدا شود، اینجا یک فاکتور اضافه می‌ماند
    //    که درآمدش هرگز به دفتر نمی‌رود و کسی دنبالش نمی‌گردد.
    const after_ = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.invoice`.execute(handle.db);
    assert.equal(after_.rows[0]!.n, before.rows[0]!.n, "هیچ فاکتوری جا نماند");
  });

  test("درآمد سفارش سایت همان لحظه به دفتر نمی‌رود", async () => {
    // ADR-003: سند درآمد و COGS کار بستن شبانه دوره کانال است. کالا
    // ولی همان لحظه از انبار خارج شده.
    const unposted = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.unposted_revenue`.execute(handle.db);
    assert.notEqual(unposted.rows[0]!.n, "0", "دوره سایت هنوز باز است");
  });

  // ── خوراک موجودی ────────────────────────────────────────────────

  test("خوراک موجودی عدد در دسترس را می‌دهد", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/web/stock?warehouseId=${STORE_WH}`,
      ...auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as {
      cursor: string | null;
      items: { sku: string; available: string }[];
    };
    const row = body.items.find((i) => i.sku === sku);
    assert.ok(row, "کالای تست در خوراک هست");
    // ۱۰ اولیه منهای ۱ (CSRF) و ۲ و ۱ (موبایل) و ۱ (تکراری) = ۵
    assert.equal(row.available, "5");
    assert.ok(body.cursor, "مکان‌نما برای درخواست بعدی برمی‌گردد");
  });

  test("کالای غیرفعال «صفر» است، نه غایب", async () => {
    await sql`UPDATE catalog.variation SET status = 'archived' WHERE sku = ${sku2}`.execute(
      handle.db,
    );
    const r = await app.inject({
      method: "GET",
      url: `/web/stock?warehouseId=${STORE_WH}`,
      ...auth(),
    });
    const body = JSON.parse(r.body) as { items: { sku: string; available: string }[] };
    const row = body.items.find((i) => i.sku === sku2);
    // ⚠️ اگر از خوراک حذف شود، سایت عدد قبلی‌اش را نگه می‌دارد و
    //    می‌فروشد. «صفر» تنها چیزی است که جلوی فروشِ کالای بایگانی را
    //    می‌گیرد.
    assert.ok(row, "کالای بایگانی از خوراک حذف نمی‌شود");
    assert.equal(row.available, "0");
    await sql`UPDATE catalog.variation SET status = 'active' WHERE sku = ${sku2}`.execute(
      handle.db,
    );
  });
  test("F16: سفارش وب مالیات فعال را در سطر و مبلغ قابل پرداخت حفظ می‌کند", async () => {
    await sql`SELECT platform.set_setting('tax.enabled','true'::jsonb,'Tax regression',${SYSTEM_USER}::uuid)`.execute(handle.db);
    await sql`SELECT platform.set_setting('tax.default_rate','10'::jsonb,'Tax regression',${SYSTEM_USER}::uuid)`.execute(handle.db);
    try {
      const response = await order({ branchId: BRANCH, warehouseId: STORE_WH, externalId: `tax-${suffix}`,
        lines: [{ sku, qty: "1", unitPrice: "2000000" }], paymentMethod: "gateway", paidAmount: "2200000" });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().payableAmount, "2200000");
      const row = await handle.db.selectFrom("sales.invoice_line").select("tax_amount")
        .where("invoice_id", "=", response.json().invoiceId).executeTakeFirstOrThrow();
      assert.equal(row.tax_amount, "200000");
    } finally {
      await sql`SELECT platform.set_setting('tax.enabled','false'::jsonb,'Restore test setting',${SYSTEM_USER}::uuid)`.execute(handle.db);
    }
  });

  test("F23: Woo partial refunds preserve stock, shipping, ledger and replay identity", async () => {
    const externalId = `refund-${suffix}`;
    const created = await order({ branchId: BRANCH, warehouseId: STORE_WH, externalId,
      customerMobile: "09129998877", customerName: "Refund regression",
      lines: [{ sku, qty: "2", unitPrice: "2000000" }], shippingAmount: "100000",
      paymentMethod: "gateway", paidAmount: "4100000", paymentRef: `refund-ref-${suffix}` });
    assert.equal(created.statusCode, 201, created.body);
    const invoiceId = created.json<OrderResponse>().invoiceId;
    const call = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/web/refunds", ...auth(), payload });
    const payload = { orderId: externalId, refundId: `r1-${suffix}`, amount: "2050000",
      shippingAmount: "50000", lines: [{ lineNo: 1, qty: "1", restock: true }] };
    const bad = await call({ ...payload, refundId: `bad-${suffix}`, amount: "100" });
    assert.equal(bad.statusCode, 422, bad.body);
    assert.equal(bad.json().error.code, "refund_amount_mismatch");
    const absent = await handle.db.selectFrom("sales.sale_return").select("id").where("invoice_id", "=", invoiceId).execute();
    assert.equal(absent.length, 0, "a mismatch rolls back stock, payment and journal together");
    const calls = await Promise.all([call(payload), call(payload)]);
    assert.deepEqual(calls.map((r) => r.statusCode).sort(), [200, 201]);
    assert.equal(calls[0]!.json().returnId, calls[1]!.json().returnId);
    const changed = await call({ ...payload, amount: "2050010" });
    assert.equal(changed.statusCode, 409, changed.body);
    const second = await call({ ...payload, refundId: `r2-${suffix}`, lines: [{ lineNo: 1, qty: "1", restock: false }] });
    assert.equal(second.statusCode, 201, second.body);
    const rows = await sql<{ count: string; paid: string; shipping: string; stock: string; cash: string }>`
      SELECT count(*)::text AS count,sum(r.refund_amount)::text AS paid,sum(r.shipping_amount)::text AS shipping,
       (SELECT coalesce(sum(m.qty),0)::text FROM inventory.stock_movement m
         WHERE m.ref_type='sale_return' AND m.ref_id IN (SELECT id FROM sales.sale_return WHERE invoice_id=${invoiceId}::uuid)) AS stock,
       (SELECT coalesce(sum(l.credit),0)::text FROM ledger.journal_line l JOIN ledger.journal_entry e ON e.id=l.entry_id
         WHERE e.ref_id IN (SELECT id FROM sales.sale_return WHERE invoice_id=${invoiceId}::uuid) AND l.account_code='1101') AS cash
      FROM sales.sale_return r WHERE r.invoice_id=${invoiceId}::uuid
    `.execute(handle.db);
    assert.equal(rows.rows[0]!.count, "2");
    assert.equal(BigInt(rows.rows[0]!.paid), 4100000n);
    assert.equal(BigInt(rows.rows[0]!.shipping), 100000n);
    assert.equal(Number(rows.rows[0]!.stock), 1, "the non-restocked unit never comes back into stock");
    assert.equal(BigInt(rows.rows[0]!.cash), 0n, "gateway returns never debit the cash drawer");
    const stockState = await handle.db.selectFrom("sales.invoice").select("status").where("id", "=", invoiceId).executeTakeFirstOrThrow();
    assert.equal(stockState.status, "returned");
    const replay = await call(payload);
    assert.equal(replay.statusCode, 200, replay.body);

    const other = newApiKey();
    const otherUser = await sql<{ id: string }>`INSERT INTO identity.app_user(username,full_name,is_active)
      VALUES(${`other-site-${suffix}`},'Other site',false) RETURNING id`.execute(handle.db);
    const otherId = otherUser.rows[0]!.id;
    await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(${otherId}::uuid,'web',${BRANCH}::uuid)`.execute(handle.db);
    await sql`INSERT INTO identity.api_client(name,user_id,key_hash,created_by)
      VALUES('Other site',${otherId}::uuid,${hashApiKey(other)},${SYSTEM_USER}::uuid)`.execute(handle.db);
    const stolen = await app.inject({ method: "POST", url: "/web/refunds", headers: { authorization: `Bearer ${other}` }, payload });
    assert.equal(stolen.statusCode, 404, "same branch is insufficient to return another site's order");
    const unauthenticated = await app.inject({ method: "POST", url: "/web/refunds", payload });
    assert.equal(unauthenticated.statusCode, 401);
    await sql`UPDATE identity.permission_rule SET allowed=false WHERE role_code='web' AND operation='web.refund'`.execute(handle.db);
    try { assert.equal((await call(payload)).statusCode, 403, "revocation also denies replay"); }
    finally { await sql`UPDATE identity.permission_rule SET allowed=true WHERE role_code='web' AND operation='web.refund'`.execute(handle.db); }
  });

});
