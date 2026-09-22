import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه انبارگردانی — روی پستگرس واقعی.
 *
 * ادعای مرکزی، همان که کل طراحی رویش بنا شده:
 *
 *   **موجودی سیستم در لحظه ثبت خوانده می‌شود، نه هنگام ورود سطر.**
 *
 * لایه API این عدد را نمی‌خواند و نباید بخواند. اینجا صریح سنجیده
 * می‌شود که `systemQty` پیش از ثبت `null` است — نه صفر، نه یک عدد
 * کهنه.
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

interface CountBody {
  id: string;
  number: string | null;
  status: string;
  lines: {
    id: string;
    variationId: string;
    countedQty: string;
    systemQty: string | null;
    diffQty: string | null;
    unitCost: string | null;
    valueDelta: string | null;
  }[];
}

describe("انبارگردانی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `sc${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-انبارگردانی-و-به‌قدر-کافی-بلند";
  const keeper = `sckeeper_${suffix}`;   // انباردار — stock.count دارد
  const cashier = `sccashier_${suffix}`; // صندوق‌دار — ندارد

  let variationA = "";
  let variationB = "";
  let barcodeA = "";

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

  async function newSheet(): Promise<CountBody> {
    const s = await loginAs(keeper);
    const r = await app.inject({
      method: "POST",
      url: "/stock-counts",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json() as CountBody;
  }

  async function onHand(variationId: string): Promise<number> {
    const r = await sql<{ on_hand: string }>`
      SELECT coalesce(on_hand, 0) AS on_hand FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);
    return Number(r.rows[0]?.on_hand ?? 0);
  }

  /** ورود مستقیم موجودی — این تست درباره خرید نیست. */
  async function stockUp(variationId: string, qty: number, cost: number): Promise<void> {
    await sql`
      SELECT platform.set_actor(${"00000000-0000-7000-8000-0000000000f1"}::uuid);
      `.execute(handle.db);
    await sql`
      SELECT inventory.apply_movement(
        ${variationId}::uuid, ${STORE_WH}::uuid, ${String(qty)}::platform.qty,
        'opening', NULL, NULL, NULL, ${String(cost)}::platform.money)`
      .execute(handle.db);
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [keeper, "انباردار شمارش", "warehouse"],
      [cashier, "صندوق‌دار شمارش", "cashier"],
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

    const product = await handle.db
      .insertInto("catalog.product")
      .values({
        code: `P-${suffix}`,
        name_internal: "کالای تست شمارش",
        name_web: null,
        tax_rate_code: "standard",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    barcodeA = "2000000000015";
    for (const [sku, barcode, color] of [
      [`SKU-${suffix}-A`, barcodeA, "مشکی"],
      [`SKU-${suffix}-B`, "2000000000022", "سفید"],
    ] as const) {
      const v = await handle.db
        .insertInto("catalog.variation")
        .values({
          product_id: product.id,
          sku,
          barcode,
          color,
          size: "L",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (barcode === barcodeA) variationA = v.id;
      else variationB = v.id;
    }

    await stockUp(variationA, 10, 1_000_000);
    await stockUp(variationB, 10, 1_000_000);

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

  test("صندوق‌دار انبارگردانی نمی‌کند", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "POST",
      url: "/stock-counts",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH },
    });
    // شمارش قفسه موجودی را **بدون سند خرید** عوض می‌کند: کسی که
    // می‌تواند بشمارد، می‌تواند کسری را پنهان کند.
    assert.equal(r.statusCode, 403, r.body);
  });

  test("برگه تازه شماره ندارد و موجودی سیستم را نشان نمی‌دهد", async () => {
    const s = await loginAs(keeper);
    const sheet = await newSheet();
    assert.equal(sheet.number, null, "پیش‌نویس نباید شماره بگیرد");

    const r = await app.inject({
      method: "PUT",
      url: `/stock-counts/${sheet.id}/lines`,
      ...s,
      payload: { barcode: barcodeA, countedQty: "7" },
    });
    assert.equal(r.statusCode, 200, r.body);

    const line = (r.json() as CountBody).lines[0];
    assert.equal(line?.countedQty, "7.000");
    // این ادعا قلب طراحی است: عدد سیستم پیش از ثبت **وجود ندارد**.
    // اگر روزی اینجا عددی بیاید، یعنی جایی پیش از ثبت خوانده شده.
    assert.equal(line?.systemQty, null, "موجودی سیستم نباید پیش از ثبت خوانده شود");
    assert.equal(line?.diffQty, null);
  });

  test("شمارش مطلق است: اسکن دوباره جمع نمی‌شود", async () => {
    const s = await loginAs(keeper);
    const sheet = await newSheet();

    for (const qty of ["3", "5"]) {
      const r = await app.inject({
        method: "PUT",
        url: `/stock-counts/${sheet.id}/lines`,
        ...s,
        payload: { variationId: variationA, countedQty: qty },
      });
      assert.equal(r.statusCode, 200, r.body);
    }

    const after = (await app.inject({
      method: "GET",
      url: `/stock-counts/${sheet.id}`,
      ...s,
    })).json() as CountBody;

    assert.equal(after.lines.length, 1, "یک کالا، یک سطر");
    // «دوباره شمردم و ۵ تاست»، نه «۳ به‌علاوه ۵».
    assert.equal(after.lines[0]?.countedQty, "5.000");
  });

  test("ثبت: کسری، سند، و موجودی نهایی", async () => {
    const s = await loginAs(keeper);
    const before = await onHand(variationA);
    const sheet = await newSheet();

    await app.inject({
      method: "PUT",
      url: `/stock-counts/${sheet.id}/lines`,
      ...s,
      payload: { variationId: variationA, countedQty: String(before - 2) },
    });

    const posted = await app.inject({
      method: "POST",
      url: `/stock-counts/${sheet.id}/post`,
      ...s,
    });
    assert.equal(posted.statusCode, 200, posted.body);

    const body = posted.json() as CountBody;
    assert.match(body.number ?? "", /^C-\d{4}-\d{6}$/, `شماره نگرفت: ${body.number}`);
    assert.equal(body.status, "posted");

    const line = body.lines[0];
    assert.equal(Number(line?.systemQty), before, "موجودی سیستم در لحظه ثبت پر شد");
    assert.equal(Number(line?.diffQty), -2);
    assert.equal(await onHand(variationA), before - 2);

    // کسری بدهکار ۵۱۰۳، بستانکار ۱۳۰۱ — و سند متوازن.
    const entry = await sql<{ shortage: string; diff: string }>`
      SELECT coalesce(sum(l.debit) FILTER (WHERE l.account_code = '5103'), 0) AS shortage,
             coalesce(sum(l.debit) - sum(l.credit), 0) AS diff
        FROM ledger.journal_entry e
        JOIN ledger.journal_line l ON l.entry_id = e.id
       WHERE e.ref_type = 'stock_count' AND e.ref_id = ${sheet.id}::uuid`
      .execute(handle.db);
    assert.equal(entry.rows[0]?.shortage, "2000000", "کسری روی حساب ۵۱۰۳");
    assert.equal(entry.rows[0]?.diff, "0", "سند نامتوازن");
  });

  test("کالای شمرده‌نشده دست نمی‌خورد", async () => {
    const s = await loginAs(keeper);
    const beforeB = await onHand(variationB);
    const sheet = await newSheet();

    await app.inject({
      method: "PUT",
      url: `/stock-counts/${sheet.id}/lines`,
      ...s,
      payload: { variationId: variationA, countedQty: "1" },
    });
    await app.inject({ method: "POST", url: `/stock-counts/${sheet.id}/post`, ...s });

    // انبارگردانی جزئی کار عادی است. اگر نبودِ سطر «صفر» تعبیر شود،
    // اولین شمارش جزئی کل انبار را پاک می‌کند.
    assert.equal(await onHand(variationB), beforeB);
  });

  test("برگه ثبت‌شده تغییر نمی‌کند", async () => {
    const s = await loginAs(keeper);
    const sheet = await newSheet();
    await app.inject({
      method: "PUT",
      url: `/stock-counts/${sheet.id}/lines`,
      ...s,
      payload: { variationId: variationB, countedQty: "9" },
    });
    await app.inject({ method: "POST", url: `/stock-counts/${sheet.id}/post`, ...s });

    const edit = await app.inject({
      method: "PUT",
      url: `/stock-counts/${sheet.id}/lines`,
      ...s,
      payload: { variationId: variationA, countedQty: "1" },
    });
    assert.equal(edit.statusCode, 409, edit.body);
    assert.equal(edit.json().error.code, "count_posted");
  });

  test("ثبت دوباره با همان کلید، موجودی را دو بار تعدیل نمی‌کند", async () => {
    const s = await loginAs(keeper);
    const sheet = await newSheet();
    await app.inject({
      method: "PUT",
      url: `/stock-counts/${sheet.id}/lines`,
      ...s,
      payload: { variationId: variationB, countedQty: "4" },
    });

    const key = `count-post-${suffix}-${Math.random()}`;
    const headers = { ...s.headers, "idempotency-key": key };

    const first = await app.inject({
      method: "POST",
      url: `/stock-counts/${sheet.id}/post`,
      ...s,
      headers,
    });
    const second = await app.inject({
      method: "POST",
      url: `/stock-counts/${sheet.id}/post`,
      ...s,
      headers,
    });

    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().replayed, true);
    assert.equal(await onHand(variationB), 4, "Replay نباید دوباره تعدیل کند");
  });

  test("برگه بدون سطر ثبت نمی‌شود و شماره نمی‌سوزاند", async () => {
    const s = await loginAs(keeper);
    const sheet = await newSheet();
    const r = await app.inject({ method: "POST", url: `/stock-counts/${sheet.id}/post`, ...s });
    assert.equal(r.statusCode, 422, r.body);

    const again = (await app.inject({
      method: "GET",
      url: `/stock-counts/${sheet.id}`,
      ...s,
    })).json() as CountBody;
    assert.equal(again.number, null);
  });

  test("ابطال پیش‌نویس", async () => {
    const s = await loginAs(keeper);
    const sheet = await newSheet();
    const r = await app.inject({ method: "POST", url: `/stock-counts/${sheet.id}/cancel`, ...s });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((r.json() as CountBody).status, "cancelled");
  });
});
