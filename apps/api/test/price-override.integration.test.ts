/**
 * تست یکپارچه قیمت دستی روی سطر فاکتور — روی پستگرس واقعی.
 *
 * ادعای مرکزی، و تنها دلیل وجود این فایل:
 *
 *   **قیمت دستی نباید راهی برای دور زدن سقف تخفیف باشد.**
 *
 * تست SQL ثابت می‌کند دیتابیس دلیل را اجبار می‌کند، ولی نردبان مجوز
 * در لایه API است — و همان‌جاست که یک صندوق‌دارِ با سقف ۱۰٪ می‌توانست
 * به‌جای تخفیف، قیمت را نصف بنویسد. این را فقط با راندن مسیر واقعی
 * می‌شود سنجید.
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

interface Line {
  id: string;
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  listPrice: string | null;
  priceOverrideReason: string | null;
}
interface InvoiceJson {
  id: string;
  netAmount: string;
  lines: Line[];
}

describe("قیمت دستی روی سطر فاکتور", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `p${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-قیمت-دستی-و-به‌قدر-کافی-بلند";
  const cashier = `pcash_${suffix}`;
  const supervisor = `psup_${suffix}`;
  let supervisorId = "";
  let variationId = "";

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

  /** فاکتور صندوق شیفت باز می‌خواهد — یک بار برای هر کاربر. */
  async function ensureShift(username: string) {
    const s = await loginAs(username);
    const cur = await app.inject({
      method: "GET",
      url: `/shifts/current?branchId=${BRANCH}`,
      ...s,
    });
    if (cur.statusCode === 200 && cur.body !== "null") return;
    const r = await app.inject({
      method: "POST",
      url: "/shifts",
      ...s,
      payload: { branchId: BRANCH, openingCash: "0" },
    });
    assert.equal(r.statusCode, 201, `باز کردن شیفت ${username}: ${r.body}`);
  }

  async function newDraft(username: string): Promise<string> {
    await ensureShift(username);
    const s = await loginAs(username);
    const r = await app.inject({
      method: "POST",
      url: "/invoices",
      ...s,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
    });
    assert.equal(r.statusCode, 201, r.body);
    return (JSON.parse(r.body) as InvoiceJson).id;
  }

  async function addLine(
    username: string,
    invoiceId: string,
    payload: Record<string, string>,
  ) {
    const s = await loginAs(username);
    return await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/lines`,
      ...s,
      payload,
    });
  }

  async function setPrice(
    username: string,
    invoiceId: string,
    lineId: string,
    payload: Record<string, string>,
  ) {
    const s = await loginAs(username);
    return await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}/price`,
      ...s,
      payload,
    });
  }

  /** یک پیش‌نویس با یک سطر به قیمت فهرست — نقطه شروع تست‌های قیمت دستی. */
  async function draftWithLine(username: string, qty = "1") {
    const invoiceId = await newDraft(username);
    const r = await addLine(username, invoiceId, { variationId, qty });
    assert.equal(r.statusCode, 201, r.body);
    return { invoiceId, lineId: (JSON.parse(r.body) as InvoiceJson).lines[0]!.id };
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [cashier, "صندوق‌دار قیمت", "cashier"],
      [supervisor, "سرپرست قیمت", "supervisor"],
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
      if (role === "supervisor") supervisorId = u.id;
    }

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'کت تست قیمت') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${prod.rows[0]!.id}, 'مشکی', 'L', ${`SKU-${suffix}`}) RETURNING id`
      .execute(handle.db);
    variationId = v.rows[0]!.id;

    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 1000000)`.execute(handle.db);
    await sql`SELECT platform.set_actor(${supervisorId}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 100, 'purchase_receipt',
                'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${supervisorId}::uuid, 400000)`.execute(handle.db);

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

  test("بدون قیمت دستی، رفتار قبلی دست‌نخورده است", async () => {
    const inv = await newDraft(cashier);
    const r = await addLine(cashier, inv, { variationId, qty: "1" });
    assert.equal(r.statusCode, 201, r.body);
    const line = (JSON.parse(r.body) as InvoiceJson).lines[0] as Line;
    assert.equal(line.unitPrice, "1000000", "قیمت از دیتابیس آمده");
    assert.equal(line.listPrice, null, "سطر دست‌نخورده listPrice ندارد");
  });

  test("صندوق‌دار اصلاً حق تایپ‌کردن قیمت ندارد", async () => {
    const inv = await newDraft(cashier);
    const r = await addLine(cashier, inv, { variationId, qty: "1", unitPrice: "950000" });
    assert.equal(r.statusCode, 403, r.body);
    const b = JSON.parse(r.body) as { error: { code: string } };
    assert.equal(b.error.code, "deny");
  });

  test("سرپرست قیمت را دستی می‌نویسد و فاکتور فقط یک قیمت نشان می‌دهد", async () => {
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, {
      variationId,
      qty: "2",
      unitPrice: "900000",
      priceOverrideReason: "چانه‌زنی مشتری",
    });
    assert.equal(r.statusCode, 201, r.body);
    const body = JSON.parse(r.body) as InvoiceJson;
    const line = body.lines[0] as Line;

    // این چهار ادعا با هم یعنی «دو قیمت روی فاکتور نمی‌خورد»:
    assert.equal(line.unitPrice, "900000", "قیمت سطر همان قیمت دستی است");
    assert.equal(line.discountAmount, "0", "تفاوت به تخفیف تبدیل نشده");
    assert.equal(line.netAmount, "1800000", "خالص از قیمت دستی ساخته شده");
    assert.equal(body.netAmount, "1800000", "جمع فاکتور هم همین است");

    // و قیمت فهرست فقط برای حسابرسی برمی‌گردد
    assert.equal(line.listPrice, "1000000");
    assert.equal(line.priceOverrideReason, "چانه‌زنی مشتری");
  });

  test("قیمت دستی برابر با فهرست، بازنویسی حساب نمی‌شود", async () => {
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, { variationId, qty: "1", unitPrice: "1000000" });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal((JSON.parse(r.body) as InvoiceJson).lines[0]?.listPrice, null);
  });

  test("قیمت دستی سقف تخفیف نقش را دور نمی‌زند", async () => {
    // **ادعای مرکزی این فایل.**
    //
    // سقف سرپرست ۲۵٪ است و بالاتر از آن تأیید مدیر می‌خواهد. قیمت
    // ۵۰۰٬۰۰۰ یعنی ۵۰٪ زیر فهرست — پس باید همان ۴۲۸ «نیازمند تأیید»
    // را بگیرد که یک تخفیف ۵۰٪ می‌گرفت، نه ۲۰۱.
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, {
      variationId,
      qty: "1",
      unitPrice: "500000",
      priceOverrideReason: "تست سقف",
    });
    assert.equal(r.statusCode, 428, r.body);
    assert.equal((JSON.parse(r.body) as { error: { code: string } }).error.code, "needs_approval");
  });

  test("تخفیف و قیمت دستی با هم، در یک سقف سنجیده می‌شوند", async () => {
    // ۱۵٪ از راه قیمت + ۱۵٪ از راه تخفیف = ۳۰٪ کاهش کل. هیچ‌کدام
    // به‌تنهایی از سقف ۲۵٪ سرپرست رد نمی‌شوند، ولی جمعشان می‌شود.
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, {
      variationId,
      qty: "1",
      unitPrice: "850000",
      discountAmount: "150000",
      priceOverrideReason: "تست جمع",
    });
    assert.equal(r.statusCode, 428, r.body);
  });

  test("گران‌تر از فهرست، نردبان تخفیف را فعال نمی‌کند", async () => {
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, { variationId, qty: "1", unitPrice: "1500000" });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal((JSON.parse(r.body) as InvoiceJson).lines[0]?.unitPrice, "1500000");
  });

  test("کاهش بالای آستانه بدون دلیل، از دیتابیس ۴۰۹ می‌گیرد", async () => {
    // آستانه ۱۰٪ است و سقف سرپرست ۲۵٪ — پس ۲۰٪ از مجوز رد می‌شود ولی
    // به نگهبان دلیل می‌خورد. لایه‌های مستقل، هر کدام کار خودشان.
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, { variationId, qty: "1", unitPrice: "800000" });
    assert.equal(r.statusCode, 409, r.body);
    const b = JSON.parse(r.body) as { error: { code: string; message: string } };
    assert.equal(b.error.code, "rule_violation");
    assert.match(b.error.message, /دلیل/);
  });

  test("قیمت صفر از هیچ مسیری", async () => {
    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, { variationId, qty: "1", unitPrice: "0" });
    assert.equal(r.statusCode, 422, r.body);
  });

  test("تغییر قیمت، ردّ حسابرسی می‌گذارد", async () => {
    const before = await sql<{ n: string }>`
      SELECT count(*) AS n FROM platform.audit_log WHERE action = 'sale.price_override'`
      .execute(handle.db);

    const inv = await newDraft(supervisor);
    const r = await addLine(supervisor, inv, {
      variationId,
      qty: "1",
      unitPrice: "920000",
      priceOverrideReason: "کالای ویترینی",
    });
    assert.equal(r.statusCode, 201, r.body);

    const rows = await sql<{ reason: string | null; after: Record<string, string> }>`
      SELECT reason, after FROM platform.audit_log
       WHERE action = 'sale.price_override' ORDER BY id DESC LIMIT 1`.execute(handle.db);
    assert.equal(Number(rows.rows.length), 1);
    assert.equal(rows.rows[0]?.reason, "کالای ویترینی");
    assert.equal(rows.rows[0]?.after.listPrice, "1000000");
    assert.equal(rows.rows[0]?.after.unitPrice, "920000");

    // و سطر عادی رویداد حسابرسی نمی‌سازد — وگرنه لاگ با هر اسکن پر
    // می‌شود و همان چیزی که باید دیده شود گم می‌شود.
    const inv2 = await newDraft(supervisor);
    await addLine(supervisor, inv2, { variationId, qty: "1" });
    const afterRows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM platform.audit_log WHERE action = 'sale.price_override'`
      .execute(handle.db);
    assert.equal(Number(afterRows.rows[0]!.n), Number(before.rows[0]!.n) + 1);
  });
  // ── قیمت دستی روی سطری که همین حالا در سبد است ────────────────────
  //
  // مسیر `PATCH /lines/:id/price` همان دروازه `POST /lines` را دارد.
  // این تست‌ها ثابت می‌کنند «همان» یعنی همان، نه یک کپی که عقب مانده.

  test("صندوق‌دار قیمت سطر را هم عوض نمی‌کند", async () => {
    const { invoiceId, lineId } = await draftWithLine(cashier);
    const r = await setPrice(cashier, invoiceId, lineId, { unitPrice: "950000" });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal((JSON.parse(r.body) as { error: { code: string } }).error.code, "deny");
  });

  test("سرپرست قیمت سطر اسکن‌شده را عوض می‌کند", async () => {
    const { invoiceId, lineId } = await draftWithLine(supervisor, "2");
    const r = await setPrice(supervisor, invoiceId, lineId, { unitPrice: "900000" });
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as InvoiceJson;
    const line = body.lines[0] as Line;
    assert.equal(line.unitPrice, "900000", "قیمت تازه روی سطر نشسته");
    assert.equal(line.discountAmount, "0", "به تخفیف تبدیل نشده");
    assert.equal(line.listPrice, "1000000", "قیمت فهرست Snapshot شده");
    assert.equal(line.netAmount, "1800000");
    assert.equal(body.netAmount, "1800000", "جمع فاکتور همان لحظه تازه شده");
  });

  test("تغییر دوم، Snapshot اول را دست نمی‌زند — و سقف را دور نمی‌زند", async () => {
    // **ادعای مرکزی این بخش.**
    //
    // اگر هر تغییر، قیمت جاری سطر را «فهرست» می‌گرفت، این دنباله سقف
    // ۲۵٪ سرپرست را دور می‌زد: ۹۰۰٬۰۰۰ یعنی ۱۰٪ (مجاز)، و بعد
    // ۷۰۰٬۰۰۰ نسبت به ۹۰۰٬۰۰۰ یعنی ۲۲٪ (باز هم مجاز) — در حالی که
    // کاهش واقعی نسبت به فهرست ۳۰٪ است.
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    assert.equal(
      (await setPrice(supervisor, invoiceId, lineId, { unitPrice: "900000" })).statusCode,
      200,
    );
    const r = await setPrice(supervisor, invoiceId, lineId, {
      unitPrice: "700000",
      priceOverrideReason: "تست سقف",
    });
    assert.equal(r.statusCode, 428, r.body);
    assert.equal((JSON.parse(r.body) as { error: { code: string } }).error.code, "needs_approval");

    // و سطر دست‌نخورده مانده — رد شدن یعنی هیچ‌چیز ننوشته شد.
    const after = await app.inject({
      method: "GET",
      url: `/invoices/${invoiceId}`,
      ...(await loginAs(supervisor)),
    });
    assert.equal((JSON.parse(after.body) as InvoiceJson).lines[0]?.unitPrice, "900000");
  });

  test("برگشت به قیمت فهرست، Snapshot و دلیل را پاک می‌کند", async () => {
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    await setPrice(supervisor, invoiceId, lineId, {
      unitPrice: "920000",
      priceOverrideReason: "اشتباه تایپی",
    });
    const r = await setPrice(supervisor, invoiceId, lineId, { unitPrice: "1000000" });
    assert.equal(r.statusCode, 200, r.body);
    const line = (JSON.parse(r.body) as InvoiceJson).lines[0] as Line;
    assert.equal(line.listPrice, null, "سطر دوباره دست‌نخورده است");
    assert.equal(line.priceOverrideReason, null);
    assert.equal(line.netAmount, "1000000");
  });

  test("تخفیفِ ثبت‌شده در سقفِ قیمت تازه هم می‌آید", async () => {
    // ۱۵٪ تخفیف مجاز است، و ۱۵٪ کاهش قیمت هم. با هم ۳۰٪ می‌شوند و
    // باید همان تأیید مدیر را بخواهند.
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    const d = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoiceId}/lines/${lineId}/discount`,
      ...(await loginAs(supervisor)),
      payload: { discountAmount: "150000", discountReason: "تخفیف پرسنلی" },
    });
    assert.equal(d.statusCode, 200, d.body);
    const r = await setPrice(supervisor, invoiceId, lineId, {
      unitPrice: "850000",
      priceOverrideReason: "تست جمع",
    });
    assert.equal(r.statusCode, 428, r.body);
  });

  test("کاهش بالای آستانه بدون دلیل، از دیتابیس ۴۰۹ می‌گیرد", async () => {
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    const r = await setPrice(supervisor, invoiceId, lineId, { unitPrice: "800000" });
    assert.equal(r.statusCode, 409, r.body);
    const b = JSON.parse(r.body) as { error: { code: string; message: string } };
    assert.equal(b.error.code, "rule_violation");
    assert.match(b.error.message, /دلیل/);
  });

  test("قیمت صفر و سطر ناموجود", async () => {
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    assert.equal(
      (await setPrice(supervisor, invoiceId, lineId, { unitPrice: "0" })).statusCode,
      422,
    );
    const r = await setPrice(
      supervisor,
      invoiceId,
      "00000000-0000-7000-8000-0000000009ff",
      { unitPrice: "900000" },
    );
    assert.equal(r.statusCode, 404, r.body);
  });

  test("تغییر قیمت سطر، ردّ حسابرسی با مقدار پیش و پس می‌گذارد", async () => {
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    const r = await setPrice(supervisor, invoiceId, lineId, {
      unitPrice: "930000",
      priceOverrideReason: "کالای ویترینی",
    });
    assert.equal(r.statusCode, 200, r.body);

    const rows = await sql<{
      reason: string | null;
      before: Record<string, string | null>;
      after: Record<string, string>;
    }>`SELECT reason, before, after FROM platform.audit_log
        WHERE action = 'sale.price_override' AND entity_id = ${lineId}
        ORDER BY id DESC LIMIT 1`.execute(handle.db);
    assert.equal(rows.rows.length, 1, "ردّ حسابرسی از خودِ تابع دیتابیس می‌آید");
    assert.equal(rows.rows[0]?.reason, "کالای ویترینی");
    assert.equal(rows.rows[0]?.before.unitPrice, "1000000");
    assert.equal(rows.rows[0]?.after.unitPrice, "930000");
  });

  test("حراجِ وسط پیش‌نویس، سقف را جابه‌جا نمی‌کند", async () => {
    // سناریوی واقعی: مشتری ساعت ۱۰ کالا را آورده و قیمت ۱٬۰۰۰٬۰۰۰
    // بوده. ساعت ۱۰:۳۰ مالک حراج می‌گذارد و قیمت فهرست ۵۰۰٬۰۰۰
    // می‌شود. حالا سرپرست روی همان پیش‌نویس ۷۵۰٬۰۰۰ می‌نویسد.
    //
    // اگر دروازه قیمت **امروز** را فهرست بگیرد، ۷۵۰٬۰۰۰ گران‌تر از
    // فهرست است و هیچ سقفی فعال نمی‌شود — در حالی که `list_price`
    // نشسته روی سطر ۱٬۰۰۰٬۰۰۰ است و نگهبان دیتابیس همان را می‌بیند.
    // دو لایه، دو عدد.
    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-SALE-${suffix}`}, 'کالای حراج') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${prod.rows[0]!.id}, 'سفید', 'M', ${`SKU-SALE-${suffix}`}) RETURNING id`
      .execute(handle.db);
    const saleVar = v.rows[0]!.id;
    // `platform.set_actor()` با `is_local = true` ست می‌شود، پس فقط
    // داخل همان تراکنش معنا دارد — روی Pool اشتراکی به دستور بعدی
    // نمی‌رسد. به همین دلیل هر دو در یک تراکنش‌اند.
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${supervisorId}::uuid)`.execute(trx);
      await sql`SELECT catalog.set_price(${saleVar}::uuid, 1000000)`.execute(trx);
      await sql`SELECT inventory.apply_movement(
                  ${saleVar}::uuid, ${STORE_WH}::uuid, 10, 'purchase_receipt',
                  'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${supervisorId}::uuid, 400000)`.execute(trx);
    });

    const invoiceId = await newDraft(supervisor);
    const added = await addLine(supervisor, invoiceId, { variationId: saleVar, qty: "1" });
    assert.equal(added.statusCode, 201, added.body);
    const lineId = (JSON.parse(added.body) as InvoiceJson).lines[0]!.id;

    // حراج، **بعد از** باز شدن پیش‌نویس
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${supervisorId}::uuid)`.execute(trx);
      await sql`SELECT catalog.set_price(${saleVar}::uuid, 500000, 'markdown',
                  'حراج وسط شیفت')`.execute(trx);
    });

    // ۷۰۰٬۰۰۰ نسبت به فهرستِ لحظه فاکتور (۱٬۰۰۰٬۰۰۰) یعنی ۳۰٪ — بالای
    // سقف ۲۵٪ سرپرست، پس باید ۴۲۸ «نیازمند تأیید» بگیرد.
    //
    // **دلیل عمداً فرستاده می‌شود** تا نگهبان دیتابیس از سر راه کنار
    // برود و فقط نردبان مجوز سنجیده شود. بدون دلیل، ۴۰۹ دیتابیس
    // هر دو حالت را می‌پوشاند و این تست هیچ‌چیز را ثابت نمی‌کرد.
    //
    // اگر دروازه قیمت **امروز** (۵۰۰٬۰۰۰) را فهرست بگیرد، ۷۰۰٬۰۰۰
    // گران‌تر از فهرست است، کاهش صفر می‌شود و پاسخ ۲۰۰ — یعنی همان
    // سقفی که کل این مسیر برایش وجود دارد، بی‌صدا دور زده می‌شود.
    const r = await setPrice(supervisor, invoiceId, lineId, {
      unitPrice: "700000",
      priceOverrideReason: "حراج",
    });
    assert.equal(r.statusCode, 428, `سقف باید از قیمت لحظه فاکتور سنجیده شود: ${r.body}`);
  });

  test("فاکتور نهایی‌شده قیمت عوض نمی‌کند", async () => {
    const { invoiceId, lineId } = await draftWithLine(supervisor);
    const s = await loginAs(supervisor);
    const pay = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      ...s,
      payload: { methodCode: "cash", amount: "1000000" },
    });
    assert.equal(pay.statusCode, 201, pay.body);
    const fin = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/finalize`,
      ...s,
      payload: {},
    });
    assert.equal(fin.statusCode, 200, fin.body);

    const r = await setPrice(supervisor, invoiceId, lineId, {
      unitPrice: "900000",
      priceOverrideReason: "دیر شد",
    });
    assert.equal(r.statusCode, 409, r.body);
  });
});
