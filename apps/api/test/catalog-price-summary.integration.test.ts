import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * قیمت کالا در فهرست «کالا و قیمت» — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **عددی که فهرست نشان می‌دهد همان عددی است که صندوق
 * می‌خواند**، و قیمتِ نبوده هرگز صفر یا «کامل» نشان داده نمی‌شود.
 *
 *   · قیمت‌های برابر ← یک عدد (کمینه = بیشینه)
 *   · قیمت‌های متفاوت ← بازهٔ واقعی
 *   · بی‌قیمت ← `null`، نه صفر
 *   · بخشی بی‌قیمت ← بازه فقط از قیمت‌دارها + شمارش جدا
 *   · فقط تنوع `active` (دروازهٔ `resolveVariation`)، فقط فهرست
 *     `default`، فقط ردیف معتبرِ اکنون (محمول `currentPrice`)
 *   · مبلغ بزرگ بی‌گرد شدن، به‌صورت رشته
 *   · جست‌وجو، سقف `limit` و بایگانی دست‌نخورده
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

interface ProductOut {
  id: string;
  code: string;
  status: string;
  variationCount: number;
  pricedCount: number;
  sellableCount: number;
  sellablePricedCount: number;
  priceMin: string | null;
  priceMax: string | null;
}

interface VariationOut {
  id: string;
  sku: string;
  size: string | null;
  price: string | null;
}

describe("قیمت کالا در فهرست کالا و قیمت", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let adminId = "";

  const suffix = `cps${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-فهرست-قیمت-کالا-به‌قدر-کافی-بلند";
  const admin = `cpsadmin_${suffix}`;
  let s: { cookies: Record<string, string>; headers: Record<string, string> };

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    const auth = new AuthService(handle.db);
    const hash = await hashSecret(PASSWORD);
    const u = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: admin,
        full_name: "مدیر فهرست قیمت",
        password_hash: hash,
        is_active: true,
        mobile: null,
        pin_hash: null,
        totp_secret: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    adminId = u.id;
    await handle.db
      .insertInto("identity.user_role")
      .values({ user_id: u.id, role_code: "admin", branch_id: BRANCH })
      .execute();

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: { username: admin, password: PASSWORD, deviceFingerprint: `fp-${suffix}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    s = {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  /** کالا با یک رنگ و چند سایز، از همان مسیر HTTP صفحه. */
  async function product(code: string, sizes: string[]): Promise<{ id: string; vars: VariationOut[] }> {
    const created = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      headers: { ...s.headers, "idempotency-key": `create-${code}` },
      payload: { code, nameInternal: `کالای آزمون ${code}` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    const gen = await app.inject({
      method: "POST",
      url: `/products/${id}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی"], sizes },
    });
    assert.equal(gen.statusCode, 201, gen.body);
    const detail = await app.inject({ method: "GET", url: `/products/${id}`, ...s });
    const vars = (detail.json().variations as VariationOut[]).sort((a, b) =>
      sizes.indexOf(a.size ?? "") - sizes.indexOf(b.size ?? ""),
    );
    return { id, vars };
  }

  async function price(variationId: string, amount: string) {
    const r = await app.inject({
      method: "PUT",
      url: `/variations/${variationId}/price`,
      ...s,
      payload: { amount, reason: "قیمت‌گذاری آزمون" },
    });
    assert.equal(r.statusCode, 200, r.body);
  }

  async function listed(code: string, status = "all"): Promise<ProductOut> {
    const r = await app.inject({
      method: "GET",
      url: `/products?search=${encodeURIComponent(code)}&status=${status}`,
      ...s,
    });
    assert.equal(r.statusCode, 200, r.body);
    const found = (r.json().products as ProductOut[]).filter((p) => p.code === code);
    assert.equal(found.length, 1, `کالای ${code} باید دقیقاً یک بار بیاید`);
    return found[0]!;
  }

  test("قیمت‌های برابر یک عدد است، نه بازه", async () => {
    const code = `EQ-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M", "L"]);
    for (const v of vars) await price(v.id, "12500000");
    const p = await listed(code);
    assert.equal(p.priceMin, "12500000");
    assert.equal(p.priceMax, "12500000");
    assert.equal(typeof p.priceMin, "string", "پول در JSON رشته است");
    assert.equal(p.sellableCount, 3);
    assert.equal(p.sellablePricedCount, 3);
    assert.equal(p.pricedCount, 3, "pricedCount برای سازگاری می‌ماند");
  });

  test("قیمت‌های متفاوت بازهٔ واقعی می‌دهند", async () => {
    const code = `RG-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M", "L"]);
    await price(vars[0]!.id, "9000000");
    await price(vars[1]!.id, "9500000");
    await price(vars[2]!.id, "11000000");
    const p = await listed(code);
    assert.equal(p.priceMin, "9000000");
    assert.equal(p.priceMax, "11000000");
  });

  test("بی‌قیمت null است، هرگز صفر", async () => {
    const code = `NP-${suffix}`.slice(0, 24);
    await product(code, ["S", "M"]);
    const p = await listed(code);
    assert.equal(p.priceMin, null);
    assert.equal(p.priceMax, null);
    assert.equal(p.sellableCount, 2);
    assert.equal(p.sellablePricedCount, 0);
    assert.equal(p.pricedCount, 0);
  });

  test("بخشی بی‌قیمت: بازه فقط از قیمت‌دارها و کسری جدا شمرده می‌شود", async () => {
    const code = `PP-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M", "L"]);
    await price(vars[0]!.id, "7000000");
    await price(vars[2]!.id, "8000000");
    const p = await listed(code);
    assert.equal(p.priceMin, "7000000", "تنوع بی‌قیمت کمینه را صفر نمی‌کند");
    assert.equal(p.priceMax, "8000000");
    assert.equal(p.sellableCount, 3);
    assert.equal(p.sellablePricedCount, 2);
  });

  test("قیمت جاری، نه قیمت قبلی: تغییر قیمت بازه را جابه‌جا می‌کند", async () => {
    const code = `CH-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M"]);
    await price(vars[0]!.id, "5000000");
    await price(vars[1]!.id, "5000000");
    await price(vars[0]!.id, "6000000"); // سطر قبلی بسته می‌شود، پاک نه
    const p = await listed(code);
    assert.equal(p.priceMin, "5000000");
    assert.equal(p.priceMax, "6000000");
    const history = await handle.db
      .selectFrom("catalog.price")
      .select((e) => e.fn.countAll<string>().as("n"))
      .where("variation_id", "=", vars[0]!.id)
      .executeTakeFirstOrThrow();
    assert.equal(Number(history.n), 2, "تاریخچه دست‌نخورده می‌ماند");
  });

  test("فقط تنوع فروختنی (active) در بازه و شمارش فروختنی می‌آید", async () => {
    const code = `ST-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M", "L"]);
    await price(vars[0]!.id, "4000000");
    await price(vars[1]!.id, "4500000");
    await price(vars[2]!.id, "99000000");
    const paused = await app.inject({
      method: "PATCH",
      url: `/variations/${vars[2]!.id}/status`,
      ...s,
      payload: { status: "paused" },
    });
    assert.equal(paused.statusCode, 200, paused.body);
    const p = await listed(code);
    assert.equal(p.priceMax, "4500000", "تنوع متوقف را صندوق نمی‌فروشد، پس بازه را نمی‌کشد");
    assert.equal(p.sellableCount, 2);
    assert.equal(p.sellablePricedCount, 2);
    assert.equal(p.variationCount, 3);
    assert.equal(p.pricedCount, 3);
  });

  test("فهرست قیمت دیگر (مثلاً سایت) و ردیفِ هنوز نامعتبر خوانده نمی‌شوند", async () => {
    const code = `PL-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M"]);
    await price(vars[0]!.id, "3000000");
    // قیمت فهرست دیگر از همان دروازهٔ رسمی — صندوق آن را نمی‌خواند.
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${adminId}::uuid)`.execute(trx);
      await sql`SELECT catalog.set_price(${vars[0]!.id}::uuid, 1000::numeric, 'regular', NULL, 'web')`.execute(trx);
      await sql`SELECT catalog.set_price(${vars[1]!.id}::uuid, 1000::numeric, 'regular', NULL, 'web')`.execute(trx);
    });
    // ردیفی که شروعش آینده است: `currentPrice` نمی‌خواندش، پس فهرست هم
    // نباید. فقط برای سنجیدن محمول `valid_from <= now()` در دیتابیس
    // یک‌بارمصرف درج شده؛ هیچ مسیر برنامه چنین ردیفی نمی‌سازد.
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount, valid_from)
              VALUES (${vars[1]!.id}::uuid, 'default', 50000000, now() + interval '1 day')`.execute(handle.db);
    const p = await listed(code);
    assert.equal(p.priceMin, "3000000");
    assert.equal(p.priceMax, "3000000");
    assert.equal(p.sellablePricedCount, 1, "قیمت سایت یا آینده، تنوع را قیمت‌دار نمی‌کند");
    assert.equal(p.pricedCount, 1);
  });

  test("مبلغ بزرگ دقیق و رشته‌ای می‌ماند", async () => {
    const code = `BG-${suffix}`.slice(0, 24);
    const { vars } = await product(code, ["S", "M"]);
    await price(vars[0]!.id, "900719925474099300"); // بزرگ‌تر از Number.MAX_SAFE_INTEGER
    await price(vars[1]!.id, "999999999999999999"); // سقف NUMERIC(18,0)
    const p = await listed(code);
    assert.equal(p.priceMin, "900719925474099300");
    assert.equal(p.priceMax, "999999999999999999");
  });

  test("کالای بایگانی: تنوع فروختنی ندارد، پس قیمتی ادعا نمی‌شود", async () => {
    const code = `AR-${suffix}`.slice(0, 24);
    const { id, vars } = await product(code, ["S"]);
    await price(vars[0]!.id, "2000000");
    const r = await app.inject({
      method: "PATCH",
      url: `/products/${id}/status`,
      ...s,
      payload: { status: "archived", reason: "پایان فصل" },
    });
    assert.equal(r.statusCode, 200, r.body);
    const p = await listed(code, "all");
    assert.equal(p.status, "archived");
    assert.equal(p.sellableCount, 0);
    assert.equal(p.priceMin, null);
    assert.equal(p.pricedCount, 1, "تاریخچهٔ قیمت با بایگانی پاک نمی‌شود");
    const active = await app.inject({
      method: "GET",
      url: `/products?search=${encodeURIComponent(code)}`,
      ...s,
    });
    assert.equal((active.json().products as ProductOut[]).length, 0, "پیش‌فرض فهرست هنوز فقط فعال است");
  });

  test("جست‌وجو و سقف limit با تجمیع قیمت دست‌نخورده‌اند", async () => {
    const all = await app.inject({ method: "GET", url: `/products?status=all&search=${suffix}`, ...s });
    const n = (all.json().products as ProductOut[]).length;
    assert.ok(n >= 8, `باید همهٔ کالاهای آزمون بیایند، آمد ${n}`);
    const two = await app.inject({ method: "GET", url: `/products?status=all&search=${suffix}&limit=2`, ...s });
    const rows = two.json().products as ProductOut[];
    assert.equal(rows.length, 2, "تجمیع LATERAL ردیف کالا را تکثیر نمی‌کند");
    const codes = rows.map((p) => p.code);
    assert.deepEqual(codes, [...codes].sort(), "ترتیب کد حفظ می‌شود");
    // یک کالا با سه تنوع یک ردیف است، نه سه.
    const eq = (all.json().products as ProductOut[]).filter((p) => p.code.startsWith("EQ-"));
    assert.equal(eq.length, 1);
  });

  test("جزئیات کالا همان خلاصه را دارد", async () => {
    const code = `EQ-${suffix}`.slice(0, 24);
    const p = await listed(code);
    const d = await app.inject({ method: "GET", url: `/products/${p.id}`, ...s });
    assert.equal(d.statusCode, 200, d.body);
    assert.equal(d.json().product.priceMin, "12500000");
    assert.equal(d.json().product.sellablePricedCount, 3);
  });
});
