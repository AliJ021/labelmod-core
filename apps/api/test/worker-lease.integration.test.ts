/**
 * مالکیت اجاره در **حلقهٔ واقعی Worker** — روی پستگرس واقعی، بی شبکه.
 *
 * `db/test/outbox-lease.sql` توابع را مستقیم می‌سنجد. اینجا ادعا دربارهٔ
 * `tick()` است: آیا Worker از توکن استفاده می‌کند، پیش از هر پیام تمدید
 * می‌کند، و Retry-After سنجیده را به دیتابیس می‌رساند؟ «Worker دیگر» با
 * همان `claim_outbox` واقعی ساخته می‌شود، **وسط ارسال**، از داخل فرستندهٔ
 * ساختگی — یعنی دقیقاً همان پنجره‌ای که probe ریشه نشان داد.
 *
 * ۱. فرستاده شد ولی اجاره در این میان به B رسید ← بسته نمی‌شود؛ مال B می‌ماند.
 * ۲. شکست خورد ولی اجاره به B رسید ← هیچ خطا یا زمانی ثبت نمی‌شود.
 * ۳. پیام دوم دسته پیش از نوبتش به B رسید ← اصلاً فرستاده نمی‌شود.
 * ۴. ۴۲۹ با Retry-After ← تلاش بعدی همان‌قدر عقب می‌رود (کنترل: بی هدر، Backoff عادی).
 * ۵. خط web پیام غیرسایت را برنمی‌دارد و برعکس.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { tick, type LoopOptions, type WorkerLane } from "../src/worker/loop.ts";
import type { PinnedPostResult } from "../src/worker/web-push.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

describe("اجارهٔ Outbox در حلقهٔ Worker", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  /** رفتار «سایت» برای هر ارسال؛ هر تست خودش می‌گذارد. */
  let onPost: (n: number, body: { variationId?: string }) => Promise<PinnedPostResult> = async () => ({ status: 200 });
  let posts = 0;

  const opts = (lane: WorkerLane = "web"): LoopOptions => ({
    db: handle.db,
    workerName: "A",
    smsApiKey: "",
    webhookToken: undefined,
    webPushSecret: "synthetic-push-secret",
    webPushDeps: {
      resolveTarget: async raw => ({ url: new URL(raw), ip: "203.0.113.10", ips: ["203.0.113.10"] }),
      post: async (_target, init) => onPost(++posts, JSON.parse(init.body) as { variationId?: string }),
    },
    batchSize: 20,
    leaseSeconds: 120,
    lane,
    log: () => {},
  });

  async function set(key: string, value: unknown): Promise<void> {
    await sql`SELECT platform.set_setting(${key}, ${JSON.stringify(value)}::jsonb, 'تست', ${SYSTEM_USER}::uuid)`
      .execute(handle.db);
  }

  async function enqueue(topic: string): Promise<string> {
    const r = await sql<{ id: string }>`
      INSERT INTO platform.outbox_message (topic, payload)
      VALUES (${topic}, jsonb_build_object('variationId', gen_random_uuid()::text, 'onHand', 1, 'version', 1))
      RETURNING id`.execute(handle.db);
    return r.rows[0]!.id;
  }

  /** «Worker B»: اجارهٔ همین پیام را منقضی می‌کند و با claim واقعی برمی‌دارد. */
  async function steal(id: string): Promise<string> {
    await sql`UPDATE platform.outbox_message SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}::bigint`
      .execute(handle.db);
    const r = await sql<{ id: string; claim_token: string }>`
      SELECT id, claim_token FROM platform.claim_outbox(200, 'B', 120,
        ARRAY['web.stock_push','web.price_push','web.instore_push'])`.execute(handle.db);
    const mine = r.rows.find(x => x.id === id);
    assert.ok(mine, "B باید همین پیام را برداشته باشد");
    assert.equal(r.rows.length, 1, "B فقط پیام منقضی را برمی‌دارد");
    return mine.claim_token;
  }

  async function row(id: string) {
    const r = await sql<{
      status: string; attempts: number; claimed_by: string | null; claim_token: string | null;
      sent: boolean; last_error: string | null; delay_s: number;
    }>`
      SELECT status, attempts, claimed_by, claim_token::text AS claim_token, sent_at IS NOT NULL AS sent,
             last_error, round(extract(epoch FROM next_attempt_at - now()))::int AS delay_s
        FROM platform.outbox_message WHERE id = ${id}::bigint`.execute(handle.db);
    return r.rows[0]!;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    await set("web.push_enabled", true);
    await set("web.site_url", "https://shop.example.test");
    await set("web.stock_warehouse", "STORE");
  });

  beforeEach(async () => {
    posts = 0;
    onPost = async () => ({ status: 200 });
    // هر تست صف خودش را دارد؛ پیام‌های تست قبلی مزاحم شمارش نمی‌شوند.
    await sql`DELETE FROM platform.outbox_message`.execute(handle.db);
  });

  after(async () => {
    await handle?.close();
    disposable?.drop();
  });

  test("فرستاده شد ولی اجاره در این میان به B رسید — بسته نمی‌شود و مال B می‌ماند", async () => {
    const id = await enqueue("web.stock_push");
    let tokenB = "";
    onPost = async () => { tokenB = await steal(id); return { status: 200 }; };

    const r = await tick(opts());
    assert.deepEqual({ claimed: r.claimed, sent: r.sent, lost: r.lost, failed: r.failed, dead: r.dead },
      { claimed: 1, sent: 0, lost: 1, failed: 0, dead: 0 });
    const after = await row(id);
    assert.deepEqual(
      { status: after.status, attempts: after.attempts, by: after.claimed_by, token: after.claim_token, sent: after.sent },
      { status: "sending", attempts: 2, by: "B", token: tokenB, sent: false },
      "A دیررس نباید پیامِ B را sent کند",
    );

    // کنترل مثبت: B که مالک است می‌بندد.
    const ok = await sql<{ ok: boolean }>`SELECT platform.complete_outbox(${id}::bigint, ${tokenB}::uuid) AS ok`
      .execute(handle.db);
    assert.equal(ok.rows[0]?.ok, true);
  });

  test("شکست خورد ولی اجاره به B رسید — نه خطا، نه زمان، نه وضعیت ثبت می‌شود", async () => {
    const id = await enqueue("web.stock_push");
    let tokenB = "";
    onPost = async () => { tokenB = await steal(id); return { status: 503, retryAfter: "600" }; };

    const r = await tick(opts());
    assert.deepEqual({ sent: r.sent, lost: r.lost, failed: r.failed, dead: r.dead },
      { sent: 0, lost: 1, failed: 0, dead: 0 });
    const after = await row(id);
    assert.equal(after.status, "sending");
    assert.equal(after.claim_token, tokenB);
    assert.equal(after.last_error, null, "خطای A روی پیامِ B نمی‌نشیند");
    assert.ok(after.delay_s > 100 && after.delay_s <= 120, `اجارهٔ B دست نخورد (${after.delay_s}s)، نه Retry-After ششصدثانیه‌ای A`);
  });

  test("پیام دیگر دسته پیش از نوبتش به B رسید — تمدید رد می‌شود و فرستاده نمی‌شود", async () => {
    const ids = [await enqueue("web.stock_push"), await enqueue("web.price_push")];
    // ترتیب پردازش دسته تضمین‌شده نیست؛ «دیگری» یعنی پیامی که الان فرستاده نمی‌شود.
    const variation = new Map<string, string>();
    for (const id of ids) {
      const v = await sql<{ v: string }>`SELECT payload->>'variationId' AS v FROM platform.outbox_message WHERE id = ${id}::bigint`
        .execute(handle.db);
      variation.set(v.rows[0]!.v, id);
    }
    let first = "", other = "", tokenB = "";
    onPost = async (n, body) => {
      if (n === 1) {
        first = variation.get(body.variationId ?? "") ?? "";
        other = ids.find(id => id !== first) ?? "";
        tokenB = await steal(other);
      }
      return { status: 200 };
    };

    const r = await tick(opts());
    assert.ok(first !== "" && other !== "");
    assert.equal(posts, 1, "فقط پیامی که نوبتش بود به سایت رفت");
    assert.deepEqual({ claimed: r.claimed, sent: r.sent, lost: r.lost }, { claimed: 2, sent: 1, lost: 1 });
    assert.equal((await row(first)).status, "sent");
    const s = await row(other);
    assert.deepEqual({ status: s.status, by: s.claimed_by, token: s.claim_token }, { status: "sending", by: "B", token: tokenB });
  });

  test("۴۲۹ با Retry-After تلاش بعدی را همان‌قدر عقب می‌برد؛ بی هدر، Backoff عادی", async () => {
    const withHeader = await enqueue("web.stock_push");
    onPost = async () => ({ status: 429, retryAfter: "600" });
    let r = await tick(opts());
    assert.deepEqual({ failed: r.failed, lost: r.lost }, { failed: 1, lost: 0 });
    let w = await row(withHeader);
    assert.equal(w.status, "pending");
    assert.equal(w.claim_token, null, "شکست، توکن را پاک می‌کند");
    assert.ok(w.delay_s >= 595 && w.delay_s <= 600, `Retry-After ۶۰۰ (${w.delay_s}s)`);

    await sql`DELETE FROM platform.outbox_message`.execute(handle.db);
    const plain = await enqueue("web.stock_push");
    onPost = async () => ({ status: 429, retryAfter: "در یک ساعت" });
    r = await tick(opts());
    assert.equal(r.failed, 1);
    w = await row(plain);
    assert.ok(w.delay_s >= 55 && w.delay_s <= 60, `هدر نامعتبر نادیده، Backoff یک دقیقه (${w.delay_s}s)`);
  });

  test("خط web فقط پیام سایت را برمی‌دارد و خط notify هرگز", async () => {
    const web = await enqueue("web.stock_push");
    const other = await enqueue("موضوع.ناشناخته");

    const notify = await tick(opts("notify"));
    assert.equal(notify.claimed, 1);
    assert.equal(posts, 0, "notify به سایت چیزی نفرستاد");
    assert.equal((await row(other)).status, "dead", "موضوع بی‌Handler در notify نامهٔ مرده است، نه یتیم");
    assert.equal((await row(web)).status, "pending");

    const site = await tick(opts("web"));
    assert.equal(site.claimed, 1);
    assert.equal(posts, 1);
    assert.equal((await row(web)).status, "sent");
  });
});
