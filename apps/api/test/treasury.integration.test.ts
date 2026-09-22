import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه خزانه و چک — روی پستگرس واقعی.
 *
 * دو حوزه‌ای که تابع دیتابیس و تست SQL کامل داشتند و **هیچ مسیر API**.
 *
 * ادعای مرکزی و مالی: **پول نقدی که از کشو رد می‌شود، در شمارش پایان
 * شیفت دیده می‌شود.** بدون این، هر هزینه صندوق یک مغایرت کاذب می‌سازد
 * که هیچ‌کس نمی‌تواند توضیحش بدهد — و صندوق‌دار متهم می‌شود.
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

type Jar = { cookies: Record<string, string>; headers: Record<string, string> };

interface AccountOut {
  id: string;
  code: string;
  name: string;
  kind: string;
}

describe("خزانه و چک", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `tr${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-خزانه-و-به‌قدر-کافی-بلند";
  const admin = `tadmin_${suffix}`;
  const cashier = `tcash_${suffix}`;
  const ids: Record<string, string> = {};
  let cashBox: AccountOut;
  let bank: AccountOut;
  let supplierId = "";
  let customerId = "";

  const jars = new Map<string, Jar>();

  async function loginAs(username: string): Promise<Jar> {
    const cached = jars.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      remoteAddress: `10.9.0.${(jars.size % 250) + 1}`,
      payload: {
        username,
        password: PASSWORD,
        deviceFingerprint: `fp-${suffix}-${username}`,
      },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const jar: Jar = {
      cookies: {
        labelmod_session:
          r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
    jars.set(username, jar);
    return jar;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر خزانه", "admin"],
      [cashier, "صندوق‌دار خزانه", "cashier"],
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

    const sup = await sql<{ id: string }>`
      INSERT INTO purchasing.supplier (code, name)
      VALUES (${`S-${suffix}`.slice(0, 20)}, 'تأمین‌کننده خزانه') RETURNING id`
      .execute(handle.db);
    supplierId = sup.rows[0]!.id;

    const cust = await sql<{ id: string }>`
      INSERT INTO sales.customer (full_name, mobile_normalized)
      VALUES ('مشتری چک', ${`0912${(Date.now() % 10000000).toString().padStart(7, "0")}`})
      RETURNING id`
      .execute(handle.db);
    customerId = cust.rows[0]!.id;

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    const a = await loginAs(admin);
    const accounts = (
      await app.inject({ method: "GET", url: "/treasury/accounts", ...a })
    ).json().accounts as AccountOut[];
    cashBox = accounts.find((x) => x.kind === "cash_box")!;
    bank = accounts.find((x) => x.kind === "bank")!;
    assert.ok(cashBox, "seed باید یک حساب صندوق داشته باشد");
    assert.ok(bank, "seed باید یک حساب بانک داشته باشد");
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  /** شیفت باز برای صندوق‌دار — و برمی‌گرداند شناسه‌اش را. */
  async function openShift(jar: Jar): Promise<string> {
    // ⚠️ پاسخ **خودِ شیفت** است، نه `{ shift: … }` — و برای «شیفتی
    //    نیست» بدنه‌اش `null` می‌آید، نه ۴۰۴.
    const cur = await app.inject({
      method: "GET",
      url: `/shifts/current?branchId=${BRANCH}`,
      ...jar,
    });
    if (cur.statusCode === 200) {
      const body = cur.json() as { id?: string } | null;
      if (body !== null && typeof body.id === "string") return body.id;
    }
    const r = await app.inject({
      method: "POST",
      url: "/shifts",
      ...jar,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  }

  // ── دروازه کشو — ادعای مالی مرکزی ────────────────────────────────────

  test("هزینه نقدی بدون شیفت باز ثبت نمی‌شود", async () => {
    const a = await loginAs(admin);
    const r = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "5000000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "6102",
        note: "کرایه پیک",
      },
    });
    assert.equal(r.statusCode, 422, `انتظار ۴۲۲ بود: ${r.body}`);
    assert.equal(r.json().error.code, "no_open_shift");
  });

  test("هزینه نقدی با شیفت باز، shift_id می‌گیرد — و در شمارش دیده می‌شود", async () => {
    const c = await loginAs(cashier);
    const shiftId = await openShift(c);
    const a = await loginAs(admin);

    const r = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "3000000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "6102",
        note: "کرایه پیک",
      },
    });
    assert.equal(r.statusCode, 201, r.body);

    // ⚠️ مرکزی‌ترین ادعای این تست: `shift_id` خودکار از شیفت باز
    //    گرفته شد، بدون اینکه کلاینت بفرستد.
    const row = await sql<{ shift_id: string | null; status: string }>`
      SELECT shift_id, status FROM treasury.transaction WHERE id = ${r.json().id}::uuid`
      .execute(handle.db);
    assert.equal(row.rows[0]!.shift_id, shiftId, "شیفت باز خودکار چسبید");
    assert.equal(row.rows[0]!.status, "posted", "و همان لحظه به دفتر رفت");

    // و از فهرست همان شیفت دیده می‌شود — چیزی که صفحه بستن شیفت
    // لازم دارد تا مغایرت توضیح‌دادنی باشد
    const list = await app.inject({
      method: "GET",
      url: `/treasury/transactions?shiftId=${shiftId}`,
      ...a,
    });
    assert.equal(list.statusCode, 200, list.body);
    const rows = list.json().transactions as Array<{ amount: string; purpose: string }>;
    assert.ok(
      rows.some((x) => x.amount === "3000000" && x.purpose === "expense"),
      "هزینه در فهرست شیفت دیده می‌شود",
    );
  });

  test("شیفتِ اشتباه رد می‌شود، نه اینکه بی‌صدا جایگزین شود", async () => {
    const c = await loginAs(cashier);
    await openShift(c);
    const a = await loginAs(admin);

    const r = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "1000000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "6102",
        shiftId: "00000000-0000-7000-8000-0000000000ee",
      },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "wrong_shift");
  });

  test("حرکت بانکی شیفت نمی‌خواهد — و اگر بفرستی رد می‌شود", async () => {
    const a = await loginAs(admin);
    const c = await loginAs(cashier);
    const shiftId = await openShift(c);

    const ok = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "supplier_payment",
        amount: "20000000",
        fromAccountId: bank.id,
        partyType: "supplier",
        partyId: supplierId,
        note: "تسویه فاکتور",
      },
    });
    assert.equal(ok.statusCode, 201, ok.body);
    const row = await sql<{ shift_id: string | null }>`
      SELECT shift_id FROM treasury.transaction WHERE id = ${ok.json().id}::uuid`
      .execute(handle.db);
    assert.equal(row.rows[0]!.shift_id, null, "پول از کشو رد نشده، پس شیفت ندارد");

    const bad = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "supplier_payment",
        amount: "1000000",
        fromAccountId: bank.id,
        partyType: "supplier",
        partyId: supplierId,
        shiftId,
      },
    });
    assert.equal(bad.statusCode, 422, bad.body);
    assert.equal(bad.json().error.code, "shift_not_applicable");
  });

  test("دو کشوی باز یعنی ابهام — سیستم حدس نمی‌زند", async () => {
    const a = await loginAs(admin);
    const c = await loginAs(cashier);
    await openShift(c);
    // مدیر هم شیفت خودش را باز می‌کند → دو کشوی باز در یک شعبه
    const second = await app.inject({
      method: "POST",
      url: "/shifts",
      ...a,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
    assert.equal(second.statusCode, 201, second.body);

    const r = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "1000000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "6102",
      },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "ambiguous_shift");

    // ولی با شیفت صریح، می‌گذرد
    const explicit = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "1000000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "6102",
        shiftId: second.json().id,
      },
    });
    assert.equal(explicit.statusCode, 201, explicit.body);

    // و شیفت مدیر بسته می‌شود تا تست‌های بعدی یک کشوی باز ببینند
    await app.inject({
      method: "POST",
      url: `/shifts/${second.json().id}/close`,
      ...a,
      payload: { countedCash: "0" },
    });
  });

  // ── سند حسابداری ─────────────────────────────────────────────────────

  test("هر حرکت نقد یک سند متوازن می‌زند", async () => {
    const a = await loginAs(admin);
    const c = await loginAs(cashier);
    await openShift(c);

    const r = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "transfer",
        amount: "10000000",
        fromAccountId: cashBox.id,
        toAccountId: bank.id,
        note: "واریز فروش روز به بانک",
      },
    });
    assert.equal(r.statusCode, 201, r.body);

    const check = await sql<{ n: string; balanced: string }>`
      SELECT count(*) AS n,
             count(*) FILTER (WHERE d = c) AS balanced
        FROM (SELECT jl.entry_id, sum(jl.debit) d, sum(jl.credit) c
                FROM ledger.journal_line jl
               WHERE jl.entry_id = (SELECT entry_id FROM treasury.transaction
                                     WHERE id = ${r.json().id}::uuid)
               GROUP BY jl.entry_id) x`.execute(handle.db);
    assert.equal(check.rows[0]!.n, "1", "دقیقاً یک سند");
    assert.equal(check.rows[0]!.balanced, "1", "و متوازن است");
  });

  // ── مجوز ─────────────────────────────────────────────────────────────

  test("صندوق‌دار پول خزانه را جابه‌جا نمی‌کند و چک نمی‌بیند", async () => {
    const c = await loginAs(cashier);

    const move = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...c,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "1",
        fromAccountId: cashBox.id,
        expenseAccountCode: "6102",
      },
    });
    assert.equal(move.statusCode, 403, `انتظار ۴۰۳ بود: ${move.body}`);

    const list = await app.inject({ method: "GET", url: "/cheques", ...c });
    assert.equal(list.statusCode, 403, `انتظار ۴۰۳ بود: ${list.body}`);
  });

  // ── چک ───────────────────────────────────────────────────────────────

  test("تاریخ تقویمی نامعتبر چک ۴۰۰ می‌گیرد و برگه‌ای نمی‌سازد", async () => {
    const a = await loginAs(admin);
    const response = await app.inject({ method: "POST", url: "/cheques", ...a,
      payload: { direction: "received", branchId: BRANCH, chequeNo: "INVALID-DATE", bankName: "Test",
        amount: "100", issuedOn: "2026-02-30", dueOn: "2026-03-01", partyType: "customer", partyId: customerId } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM treasury.cheque WHERE cheque_no='INVALID-DATE'`.execute(handle.db)).rows[0]!.n, 0);
  });

  test("چرخه کامل چک دریافتی: ثبت → دریافت → واگذاری → وصول", async () => {
    const a = await loginAs(admin);

    const made = await app.inject({
      method: "POST",
      url: "/cheques",
      ...a,
      payload: {
        direction: "received",
        branchId: BRANCH,
        chequeNo: `${Date.now() % 1000000}`,
        bankName: "ملت",
        amount: "50000000",
        issuedOn: "2026-06-01",
        dueOn: "2026-08-01",
        partyType: "customer",
        partyId: customerId,
        drawerName: "علی رضایی",
      },
    });
    assert.equal(made.statusCode, 201, made.body);
    const chequeId = made.json().id as string;

    // برگه تازه هیچ اثر مالی ندارد
    const draft = await app.inject({ method: "GET", url: `/cheques/${chequeId}`, ...a });
    assert.equal(draft.json().cheque.status, "draft");
    assert.equal(draft.json().cheque.issuedOn, "2026-06-01", "DATE must not shift with server timezone");
    assert.equal(draft.json().cheque.dueOn, "2026-08-01");
    assert.equal((draft.json().events as unknown[]).length, 0, "هنوز رویدادی نیست");

    for (const [action, extra] of [
      ["receive", {}],
      ["deposit", { accountId: bank.id }],
      ["clear", { accountId: bank.id }],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/cheques/${chequeId}/events`,
        ...a,
        payload: { action, ...extra },
      });
      assert.equal(r.statusCode, 200, `${action} ناموفق: ${r.body}`);
    }

    const done = await app.inject({ method: "GET", url: `/cheques/${chequeId}`, ...a });
    assert.equal(done.json().cheque.status, "cleared");
    const events = done.json().events as Array<{ action: string; entryId: string | null }>;
    assert.deepEqual(
      events.map((e) => e.action),
      ["receive", "deposit", "clear"],
      "زنجیره رویداد به ترتیب",
    );
    // `receive` و `clear` سند می‌زنند؛ `deposit` فقط جابه‌جایی داخلی است
    assert.ok(
      events.filter((e) => e.entryId !== null).length >= 2,
      "دست‌کم دو رویداد سند زده‌اند",
    );
  });

  test("گذار نامجاز رد می‌شود — با پیام فارسی، نه ۵۰۰", async () => {
    const a = await loginAs(admin);
    const made = await app.inject({
      method: "POST",
      url: "/cheques",
      ...a,
      payload: {
        direction: "received",
        branchId: BRANCH,
        chequeNo: `${(Date.now() % 1000000) + 1}`,
        bankName: "صادرات",
        amount: "1000000",
        issuedOn: "2026-06-01",
        dueOn: "2026-09-01",
        partyType: "customer",
        partyId: customerId,
      },
    });
    const id = made.json().id as string;

    // draft → clear بدون receive و deposit
    const r = await app.inject({
      method: "POST",
      url: `/cheques/${id}/events`,
      ...a,
      payload: { action: "clear", accountId: bank.id },
    });
    assert.equal(r.statusCode, 409, `انتظار ۴۰۹ بود، نه ۵۰۰: ${r.body}`);
    assert.match(r.json().error.message, /مجاز نیست/);
  });

  test("چک برگشتی به بدهی عادی منتقل می‌شود", async () => {
    const a = await loginAs(admin);
    const made = await app.inject({
      method: "POST",
      url: "/cheques",
      ...a,
      payload: {
        direction: "received",
        branchId: BRANCH,
        chequeNo: `${(Date.now() % 1000000) + 2}`,
        bankName: "پاسارگاد",
        amount: "7000000",
        issuedOn: "2026-06-01",
        dueOn: "2026-07-01",
        partyType: "customer",
        partyId: customerId,
      },
    });
    const id = made.json().id as string;

    for (const [action, extra] of [
      ["receive", {}],
      ["deposit", { accountId: bank.id }],
      ["bounce", {}],
      ["settle", {}],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/cheques/${id}/events`,
        ...a,
        payload: { action, ...extra },
      });
      assert.equal(r.statusCode, 200, `${action} ناموفق: ${r.body}`);
    }

    const done = await app.inject({ method: "GET", url: `/cheques/${id}`, ...a });
    assert.equal(done.json().cheque.status, "settled");
  });

  test("سررسیدها از دیتابیس می‌آیند، نه از مرورگر", async () => {
    const a = await loginAs(admin);
    const made = await app.inject({
      method: "POST",
      url: "/cheques",
      ...a,
      payload: {
        direction: "received",
        branchId: BRANCH,
        chequeNo: `${(Date.now() % 1000000) + 3}`,
        bankName: "سامان",
        amount: "2000000",
        issuedOn: "2020-01-01",
        dueOn: "2020-02-01",
        partyType: "customer",
        partyId: customerId,
      },
    });
    await app.inject({
      method: "POST",
      url: `/cheques/${made.json().id}/events`,
      ...a,
      payload: { action: "receive" },
    });

    const r = await app.inject({ method: "GET", url: "/cheques/due", ...a });
    assert.equal(r.statusCode, 200, r.body);
    const due = r.json().due as Array<{ id: string; urgency: string }>;
    const found = due.find((x) => x.id === made.json().id);
    assert.ok(found, "چک سررسیدشده باید در فهرست باشد");
    assert.equal(found.urgency, "overdue", "و دیتابیس آن را سررسیدشده می‌داند");
  });

  // ── اعتبارسنجی ───────────────────────────────────────────────────────

  test("شکل حساب‌ها اجبار می‌شود — پیش از رسیدن به دیتابیس", async () => {
    const a = await loginAs(admin);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["انتقال به یک حساب", { purpose: "transfer", fromAccountId: bank.id, toAccountId: bank.id }],
      ["هزینه با حساب مقصد", { purpose: "expense", toAccountId: bank.id, expenseAccountCode: "6102" }],
      ["هزینه بدون سرفصل", { purpose: "expense", fromAccountId: bank.id }],
      ["پرداخت بدون شخص", { purpose: "supplier_payment", fromAccountId: bank.id }],
      ["دریافت با حساب مبدأ", { purpose: "customer_receipt", fromAccountId: bank.id, partyId: customerId }],
    ];
    for (const [label, extra] of cases) {
      const r = await app.inject({
        method: "POST",
        url: "/treasury/transactions",
        ...a,
        payload: { branchId: BRANCH, amount: "1000", ...extra },
      });
      assert.equal(r.statusCode, 400, `«${label}» باید ۴۰۰ بگیرد: ${r.body}`);
    }
  });

  test("سرفصل هزینه نامعتبر پیام فارسی می‌دهد، نه ۵۰۰", async () => {
    const a = await loginAs(admin);
    const c = await loginAs(cashier);
    await openShift(c);

    // ⚠️ نسخه اول این مسیر، کد ناموجود را به نقض کلید خارجی می‌سپرد و
    //    کاربر ۵۰۰ می‌گرفت — یعنی دفاعی که کار کرده بود، شبیه خرابی
    //    سرور گزارش می‌شد.
    const missing = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "1000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "9999",
      },
    });
    assert.equal(missing.statusCode, 422, `انتظار ۴۲۲ بود: ${missing.body}`);
    assert.match(missing.json().error.message, /کدینگ حساب/);

    // حساب گروه هم رد می‌شود، و پیامش می‌گوید چرا
    const group = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "expense",
        amount: "1000",
        fromAccountId: cashBox.id,
        expenseAccountCode: "62",
      },
    });
    assert.equal(group.statusCode, 422, group.body);
    assert.match(group.json().error.message, /حساب گروه/);

    // و حساب خزانه ناموجود
    const noAcc = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "supplier_payment",
        amount: "1000",
        fromAccountId: "00000000-0000-7000-8000-0000000000cc",
        partyType: "supplier",
        partyId: supplierId,
      },
    });
    assert.equal(noAcc.statusCode, 404, noAcc.body);
  });

  test("پول در JSON رشته است — عدد رد می‌شود", async () => {
    const a = await loginAs(admin);
    for (const amount of [1000000, "-1", "1.5", "۱۰۰۰", ""]) {
      const r = await app.inject({
        method: "POST",
        url: "/treasury/transactions",
        ...a,
        payload: {
          branchId: BRANCH,
          purpose: "supplier_payment",
          amount,
          fromAccountId: bank.id,
          partyType: "supplier",
          partyId: supplierId,
        },
      });
      assert.equal(r.statusCode, 400, `«${String(amount)}» نباید پذیرفته شود: ${r.body}`);
    }
  });

  test("همان کلید Idempotency، دو بار = یک تراکنش", async () => {
    const a = await loginAs(admin);
    const key = `tr-idem-${suffix}`;
    const payload = {
      branchId: BRANCH,
      purpose: "supplier_payment",
      amount: "4000000",
      fromAccountId: bank.id,
      partyType: "supplier",
      partyId: supplierId,
    };

    const first = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      headers: { ...a.headers, "idempotency-key": key },
      payload,
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      headers: { ...a.headers, "idempotency-key": key },
      payload,
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().replayed, true);
    assert.equal(second.json().id, first.json().id);

    const n = await sql<{ n: string }>`
      SELECT count(*) AS n FROM treasury.transaction
       WHERE amount = 4000000 AND purpose = 'supplier_payment'`.execute(handle.db);
    assert.equal(n.rows[0]!.n, "1", "فقط یک تراکنش ساخته شد");
  });

  test("دو بار «وصول شد» روی یک چک، دو سند نمی‌زند", async () => {
    const a = await loginAs(admin);
    const made = await app.inject({
      method: "POST",
      url: "/cheques",
      ...a,
      payload: {
        direction: "received",
        branchId: BRANCH,
        chequeNo: `${(Date.now() % 1000000) + 4}`,
        bankName: "تجارت",
        amount: "9000000",
        issuedOn: "2026-06-01",
        dueOn: "2026-07-15",
        partyType: "customer",
        partyId: customerId,
      },
    });
    const id = made.json().id as string;
    await app.inject({
      method: "POST",
      url: `/cheques/${id}/events`,
      ...a,
      payload: { action: "receive" },
    });
    await app.inject({
      method: "POST",
      url: `/cheques/${id}/events`,
      ...a,
      payload: { action: "deposit", accountId: bank.id },
    });

    const first = await app.inject({
      method: "POST",
      url: `/cheques/${id}/events`,
      ...a,
      payload: { action: "clear", accountId: bank.id },
    });
    assert.equal(first.statusCode, 200, first.body);

    // بدون هدر — کلید از (چک، عمل) ساخته می‌شود
    const again = await app.inject({
      method: "POST",
      url: `/cheques/${id}/events`,
      ...a,
      payload: { action: "clear", accountId: bank.id },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().replayed, true, "بار دوم Replay است، نه سند دوم");

    const n = await sql<{ n: string }>`
      SELECT count(*) AS n FROM treasury.cheque_event
       WHERE cheque_id = ${id}::uuid AND action = 'clear'`.execute(handle.db);
    assert.equal(n.rows[0]!.n, "1", "فقط یک رویداد وصول");
  });

  // ── دامنه شعبه ───────────────────────────────────────────────────────

  test("حساب شعبه دیگر نه فهرست می‌شود و نه در تراکنش پذیرفته می‌شود", async () => {
    const a = await loginAs(admin);
    const other = await sql<{ id: string }>`
      INSERT INTO platform.branch (code, name)
      VALUES (${`B-${suffix}`.slice(0, 12)}, 'شعبه دوم') RETURNING id`
      .execute(handle.db);

    const foreign = await sql<{ id: string }>`
      INSERT INTO treasury.account
        (code, name, kind, branch_id, ledger_account_code)
      VALUES (${`BANK-${suffix}`.slice(0, 30)}, 'بانک شعبه دوم', 'bank',
              ${other.rows[0]!.id}::uuid, '1102')
      RETURNING id`.execute(handle.db);

    const listed = await app.inject({ method: "GET", url: "/treasury/accounts", ...a });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.ok(
      !(listed.json().accounts as AccountOut[]).some((x) => x.id === foreign.rows[0]!.id),
      "شناسه حساب شعبه دیگر نباید افشا شود",
    );

    const r = await app.inject({
      method: "POST",
      url: "/treasury/transactions",
      ...a,
      payload: {
        branchId: BRANCH,
        purpose: "supplier_payment",
        amount: "1000",
        fromAccountId: foreign.rows[0]!.id,
        partyType: "supplier",
        partyId: supplierId,
      },
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error.code, "account_branch_mismatch");

    await assert.rejects(
      sql`INSERT INTO treasury.transaction
            (branch_id, purpose, from_account_id, party_type, party_id, amount, created_by)
          VALUES (${BRANCH}::uuid, 'supplier_payment', ${foreign.rows[0]!.id}::uuid,
                  'supplier', ${supplierId}::uuid, 1000, ${ids.admin}::uuid)`
        .execute(handle.db),
      { code: "23514", constraint: "transaction_account_branch" },
      "پایگاه داده نیز درج مستقیم با حساب شعبه دیگر را رد می‌کند",
    );
    await sql`INSERT INTO treasury.transaction
      (branch_id, purpose, from_account_id, party_type, party_id, amount, created_by)
      VALUES (${other.rows[0]!.id}::uuid, 'supplier_payment', ${foreign.rows[0]!.id}::uuid,
        'supplier', ${supplierId}::uuid, 1000, ${ids.admin}::uuid)`.execute(handle.db);
    await assert.rejects(sql`UPDATE treasury.account SET branch_id = ${BRANCH}::uuid
      WHERE id = ${foreign.rows[0]!.id}::uuid`.execute(handle.db),
      { code: "23514", constraint: "used_transaction_account_branch" });
  });
});
