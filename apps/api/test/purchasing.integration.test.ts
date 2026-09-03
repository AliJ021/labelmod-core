/**
 * تست یکپارچه رسید خرید — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **محموله‌ای که انباردار با اسکنر می‌شمارد، با یک «ثبت»
 * هم به انبار می‌رود و هم به دفتر — و تا آن لحظه هیچ اثری ندارد.**
 *
 * سه مرزی که بی‌آن‌ها این مسیر خطرناک است و اینجا صریح سنجیده می‌شوند:
 *
 *   • پیش‌نویس تا ثبت **شماره نمی‌گیرد** و موجودی را تکان نمی‌دهد
 *   • رسید ثبت‌شده تغییر نمی‌کند — نه سطر، نه هزینه، نه سرآیند
 *   • هزینه حمل روی بهای تمام‌شده می‌نشیند، و جمعش با کل هزینه یکی است
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

interface ReceiptBody {
  id: string;
  number: string | null;
  status: string;
  goodsAmount: string;
  chargesAmount: string;
  taxAmount: string;
  supplierPayable: string;
  thirdPartyPayable: string;
  lines: {
    id: string;
    qty: string;
    unitPrice: string;
    lineAmount: string;
    chargeAlloc: string;
    landedUnitCost: string;
  }[];
  charges: { id: string; amount: string }[];
}

describe("رسید خرید", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `p${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-خرید-و-به‌قدر-کافی-بلند";
  const keeper = `pkeeper_${suffix}`;   // انباردار
  const cashier = `pcashier_${suffix}`; // صندوق‌دار — نباید بتواند
  const manager = `pmanager_${suffix}`; // مدیر

  let supplierId = "";
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

  /** یک پیش‌نویس تازه با تأمین‌کننده و انبار پیش‌فرض. */
  async function newDraft(user: string): Promise<ReceiptBody> {
    const s = await loginAs(user);
    const r = await app.inject({
      method: "POST",
      url: "/receipts",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, supplierId },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json() as ReceiptBody;
  }

  async function onHand(variationId: string): Promise<number> {
    const r = await sql<{ on_hand: string }>`
      SELECT coalesce(on_hand, 0) AS on_hand FROM inventory.stock_balance
       WHERE variation_id = ${variationId}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);
    return Number(r.rows[0]?.on_hand ?? 0);
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [keeper, "انباردار خرید", "warehouse"],
      [cashier, "صندوق‌دار خرید", "cashier"],
      [manager, "مدیر خرید", "admin"],
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

    const sup = await handle.db
      .insertInto("purchasing.supplier")
      .values({
        code: `S-${suffix}`,
        name: "تأمین‌کننده تست",
        mobile: null,
        phone: null,
        address: null,
        national_id: null,
        is_active: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    supplierId = sup.id;

    const product = await handle.db
      .insertInto("catalog.product")
      .values({
        code: `P-${suffix}`,
        name_internal: "پیراهن تست خرید",
        name_web: null,
        tax_rate_code: "standard",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    barcodeA = "2000000000015";
    const a = await handle.db
      .insertInto("catalog.variation")
      .values({
        product_id: product.id,
        sku: `SKU-${suffix}-A`,
        barcode: barcodeA,
        color: "مشکی",
        size: "L",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    variationA = a.id;

    const b = await handle.db
      .insertInto("catalog.variation")
      .values({
        product_id: product.id,
        sku: `SKU-${suffix}-B`,
        barcode: "2000000000022",
        color: "سفید",
        size: "M",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    variationB = b.id;

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

  // ── مجوز ───────────────────────────────────────────────────────────

  test("صندوق‌دار رسید خرید نمی‌سازد", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "POST",
      url: "/receipts",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, supplierId },
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error.code, "deny");
  });

  test("انباردار تأمین‌کننده تازه نمی‌سازد — تفصیلی، کار حسابداری است", async () => {
    const s = await loginAs(keeper);
    const r = await app.inject({
      method: "POST",
      url: "/suppliers",
      ...s,
      payload: { code: `S2-${suffix}`, name: "تأمین‌کننده دوم" },
    });
    assert.equal(r.statusCode, 403, r.body);

    // ولی فهرست را می‌بیند — بدون آن نمی‌تواند رسید بزند.
    const list = await app.inject({ method: "GET", url: "/suppliers", ...s });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok((list.json() as unknown[]).length >= 1);
  });

  test("مدیر تأمین‌کننده می‌سازد و تفصیلی می‌گیرد", async () => {
    const s = await loginAs(manager);
    const r = await app.inject({
      method: "POST",
      url: "/suppliers",
      ...s,
      payload: { code: `S3-${suffix}`, name: "تأمین‌کننده سوم", mobile: "09120000000" },
    });
    assert.equal(r.statusCode, 201, r.body);
    // بدون شماره تفصیلی، گردش حساب این تأمین‌کننده از دفتر ساختنی نیست.
    assert.ok(Number(r.json().tafsiliNo) > 0, "شماره تفصیلی نگرفت");
  });

  // ── پیش‌نویس ───────────────────────────────────────────────────────

  test("پیش‌نویس شماره نمی‌گیرد و موجودی را تکان نمی‌دهد", async () => {
    const before = await onHand(variationA);
    const draft = await newDraft(keeper);

    assert.equal(draft.number, null, "پیش‌نویس نباید شماره بگیرد");
    assert.equal(draft.status, "draft");
    assert.equal(await onHand(variationA), before, "پیش‌نویس نباید موجودی را عوض کند");
  });

  test("قلم با بارکد اضافه می‌شود؛ همان قیمت روی یک سطر جمع می‌شود", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);

    for (const _ of [1, 2]) {
      const r = await app.inject({
        method: "POST",
        url: `/receipts/${draft.id}/lines`,
        ...s,
        payload: { barcode: barcodeA, qty: "3", unitPrice: "1000000" },
      });
      assert.equal(r.statusCode, 201, r.body);
    }

    const after = (await app.inject({
      method: "GET",
      url: `/receipts/${draft.id}`,
      ...s,
    })).json() as ReceiptBody;

    assert.equal(after.lines.length, 1, "دو بار همان کالا با همان قیمت = یک سطر");
    assert.equal(after.lines[0]?.qty, "6.000");
    assert.equal(after.goodsAmount, "6000000");
  });

  test("همان کالا با قیمت متفاوت، سطر جدا می‌گیرد", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);

    for (const price of ["1000000", "1200000"]) {
      const r = await app.inject({
        method: "POST",
        url: `/receipts/${draft.id}/lines`,
        ...s,
        payload: { variationId: variationA, qty: "2", unitPrice: price },
      });
      assert.equal(r.statusCode, 201, r.body);
    }

    const after = (await app.inject({
      method: "GET",
      url: `/receipts/${draft.id}`,
      ...s,
    })).json() as ReceiptBody;

    // دو نرخ روی یک فاکتور، دو سطر واقعی‌اند. ادغامشان یعنی یکی از دو
    // نرخ پاک شود و بهای تمام‌شده هیچ‌کدام نباشد.
    assert.equal(after.lines.length, 2);
    assert.equal(after.goodsAmount, "4400000");
  });

  test("تعداد اعشاری درست حساب می‌شود — محاسبه در SQL است، نه bigint", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);

    const r = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "2.5", unitPrice: "1000001" },
    });
    assert.equal(r.statusCode, 201, r.body);

    // 2.5 × 1٬000٬001 = 2٬500٬002.5 → round → 2٬500٬003
    // با تقسیم صحیح bigint، ۲٬۵۰۰٬۰۰۲ درمی‌آمد و با جمع دیتابیس
    // نمی‌خواند.
    assert.equal((r.json() as ReceiptBody).goodsAmount, "2500003");
  });

  test("Idempotency-Key تکراری، قلم دوم نمی‌سازد", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    const key = `line-${suffix}-${Math.random()}`;

    const first = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { variationId: variationA, qty: "4", unitPrice: "900000" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      headers: { ...s.headers, "idempotency-key": key },
      payload: { variationId: variationA, qty: "4", unitPrice: "900000" },
    });

    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().replayed, true);

    const body = second.json() as ReceiptBody;
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0]?.qty, "4.000", "Retry نباید تعداد را دو برابر کند");
  });

  // ── ثبت ────────────────────────────────────────────────────────────

  test("ثبت: شماره، موجودی، سند — و هزینه حمل روی بهای تمام‌شده", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    const beforeA = await onHand(variationA);
    const beforeB = await onHand(variationB);

    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "10", unitPrice: "1000000" },
    });
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationB, qty: "10", unitPrice: "1000000" },
    });

    const charge = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/charges`,
      ...s,
      payload: {
        chargeType: "حمل",
        amount: "2000000",
        allocation: "by_value",
        paidFrom: "payable",
        payeeType: "other",
        payeeName: "باربری",
      },
    });
    assert.equal(charge.statusCode, 201, charge.body);

    const posted = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/post`,
      ...s,
    });
    assert.equal(posted.statusCode, 200, posted.body);

    const body = posted.json() as ReceiptBody;
    assert.match(body.number ?? "", /^P-\d{4}-\d{6}$/, `شماره نگرفت: ${body.number}`);
    assert.equal(body.status, "posted");

    assert.equal(await onHand(variationA), beforeA + 10);
    assert.equal(await onHand(variationB), beforeB + 10);

    // هزینه ۲٬۰۰۰٬۰۰۰ روی دو سطر هم‌مبلغ → یک میلیون هرکدام →
    // بهای هر واحد ۱٬۱۰۰٬۰۰۰.
    for (const line of body.lines) {
      assert.equal(line.chargeAlloc, "1000000");
      assert.equal(line.landedUnitCost, "1100000");
    }

    // جمع تخصیص باید **دقیقاً** برابر کل هزینه باشد — وگرنه دفتر و
    // انبار از هم جدا می‌افتند.
    const allocated = body.lines.reduce((a, l) => a + BigInt(l.chargeAlloc), 0n);
    assert.equal(allocated, 2000000n);

    // هزینه بر عهده شخص ثالث است، پس بدهی تأمین‌کننده فقط بهای کالاست.
    assert.equal(body.supplierPayable, "20000000");
    assert.equal(body.thirdPartyPayable, "2000000");

    // سند حسابداری باید متوازن باشد — و به همین رسید بچسبد.
    const entry = await sql<{ n: string; diff: string }>`
      SELECT count(*) AS n,
             coalesce(sum(l.debit) - sum(l.credit), 0) AS diff
        FROM ledger.journal_entry e
        JOIN ledger.journal_line l ON l.entry_id = e.id
       WHERE e.ref_type = 'purchase_receipt' AND e.ref_id = ${draft.id}::uuid`
      .execute(handle.db);
    assert.ok(Number(entry.rows[0]?.n) > 0, "سندی برای این رسید ساخته نشد");
    assert.equal(entry.rows[0]?.diff, "0", "سند نامتوازن");
  });

  test("رسید ثبت‌شده تغییر نمی‌کند", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "1", unitPrice: "500000" },
    });
    const posted = (await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/post`,
      ...s,
    })).json() as ReceiptBody;
    assert.equal(posted.status, "posted");

    const addLine = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationB, qty: "1", unitPrice: "500000" },
    });
    assert.equal(addLine.statusCode, 409, addLine.body);
    assert.equal(addLine.json().error.code, "receipt_posted");

    const patchHead = await app.inject({
      method: "PATCH",
      url: `/receipts/${draft.id}`,
      ...s,
      payload: { taxAmount: "1" },
    });
    assert.equal(patchHead.statusCode, 409, patchHead.body);

    const removeLine = await app.inject({
      method: "DELETE",
      url: `/receipts/${draft.id}/lines/${posted.lines[0]?.id}`,
      ...s,
    });
    assert.equal(removeLine.statusCode, 409, removeLine.body);
  });

  test("ثبت دوباره با همان کلید، محموله را دو بار وارد نمی‌کند", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "7", unitPrice: "800000" },
    });

    const before = await onHand(variationA);
    const key = `post-${suffix}-${Math.random()}`;
    const headers = { ...s.headers, "idempotency-key": key };

    const first = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/post`,
      ...s,
      headers,
    });
    const second = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/post`,
      ...s,
      headers,
    });

    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().replayed, true);
    assert.equal(await onHand(variationA), before + 7, "Replay نباید دوباره وارد کند");
  });

  test("رسید بدون قلم ثبت نمی‌شود", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    const r = await app.inject({ method: "POST", url: `/receipts/${draft.id}/post`, ...s });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "empty_receipt");
  });

  test("ابطال پیش‌نویس؛ شماره‌ای مصرف نمی‌شود", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);

    const cancelled = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/cancel`,
      ...s,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal((cancelled.json() as ReceiptBody).status, "cancelled");
    assert.equal((cancelled.json() as ReceiptBody).number, null);

    const posted = await app.inject({ method: "POST", url: `/receipts/${draft.id}/post`, ...s });
    assert.notEqual(posted.statusCode, 200, "رسید باطل‌شده نباید ثبت شود");
  });

  test("هزینه از خزانه بدون حساب پرداخت‌کننده رد می‌شود", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    const r = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/charges`,
      ...s,
      payload: { chargeType: "ترخیص", amount: "100000", paidFrom: "treasury" },
    });
    assert.equal(r.statusCode, 400, r.body);
  });

  test("هزینه «بدون تخصیص» به بهای کالا نمی‌رود", async () => {
    // رگرسیون مهاجرت ۰۲۶: تا پیش از آن، این هزینه تمامش روی آخرین
    // قلم می‌نشست — گزینه‌ای که می‌گفت «به بها نرو» همه‌اش را روی یک
    // قلم دلخواه می‌گذاشت و هیچ خطایی هم نمی‌داد.
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);

    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "2", unitPrice: "1000000" },
    });
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationB, qty: "2", unitPrice: "1000000" },
    });

    const charge = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/charges`,
      ...s,
      payload: {
        chargeType: "بسته‌بندی",
        amount: "600000",
        allocation: "none",
        paidFrom: "payable",
        payeeType: "other",
        expenseAccountCode: "6103",
      },
    });
    assert.equal(charge.statusCode, 201, charge.body);

    const posted = (await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/post`,
      ...s,
    })).json() as ReceiptBody;
    assert.equal(posted.status, "posted");

    for (const line of posted.lines) {
      assert.equal(line.chargeAlloc, "0", "هیچ سطری نباید سهمی از این هزینه بگیرد");
      assert.equal(line.landedUnitCost, "1000000", "بهای واحد نباید بالا برود");
    }

    const expense = await sql<{ debit: string }>`
      SELECT coalesce(sum(l.debit), 0) AS debit
        FROM ledger.journal_entry e
        JOIN ledger.journal_line l ON l.entry_id = e.id
       WHERE e.ref_type = 'purchase_receipt' AND e.ref_id = ${draft.id}::uuid
         AND l.account_code = '6103'`.execute(handle.db);
    assert.equal(expense.rows[0]?.debit, "600000", "هزینه باید روی سرفصل خودش بنشیند");
  });

  test("سرفصل هزینه روی تخصیصِ واردشونده به بها رد می‌شود", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    const r = await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/charges`,
      ...s,
      payload: {
        chargeType: "حمل",
        amount: "1000",
        allocation: "by_value",
        expenseAccountCode: "6103",
      },
    });
    // انتخابی که اثر ندارد نباید بی‌صدا پذیرفته شود.
    assert.equal(r.statusCode, 400, r.body);
  });

  // ── برگشت از خرید ─────────────────────────────────────────────────

  test("برگشت از خرید: بدهی به بهای فاکتور، انبار به بهای دفتری", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);

    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "10", unitPrice: "1000000" },
    });
    // حمل ۲٬۰۰۰٬۰۰۰ روی یک سطر → سهم هر واحد ۲۰۰٬۰۰۰،
    // بهای دفتری هر واحد ۱٬۲۰۰٬۰۰۰.
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/charges`,
      ...s,
      payload: {
        chargeType: "حمل",
        amount: "2000000",
        allocation: "by_value",
        paidFrom: "payable",
        payeeType: "other",
      },
    });
    await app.inject({ method: "POST", url: `/receipts/${draft.id}/post`, ...s });

    const before = await onHand(variationA);

    const view = (await app.inject({
      method: "GET",
      url: `/receipts/${draft.id}/returnable`,
      ...s,
    })).json() as {
      lines: { receiptLineId: string; remainingQty: string; landedUnitCost: string }[];
    };
    assert.equal(view.lines[0]?.remainingQty, "10.000");
    assert.equal(view.lines[0]?.landedUnitCost, "1200000", "بهای دفتری شامل حمل است");

    const posted = await app.inject({
      method: "POST",
      url: "/purchase-returns",
      ...s,
      payload: {
        receiptId: draft.id,
        reasonCode: "quality",
        lines: [{ receiptLineId: view.lines[0]?.receiptLineId, qty: "2" }],
      },
    });
    assert.equal(posted.statusCode, 201, posted.body);

    const body = posted.json() as {
      number: string | null;
      status: string;
      goodsAmount: string;
      costAmount: string;
      chargeLoss: string;
    };
    assert.match(body.number ?? "", /^PR-\d{4}-\d{6}$/, `شماره نگرفت: ${body.number}`);
    assert.equal(body.status, "posted");
    // این سه عدد قلب موضوع‌اند: بدهی به بهای فاکتور، انبار به بهای
    // دفتری، و تفاوتشان حملی که برنمی‌گردد.
    assert.equal(body.goodsAmount, "2000000");
    assert.equal(body.costAmount, "2400000");
    assert.equal(body.chargeLoss, "400000");

    assert.equal(await onHand(variationA), before - 2);

    const entry = await sql<{ payable: string; inventory: string; loss: string; diff: string }>`
      SELECT coalesce(sum(l.debit)  FILTER (WHERE l.account_code = '2101'), 0) AS payable,
             coalesce(sum(l.credit) FILTER (WHERE l.account_code = '1301'), 0) AS inventory,
             coalesce(sum(l.debit)  FILTER (WHERE l.account_code = '5102'), 0) AS loss,
             coalesce(sum(l.debit) - sum(l.credit), 0) AS diff
        FROM ledger.journal_entry e
        JOIN ledger.journal_line l ON l.entry_id = e.id
       WHERE e.ref_type = 'purchase_return'`
      .execute(handle.db);
    assert.equal(entry.rows[0]?.payable, "2000000");
    assert.equal(entry.rows[0]?.inventory, "2400000");
    assert.equal(entry.rows[0]?.loss, "400000");
    assert.equal(entry.rows[0]?.diff, "0", "سند نامتوازن");
  });

  test("یافتن رسید از روی شماره، سمت سرور", async () => {
    // فیلتر روی فهرست کافی نبود: فهرست سقف دارد و رسید سه ماه پیش در
    // آن نیست.
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "1", unitPrice: "100000" },
    });
    const posted = (await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/post`,
      ...s,
    })).json() as ReceiptBody;

    const found = await app.inject({
      method: "GET",
      url: `/receipts/lookup?number=${encodeURIComponent(posted.number ?? "")}&branchId=${BRANCH}`,
      ...s,
    });
    assert.equal(found.statusCode, 200, found.body);
    assert.equal((found.json() as ReceiptBody).id, draft.id);

    const missing = await app.inject({
      method: "GET",
      url: `/receipts/lookup?number=P-0000-000000&branchId=${BRANCH}`,
      ...s,
    });
    assert.equal(missing.statusCode, 404, missing.body);
  });

  test("بیشتر از باقی‌مانده برنمی‌گردد", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    await app.inject({
      method: "POST",
      url: `/receipts/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationB, qty: "3", unitPrice: "1000000" },
    });
    await app.inject({ method: "POST", url: `/receipts/${draft.id}/post`, ...s });

    const view = (await app.inject({
      method: "GET",
      url: `/receipts/${draft.id}/returnable`,
      ...s,
    })).json() as { lines: { receiptLineId: string }[] };

    const r = await app.inject({
      method: "POST",
      url: "/purchase-returns",
      ...s,
      payload: {
        receiptId: draft.id,
        reasonCode: "quality",
        lines: [{ receiptLineId: view.lines[0]?.receiptLineId, qty: "4" }],
      },
    });
    assert.notEqual(r.statusCode, 201, "۴ عدد از ۳ عدد رسیدشده نباید برگردد");
  });

  test("رسید ثبت‌نشده برگشت ندارد", async () => {
    const s = await loginAs(keeper);
    const draft = await newDraft(keeper);
    const r = await app.inject({
      method: "GET",
      url: `/receipts/${draft.id}/returnable`,
      ...s,
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "receipt_not_posted");
  });

  test("قلمی از رسید دیگر، برگشت نمی‌خورد", async () => {
    // بدون این بررسی، یک شناسه از رسید دیگر می‌توانست بهای آن رسید را
    // برگرداند در حالی که بدهی این تأمین‌کننده کم می‌شد.
    const s = await loginAs(keeper);

    const a = await newDraft(keeper);
    await app.inject({
      method: "POST",
      url: `/receipts/${a.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "2", unitPrice: "500000" },
    });
    await app.inject({ method: "POST", url: `/receipts/${a.id}/post`, ...s });

    const b = await newDraft(keeper);
    await app.inject({
      method: "POST",
      url: `/receipts/${b.id}/lines`,
      ...s,
      payload: { variationId: variationB, qty: "2", unitPrice: "500000" },
    });
    await app.inject({ method: "POST", url: `/receipts/${b.id}/post`, ...s });

    const viewB = (await app.inject({
      method: "GET",
      url: `/receipts/${b.id}/returnable`,
      ...s,
    })).json() as { lines: { receiptLineId: string }[] };

    const r = await app.inject({
      method: "POST",
      url: "/purchase-returns",
      ...s,
      payload: {
        receiptId: a.id,
        reasonCode: "quality",
        lines: [{ receiptLineId: viewB.lines[0]?.receiptLineId, qty: "1" }],
      },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "line_not_in_receipt");
  });

  test("فهرست حساب‌های پرداخت، صندوق فروشگاه را نشان نمی‌دهد", async () => {
    const s = await loginAs(keeper);
    const r = await app.inject({ method: "GET", url: "/purchasing/pay-accounts", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const kinds = (r.json() as { kind: string }[]).map((a) => a.kind);
    // دیتابیس هم ردش می‌کند؛ ولی گزینه‌ای که سرور ردش می‌کند، تله است.
    assert.ok(!kinds.includes("cash_box"), "صندوق فروشگاه نباید در فهرست باشد");
    assert.ok(kinds.length > 0, "فهرست نباید خالی باشد");
  });
});
