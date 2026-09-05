/**
 * تست یکپارچه انتقال بین انبارها — روی پستگرس واقعی.
 *
 * تست SQL ثابت می‌کند ارزش موجودی دست‌نخورده می‌ماند. این پرونده دو
 * چیز دیگر را می‌سنجد که فقط با راندن مسیر واقعی دیده می‌شوند:
 *
 * ۱. **دامنه شعبه روی هر دو انبار.** انتقالی که فقط مبدأش سنجیده
 *    شود، راهی است برای بیرون‌بردن کالا به انباری که کاربر نمی‌بیند.
 *
 * ۲. **ثبت دوباره کالا را دو بار جابه‌جا نمی‌کند.** دو لایه دارد —
 *    کلید Idempotency و خودِ `post_transfer` — و هر دو سنجیده می‌شوند.
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

interface TransferJson {
  id: string;
  number: string | null;
  status: string;
  lineCount: number;
  totalQty: string;
  lines: Array<{ id: string; variationId: string; qty: string; unitCost: string | null }>;
}

describe("انتقال بین انبارها", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-انتقال-و-به‌قدر-کافی-بلند";
  const keeper = `tkeep_${suffix}`;
  const cashier = `tcash_${suffix}`;
  let keeperId = "";
  let variationId = "";
  let backWh = "";
  let otherBranchWh = "";

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

  /** موجودی یک انبار — از `stock_balance`، نه از جمع دوباره حرکت‌ها. */
  async function onHand(warehouseId: string): Promise<number> {
    const r = await sql<{ q: string }>`
      SELECT coalesce(on_hand, 0)::text AS q FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${warehouseId}::uuid
    `.execute(handle.db);
    return Number(r.rows[0]?.q ?? "0");
  }

  async function totalValue(): Promise<bigint> {
    const r = await sql<{ v: string }>`
      SELECT coalesce(sum(total_value), 0)::text AS v FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid
    `.execute(handle.db);
    return BigInt(r.rows[0]?.v ?? "0");
  }

  async function newDraft(from = STORE_WH, to?: string): Promise<string> {
    const s = await loginAs(keeper);
    const r = await app.inject({
      method: "POST",
      url: "/transfers",
      ...s,
      payload: {
        branchId: BRANCH,
        fromWarehouseId: from,
        toWarehouseId: to ?? backWh,
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    return (JSON.parse(r.body) as { id: string }).id;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [keeper, "انباردار انتقال", "warehouse"],
      [cashier, "صندوق‌دار انتقال", "cashier"],
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
      if (role === "warehouse") keeperId = u.id;
    }

    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${keeperId}::uuid)`.execute(trx);

      const back = await sql<{ id: string }>`
        INSERT INTO inventory.warehouse (branch_id, code, name, kind)
        VALUES (${BRANCH}::uuid, ${`WH-${suffix}`}, 'انبار پشتیبان', 'stock')
        RETURNING id`.execute(trx);
      backWh = back.rows[0]!.id;

      // انبار یک شعبه **دیگر** — برای سنجش دروازه دامنه.
      const otherBranch = await sql<{ id: string }>`
        INSERT INTO platform.branch (code, name)
        VALUES (${`B-${suffix}`}, 'شعبه دیگر') RETURNING id`.execute(trx);
      const other = await sql<{ id: string }>`
        INSERT INTO inventory.warehouse (branch_id, code, name, kind)
        VALUES (${otherBranch.rows[0]!.id}::uuid, ${`WHX-${suffix}`}, 'انبار شعبه دیگر', 'stock')
        RETURNING id`.execute(trx);
      otherBranchWh = other.rows[0]!.id;

      const prod = await sql<{ id: string }>`
        INSERT INTO catalog.product (code, name_internal)
        VALUES (${`P-${suffix}`}, 'کالای انتقال') RETURNING id`.execute(trx);
      const v = await sql<{ id: string }>`
        INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (${prod.rows[0]!.id}, 'طوسی', 'L', ${`SKU-${suffix}`}) RETURNING id`
        .execute(trx);
      variationId = v.rows[0]!.id;
      await sql`SELECT catalog.set_price(${variationId}::uuid, 900000)`.execute(trx);
      // نرخی که تقسیمش باقی‌مانده دارد — عمداً.
      await sql`SELECT inventory.apply_movement(
                  ${variationId}::uuid, ${STORE_WH}::uuid, 30, 'purchase_receipt',
                  NULL, NULL, ${keeperId}::uuid, 333333)`.execute(trx);
    });

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

  test("صندوق‌دار انتقال ثبت نمی‌کند", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "POST",
      url: "/transfers",
      ...s,
      payload: { branchId: BRANCH, fromWarehouseId: STORE_WH, toWarehouseId: backWh },
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  test("انبار مقصدِ شعبه دیگر رد می‌شود — نه فقط مبدأ", async () => {
    // **ادعای مرکزی این پرونده.** دروازه‌ای که فقط مبدأ را بسنجد،
    // راهی است برای بیرون‌بردن کالا به انباری که کاربر نمی‌بیند.
    const s = await loginAs(keeper);
    const r = await app.inject({
      method: "POST",
      url: "/transfers",
      ...s,
      payload: { branchId: BRANCH, fromWarehouseId: STORE_WH, toWarehouseId: otherBranchWh },
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.match(JSON.parse(r.body).error.message as string, /شعبه/);
  });

  test("انتقال به همان انبار ۴۲۲ می‌گیرد، نه ۵۰۰", async () => {
    const s = await loginAs(keeper);
    const r = await app.inject({
      method: "POST",
      url: "/transfers",
      ...s,
      payload: { branchId: BRANCH, fromWarehouseId: STORE_WH, toWarehouseId: STORE_WH },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(JSON.parse(r.body).error.code, "same_warehouse");
  });

  test("چرخه کامل: پیش‌نویس، قلم، ثبت — و ارزش دست‌نخورده", async () => {
    const before = await totalValue();
    const beforeStore = await onHand(STORE_WH);

    const id = await newDraft();
    const s = await loginAs(keeper);

    const line = await app.inject({
      method: "POST",
      url: `/transfers/${id}/lines`,
      ...s,
      payload: { variationId, qty: "7" },
    });
    assert.equal(line.statusCode, 201, line.body);
    const draft = JSON.parse(line.body) as TransferJson;
    assert.equal(draft.status, "draft");
    assert.equal(draft.number, null, "پیش‌نویس شماره نمی‌سوزاند");
    assert.equal(draft.lines[0]?.unitCost, null, "بها تا لحظه ثبت معلوم نیست");

    // اسکن دوباره همان کالا = جمع، نه سطر دوم.
    const again = await app.inject({
      method: "POST",
      url: `/transfers/${id}/lines`,
      ...s,
      payload: { variationId, qty: "3" },
    });
    assert.equal(again.statusCode, 201, again.body);
    const merged = JSON.parse(again.body) as TransferJson;
    assert.equal(merged.lineCount, 1, "یک سطر، نه دو تا");
    assert.equal(Number(merged.totalQty), 10);

    // تا اینجا هیچ کالایی جابه‌جا نشده.
    assert.equal(await onHand(STORE_WH), beforeStore, "پیش‌نویس موجودی را دست نمی‌زند");

    const post = await app.inject({
      method: "POST",
      url: `/transfers/${id}/post`,
      ...s,
      payload: {},
    });
    assert.equal(post.statusCode, 200, post.body);
    const posted = JSON.parse(post.body) as TransferJson & { replayed: boolean };
    assert.equal(posted.status, "posted");
    assert.match(posted.number as string, /^TR-1405-/, "شماره در لحظه ثبت");
    assert.equal(posted.replayed, false);
    assert.ok(posted.lines[0]?.unitCost !== null, "بها پس از ثبت نوشته شد");

    assert.equal(await onHand(STORE_WH), beforeStore - 10);
    assert.equal(await onHand(backWh), 10);
    // **ارزش کل دقیقاً همان است** — انتقال سندی نمی‌زند، پس اگر ارزش
    // عوض شود هیچ‌جا طرف حسابی ندارد.
    assert.equal(await totalValue(), before, "جمع ارزش موجودی تغییر نکرد");
  });

  test("ثبت دوباره، کالا را دو بار جابه‌جا نمی‌کند", async () => {
    const id = await newDraft();
    const s = await loginAs(keeper);
    await app.inject({
      method: "POST",
      url: `/transfers/${id}/lines`,
      ...s,
      payload: { variationId, qty: "4" },
    });

    const beforeStore = await onHand(STORE_WH);
    const first = await app.inject({
      method: "POST",
      url: `/transfers/${id}/post`,
      ...s,
      payload: {},
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await app.inject({
      method: "POST",
      url: `/transfers/${id}/post`,
      ...s,
      payload: {},
    });
    // کلید از خودِ برگه ساخته می‌شود، پس تلاش دوم Replay است نه اثر دوم.
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((JSON.parse(second.body) as { replayed: boolean }).replayed, true);
    assert.equal(await onHand(STORE_WH), beforeStore - 4, "فقط یک بار جابه‌جا شد");
  });

  test("برگه ثبت‌شده دیگر عوض نمی‌شود", async () => {
    const id = await newDraft();
    const s = await loginAs(keeper);
    const line = await app.inject({
      method: "POST",
      url: `/transfers/${id}/lines`,
      ...s,
      payload: { variationId, qty: "2" },
    });
    const lineId = (JSON.parse(line.body) as TransferJson).lines[0]!.id;
    await app.inject({ method: "POST", url: `/transfers/${id}/post`, ...s, payload: {} });

    for (const [method, url] of [
      ["POST", `/transfers/${id}/lines`],
      ["PATCH", `/transfers/${id}/lines/${lineId}`],
      ["DELETE", `/transfers/${id}/lines/${lineId}`],
      ["DELETE", `/transfers/${id}`],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        ...s,
        payload: method === "POST" ? { variationId, qty: "1" } : { qty: "5" },
      });
      assert.equal(r.statusCode, 409, `${method} ${url} → ${r.body}`);
    }
  });

  test("انتقال کالایی که در مبدأ نیست، رد می‌شود و برگه پیش‌نویس می‌ماند", async () => {
    const id = await newDraft(backWh, STORE_WH);
    const s = await loginAs(keeper);
    await app.inject({
      method: "POST",
      url: `/transfers/${id}/lines`,
      ...s,
      payload: { variationId, qty: "9999" },
    });
    const r = await app.inject({
      method: "POST",
      url: `/transfers/${id}/post`,
      ...s,
      payload: {},
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(JSON.parse(r.body).error.message as string, /موجودی/);

    const still = await app.inject({ method: "GET", url: `/transfers/${id}`, ...s });
    assert.equal((JSON.parse(still.body) as TransferJson).status, "draft");
    assert.equal((JSON.parse(still.body) as TransferJson).number, null, "شماره نسوخت");
  });

  test("فهرست فقط برگه‌های شعبه خود کاربر را می‌دهد", async () => {
    const s = await loginAs(keeper);
    const r = await app.inject({ method: "GET", url: "/transfers", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as { transfers: Array<{ branchId: string }> }).transfers;
    assert.ok(rows.length > 0);
    for (const t of rows) assert.equal(t.branchId, BRANCH);
  });
});
