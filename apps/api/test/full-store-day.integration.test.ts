/**
 * «یک روز کامل فروشگاه» — تست مرجع End-to-End (بخش ۸٫۷ ممیزی).
 *
 * ── چرا این پرونده از بقیه فرق دارد ────────────────────────────────
 *
 * بقیهٔ تست‌های یکپارچه هر ماژول را **جدا** می‌سنجند. این یکی تعامل
 * آن‌ها را می‌سنجد: همان چیزی که در عمل می‌شکند. یک روز واقعی فروشگاه
 * از باز کردن شیفت تا بستن دورهٔ کانال سایت، **از راه HTTP** — نه با
 * صدا زدن توابع SQL — چون دروازه‌های واقعی در لایهٔ API‌اند:
 *
 *   • `markdown-gate` سقف کاهش قیمت را می‌سنجد (صندوق و سایت، یک تعریف)
 *   • `treasury-routes` شیفت را از **شعبه** می‌گیرد، نه از کاربر
 *   • `return-routes` بازپرداخت نقدی را به شیفت باز گره می‌زند
 *   • `report-routes` دامنهٔ شعبه را تعیین می‌کند
 *
 * تستی که این‌ها را با SQL دور بزند، همان چیزی را نمی‌سنجد که کاربر
 * واقعی از آن می‌گذرد.
 *
 * ── و چرا تطبیق پایانی در یک پروندهٔ SQL جداست ─────────────────────
 *
 * `db/reconcile/full-day.sql` دوازده تطبیق مستقل می‌راند و **دو بار**
 * اجرا می‌شود: یک بار روی دیتابیس زنده، و یک بار روی دیتابیسی که از
 * **بکاپ** برگردانده شده. بکاپی که تطبیق‌هایش را پاس نکند، بکاپ نیست —
 * بند ۴ SECURITY.md.
 *
 * آن پرونده عمداً **در `db/test/` نیست**: `ops/db.sh test` هر
 * `db/test/*.sql` را روی دیتابیس **خالی** اجرا می‌کند و یک تطبیقِ
 * فقط‌خواندنی آنجا بی‌معنا سبز می‌شد. بند ۰ خودش هم ضد‌پوچی دارد.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { hashApiKey } from "../src/auth/api-key.ts";
import { makeEan13 } from "../src/catalog/barcode.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const RECONCILE = path.join(REPO_ROOT, "db/reconcile/full-day.sql");

const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const BACK_WH = "00000000-0000-7000-8000-000000000102";
const BANK = "00000000-0000-7000-8000-000000000202";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

/**
 * اجرای تطبیق روی یک دیتابیس؛ **stdout و stderr هر دو** برگردانده
 * می‌شوند.
 *
 * ⚠️ psql هر `RAISE NOTICE` را روی **stderr** می‌نویسد، نه stdout. با
 *    گرفتنِ فقط stdout، خروجی این تابع همیشه فقط
 *    «BEGIN / CREATE FUNCTION / DO / ROLLBACK» بود — یعنی هر ادعایی روی
 *    متنِ تطبیق بی‌صدا ناموفق می‌شد، و بدتر: ادعایی که دنبال یک رشتهٔ
 *    **منفی** بگردد، پوچ سبز می‌شد. کد خروج تنها دروازهٔ واقعی است
 *    (`ON_ERROR_STOP=1`) و متن، شاهدِ آن.
 */
function reconcile(url: string): string {
  const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-d", url, "-f", RECONCILE], {
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`تطبیق رد شد (کد ${r.status}):\n${out}`);
  return out;
}

describe("یک روز کامل فروشگاه", { skip, timeout: 300_000 }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `d${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-روز-کامل-و-به‌قدر-کافی-بلند";
  const admin = `admin_${suffix}`;
  const cashier = `cashier_${suffix}`;
  const supervisor = `sup_${suffix}`;
  const apiKey = `lmk_${randomBytes(24).toString("base64url")}`;

  /** وضعیت روز — هر مرحله چیزی به آن اضافه می‌کند. */
  const day: Record<string, string> = {};
  let variationA = "";
  let variationB = "";
  let barcodeA = "";
  let skuA = "";
  let supplierId = "";
  let customerId = "";

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

  /** `inject` با کلید Idempotency تازه — هر مرحله یک هویت. */
  async function call(
    method: "POST" | "PUT" | "PATCH" | "GET" | "DELETE",
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

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 8);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر روز کامل", "admin"],
      [cashier, "صندوق‌دار روز کامل", "cashier"],
      [supervisor, "سرپرست روز کامل", "supervisor"],
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

    // کاربر پشتی سایت + کلید ماشینی — همان چیزی که create-api-client می‌سازد
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
        name: "سایت لیبل مد",
        user_id: webUser.id,
        key_hash: hashApiKey(apiKey),
        created_by: SYSTEM_USER,
        note: null,
        last_used_at: null,
      })
      .execute();

    // کالا با دو تنوع، **بدون موجودی اولیه**: موجودی فقط از رسید خرید
    // امروز می‌آید، تا بقای تعداد و ارزش در یک چرخهٔ کامل قابل تطبیق
    // بماند (بند ۵۶ الحاقیه).
    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'مانتو روز کامل') RETURNING id`.execute(handle.db);
    // بارکد واقعی EAN-13 با پیشوند ۲۰ — «BC-…» بارکد نیست و صفحهٔ
    // برچسب رقم کنترل را حساب می‌کند، پس رشتهٔ دلخواه آنجا ۵۰۰ می‌دهد.
    const serialBase = Number(String(Date.now()).slice(-8));
    for (const [color, size, tag, serial] of [
      ["مشکی", "M", "a", serialBase],
      ["مشکی", "L", "b", serialBase + 1],
    ] as const) {
      const v = await sql<{ id: string }>`
        INSERT INTO catalog.variation (product_id, color, size, sku, barcode)
        VALUES (${prod.rows[0]!.id}, ${color}, ${size},
                ${`SKU-${suffix}-${tag}`}, ${makeEan13(serial)})
        RETURNING id`.execute(handle.db);
      if (tag === "a") {
        variationA = v.rows[0]!.id;
        barcodeA = makeEan13(serial);
        skuA = `SKU-${suffix}-a`;
      } else variationB = v.rows[0]!.id;
      await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
                VALUES (${v.rows[0]!.id}, 'default', 4000000)`.execute(handle.db);
    }

    const sup = await sql<{ id: string }>`
      INSERT INTO purchasing.supplier (code, name)
      VALUES (${`S-${suffix}`}, ${`تأمین‌کننده ${suffix}`}) RETURNING id`.execute(handle.db);
    supplierId = sup.rows[0]!.id;

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

  // ── ۰۸:۰۰ ─────────────────────────────────────────────────────────
  test("۰۸:۰۰ شیفت صندوق با موجودی اولیه باز می‌شود", async () => {
    const r = await call("POST", "/shifts", cashier, {
      branchId: BRANCH,
      openingCash: "5000000",
    });
    assert.equal(r.statusCode, 201, r.body);
    day.shift = (r.json() as { id: string }).id;

    // و دو کشوی باز ممکن نیست — وگرنه شمارش صندوق ابهام دارد
    const again = await call("POST", "/shifts", cashier, {
      branchId: BRANCH,
      openingCash: "0",
    });
    assert.equal(again.statusCode, 409, `شیفت دوم باید رد شود: ${again.body}`);
  });

  // ── ۰۸:۳۰ ─────────────────────────────────────────────────────────
  test("۰۸:۳۰ رسید خرید: دو نرخ برای یک کالا + هزینه حمل با تخصیص", async () => {
    const draft = await call("POST", "/receipts", admin, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      supplierId,
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const id = (draft.json() as { id: string }).id;
    day.receipt = id;

    // همان کالا، دو نرخ → **دو سطر**، نه یک سطر تجمیعی
    await call("POST", `/receipts/${id}/lines`, admin, {
      variationId: variationA,
      qty: "10",
      unitPrice: "2000000",
    });
    await call("POST", `/receipts/${id}/lines`, admin, {
      variationId: variationA,
      qty: "10",
      unitPrice: "2400000",
    });
    await call("POST", `/receipts/${id}/lines`, admin, {
      variationId: variationB,
      qty: "10",
      unitPrice: "2200000",
    });

    const mid = await call("GET", `/receipts/${id}`, admin);
    const lines = (mid.json() as { lines: unknown[] }).lines;
    assert.equal(lines.length, 3, `دو نرخ باید دو سطر بماند: ${mid.body}`);

    // هزینه حمل، تخصیص بر مبنای ارزش → به بهای کالا می‌رود
    const ch = await call("POST", `/receipts/${id}/charges`, admin, {
      chargeType: "حمل",
      amount: "6600000",
      allocation: "by_value",
      paidFrom: "payable",
      payeeType: "other",
      payeeName: "باربری روز کامل",
    });
    assert.equal(ch.statusCode, 201, ch.body);

    const posted = await call("POST", `/receipts/${id}/post`, admin, {}, `rcpt-${suffix}`);
    assert.equal(posted.statusCode, 200, posted.body);
    assert.match((posted.json() as { number: string }).number, /^P-\d{4}-\d{6}$/);

    // تعداد در انبار: ۳۰ قلم
    const q = await sql<{ n: string }>`
      SELECT coalesce(sum(on_hand),0)::text AS n FROM inventory.stock_balance
       WHERE warehouse_id = ${STORE_WH}::uuid`.execute(handle.db);
    assert.equal(Number(q.rows[0]!.n), 30, "۳۰ قلم باید در قفسه باشد");

    // و هزینه حمل واقعاً روی بها نشست.
    //
    // ⚠️ عدد را **hardcode نمی‌کنیم** و این یک درس از خودِ همین اجراست:
    // اولین نسخه انتظار «کالا + حمل» داشت و ۷۷٬۰۰۰٬۰۰۰ دید نه
    // ۷۲٬۶۰۰٬۰۰۰. علتش نقص نبود — روش پیش‌فرض `last_purchase` است و هر
    // رسید تازه **کل موجودی همان کالا** را به نرخ خودش تجدید ارزیابی
    // می‌کند (ADR-006). پس ادعا باید همان چیزی باشد که قاعده می‌گوید:
    //   • ارزش انبار = جمع `value_delta` حرکات (بقای ارزش)
    //   • بیشتر از بهای خالی کالا (حمل واقعاً نشسته)
    //   • و تجدید ارزیابی **حرکت با تعداد صفر** است، نه تغییر تعداد
    const v = await sql<{ v: string }>`
      SELECT coalesce(sum(total_value),0)::text AS v FROM inventory.stock_balance`
      .execute(handle.db);
    const mv = await sql<{ v: string }>`
      SELECT coalesce(sum(value_delta),0)::text AS v FROM inventory.stock_movement`
      .execute(handle.db);
    assert.equal(v.rows[0]!.v, mv.rows[0]!.v, "ارزش انبار = جمع value_delta");
    assert.ok(
      Number(v.rows[0]!.v) > 10 * 2000000 + 10 * 2400000 + 10 * 2200000,
      `حمل باید روی بها نشسته باشد: ${v.rows[0]!.v}`,
    );

    const reval = await sql<{ c: string; q: string }>`
      SELECT count(*)::text AS c, coalesce(sum(abs(qty)),0)::text AS q
        FROM inventory.stock_movement WHERE kind = 'revaluation'`.execute(handle.db);
    assert.ok(Number(reval.rows[0]!.c) > 0, "روش last_purchase باید تجدید ارزیابی بزند");
    assert.equal(Number(reval.rows[0]!.q), 0, "تجدید ارزیابی تعداد را عوض نمی‌کند");

    // و دفتر با انبار می‌خواند — تفاوت تجدید ارزیابی سرفصل ۵۱۰۲ گرفته
    const lc = await sql<{ d: string }>`SELECT diff::text AS d FROM inventory.ledger_check`
      .execute(handle.db);
    assert.equal(Number(lc.rows[0]!.d), 0, "دفتر باید با ارزش انبار بخواند");
  });

  // ── ۰۹:۰۰ ─────────────────────────────────────────────────────────
  test("۰۹:۰۰ برچسب و بارکد EAN-13 داخلی چاپ می‌شود", async () => {
    const r = await call("POST", "/labels", admin, {
      items: [
        { variationId: variationA, count: 2 },
        { variationId: variationB, count: 1 },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers["content-type"] as string, /text\/html/);
    // پیشوند ۲۰ — محدودهٔ «گردش محدود در یک شرکت» در GS1
    assert.match(r.body, /20\d{11}/, "بارکد داخلی باید با ۲۰ شروع شود");
    // و CSP این صفحه جاوااسکریپت را کامل می‌بندد. ⚠️ با `script-src`
    // نمی‌بندد، با `default-src 'none'` می‌بندد — و همان کافی است، چون
    // `script-src` غایب به `default-src` برمی‌گردد. ادعا نباید شکل را
    // بسنجد، باید **اثر** را بسنجد: هیچ مسیری برای اجرای اسکریپت.
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/, csp);
    assert.doesNotMatch(csp, /script-src (?!'none')/, `script-src باز است: ${csp}`);
    assert.doesNotMatch(r.body, /<script/i, "صفحه برچسب اصلاً اسکریپت لازم ندارد");
  });

  // ── ۱۰:۰۰ ─────────────────────────────────────────────────────────
  test("۱۰:۰۰ فروش حضوری نقدی", async () => {
    const inv = await call("POST", "/invoices", cashier, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      channel: "pos",
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const id = (inv.json() as { id: string }).id;

    const line = await call("POST", `/invoices/${id}/lines`, cashier, {
      barcode: barcodeA,
      qty: "2",
    });
    assert.equal(line.statusCode, 201, line.body);

    const view = await call("GET", `/invoices/${id}`, cashier);
    const payable = (view.json() as { payableAmount: string }).payableAmount;
    assert.equal(payable, "8000000", `قیمت باید از دیتابیس بیاید: ${view.body}`);

    await call("POST", `/invoices/${id}/payments`, cashier, {
      methodCode: "cash",
      amount: payable,
    });
    const fin = await call("POST", `/invoices/${id}/finalize`, cashier, {}, `inv-cash-${suffix}`);
    assert.equal(fin.statusCode, 200, fin.body);
    day.invCash = id;
  });

  // ── ۱۰:۱۵ ─────────────────────────────────────────────────────────
  test("۱۰:۱۵ فروش با پرداخت ترکیبی: نقد + کارت", async () => {
    const cust = await call("POST", "/customers", admin, {
      mobile: "09121110001",
      fullName: "مشتری روز کامل",
    });
    assert.equal(cust.statusCode, 201, cust.body);
    customerId = (cust.json() as { id: string }).id;

    const inv = await call("POST", "/invoices", cashier, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      channel: "pos",
      customerId,
    });
    const id = (inv.json() as { id: string }).id;
    await call("POST", `/invoices/${id}/lines`, cashier, { variationId: variationB, qty: "3" });

    const view = await call("GET", `/invoices/${id}`, cashier);
    const payable = BigInt((view.json() as { payableAmount: string }).payableAmount);
    assert.equal(payable, 12000000n);

    // نقد + کارت — و جمعشان باید **دقیقاً** مبلغ فاکتور باشد
    await call("POST", `/invoices/${id}/payments`, cashier, {
      methodCode: "cash",
      amount: "5000000",
    });
    const card = await call("POST", `/invoices/${id}/payments`, cashier, {
      methodCode: "card",
      amount: "7000000",
      refNo: `POS-${suffix}`,
    });
    assert.equal(card.statusCode, 201, card.body);

    const fin = await call("POST", `/invoices/${id}/finalize`, cashier, {}, `inv-mix-${suffix}`);
    assert.equal(fin.statusCode, 200, fin.body);
    day.invMix = id;

    // کارت پول نقد نیست: نباید در انتظار نقد شیفت بیاید
    const cash = await sql<{ v: string }>`
      SELECT coalesce(sum(p.amount),0)::text AS v FROM treasury.payment p
       WHERE p.shift_id = ${day.shift}::uuid AND p.method_code = 'card'
         AND p.status = 'succeeded'`.execute(handle.db);
    assert.equal(Number(cash.rows[0]!.v), 7000000, "پرداخت کارت باید ثبت شود");
  });

  // ── ۱۰:۳۰ و ۱۰:۳۵ ─────────────────────────────────────────────────
  test("۱۰:۳۰ قیمت دستی زیر سقف بدون دلیل، ۱۰:۳۵ بالای سقف با دلیل", async () => {
    // ⚠️ فاکتور صندوق به شیفتِ **خودِ کاربر** می‌چسبد و این درست است:
    // کسی که می‌فروشد همان کسی است که کشو دستش است. پس صندوق‌دار
    // فاکتور را می‌زند — مدیر شیفتی ندارد و ۴۲۲ می‌گرفت.
    const inv = await call("POST", "/invoices", cashier, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      channel: "pos",
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const id = (inv.json() as { id: string }).id;
    const l1 = await call("POST", `/invoices/${id}/lines`, cashier, {
      variationId: variationA,
      qty: "1",
    });
    assert.equal(l1.statusCode, 201, l1.body);
    // ⚠️ این Endpoint **کل فاکتور** را برمی‌گرداند، نه سطر تازه را.
    const lineId = (l1.json() as { lines: Array<{ id: string }> }).lines.at(-1)!.id;

    // و قیمت دستی مجوز جدا دارد: `sale.price_override` را صندوق‌دار
    // ندارد. سرپرست می‌آید و قیمت را عوض می‌کند.
    const byCashier = await call("PATCH", `/invoices/${id}/lines/${lineId}/price`, cashier, {
      unitPrice: "3700000",
    });
    assert.equal(byCashier.statusCode, 403, `صندوق‌دار نباید قیمت را عوض کند: ${byCashier.body}`);

    // زیر سقف ثبت دلیل (۱۰٪): ۴٬۰۰۰٬۰۰۰ → ۳٬۷۰۰٬۰۰۰ یعنی ۷٫۵٪
    const ok = await call("PATCH", `/invoices/${id}/lines/${lineId}/price`, supervisor, {
      unitPrice: "3700000",
    });
    assert.equal(ok.statusCode, 200, `کاهش زیر سقف باید بی‌دلیل بنشیند: ${ok.body}`);

    // بالای سقف **بدون** دلیل → رد
    const bad = await call("PATCH", `/invoices/${id}/lines/${lineId}/price`, supervisor, {
      unitPrice: "3000000",
    });
    assert.equal(bad.statusCode, 409, `کاهش ۲۵٪ بی‌دلیل باید رد شود: ${bad.body}`);

    // همان کاهش **با** دلیل → می‌نشیند
    const good = await call("PATCH", `/invoices/${id}/lines/${lineId}/price`, supervisor, {
      unitPrice: "3000000",
      priceOverrideReason: "کالای نمایشگاهی با لک جزئی",
    });
    assert.equal(good.statusCode, 200, good.body);

    // فاکتور **یک** قیمت نشان می‌دهد: قیمت تازه در unit_price، فهرست در
    // list_price — نه به‌شکل تخفیف، وگرنه دو قیمت روی فاکتور می‌خورد.
    const snap = await sql<{ up: string; lp: string | null; disc: string }>`
      SELECT unit_price::text AS up, list_price::text AS lp, discount_amount::text AS disc
        FROM sales.invoice_line WHERE id = ${lineId}::uuid`.execute(handle.db);
    assert.equal(snap.rows[0]!.up, "3000000");
    assert.equal(snap.rows[0]!.lp, "4000000", "قیمت فهرست باید Snapshot لحظه اول بماند");
    assert.equal(snap.rows[0]!.disc, "0", "قیمت دستی تخفیف نیست");

    const view = await call("GET", `/invoices/${id}`, cashier);
    await call("POST", `/invoices/${id}/payments`, cashier, {
      methodCode: "cash",
      amount: (view.json() as { payableAmount: string }).payableAmount,
    });
    const fin = await call("POST", `/invoices/${id}/finalize`, cashier, {}, `inv-md-${suffix}`);
    assert.equal(fin.statusCode, 200, fin.body);
    day.invMarkdown = id;
  });

  // ── ۱۱:۰۰ و ۱۱:۳۰ ─────────────────────────────────────────────────
  test("۱۱:۰۰ سفارش سایت با قیمت سایت، ۱۱:۳۰ همان Webhook دوباره", async () => {
    const payload = {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      externalId: `wc-${suffix}`,
      lines: [{ sku: skuA, qty: "1", unitPrice: "3800000" }],
      paymentMethod: "gateway",
      paymentRef: `gw-${suffix}`,
      paidAmount: "3800000",
      customerMobile: "09121110002",
    };
    const first = await app.inject({
      method: "POST",
      url: "/web/orders",
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    });
    assert.equal(first.statusCode, 201, first.body);
    const body1 = first.json() as { invoiceId: string; replayed?: boolean };
    day.invWeb = body1.invoiceId;

    // قیمت سایت واقعاً ثبت شد (نه قیمت جاری کاتالوگ) و از دروازه گذشت
    const snap = await sql<{ up: string; reason: string | null }>`
      SELECT unit_price::text AS up, price_override_reason AS reason
        FROM sales.invoice_line WHERE invoice_id = ${body1.invoiceId}::uuid`.execute(handle.db);
    assert.equal(snap.rows[0]!.up, "3800000", "قیمت سایت باید همان باشد که مشتری دید");

    // همان سفارش دوباره → Replay، نه فاکتور دوم
    const second = await app.inject({
      method: "POST",
      url: "/web/orders",
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    });
    assert.equal(second.statusCode, 200, second.body);
    const body2 = second.json() as { invoiceId: string; replayed: boolean };
    assert.equal(body2.invoiceId, body1.invoiceId, "همان فاکتور، نه فاکتور دوم");
    assert.equal(body2.replayed, true);

    const n = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM sales.invoice WHERE channel = 'web'`.execute(handle.db);
    assert.equal(Number(n.rows[0]!.c), 1, "یک سفارش سایت، یک فاکتور");
  });

  // ── ۱۲:۰۰ و ۱۲:۳۰ ─────────────────────────────────────────────────
  test("۱۲:۰۰ مرجوعی داخل مهلت با بهای همان فروش، ۱۲:۳۰ خارج از مهلت رد", async () => {
    const view = await call("GET", `/invoices/${day.invCash}/returnable`, supervisor);
    assert.equal(view.statusCode, 200, view.body);
    const lineId = (view.json() as { lines: Array<{ invoiceLineId: string }> }).lines[0]!
      .invoiceLineId;

    // بهای Snapshot شدهٔ همان فروش — مرجع مستقل برای ادعای COGS
    const cost = await sql<{ c: string }>`
      SELECT unit_cost::text AS c FROM sales.invoice_line WHERE id = ${lineId}::uuid`
      .execute(handle.db);

    const draft = await call("POST", "/returns", supervisor, {
      invoiceId: day.invCash,
      reasonCode: "size_small",
      refundAmount: "4000000",
      refundMethod: "cash",
      lines: [{ invoiceLineId: lineId, qty: "1" }],
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const rid = (draft.json() as { id: string }).id;
    const posted = await call("POST", `/returns/${rid}/post`, supervisor, {}, `ret-${suffix}`);
    assert.equal(posted.statusCode, 200, posted.body);
    day.return = rid;

    // بهای برگشتی = بهای همان فروش، نه میانگین جاری انبار
    const rc = await sql<{ c: string }>`
      SELECT cogs_amount::text AS c FROM sales.sale_return WHERE id = ${rid}::uuid`
      .execute(handle.db);
    assert.equal(rc.rows[0]!.c, cost.rows[0]!.c, "بهای مرجوعی باید بهای همان فروش باشد");

    // و بازپرداخت نقدی به شیفت باز چسبید — وگرنه شمارش کشو مغایرت کاذب
    const pay = await sql<{ s: string | null }>`
      SELECT shift_id::text AS s FROM treasury.payment
       WHERE return_id = ${rid}::uuid`.execute(handle.db);
    assert.equal(pay.rows[0]!.s, day.shift, "بازپرداخت نقدی باید shift_id داشته باشد");

    // ── خارج از مهلت: فاکتور را ۷۲ ساعت به عقب می‌بریم ──────────────
    // چرا این کار مجاز است: `returnWindow` از `finalized_at` می‌خواند و
    // ما فاکتوری **واقعاً قدیمی** را شبیه‌سازی می‌کنیم، نه اینکه
    // نگهبانی را خاموش کنیم. مهلت ۴۸ ساعت است.
    await sql`UPDATE sales.invoice
                 SET finalized_at = finalized_at - interval '72 hours',
                     occurred_at  = occurred_at  - interval '72 hours'
               WHERE id = ${day.invMix}::uuid`.execute(handle.db);

    const oldView = await call("GET", `/invoices/${day.invMix}/returnable`, cashier);
    assert.equal((oldView.json() as { late: boolean }).late, true, "باید «دیرهنگام» باشد");

    const lateLine = (oldView.json() as { lines: Array<{ invoiceLineId: string }> }).lines[0]!
      .invoiceLineId;
    const late = await call("POST", "/returns", cashier, {
      invoiceId: day.invMix,
      reasonCode: "changed_mind",
      refundAmount: "0",
      lines: [{ invoiceLineId: lateLine, qty: "1" }],
    });
    assert.equal(late.statusCode, 403, `صندوق‌دار نباید مرجوعی دیرهنگام بزند: ${late.body}`);

    // و تاریخ را برمی‌گردانیم تا تطبیق روزِ پایانی یک روز بماند
    await sql`UPDATE sales.invoice
                 SET finalized_at = finalized_at + interval '72 hours',
                     occurred_at  = occurred_at  + interval '72 hours'
               WHERE id = ${day.invMix}::uuid`.execute(handle.db);
  });

  // ── ۱۳:۰۰ ─────────────────────────────────────────────────────────
  test("۱۳:۰۰ چک دریافت می‌شود و تا وصول پول نیست", async () => {
    const chq = await call("POST", "/cheques", admin, {
      direction: "received",
      branchId: BRANCH,
      chequeNo: `${Date.now() % 1000000}`,
      bankName: "ملت",
      amount: "20000000",
      issuedOn: "2026-06-01",
      dueOn: "2026-08-01",
      partyType: "customer",
      partyId: customerId,
      drawerName: "خریدار عمده",
    });
    assert.equal(chq.statusCode, 201, chq.body);
    const id = (chq.json() as { id: string }).id;
    day.cheque = id;

    await call("POST", `/cheques/${id}/events`, admin, { action: "receive" });

    // در دست، نه در صندوق: حساب ۱۱۰۱ نباید تکان بخورد
    const inHand = await sql<{ s: string }>`
      SELECT status AS s FROM treasury.cheque WHERE id = ${id}::uuid`.execute(handle.db);
    assert.equal(inHand.rows[0]!.s, "in_hand");

    await call("POST", `/cheques/${id}/events`, admin, { action: "deposit", accountId: BANK });
    const cleared = await call("POST", `/cheques/${id}/events`, admin, {
      action: "clear",
      accountId: BANK,
    });
    assert.equal(cleared.statusCode, 200, cleared.body);

    const st = await sql<{ s: string }>`
      SELECT status AS s FROM treasury.cheque WHERE id = ${id}::uuid`.execute(handle.db);
    assert.equal(st.rows[0]!.s, "cleared");

    // `status` یک Projection است: UPDATE مستقیم رویش باید رد شود
    await assert.rejects(
      () =>
        sql`UPDATE treasury.cheque SET status = 'bounced' WHERE id = ${id}::uuid`.execute(
          handle.db,
        ),
      /وضعیت|رویداد|status/,
      "UPDATE مستقیم روی وضعیت چک باید رد شود",
    );
  });

  // ── ۱۴:۰۰ ─────────────────────────────────────────────────────────
  test("۱۴:۰۰ انتقال بین دو انبار، با ارزش ثابت", async () => {
    const before = await sql<{ v: string }>`
      SELECT coalesce(sum(total_value),0)::text AS v FROM inventory.stock_balance`
      .execute(handle.db);

    const t = await call("POST", "/transfers", admin, {
      branchId: BRANCH,
      fromWarehouseId: STORE_WH,
      toWarehouseId: BACK_WH,
    });
    assert.equal(t.statusCode, 201, t.body);
    const id = (t.json() as { id: string }).id;
    await call("POST", `/transfers/${id}/lines`, admin, { variationId: variationB, qty: "4" });
    const posted = await call("POST", `/transfers/${id}/post`, admin, {}, `tr-${suffix}`);
    assert.equal(posted.statusCode, 200, posted.body);
    day.transfer = id;

    const after = await sql<{ v: string }>`
      SELECT coalesce(sum(total_value),0)::text AS v FROM inventory.stock_balance`
      .execute(handle.db);
    assert.equal(after.rows[0]!.v, before.rows[0]!.v, "انتقال ارزش کل را عوض نمی‌کند");

    // و سندی نمی‌زند: هر دو انبار به همان حساب ۱۳۰۱ می‌خورند
    const entries = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM ledger.journal_entry
       WHERE ref_type = 'transfer' AND ref_id = ${id}::uuid`
      .execute(handle.db);
    assert.equal(Number(entries.rows[0]!.c), 0, "انتقال بین انبار سند نمی‌زند");
  });

  // ── ۱۵:۰۰ ─────────────────────────────────────────────────────────
  test("۱۵:۰۰ انبارگردانی جزئی: کالای نشمرده صفر نمی‌شود", async () => {
    const beforeB = await sql<{ n: string }>`
      SELECT coalesce(sum(on_hand),0)::text AS n FROM inventory.stock_balance
       WHERE variation_id = ${variationB}::uuid`.execute(handle.db);

    const sheet = await call("POST", "/stock-counts", admin, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
    });
    assert.equal(sheet.statusCode, 201, sheet.body);
    const id = (sheet.json() as { id: string; systemQty?: unknown }).id;
    day.count = id;

    // برگه تازه موجودی سیستم را **نشان نمی‌دهد** — وگرنه انباردار
    // تأیید می‌کند، نه می‌شمارد
    const view = await call("GET", `/stock-counts/${id}`, admin);
    const vLines = (view.json() as { lines: Array<{ systemQty: unknown }> }).lines;
    assert.ok(
      vLines.every((l) => l.systemQty === null || l.systemQty === undefined),
      `موجودی سیستم پیش از ثبت نباید دیده شود: ${view.body}`,
    );

    // فقط تنوع A شمرده می‌شود — یک قلم کم
    const actualA = await sql<{ n: string }>`
      SELECT coalesce(sum(on_hand),0)::text AS n FROM inventory.stock_balance
       WHERE variation_id = ${variationA}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);
    await call("PUT", `/stock-counts/${id}/lines`, admin, {
      barcode: barcodeA,
      countedQty: String(Number(actualA.rows[0]!.n) - 1),
    });

    const posted = await call("POST", `/stock-counts/${id}/post`, admin, {}, `sc-${suffix}`);
    assert.equal(posted.statusCode, 200, posted.body);

    // تنوع B شمرده نشد → دست‌نخورده، نه صفر
    const afterB = await sql<{ n: string }>`
      SELECT coalesce(sum(on_hand),0)::text AS n FROM inventory.stock_balance
       WHERE variation_id = ${variationB}::uuid`.execute(handle.db);
    assert.equal(afterB.rows[0]!.n, beforeB.rows[0]!.n, "کالای نشمرده نباید صفر شود");
  });

  // ── ۱۶:۰۰ ─────────────────────────────────────────────────────────
  test("۱۶:۰۰ فروش آفلاین: همان Idempotency-Key دو فاکتور نمی‌سازد", async () => {
    // صف آفلاین مرورگر، درخواستی را که سرور **قبولش می‌کرد** با همان
    // کلید دوباره می‌فرستد. ادعا: اثر یکی است.
    const inv = await call("POST", "/invoices", cashier, {
      branchId: BRANCH,
      warehouseId: STORE_WH,
      channel: "pos",
    });
    const id = (inv.json() as { id: string }).id;
    await call("POST", `/invoices/${id}/lines`, cashier, { variationId: variationA, qty: "1" });
    const view = await call("GET", `/invoices/${id}`, cashier);
    await call("POST", `/invoices/${id}/payments`, cashier, {
      methodCode: "cash",
      amount: (view.json() as { payableAmount: string }).payableAmount,
    });

    const key = `offline-${suffix}`;
    const a = await call("POST", `/invoices/${id}/finalize`, cashier, {}, key);
    assert.equal(a.statusCode, 200, a.body);
    const b = await call("POST", `/invoices/${id}/finalize`, cashier, {}, key);
    assert.equal(b.statusCode, 200, b.body);

    const mv = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM inventory.stock_movement
       WHERE kind = 'sale' AND ref_id = ${id}::uuid`.execute(handle.db);
    assert.equal(Number(mv.rows[0]!.c), 1, "Replay نباید حرکت انبار دوم بسازد");
    day.invOffline = id;
  });

  // ── ۱۷:۰۰ ─────────────────────────────────────────────────────────
  test("۱۷:۰۰ برگشت از خرید: تفاوت unit_price و landed_unit_cost زیان است", async () => {
    const view = await call("GET", `/receipts/${day.receipt}/returnable`, admin);
    assert.equal(view.statusCode, 200, view.body);
    const rl = (view.json() as {
      lines: Array<{ receiptLineId: string; unitPrice: string; landedUnitCost: string }>;
    }).lines[0]!;

    // مرجع مستقل: تفاوت باید به حساب زیان برود، نه در بدهی گم شود
    const diff = (BigInt(rl.landedUnitCost) - BigInt(rl.unitPrice)) * 2n;
    assert.ok(diff > 0n, "با هزینه حمل، بهای دفتری باید از قیمت فاکتور بیشتر باشد");

    const pr = await call("POST", "/purchase-returns", admin, {
      receiptId: day.receipt,
      reasonCode: "quality",
      lines: [{ receiptLineId: rl.receiptLineId, qty: "2" }],
    });
    assert.equal(pr.statusCode, 201, pr.body);
    day.purchaseReturn = (pr.json() as { id: string }).id;

    const loss = await sql<{ l: string }>`
      SELECT charge_loss::text AS l FROM purchasing.purchase_return
       WHERE id = ${day.purchaseReturn}::uuid`.execute(handle.db);
    assert.equal(
      loss.rows[0]!.l,
      diff.toString(),
      "حملِ کالای پس‌فرستاده باید زیان باشد، نه چیزی گم‌شده",
    );
  });

  // ── ۱۸:۰۰ ─────────────────────────────────────────────────────────
  test("۱۸:۰۰ بستن شیفت با شمارش کشو", async () => {
    // شمارش مستقل: موجودی اول + نقد دریافتی − بازپرداخت نقدی
    const calc = await sql<{ v: string }>`
      SELECT (s.opening_cash + coalesce((
               SELECT sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END)
                 FROM treasury.payment p
                 JOIN treasury.payment_method m ON m.code = p.method_code
                WHERE p.shift_id = s.id AND p.status = 'succeeded' AND m.kind = 'cash'
             ), 0))::text AS v
        FROM sales.cash_shift s WHERE s.id = ${day.shift}::uuid`.execute(handle.db);

    // ⚠️ `shift.close` را **صندوق‌دار ندارد** (Seed: admin و supervisor).
    // با صندوق‌دار ۴۰۳ می‌گیرد — و این ادعا هم سنجیده می‌شود.
    const denied = await call("POST", `/shifts/${day.shift}/close`, cashier, {
      countedCash: calc.rows[0]!.v,
    });
    assert.equal(denied.statusCode, 403, `صندوق‌دار نباید شیفت ببندد: ${denied.body}`);

    const r = await call("POST", `/shifts/${day.shift}/close`, supervisor, {
      countedCash: calc.rows[0]!.v,
    });
    assert.equal(r.statusCode, 200, r.body);
    const closed = r.json() as { expectedCash: string; variance: string };
    assert.equal(closed.expectedCash, calc.rows[0]!.v, "انتظار باید با شمارش مستقل بخواند");
    assert.equal(closed.variance, "0", "شمارش درست یعنی مغایرت صفر");
  });

  // ── ۲۳:۵۹ ─────────────────────────────────────────────────────────
  test("۲۳:۵۹ دوره کانال سایت بسته می‌شود و درآمد به دفتر می‌رود", async () => {
    const unposted = await call("GET", "/posting-batches/unposted", admin);
    assert.equal(unposted.statusCode, 200, unposted.body);
    assert.ok(
      (unposted.json() as { rows: unknown[] }).rows.length > 0,
      `پیش از بستن، درآمد سایت باید ثبت‌نشده باشد: ${unposted.body}`,
    );

    const date = await sql<{ d: string }>`
      SELECT platform.business_date()::text AS d`.execute(handle.db);
    const closed = await call("POST", "/posting-batches/close-channel-day", admin, {
      branchId: BRANCH,
      channel: "web",
      date: date.rows[0]!.d,
    });
    assert.equal(closed.statusCode, 200, closed.body);
    const cb = closed.json() as { saleEntry: string | null; cogsEntry: string | null };
    assert.ok(cb.saleEntry, "سند فروش باید زده شود");
    assert.ok(cb.cogsEntry, "سند بهای تمام‌شده باید زده شود");

    // و دوره امروزِ کانال صندوق با شمردن کشو بسته شد، پس حالا
    // هیچ درآمدی نباید بیرون از دفتر بماند
    const left = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM sales.unposted_revenue`.execute(handle.db);
    assert.equal(Number(left.rows[0]!.c), 0, `درآمد ثبت‌نشده باقی ماند`);
  });

  // ── تطبیق پایانی ──────────────────────────────────────────────────
  test("تطبیق پایانی: دوازده بند مستقل روی دیتابیس زنده", () => {
    const out = reconcile(disposable!.url);
    assert.match(out, /تطبیق پایانی: همه بندها پاس/, out.slice(-3000));
    // و ضد‌پوچی واقعاً کار کرد
    assert.match(out, /فاکتور غیرپیش‌نویس = \d+ \(≥ 5\)/, "بند ضد‌پوچی اجرا نشد");
  });

  // ── بعد: عوض‌کردن روش قیمت تمام‌شده ───────────────────────────────
  test("عوض‌کردن costing.method سود گذشته را بازنویسی نمی‌کند", async () => {
    const date = await sql<{ d: string }>`SELECT platform.business_date()::text AS d`
      .execute(handle.db);
    const before = await sql<{ p: string; s: string }>`
      SELECT profit_amount::text AS p, sales_amount::text AS s
        FROM sales.daily_summary(${BRANCH}::uuid, ${date.rows[0]!.d}::date)`
      .execute(handle.db);

    // روش پیش‌فرض تصمیم مالک است (`last_purchase`)؛ اینجا فقط عوضش
    // می‌کنیم تا ثابت شود **گذشته** تکان نمی‌خورد.
    // ⚠️ بی **دلیل** ثبت نمی‌شود: `costing.method` تصویب مسئول مالی
    //    می‌خواهد. این خودش یک ادعا است، نه یک مانع.
    const noReason = await call("PATCH", "/settings/costing.method", admin, {
      value: "moving_weighted_average",
    });
    assert.equal(noReason.statusCode, 409, `تغییر بی‌دلیل باید رد شود: ${noReason.body}`);

    const r = await call("PATCH", "/settings/costing.method", admin, {
      value: "moving_weighted_average",
      reason: "آزمون ممیزی — سنجش اینکه سود گذشته بازنویسی نمی‌شود",
    });
    assert.equal(r.statusCode, 200, r.body);

    // تغییر تنظیم مالی باید با مقدار **پیش و پس** در حسابرسی بنشیند —
    // نه فقط «عوض شد».
    const audit = await sql<{ before: string | null; after: string | null; reason: string | null }>`
      SELECT before->>'value' AS before, after->>'value' AS after, reason
        FROM platform.audit_log
       WHERE action = 'setting.change' AND entity_id = 'costing.method'
       ORDER BY id DESC LIMIT 1`.execute(handle.db);
    const row = audit.rows[0];
    assert.ok(row, "تغییر تنظیم باید در audit_log بنشیند");
    assert.equal(row.before, "last_purchase", "مقدار پیش باید ثبت شود");
    assert.equal(row.after, "moving_weighted_average", "مقدار پس باید ثبت شود");
    assert.ok((row.reason ?? "").length > 0, "دلیل باید ثبت شود");

    // و سود روزِ گذشته **همان** است: بها در `invoice_line.unit_cost`
    // Snapshot شده و از قیمت جاری خوانده نمی‌شود (بند ۲۰ الحاقیه).
    const after = await sql<{ p: string; s: string }>`
      SELECT profit_amount::text AS p, sales_amount::text AS s
        FROM sales.daily_summary(${BRANCH}::uuid, ${date.rows[0]!.d}::date)`
      .execute(handle.db);
    assert.equal(after.rows[0]!.p, before.rows[0]!.p, "سود گذشته نباید عوض شود");
    assert.equal(after.rows[0]!.s, before.rows[0]!.s, "فروش گذشته نباید عوض شود");

    // و هیچ سطر فاکتوری بازنویسی نشد
    const recon = reconcile(disposable!.url);
    assert.match(recon, /تطبیق پایانی: همه بندها پاس/, recon.slice(-2000));

    // برگردانده می‌شود تا حالت دیتابیس برای مرحله بکاپ همان باشد که
    // مالک تصویب کرده
    const back = await call("PATCH", "/settings/costing.method", admin, {
      value: "last_purchase",
      reason: "بازگرداندن به روش تصویب‌شدهٔ مالک",
    });
    assert.equal(back.statusCode, 200, back.body);
  });

  // ── بکاپ، Restore، و تطبیق دوباره ─────────────────────────────────
  test("بکاپ گرفته، در دیتابیس تازه برگردانده، و همه تطبیق‌ها دوباره", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lmc-day-"));
    const dump = path.join(dir, "day.sql");
    const restored = `labelmod_restore_${randomBytes(5).toString("hex")}`;
    const adminUrl = DATABASE_URL as string;
    const restoredUrl = (() => {
      const u = new URL(adminUrl);
      u.pathname = `/${restored}`;
      return u.toString();
    })();

    const psql = (url: string, arg: string[]) =>
      execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", url, ...arg], {
        stdio: "pipe",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      });

    try {
      // ⚠️ بکاپ با نقش **مالک** گرفته می‌شود، نه با نقش برنامه — و این
      // یک واقعیت استقرار است نه یک راحتیِ تست: `pg_dump` روی
      // `public.schema_migration` هم `LOCK TABLE` می‌زند و نقش برنامه
      // آنجا حقی ندارد. اگر روزی `DATABASE_URL` بکاپ را هم به نقش
      // برنامه عوض کنند، همین خطا را می‌گیرند. docs/DEPLOYMENT.md.
      execFileSync("pg_dump", ["--no-owner", "--no-privileges", "-f", dump, disposable!.ownerUrl], {
        stdio: "pipe",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      });
      psql(adminUrl, ["-c", `CREATE DATABASE "${restored}"`]);
      psql(restoredUrl, ["-f", dump]);

      // ادعای صحت Restore: همان تطبیق‌ها، روی دیتابیسی که از فایل آمده
      const out = reconcile(restoredUrl);
      assert.match(out, /تطبیق پایانی: همه بندها پاس/, out.slice(-3000));

      // و شمار رکوردهای کلیدی یکی است — وگرنه Restore ناقص می‌توانست
      // با «صفر با صفر می‌خواند» پاس شود
      for (const t of [
        "sales.invoice",
        "sales.invoice_line",
        "ledger.journal_line",
        "inventory.stock_movement",
        "platform.audit_log",
        "treasury.payment",
      ]) {
        const a = psql(disposable!.url, ["-tAc", `SELECT count(*) FROM ${t}`]).toString().trim();
        const b = psql(restoredUrl, ["-tAc", `SELECT count(*) FROM ${t}`]).toString().trim();
        assert.equal(b, a, `شمار ${t} پس از Restore فرق دارد`);
        assert.ok(Number(a) > 0, `${t} خالی است — تطبیق پوچ می‌شد`);
      }
    } finally {
      try {
        psql(adminUrl, ["-c", `DROP DATABASE IF EXISTS "${restored}" WITH (FORCE)`]);
      } catch {
        // انداختن دیتابیس موقت نباید نتیجه تست را عوض کند
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
