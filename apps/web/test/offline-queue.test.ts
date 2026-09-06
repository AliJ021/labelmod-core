/**
 * صف امن هنگام اختلال — و چهار چیزی که بی‌صدا پول را دو برابر می‌کنند.
 *
 * این صف فقط به یک دلیل بی‌خطر است: هر درخواستِ صف‌شده
 * `Idempotency-Key` دارد و سرور با همان کلید Replay می‌دهد نه اثر
 * دوم. هر ادعای زیر یکی از راه‌هایی را می‌بندد که این تضمین بشکند.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  OfflineQueue,
  OfflineQueueError,
  isNetworkFailure,
  memoryStore,
  type QueuedRequest,
} from "../src/lib/offline-queue.ts";

function req(id: string, key = `k-${id}`): Omit<QueuedRequest, "queuedAt" | "attempts"> {
  return {
    id,
    method: "POST",
    path: "/invoices",
    body: {},
    idempotencyKey: key,
    label: `فروش ${id}`,
  };
}

describe("صف آفلاین", () => {
  test("درخواست بدون کلید Idempotency صف نمی‌شود", async () => {
    // ⚠️ مهم‌ترین ادعای این پرونده. بدون کلید، ارسال دوباره یعنی
    // فاکتور دوم یا پرداخت دوم — صف کردنش خطرناک‌تر از شکست‌دادنش است.
    const q = new OfflineQueue({ store: memoryStore(), send: async () => {} });
    await assert.rejects(
      () => q.enqueue({ ...req("a"), idempotencyKey: "" }),
      (e: unknown) =>
        e instanceof OfflineQueueError && e.code === "no_idempotency_key",
    );
    await assert.rejects(() => q.enqueue({ ...req("a"), idempotencyKey: "   " }));
    assert.equal((await q.pending()).length, 0);
  });

  test("خطای شبکه از خطای «رد شد» جدا است", () => {
    // همان تفکیک `SmsError.permanent` در Worker: شماره غلط با تلاش
    // صدم هم درست نمی‌شود، ولی قطعی لحظه‌ای نباید فروش را بکشد.
    assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
    assert.equal(isNetworkFailure({ name: "AbortError" }), true);
    assert.equal(isNetworkFailure({ status: 503 }), true);
    assert.equal(isNetworkFailure({ status: 504 }), true);

    // اینها را سرور **شنید** و رد کرد.
    assert.equal(isNetworkFailure({ status: 409 }), false);
    assert.equal(isNetworkFailure({ status: 422 }), false);
    assert.equal(isNetworkFailure({ status: 403 }), false);
    assert.equal(isNetworkFailure({ status: 500 }), false);
    assert.equal(isNetworkFailure(null), false);
    assert.equal(isNetworkFailure("خطا"), false);
  });

  test("همان کلید فرستاده می‌شود — نه کلید تازه", async () => {
    // اگر Retry کلید تازه بگیرد، سرور آن را یک عمل **جدید** می‌بیند و
    // فاکتور دوم می‌سازد. تمام ایمنی این صف روی همین یک بند است.
    const seen: string[] = [];
    const q = new OfflineQueue({
      store: memoryStore(),
      send: async (r) => {
        seen.push(r.idempotencyKey);
        if (seen.length === 1) throw new TypeError("network down");
      },
    });
    await q.enqueue(req("a", "کلید-ثابت"));

    await q.flush(); // شکست شبکه
    await q.flush(); // موفق

    assert.deepEqual(seen, ["کلید-ثابت", "کلید-ثابت"]);
    assert.equal((await q.pending()).length, 0, "پس از موفقیت باید از صف برود");
  });

  test("ترتیب حفظ می‌شود و اولین شکست شبکه بقیه را متوقف می‌کند", async () => {
    // اگر ادامه می‌داد، فروش دوم پیش از اول به سرور می‌رسید و
    // شماره‌گذاری سند بی‌ترتیب می‌شد.
    const seen: string[] = [];
    const q = new OfflineQueue({
      store: memoryStore(),
      send: async (r) => {
        seen.push(r.id);
        throw new TypeError("network down");
      },
    });
    await q.enqueue(req("a"));
    await q.enqueue(req("b"));
    await q.enqueue(req("c"));

    const out = await q.flush();
    assert.deepEqual(seen, ["a"], "فقط اولی تلاش شد");
    assert.equal(out.sent, 0);
    assert.equal(out.failed, 1);
    assert.equal((await q.pending()).length, 3, "هیچ‌کدام نباید حذف شوند");
  });

  test("رد صریح سرور صف را نمی‌بندد", async () => {
    // یک فاکتور ردشده نباید صف را برای همیشه ببندد — بقیه باید
    // بروند.
    const seen: string[] = [];
    const q = new OfflineQueue({
      store: memoryStore(),
      send: async (r) => {
        seen.push(r.id);
        if (r.id === "a") throw { status: 409, message: "دوره بسته است" };
      },
    });
    await q.enqueue(req("a"));
    await q.enqueue(req("b"));

    const out = await q.flush();
    assert.deepEqual(seen, ["a", "b"], "بعدی هم باید تلاش شود");
    assert.equal(out.sent, 1);
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0]!.id, "a");
    assert.equal((await q.pending()).length, 0, "هر دو باید از صف رفته باشند");
  });

  test("شکست بی‌پایان صف را برای همیشه نگه نمی‌دارد", async () => {
    // ده بار شکست شبکه‌ای پشت‌سرهم یعنی چیزی جز شبکه ایراد دارد.
    // نگه‌داشتنش تا ابد یعنی صف هرگز خالی نشود و کاربر هرگز نفهمد
    // فروشش ثبت نشده.
    const q = new OfflineQueue({
      store: memoryStore(),
      send: async () => {
        throw new TypeError("network down");
      },
      maxAttempts: 3,
    });
    await q.enqueue(req("a"));

    await q.flush();
    await q.flush();
    const last = await q.flush();

    assert.equal(last.rejected.length, 1, "پس از سقف تلاش باید بیرون برود");
    assert.equal((await q.pending()).length, 0);
  });

  test("صف خالی، تلاشی نمی‌کند", async () => {
    let calls = 0;
    const q = new OfflineQueue({
      store: memoryStore(),
      send: async () => {
        calls += 1;
      },
    });
    const out = await q.flush();
    assert.equal(calls, 0);
    assert.deepEqual(out, { sent: 0, failed: 0, rejected: [] });
  });
});
