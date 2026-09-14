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
  backoffMs,
  isNetworkFailure,
  memoryStore,
  type QueuedRequest,
} from "../src/lib/offline-queue.ts";

/**
 * ساعت کنترل‌شده.
 *
 * ⚠️ بی این، هر ادعای Backoff یا `sleep` می‌خواست (ناپایدار — بند ۷۲
 *    الحاقیه) یا باید حذف می‌شد. ساعتِ تزریقی تنها راهی است که هم
 *    Backoff واقعی باشد و هم آزمون‌پذیر.
 */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

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
    const ck = clock();
    const q = new OfflineQueue({
      store: memoryStore(),
      now: ck.now,
      send: async (r) => {
        seen.push(r.idempotencyKey);
        if (seen.length === 1) throw new TypeError("network down");
      },
    });
    await q.enqueue(req("a", "کلید-ثابت"));

    await q.flush(); // شکست شبکه
    // ⚠️ تلاش بی‌فاصله دیگر انجام نمی‌شود (FND-003): Backoff باید بگذرد.
    //    همین یک خط، فرق «صفِ مؤدب» و «کوبیدن سرور» است.
    const early = await q.flush();
    assert.equal(early.deferred, 1, "هنوز در Backoff — نباید تلاش شود");
    assert.equal(seen.length, 1);

    ck.advance(backoffMs(1));
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
    const pending = await q.pending();
    assert.equal(pending.length, 1, "فقط درخواست تأییدشده از صف خارج می‌شود");
    assert.equal(pending[0]!.id, "a");
    assert.equal(pending[0]!.pausedReason, "response_error");
  });

  test("سقف تلاش ارسال خودکار را متوقف می‌کند و داده را نگه می‌دارد", async () => {
    const ck = clock();
    const q = new OfflineQueue({
      store: memoryStore(),
      now: ck.now,
      send: async () => {
        throw new TypeError("network down");
      },
      maxAttempts: 3,
    });
    await q.enqueue(req("a"));

    // هر دور یک Backoff دارد، پس میانشان زمان باید بگذرد — وگرنه دورهای
    // دوم و سوم اصلاً تلاش نمی‌کنند و سقف هرگز نمی‌رسد.
    await q.flush();
    ck.advance(backoffMs(1));
    await q.flush();
    ck.advance(backoffMs(2));
    const last = await q.flush();

    assert.equal(last.rejected.length, 1, "پس از سقف تلاش نیازمند رسیدگی است");
    assert.equal((await q.pending()).length, 1);
    assert.equal((await q.pending())[0]!.pausedReason, "retry_limit");
  });

  /**
   * FND-003 — سرور می‌گفت «چند لحظه بعد تلاش کنید» و کلاینت همان را
   * «نیازمند رسیدگی انسانی» علامت می‌زد.
   *
   * سناریوی واقعی‌اش: دو تب هم‌زمان Flush کنند. قفل `flush` فقط
   * درون‌نمونه‌ای است، پس تب دوم ۴۰۹ `idempotency_in_flight` می‌گیرد —
   * و فروشی که **واقعاً موفق شده** در صف پارک می‌شد و منتظر آدم می‌ماند.
   */
  test("«در حال پردازش» سرور قابل تلاش مجدد است، نه نیازمند رسیدگی", async () => {
    assert.equal(
      isNetworkFailure({ status: 409, code: "idempotency_in_flight" }),
      true,
    );
    // ⚠️ و بقیهٔ ۴۰۹ها **نه**: «موجودی کافی نیست» یک رد دائمی است و
    //    تلاش دوباره‌اش تا ابد ادامه پیدا می‌کرد.
    assert.equal(isNetworkFailure({ status: 409, code: "rule_violation" }), false);
    assert.equal(isNetworkFailure({ status: 409 }), false);

    // ۴۲۹ و ۴۰۸ ماهیتاً موقتی‌اند.
    assert.equal(isNetworkFailure({ status: 429 }), true);
    assert.equal(isNetworkFailure({ status: 408 }), true);
    // و این‌ها همچنان دائمی: خطای برنامه، نه خطای گذرا.
    assert.equal(isNetworkFailure({ status: 400 }), false);
    assert.equal(isNetworkFailure({ status: 403 }), false);
    assert.equal(isNetworkFailure({ status: 422 }), false);
    assert.equal(isNetworkFailure({ status: 500 }), false);
  });

  test("۴۰۹ «در حال پردازش» صف را نمی‌بندد و سطر را نگه می‌دارد", async () => {
    const ck = clock();
    let tries = 0;
    const q = new OfflineQueue({
      store: memoryStore(),
      now: ck.now,
      send: async () => {
        tries += 1;
        if (tries === 1) throw { status: 409, code: "idempotency_in_flight" };
      },
    });
    await q.enqueue(req("a"));

    const first = await q.flush();
    assert.equal(first.rejected.length, 0, "نباید نیازمند رسیدگی شود");
    assert.equal(first.failed, 1);
    const held = await q.pending();
    assert.equal(held.length, 1);
    assert.equal(held[0]!.pausedReason, undefined, "متوقف نشده — فقط عقب افتاده");

    ck.advance(backoffMs(1));
    const second = await q.flush();
    assert.equal(second.sent, 1);
    assert.equal((await q.pending()).length, 0);
  });

  test("Backoff نمایی است و سقف دارد", async () => {
    // ۴۲۹ با تلاش فوری بدتر می‌شود، پس فاصله باید واقعاً رشد کند.
    assert.equal(backoffMs(1), 2000);
    assert.equal(backoffMs(2), 4000);
    assert.equal(backoffMs(3), 8000);
    // و بی‌سقف نباشد، وگرنه صندوق‌دار ساعت‌ها منتظر می‌ماند.
    assert.equal(backoffMs(50), 30_000);
    assert.equal(backoffMs(0), 1000);
    // ورودی بی‌معنا نباید مقدار بی‌معنا بدهد.
    assert.equal(backoffMs(-5), 1000);
  });

  test("سطری که در Backoff است، ترتیب را نمی‌شکند", async () => {
    /*
     * ⚠️ اگر سطرِ عقب‌افتاده **رد** می‌شد و بعدی می‌رفت، فروش دوم پیش از
     *    اول به سرور می‌رسید — همان چیزی که شکست شبکه با `break` از آن
     *    پرهیز می‌کند. پس Backoff هم `break` است، نه `continue`.
     */
    const seen: string[] = [];
    const ck = clock();
    let first = true;
    const q = new OfflineQueue({
      store: memoryStore(),
      now: ck.now,
      send: async (r) => {
        seen.push(r.id);
        if (r.id === "a" && first) {
          first = false;
          throw { status: 429 };
        }
      },
    });
    await q.enqueue(req("a"));
    await q.enqueue(req("b"));

    await q.flush();
    assert.deepEqual(seen, ["a"], "فقط اولی تلاش شد");

    const deferred = await q.flush();
    assert.equal(deferred.deferred, 1);
    assert.deepEqual(seen, ["a"], "«b» نباید از «a» جلو بزند");

    ck.advance(backoffMs(1));
    await q.flush();
    assert.deepEqual(seen, ["a", "a", "b"], "پس از گذر Backoff، به ترتیب");
  });

  test("تلاش دستی Backoff را دور می‌زند", async () => {
    // آدمی که دکمه زده، منتظر ماشین نمی‌ماند.
    const ck = clock();
    let tries = 0;
    const q = new OfflineQueue({
      store: memoryStore(),
      now: ck.now,
      send: async () => {
        tries += 1;
        if (tries === 1) throw new TypeError("network down");
      },
    });
    await q.enqueue(req("a"));
    await q.flush();

    await q.retry("a");
    const out = await q.flush();
    assert.equal(out.sent, 1, "بی گذر زمان هم باید برود");
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
    assert.deepEqual(out, { sent: 0, failed: 0, deferred: 0, rejected: [] });
  });
});
