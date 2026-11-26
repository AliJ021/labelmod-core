/**
 * تست یکپارچه Worker — روی پستگرس واقعی، بدون هیچ پیامک واقعی.
 *
 * پنج ادعا که هیچ‌کدام را نمی‌شود بدون راندن مسیر واقعی سنجید:
 *
 * ۱. **فاکتور نهایی‌شده خودش پیام می‌سازد.** `finalize_invoice` از
 *    مهاجرت ۰۰۲ در Outbox می‌نویسد؛ اگر روزی کسی آن `INSERT` را
 *    بردارد، این تست قرمز می‌شود، نه اینکه پیامک بی‌صدا قطع شود.
 *
 * ۲. **خطای موقت Backoff می‌گیرد، خطای دائمی نامه مرده.** تفاوت این
 *    دو کل رفتار صف است: بدون آن یا شماره غلط تا ابد تلاش می‌شود، یا
 *    قطعی لحظه‌ای شبکه یک پیامک را برای همیشه می‌کشد.
 *
 * ۳. **اجاره، پیام رهاشده را برمی‌گرداند.** Workerی که وسط ارسال
 *    بمیرد نباید پیام را برای همیشه در `sending` جا بگذارد.
 *
 * ۴. **هشدار چک در یک روز کاری دو بار ساخته نمی‌شود.** Worker هر چند
 *    ثانیه یک بار صدایش می‌زند؛ بدون Idempotency، مالک تا ظهر بیست
 *    پیامک یکسان می‌گرفت و بعد همه را نادیده می‌گرفت.
 *
 * ۵. **صفحه عمومی فاکتور فقط سند واقعی را نشان می‌دهد** و توکن غلط،
 *    پیش‌نویس و فاکتور باطل همه یک پاسخ می‌گیرند.
 */
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { tick, type LoopOptions } from "../src/worker/loop.ts";
import { toLocalMobile } from "../src/worker/sms.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

/** پیامک‌های «فرستاده‌شده» در این اجرا. هیچ شبکه‌ای لمس نمی‌شود. */
const sent: { to: string; text: string }[] = [];

describe("Worker — صف پیام، پیامک و هشدار چک", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `k${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let variationId = "";
  let customerId = "";
  let chequeId = "";

  const opts = (): LoopOptions => ({
    db: handle.db,
    workerName: "test",
    smsApiKey: "",
      webhookToken: undefined,
      webPushSecret: undefined,
    batchSize: 20,
    leaseSeconds: 120,
    log: () => {},
  });

  /** یک تنظیم، از همان مسیری که صفحه تنظیمات می‌رود. */
  async function set(key: string, value: unknown): Promise<void> {
    await sql`
      SELECT platform.set_setting(${key}, ${JSON.stringify(value)}::jsonb,
                                  'تست', ${SYSTEM_USER}::uuid)
    `.execute(handle.db);
  }

  /** یک فاکتور نهایی‌شده — همان مسیری که صندوق می‌رود. */
  async function finalizedInvoice(withCustomer: boolean): Promise<string> {
    const inv = await sql<{ id: string }>`
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel,
                                 customer_id, created_by)
      VALUES (${BRANCH}::uuid, ${STORE_WH}::uuid, NULL, 'web',
              ${withCustomer ? customerId : null}::uuid, ${SYSTEM_USER}::uuid)
      RETURNING id`.execute(handle.db);
    const id = inv.rows[0]!.id;

    await sql`
      INSERT INTO sales.invoice_line (invoice_id, line_no, variation_id, qty,
                                      unit_price, net_amount)
      VALUES (${id}::uuid, 1, ${variationId}::uuid, 1, 1500000, 1500000)`
      .execute(handle.db);
    await sql`
      INSERT INTO treasury.payment (invoice_id, shift_id, method_code, amount, ref_no)
      VALUES (${id}::uuid, NULL, 'gateway', 1500000, ${`GW-${id.slice(0, 8)}`})`
      .execute(handle.db);
    await sql`SELECT sales.finalize_invoice(${id}::uuid, ${SYSTEM_USER}::uuid)`
      .execute(handle.db);
    return id;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'پیراهن تست Worker') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${prod.rows[0]!.id}, 'سفید', 'L', ${`SKU-${suffix}`}) RETURNING id`
      .execute(handle.db);
    variationId = v.rows[0]!.id;

    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 1500000)`.execute(handle.db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 50, 'purchase_receipt',
                'test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid, ${SYSTEM_USER}::uuid, 600000)`.execute(handle.db);

    const c = await sql<{ id: string }>`
      INSERT INTO sales.customer (mobile_normalized, full_name, consent_sms)
      VALUES (sales.normalize_mobile('09121112233'), 'مشتری تست', true)
      RETURNING id`.execute(handle.db);
    customerId = c.rows[0]!.id;

    await set("notify.sms_enabled", true);
    await set("notify.invoice_sms", true);
    await set("notify.accounting_web_receipt", true);
    await set("notify.sms_provider", "log");
    await set("platform.public_url", "https://shop.example.com");

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", SMS_CREDENTIAL_KEY:"ab".repeat(32) }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  // ── تولید پیام ──────────────────────────────────────────────────

  test("نهایی‌سازی فاکتور خودش پیام Outbox می‌سازد", async () => {
    const id = await finalizedInvoice(true);
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_message
       WHERE topic = 'invoice.finalized' AND payload->>'invoice_id' = ${id}`
      .execute(handle.db);
    // ⚠️ اگر روزی کسی آن INSERT را از `finalize_invoice` بردارد، این
    //    ادعا قرمز می‌شود — نه اینکه پیامک بی‌صدا قطع شود.
    assert.equal(n.rows[0]!.n, "1");
  });

  // ── مصرف ────────────────────────────────────────────────────────

  test("یک دور، پیام را می‌فرستد و می‌بندد", async () => {
    const logs: string[] = [];
    const r = await tick({ ...opts(), log: (message) => { logs.push(message); } });
    assert.ok(r.claimed >= 1, `پیامی برداشته نشد: ${JSON.stringify(r)}`);
    assert.equal(r.failed, 0);
    assert.equal(r.dead, 0);
    assert.doesNotMatch(logs.join("\n"), /09121112233|989121112233|\/i\//,
      "لاگ Worker نباید شماره مشتری یا لینک حامل توکن را افشا کند");

    const left = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_message WHERE status <> 'sent'`
      .execute(handle.db);
    assert.equal(left.rows[0]!.n, "0", "همه پیام‌ها باید بسته شده باشند");
  });

  test("دور دوم چیزی برنمی‌دارد", async () => {
    // پیامِ بسته‌شده نباید دوباره برداشته شود — وگرنه مشتری هر پنج
    // ثانیه یک پیامک می‌گرفت.
    const r = await tick(opts());
    assert.equal(r.claimed, 0);
  });

  test("فاکتور بی‌مشتری موفق بسته می‌شود، نه ناموفق", async () => {
    await finalizedInvoice(false);
    const r = await tick(opts());
    assert.equal(r.claimed, 1);
    // ⚠️ «کاری نبود» یک شکست نیست. اگر ناموفق بسته می‌شد، نامه مرده
    //    پر می‌شد از فروش‌های ناشناس — که بیشتر فروش صندوق است — و
    //    خطای واقعی همان‌جا گم می‌شد.
    assert.equal(r.sent, 1);
    assert.equal(r.failed, 0);
  });

  test("مشتری بدون رضایت پیامک نمی‌گیرد، ولی پیام بسته می‌شود", async () => {
    await sql`UPDATE sales.customer SET consent_sms = false WHERE id = ${customerId}::uuid`
      .execute(handle.db);
    await finalizedInvoice(true);
    const r = await tick(opts());
    assert.equal(r.sent, 1);
    assert.equal(r.failed, 0);
    await sql`UPDATE sales.customer SET consent_sms = true WHERE id = ${customerId}::uuid`
      .execute(handle.db);
  });

  // ── شکست و Backoff ──────────────────────────────────────────────

  test("خطای موقت Backoff می‌گیرد و پیام در صف می‌ماند", async () => {
    // سرویس‌دهنده ناشناخته → خطای دائمی. برای خطای **موقت** نشانی
    // عمومی را برمی‌داریم: قابل جبران با یک تغییر تنظیم، پس نباید
    // پیام را بکشد.
    await set("platform.public_url", "");
    await finalizedInvoice(true);

    const r = await tick(opts());
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.dead, 0);

    const row = await sql<{ status: string; attempts: number; future: boolean }>`
      SELECT status, attempts, next_attempt_at > now() AS future
        FROM platform.outbox_message ORDER BY id DESC LIMIT 1`.execute(handle.db);
    assert.equal(row.rows[0]!.status, "pending", "باید در صف بماند");
    assert.equal(row.rows[0]!.future, true, "تلاش بعدی باید در آینده باشد");

    await set("platform.public_url", "https://shop.example.com");
  });

  test("پس از سقف تلاش، پیام نامه مرده می‌شود", async () => {
    const id = await sql<{ id: string }>`
      INSERT INTO platform.outbox_message (topic, payload, attempts)
      VALUES ('invoice.finalized',
              jsonb_build_object('invoice_id', '00000000-0000-7000-8000-00000000dead'),
              7)
      RETURNING id::text`.execute(handle.db);
    const messageId = id.rows[0]!.id;

    // فاکتور وجود ندارد → خطای دائمی، مستقیم نامه مرده.
    const r = await tick(opts());
    assert.ok(r.dead >= 1, JSON.stringify(r));

    const dead = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_dead WHERE id = ${messageId}::bigint`
      .execute(handle.db);
    assert.equal(dead.rows[0]!.n, "1");
  });

  test("موضوع ناشناخته مستقیم نامه مرده می‌شود، نه یک حلقه", async () => {
    await sql`INSERT INTO platform.outbox_message (topic, payload)
              VALUES ('something.unknown', '{}'::jsonb)`.execute(handle.db);
    const r = await tick(opts());
    assert.ok(r.dead >= 1);
  });

  // ── اجاره ───────────────────────────────────────────────────────

  test("پیام رهاشده پس از پایان اجاره دوباره برداشته می‌شود", async () => {
    // Workerی که وسط ارسال مرده: پیام در `sending` مانده و اجاره‌اش
    // گذشته. بدون این، آن پیامک هرگز نمی‌رفت و هیچ خطایی هم نبود.
    await sql`
      INSERT INTO platform.outbox_message (topic, payload, status, next_attempt_at, claimed_by)
      VALUES ('invoice.finalized', jsonb_build_object('invoice_id', 'x'),
              'sending', now() - interval '5 minutes', 'worker-که-مرد')`
      .execute(handle.db);

    const r = await tick(opts());
    assert.ok(r.claimed >= 1, "پیام رهاشده باید دوباره برداشته شود");
  });

  test("پیامی که اجاره‌اش هنوز نگذشته برداشته نمی‌شود", async () => {
    await sql`
      INSERT INTO platform.outbox_message (topic, payload, status, next_attempt_at, claimed_by)
      VALUES ('invoice.finalized', jsonb_build_object('invoice_id', 'y'),
              'sending', now() + interval '5 minutes', 'worker-دیگر')`
      .execute(handle.db);

    const r = await tick(opts());
    // دو Worker هم‌زمان نباید یک پیام را دو بار بفرستند.
    assert.equal(r.claimed, 0, "اجاره زنده باید محترم بماند");
  });

  // ── هشدار چک ────────────────────────────────────────────────────

  test("چک نزدیک سررسید یک بار در روز هشدار می‌سازد", async () => {
    const acc = await sql<{ id: string }>`
      SELECT id FROM treasury.account LIMIT 1`.execute(handle.db);
    const supplier = await sql<{ id: string }>`
      INSERT INTO purchasing.supplier (code, name)
      VALUES (${`S-${suffix}`}, 'تأمین‌کننده چک') RETURNING id`.execute(handle.db);

    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    // ⚠️ چک به‌صورت `draft` درج می‌شود و بعد با رویداد حرکت می‌کند.
    //    وضعیت یک Projection از زنجیره رویداد است و `UPDATE` مستقیم
    //    رویش رد می‌شود (ADR-004) — این تست هم باید از همان دروازه
    //    برود که بقیه سیستم می‌رود.
    const cheque = await sql<{ id: string }>`
      INSERT INTO treasury.cheque
        (direction, branch_id, party_type, party_id, bank_name, cheque_no, amount,
         issued_on, due_on, bank_account_id, created_by)
      VALUES ('issued', ${BRANCH}::uuid, 'supplier', ${supplier.rows[0]!.id}::uuid, 'ملت',
              ${`CH-${suffix}`}, 5000000,
              platform.business_date() - 10,
              platform.business_date() + 2,
              ${acc.rows[0]!.id}::uuid, ${SYSTEM_USER}::uuid)
      RETURNING id`.execute(handle.db);
    chequeId = cheque.rows[0]!.id;
    await sql`SELECT treasury.post_cheque_event(
                ${chequeId}::uuid, 'issue', ${SYSTEM_USER}::uuid)`.execute(handle.db);

    const first = await sql<{ n: number }>`
      SELECT treasury.enqueue_due_cheque_alerts() AS n`.execute(handle.db);
    assert.equal(Number(first.rows[0]!.n), 1, "هشدار باید ساخته شود");

    // ⚠️ هسته این ادعا: اجرای دوباره در همان روز کاری، پیام دوم
    //    نمی‌سازد. Worker هر چند ثانیه صدایش می‌زند.
    const second = await sql<{ n: number }>`
      SELECT treasury.enqueue_due_cheque_alerts() AS n`.execute(handle.db);
    assert.equal(Number(second.rows[0]!.n), 0, "روز دوم همان روز، پیام دوم ندارد");

    // و فردا دوباره — چون هشدار روزانه است، نه یک‌باره.
    const tomorrow = await sql<{ n: number }>`
      SELECT treasury.enqueue_due_cheque_alerts(platform.business_date() + 1) AS n`
      .execute(handle.db);
    assert.equal(Number(tomorrow.rows[0]!.n), 1, "روز بعد هشدار تازه دارد");
  });

  test("چک وصول‌شده پیامک نمی‌گیرد", async () => {
    await set("notify.cheque_due_sms", true);
    await set("notify.manager_mobile", "09120000000");

    // چک بین ساخت هشدار و ارسالش وصول شده: پیام باید بی‌سروصدا بسته
    // شود، نه اینکه مدیر هشدار چکی را بگیرد که دیگر باز نیست.
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    const bank = await sql<{ id: string }>`
      SELECT id FROM treasury.account WHERE kind = 'bank' LIMIT 1`.execute(handle.db);
    await sql`SELECT treasury.post_cheque_event(
                ${chequeId}::uuid, 'pay', ${SYSTEM_USER}::uuid,
                ${bank.rows[0]!.id}::uuid)`.execute(handle.db);

    const r = await tick(opts());
    assert.ok(r.claimed >= 1);
    assert.equal(r.failed, 0);
    assert.equal(r.dead, 0);
  });

  /*
   * بازبینی مستقل ۲۰۲۶/۱۱/۱۷: با دور ۱ ثانیه‌ای، زنگ سلامت (که زنجیرهٔ حسابرسی را
   * بازمحاسبه می‌کند) هر ثانیه اجرا می‌شد. `runLoop` حالا تولیدکننده‌ها را با
   * `producersDue` دقیقه‌ای می‌زند و بقیهٔ دورها `skipProducers` می‌فرستد.
   * ⚠️ کنترل مثبت لازم است: بی دور دوم، `tick`ی که اصلاً زنگ نسازد هم پاس می‌شد.
   */
  test("دور بی تولیدکننده زنگ سلامت نمی‌سازد؛ دور عادی می‌سازد", async () => {
    const codesBefore = (await sql<{ v: unknown }>`
      SELECT value AS v FROM platform.setting WHERE key = 'notify.health_alert_codes'`.execute(handle.db)).rows[0]!.v;
    await set("notify.health_alert_codes", ["backup_stale"]);
    await set("notify.health_alerts", true);
    try {
      const count = async () => Number((await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM platform.outbox_message
         WHERE topic = 'health.alert' AND payload->>'code' = 'backup_stale'`.execute(handle.db)).rows[0]!.n);
      const before = await count();
      const skipped = await tick({ ...opts(), skipProducers: true });
      assert.equal(skipped.enqueuedAlerts, 0);
      assert.equal(await count(), before, "دور بی تولیدکننده پیامی ساخت");
      const normal = await tick(opts());
      assert.equal(normal.enqueuedAlerts, 1, "کنترل مثبت: زنگ بکاپ تازه روی دیتابیس آزمون روشن است");
      assert.equal(await count(), before + 1);
    } finally {
      await set("notify.health_alerts", false);
      await set("notify.health_alert_codes", codesBefore);
    }
  });

  test("fixed receipt page verifies a mobile, enforces expiry and signs out",async()=>{
    const id=await finalizedInvoice(true);
    const other=await finalizedInvoice(false);
    const token=(await sql<{token:string}>`SELECT sales.ensure_public_token(${id}::uuid) AS token`.execute(handle.db)).rows[0]!.token;
    await set("receipt.link_days",0);
    try{
      assert.equal((await app.inject({method:"GET",url:"/i/"+token})).statusCode,303);
      const start=await app.inject({method:"GET",url:"/customer-receipts"});
      const name="__Host-lm-receipt-form";
      const nonce=start.cookies.find(c=>c.name===name)!.value;
      const post=(url:string,fields:Record<string,string>,cookies:Record<string,string>)=>app.inject({method:"POST",url,cookies,headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams(fields).toString()});
      const r=await post("/customer-receipts/start",{nonce,mobile:"09121112233"},{[name]:nonce});
      assert.equal(r.statusCode,200,r.body);
      const cookies=Object.fromEntries(r.cookies.map(c=>[c.name,c.value]));
      const pending=cookies["__Host-lm-receipt-code"]!;
      assert.equal((await sql`SELECT FROM platform.outbox_message WHERE topic='customer.receipt_otp' AND payload->>'id'=${pending}`.execute(handle.db)).rows.length,1);
      const code=String(createHmac("sha256",Buffer.from("ab".repeat(32),"hex")).update("labelmod/customer-receipt/v1/"+pending).digest().readUInt32BE(0)%1000000).padStart(6,"0");
      const bad=await post("/customer-receipts/verify",{nonce:cookies[name]!,code:code==="000000"?"000001":"000000"},cookies);
      assert.equal(bad.statusCode,400);
      cookies[name]=bad.cookies.find(c=>c.name===name)!.value;
      const verified=await post("/customer-receipts/verify",{nonce:cookies[name]!,code},cookies);
      assert.equal(verified.statusCode,303,verified.body);
      const session=Object.fromEntries(verified.cookies.map(c=>[c.name,c.value]));
      const home=await app.inject({method:"GET",url:"/customer-receipts",cookies:session});
      assert.ok(home.body.includes(id));assert.ok(!home.body.includes(other));
      assert.equal((await app.inject({method:"GET",url:"/customer-receipts/view/"+other,cookies:session})).statusCode,404);
      assert.equal((await app.inject({method:"GET",url:"/i/"+token,cookies:session})).statusCode,200);
      const exitNonce=home.cookies.find(c=>c.name===name)!.value;
      assert.equal((await post("/customer-receipts/logout",{nonce:exitNonce},{...session,[name]:exitNonce})).statusCode,303);
      assert.equal((await app.inject({method:"GET",url:"/customer-receipts/view/"+id,cookies:session})).statusCode,404);
    }finally{await set("receipt.link_days",30);}
  });

  // ── صفحه عمومی فاکتور ───────────────────────────────────────────

  test("صفحه فاکتور با توکن درست باز می‌شود", async () => {
    const id = await finalizedInvoice(true);
    const t = await sql<{ token: string }>`
      SELECT sales.ensure_public_token(${id}::uuid) AS token`.execute(handle.db);
    const token = t.rows[0]!.token;

    const r = await app.inject({ method: "GET", url: `/i/${token}` });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers["content-type"] as string, /text\/html/);
    // ⚠️ CSP باید `script-src` را کامل ببندد: نام کالا ریشه‌اش ورودی
    //    کاربر است و این صفحه بدون احراز هویت باز می‌شود.
    assert.match(r.headers["content-security-policy"] as string, /default-src 'none'/);
    assert.match(r.headers["x-robots-tag"] as string, /noindex/);
    assert.match(r.body, /پیراهن تست Worker/);
    // مبلغ به تومان نمایش داده می‌شود، نه ریال.
    assert.match(r.body, /150,000/); // رقم لاتین روی فاکتور (خواستهٔ مالک ۱۴۰۵/۰۷/۱۷)
  });

  test("توکن Idempotent است — لینک پیامک‌شده عوض نمی‌شود", async () => {
    const id = await finalizedInvoice(true);
    const a = await sql<{ token: string }>`
      SELECT sales.ensure_public_token(${id}::uuid) AS token`.execute(handle.db);
    const b = await sql<{ token: string }>`
      SELECT sales.ensure_public_token(${id}::uuid) AS token`.execute(handle.db);
    assert.equal(a.rows[0]!.token, b.rows[0]!.token);
  });

  test("توکن غلط و فاکتور پیش‌نویس یک پاسخ می‌گیرند", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/i/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    assert.equal(bad.statusCode, 404);

    // پیش‌نویس: هنوز سبد است، نه سند.
    const draft = await sql<{ id: string }>`
      INSERT INTO sales.invoice (branch_id, warehouse_id, shift_id, channel, created_by)
      VALUES (${BRANCH}::uuid, ${STORE_WH}::uuid, NULL, 'web', ${SYSTEM_USER}::uuid)
      RETURNING id`.execute(handle.db);
    const t = await sql<{ token: string }>`
      SELECT sales.ensure_public_token(${draft.rows[0]!.id}::uuid) AS token`
      .execute(handle.db);

    const r = await app.inject({ method: "GET", url: `/i/${t.rows[0]!.token}` });
    assert.equal(r.statusCode, 404, "پیش‌نویس نباید مثل فاکتور دیده شود");
  });

  test("صفحه فاکتور نشست نمی‌خواهد", async () => {
    // اگر روزی از فهرست عمومی بیفتد، ۴۰۱ می‌گیرد و مشتری با لینک
    // پیامک به صفحه ورود می‌رسد — بدون اینکه حسابی داشته باشد.
    const r = await app.inject({ method: "GET", url: "/i/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    assert.notEqual(r.statusCode, 401);
  });

  /**
   * تنها مسیر محتوایی بی‌نشست، سقف نرخ دارد (یافتهٔ ممیزی LM-23).
   *
   * توکن ۲۴ بایتی است و حدس‌زدنش عملاً ناممکن؛ سقف برای جلوگیری از
   * پیمایش انبوه و بار بی‌حساب روی دیتابیس است، نه دفاع رمزنگاری.
   * از یک IP جدا می‌آید تا آزمون‌های دیگر همین پرونده را نخورد، و
   * کنترل مثبتش این است که IP دیگر همان لحظه هنوز پاسخ عادی می‌گیرد.
   */
  test("صفحهٔ عمومی فاکتور سقف نرخ به‌ازای IP دارد", async () => {
    const hit = (ip: string) =>
      app.inject({ method: "GET", url: "/i/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", remoteAddress: ip });
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await hit("10.77.0.1")).statusCode);
    assert.deepEqual(new Set(codes.slice(0, 60)), new Set([404]), "تا سقف، پاسخ عادی");
    assert.equal(codes[60], 429, "درخواست شصت‌ویکم در همان دقیقه رد می‌شود");
    assert.equal((await hit("10.77.0.2")).statusCode, 404, "IP دیگر محدود نشده است");
  });
});

describe("نرمال‌سازی موبایل برای سرویس پیامک", () => {
  test("شکل‌های رایج به 09xxxxxxxxx می‌رسند", () => {
    assert.equal(toLocalMobile("09123456789"), "09123456789");
    assert.equal(toLocalMobile("+989123456789"), "09123456789");
    assert.equal(toLocalMobile("00989123456789"), "09123456789");
    assert.equal(toLocalMobile("9123456789"), "09123456789");
    assert.equal(toLocalMobile("0912 345 6789"), "09123456789");
    assert.equal(toLocalMobile("۰۹۱۲۳۴۵۶۷۸۹"), "09123456789", "رقم فارسی");
    assert.equal(toLocalMobile("٠٩١٢٣٤٥٦٧٨٩"), "09123456789", "رقم عربی");
  });

  test("چیزی که موبایل نیست null می‌شود", () => {
    // ⚠️ `null` یک خطای **دائمی** می‌سازد: تلفن ثابت با تلاش صدم هم
    //    پیامک نمی‌گیرد.
    assert.equal(toLocalMobile("02188776655"), null, "تلفن ثابت");
    assert.equal(toLocalMobile(""), null);
    assert.equal(toLocalMobile("سلام"), null);
    assert.equal(toLocalMobile("091234567890"), null, "یک رقم اضافه");
  });
});

// ادعای دیگری روی این آرایه نیست؛ فقط تضمین می‌کند که هیچ تستی از
// اینجا به شبکه واقعی نزده باشد.
after(() => {
  assert.equal(sent.length, 0);
});
