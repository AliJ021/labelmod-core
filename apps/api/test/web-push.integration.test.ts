/**
 * ارسال لحظه‌ای به سایت، **از فروش تا گیرنده** — ADR-007.
 *
 * ── چرا این تست جدا از `web-push.test.ts` است ───────────────────────
 *
 * آن پرونده فرستنده را با `fetch` ساختگی می‌سنجد. این یکی کل مسیر را
 * می‌راند: حرکت انبار → درج در `outbox_message` → `tick()` واقعی →
 * یک سرور HTTP محلی که **همان قرارداد افزونه** را پیاده کرده (امضا،
 * پنجرهٔ زمانی، Nonce یک‌بارمصرف، نگهبان نسخه).
 *
 * ⚠️ **و صریح بگوییم این چه چیزی نیست:** ووکامرس واقعی نیست. گیرنده
 *    اینجا همان الگوریتم `class-lmc-push-receiver.php` را دارد، نه
 *    خودِ آن کد. پس این تست ثابت می‌کند **قرارداد دو طرف می‌خواند** و
 *    ترتیب و تکرار درست مدیریت می‌شوند؛ ثابت **نمی‌کند** که افزونه روی
 *    یک وردپرس واقعی فعال می‌شود یا HPOS را درست می‌بیند. آن‌ها در
 *    فهرست «پیش از بهره‌برداری» می‌مانند.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { tick, type LoopOptions } from "../src/worker/loop.ts";
import { makePinnedPost } from "../src/worker/web-push.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";
const SECRET = "کلید-یکپارچه-۴۲";
/** نشانی «سایت» — یک نام عمومی که هرگز Resolve نمی‌شود. */
const SITE = "https://shop.example.test";

interface Received {
  path: string;
  status: number;
  payload: Record<string, unknown>;
  applied: boolean;
}

describe("ارسال لحظه‌ای به سایت — از حرکت انبار تا گیرنده", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let server: Server;
  let port = 0;

  /** آنچه گیرنده «نوشته» — همان نقش `_stock` و `_lmc_stock_version`. */
  const site = new Map<string, { onHand: number | null; price: string | null; version: number }>();
  const log: Received[] = [];
  const seenNonces = new Set<string>();
  /** کالایی که سایت نمی‌شناسد — برای ادعای «۴۰۴ نده». */
  let unknownVariation = "";

  /**
   * مقصد را به گیرندهٔ محلی نگاشت می‌کند، **بی دست‌زدن به نگهبان SSRF**.
   *
   * ⚠️ نگهبان در `web-push.test.ts` مستقیم و کامل سنجیده می‌شود. اینجا
   *    مسئله **قرارداد دو طرف** است، نه شبکه — پس به‌جای ضعیف‌کردن
   *    نگهبان، نشانی در همین تست نگاشت می‌شود. دقیقاً کاری که یک Proxy
   *    می‌کند.
   */
  const to = (target: number) => async (raw: string) => ({
    url: new URL(raw.replace(SITE, `http://127.0.0.1:${target}`)),
    ip: "127.0.0.1",
    /*
     * ⚠️ از FND-R60-02 به بعد، اتصال به **همین فهرست** پین می‌شود. پس
     *    این تست حالا ادعای بیشتری هم دارد: اگر پین به لایهٔ اتصال
     *    نرسد، هیچ درخواستی به گیرندهٔ محلی نمی‌رسد و کل پرونده قرمز
     *    می‌شود.
     */
    ips: ["127.0.0.1"],
  });

  const opts = (deps?: LoopOptions["webPushDeps"]): LoopOptions => ({
    db: handle.db,
    workerName: "test-push",
    smsApiKey: "",
    webhookToken: undefined,
    webPushSecret: SECRET,
    webPushDeps: deps ?? { resolveTarget: to(port) },
    batchSize: 50,
    leaseSeconds: 120,
    log: () => {},
  });

  async function set(key: string, value: unknown): Promise<void> {
    await sql`
      SELECT platform.set_setting(${key}, ${JSON.stringify(value)}::jsonb,
                                  'تست', ${SYSTEM_USER}::uuid)
    `.execute(handle.db);
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    /*
     * گیرندهٔ محلی — همان چهار سنجشی که افزونه دارد.
     *
     * ⚠️ عمداً **بازنویسی مستقل** است، نه صدا زدن `signBody` فرستنده.
     *    تستی که امضا را با همان تابعی بسنجد که ساخته، فقط سازگاری
     *    تابع با خودش را ثابت می‌کند — همان اشکالی که برای TOTP گرفته
     *    شد.
     */
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const ts = String(req.headers["x-lmc-timestamp"] ?? "");
        const nonce = String(req.headers["x-lmc-nonce"] ?? "");
        const sig = String(req.headers["x-lmc-signature"] ?? "").replace(/^sha256=/, "");

        const reply = (status: number, applied: boolean, payload: Record<string, unknown>): void => {
          log.push({ path: req.url ?? "", status, payload, applied });
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: status < 400, applied }));
        };

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          reply(400, false, {});
          return;
        }

        if (ts === "" || nonce === "" || sig === "") { reply(401, false, parsed); return; }
        if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) { reply(401, false, parsed); return; }

        const expect = createHmac("sha256", SECRET)
          .update(`${ts}.${nonce}.${body}`, "utf8").digest("hex");
        if (expect !== sig) { reply(403, false, parsed); return; }
        if (seenNonces.has(nonce)) { reply(409, false, parsed); return; }
        seenNonces.add(nonce);

        const id = String(parsed["variationId"] ?? "");
        // کالای ناشناخته: ۲۰۰ و نه ۴۰۴ — وگرنه Core آن را شکست دائمی
        // می‌شمارد و به نامهٔ مرده می‌فرستد.
        if (id === unknownVariation) { reply(200, false, parsed); return; }

        const version = Number(parsed["version"] ?? 0);
        const cur = site.get(id) ?? { onHand: null, price: null, version: 0 };
        // ⚠️ `>=` — تحویل تکراریِ همان پیام هم دور انداخته می‌شود.
        if (cur.version > 0 && version <= cur.version) { reply(200, false, parsed); return; }

        if (req.url?.includes("/stock")) cur.onHand = Number(parsed["onHand"]);
        else cur.price = parsed["priceRial"] === null ? null : String(parsed["priceRial"]);
        cur.version = version;
        site.set(id, cur);
        reply(200, true, parsed);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;

    await set("web.push_enabled", true);
    await set("web.site_url", SITE);
    await set("web.stock_warehouse", "STORE");
  });

  after(async () => {
    await handle?.close();
    disposable?.drop();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  /**
   * فرستنده با `https` اجباری است ولی سرور تست `http` است. به‌جای
   * ضعیف‌کردن آن قاعده، مقصد در **همان لحظه** به سرور محلی نگاشت
   * می‌شود — دقیقاً کاری که یک Proxy می‌کند.
   *
   * ⚠️ سنجش SSRF با این دور زده **نمی‌شود**: آن در `web-push.test.ts`
   *    مستقیم سنجیده شده. اینجا مسئله قرارداد است، نه شبکه.
   */
  async function pushAll(): Promise<void> {
    // چند دور، تا صف واقعاً خالی شود.
    for (let i = 0; i < 5; i++) {
      const r = await tick(opts());
      if (r.claimed === 0) break;
    }
  }

  async function makeVariation(sku: string): Promise<string> {
    const p = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal) VALUES (${`P-${sku}`}, ${sku})
      RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${p.rows[0]!.id}::uuid, 'سفید', '38', ${sku}) RETURNING id`.execute(handle.db);
    return v.rows[0]!.id;
  }

  async function move(variation: string, qty: number): Promise<void> {
    // یک تراکنش، به همان دلیل `is_local = true` که پایین توضیح داده شد.
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(trx);
      await sql`
        SELECT inventory.apply_movement(
          ${variation}::uuid, ${STORE_WH}::uuid, ${qty}::platform.qty,
          ${qty > 0 ? "purchase_receipt" : "sale"}, 'test',
          '00000000-0000-7000-8000-00000000fa11'::uuid, ${SYSTEM_USER}::uuid,
          ${qty > 0 ? 500000 : null}::platform.money)
      `.execute(trx);
    });
  }

  test("فروش → سایت در همان دور به‌روز می‌شود", async () => {
    const v = await makeVariation("PUSH-1");
    await move(v, 20);
    await move(v, -3);
    await pushAll();

    assert.equal(site.get(v)?.onHand, 17, "سایت باید ۱۷ ببیند");
    // ⚠️ دو حرکت، **یک** درخواست: تجمیع در صف اتفاق افتاده.
    const stockCalls = log.filter((l) => l.path.includes("/stock") && l.applied);
    assert.equal(stockCalls.length, 1, `انتظار یک درخواست، ${stockCalls.length} رفت`);
  });

  test("فروش آخرین قلم → سایت صفر می‌بیند، نه «موجود»", async () => {
    const v = await makeVariation("PUSH-2");
    await move(v, 1);
    await pushAll();
    assert.equal(site.get(v)?.onHand, 1);

    await move(v, -1);
    await pushAll();
    assert.equal(site.get(v)?.onHand, 0, "آخرین قلم که رفت، سایت باید صفر ببیند");
  });

  test("تحویل تکراریِ همان پیام، موجودی را دو بار کم نمی‌کند", async () => {
    const v = await makeVariation("PUSH-3");
    await move(v, 10);
    await pushAll();
    assert.equal(site.get(v)?.onHand, 10);

    // همان پیام را دستی دوباره در صف بگذار — دقیقاً همان Payload.
    const row = await sql<{ payload: Record<string, unknown> }>`
      SELECT payload FROM platform.outbox_message
       WHERE topic = 'web.stock_push' AND payload->>'variationId' = ${v}
       ORDER BY id DESC LIMIT 1`.execute(handle.db);
    await sql`
      INSERT INTO platform.outbox_message (topic, payload)
      VALUES ('web.stock_push', ${JSON.stringify(row.rows[0]!.payload)}::jsonb)
    `.execute(handle.db);
    await pushAll();

    // مقدار **مطلق** است: تکرار همان عدد را دوباره می‌نشاند، نه کم‌تر.
    assert.equal(site.get(v)?.onHand, 10, "تکرار نباید عدد را عوض کند");
  });

  test("دو پیام خارج از ترتیب — عدد کهنه، تازه را بازنویسی نمی‌کند", async () => {
    const v = await makeVariation("PUSH-4");
    await move(v, 30);
    await pushAll();
    const fresh = site.get(v)!;
    assert.equal(fresh.onHand, 30);

    // یک پیام با نسخهٔ **کوچک‌تر** — همان چیزی که یک تحویل دیررس است.
    await sql`
      INSERT INTO platform.outbox_message (topic, payload)
      VALUES ('web.stock_push', ${JSON.stringify({
        variationId: v, sku: "PUSH-4", onHand: 999, version: fresh.version - 1,
      })}::jsonb)`.execute(handle.db);
    await pushAll();

    assert.equal(site.get(v)?.onHand, 30, "عدد کهنه نباید بنشیند");
  });

  test("۵۰ فروش پشت سر هم → یک درخواست، نه ۵۰ تا", async () => {
    const v = await makeVariation("PUSH-5");
    await move(v, 100);
    await pushAll();

    const before = log.filter((l) => l.path.includes("/stock")).length;
    for (let i = 0; i < 50; i++) await move(v, -1);
    await pushAll();
    const after = log.filter((l) => l.path.includes("/stock")).length;

    assert.equal(after - before, 1, `۵۰ حرکت باید یک درخواست بسازد، ${after - before} شد`);
    assert.equal(site.get(v)?.onHand, 50);
  });

  test("سایت پایین → فروش کامل می‌شود و پیام در صف می‌ماند", async () => {
    const v = await makeVariation("PUSH-6");
    await move(v, 8);

    // پورتی که هیچ‌کس روی آن گوش نمی‌دهد: «سایت پایین است».
    // فروش قبلاً Commit شده — این ادعای اصلی است.
    const r = await tick(opts({ resolveTarget: to(1) }));
    assert.ok(r.claimed >= 1, "پیام برداشته شد");

    const stillQueued = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_message
       WHERE topic = 'web.stock_push' AND status IN ('pending','sending')
         AND payload->>'variationId' = ${v}`.execute(handle.db);
    assert.equal(stillQueued.rows[0]!.n, "1", "پیام باید در صف بماند");

    // و موجودی در Core دست‌نخورده است — قطعی سایت فروش را برنگرداند.
    const bal = await sql<{ q: string }>`
      SELECT trim_scale(on_hand)::text AS q FROM inventory.stock_balance
       WHERE variation_id = ${v}::uuid AND warehouse_id = ${STORE_WH}::uuid`
      .execute(handle.db);
    assert.equal(bal.rows[0]!.q, "8");

    /*
     * و بعد که سایت برگشت، پیام می‌رود.
     *
     * ⚠️ Backoff باید صریح جلو برده شود، وگرنه `tick` بعدی چیزی
     *    برنمی‌دارد و این تست به‌جای «پیام بالاخره رفت»، در واقع
     *    «Backoff کار می‌کند» را می‌سنجید — یک سبزِ بی‌ربط.
     */
    await sql`
      UPDATE platform.outbox_message SET next_attempt_at = now()
       WHERE topic = 'web.stock_push' AND payload->>'variationId' = ${v}
    `.execute(handle.db);
    await pushAll();
    assert.equal(site.get(v)?.onHand, 8);
  });

  test("کالای ناشناختهٔ سایت → ۲۰۰، نه نامهٔ مرده", async () => {
    const v = await makeVariation("PUSH-7");
    unknownVariation = v;
    await move(v, 5);
    await pushAll();

    const dead = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_message
       WHERE payload->>'variationId' = ${v} AND status = 'dead'`.execute(handle.db);
    assert.equal(dead.rows[0]!.n, "0", "کالای نبوده در سایت یک خطا نیست");
    unknownVariation = "";
  });

  test("تغییر قیمت → لحظه‌ای، و رشته می‌ماند", async () => {
    const v = await makeVariation("PUSH-8");
    /*
     * ⚠️ هر دو در **یک تراکنش**: `set_actor` با `is_local = true` ست
     *    می‌شود، پس فقط تا پایان همان تراکنش زنده است. دو `execute`
     *    جدا روی یک Pool ممکن است دو اتصال متفاوت بگیرند و دومی
     *    «کاربر عامل ست نشده» بدهد — که هیچ ربطی به واقعیت ندارد.
     */
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(trx);
      await sql`SELECT catalog.set_price(${v}::uuid, 1850000, 'regular', 'تست')`.execute(trx);
    });
    await pushAll();
    assert.equal(site.get(v)?.price, "1850000");
  });

  test("امضای غلط → ۴۰۳ و پیام **دائمی** شکست می‌خورد", async () => {
    const v = await makeVariation("PUSH-9");
    await move(v, 4);

    const realPost = makePinnedPost();
    await tick(opts({
      resolveTarget: to(port),
      post: async (t, init) => await realPost(t, {
        ...init,
        // امضای خراب — بقیهٔ مسیر (پین، اتصال، هدرها) واقعی می‌ماند.
        headers: { ...init.headers, "x-lmc-signature": `sha256=${"0".repeat(64)}` },
      }),
    }));

    const row = await sql<{ status: string }>`
      SELECT status FROM platform.outbox_message
       WHERE topic = 'web.stock_push' AND payload->>'variationId' = ${v}
       ORDER BY id DESC LIMIT 1`.execute(handle.db);
    // ۴۰۳ یعنی امضا غلط است؛ تلاش صدم هم درستش نمی‌کند.
    assert.equal(row.rows[0]!.status, "dead", "امضای غلط باید مستقیم نامهٔ مرده بگیرد");
  });

  test("خاموش‌کردن → صف تازه پر نمی‌شود", async () => {
    await set("web.push_enabled", false);
    const v = await makeVariation("PUSH-10");
    await move(v, 3);
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_message
       WHERE payload->>'variationId' = ${v}`.execute(handle.db);
    assert.equal(n.rows[0]!.n, "0");
    await set("web.push_enabled", true);
  });
});
