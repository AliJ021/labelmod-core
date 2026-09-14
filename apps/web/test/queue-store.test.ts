/**
 * ذخیرهٔ پایدار صف — بندهایی که اگر نبودند، «صف پایدار» یک اسم بود.
 *
 * ⚠️ سه ادعای این پرونده عمداً ادعای **نبودِ** یک رفتار راحت‌اند: دادهٔ
 *    خراب پاک نمی‌شود، سهم پر بلعیده نمی‌شود، و نبودِ `localStorage`
 *    بی‌صدا به حافظه سقوط نمی‌کند. هر سه راه‌حل‌های «تا صفحه بالا بیاید»
 *    هستند و هر سه یک فروش را بی‌صدا می‌خورند.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OfflineQueue, type QueuedRequest } from "../src/lib/offline-queue.ts";
import {
  QueueStoreError,
  browserStorage,
  localQueueStore,
  type KeyValueStorage,
} from "../src/lib/queue-store.ts";

/** `localStorage` تقلبی — همان قرار، بدون مرورگر. */
function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & { raw: Map<string, string> } {
  const raw = new Map(Object.entries(seed));
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
    removeItem: (k) => void raw.delete(k),
  };
}

const row = (over: Partial<QueuedRequest> = {}): QueuedRequest => ({
  id: "finalize:inv-1", method: "POST", path: "/invoices/inv-1/finalize",
  body: {}, idempotencyKey: "key-1", label: "فروش ۱۲۰٬۰۰۰ تومان",
  queuedAt: 1_700_000_000_000, attempts: 0, ...over,
});

test("رفت‌وبرگشت پایدار و ترتیب بر اساس زمان صف", async () => {
  const storage = fakeStorage();
  const s = localQueueStore({ storage });
  await s.put(row({ id: "b", queuedAt: 2000 }));
  await s.put(row({ id: "a", queuedAt: 1000 }));
  assert.deepEqual((await s.all()).map((r) => r.id), ["a", "b"]);
  await s.remove("a");
  assert.deepEqual((await s.all()).map((r) => r.id), ["b"]);
});

test("همان شناسه جای خودش را می‌گیرد، ردیف دوم نمی‌سازد", async () => {
  const s = localQueueStore({ storage: fakeStorage() });
  await s.put(row({ attempts: 0 }));
  await s.put(row({ attempts: 3 }));
  const rows = await s.all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.attempts, 3);
});

test("صف با Reload از بین نمی‌رود — نمونهٔ تازه همان ردیف‌ها را می‌بیند", async () => {
  const storage = fakeStorage();
  const t0 = 1_700_000_000_000;
  const q1 = new OfflineQueue({
    store: localQueueStore({ storage }),
    send: async () => { throw new TypeError("شبکه قطع"); },
    now: () => t0,
  });
  await q1.enqueue({ id: "finalize:inv-9", method: "POST", path: "/invoices/inv-9/finalize",
                     body: {}, idempotencyKey: "k-9", label: "فروش" });
  await q1.flush();

  // «Reload»: نمونه و ذخیرهٔ تازه روی همان حافظهٔ مرورگر.
  /*
   * ⚠️ ساعت جلو برده می‌شود، وگرنه ردیف در Backoff همان تلاش ناموفق
   *    می‌ماند و `sent` صفر می‌شد — یعنی تست پایداری، در واقع Backoff را
   *    می‌سنجید. یک بار همین‌جا گرفته شد.
   */
  const q2 = new OfflineQueue({
    store: localQueueStore({ storage }), send: async () => {}, now: () => t0 + 60_000,
  });
  const before = await q2.pending();
  assert.equal(before.length, 1, "صف با نمونهٔ تازه خالی شد — یعنی پایدار نیست.");
  assert.equal(before[0]?.idempotencyKey, "k-9", "کلید Idempotency حفظ نشد — ارسال دوباره اثر دوم می‌ساخت.");
  const out = await q2.flush();
  assert.equal(out.sent, 1);
  assert.equal((await q2.pending()).length, 0);
});

test("JSON خراب خطا می‌دهد و صف را پاک نمی‌کند", async () => {
  const storage = fakeStorage({ labelmod_sale_queue_v1: "{نه JSON" });
  const s = localQueueStore({ storage });
  await assert.rejects(() => s.all(), (e: unknown) => {
    assert.ok(e instanceof QueueStoreError);
    assert.equal(e.code, "queue_unreadable");
    return true;
  });
  // مهم‌ترین ادعا: محتوا دست‌نخورده مانده.
  assert.equal(storage.raw.get("labelmod_sale_queue_v1"), "{نه JSON");
});

test("ردیف بدون کلید Idempotency خطا می‌دهد و صف دست‌نخورده می‌ماند", async () => {
  const bad = JSON.stringify([{ ...row(), idempotencyKey: "" }]);
  const storage = fakeStorage({ labelmod_sale_queue_v1: bad });
  const s = localQueueStore({ storage });
  await assert.rejects(() => s.all(), (e: unknown) => {
    assert.ok(e instanceof QueueStoreError);
    assert.equal(e.code, "queue_corrupt_row");
    return true;
  });
  assert.equal(storage.raw.get("labelmod_sale_queue_v1"), bad);
});

test("کنترل مثبت: ردیف سالم رد نمی‌شود", async () => {
  // بی این بند، یک اعتبارسنجیِ همیشه‌رد هم «پاس» می‌شد و صف را
  // برای همیشه غیرقابل خواندن می‌کرد.
  const good = JSON.stringify([row()]);
  const s = localQueueStore({ storage: fakeStorage({ labelmod_sale_queue_v1: good }) });
  assert.equal((await s.all()).length, 1);
});

test("پرشدن سهم ذخیره بلعیده نمی‌شود", async () => {
  const storage = fakeStorage();
  const full: KeyValueStorage = {
    ...storage,
    setItem: () => { throw new Error("QuotaExceededError"); },
  };
  const s = localQueueStore({ storage: full });
  // اگر می‌بلعیدیم، `enqueue` موفق می‌شد و فروش هیچ‌جا نمی‌نشست.
  await assert.rejects(() => s.put(row()));
});

test("نبودِ ذخیرهٔ پایدار خطای آشکار است، نه سقوط بی‌صدا به حافظه", () => {
  const had = "localStorage" in globalThis;
  assert.equal(had, false, "این محیط localStorage دارد — ادعا معنایش را از دست می‌دهد.");
  assert.throws(() => browserStorage(), (e: unknown) => {
    assert.ok(e instanceof QueueStoreError);
    assert.equal(e.code, "no_persistent_storage");
    return true;
  });
});
