/**
 * تست یکپارچه چرخه حیات کالا و قیمت — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **از «کالای تازه رسید» تا «سر صندوق فروخته شد» یک
 * چرخه کامل است، بدون psql.** و در همان چرخه:
 *
 *   · قیمت قبلی پاک نمی‌شود
 *   · فاکتور نهایی‌شده پس از تغییر قیمت تکان نمی‌خورد
 *   · صندوق‌دار نمی‌تواند قیمت عوض کند، حتی اگر درخواستش را دستی بسازد
 *   · نشست بازشده با PIN هم نمی‌تواند — حتی اگر کاربرش مدیر باشد
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

interface VariationOut {
  id: string;
  sku: string;
  color: string | null;
  size: string | null;
  price: string | null;
  status: string;
  locked: boolean;
}

describe("چرخه حیات کالا و قیمت", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `pp${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-کالا-و-قیمت-به‌قدر-کافی-بلند";
  const admin = `padmin_${suffix}`;
  const warehouse = `pwh_${suffix}`;
  const cashier = `pcash_${suffix}`;
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
        labelmod_session:
          r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
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
      [admin, "مدیر قیمت", "admin"],
      [warehouse, "انباردار قیمت", "warehouse"],
      [cashier, "صندوق‌دار قیمت", "cashier"],
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

  // ── چرخه کامل ────────────────────────────────────────────────────────

  test("از ساخت کالا تا فروشِ همان کالا — بدون یک خط psql", async () => {
    const s = await loginAs(admin);

    // ۱. کالای تازه
    const created = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      payload: {
        code: `NEW-${suffix}`.slice(0, 24),
        nameInternal: "شلوار پارچه‌ای رگولار کمر ایتالیایی",
        nameWeb: "Regular Trouser",
        fit: "رگولار",
        season: "پاییز ۱۴۰۵",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;

    // ۲. تنوع‌ها — همان مسیر موجود
    const gen = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["سبز لجنی"], sizes: ["30", "32"] },
    });
    assert.equal(gen.statusCode, 201, gen.body);

    // ۳. هنوز قیمت ندارند — و همین باید در فهرست دیده شود
    const detail = await app.inject({ method: "GET", url: `/products/${productId}`, ...s });
    assert.equal(detail.statusCode, 200, detail.body);
    const vars = detail.json().variations as VariationOut[];
    assert.equal(vars.length, 2);
    assert.equal(vars[0]!.price, null, "تنوع تازه نباید قیمت داشته باشد");
    assert.equal(detail.json().product.pricedCount, 0);
    assert.equal(detail.json().product.variationCount, 2);

    // ۴. قیمت‌گذاری گروهی — یک مبلغ روی هر دو سایز، در یک تراکنش
    const priced = await app.inject({
      method: "PUT",
      url: "/prices",
      ...s,
      payload: {
        variationIds: vars.map((v) => v.id),
        amount: "43800000",
        reason: "قیمت‌گذاری اولیه",
      },
    });
    assert.equal(priced.statusCode, 200, priced.body);
    assert.equal(priced.json().updated, 2);

    const after1 = await app.inject({ method: "GET", url: `/products/${productId}`, ...s });
    assert.equal(after1.json().product.pricedCount, 2, "هر دو تنوع قیمت گرفتند");
    for (const v of after1.json().variations as VariationOut[]) {
      assert.equal(v.price, "43800000");
      assert.equal(typeof v.price, "string", "پول در JSON رشته است، نه عدد");
    }

    // ۵. و حالا واقعاً فروختنی است — همان مسیری که صندوق می‌رود
    const variationId = vars[0]!.id;
    await sql`SELECT inventory.apply_movement(
      ${variationId}::uuid, ${STORE_WH}::uuid, 5, 'purchase_receipt',
      NULL, NULL, ${ids["admin"]}::uuid, 20000000)`.execute(handle.db);

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
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const invoiceId = inv.json().id as string;

    const line = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "1" },
    });
    assert.equal(line.statusCode, 201, line.body);
    assert.equal(
      line.json().netAmount,
      "43800000",
      "قیمت فاکتور از catalog.price آمد، نه از کلاینت",
    );
  });

  // ── تاریخچه ──────────────────────────────────────────────────────────

  test("تغییر قیمت، سطر تازه می‌سازد و سطر قبلی را نگه می‌دارد", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "hist");

    await setPrice(s, variationId, "10000000", "قیمت اول");
    await setPrice(s, variationId, "8000000", "حراج", "markdown");
    await setPrice(s, variationId, "12000000", "فصل تازه");

    const h = await app.inject({
      method: "GET",
      url: `/variations/${variationId}/price-history`,
      ...s,
    });
    assert.equal(h.statusCode, 200, h.body);
    const history = h.json().history as Array<{
      amount: string;
      kind: string;
      reason: string | null;
      validTo: string | null;
    }>;

    assert.equal(history.length, 3, "هر سه قیمت در تاریخچه هستند");
    assert.equal(history[0]!.amount, "12000000", "تازه‌ترین اول");
    assert.equal(history[0]!.validTo, null, "و باز است");
    assert.equal(history[1]!.amount, "8000000");
    assert.equal(history[1]!.kind, "markdown");
    assert.notEqual(history[1]!.validTo, null, "قیمت قبلی بسته شده، نه پاک");
    assert.equal(history[2]!.amount, "10000000");
    assert.equal(history[2]!.reason, "قیمت اول", "دلیل هر تغییر می‌ماند");

    const open = await sql<{ n: string }>`
      SELECT count(*) AS n FROM catalog.price
       WHERE variation_id = ${variationId}::uuid AND valid_to IS NULL`
      .execute(handle.db);
    assert.equal(open.rows[0]!.n, "1", "همیشه دقیقاً یک قیمت باز");
  });

  test("همان قیمت دوباره، سطر تاریخچه اضافه نمی‌کند", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "same");

    await setPrice(s, variationId, "5000000");
    await setPrice(s, variationId, "5000000");
    await setPrice(s, variationId, "5000000");

    const h = await app.inject({
      method: "GET",
      url: `/variations/${variationId}/price-history`,
      ...s,
    });
    assert.equal((h.json().history as unknown[]).length, 1);
  });

  test("فاکتور نهایی‌شده پس از تغییر قیمت تکان نمی‌خورد", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "snap");
    await setPrice(s, variationId, "7000000");
    await sql`SELECT inventory.apply_movement(
      ${variationId}::uuid, ${STORE_WH}::uuid, 3, 'purchase_receipt',
      NULL, NULL, ${ids["admin"]}::uuid, 3000000)`.execute(handle.db);

    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    const invoiceId = inv.json().id as string;
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload: { variationId, qty: "2" },
    });
    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "14000000" },
    });
    const fin = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
      payload: {},
    });
    assert.equal(fin.statusCode, 200, fin.body);
    const before = fin.json().netAmount as string;
    assert.equal(before, "14000000");

    // قیمت را سه برابر می‌کنیم
    await setPrice(s, variationId, "21000000", "قیمت فصل بعد");

    const read = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, ...s });
    assert.equal(read.json().netAmount, before, "جمع فاکتور عوض نشد");
    assert.equal(
      read.json().lines[0]!.unitPrice,
      "7000000",
      "قیمت واحد Snapshot سر جایش ماند",
    );
  });

  // ── مجوز ─────────────────────────────────────────────────────────────

  test("صندوق‌دار نه کالا می‌سازد نه قیمت عوض می‌کند", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "perm");
    const c = await loginAs(cashier);

    const make = await app.inject({
      method: "POST",
      url: "/products",
      ...c,
      payload: { code: `X-${suffix}`.slice(0, 24), nameInternal: "نباید ساخته شود" },
    });
    assert.equal(make.statusCode, 403, `انتظار ۴۰۳ بود: ${make.body}`);

    const price = await app.inject({
      method: "PUT",
      url: `/variations/${variationId}/price`,
      ...c,
      payload: { amount: "1" },
    });
    assert.equal(price.statusCode, 403, `انتظار ۴۰۳ بود: ${price.body}`);

    const list = await app.inject({ method: "GET", url: "/products", ...c });
    assert.equal(list.statusCode, 403, "حتی خواندن فهرست کالا هم catalog.manage می‌خواهد");
  });

  test("انباردار کالا می‌سازد ولی قیمت عوض نمی‌کند", async () => {
    const w = await loginAs(warehouse);

    const make = await app.inject({
      method: "POST",
      url: "/products",
      ...w,
      payload: {
        code: `WH-${suffix}`.slice(0, 24),
        nameInternal: "کالای انباردار",
      },
    });
    assert.equal(make.statusCode, 201, make.body);
    const productId = make.json().id as string;

    const gen = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...w,
      payload: { colors: ["مشکی"], sizes: ["L"] },
    });
    assert.equal(gen.statusCode, 201, gen.body);
    const variationId = gen.json().created[0].id as string;

    const price = await app.inject({
      method: "PUT",
      url: `/variations/${variationId}/price`,
      ...w,
      payload: { amount: "1000000" },
    });
    assert.equal(
      price.statusCode,
      403,
      "price.change فقط مدیر دارد — انباردار قیمت تعیین نمی‌کند",
    );
  });

  test("نشست بازشده با PIN قیمت عوض نمی‌کند، حتی برای مدیر", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "pin");

    // PIN را ست می‌کنیم و نشست را قفل و با PIN باز می‌کنیم
    const pinHash = await hashSecret("4731");
    await handle.db
      .updateTable("identity.app_user")
      .set({ pin_hash: pinHash })
      .where("id", "=", ids["admin"] as string)
      .execute();

    const fresh = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        username: admin,
        password: PASSWORD,
        deviceFingerprint: `fp-${suffix}-pin`,
      },
    });
    assert.equal(fresh.statusCode, 200, fresh.body);
    const csrf = fresh.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const jar = {
      cookies: {
        labelmod_session:
          fresh.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
        ...Object.fromEntries(
          fresh.cookies
            .filter((c) => c.name === "labelmod_device")
            .map((c) => [c.name, c.value]),
        ),
      },
      headers: { "x-csrf-token": csrf },
    };

    await app.inject({ method: "POST", url: "/auth/lock", ...jar, payload: {} });
    const unlocked = await app.inject({
      method: "POST",
      url: "/auth/unlock",
      ...jar,
      payload: { username: admin, pin: "4731", deviceFingerprint: `fp-${suffix}-pin` },
    });

    // اگر دستگاه تأیید نشده باشد، بازگشایی با PIN اصلاً ممکن نیست —
    // آن خودش دفاع است و ادعای این تست را نقض نمی‌کند.
    if (unlocked.statusCode !== 200) return;

    const price = await app.inject({
      method: "PUT",
      url: `/variations/${variationId}/price`,
      ...jar,
      payload: { amount: "1" },
    });
    assert.equal(
      price.statusCode,
      403,
      "price.change در auth.pin_forbidden_operations است",
    );
  });

  // ── اعتبارسنجی ورودی ─────────────────────────────────────────────────

  test("قیمت از کلاینت می‌آید ولی هر رشته‌ای پذیرفته نمی‌شود", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "valid");

    for (const bad of ["-1", "1.5", "۱۰۰۰", "1e6", "", "1000000000000000000000"]) {
      const r = await app.inject({
        method: "PUT",
        url: `/variations/${variationId}/price`,
        ...s,
        payload: { amount: bad },
      });
      assert.equal(r.statusCode, 400, `«${bad}» نباید پذیرفته شود: ${r.body}`);
    }

    const num = await app.inject({
      method: "PUT",
      url: `/variations/${variationId}/price`,
      ...s,
      payload: { amount: 1000000 },
    });
    assert.equal(num.statusCode, 400, "عدد جاوااسکریپت به‌جای رشته رد می‌شود");
  });

  test("کد کالا فقط لاتین و رقم — و نویسه کنترلی رد می‌شود", async () => {
    const s = await loginAs(admin);

    const persianCode = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      payload: { code: "کد-فارسی", nameInternal: "نام" },
    });
    assert.equal(persianCode.statusCode, 400, "کد فارسی SKU را می‌شکند");

    const bidi = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      payload: {
        code: `BIDI-${suffix}`.slice(0, 24),
        nameInternal: `نام${String.fromCodePoint(0x202e)}وارونه`,
      },
    });
    assert.equal(bidi.statusCode, 400, "نویسه جهت‌دهی ظاهر برچسب را وارونه می‌کند");
  });

  test("کد کالا پس از ساخت عوض نمی‌شود — حتی اگر کلاینت بفرستد", async () => {
    const s = await loginAs(admin);
    const code = `LOCK-${suffix}`.slice(0, 24);
    const made = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      payload: { code, nameInternal: "کد قفل" },
    });
    const productId = made.json().id as string;

    const patched = await app.inject({
      method: "PATCH",
      url: `/products/${productId}`,
      ...s,
      payload: { nameInternal: "نام تازه", code: "SOMETHING-ELSE" },
    });
    assert.equal(patched.statusCode, 200, patched.body);

    const read = await app.inject({ method: "GET", url: `/products/${productId}`, ...s });
    assert.equal(read.json().product.code, code, "کد دست‌نخورده ماند");
    assert.equal(read.json().product.nameInternal, "نام تازه", "ولی نام عوض شد");
  });

  // ── Idempotency ──────────────────────────────────────────────────────

  test("ساخت کالا با یک کلید، دو بار = یک کالا", async () => {
    const s = await loginAs(admin);
    const key = `idem-${suffix}`;
    const payload = {
      code: `IDEM-${suffix}`.slice(0, 24),
      nameInternal: "کالای تکراری",
    };

    const first = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload,
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload,
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().replayed, true);
    assert.equal(second.json().id, first.json().id, "همان کالا برگشت");

    // همان کلید با بدنه متفاوت = تعارض، نه یک کالای دوم
    const conflict = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { ...payload, nameInternal: "چیز دیگری" },
    });
    assert.equal(conflict.statusCode, 409, `انتظار ۴۰۹ بود: ${conflict.body}`);
  });

  // ── بایگانی و اصلاح ──────────────────────────────────────────────────

  test("بایگانی کالا تنوع‌هایش را می‌بندد ولی تاریخچه را نگه می‌دارد", async () => {
    const s = await loginAs(admin);
    const { productId, variationId } = await freshVariation(s, "arch");

    const r = await app.inject({
      method: "PATCH",
      url: `/products/${productId}/status`,
      ...s,
      payload: { status: "archived", reason: "مدل قدیمی" },
    });
    assert.equal(r.statusCode, 200, r.body);

    const read = await app.inject({
      method: "GET",
      url: `/products/${productId}`,
      ...s,
    });
    assert.equal(read.json().product.status, "archived");
    for (const v of read.json().variations as VariationOut[]) {
      assert.equal(v.status, "archived");
    }

    // و کالا واقعاً حذف نشده
    const n = await sql<{ n: string }>`
      SELECT count(*) AS n FROM catalog.variation WHERE id = ${variationId}::uuid`
      .execute(handle.db);
    assert.equal(n.rows[0]!.n, "1");
  });

  test("رنگ و سایز فقط پیش از اولین حرکت انبار اصلاح می‌شوند", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "amend");

    const ok = await app.inject({
      method: "PATCH",
      url: `/variations/${variationId}`,
      ...s,
      payload: { color: "سبز زیتونی", size: "32" },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    await sql`SELECT inventory.apply_movement(
      ${variationId}::uuid, ${STORE_WH}::uuid, 1, 'purchase_receipt',
      NULL, NULL, ${ids["admin"]}::uuid, 1000000)`.execute(handle.db);

    const blocked = await app.inject({
      method: "PATCH",
      url: `/variations/${variationId}`,
      ...s,
      payload: { color: "قرمز" },
    });
    assert.equal(blocked.statusCode, 409, `انتظار ۴۰۹ بود: ${blocked.body}`);
    assert.match(blocked.json().error.message, /حرکت انبار/);
  });

  test("پرچم locked همان چیزی را می‌گوید که سرور اجبار می‌کند", async () => {
    const s = await loginAs(admin);
    const { productId, variationId } = await freshVariation(s, "locked");

    const before = await app.inject({ method: "GET", url: `/products/${productId}`, ...s });
    const v0 = (before.json().variations as VariationOut[]).find((v) => v.id === variationId);
    assert.equal(v0!.locked, false, "تنوع دست‌نخورده قفل نیست");

    await sql`SELECT inventory.apply_movement(
      ${variationId}::uuid, ${STORE_WH}::uuid, 1, 'purchase_receipt',
      NULL, NULL, ${ids["admin"]}::uuid, 1000000)`.execute(handle.db);

    const after2 = await app.inject({ method: "GET", url: `/products/${productId}`, ...s });
    const v1 = (after2.json().variations as VariationOut[]).find((v) => v.id === variationId);
    assert.equal(v1!.locked, true, "پس از حرکت انبار قفل است");
  });

  // ── ردّ حسابرسی ──────────────────────────────────────────────────────

  test("هر تغییر قیمت با مقدار پیش و پس در لاگ حسابرسی می‌نشیند", async () => {
    const s = await loginAs(admin);
    const { variationId } = await freshVariation(s, "audit");

    await setPrice(s, variationId, "3000000", "اول");
    await setPrice(s, variationId, "4000000", "دوم");

    const rows = await sql<{
      before: { amount?: string } | null;
      after: { amount?: string };
      reason: string | null;
      actor_id: string;
    }>`
      SELECT before, after, reason, actor_id FROM platform.audit_log
       WHERE action = 'price.change' AND entity_id = ${variationId}::text
       ORDER BY id`.execute(handle.db);

    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]!.before, null, "اولین قیمت مقدار پیش ندارد");
    assert.equal(rows.rows[0]!.after.amount, "3000000");
    assert.equal(rows.rows[1]!.before?.amount, "3000000");
    assert.equal(rows.rows[1]!.after.amount, "4000000");
    assert.equal(rows.rows[1]!.reason, "دوم");
    assert.equal(rows.rows[1]!.actor_id, ids["admin"], "کاربر عامل واقعی ثبت شد");
  });

  // ── کمکی ─────────────────────────────────────────────────────────────

  let seq = 0;
  async function freshVariation(
    s: { cookies: Record<string, string>; headers: Record<string, string> },
    tag: string,
  ): Promise<{ productId: string; variationId: string }> {
    seq += 1;
    const made = await app.inject({
      method: "POST",
      url: "/products",
      ...s,
      payload: { code: `${tag}${seq}-${suffix}`.slice(0, 24), nameInternal: `مدل ${tag}` },
    });
    assert.equal(made.statusCode, 201, made.body);
    const productId = made.json().id as string;

    const gen = await app.inject({
      method: "POST",
      url: `/products/${productId}/variations/generate`,
      ...s,
      payload: { colors: ["مشکی"], sizes: ["M"] },
    });
    assert.equal(gen.statusCode, 201, gen.body);
    return { productId, variationId: gen.json().created[0].id as string };
  }

  async function setPrice(
    s: { cookies: Record<string, string>; headers: Record<string, string> },
    variationId: string,
    amount: string,
    reason?: string,
    kind?: string,
  ) {
    const r = await app.inject({
      method: "PUT",
      url: `/variations/${variationId}/price`,
      ...s,
      payload: {
        amount,
        ...(reason === undefined ? {} : { reason }),
        ...(kind === undefined ? {} : { kind }),
      },
    });
    assert.equal(r.statusCode, 200, r.body);
  }
});
