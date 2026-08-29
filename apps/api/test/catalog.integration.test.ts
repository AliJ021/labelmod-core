/**
 * تست یکپارچه ساخت خودکار تنوع و ماتریس موجودی — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **یک مدل در ۳ رنگ و ۴ سایز، یک درخواست است نه ۱۲ تا** —
 * و کالایی که این‌طور ساخته می‌شود همان لحظه با بارکدش سر صندوق
 * فروختنی است.
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
import { isInStoreBarcode } from "../src/catalog/barcode.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

/** شکل سطرهای `created` در پاسخ. */
interface Created {
  id: string;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string;
}

const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const STOCK_WH = "00000000-0000-7000-8000-000000000102";

describe("ساخت خودکار تنوع و ماتریس موجودی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `c${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-کالا-و-به‌قدر-کافی-بلند";
  const cashier = `ccashier_${suffix}`;
  const supervisor = `csup_${suffix}`;
  const ids: Record<string, string> = {};

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

  /** یک مدل تازه بدون هیچ تنوعی. */
  async function newProduct(tag: string): Promise<string> {
    const r = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}-${tag}`}, ${`مدل ${tag}`}) RETURNING id`
      .execute(handle.db);
    return r.rows[0]!.id;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [cashier, "صندوق‌دار کالا", "cashier"],
      [supervisor, "سرپرست کالا", "supervisor"],
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

  test("یک درخواست، دوازده کالا — هرکدام با SKU و بارکد معتبر", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("shirt");

    const r = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: {
        colors: ["مشکی", "سفید", "آبی"],
        sizes: ["S", "M", "L", "XL"],
        price: "1500000",
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const body = r.json();
    assert.equal(body.createdCount, 12, "۳ رنگ × ۴ سایز = ۱۲");
    assert.equal(body.skippedCount, 0);

    const skus = new Set<string>();
    const barcodes = new Set<string>();
    for (const v of body.created as Created[]) {
      assert.ok(isInStoreBarcode(v.barcode), `بارکد نامعتبر: ${v.barcode}`);
      assert.match(v.sku, /-\d{3}$/, `SKU نامعتبر: ${v.sku}`);
      skus.add(v.sku);
      barcodes.add(v.barcode);
    }
    assert.equal(skus.size, 12, "SKU‌ها باید یکتا باشند");
    assert.equal(barcodes.size, 12, "بارکدها باید یکتا باشند");
  });

  test("دوباره‌زدن همان دکمه، کالای تکراری نمی‌سازد", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("twice");

    const payload = { colors: ["قرمز", "سبز"], sizes: ["M", "L"] };
    const first = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload,
    });
    assert.equal(first.json().createdCount, 4);

    const again = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload,
    });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.json().createdCount, 0, "هیچ‌چیز تازه‌ای نباید ساخته شود");
    assert.equal(again.json().skippedCount, 4);

    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM catalog.variation
       WHERE product_id = ${productId}::uuid`.execute(handle.db);
    assert.equal(count.rows[0]!.n, "4", "تعداد کل باید همان ۴ بماند");
  });

  test("افزودن یک رنگ تازه به مدل موجود، بارکدهای چاپ‌شده را دست نمی‌زند", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("addcolor");

    const first = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی"], sizes: ["S", "M"] },
    });
    const original = new Map(
      (first.json().created as Created[]).map((v) => [
        `${v.color}|${v.size}`,
        v.barcode,
      ]),
    );

    const second = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی", "طوسی"], sizes: ["S", "M"] },
    });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().createdCount, 2, "فقط ترکیب‌های تازه");
    assert.equal(second.json().skippedCount, 2);

    // شماره‌گذاری SKU باید **ادامه** پیدا کند، نه از ۰۰۱ شروع شود.
    //
    // این دقیقاً باگی بود که همین‌جا گیر افتاد: نسخه اول این شماره را
    // با `max(substring(sku from $1)::bigint)` می‌گرفت، پارامتر بدون
    // Cast به `text` بسته می‌شد، و پستگرس نسخه Regex تابع `substring`
    // را برمی‌گزید. نتیجه NULL بود و شماره‌گذاری بی‌صدا از نو شروع
    // می‌شد — تا روی قید یکتایی بشکند.
    const seqs = (second.json().created as Created[])
      .map((v) => Number(v.sku.slice(-3)))
      .sort((a, b) => a - b);
    assert.deepEqual(seqs, [3, 4], "شماره SKU باید از ۳ ادامه یابد");

    const now = await sql<{ color: string; size: string; barcode: string }>`
      SELECT color, size, barcode FROM catalog.variation
       WHERE product_id = ${productId}::uuid`.execute(handle.db);
    for (const row of now.rows) {
      const was = original.get(`${row.color}|${row.size}`);
      if (was !== undefined) {
        assert.equal(row.barcode, was, "بارکد موجود نباید عوض شود");
      }
    }
  });

  test("صندوق‌دار کالا نمی‌سازد — catalog.manage ندارد", async () => {
    const s = await loginAs(cashier);
    const productId = await newProduct("denied");

    const r = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی"], sizes: ["M"] },
    });
    assert.equal(r.statusCode, 403, r.body);

    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM catalog.variation
       WHERE product_id = ${productId}::uuid`.execute(handle.db);
    assert.equal(count.rows[0]!.n, "0", "کالای ردشده نباید نوشته شده باشد");
  });

  test("کالای ساخته‌شده همان لحظه با بارکدش فروختنی است", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("sellable");

    const gen = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["کرم"], sizes: ["L"], price: "2400000" },
    });
    const variation = (gen.json().created as Created[])[0]!;

    await sql`SELECT platform.set_actor(${ids["supervisor"]}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variation.id}::uuid, ${STORE_WH}::uuid, 5, 'purchase_receipt',
                NULL, NULL, ${ids["supervisor"]}::uuid, 900000)`.execute(handle.db);

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
    const line = await app.inject({
      method: "POST",
      url: `/invoices/${inv.json().id}/lines`,
      ...s,
      payload: { barcode: variation.barcode, qty: "1" },
    });
    assert.equal(line.statusCode, 201, line.body);
    assert.equal(
      line.json().lines[0].unitPrice,
      "2400000",
      "قیمتی که موقع ساخت داده شد باید سر صندوق بیاید",
    );
  });

  test("ماتریس موجودی — ستون‌ها به ترتیب سایز، و سوراخِ وسط دیده می‌شود", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("matrix");

    const gen = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی", "سفید"], sizes: ["XL", "S", "L", "M"] },
    });
    assert.equal(gen.json().createdCount, 8);

    const made = new Map(
      (gen.json().created as Created[]).map((v) => [
        `${v.color}|${v.size}`,
        v.id,
      ]),
    );

    // مشکی: S و XL موجود، M و L صفر — همان الگویی که یعنی «سفارش بده»
    await sql`SELECT platform.set_actor(${ids["supervisor"]}::uuid)`.execute(handle.db);
    for (const [key, qty] of [
      ["مشکی|S", 2],
      ["مشکی|XL", 3],
      ["سفید|S", 4],
      ["سفید|M", 6],
      ["سفید|L", 5],
      ["سفید|XL", 1],
    ] as const) {
      await sql`SELECT inventory.apply_movement(
                  ${made.get(key)}::uuid, ${STORE_WH}::uuid, ${qty},
                  'purchase_receipt', NULL, NULL,
                  ${ids["supervisor"]}::uuid, 500000)`.execute(handle.db);
    }

    const r = await app.inject({
      method: "GET",
      url: `/products/${productId}/stock-matrix`,
      ...s,
    });
    assert.equal(r.statusCode, 200, r.body);
    const m = r.json();

    assert.deepEqual(
      m.sizes,
      ["S", "M", "L", "XL"],
      "ستون‌ها باید به ترتیب سایز باشند، نه الفبایی",
    );
    assert.deepEqual(m.colors, ["مشکی", "سفید"]);
    assert.equal(m.cells["مشکی"]["S"].onHand, "2.000");
    assert.equal(m.cells["مشکی"]["M"].onHand, "0");
    assert.equal(m.cells["سفید"]["M"].onHand, "6.000");
    assert.equal(m.totalOnHand, "21.000", "۲+۳+۴+۶+۵+۱");

    const black = (m.soldOut as Array<{ color: string; sizes: string[] }>).find(
      (x) => x.color === "مشکی",
    );
    assert.ok(black, "مشکی باید سایز صفرشده داشته باشد");
    assert.deepEqual(black.sizes, ["M", "L"], "سوراخ وسط: M و L");
    const white = (m.soldOut as Array<{ color: string }>).find(
      (x) => x.color === "سفید",
    );
    assert.equal(white, undefined, "سفید هیچ سایز صفری ندارد");
  });

  test("ماتریس فقط انبار خواسته‌شده را می‌شمارد", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("wh");

    const gen = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["آبی"], sizes: ["M"] },
    });
    const v = (gen.json().created as Created[])[0]!;

    await sql`SELECT platform.set_actor(${ids["supervisor"]}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(${v.id}::uuid, ${STORE_WH}::uuid, 3,
                'purchase_receipt', NULL, NULL, ${ids["supervisor"]}::uuid, 100000)`
      .execute(handle.db);
    await sql`SELECT inventory.apply_movement(${v.id}::uuid, ${STOCK_WH}::uuid, 7,
                'purchase_receipt', NULL, NULL, ${ids["supervisor"]}::uuid, 100000)`
      .execute(handle.db);

    const all = await app.inject({
      method: "GET",
      url: `/products/${productId}/stock-matrix`,
      ...s,
    });
    assert.equal(all.json().totalOnHand, "10.000", "بدون فیلتر، جمع همه انبارها");

    const store = await app.inject({
      method: "GET",
      url: `/products/${productId}/stock-matrix?warehouseId=${STORE_WH}`,
      ...s,
    });
    assert.equal(store.json().totalOnHand, "3.000", "فقط انبار فروشگاه");
    assert.equal(store.json().cells["آبی"]["M"].onHand, "3.000");
  });

  test("ورودی نامعتبر و مدل ناموجود، ۵۰۰ نمی‌دهند", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("bad");

    const empty = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: [], sizes: [] },
    });
    assert.equal(empty.statusCode, 400, empty.body);

    const huge = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: {
        colors: Array.from({ length: 30 }, (_, i) => `رنگ${i}`),
        sizes: Array.from({ length: 30 }, (_, i) => `س${i}`),
      },
    });
    assert.equal(huge.statusCode, 422, huge.body);
    assert.equal(huge.json().error.code, "too_many_combinations");

    // نشانه وارونه‌سازی دوطرفه: محتوا را عوض نمی‌کند ولی ظاهر برچسب
    // چاپی را وارونه نشان می‌دهد. با کد نویسه نوشته شده، نه با خودش —
    // نویسه کنترلیِ خام در سورس نامرئی است.
    const bidi = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["\u202eمشکی"], sizes: ["M"] },
    });
    assert.equal(bidi.statusCode, 400, bidi.body);
    assert.equal(bidi.json().error.code, "invalid_input");

    const nul = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی"], sizes: ["M\u0000"] },
    });
    assert.equal(nul.statusCode, 400, nul.body);

    const missing = await app.inject({
      method: "POST",
      url: `/products/00000000-0000-7000-8000-0000000000ff/variations/generate`,
      ...s,
      payload: { colors: ["مشکی"], sizes: ["M"] },
    });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal(missing.json().error.code, "product_not_found");

    const matrix = await app.inject({
      method: "GET",
      url: `/products/00000000-0000-7000-8000-0000000000ff/stock-matrix`,
      ...s,
    });
    assert.equal(matrix.statusCode, 404, matrix.body);
  });

  test("رنگ تکراری در یک درخواست، کالای تکراری نمی‌سازد", async () => {
    const s = await loginAs(supervisor);
    const productId = await newProduct("dupe");

    const r = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی", " مشکی ", "مشکی"], sizes: ["M", "M"] },
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().createdCount, 1, "سه «مشکی» و دو «M» یک ترکیب‌اند");
  });
});
