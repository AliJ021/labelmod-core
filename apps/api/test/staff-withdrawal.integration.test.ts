/**
 * دفتر برداشت پرسنل از راه HTTP — مهاجرت ۰۸۴.
 *
 * هر کاربر فقط برداشت خودش را می‌سازد و می‌بیند؛ مدیر کل (مجوز اختصاصی
 * `withdrawal.*`، نه نام نقش و نه یک مجوز پهن بی‌ربط) دفتر همه را در
 * دامنهٔ شعبه می‌بیند و با شرط نسخه اصلاح می‌کند. و **هیچ** اثری بر دفتر،
 * انبار، خزانه، شیفت یا صف پیام نمی‌ماند — با شمارش، نه با فرض.
 *
 * با `LMC_TEST_DB_ROLE=app` همین پرونده زیر نقش محدود تولیدی اجرا می‌شود.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

describe("دفتر برداشت پرسنل", { skip: DATABASE_URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  let branchB: string;
  let cashier: Actor, cashierB: Actor, otherCashier: Actor, supervisor: Actor, accountant: Actor, gm: Actor, gmA: Actor;
  let serial = 0;
  let footprintBefore: string;

  async function actor(role: string, branch: string | null): Promise<Actor> {
    const username = `wd_${randomUUID().slice(0, 8)}`;
    const password = `withdrawal-fixture-${randomUUID()}`;
    const user = await owner.db.insertInto("identity.app_user").values({ username, full_name: `آزمون ${role} ${++serial}`,
      password_hash: await hashSecret(password), is_active: true, mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await owner.db.insertInto("identity.user_role").values({ user_id: user.id, role_code: role, branch_id: branch }).execute();
    const login = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: `127.0.4.${++serial}`,
      payload: { username, password } });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = Object.fromEntries(login.cookies.map(c => [c.name, c.value]));
    return { id: user.id, cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
  }

  function call(who: Actor, method: Method, url: string, payload?: unknown, key?: string | null) {
    const headers = { ...who.headers, ...(key ? { "idempotency-key": key } : {}) };
    return app.inject({ method, url, cookies: who.cookies, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  }
  async function create(who: Actor, amount: string, reason: string) {
    const res = await call(who, "POST", "/withdrawals", { amount, reason }, randomUUID());
    assert.equal(res.statusCode, 201, res.body);
    return res.json().withdrawal as { id: string; version: number; amount: string; owner: { id: string } };
  }
  async function footprint(): Promise<string> {
    const r = await sql<{ f: string }>`SELECT concat_ws('|',
      (SELECT count(*) FROM ledger.journal_entry), (SELECT count(*) FROM ledger.journal_line),
      (SELECT count(*) FROM inventory.stock_movement), (SELECT count(*) FROM inventory.stock_balance),
      (SELECT count(*) FROM treasury.transaction), (SELECT count(*) FROM treasury.payment),
      (SELECT count(*) FROM sales.cash_shift), (SELECT count(*) FROM platform.outbox_message)) AS f`.execute(owner.db);
    return r.rows[0]!.f;
  }
  async function rows(id: string) {
    return (await sql<{ n: number }>`SELECT count(*)::int n FROM identity.staff_withdrawal_revision WHERE withdrawal_id=${id}::uuid`
      .execute(owner.db)).rows[0]!.n;
  }

  before(async () => {
    const made = createDisposableDb(DATABASE_URL!);
    assert.ok(made); disposable = made;
    handle = createDb(disposable.url, 8);
    owner = createDb(disposable.ownerUrl, 2);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
    branchB = (await owner.db.insertInto("platform.branch").values({ code: `wd-${randomUUID()}`,
      name: "شعبهٔ دوم آزمون برداشت", is_active: true }).returning("id").executeTakeFirstOrThrow()).id;
    cashier = await actor("cashier", A); cashierB = await actor("cashier", branchB); otherCashier = await actor("cashier", A);
    supervisor = await actor("supervisor", A); accountant = await actor("accountant", null);
    gm = await actor("admin", null); gmA = await actor("admin", A);
    footprintBefore = await footprint();
  });
  after(async () => { await app?.close(); await handle?.close(); await owner?.close(); disposable?.drop(); });

  test("کارمند هر نقشی برداشت خودش را ثبت می‌کند؛ مالک از نشست، نه از بدنه", async () => {
    for (const who of [cashier, supervisor, accountant]) {
      const w = await create(who, "1500000", "پیش‌پرداخت");
      assert.equal(w.owner.id, who.id);
      assert.equal(w.amount, "1500000");
      assert.equal(w.version, 1);
    }
    const spoof = await call(cashier, "POST", "/withdrawals", { amount: "10", reason: "x", ownerId: gm.id }, randomUUID());
    assert.equal(spoof.statusCode, 400, spoof.body);
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM identity.staff_withdrawal WHERE owner_id=${gm.id}::uuid`
      .execute(owner.db)).rows[0]!.n, 0);
  });

  test("ورودی نامعتبر و بی شناسهٔ عملیات رد می‌شود", async () => {
    const before = (await sql<{ n: number }>`SELECT count(*)::int n FROM identity.staff_withdrawal`.execute(owner.db)).rows[0]!.n;
    const noKey = await call(cashier, "POST", "/withdrawals", { amount: "10", reason: "x" }, null);
    assert.equal(noKey.statusCode, 400); assert.equal(noKey.json().error.code, "idempotency_key_required");
    for (const body of [{ amount: "0", reason: "x" }, { amount: "-5", reason: "x" }, { amount: "12.5", reason: "x" },
      { amount: 100, reason: "x" }, { amount: "100", reason: "   " }, { amount: "1".repeat(19), reason: "x" },
      { amount: "100", reason: "x".repeat(501) }, { amount: "100", reason: "a‮b" }]) {
      const res = await call(cashier, "POST", "/withdrawals", body, randomUUID());
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)} → ${res.body}`);
    }
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM identity.staff_withdrawal`.execute(owner.db)).rows[0]!.n, before);
  });

  test("ثبت تکراری با همان کلید، Replay است نه ثبت دوم", async () => {
    const key = randomUUID();
    const first = await call(cashier, "POST", "/withdrawals", { amount: "250000", reason: "ناهار" }, key);
    const again = await call(cashier, "POST", "/withdrawals", { amount: "250000", reason: "ناهار" }, key);
    assert.equal(first.statusCode, 201, first.body); assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().replayed, true);
    assert.equal(again.json().withdrawal.id, first.json().withdrawal.id);
    const changed = await call(cashier, "POST", "/withdrawals", { amount: "260000", reason: "ناهار" }, key);
    assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, "idempotency_key_reused");
    const stolen = await call(otherCashier, "POST", "/withdrawals", { amount: "250000", reason: "ناهار" }, key);
    assert.equal(stolen.statusCode, 409, "کلید کاربر دیگر Replay نمی‌شود");
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM identity.staff_withdrawal
      WHERE owner_id IN (${cashier.id}::uuid, ${otherCashier.id}::uuid) AND id IN
        (SELECT withdrawal_id FROM identity.staff_withdrawal_revision WHERE reason='ناهار')`.execute(owner.db)).rows[0]!.n, 1);
  });

  test("کاربر فقط برداشت خودش را می‌بیند؛ دفتر همه و اصلاح برای غیرمدیر کل بسته است", async () => {
    const mine = await create(cashier, "300000", "کرایه");
    const list = await call(otherCashier, "GET", "/withdrawals/mine");
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().items.every((i: { owner: { id: string } }) => i.owner.id === otherCashier.id));
    const peek = await call(otherCashier, "GET", `/withdrawals/mine/${mine.id}`);
    assert.equal(peek.statusCode, 404, peek.body);
    const own = await call(cashier, "GET", `/withdrawals/mine/${mine.id}`);
    assert.equal(own.statusCode, 200); assert.equal(own.json().history.length, 1);
    // سرپرست (مدیر غیرکل) و حسابدار با دامنهٔ همهٔ شعب، هیچ‌کدام مدیر کل نیستند.
    for (const who of [cashier, supervisor, accountant]) {
      assert.equal((await call(who, "GET", "/withdrawals")).statusCode, 403);
      assert.equal((await call(who, "GET", `/withdrawals/${mine.id}`)).statusCode, 403);
      const fix = await call(who, "POST", `/withdrawals/${mine.id}/corrections`,
        { expectedVersion: 1, amount: "0", reason: "کرایه", note: "اصلاح" }, randomUUID());
      assert.equal(fix.statusCode, 403, fix.body);
    }
    assert.equal(await rows(mine.id), 1);
    // هیچ مسیر ویرایش یا حذف مستقیم وجود ندارد.
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      assert.equal((await call(cashier, method, `/withdrawals/mine/${mine.id}`, method === "DELETE" ? undefined : { amount: "1" })).statusCode, 404);
      assert.equal((await call(gm, method, `/withdrawals/${mine.id}`, method === "DELETE" ? undefined : { amount: "1" })).statusCode, 404);
    }
  });

  test("مدیر کل: دفتر صفحه‌بندی‌شده، تاریخچه، اصلاح تا صفر با حسابرسی پیش/پس", async () => {
    const w = await create(cashier, "900000", "خرید لوازم");
    const log = await call(gm, "GET", "/withdrawals?page=1&pageSize=2");
    assert.equal(log.statusCode, 200, log.body);
    assert.equal(log.json().items.length, 2); assert.ok(log.json().total >= 5);
    assert.equal(log.json().items[0].id, w.id, "تازه‌ترین اول");
    const page2 = await call(gm, "GET", "/withdrawals?page=2&pageSize=2");
    assert.ok(!page2.json().items.some((i: { id: string }) => i.id === w.id));
    assert.equal((await call(gm, "GET", "/withdrawals?pageSize=1000")).statusCode, 400);

    const detail = await call(gm, "GET", `/withdrawals/${w.id}`);
    assert.equal(detail.statusCode, 200); assert.equal(detail.json().canCorrect, true);

    const key = randomUUID();
    const body = { expectedVersion: 1, amount: "0", reason: "خرید لوازم", note: "ثبت تکراری" };
    const fixed = await call(gm, "POST", `/withdrawals/${w.id}/corrections`, body, key);
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.equal(fixed.json().appliedVersion, 2);
    assert.equal(fixed.json().withdrawal.amount, "0");
    assert.deepEqual(fixed.json().withdrawal.history.map((h: { version: number; amount: string }) => [h.version, h.amount]),
      [[1, "900000"], [2, "0"]]);
    const replay = await call(gm, "POST", `/withdrawals/${w.id}/corrections`, body, key);
    assert.equal(replay.statusCode, 200); assert.equal(replay.json().replayed, true); assert.equal(replay.json().appliedVersion, 2);
    assert.equal(await rows(w.id), 2, "Replay نسخهٔ سوم نمی‌سازد");

    const audit = (await sql<{ before: Record<string, unknown>; after: Record<string, unknown>; actor_id: string; reason: string }>`
      SELECT before, after, actor_id, reason FROM platform.audit_log
      WHERE action='withdrawal.correct' AND entity_id=${w.id}`.execute(owner.db)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_id, gm.id); assert.equal(audit[0]!.reason, "ثبت تکراری");
    assert.deepEqual([audit[0]!.before.amount, audit[0]!.after.amount, audit[0]!.before.ownerId], ["900000", "0", cashier.id]);
    const ownView = await call(cashier, "GET", `/withdrawals/mine/${w.id}`);
    assert.equal(ownView.json().amount, "0", "مالک مقدار اصلاح‌شده و صفر را می‌بیند، نه «نامعلوم»");
    assert.equal(ownView.json().history[1].note, "ثبت تکراری");
    // مالک با اصلاح مدیر هم نمی‌تواند چیزی را عوض کند.
    assert.equal((await call(cashier, "POST", `/withdrawals/${w.id}/corrections`,
      { expectedVersion: 2, amount: "5", reason: "x", note: "y" }, randomUUID())).statusCode, 403);
  });

  test("اصلاح کهنه و هم‌زمان: یکی می‌نشیند، دیگری صریحاً «قدیمی» می‌گیرد", async () => {
    const w = await create(cashierB, "400000", "قسط");
    const stale = await call(gm, "POST", `/withdrawals/${w.id}/corrections`,
      { expectedVersion: 2, amount: "1", reason: "قسط", note: "x" }, randomUUID());
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, "withdrawal_stale");
    const [one, two] = await Promise.all([
      call(gm, "POST", `/withdrawals/${w.id}/corrections`, { expectedVersion: 1, amount: "100000", reason: "قسط", note: "اول" }, randomUUID()),
      call(gm, "POST", `/withdrawals/${w.id}/corrections`, { expectedVersion: 1, amount: "200000", reason: "قسط", note: "دوم" }, randomUUID()),
    ]);
    const codes = [one.statusCode, two.statusCode].sort();
    assert.deepEqual(codes, [200, 409], `${one.body} / ${two.body}`);
    const loser = one.statusCode === 409 ? one : two;
    assert.equal(loser.json().error.code, "withdrawal_stale");
    assert.equal(await rows(w.id), 2);
    const noChange = await call(gm, "POST", `/withdrawals/${w.id}/corrections`,
      { expectedVersion: 2, amount: (one.statusCode === 200 ? one : two).json().withdrawal.amount, reason: "قسط", note: "x" }, randomUUID());
    assert.equal(noChange.statusCode, 422); assert.equal(noChange.json().error.code, "withdrawal_no_change");
    const blankNote = await call(gm, "POST", `/withdrawals/${w.id}/corrections`,
      { expectedVersion: 2, amount: "1", reason: "قسط", note: "  " }, randomUUID());
    assert.equal(blankNote.statusCode, 400);
  });

  test("مدیر کل برداشت خودش را اصلاح نمی‌کند", async () => {
    const own = await create(gm, "50000", "برداشت مدیر");
    const detail = await call(gm, "GET", `/withdrawals/${own.id}`);
    assert.equal(detail.json().canCorrect, false);
    const res = await call(gm, "POST", `/withdrawals/${own.id}/corrections`,
      { expectedVersion: 1, amount: "0", reason: "برداشت مدیر", note: "x" }, randomUUID());
    assert.equal(res.statusCode, 403); assert.equal(res.json().error.code, "withdrawal_self_correction");
    assert.equal(await rows(own.id), 1);
  });

  test("دامنهٔ شعبه: مدیر کل شعبه‌ای فقط ثبت‌های شعبهٔ خودش را می‌بیند و اصلاح می‌کند", async () => {
    const inB = await create(cashierB, "70000", "شعبهٔ دوم");
    const global = await create(accountant, "80000", "سراسری");
    const inA = await create(otherCashier, "90000", "شعبهٔ اصلی");
    const all: { id: string }[] = [];
    for (let p = 1; ; p++) {
      const res = await call(gmA, "GET", `/withdrawals?page=${p}&pageSize=100`);
      assert.equal(res.statusCode, 200, res.body);
      all.push(...res.json().items);
      if (res.json().items.length < 100) break;
    }
    assert.ok(all.some(i => i.id === inA.id));
    assert.ok(!all.some(i => i.id === inB.id || i.id === global.id));
    for (const id of [inB.id, global.id]) {
      assert.equal((await call(gmA, "GET", `/withdrawals/${id}`)).statusCode, 404);
      const res = await call(gmA, "POST", `/withdrawals/${id}/corrections`,
        { expectedVersion: 1, amount: "0", reason: "x", note: "y" }, randomUUID());
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(await rows(id), 1);
    }
    const ok = await call(gmA, "POST", `/withdrawals/${inA.id}/corrections`,
      { expectedVersion: 1, amount: "0", reason: "شعبهٔ اصلی", note: "اصلاح در دامنه" }, randomUUID());
    assert.equal(ok.statusCode, 200, ok.body);
    const viaGlobal = await call(gm, "GET", `/withdrawals/${global.id}`);
    assert.equal(viaGlobal.statusCode, 200);
  });

  test("نشست بازشده با PIN دفتر مدیر را نمی‌بیند ولی برداشت خود را ثبت می‌کند", async () => {
    await owner.db.updateTable("identity.session").set({ pin_unlocked: true }).where("user_id", "=", gm.id).execute();
    try {
      assert.equal((await call(gm, "GET", "/withdrawals")).statusCode, 403);
      const w = await create(gm, "11000", "با PIN");
      assert.equal(w.owner.id, gm.id);
    } finally {
      await owner.db.updateTable("identity.session").set({ pin_unlocked: false }).where("user_id", "=", gm.id).execute();
    }
  });

  test("بدون نشست: ۴۰۱؛ و هیچ اثر مالی", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/withdrawals/mine" })).statusCode, 401);
    assert.equal(await footprint(), footprintBefore, "دفتر، انبار، خزانه، شیفت و صف دست‌نخورده");
  });
});
