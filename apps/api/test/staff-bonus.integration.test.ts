/**
 * دفتر پاداش پرسنل از راه HTTP — مهاجرت ۰۹۸.
 *
 * دو مسیر: درخواست کارمند → تأیید/رد مدیر، و اعطای مستقیم مدیر؛ سپس تسویهٔ
 * گروهی. هر کاربر فقط پاداش خودش را می‌بیند؛ مدیر مجاز (`bonus.*`، نه نام
 * نقش) دفتر همه را در دامنهٔ شعبه می‌بیند. **هیچ** اثری بر دفتر، انبار،
 * خزانه، شیفت یا صف پیام نمی‌ماند — با شمارش، نه با فرض.
 *
 * با `LMC_TEST_DB_ROLE=app` همین پرونده زیر نقش محدود تولیدی اجرا می‌شود.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const A = "00000000-0000-7000-8000-000000000001";
type Actor = { id: string; cookies: Record<string, string>; headers: Record<string, string> };
type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type Bonus = { id: string; status: string; amount: string; origin: string; owner: { id: string } };

describe("دفتر پاداش پرسنل", { skip: DATABASE_URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  let branchB: string;
  let cashier: Actor, cashierB: Actor, otherCashier: Actor, supervisor: Actor, accountant: Actor, gm: Actor, gm2: Actor, gmA: Actor;
  let serial = 0;
  let footprintBefore: string;
  let requestAddress = "127.0.0.1";

  async function actor(role: string, branch: string | null): Promise<Actor> {
    const username = `bn_${randomUUID().slice(0, 8)}`;
    const password = `bonus-fixture-${randomUUID()}`;
    const user = await owner.db.insertInto("identity.app_user").values({ username, full_name: `آزمون ${role} ${++serial}`,
      password_hash: await hashSecret(password), is_active: true, mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await owner.db.insertInto("identity.user_role").values({ user_id: user.id, role_code: role, branch_id: branch }).execute();
    const login = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: `127.0.6.${++serial}`,
      payload: { username, password } });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = Object.fromEntries(login.cookies.map(c => [c.name, c.value]));
    return { id: user.id, cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
  }

  function call(who: Actor, method: Method, url: string, payload?: unknown, key?: string | null) {
    const headers = { ...who.headers, ...(key ? { "idempotency-key": key } : {}) };
    return app.inject({ method, url, remoteAddress: requestAddress, cookies: who.cookies, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  }
  async function request(who: Actor, amount: string, reason: string): Promise<Bonus> {
    const res = await call(who, "POST", "/bonuses", { amount, reason }, randomUUID());
    assert.equal(res.statusCode, 201, res.body);
    return res.json().bonus;
  }
  async function award(by: Actor, to: Actor, amount: string, reason: string): Promise<Bonus> {
    const res = await call(by, "POST", "/bonuses/awards", { ownerId: to.id, amount, reason }, randomUUID());
    assert.equal(res.statusCode, 201, res.body);
    return res.json().bonus;
  }
  const decide = (by: Actor, id: string, decision: string, note?: string, key = randomUUID()) =>
    call(by, "POST", `/bonuses/${id}/decisions`, note === undefined ? { decision } : { decision, note }, key);
  const settle = (by: Actor, items: string[], note = "تسویهٔ دفتر؛ بی اثر مالی", key = randomUUID()) =>
    call(by, "POST", "/bonuses/settlements", { items, note }, key);
  async function count(table: string, id: string) {
    return (await sql<{ n: number }>`SELECT count(*)::int n FROM ${sql.table(`identity.${table}`)} WHERE bonus_id=${id}::uuid`
      .execute(owner.db)).rows[0]!.n;
  }
  async function footprint(): Promise<string> {
    const r = await sql<{ f: string }>`SELECT concat_ws('|',
      (SELECT count(*) FROM ledger.journal_entry), (SELECT count(*) FROM ledger.journal_line),
      (SELECT count(*) FROM inventory.stock_movement), (SELECT count(*) FROM inventory.stock_balance),
      (SELECT count(*) FROM treasury.transaction), (SELECT count(*) FROM treasury.payment),
      (SELECT count(*) FROM sales.cash_shift), (SELECT count(*) FROM sales.invoice),
      (SELECT count(*) FROM platform.outbox_message)) AS f`.execute(owner.db);
    return r.rows[0]!.f;
  }

  before(async () => {
    const made = createDisposableDb(DATABASE_URL!);
    assert.ok(made); disposable = made;
    handle = createDb(disposable.url, 8);
    owner = createDb(disposable.ownerUrl, 2);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    branchB = (await owner.db.insertInto("platform.branch").values({ code: `bn-${randomUUID()}`,
      name: "شعبهٔ دوم آزمون پاداش", is_active: true }).returning("id").executeTakeFirstOrThrow()).id;
    cashier = await actor("cashier", A); cashierB = await actor("cashier", branchB); otherCashier = await actor("cashier", A);
    supervisor = await actor("supervisor", A); accountant = await actor("accountant", null);
    gm = await actor("admin", null); gm2 = await actor("admin", null); gmA = await actor("admin", A);
    footprintBefore = await footprint();
  });
  after(async () => { await app?.close(); await handle?.close(); await owner?.close(); disposable?.drop(); });

  test("نگهبان‌های مستقیم SQL حتی با نقش مالک دفتر پاداش", async () => {
    await owner.db.connection().execute(async connection => {
      const script = readFileSync(new URL("../../../db/test/staff-bonus.sql", import.meta.url), "utf8").replace(/^\\set ON_ERROR_STOP on\r?$/m, "");
      try { await sql.raw(script).execute(connection); }
      finally { await sql`ROLLBACK`.execute(connection); }
    });
  });

  test("درخواست: هر کارمند برای خودش؛ ذی‌نفع از نشست؛ ورودی نامعتبر و بی کلید رد", async () => {
    for (const who of [cashier, supervisor, accountant]) {
      const b = await request(who, "500000", "فروش بالا");
      assert.deepEqual([b.owner.id, b.status, b.origin, b.amount], [who.id, "pending", "request", "500000"]);
    }
    const spoof = await call(cashier, "POST", "/bonuses", { amount: "10", reason: "x", ownerId: gm.id }, randomUUID());
    assert.equal(spoof.statusCode, 400, spoof.body);
    const noKey = await call(cashier, "POST", "/bonuses", { amount: "10", reason: "x" }, null);
    assert.equal(noKey.statusCode, 400); assert.equal(noKey.json().error.code, "idempotency_key_required");
    for (const body of [{ amount: "0", reason: "x" }, { amount: "-5", reason: "x" }, { amount: "12.5", reason: "x" },
      { amount: 100, reason: "x" }, { amount: "100", reason: "  " }, { amount: "100" }, { amount: "1".repeat(19), reason: "x" },
      { amount: "100", reason: "a‮b" }]) {
      const res = await call(cashier, "POST", "/bonuses", body, randomUUID());
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)} → ${res.body}`);
    }
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM identity.staff_bonus WHERE owner_id=${gm.id}::uuid`
      .execute(owner.db)).rows[0]!.n, 0);
  });

  test("درخواست تکراری با همان کلید Replay است؛ کلید کاربر دیگر لو نمی‌رود", async () => {
    const key = randomUUID();
    const first = await call(cashier, "POST", "/bonuses", { amount: "250000", reason: "شب عید" }, key);
    const again = await call(cashier, "POST", "/bonuses", { amount: "250000", reason: "شب عید" }, key);
    assert.equal(first.statusCode, 201, first.body); assert.equal(again.statusCode, 200);
    assert.equal(again.json().replayed, true); assert.equal(again.json().bonus.id, first.json().bonus.id);
    assert.equal((await call(cashier, "POST", "/bonuses", { amount: "260000", reason: "شب عید" }, key)).statusCode, 409);
    assert.equal((await call(cashier, "GET", `/bonuses/mine/by-key/${key}`)).json().status, "recorded");
    assert.equal((await call(otherCashier, "GET", `/bonuses/mine/by-key/${key}`)).json().status, "not_found");
    assert.equal((await call(otherCashier, "POST", "/bonuses", { amount: "250000", reason: "شب عید" }, key)).statusCode, 409);
  });

  test("کارمند فقط پاداش خودش را می‌بیند؛ مسیرهای مدیر برای غیرمدیر کل بسته‌اند", async () => {
    const mine = await request(cashier, "300000", "پاداش من");
    const list = await call(otherCashier, "GET", "/bonuses/mine");
    assert.ok(list.json().items.every((i: Bonus) => i.owner.id === otherCashier.id));
    assert.equal((await call(otherCashier, "GET", `/bonuses/mine/${mine.id}`)).statusCode, 404);
    assert.equal((await call(cashier, "GET", `/bonuses/mine/${mine.id}`)).json().status, "pending");
    for (const who of [cashier, supervisor, accountant]) {
      for (const url of ["/bonuses", `/bonuses/${mine.id}`, "/bonuses/owners", "/bonuses/beneficiaries", "/bonuses/selection"]) {
        assert.equal((await call(who, "GET", url)).statusCode, 403, `${url}`);
      }
      assert.equal((await decide(who, mine.id, "approved")).statusCode, 403);
      assert.equal((await call(who, "POST", "/bonuses/awards", { ownerId: otherCashier.id, amount: "1", reason: "x" }, randomUUID())).statusCode, 403);
      assert.equal((await settle(who, [mine.id])).statusCode, 403);
    }
    assert.equal(await count("staff_bonus_decision", mine.id), 0);
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      assert.equal((await call(gm, method, `/bonuses/${mine.id}`, method === "DELETE" ? undefined : { amount: "1" })).statusCode, 404);
    }
  });

  test("مسیر درخواست: تأیید با حسابرسی، Replay یکتا، تصمیم دوم «قدیمی»", async () => {
    const b = await request(cashier, "400000", "فروش ویژه");
    const key = randomUUID();
    const ok = await decide(gm, b.id, "approved", undefined, key);
    assert.equal(ok.statusCode, 200, ok.body); assert.equal(ok.json().bonus.status, "approved");
    const replay = await decide(gm, b.id, "approved", undefined, key);
    assert.equal(replay.json().replayed, true); assert.equal(await count("staff_bonus_decision", b.id), 1);
    const second = await decide(gm2, b.id, "rejected", "دیر");
    assert.equal(second.statusCode, 409); assert.equal(second.json().error.code, "bonus_stale");
    const audit = (await sql<{ before: { status: string }; after: { status: string }; actor_id: string }>`SELECT before, after, actor_id
      FROM platform.audit_log WHERE action='bonus.approve' AND entity_id=${b.id}`.execute(owner.db)).rows;
    assert.deepEqual(audit.map(a => [a.before.status, a.after.status, a.actor_id]), [["pending", "approved", gm.id]]);
    const own = await call(cashier, "GET", `/bonuses/mine/${b.id}`);
    assert.equal(own.json().status, "approved"); assert.ok(own.json().decidedBy);
  });

  test("رد: دلیل اجباری؛ ردشده تسویه نمی‌شود", async () => {
    const b = await request(cashier, "120000", "درخواست ضعیف");
    assert.equal((await decide(gm, b.id, "rejected")).statusCode, 400);
    assert.equal((await decide(gm, b.id, "rejected", "  ")).statusCode, 400);
    assert.equal((await decide(gm, b.id, "paid", "x")).statusCode, 400);
    const res = await decide(gm, b.id, "rejected", "خارج از سیاست");
    assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().bonus.decisionNote, "خارج از سیاست");
    const s = await settle(gm, [b.id]);
    assert.equal(s.statusCode, 409, s.body); assert.equal(await count("staff_bonus_settlement", b.id), 0);
  });

  test("تصمیم هم‌زمان: یکی می‌نشیند، دیگری «قدیمی»", async () => {
    const b = await request(cashierB, "77000", "هم‌زمان");
    const [one, two] = await Promise.all([decide(gm, b.id, "approved"), decide(gm2, b.id, "rejected", "رد")]);
    assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 409], `${one.body} / ${two.body}`);
    assert.equal(await count("staff_bonus_decision", b.id), 1);
  });

  test("جداسازی وظایف: نه بررسی درخواست خود، نه اعطا به خود، نه تسویهٔ پاداش خود", async () => {
    const own = await request(gm, "60000", "درخواست مدیر");
    const self = await decide(gm, own.id, "approved");
    assert.equal(self.statusCode, 422, self.body); assert.equal(self.json().error.code, "bonus_self");
    const detail = await call(gm, "GET", `/bonuses/${own.id}`);
    assert.equal(detail.json().canManage, false);
    const selfAward = await call(gm, "POST", "/bonuses/awards", { ownerId: gm.id, amount: "1", reason: "x" }, randomUUID());
    assert.equal(selfAward.statusCode, 422); assert.equal(selfAward.json().error.code, "bonus_self");
    assert.equal((await decide(gm2, own.id, "approved")).statusCode, 200);
    const sel = await call(gm, "GET", "/bonuses/selection");
    assert.ok(!sel.json().items.some((i: Bonus) => i.id === own.id), "پاداش خود در انتخاب همه نیست");
    const selfSettle = await settle(gm, [own.id]);
    assert.equal(selfSettle.statusCode, 422); assert.equal(await count("staff_bonus_settlement", own.id), 0);
    assert.equal((await settle(gm2, [own.id])).statusCode, 200);
    const bens = (await call(gm, "GET", "/bonuses/beneficiaries")).json().beneficiaries as { id: string }[];
    assert.ok(!bens.some(b => b.id === gm.id)); assert.ok(bens.some(b => b.id === cashier.id));
  });

  test("مسیر اعطا: مستقیم تأییدشده، دامنه، کارمند فعال، Replay و بررسی با کلید", async () => {
    const key = randomUUID();
    const body = { ownerId: cashier.id, amount: "350000", reason: "رضایت مشتری" };
    const first = await call(gm, "POST", "/bonuses/awards", body, key);
    assert.equal(first.statusCode, 201, first.body);
    const b = first.json().bonus as Bonus;
    assert.deepEqual([b.origin, b.status, b.owner.id], ["award", "approved", cashier.id]);
    const again = await call(gm, "POST", "/bonuses/awards", body, key);
    assert.equal(again.statusCode, 200); assert.equal(again.json().bonus.id, b.id);
    assert.equal((await call(gm, "POST", "/bonuses/awards", { ...body, amount: "1" }, key)).statusCode, 409);
    assert.equal((await call(gm, "GET", `/bonuses/awards/by-key/${key}`)).json().status, "recorded");
    assert.equal((await call(gm2, "GET", `/bonuses/awards/by-key/${key}`)).json().status, "not_found");
    assert.equal((await decide(gm2, b.id, "rejected", "x")).statusCode, 409, "اعطا بررسی ندارد");
    assert.equal((await call(cashier, "GET", `/bonuses/mine/${b.id}`)).json().status, "approved");
    const audit = await sql<{ n: number }>`SELECT count(*)::int n FROM platform.audit_log WHERE action='bonus.award'
      AND entity_id=${b.id} AND actor_id=${gm.id}::uuid AND after->>'ownerId'=${cashier.id}`.execute(owner.db);
    assert.equal(audit.rows[0]!.n, 1);
    // دامنه: مدیر شعبهٔ اصلی به شعبهٔ دوم و سراسری اعطا نمی‌کند.
    for (const to of [cashierB, accountant]) {
      const res = await call(gmA, "POST", "/bonuses/awards", { ownerId: to.id, amount: "1", reason: "x" }, randomUUID());
      assert.equal(res.statusCode, 404, res.body);
    }
    assert.equal((await call(gm, "POST", "/bonuses/awards", { ownerId: randomUUID(), amount: "1", reason: "x" }, randomUUID())).statusCode, 404);
    const inactive = await actor("cashier", A);
    await owner.db.updateTable("identity.app_user").set({ is_active: false }).where("id", "=", inactive.id).execute();
    assert.equal((await call(gm, "POST", "/bonuses/awards", { ownerId: inactive.id, amount: "1", reason: "x" }, randomUUID())).statusCode, 404);
    assert.equal((await call(gmA, "POST", "/bonuses/awards", { ownerId: otherCashier.id, amount: "1", reason: "در دامنه" }, randomUUID())).statusCode, 201);
  });

  test("دامنهٔ شعبه در دفتر مدیر، جزئیات، فیلتر وضعیت و کارمند", async () => {
    const inB = await request(cashierB, "70000", "شعبهٔ دوم");
    const global = await request(accountant, "80000", "سراسری");
    const inA = await request(otherCashier, "90000", "شعبهٔ اصلی");
    const all: Bonus[] = [];
    for (let p = 1; ; p++) {
      const res = await call(gmA, "GET", `/bonuses?page=${p}&pageSize=100`);
      assert.equal(res.statusCode, 200, res.body);
      all.push(...res.json().items);
      if (res.json().items.length < 100) break;
    }
    assert.ok(all.some(i => i.id === inA.id));
    assert.ok(!all.some(i => i.id === inB.id || i.id === global.id));
    for (const id of [inB.id, global.id]) {
      assert.equal((await call(gmA, "GET", `/bonuses/${id}`)).statusCode, 404);
      assert.equal((await decide(gmA, id, "approved")).statusCode, 404);
    }
    assert.equal((await call(gm, "GET", `/bonuses/${global.id}`)).statusCode, 200);
    const pending = await call(gm, "GET", `/bonuses?status=pending&ownerId=${otherCashier.id}`);
    assert.ok(pending.json().items.length >= 1);
    assert.ok(pending.json().items.every((i: Bonus) => i.status === "pending" && i.owner.id === otherCashier.id));
    assert.equal((await call(gm, "GET", "/bonuses?status=paid")).statusCode, 400);
    assert.equal((await call(gm, "GET", "/bonuses?pageSize=1000")).statusCode, 400);
  });

  test("نشست بازشده با PIN دفتر مدیر را نمی‌بیند ولی درخواست خود را ثبت می‌کند", async () => {
    await owner.db.updateTable("identity.session").set({ pin_unlocked: true }).where("user_id", "=", gm.id).execute();
    try {
      assert.equal((await call(gm, "GET", "/bonuses")).statusCode, 403);
      assert.equal((await call(gm, "POST", "/bonuses/awards", { ownerId: cashier.id, amount: "1", reason: "x" }, randomUUID())).statusCode, 403);
      const b = await request(gm, "11000", "با PIN");
      assert.equal(b.owner.id, gm.id);
    } finally {
      await owner.db.updateTable("identity.session").set({ pin_unlocked: false }).where("user_id", "=", gm.id).execute();
    }
  });

  test("تسویهٔ گروهی: هر دو مسیر، بازپخش یکتا، بررسی با کلید و حسابرسی", async () => {
    requestAddress = "127.0.7.1";
    const r = await request(cashier, "101", "گروهی درخواست");
    assert.equal((await decide(gm, r.id, "approved")).statusCode, 200);
    const a = await award(gm, cashier, "999999999999999999", "گروهی اعطا");
    const key = randomUUID();
    const result = await settle(gm, [a.id, r.id], "تسویهٔ مهر", key);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().count, 2); assert.equal(result.json().totalAmount, "1000000000000000100");
    const replay = await settle(gm, [r.id, a.id], "تسویهٔ مهر", key);
    assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().replayed, true, "ترتیب انتخاب هویت را عوض نمی‌کند");
    assert.equal(replay.json().batchId, result.json().batchId);
    assert.equal((await settle(gm, [a.id, r.id], "تغییر", key)).statusCode, 409);
    assert.equal((await call(gm, "GET", `/bonuses/settlements/by-key/${key}`)).json().status, "recorded");
    assert.equal((await call(gm2, "GET", `/bonuses/settlements/by-key/${key}`)).json().status, "not_found");
    for (const id of [r.id, a.id]) {
      const own = await call(cashier, "GET", `/bonuses/mine/${id}`);
      assert.equal(own.json().status, "settled"); assert.equal(own.json().settlementNote, "تسویهٔ مهر");
    }
    const events = await sql<{ n: number }>`SELECT count(*)::int n FROM platform.audit_log WHERE action='bonus.settle'
      AND entity_id IN (${r.id}, ${a.id}) AND before->>'status'='approved' AND after->>'status'='settled'`.execute(owner.db);
    assert.equal(events.rows[0]!.n, 2);
    const sel = await call(gm, "GET", `/bonuses/selection?ownerId=${cashier.id}`);
    assert.ok(sel.json().items.every((i: Bonus) => i.status === "approved" && i.id !== r.id && i.id !== a.id));
  });

  test("تسویهٔ گروهی اتمیک: انتخاب کهنه، خارج دامنه یا در انتظار، هیچ‌کدام را تسویه نمی‌کند", async () => {
    requestAddress = "127.0.7.2";
    const ok = await award(gm, cashier, "101", "اتمیک");
    const foreign = await award(gm, cashierB, "202", "شعبهٔ دوم");
    const pending = await request(otherCashier, "303", "در انتظار");
    const mixed = await settle(gmA, [ok.id, foreign.id]);
    assert.equal(mixed.statusCode, 404, mixed.body);
    const withPending = await settle(gm, [ok.id, pending.id]);
    assert.equal(withPending.statusCode, 409, withPending.body); assert.equal(withPending.json().error.code, "bonus_stale");
    assert.equal(await count("staff_bonus_settlement", ok.id), 0, "همه یا هیچ");
    assert.equal((await settle(gm, [ok.id, ok.id])).statusCode, 400);
    assert.equal((await settle(gm, [ok.id, randomUUID()])).statusCode, 404);
    assert.equal(await count("staff_bonus_settlement", ok.id), 0);
    await owner.db.updateTable("identity.session").set({ pin_unlocked: true }).where("user_id", "=", gm.id).execute();
    try { assert.equal((await settle(gm, [ok.id])).statusCode, 403); }
    finally { await owner.db.updateTable("identity.session").set({ pin_unlocked: false }).where("user_id", "=", gm.id).execute(); }
    // انتخاب کهنه: یک بار تسویه، تلاش دوم با کلید تازه «قدیمی».
    const concurrent = await Promise.all([settle(gm, [ok.id, foreign.id]), settle(gm2, [foreign.id, ok.id])]);
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200, 409], concurrent.map(r => r.body).join(" / "));
    assert.equal(await count("staff_bonus_settlement", ok.id), 1);
    assert.equal(await count("staff_bonus_settlement", foreign.id), 1);
    const stale = await settle(gm, [ok.id]);
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, "bonus_stale");
  });

  test("بازپخش پس از تغییر دامنهٔ مدیر جزئیات را لو نمی‌دهد؛ نگهبان SQL تغییر را رد می‌کند", async () => {
    requestAddress = "127.0.7.3";
    const manager = await actor("admin", A);
    const b = await award(gm, cashier, "103", "دامنه");
    const key = randomUUID();
    assert.equal((await settle(manager, [b.id], "تسویه", key)).statusCode, 200);
    const dKey = randomUUID();
    const pending = await request(cashier, "104", "تصمیم دامنه");
    assert.equal((await decide(manager, pending.id, "approved", undefined, dKey)).statusCode, 200);
    await owner.db.updateTable("identity.user_role").set({ branch_id: branchB }).where("user_id", "=", manager.id).execute();
    assert.equal((await settle(manager, [b.id], "تسویه", key)).statusCode, 404);
    assert.equal((await call(manager, "GET", `/bonuses/settlements/by-key/${key}`)).statusCode, 404);
    const replayDecision = await decide(manager, pending.id, "approved", undefined, dKey);
    assert.equal(replayDecision.statusCode, 404, replayDecision.body); assert.equal(replayDecision.json().bonus, undefined);
    await assert.rejects(sql`UPDATE identity.staff_bonus_settlement SET note='تغییر' WHERE bonus_id=${b.id}::uuid`.execute(owner.db), /فقط قابل درج/);
    await assert.rejects(sql`DELETE FROM identity.staff_bonus_decision WHERE bonus_id=${pending.id}::uuid`.execute(owner.db), /فقط قابل درج/);
    await assert.rejects(sql`UPDATE identity.staff_bonus SET amount=1 WHERE id=${b.id}::uuid`.execute(owner.db), /فقط قابل درج/);
    const unrecorded = await award(gm, cashier, "105", "رد مستقیم");
    await assert.rejects(owner.db.transaction().execute(async trx => {
      await sql`SELECT platform.set_actor(${cashier.id}::uuid)`.execute(trx);
      await sql`INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note)
        VALUES(${unrecorded.id}::uuid,${randomUUID()}::uuid,${cashier.id}::uuid,'غیرمجاز')`.execute(trx);
    }), /bonus\.manage|خود را/);
  });

  test("بدون نشست ۴۰۱؛ و هیچ اثر مالی پس از همهٔ مسیرها", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/bonuses/mine" })).statusCode, 401);
    assert.equal(await footprint(), footprintBefore, "دفتر، انبار، خزانه، شیفت، فاکتور و صف دست‌نخورده");
    const rules = await sql<{ n: number }>`SELECT count(*)::int n FROM ledger.posting_rule WHERE event_type ILIKE '%bonus%'`.execute(owner.db);
    assert.equal(rules.rows[0]!.n, 0);
  });
});
