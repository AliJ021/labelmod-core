import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * گزارش کمبود موجودی (۱۰۴) — بازبینی root روی پستگرس واقعی:
 *
 * ۱. **یک snapshot.** آستانه، شمار کل و سطرها در یک دستور SQL. آزمون یک plugin روی Kysely می‌گذارد که پس
 *    از **هر** دستورِ گزارش، موجودی یک تنوع را با حرکت واقعی (`count_adjust`) به درون یا بیرون کمبود
 *    می‌برد. با دستورهای جدا (نسخهٔ پیشین) شمار و سطرها از هم جدا می‌شدند؛ حالا ممکن نیست.
 * ۲. **بیش از یک صفحه در یک انبار.** ۲٬۱۰۱ تنوع کم‌موجود در **همان** انبار: صفحه‌ها همه را بی‌تکرار
 *    می‌دهند و CSV کامل است؛ بی بها و فقط‌خواندنی.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql, type KyselyPlugin } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { ReportService } from "../src/reports/service.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";
const BRANCH = "00000000-0000-7000-8000-000000000001";
const MANY = 2101;

describe("گزارش کمبود موجودی: یک snapshot و صفحه‌بندی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  let wh = "";
  let flip = "";
  const suffix = `ls${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-گزارش-کمبود-موجودی-بلند";
  const admin = `lsadm_${suffix}`;
  let adminId = "";
  let auth: { cookies: Record<string, string>; headers: Record<string, string> };

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    owner = createDb(disposable.ownerUrl, 2);
    const u = await handle.db.insertInto("identity.app_user").values({ username: admin, full_name: "مدیر", password_hash: await hashSecret(PASSWORD),
      is_active: true, mobile: null, pin_hash: null, totp_secret: null }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: "admin", branch_id: BRANCH }).execute();
    adminId = u.id;
    // انبار فروش تازه و جدا تا شمارها فقط همین سناریو باشند.
    wh = (await sql<{ id: string }>`INSERT INTO inventory.warehouse (branch_id, code, name, kind)
      VALUES (${BRANCH}::uuid, ${"LS-" + suffix}, 'انبار کمبود', 'stock') RETURNING id::text`.execute(owner.db)).rows[0]!.id;
    await sql.raw(`DO $fx$
    DECLARE u uuid := '${adminId}'; w uuid := '${wh}'; p uuid; v uuid;
    BEGIN
      PERFORM platform.set_actor(u);
      INSERT INTO catalog.product (code, name_internal) VALUES ('P-${suffix}', 'جوراب') RETURNING id INTO p;
      FOR i IN 1..${MANY} LOOP
        INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'رنگ' || i, 'M', '${suffix}-' || i) RETURNING id INTO v;
        PERFORM inventory.apply_movement(v, w, 1, 'opening', p_user => u, p_unit_cost => 1000);
      END LOOP;
      -- تنوعی که موجودی‌اش میان دستورها جابه‌جا می‌شود: ۱۰ عدد، بیرون از کمبود (آستانه ۲).
      INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'متغیر', 'L', '${suffix}-flip') RETURNING id INTO v;
      PERFORM inventory.apply_movement(v, w, 10, 'opening', p_user => u, p_unit_cost => 1000);
    END $fx$`).execute(owner.db);
    flip = (await sql<{ id: string }>`SELECT id::text FROM catalog.variation WHERE sku = ${suffix + "-flip"}`.execute(owner.db)).rows[0]!.id;
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    const r = await loginWithMfa(app, { method: "POST", url: "/auth/login",
      payload: { username: admin, password: PASSWORD, deviceFingerprint: `fp-${suffix}` } });
    assert.equal(r.statusCode, 200, r.body);
    const c = (k: string) => r.cookies.find((x) => x.name === k)?.value ?? "";
    auth = { cookies: { labelmod_session: c("labelmod_session"), labelmod_csrf: c("labelmod_csrf") }, headers: { "x-csrf-token": c("labelmod_csrf") } };
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  /** حرکت واقعی موجودی (با سند مرجع) از اتصال دیگر و Commit‌شده. */
  const move = async (qty: number) => sql`SELECT platform.set_actor(${adminId}::uuid),
      inventory.apply_movement(${flip}::uuid, ${wh}::uuid, ${qty}, 'count_adjust', 'test', gen_random_uuid(), ${adminId}::uuid, 1000)`
    .execute(owner.db);

  test("تغییر هم‌زمان موجودی میان دستورها شمار و سطرها را از هم جدا نمی‌کند (یک دستور، یک snapshot)", async () => {
    let statements = 0;
    let low = false;
    // پس از هر دستورِ گزارش، تنوع «متغیر» یک بار به درون و بار بعد به بیرون کمبود می‌رود.
    const interleave: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        statements++;
        await move(low ? 10 : -10);
        low = !low;
        return args.result;
      },
    };
    const reports = new ReportService(handle.db.withPlugin(interleave));
    for (let round = 0; round < 4; round++) {
      const out = await reports.lowStock({ branchId: BRANCH, warehouseId: wh, page: 1, pageSize: null });
      assert.equal(out.rows.length, out.total, `دور ${round}: شمار کل = سطرهای خروجی کامل`);
      assert.equal(out.truncated, false);
      assert.equal(out.total === MANY + 1, out.rows.some((r) => r.variationId === flip), `دور ${round}: «متغیر» در شمار و سطرها هم‌حال`);
    }
    assert.equal(statements, 4, "هر گزارش دقیقاً یک دستور SQL است");
    if (low) await move(10);
  });

  test("بیش از یک صفحه در **یک** انبار: صفحه‌ها همه را بی‌تکرار می‌دهند؛ CSV کامل؛ بی بها؛ فقط‌خواندنی", async () => {
    const moves = async () => (await sql<{ n: string }>`SELECT count(*)::text AS n FROM inventory.stock_movement`.execute(owner.db)).rows[0]!.n;
    const before = await moves();
    const get = (q: string) => app.inject({ method: "GET", url: `/reports/low-stock?warehouseId=${wh}${q}`, ...auth });
    const p1 = await get("");
    assert.equal(p1.statusCode, 200, p1.body);
    const a = p1.json();
    assert.deepEqual({ total: a.total, page: a.page, pages: a.pages, n: a.rows.length, truncated: a.truncated },
      { total: MANY, page: 1, pages: 2, n: 2000, truncated: true });
    const b = (await get("&page=2")).json();
    assert.deepEqual({ total: b.total, page: b.page, n: b.rows.length }, { total: MANY, page: 2, n: MANY - 2000 });
    const seen = new Set([...a.rows, ...b.rows].map((r: { variationId: string }) => r.variationId));
    assert.equal(seen.size, MANY, "دو صفحه همهٔ موارد را بی‌تکرار دارند");
    const beyond = (await get("&page=3")).json();
    assert.deepEqual({ total: beyond.total, n: beyond.rows.length }, { total: MANY, n: 0 }, "صفحهٔ بیرون از بازه خالی است، نه شمار صفر");
    const csv = await get("&format=csv");
    assert.equal(csv.statusCode, 200);
    const lines = csv.body.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    assert.equal(lines.length, MANY + 1, "CSV کامل: سرآیند + همهٔ موارد همین انبار");
    assert.doesNotMatch(lines[0]!, /بها|ارزش|cost/i, "بی ستون بها");
    assert.ok(!JSON.stringify(a.rows[0]).match(/cost|value/i), "JSON بی بها");
    assert.equal(await moves(), before, "گزارش چیزی ننوشت");
    // دامنه دست نخورد: صفحه پارامتر نامعتبر نمی‌پذیرد.
    assert.equal((await get("&page=0")).statusCode, 400);
  });

  test("same-name warehouses: tied variations retain a unique order across pages and full export", async () => {
    // Warehouse names are not unique. The row identity includes BOTH warehouse and variation.
    // Duplicate this fixture in another same-name warehouse, plus a singleton before the pairs,
    // so a 2,000-row page boundary cuts through one pair of otherwise identical sort keys.
    const second = (await sql<{ id: string }>`INSERT INTO inventory.warehouse (branch_id, code, name, kind)
      VALUES (${BRANCH}::uuid, ${"LS-TIE-" + suffix}, 'انبار کمبود', 'stock') RETURNING id::text`.execute(owner.db)).rows[0]!.id;
    await sql`SELECT platform.set_actor(${adminId}::uuid)`.execute(owner.db);
    await sql`SELECT inventory.apply_movement(variation_id, ${second}::uuid, 1, 'opening',
        p_user => ${adminId}::uuid, p_unit_cost => 1000)
      FROM inventory.stock_balance WHERE warehouse_id = ${wh}::uuid AND variation_id <> ${flip}::uuid`.execute(owner.db);
    await move(-10);
    const reports = new ReportService(handle.db);
    const full = await reports.lowStock({ branchId: BRANCH, warehouseId: undefined, page: 1, pageSize: null });
    assert.equal(full.total, MANY * 2 + 1);
    const key = (r: { variationId: string; warehouseId: string }) => `${r.variationId}/${r.warehouseId}`;
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      pages.push(...(await reports.lowStock({ branchId: BRANCH, warehouseId: undefined, page, pageSize: 2000 })).rows);
    }
    assert.equal(new Set(pages.map(key)).size, full.total, "no duplicated/omitted warehouse-variation across pages");
    assert.equal(pages.length, full.rows.length, "pagination and full export have the same length");
    assert.equal(pages.findIndex((row, i) => key(row) !== key(full.rows[i]!)), -1,
      "pagination and full export have the same complete order");
    const grouped = new Map<string, string[]>();
    for (const row of full.rows) grouped.set(row.variationId, [...(grouped.get(row.variationId) ?? []), row.warehouseId]);
    for (const ids of grouped.values()) {
      assert.deepEqual(ids, [...ids].sort(), "warehouse identity breaks identical name/variation ties");
    }
  });
});
