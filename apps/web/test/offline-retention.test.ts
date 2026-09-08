import { test } from "node:test";
import assert from "node:assert/strict";
import { OfflineQueue, memoryStore } from "../src/lib/offline-queue.ts";

const request = {
  id: "audit-sale", method: "POST", path: "/invoices",
  body: { synthetic: true }, idempotencyKey: "audit-sale-idempotency",
  label: "فروش مصنوعی",
};

test("سقف تلاش نباید درخواست بدون تأیید را از ذخیره حذف کند", async () => {
  const q = new OfflineQueue({
    store: memoryStore(), maxAttempts: 3,
    send: async () => { throw new TypeError("synthetic network failure"); },
  });
  await q.enqueue(request);
  await q.flush();
  await q.flush();
  await q.flush();
  const rows = await q.pending();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.body, request.body);
  assert.equal(rows[0]?.idempotencyKey, request.idempotencyKey);
});

test("نیاز به ورود دوباره نباید درخواست تأییدنشده را حذف کند", async () => {
  const q = new OfflineQueue({ store: memoryStore(), send: async () => { throw { status: 401 }; } });
  await q.enqueue(request);
  await q.flush();
  assert.equal((await q.pending()).length, 1);
});

test("شکست حذف محلی پس از ACK خطای ارسال نیست و باید آشکار بماند", async () => {
  const storageError = new Error("synthetic storage failure");
  const memory = memoryStore();
  let removals = 0;
  const store = { ...memory, remove: async (id: string) => {
    removals++;
    if (removals === 1) throw storageError;
    await memory.remove(id);
  } };
  const q = new OfflineQueue({ store, send: async () => {} });
  await q.enqueue(request);
  await assert.rejects(q.flush(), (error: unknown) => error === storageError);
  assert.equal(removals, 1);
  assert.equal((await q.pending()).length, 1);
});

test("دو flush هم‌زمان یک نمونه درخواست را دوباره ارسال نمی‌کنند", async () => {
  let sent = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const q = new OfflineQueue({ store: memoryStore(), send: async () => { sent++; await gate; } });
  await q.enqueue(request);
  const first = q.flush();
  const second = q.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(sent, 1);
  assert.equal((await q.pending()).length, 0);
});

test("توقف در ذخیره می‌ماند و تلاش صریح همان کلید و بدنه را می‌فرستد", async () => {
  const store = memoryStore();
  const first = new OfflineQueue({ store, maxAttempts: 1,
    send: async () => { throw new TypeError("synthetic network failure"); },
  });
  await first.enqueue(request);
  await first.flush();
  const seen: Array<{ key: string; body: unknown }> = [];
  const resumed = new OfflineQueue({ store, send: async (r) => {
    seen.push({ key: r.idempotencyKey, body: r.body });
  } });
  await resumed.flush();
  assert.equal(seen.length, 0, "ساخت نمونه تازه سقف تلاش را دور نمی‌زند");
  assert.equal((await resumed.pending()).length, 1);
  await resumed.retry(request.id);
  await resumed.flush();
  assert.deepEqual(seen, [{ key: request.idempotencyKey, body: request.body }]);
  assert.equal((await resumed.pending()).length, 0);
});
