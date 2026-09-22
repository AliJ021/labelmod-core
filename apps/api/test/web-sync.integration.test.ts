import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * دو خوراک همگام‌سازی سایت — و نگهبان حلقه بازگشتی.
 *
 * ── چه چیزی اینجا سنجیده می‌شود ───────────────────────────────────
 *
 * ۱. **کلید اتصال `variationId` است، نه SKU و نه نام.** نام کالا در
 *    سایت و در حسابداری عمداً یکی نیست (تصمیم سئویی مالک) و SKU هم
 *    می‌تواند عوض شود. اگر خوراک `variationId` ندهد، افزونه چاره‌ای
 *    جز تطبیق با SKU ندارد و اولین تغییر SKU اتصال را می‌شکند.
 *
 * ۲. **سفارش سایت به سایت برنمی‌گردد.** خوراک خرید حضوری اگر فاکتور
 *    کانال `web` را هم بدهد، افزونه رکورد تازه می‌سازد و چرخه بسته
 *    می‌شود. نگهبان **در سرور** است، نه فقط در افزونه.
 *
 * ۳. **قیمتِ نبوده، صفر نیست.** کالایی که در آن فهرست قیمت ندارد
 *    باید `null` بگیرد. اگر «۰» می‌گرفت، سایت آن را مجانی می‌فروخت.
 *
 * ۴. **مکان‌نمای مرکب.** دو فاکتور می‌توانند در یک لحظه نهایی شوند؛
 *    مکان‌نمای تک‌ستونی یا یکی‌شان را جا می‌اندازد یا تکرارش می‌کند.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashApiKey, newApiKey } from "../src/auth/api-key.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

interface StockFeed {
  priceList: string;
  cursor: string | null;
  items: Array<{
    variationId: string;
    sku: string;
    available: string;
    price: string | null;
  }>;
}

interface PurchaseFeed {
  cursor: string | null;
  cursorId: string | null;
  items: Array<{
    invoiceId: string;
    number: string | null;
    channel: string;
    customer: { mobile: string | null; name: string | null };
    netAmount: string;
    lines: Array<{ variationId: string; sku: string; name: string; qty: string }>;
  }>;
}

describe("خوراک‌های همگام‌سازی سایت", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `s${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const key = newApiKey();
  const auth = () => ({ headers: { authorization: `Bearer ${key}` } });

  /** نشست یک صندوق‌دار واقعی — مسیر مشتری از راه کوکی می‌رود. */
  const PASSWORD = "رمز-صندوق-همگام‌سازی-و-به‌قدر-کافی-بلند";
  const cashierName = `sync_cash_${Date.now() % 100000}`;
  let cashierCookies: Record<string, string> = {};
  let cashierHeaders: Record<string, string> = {};
  const cashier = () => ({ cookies: cashierCookies, headers: cashierHeaders });

  /** یک پیش‌نویس باز، از همان مسیری که صندوق می‌رود. */
  async function draft(): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/invoices",
      ...cashier(),
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    assert.equal(r.statusCode, 201, r.body);
    return (JSON.parse(r.body) as { id: string }).id;
  }

  /** تنوع قیمت‌دار، و تنوعی که عمداً قیمت ندارد. */
  let pricedId = "";
  let pricelessId = "";
  let pricedSku = "";

  async function stock(query = ""): Promise<StockFeed> {
    const r = await app.inject({
      method: "GET",
      url: `/web/stock?warehouseId=${STORE_WH}${query}`,
      ...auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body) as StockFeed;
  }

  async function purchases(query = ""): Promise<PurchaseFeed> {
    const r = await app.inject({
      method: "GET",
      url: `/web/instore-purchases?branchId=${BRANCH}${query}`,
      ...auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body) as PurchaseFeed;
  }

  /** یک فاکتور نهایی‌شده روی کانال داده‌شده، با مشتری موبایل‌دار. */
  async function invoice(channel: "pos" | "web", mobile: string): Promise<string> {
    const c = await sql<{ id: string }>`
      INSERT INTO sales.customer (mobile_normalized, full_name)
      VALUES (sales.normalize_mobile(${mobile}), 'مشتری تست')
      ON CONFLICT (mobile_normalized) DO UPDATE SET full_name = EXCLUDED.full_name
      RETURNING id`.execute(handle.db);
    const customerId = c.rows[0]!.id;

    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    const inv = await sql<{ id: string }>`
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel,
                                 customer_id, created_by)
      VALUES (${BRANCH}::uuid, ${STORE_WH}::uuid, NULL, ${channel},
              ${customerId}::uuid, ${SYSTEM_USER}::uuid)
      RETURNING id`.execute(handle.db);
    const id = inv.rows[0]!.id;

    await sql`
      INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                      unit_price, discount_amount, net_amount)
      VALUES (${id}::uuid, 1, ${pricedId}::uuid, 1, 2000000, 0, 2000000)
    `.execute(handle.db);
    await sql`SELECT sales.refresh_invoice_totals(${id}::uuid)`.execute(handle.db);
    await sql`
      INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction,
                                    amount, status, occurred_at)
      VALUES (${id}::uuid, NULL, 'cash', 'in', 2000000, 'succeeded', now())
    `.execute(handle.db);
    await sql`SELECT sales.finalize_invoice(${id}::uuid, ${SYSTEM_USER}::uuid)`.execute(
      handle.db,
    );
    return id;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

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
    await handle.db
      .insertInto("identity.user_role")
      .values({ user_id: webUser.id, role_code: "web", branch_id: BRANCH })
      .execute();
    await handle.db
      .insertInto("identity.api_client")
      .values({
        name: "سایت",
        user_id: webUser.id,
        key_hash: hashApiKey(key),
        created_by: SYSTEM_USER,
        note: null,
        last_used_at: null,
      })
      .execute();

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal, name_web)
      VALUES (${`P-${suffix}`}, 'شومیز — انبارداری', 'شومیز ابریشمی زنانه')
      RETURNING id`.execute(handle.db);
    const productId = prod.rows[0]!.id;

    for (const [color, tag] of [["آبی", "a"], ["سبز", "b"]] as const) {
      const code = `SKU-${suffix}-${tag}`;
      const v = await sql<{ id: string }>`
        INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (${productId}, ${color}, 'M', ${code}) RETURNING id`.execute(handle.db);
      const id = v.rows[0]!.id;
      if (tag === "a") {
        pricedId = id;
        pricedSku = code;
        await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
                  VALUES (${id}, 'default', 2000000)`.execute(handle.db);
      } else {
        // عمداً بدون قیمت.
        pricelessId = id;
      }
      await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
      await sql`SELECT inventory.apply_movement(
                  ${id}::uuid, ${STORE_WH}::uuid, 10, 'purchase_receipt',
                  'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${SYSTEM_USER}::uuid, 800000)`.execute(handle.db);
    }

    const u = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: cashierName,
        full_name: "صندوق‌دار همگام‌سازی",
        password_hash: await hashSecret(PASSWORD),
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

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    const login = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      remoteAddress: "10.11.0.5",
      payload: {
        username: cashierName,
        password: PASSWORD,
        deviceFingerprint: `fp-sync-${suffix}`,
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const csrf = login.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    cashierCookies = {
      labelmod_session:
        login.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
      labelmod_csrf: csrf,
    };
    cashierHeaders = { "x-csrf-token": csrf };

    // فروش صندوق بدون شیفت باز ممکن نیست — و همان نگهبانی است که
    // مغایرت کاذب کشو را جلوگیری می‌کند.
    const shift = await app.inject({
      method: "POST",
      url: "/shifts",
      cookies: cashierCookies,
      headers: cashierHeaders,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, openingCash: "0" },
    });
    assert.ok(shift.statusCode < 300, shift.body);
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  // ── خوراک موجودی و قیمت ─────────────────────────────────────────

  test("خوراک، کلید اتصال می‌دهد — نه فقط SKU", async () => {
    const feed = await stock();
    const row = feed.items.find((i) => i.variationId === pricedId);
    assert.ok(row, "کالا باید با شناسه تنوع پیدا شود");
    assert.equal(row.sku, pricedSku, "SKU هم می‌آید، برای اتصال اولیه");
  });

  test("قیمت از فهرست قیمت می‌آید، به‌شکل رشته", async () => {
    const feed = await stock();
    const row = feed.items.find((i) => i.variationId === pricedId);
    // پول در JSON **رشته** است، نه عدد — مبالغ ریالی سریع از دقت
    // `number` جاوااسکریپت رد می‌شوند.
    assert.equal(row?.price, "2000000");
    assert.equal(typeof row?.price, "string");
  });

  test("کالای بی‌قیمت `null` می‌گیرد، نه صفر", async () => {
    // اگر «۰» می‌گرفت، سایت آن را **مجانی** می‌فروخت. `null` یعنی
    // «قیمت ندارد» و افزونه باید ردش کند.
    const feed = await stock();
    const row = feed.items.find((i) => i.variationId === pricelessId);
    assert.equal(row?.price, null);
  });

  test("فهرست قیمت دیگر، قیمت دیگری می‌دهد", async () => {
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${pricedId}::uuid, 'online', 1800000)`.execute(handle.db);
    const feed = await stock("&priceList=online");
    assert.equal(feed.priceList, "online");
    assert.equal(feed.items.find((i) => i.variationId === pricedId)?.price, "1800000");
    // و فهرست پیش‌فرض دست‌نخورده مانده.
    const dflt = await stock();
    assert.equal(dflt.items.find((i) => i.variationId === pricedId)?.price, "2000000");
  });

  // ── خوراک خرید حضوری ────────────────────────────────────────────

  test("خرید حضوری با مشتری موبایل‌دار می‌آید", async () => {
    const id = await invoice("pos", "09121110000");
    const feed = await purchases();
    const row = feed.items.find((i) => i.invoiceId === id);
    assert.ok(row, "فاکتور حضوری باید در خوراک باشد");
    assert.equal(row.channel, "pos");
    assert.equal(row.customer.mobile, "09121110000");
    assert.equal(row.netAmount, "2000000");
    assert.equal(row.lines.length, 1);
    assert.equal(row.lines[0]?.variationId, pricedId);
  });

  test("نام مشتری‌پسند می‌رود، نه نام انبارداری", async () => {
    const feed = await purchases();
    const row = feed.items[0];
    assert.equal(row?.lines[0]?.name, "شومیز ابریشمی زنانه");
  });

  test("سفارش سایت به سایت برنمی‌گردد — نگهبان حلقه", async () => {
    // **ادعای مرکزی.** بدون این، افزونه برای سفارشی که خودش فرستاده
    // یک رکورد تازه می‌سازد و چرخه بسته می‌شود.
    const webId = await invoice("web", "09121110001");
    const feed = await purchases();
    assert.ok(
      !feed.items.some((i) => i.invoiceId === webId),
      "فاکتور کانال web نباید در خوراک باشد",
    );
    assert.ok(
      feed.items.every((i) => i.channel !== "web"),
      "هیچ سطری نباید کانال web داشته باشد",
    );
  });

  test("فروش ناشناس نمی‌آید — حسابی برای چسباندنش نیست", async () => {
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    const inv = await sql<{ id: string }>`
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel,
                                 customer_id, created_by)
      VALUES (${BRANCH}::uuid, ${STORE_WH}::uuid, NULL, 'pos', NULL,
              ${SYSTEM_USER}::uuid)
      RETURNING id`.execute(handle.db);
    const id = inv.rows[0]!.id;
    await sql`
      INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                      unit_price, discount_amount, net_amount)
      VALUES (${id}::uuid, 1, ${pricedId}::uuid, 1, 2000000, 0, 2000000)
    `.execute(handle.db);
    await sql`SELECT sales.refresh_invoice_totals(${id}::uuid)`.execute(handle.db);
    await sql`
      INSERT INTO treasury.payment (invoice_id, shift_id, method_code, direction,
                                    amount, status, occurred_at)
      VALUES (${id}::uuid, NULL, 'cash', 'in', 2000000, 'succeeded', now())
    `.execute(handle.db);
    await sql`SELECT sales.finalize_invoice(${id}::uuid, ${SYSTEM_USER}::uuid)`.execute(
      handle.db,
    );

    const feed = await purchases();
    assert.ok(!feed.items.some((i) => i.invoiceId === id));
  });

  test("پیش‌نویس نمی‌آید — هنوز خریدی نشده", async () => {
    const c = await sql<{ id: string }>`
      INSERT INTO sales.customer (mobile_normalized, full_name)
      VALUES (sales.normalize_mobile('09121110002'), 'مشتری پیش‌نویس')
      RETURNING id`.execute(handle.db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    const inv = await sql<{ id: string }>`
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel,
                                 customer_id, created_by)
      VALUES (${BRANCH}::uuid, ${STORE_WH}::uuid, NULL, 'pos',
              ${c.rows[0]!.id}::uuid, ${SYSTEM_USER}::uuid)
      RETURNING id`.execute(handle.db);
    const feed = await purchases();
    assert.ok(!feed.items.some((i) => i.invoiceId === inv.rows[0]!.id));
  });

  test("مکان‌نما همان‌جا که ماند ادامه می‌دهد", async () => {
    const first = await purchases("&limit=1");
    assert.equal(first.items.length, 1);
    assert.ok(first.cursor && first.cursorId, "مکان‌نما باید هر دو بخش را بدهد");

    const next = await purchases(
      `&limit=50&since=${encodeURIComponent(first.cursor)}&sinceId=${first.cursorId}`,
    );
    assert.ok(
      !next.items.some((i) => i.invoiceId === first.items[0]?.invoiceId),
      "سطری که آمده دوباره نمی‌آید",
    );
  });

  test("مکان‌نمای مرکب، فاکتورهای هم‌لحظه را جا نمی‌اندازد", async () => {
    // دو فاکتور با **دقیقاً** یک `finalized_at`. مکان‌نمای تک‌ستونی
    // با `>` دومی را برای همیشه رد می‌کرد.
    const ids: string[] = [];
    for (const m of ["09121110010", "09121110011"]) ids.push(await invoice("pos", m));
    await sql`
      UPDATE sales.invoice SET finalized_at = timestamptz '2030-01-01 10:00:00+00'
       WHERE id = ANY(${ids}::uuid[])
    `.execute(handle.db);

    const page = await purchases(
      `&limit=1&since=${encodeURIComponent("2029-12-31T00:00:00.000000Z")}`,
    );
    assert.equal(page.items.length, 1);
    const rest = await purchases(
      `&limit=50&since=${encodeURIComponent(page.cursor as string)}&sinceId=${page.cursorId}`,
    );
    const seen = new Set([page.items[0]!.invoiceId, ...rest.items.map((i) => i.invoiceId)]);
    for (const id of ids) {
      assert.ok(seen.has(id), "هر دو فاکتور هم‌لحظه باید دیده شوند");
    }
  });

  // ── دامنه و مجوز ────────────────────────────────────────────────

  test("بدون کلید، هیچ خوراکی باز نیست", async () => {
    for (const url of [
      `/web/stock?warehouseId=${STORE_WH}`,
      `/web/instore-purchases?branchId=${BRANCH}`,
    ]) {
      const r = await app.inject({ method: "GET", url });
      assert.equal(r.statusCode, 401, `${url}: ${r.body}`);
    }
  });

  test("شعبه بیرون از دامنه کلید، ۴۰۳ می‌گیرد", async () => {
    const other = "00000000-0000-7000-8000-0000000009ff";
    const r = await app.inject({
      method: "GET",
      url: `/web/instore-purchases?branchId=${other}`,
      ...auth(),
    });
    assert.ok(r.statusCode === 403 || r.statusCode === 404, r.body);
  });

  // ── چسباندن مشتری از پای صندوق ──────────────────────────────────

  test("شماره تکراری مشتری دوم نمی‌سازد — و همان خرید به سایت می‌رود", async () => {
    // **ادعای مرکزی این بخش.** نرمال‌سازی و یکتایی هر دو در دیتابیس‌اند.
    // اگر در TypeScript تکرار می‌شدند، مشتری‌ای که یک بار آنلاین و یک
    // بار حضوری خرید کند دو حساب پیدا می‌کرد و سابقه‌اش گم می‌شد.
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer`.execute(handle.db);

    // همان شماره، سه شکل مختلف — از جمله ارقام فارسی.
    for (const form of ["09129998888", "9129998888", "۰۹۱۲۹۹۹۸۸۸۸"]) {
      const inv = await draft();
      const r = await app.inject({
        method: "PATCH",
        url: `/invoices/${inv}/customer`,
        ...cashier(),
        payload: { mobile: form },
      });
      assert.equal(r.statusCode, 200, `${form}: ${r.body}`);
      assert.ok((JSON.parse(r.body) as { customerId: string | null }).customerId);
    }

    const after = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer`.execute(handle.db);
    assert.equal(
      Number(after.rows[0]!.n) - Number(before.rows[0]!.n),
      1,
      "سه شکل از یک شماره، یک مشتری",
    );
  });

  test("شماره بی‌معنا مشتری نمی‌سازد", async () => {
    const inv = await draft();
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${inv}/customer`,
      ...cashier(),
      payload: { mobile: "سلام" },
    });
    assert.equal(JSON.parse(r.body).error.code, "bad_mobile", r.body);
  });

  test("چسباندن مشتری، فاکتور نهایی‌شده را دست نمی‌زند", async () => {
    // Snapshot لحظه فروش تغییرناپذیر است. اگر مشتری پس از نهایی‌شدن
    // عوض می‌شد، خریدی که به سایت رفته بود به حساب کسِ دیگری هم
    // می‌چسبید — و آن رکورد در سایت پاک نمی‌شود.
    const finalized = await invoice("pos", "09121113333");
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${finalized}/customer`,
      ...cashier(),
      payload: { mobile: "09121114444" },
    });
    assert.ok(r.statusCode >= 400, r.body);
  });

  test("شماره خالی مشتری نمی‌سازد", async () => {
    const inv = await draft();
    const r = await app.inject({
      method: "PATCH",
      url: `/invoices/${inv}/customer`,
      ...cashier(),
      payload: { mobile: "   " },
    });
    assert.ok(r.statusCode >= 400 && r.statusCode < 500, r.body);
  });
});
