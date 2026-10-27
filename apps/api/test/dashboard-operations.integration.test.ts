import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * کارهای عملیاتی داشبورد (دستهٔ D) — شیفت، چک و دریافتنی یک شعبه، روی پستگرس واقعی و فقط‌خواندنی.
 * هر عدد در برابر سناریویی سنجیده می‌شود که مرزهایش را دارد: شعبهٔ دیگر، سند پیش‌نویس، ماندهٔ صفر،
 * چک وصول‌شده و چک دور، شیفت دیروز و شیفت بسته‌شدهٔ دیروز.
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
const BANK = "00000000-0000-7000-8000-000000000202";

describe("کارهای عملیاتی داشبورد", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let owner: DbHandle;
  let app: FastifyInstance;
  let other = "";
  const suffix = `o${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-کارهای-عملیاتی-و-به‌قدر-کافی-بلند";
  const users = { admin: `oadm_${suffix}`, supervisor: `osup_${suffix}`, cashier: `ocash_${suffix}` };
  const ids: Record<string, string> = {};
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
  const get = async (username: string, branchId = BRANCH) =>
    app.inject({ method: "GET", url: `/dashboard/operations?branchId=${branchId}`, ...(await loginAs(username)) });

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    owner = createDb(disposable.ownerUrl, 2);
    const hash = await hashSecret(PASSWORD);
    for (const [username, role] of [[users.admin, "admin"], [users.supervisor, "supervisor"], [users.cashier, "cashier"]] as const) {
      const u = await handle.db.insertInto("identity.app_user").values({ username, full_name: `کاربر ${role}`, password_hash: hash,
        is_active: true, mobile: null, pin_hash: null, totp_secret: null }).returning("id").executeTakeFirstOrThrow();
      await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: role, branch_id: BRANCH }).execute();
      ids[role] = u.id;
    }
    other = (await sql<{ id: string }>`INSERT INTO platform.branch (code, name) VALUES (${"OPS-B2-" + suffix}, 'شعبهٔ دوم') RETURNING id`
      .execute(owner.db)).rows[0]!.id;
    // شعبهٔ تازه شمارندهٔ سند ندارد؛ همان الگوی db/test/dashboard-period.sql.
    await sql`INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
      SELECT ${other}::uuid, doc_type, fiscal_year, prefix FROM platform.document_counter WHERE branch_id = ${BRANCH}::uuid`.execute(owner.db);
    // سناریو در یک بلوک، با کاربر عامل؛ فقط از دروازه‌های خودِ دفتر و چک (post_entry، post_cheque_event).
    await sql.raw(`DO $fx$
    DECLARE
      u uuid := '${ids.admin}'; br uuid := '${BRANCH}'; b2 uuid := '${other}';
      c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid; s1 uuid; ch uuid;
      today date := platform.business_date();
    BEGIN
      PERFORM platform.set_actor(u);
      INSERT INTO sales.customer (mobile_normalized, full_name) VALUES ('09120000101','طلب‌دار') RETURNING id INTO c1;
      INSERT INTO sales.customer (mobile_normalized, full_name) VALUES ('09120000102','بستانکار') RETURNING id INTO c2;
      INSERT INTO sales.customer (mobile_normalized, full_name) VALUES ('09120000103','شعبهٔ دیگر') RETURNING id INTO c3;
      INSERT INTO sales.customer (mobile_normalized, full_name) VALUES ('09120000104','پیش‌نویس') RETURNING id INTO c4;
      INSERT INTO sales.customer (mobile_normalized, full_name) VALUES ('09120000105','تسویه') RETURNING id INTO c5;
      INSERT INTO sales.customer (mobile_normalized, full_name) VALUES ('09120000106','صاحب چک') RETURNING id INTO c6;
      INSERT INTO purchasing.supplier (code, name) VALUES ('S-OPS','تأمین‌کنندهٔ آزمون') RETURNING id INTO s1;
      -- c1: فروش نسیهٔ ۳۰۰٬۰۰۰ در همین شعبه → طلب ۳۰۰٬۰۰۰
      PERFORM ledger.post_entry('sale_shift', br, today, 'نسیه',
        jsonb_build_array(jsonb_build_object('leg','receivable','amount',300000,'party_type','customer','party_id',c1),
          jsonb_build_object('leg','sales','amount',300000)), 'test', c1, u);
      -- c2: نسیهٔ ۱۰۰٬۰۰۰ و دریافت ۱۵۰٬۰۰۰ → اعتبار ۵۰٬۰۰۰
      PERFORM ledger.post_entry('sale_shift', br, today, 'نسیه',
        jsonb_build_array(jsonb_build_object('leg','receivable','amount',100000,'party_type','customer','party_id',c2),
          jsonb_build_object('leg','sales','amount',100000)), 'test', c2, u);
      PERFORM ledger.post_entry('customer_receipt', br, today, 'دریافت',
        jsonb_build_array(jsonb_build_object('leg','to_account','amount',150000),
          jsonb_build_object('leg','receivable','amount',150000,'party_type','customer','party_id',c2)), 'test', c2, u);
      -- c3: طلب در شعبهٔ دیگر → بیرون از این شعبه
      PERFORM ledger.post_entry('sale_shift', b2, today, 'نسیه',
        jsonb_build_array(jsonb_build_object('leg','receivable','amount',70000,'party_type','customer','party_id',c3),
          jsonb_build_object('leg','sales','amount',70000)), 'test', c3, u);
      -- c4: سند پیش‌نویس → هنوز در دفتر نیست
      PERFORM ledger.post_entry('sale_shift', br, today, 'پیش‌نویس',
        jsonb_build_array(jsonb_build_object('leg','receivable','amount',999,'party_type','customer','party_id',c4),
          jsonb_build_object('leg','sales','amount',999)), 'test', c4, u, 'draft');
      -- c5: نسیه و تسویهٔ کامل → صفر، در هیچ شمار نیست
      PERFORM ledger.post_entry('sale_shift', br, today, 'نسیه',
        jsonb_build_array(jsonb_build_object('leg','receivable','amount',40000,'party_type','customer','party_id',c5),
          jsonb_build_object('leg','sales','amount',40000)), 'test', c5, u);
      PERFORM ledger.post_entry('customer_receipt', br, today, 'دریافت',
        jsonb_build_array(jsonb_build_object('leg','to_account','amount',40000),
          jsonb_build_object('leg','receivable','amount',40000,'party_type','customer','party_id',c5)), 'test', c5, u);

      -- چک‌ها: دریافتیِ سررسیدگذشته ×۲، نزدیک ×۱، دور ×۱، وصول‌شده ×۱ (همه از c6)؛ پرداختیِ نزدیک ×۱؛ دریافتی
      -- شعبهٔ دیگر ×۱. دریافت چک بدهی c6 را به حساب «چک نزد ما» با همان شخص می‌برد، پس خالصش فقط با وصول عوض می‌شود.
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, drawer_name, amount, issued_on, due_on, party_type, party_id, created_by)
        VALUES ('received', br, 'OPS-1', 'ملت', 'صاحب چک', 1000000, today - 30, today - 3, 'customer', c6, u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'receive', u, NULL, NULL, today - 30);
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, drawer_name, amount, issued_on, due_on, party_type, party_id, created_by)
        VALUES ('received', br, 'OPS-2', 'ملت', 'صاحب چک', 2000001, today - 30, today - 1, 'customer', c6, u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'receive', u, NULL, NULL, today - 30);
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, drawer_name, amount, issued_on, due_on, party_type, party_id, created_by)
        VALUES ('received', br, 'OPS-3', 'ملت', 'صاحب چک', 500000, today - 5, today + 2, 'customer', c6, u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'receive', u, NULL, NULL, today - 5);
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, drawer_name, amount, issued_on, due_on, party_type, party_id, created_by)
        VALUES ('received', br, 'OPS-4', 'ملت', 'صاحب چک', 700000, today - 5, today + 60, 'customer', c6, u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'receive', u, NULL, NULL, today - 5);
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, drawer_name, amount, issued_on, due_on, party_type, party_id, created_by)
        VALUES ('received', br, 'OPS-5', 'ملت', 'صاحب چک', 800000, today - 40, today - 10, 'customer', c6, u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'receive', u, NULL, NULL, today - 40);
      PERFORM treasury.post_cheque_event(ch, 'deposit', u, '${BANK}', NULL, today - 12);
      PERFORM treasury.post_cheque_event(ch, 'clear', u, NULL, NULL, today - 10);
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, amount, issued_on, due_on, party_type, party_id, bank_account_id, created_by)
        VALUES ('issued', br, 'OPS-6', 'ملت', 900000, today - 5, today + 4, 'supplier', s1, '${BANK}', u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'issue', u, NULL, NULL, today - 5);
      INSERT INTO treasury.cheque (direction, branch_id, cheque_no, bank_name, drawer_name, amount, issued_on, due_on, party_type, party_id, created_by)
        VALUES ('received', b2, 'OPS-7', 'ملت', 'شعبهٔ دیگر', 400000, today - 30, today - 2, 'customer', c3, u) RETURNING id INTO ch;
      PERFORM treasury.post_cheque_event(ch, 'receive', u, NULL, NULL, today - 30);

      -- شیفت‌ها: باز از دیروز، باز امروز، بستهٔ امروز با مغایرت، بستهٔ امروز بی مغایرت، بستهٔ دیروز با مغایرت،
      -- باز در شعبهٔ دیگر.
      INSERT INTO sales.cash_shift (branch_id, user_id, opened_at)
        VALUES (br, '${ids.cashier}', platform.business_day_start(today) - interval '3 hours');
      INSERT INTO sales.cash_shift (branch_id, user_id, opened_at)
        VALUES (br, '${ids.supervisor}', platform.business_day_start(today) + interval '1 hour');
      INSERT INTO sales.cash_shift (branch_id, user_id, opened_at, closed_at, status, counted_cash, expected_cash, variance)
        VALUES (br, u, platform.business_day_start(today) + interval '1 hour', platform.business_day_start(today) + interval '2 hours', 'closed', 90, 100, -10);
      INSERT INTO sales.cash_shift (branch_id, user_id, opened_at, closed_at, status, counted_cash, expected_cash, variance)
        VALUES (br, u, platform.business_day_start(today) + interval '3 hours', platform.business_day_start(today) + interval '4 hours', 'approved', 100, 100, 0);
      INSERT INTO sales.cash_shift (branch_id, user_id, opened_at, closed_at, status, counted_cash, expected_cash, variance)
        VALUES (br, u, platform.business_day_start(today) - interval '6 hours', platform.business_day_start(today) - interval '5 hours', 'closed', 50, 100, -50);
      INSERT INTO sales.cash_shift (branch_id, user_id, opened_at) VALUES (b2, u, now());

      -- کمبود موجودی (۱۰۴، آستانهٔ پیش‌فرض ۲): قفسه: LS-A ۱ و LS-B ۲ داخل، LS-C ۳ بیرون؛ پشتیبان: LS-A ۰؛
      -- معیوب: LS-D ۰ بیرون؛ شعبهٔ دیگر: LS-E ۰ بیرون. یعنی همین شعبه = ۳.
      DECLARE p uuid; va uuid; vb uuid; vc uuid; vd uuid; ve uuid; w2 uuid;
      BEGIN
        INSERT INTO inventory.warehouse (branch_id, code, name, kind) VALUES (b2, 'OPS-W2-${suffix}', 'انبار شعبهٔ دوم', 'store') RETURNING id INTO w2;
        INSERT INTO catalog.product (code, name_internal) VALUES ('P-OPS-LS', 'کالای کمبود') RETURNING id INTO p;
        INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'آبی', 'S', 'OPS-LS-A') RETURNING id INTO va;
        INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'آبی', 'M', 'OPS-LS-B') RETURNING id INTO vb;
        INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'آبی', 'L', 'OPS-LS-C') RETURNING id INTO vc;
        INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'آبی', 'XL', 'OPS-LS-D') RETURNING id INTO vd;
        INSERT INTO catalog.variation (product_id, color, size, sku) VALUES (p, 'سبز', 'S', 'OPS-LS-E') RETURNING id INTO ve;
        PERFORM inventory.apply_movement(va, '00000000-0000-7000-8000-000000000101', 1, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(vb, '00000000-0000-7000-8000-000000000101', 2, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(vc, '00000000-0000-7000-8000-000000000101', 3, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(va, '00000000-0000-7000-8000-000000000102', 1, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(va, '00000000-0000-7000-8000-000000000102', -1, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(vd, '00000000-0000-7000-8000-000000000103', 1, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(vd, '00000000-0000-7000-8000-000000000103', -1, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(ve, w2, 1, 'opening', p_user => u, p_unit_cost => 1000);
        PERFORM inventory.apply_movement(ve, w2, -1, 'opening', p_user => u, p_unit_cost => 1000);
      END;
    END $fx$`).execute(owner.db);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }) });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    await owner?.close();
    disposable?.drop();
  });

  test("مدیر: هر سه بخش با شمار و جمع دقیق همین شعبه؛ شعبهٔ دیگر، پیش‌نویس، صفر، وصول‌شده و دور بیرون", async () => {
    const r = await get(users.admin);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["cache-control"], "no-store");
    const body = JSON.parse(r.body);
    // c1 طلب ۳۰۰٬۰۰۰؛ اعتبار: c2 ۵۰٬۰۰۰ و c6 ۸۰۰٬۰۰۰ (فقط چک وصول‌شده). چهار چک وصول‌نشدهٔ c6 (۴٬۲۰۰٬۰۰۱) خالص او
    // را عوض نمی‌کنند — اگر فقط حساب دریافتنی شمرده می‌شد، c6 اعتبار ۵٬۰۰۰٬۰۰۱ نشان می‌داد.
    assert.deepEqual(body.receivables, { state: "ready", owed: { count: 1, amount: "300000" }, credit: { count: 2, amount: "850000" } });
    assert.equal(body.cheques.state, "ready");
    assert.equal(body.cheques.warningDays, 7);
    assert.deepEqual(body.cheques.received.overdue, { count: 2, amount: "3000001", nextDue: body.cheques.received.overdue.nextDue });
    assert.deepEqual({ ...body.cheques.received.dueSoon, nextDue: undefined }, { count: 1, amount: "500000", nextDue: undefined });
    assert.deepEqual({ ...body.cheques.issued.dueSoon, nextDue: undefined }, { count: 1, amount: "900000", nextDue: undefined });
    assert.deepEqual(body.cheques.issued.overdue, { count: 0, amount: "0", nextDue: null });
    assert.ok(body.cheques.received.overdue.nextDue < body.businessDate, "نزدیک‌ترین سررسید گذشته پیش از امروز است");
    assert.equal(typeof body.cheques.received.overdue.amount, "string", "پول رشته است");
    assert.equal(body.shifts.state, "ready");
    assert.deepEqual({ open: body.shifts.openCount, carried: body.shifts.carriedOverCount, closed: body.shifts.closedToday, variance: body.shifts.varianceToday },
      { open: 2, carried: 1, closed: 2, variance: 1 });
    assert.deepEqual(body.shifts.open.map((s: { carriedOver: boolean }) => s.carriedOver), [true, false], "قدیمی‌ترین اول؛ شیفت دیروز علامت دارد");
    assert.deepEqual(body.shifts.open.map((s: { userName: string }) => s.userName), ["کاربر cashier", "کاربر supervisor"]);
  });

  test("کمبود موجودی: شمار دقیق انبارهای فروش همین شعبه و برابر با فهرست گزارش؛ معیوب و شعبهٔ دیگر بیرون", async () => {
    const body = JSON.parse((await get(users.admin)).body);
    assert.equal(body.lowStock.state, "ready");
    assert.equal(body.lowStock.threshold, "2");
    assert.equal(body.lowStock.total, 3);
    // هر انبار فروش فعال یک ردیف، حتی با صفرِ واقعی (آوتلتِ Seed)؛ معیوب ردیف ندارد.
    assert.deepEqual(body.lowStock.warehouses.map((w: { name: string; count: number }) => `${w.name}:${w.count}`),
      ["آوتلت — تک‌سایز حراجی:0", "انبار پشتیبان:1", "قفسه فروشگاه:2"]);
    const auth = await loginAs(users.admin);
    const list = await app.inject({ method: "GET", url: `/reports/low-stock?branchId=${BRANCH}`, ...auth });
    assert.equal(list.statusCode, 200, list.body);
    const l = JSON.parse(list.body);
    assert.equal(l.total, body.lowStock.total, "شمار داشبورد = شمار گزارشی که پیوندش باز می‌کند");
    assert.equal(l.truncated, false);
    assert.equal(l.threshold, "2");
    assert.deepEqual(l.rows.map((r: { sku: string; available: string; warehouseName: string }) => `${r.sku}@${r.available}@${r.warehouseName}`),
      ["OPS-LS-A@0.000@انبار پشتیبان", "OPS-LS-A@1.000@قفسه فروشگاه", "OPS-LS-B@2.000@قفسه فروشگاه"], "کمترین قابل‌فروش اول");
    const one = await app.inject({ method: "GET", url: `/reports/low-stock?warehouseId=00000000-0000-7000-8000-000000000101`, ...auth });
    assert.equal(JSON.parse(one.body).total, 2, "فیلتر انبار");
    const csv = await app.inject({ method: "GET", url: `/reports/low-stock?branchId=${BRANCH}&format=csv`, ...auth });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers["content-type"] as string, /text\/csv/);
    assert.ok(csv.body.startsWith("\uFEFF"), "BOM برای اکسل");
    assert.equal(csv.body.trim().split(/\r?\n/).length, 4, "سرستون + سه سطر");
    assert.ok(!/unitCost|بها/.test(csv.body), "بی ستون بها");
  });

  test("کمبود موجودی: دامنه و مجوز — شعبه/انبار بیرون از دامنه ۴۰۳، بی report.view ۴۰۳ و denied", async () => {
    const sup = await loginAs(users.supervisor);
    assert.equal((await app.inject({ method: "GET", url: `/reports/low-stock?branchId=${other}`, ...sup })).statusCode, 403);
    const w2 = (await sql<{ id: string }>`SELECT id::text FROM inventory.warehouse WHERE branch_id = ${other}::uuid`.execute(owner.db)).rows[0]!.id;
    assert.equal((await app.inject({ method: "GET", url: `/reports/low-stock?warehouseId=${w2}`, ...sup })).statusCode, 403);
    const own = JSON.parse((await app.inject({ method: "GET", url: `/reports/low-stock`, ...sup })).body);
    assert.equal(own.total, 3, "دامنهٔ تک‌شعبه بی پارامتر همان شعبه است، نه همه");
    const cash = await loginAs(users.cashier);
    assert.equal((await app.inject({ method: "GET", url: `/reports/low-stock?branchId=${BRANCH}`, ...cash })).statusCode, 403);
    assert.deepEqual(JSON.parse((await get(users.cashier)).body).lowStock, { state: "denied" });
  });

  test("کمبود موجودی: آستانهٔ تازه از تنظیم خوانده می‌شود؛ نبودِ آستانه «unknown» است، نه صفر", async () => {
    await sql`SELECT platform.set_setting('inventory.low_stock_threshold', '3'::jsonb, 'آزمون آستانه', ${ids.admin}::uuid)`.execute(owner.db);
    const three = JSON.parse((await get(users.admin)).body).lowStock;
    assert.equal(three.threshold, "3");
    assert.equal(three.total, 4, "LS-C با موجودی ۳ حالا داخل است");
    const saved = (await sql<{ r: unknown }>`SELECT to_jsonb(s) AS r FROM platform.setting s WHERE key = 'inventory.low_stock_threshold'`.execute(owner.db)).rows[0]!.r;
    // نصبی که ۱۰۴ را ندارد یا کلیدش گم شده: داده‌ساز آزمون؛ کلید از هیچ مسیر برنامه حذف نمی‌شود.
    await sql`DELETE FROM platform.setting WHERE key = 'inventory.low_stock_threshold'`.execute(owner.db);
    try {
      const body = JSON.parse((await get(users.admin)).body);
      assert.equal(body.lowStock.state, "unknown");
      assert.ok(!("total" in body.lowStock), "شماری که خوانده نشده صفر گزارش نمی‌شود");
      const auth = await loginAs(users.admin);
      const l = JSON.parse((await app.inject({ method: "GET", url: `/reports/low-stock?branchId=${BRANCH}`, ...auth })).body);
      assert.deepEqual({ threshold: l.threshold, total: l.total }, { threshold: null, total: null });
      assert.equal((await app.inject({ method: "GET", url: `/reports/low-stock?branchId=${BRANCH}&format=csv`, ...auth })).statusCode, 409,
        "CSV خالی شبیه «کمبودی نیست» بود");
    } finally {
      await sql`INSERT INTO platform.setting SELECT * FROM jsonb_populate_record(NULL::platform.setting, ${JSON.stringify(saved)}::jsonb)`.execute(owner.db);
      await sql`SELECT platform.set_setting('inventory.low_stock_threshold', '2'::jsonb, 'برگشت آزمون', ${ids.admin}::uuid)`.execute(owner.db);
    }
  });

  test("سرپرست: شیفت و دریافتنی بله، چک «denied» — نه صفر و نه خواندن", async () => {
    const body = JSON.parse((await get(users.supervisor)).body);
    assert.deepEqual(body.cheques, { state: "denied" });
    assert.equal(body.shifts.state, "ready");
    assert.equal(body.receivables.state, "ready");
  });

  test("صندوق‌دار: هر سه «denied»؛ ناشناس ۴۰۱؛ شعبهٔ بیرون از دامنه ۴۰۳ پیش از هر خواندن", async () => {
    const body = JSON.parse((await get(users.cashier)).body);
    assert.deepEqual([body.shifts, body.cheques, body.receivables, body.lowStock], [{ state: "denied" }, { state: "denied" }, { state: "denied" }, { state: "denied" }]);
    assert.ok(!/300000|3000001|کاربر/.test(JSON.stringify(body)), "هیچ عددی از بخش بسته نمی‌رسد");
    assert.equal((await app.inject({ method: "GET", url: `/dashboard/operations?branchId=${BRANCH}` })).statusCode, 401);
    assert.equal((await get(users.admin, other)).statusCode, 403);
    assert.equal((await get(users.admin, "not-a-uuid")).statusCode, 400);
  });

  test("فقط‌خواندنی: دفتر، چک و شیفت دست نمی‌خورند", async () => {
    const snap = async () => (await sql<{ s: string }>`SELECT
      (SELECT count(*) FROM ledger.journal_line)::text || ':' || (SELECT count(*) FROM treasury.cheque_event)::text || ':' ||
      (SELECT count(*) FROM inventory.stock_movement)::text || ':' || (SELECT string_agg(on_hand::text || '/' || reserved::text, ',' ORDER BY variation_id, warehouse_id) FROM inventory.stock_balance) || ':' ||
      (SELECT string_agg(id::text || status, ',' ORDER BY id) FROM sales.cash_shift) AS s`.execute(owner.db)).rows[0]!.s;
    const before = await snap();
    await get(users.admin);
    await get(users.supervisor);
    assert.equal(await snap(), before);
  });
});
