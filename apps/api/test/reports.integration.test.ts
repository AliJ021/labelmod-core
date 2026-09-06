/**
 * تست یکپارچه گزارش‌ها — روی پستگرس واقعی.
 *
 * تست SQL ثابت می‌کند اعداد درست‌اند. این پرونده چیز دیگری می‌سنجد که
 * فقط با راندن مسیر واقعی دیده می‌شود:
 *
 *   **کدام کاربر چه می‌بیند، و آنچه نمی‌بیند چگونه غایب است.**
 *
 * دو شکست بی‌صدا که اینجا قفل می‌شوند:
 *
 * ۱. حذف `?branchId` از URL. توابع دیتابیس `NULL` را «همه شعبه‌ها»
 *    می‌فهمند؛ مسیری که پارامتر نداشتِ کلاینت را مستقیم بدهد، دامنه
 *    شعبه را با یک حذف کاراکتر باز می‌کند.
 *
 * ۲. ستون بها برای کسی که `cost.view` ندارد. اگر صفر برگردد، سرپرست
 *    فکر می‌کند سود صفر بوده — یک ادعای مالی دروغ. باید `null` باشد.
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

interface SalesRow {
  businessDate: string;
  channel: string;
  netAmount: string;
  grossAmount: string;
  cogsAmount: string | null;
  profitAmount: string | null;
}

describe("گزارش‌ها", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `r${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-گزارش-و-به‌قدر-کافی-بلند";
  const admin = `radm_${suffix}`;
  const supervisor = `rsup_${suffix}`;
  const cashier = `rcash_${suffix}`;
  let adminId = "";
  let variationId = "";
  let today = "";

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

  const get = async (username: string, url: string) =>
    await app.inject({ method: "GET", url, ...(await loginAs(username)) });

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر گزارش", "admin"],
      [supervisor, "سرپرست گزارش", "supervisor"],
      [cashier, "صندوق‌دار گزارش", "cashier"],
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
      if (role === "admin") adminId = u.id;
    }

    // یک فروش واقعی، تا گزارش‌ها چیزی برای نشان‌دادن داشته باشند.
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${adminId}::uuid)`.execute(trx);
      const prod = await sql<{ id: string }>`
        INSERT INTO catalog.product (code, name_internal)
        VALUES (${`P-${suffix}`}, 'کالای گزارش') RETURNING id`.execute(trx);
      const v = await sql<{ id: string }>`
        INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (${prod.rows[0]!.id}, 'سبز', 'XL', ${`SKU-${suffix}`}) RETURNING id`
        .execute(trx);
      variationId = v.rows[0]!.id;
      await sql`SELECT catalog.set_price(${variationId}::uuid, 1000000)`.execute(trx);
      await sql`SELECT inventory.apply_movement(
                  ${variationId}::uuid, ${STORE_WH}::uuid, 20, 'purchase_receipt',
                  NULL, NULL, ${adminId}::uuid, 400000)`.execute(trx);
    });

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    const s = await loginAs(admin);
    const shift = await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
    assert.equal(shift.statusCode, 201, shift.body);

    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const invoiceId = (JSON.parse(inv.body) as { id: string }).id;

    const line = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "2" },
    });
    assert.equal(line.statusCode, 201, line.body);

    const pay = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "2000000" },
    });
    assert.equal(pay.statusCode, 201, pay.body);

    const fin = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
      payload: {},
    });
    assert.equal(fin.statusCode, 200, fin.body);

    const rep = await app.inject({
      method: "GET",
      url: `/reports/daily?branchId=${BRANCH}`,
      ...s,
    });
    // «امروز» را از **سرور** می‌گیریم، نه از ساعت این ماشین.
    today = (JSON.parse(rep.body) as { businessDate: string }).businessDate;
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("مدیر فروش دوره را با بها و سود می‌بیند", async () => {
    const r = await get(admin, `/reports/sales?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as { rows: SalesRow[] }).rows;
    assert.equal(rows.length, 1, r.body);
    const row = rows[0] as SalesRow;
    assert.equal(row.netAmount, "2000000");
    assert.equal(row.cogsAmount, "800000");
    assert.equal(row.profitAmount, "1200000");
    assert.equal(row.channel, "pos");
  });

  test("سرپرست همان فروش را می‌بیند، ولی بها و سود null است — نه صفر", async () => {
    // **ادعای مرکزی.** صفر یعنی «سود نداشتی»؛ null یعنی «اجازه دیدنش
    // را نداری». یکی‌کردنشان یعنی سرپرست فکر کند فروشگاه ضرر کرده.
    const r = await get(supervisor, `/reports/sales?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const row = (JSON.parse(r.body) as { rows: SalesRow[] }).rows[0] as SalesRow;
    assert.equal(row.netAmount, "2000000", "فروش را می‌بیند");
    assert.equal(row.cogsAmount, null, "بها برداشته شده، نه صفر شده");
    assert.equal(row.profitAmount, null, "سود هم همین‌طور");
  });

  test("صندوق‌دار اصلاً گزارش نمی‌بیند", async () => {
    const r = await get(cashier, `/reports/sales?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal((JSON.parse(r.body) as { error: { code: string } }).error.code, "deny");
  });

  test("سود کالا کلاً پشت cost.view است", async () => {
    const ok = await get(admin, `/reports/profit-by-product?from=${today}&to=${today}`);
    assert.equal(ok.statusCode, 200, ok.body);
    const rows = (JSON.parse(ok.body) as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.profitAmount, "1200000");
    assert.equal(rows[0]?.marginPercent, 60);

    const no = await get(supervisor, `/reports/profit-by-product?from=${today}&to=${today}`);
    assert.equal(no.statusCode, 403, "سرپرست سود کالا را نمی‌بیند");
  });

  test("ارزش موجودی پشت cost.view است و از stock_balance می‌آید", async () => {
    const r = await get(admin, `/reports/inventory-valuation?warehouseId=${STORE_WH}`);
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as { rows: Array<Record<string, unknown>> }).rows;
    const mine = rows.find((x) => x.variationId === variationId);
    assert.ok(mine, "کالای تست در ارزش‌گذاری هست");
    assert.equal(mine?.onHand, "18.000", "۲۰ خرید منهای ۲ فروش");
    assert.equal(mine?.unitCost, "400000");

    const no = await get(supervisor, `/reports/inventory-valuation?warehouseId=${STORE_WH}`);
    assert.equal(no.statusCode, 403);
  });

  test("کاردکس بدون cost.view تعداد را می‌دهد و بها را نه", async () => {
    const url = `/reports/stock-movements?variationId=${variationId}&from=${today}&to=${today}`;
    const ok = await get(admin, url);
    assert.equal(ok.statusCode, 200, ok.body);
    const rows = (JSON.parse(ok.body) as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows.length, 2, "یک ورود، یک خروج");
    assert.equal(rows[0]?.unitCost, "400000");

    const sup = await get(supervisor, url);
    assert.equal(sup.statusCode, 200, sup.body);
    const supRows = (JSON.parse(sup.body) as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(supRows[0]?.runningQty, "20.000", "تعداد را می‌بیند");
    assert.equal(supRows[0]?.unitCost, null, "بها را نه");
    assert.equal(supRows[0]?.valueDelta, null);
  });

  test("تراز آزمایشی متوازن است و از همین مسیر هم متوازن می‌ماند", async () => {
    const r = await get(admin, `/reports/trial-balance?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as {
      rows: Array<{ debit: string; credit: string; openingBalance: string; closingBalance: string }>;
    }).rows;
    const dr = rows.reduce((n, x) => n + BigInt(x.debit), 0n);
    const cr = rows.reduce((n, x) => n + BigInt(x.credit), 0n);
    assert.equal(dr, cr, "بدهکار و بستانکار برابرند");
    for (const x of rows) {
      assert.equal(
        BigInt(x.closingBalance),
        BigInt(x.openingBalance) + BigInt(x.debit) - BigInt(x.credit),
        "مانده پایان = مانده اول + گردش",
      );
    }
  });

  test("مغایرت‌گیری نقد شیفت باز را هم نشان می‌دهد", async () => {
    const r = await get(admin, `/reports/cash-reconciliation?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.cashSales, "2000000");
    assert.equal(rows[0]?.status, "open");
    // شیفت باز هنوز شمرده نشده — `null` است، نه صفر.
    assert.equal(rows[0]?.countedCash, null);
    assert.equal(rows[0]?.variance, null);
  });

  test("بازه وارونه ۴۰۰ می‌گیرد، نه جدول خالی", async () => {
    const r = await get(admin, `/reports/sales?from=${today}&to=2020-01-01`);
    assert.equal(r.statusCode, 400, r.body);
  });

  test("شعبه‌ای که مال این کاربر نیست، ۴۰۳", async () => {
    const other = "00000000-0000-7000-8000-0000000009ff";
    const r = await get(supervisor, `/reports/sales?from=${today}&to=${today}&branchId=${other}`);
    assert.equal(r.statusCode, 403, r.body);
  });

  test("کاربرِ یک‌شعبه‌ای بدون branchId هم فقط شعبه خودش را می‌گیرد", async () => {
    // حذف `?branchId` نباید دامنه را باز کند: سرور خودش شعبه کاربر را
    // می‌گذارد. بدون این، یک کاراکتر کمتر در URL یعنی دیدن شعبه دیگر.
    const r = await get(supervisor, `/reports/sales?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const withBranch = await get(
      supervisor,
      `/reports/sales?from=${today}&to=${today}&branchId=${BRANCH}`,
    );
    assert.equal(r.body, withBranch.body, "با و بدون شعبه، همان نتیجه");
  });

  test("دریافتنی و پرداختنی از تفصیلی سند می‌آید", async () => {
    const r = await get(admin, "/reports/party-balances?partyType=supplier");
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as { rows: Array<{ partyType: string }> }).rows;
    for (const x of rows) assert.equal(x.partyType, "supplier", "فیلتر نوع شخص کار می‌کند");
  });

  // ── خروجی CSV ───────────────────────────────────────────────────

  test("CSV از همان مسیر می‌آید و BOM دارد", async () => {
    const r = await get(admin, `/reports/sales?from=${today}&to=${today}&format=csv`);
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers["content-type"] as string, /text\/csv/);
    // بدون BOM، اکسل ویندوز فارسی را نامفهوم نشان می‌دهد.
    assert.equal(r.body.codePointAt(0), 0xfeff, "BOM باید اولین نویسه باشد");
    assert.ok(r.body.includes("فروش ناخالص (ریال)"), r.body.slice(0, 200));
    assert.ok(r.body.includes("2000000"), "مبلغ باید در فایل باشد");
  });

  test("هدر دانلود نام فارسی و ASCII هر دو را می‌دهد", async () => {
    const r = await get(admin, `/reports/sales?from=${today}&to=${today}&format=csv`);
    const cd = r.headers["content-disposition"] as string;
    assert.match(cd, /attachment;/);
    assert.match(cd, /filename="sales\.csv"/);
    assert.match(cd, /filename\*=UTF-8''/);
    // فایل مالی نباید در حافظه پنهان بماند.
    assert.equal(r.headers["cache-control"], "no-store");
  });

  test("CSV همان چیزی را می‌دهد که JSON می‌دهد — نه بیشتر", async () => {
    // **ادعای مرکزی.** اگر CSV مسیر جدایی داشت، دروازه‌هایش دیر یا زود
    // از مسیر JSON عقب می‌ماندند — و آن همان است که دور زده می‌شود.
    // سرپرست `cost.view` ندارد، پس ستون بها و سود باید در فایل هم
    // **خالی** باشند، نه صفر و نه عدد واقعی.
    const json = await get(supervisor, `/reports/sales?from=${today}&to=${today}`);
    const rows = (JSON.parse(json.body) as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows[0]?.cogsAmount, null, "JSON باید بها را پوشانده باشد");

    const csv = await get(supervisor, `/reports/sales?from=${today}&to=${today}&format=csv`);
    assert.equal(csv.statusCode, 200, csv.body);
    const line = csv.body.trim().split("\r\n").at(-1) ?? "";
    // دو ستون آخر بها و سودند و باید خالی باشند.
    assert.ok(line.endsWith(",,"), `دو ستون آخر باید خالی باشند: ${line}`);
    assert.ok(!line.includes("800000"), "بهای واقعی نباید در فایل باشد");
  });

  test("CSV بدون مجوز هم بسته است", async () => {
    // مجوز **پیش از** تصمیم قالب سنجیده می‌شود.
    const r = await get(supervisor, `/reports/profit-by-product?from=${today}&to=${today}&format=csv`);
    assert.equal(r.statusCode, 403, "سرپرست سود کالا را در CSV هم نمی‌بیند");
    assert.ok(!(r.headers["content-type"] as string).includes("csv"), "پاسخ خطا CSV نیست");
  });

  test("قالب ناشناخته رد می‌شود، نه اینکه JSON فرض شود", async () => {
    const r = await get(admin, `/reports/sales?from=${today}&to=${today}&format=xlsx`);
    assert.equal(r.statusCode, 400, r.body);
  });

  test("هر هشت گزارش CSV می‌دهند", async () => {
    // کد حساب از **قاعده ثبت** گرفته می‌شود، نه Hardcode: کدینگ حساب
    // یک تصمیم باز است و در جدول می‌نشیند، نه در کد. گزارش دفتر هم
    // برای حسابی که گردش ندارد باید ۲۰۰ با جدول خالی بدهد، نه خطا.
    const acc = await sql<{ code: string }>`
      SELECT account_code AS code FROM ledger.posting_rule LIMIT 1
    `.execute(handle.db);
    const code = acc.rows[0]?.code;
    assert.ok(code, "قاعده ثبت باید حساب داشته باشد");

    // گزارشی که خروجی CSV نداشته باشد، همان است که حسابدار دستی
    // رونویسی‌اش می‌کند.
    const urls = [
      `/reports/sales?from=${today}&to=${today}`,
      `/reports/profit-by-product?from=${today}&to=${today}`,
      `/reports/inventory-valuation?warehouseId=${STORE_WH}`,
      `/reports/stock-movements?variationId=${variationId}&from=${today}&to=${today}`,
      `/reports/trial-balance?from=${today}&to=${today}`,
      `/reports/party-balances`,
      `/reports/cash-reconciliation?from=${today}&to=${today}`,
      `/reports/account-ledger?code=${code}&from=${today}&to=${today}`,
      `/reports/hourly?from=${today}&to=${today}`,
      `/reports/compare?from=${today}&to=${today}&prevFrom=${today}&prevTo=${today}`,
    ];
    for (const u of urls) {
      const r = await get(admin, `${u}${u.includes("?") ? "&" : "?"}format=csv`);
      assert.equal(r.statusCode, 200, `${u}: ${r.body.slice(0, 150)}`);
      assert.match(r.headers["content-type"] as string, /text\/csv/, u);
      assert.equal(r.body.codePointAt(0), 0xfeff, `${u} بدون BOM`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // پنل مدیریتی
  // ═══════════════════════════════════════════════════════════════════

  test("گزارش ساعتی، ساعت را از دیتابیس می‌دهد نه از کلاینت", async () => {
    const r = await get(admin, `/reports/hourly?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const rows = JSON.parse(r.body).rows as { hourOfDay: number; netAmount: string }[];
    assert.ok(rows.length > 0, "فروش امروز باید ساعتی هم دیده شود");
    for (const x of rows) {
      assert.ok(Number.isInteger(x.hourOfDay) && x.hourOfDay >= 0 && x.hourOfDay <= 23,
        `ساعت نامعتبر: ${x.hourOfDay}`);
      // پول رشته است، نه عدد — همان قاعده هر مبلغ دیگری.
      assert.equal(typeof x.netAmount, "string", "مبلغ باید رشته باشد");
    }
  });

  test("مقایسه دوره، هر دو بازه را از کلاینت می‌گیرد", async () => {
    const r = await get(
      admin,
      `/reports/compare?from=${today}&to=${today}&prevFrom=2020-01-01&prevTo=2020-01-31`,
    );
    assert.equal(r.statusCode, 200, r.body);
    const rows = JSON.parse(r.body).rows as {
      netAmount: string; prevNetAmount: string; deltaPercent: number | null; direction: string;
    }[];
    const pos = rows.find((x) => x.direction === "up");
    assert.ok(pos, "فروش امروز در برابر بازه خالی باید رشد باشد");
    assert.equal(pos.prevNetAmount, "0");
    // رشد از صفر درصد ندارد. اگر روزی کسی `?? 0` بگذارد، مالک
    // «۰٪ رشد» می‌بیند در حالی که از هیچ به فروش رسیده.
    assert.equal(pos.deltaPercent, null, "رشد از صفر نباید درصد داشته باشد");
  });

  test("دوره مبنای وارونه ۴۰۰ می‌گیرد", async () => {
    const r = await get(
      admin,
      `/reports/compare?from=${today}&to=${today}&prevFrom=2020-02-01&prevTo=2020-01-01`,
    );
    assert.equal(r.statusCode, 400, r.body);
  });

  test("مقایسه بدون cost.view سود را null می‌دهد، نه صفر", async () => {
    const r = await get(
      supervisor,
      `/reports/compare?from=${today}&to=${today}&prevFrom=${today}&prevTo=${today}`,
    );
    assert.equal(r.statusCode, 200, r.body);
    const rows = JSON.parse(r.body).rows as { profitAmount: string | null }[];
    assert.ok(rows.length > 0);
    for (const x of rows) assert.equal(x.profitAmount, null, "سود باید پوشانده شود");
  });

  test("تحلیل سبد فقط برای مدیر است — سرپرست ۴۰۳ می‌گیرد", async () => {
    // این یک شرط در کد نیست: `report.customer_insight` در Seed فقط
    // به admin داده شده. مالک می‌تواند از صفحه «مجوزها» عوضش کند.
    const ok = await get(admin, `/reports/basket?from=${today}&to=${today}`);
    assert.equal(ok.statusCode, 200, ok.body);
    const no = await get(supervisor, `/reports/basket?from=${today}&to=${today}`);
    assert.equal(no.statusCode, 403, no.body);
    const nope = await get(cashier, `/reports/basket?from=${today}&to=${today}`);
    assert.equal(nope.statusCode, 403, nope.body);
  });

  test("خرید هر مشتری هم پشت همان دروازه است", async () => {
    const ok = await get(admin, `/reports/customer-basket?from=${today}&to=${today}`);
    assert.equal(ok.statusCode, 200, ok.body);
    const no = await get(supervisor, `/reports/customer-basket?from=${today}&to=${today}`);
    assert.equal(no.statusCode, 403, no.body);
  });

  test("تحلیل سبد، فاکتور بی‌شماره را «یک مشتری» نمی‌شمارد", async () => {
    const r = await get(admin, `/reports/basket?from=${today}&to=${today}`);
    assert.equal(r.statusCode, 200, r.body);
    const rows = JSON.parse(r.body).rows as {
      invoiceCount: number; knownCustomers: number; anonymousCount: number;
    }[];
    assert.ok(rows.length > 0);
    for (const x of rows) {
      assert.ok(x.knownCustomers + x.anonymousCount <= x.invoiceCount,
        "مشتری شناخته + بی‌شماره نباید از تعداد فاکتور بیشتر شود");
    }
  });

  test("CSV تحلیل سبد هم از همان مسیر و با BOM می‌آید", async () => {
    for (const u of [
      `/reports/basket?from=${today}&to=${today}`,
      `/reports/customer-basket?from=${today}&to=${today}`,
    ]) {
      const r = await get(admin, `${u}&format=csv`);
      assert.equal(r.statusCode, 200, `${u}: ${r.body.slice(0, 150)}`);
      assert.match(r.headers["content-type"] as string, /text\/csv/, u);
      assert.equal(r.body.codePointAt(0), 0xfeff, `${u} بدون BOM`);
    }
  });
});
