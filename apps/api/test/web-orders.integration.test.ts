import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * «سفارش‌های سایت» — مجوز، دامنه و پیکربندی **پیش از** هر درخواست بیرونی، روی پستگرس واقعی.
 *
 * خوانندهٔ سایت ساختگی است و فراخوان‌هایش شمرده می‌شوند. ادعای اصلی این است که هیچ نقش بی‌مجوز،
 * شعبهٔ بیرون از دامنه، ورودی نامعتبر یا پیکربندی ناقص به سایت نمی‌رسد. قرارداد خود افزونه و امضا در
 * `woocommerce-orders.test.ts` است، و رفتار روی ووکامرس واقعی (HPOS و legacy) در
 * `integrations/woocommerce/test/real-wc/orders_view.php`.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import type { WooOrdersReader, WooOrdersSite } from "../src/platform/woocommerce-orders.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";
const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";
const SITE = "https://shop.example.test";

describe("سفارش‌های سایت — مسیر Core", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  const suffix = `w${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-سفارش‌های-سایت-و-به‌قدر-کافی-بلند";
  const users = { admin: `wadm_${suffix}`, supervisor: `wsup_${suffix}`, accountant: `wacc_${suffix}`, outsider: `wout_${suffix}` };
  const calls: { kind: "page" | "order"; site: WooOrdersSite; arg: unknown }[] = [];
  const reader: WooOrdersReader = {
    async page(site, page, status) {
      calls.push({ kind: "page", site, arg: { page, status } });
      return { state: "ready", page, perPage: 20, status, total: 1, pages: 1, orders: [{
        id: 41, number: "41", status: "processing", createdAt: "2026-10-20T08:00:00Z", totalRial: "12000000", itemCount: 2,
        customerName: "مشتری", paymentMethod: "زرین‌پال",
        core: { paymentConfirmed: true, recorded: false, invoiceNumber: null, attempts: 1, hasError: true, stopped: false },
      }] };
    },
    async order(site, orderId) {
      calls.push({ kind: "order", site, arg: orderId });
      return orderId === 404 ? { state: "not_found" } : { state: "unavailable", code: "network", message: "اتصال کامل نشد" };
    },
  };
  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, { method: "POST", url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` } });
    assert.equal(r.statusCode, 200, r.body);
    const csrf = r.cookies.find(c => c.name === "labelmod_csrf")?.value ?? "";
    const out = { cookies: { labelmod_session: r.cookies.find(c => c.name === "labelmod_session")?.value ?? "", labelmod_csrf: csrf }, headers: { "x-csrf-token": csrf } };
    sessions.set(username, out);
    return out;
  }
  const get = async (username: string | null, url: string) =>
    app.inject({ method: "GET", url, ...(username ? await loginAs(username) : {}) });
  async function set(key: string, value: unknown) {
    await sql`SELECT platform.set_setting(${key}, ${JSON.stringify(value)}::jsonb, 'تست', ${SYSTEM_USER}::uuid)`.execute(owner.db);
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    owner = createDb(disposable.ownerUrl, 2);
    const other = (await sql<{ id: string }>`INSERT INTO platform.branch (code, name) VALUES (${"WO-B2-" + suffix}, 'شعبهٔ دوم') RETURNING id`
      .execute(owner.db)).rows[0]!.id;
    const hash = await hashSecret(PASSWORD);
    for (const [username, role, branch] of [[users.admin, "admin", BRANCH], [users.supervisor, "supervisor", BRANCH],
      [users.accountant, "accountant", BRANCH], [users.outsider, "admin", other]] as const) {
      const u = await handle.db.insertInto("identity.app_user").values({ username, full_name: `کاربر ${role}`, password_hash: hash,
        is_active: true, mobile: null, pin_hash: null, totp_secret: null }).returning("id").executeTakeFirstOrThrow();
      await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: role, branch_id: branch }).execute();
    }
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db), wooOrders: reader,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", WEB_PUSH_SECRET: "synthetic-orders-secret" }) });
    await app.ready();
  });

  beforeEach(async () => {
    calls.length = 0;
    await set("web.site_url", SITE);
    await set("web.stock_warehouse", "STORE");
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  test("Seed: فقط مدیر مجوز دیدن دارد؛ نقش‌های دیگر سطر «رد» صریح دارند", async () => {
    const rows = await sql<{ role_code: string; allowed: boolean }>`
      SELECT role_code, allowed FROM identity.permission_rule WHERE operation = 'web.orders.view' ORDER BY role_code`.execute(handle.db);
    const roles = await sql<{ n: number }>`SELECT count(*)::int AS n FROM identity.role`.execute(handle.db);
    assert.equal(rows.rows.length, roles.rows[0]!.n, "هر نقش یک سطر");
    assert.deepEqual(rows.rows.filter(r => r.allowed).map(r => r.role_code), ["admin"]);
  });

  test("مدیر: فهرست از همان سایت و دامنهٔ انبار سایت؛ بی‌کش", async () => {
    const r = await get(users.admin, "/web/orders?page=2&status=processing");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["cache-control"], "no-store");
    const body = r.json();
    assert.equal(body.state, "ready");
    assert.equal(body.orders[0].totalRial, "12000000", "پول رشته");
    assert.ok(Date.parse(body.fetchedAt) > 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { kind: "page", arg: { page: 2, status: "processing" },
      site: { siteUrl: SITE, secret: "synthetic-orders-secret", branchId: BRANCH, warehouseId: STORE_WH } });
  });

  test("جزئیات: «پیدا نشد» و «نامعلوم» جدا می‌مانند", async () => {
    let r = await get(users.admin, "/web/orders/404");
    assert.deepEqual({ status: r.statusCode, state: r.json().state }, { status: 200, state: "not_found" });
    r = await get(users.admin, "/web/orders/7");
    assert.equal(r.json().state, "unavailable");
    assert.equal(r.json().code, "network");
    assert.deepEqual(calls.map(c => c.arg), [404, 7]);
  });

  test("بی مجوز، بی نشست یا بیرون از دامنه: هیچ درخواستی به سایت نمی‌رود", async () => {
    for (const user of [users.supervisor, users.accountant]) {
      const r = await get(user, "/web/orders");
      assert.equal(r.statusCode, 403, `${user}: ${r.body}`);
      assert.equal((await get(user, "/web/orders/1")).statusCode, 403);
    }
    assert.equal((await get(null, "/web/orders")).statusCode, 401);
    // مدیرِ شعبهٔ دیگر مجوز دارد ولی انبار سایت بیرون از دامنهٔ اوست.
    assert.equal((await get(users.outsider, "/web/orders")).statusCode, 403);
    assert.equal((await get(users.outsider, "/web/orders/1")).statusCode, 403);
    assert.equal(calls.length, 0);
  });

  test("ورودی نامعتبر پیش از سایت رد می‌شود", async () => {
    for (const url of ["/web/orders?page=0", "/web/orders?page=201", "/web/orders?status=trash", "/web/orders?status=wc-processing",
      "/web/orders?perPage=-1", "/web/orders?limit=-1", "/web/orders/0", "/web/orders/abc", "/web/orders/-1"]) {
      assert.equal((await get(users.admin, url)).statusCode, 400, url);
    }
    assert.equal(calls.length, 0);
  });

  test("پیکربندی ناقص: «نامعلوم» با دلیل، نه فهرست خالی، و بی درخواست", async () => {
    await set("web.stock_warehouse", "");
    let r = await get(users.admin, "/web/orders");
    assert.deepEqual({ state: r.json().state, code: r.json().code }, { state: "unavailable", code: "warehouse" });
    await set("web.stock_warehouse", "STORE");
    await set("web.site_url", "");
    r = await get(users.admin, "/web/orders/5");
    assert.deepEqual({ state: r.json().state, code: r.json().code }, { state: "unavailable", code: "site_url" });
    assert.equal(r.json().orders, undefined);
    assert.equal(calls.length, 0);
  });
});
