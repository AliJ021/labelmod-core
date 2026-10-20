/**
 * Worker پس از مهاجرت ۱۰۰ — بخش‌های بی‌دیتابیس:
 *
 * ۱. **Retry-After سنجیده می‌شود، نه parse آزاد.** مقدار از سرور بیرونی است.
 * ۲. **خط‌های موضوع با هم کامل و بی‌همپوشانی‌اند**، روی خودِ `HANDLERS`.
 * ۳. **سرعت حلقه در هر سه حالت محدود است**: صف عقب، بی‌کاری، خطا.
 * ۴. **اجاره کمتر از بودجهٔ یک پیام رد می‌شود.**
 * ۵. **هر سه فرستنده Retry-After را به خطا می‌رسانند** و ۴۲۹ Webhook دیگر
 *    نامهٔ مرده نمی‌سازد.
 *
 * مالکیت اجاره (CAS) روی دیتابیس واقعی است: `db/test/outbox-lease.sql` و
 * `worker-lease.integration.test.ts`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter, retryAfterFor, RETRY_AFTER_MAX_SECONDS } from "../src/worker/retry-after.ts";
import {
  assertLease, MAX_BACKLOG_STREAK, MAX_ERROR_BACKOFF_MS, MESSAGE_BUDGET_SECONDS, nextPace,
  WEB_TOPICS, WORKER_LANES, type PaceState,
} from "../src/worker/loop.ts";
import { HANDLERS } from "../src/worker/handlers.ts";
import { makeSender, SmsError } from "../src/worker/sms.ts";
import { makeWebhookSender } from "../src/worker/webhook.ts";
import { makeWebPushSender } from "../src/worker/web-push.ts";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("Retry-After", () => {
  test("ثانیهٔ صحیح و تاریخ HTTP پذیرفته می‌شوند", () => {
    assert.equal(parseRetryAfter("120", NOW), 120);
    assert.equal(parseRetryAfter(" 0 ", NOW), 0);
    assert.equal(parseRetryAfter(String(RETRY_AFTER_MAX_SECONDS), NOW), RETRY_AFTER_MAX_SECONDS);
    assert.equal(parseRetryAfter("Tue, 20 Oct 2026 12:10:00 GMT", NOW), 600);
    // تاریخ گذشته یعنی «همین حالا»، نه خطا.
    assert.equal(parseRetryAfter("Tue, 20 Oct 2026 11:00:00 GMT", NOW), 0);
  });

  test("هر شکل دیگری null است — Backoff عادی، نه عددی که parseInt درآورد", () => {
    for (const raw of [
      null, undefined, "", "10abc", "1e3", "-5", "120.5", "+60", "0x10", "١٢٠",
      String(RETRY_AFTER_MAX_SECONDS + 1), "9999999",
      "2026-10-20T12:10:00Z", "Tuesday, 20-Oct-26 12:10:00 GMT", "Tue, 20 Oct 2026 12:10:00 +0000",
      "Tue, 99 Oct 2026 12:10:00 GMT", // شکل درست، تاریخ ناممکن
      "Thu, 22 Oct 2026 12:00:01 GMT", // بیش از یک روز
    ]) {
      assert.equal(parseRetryAfter(raw, NOW), null, `«${String(raw)}» باید رد شود`);
    }
  });

  test("فقط ۴۲۹ و ۵۰۳ «بعداً بیا» معنا می‌دهند", () => {
    assert.equal(retryAfterFor(429, "30", NOW), 30);
    assert.equal(retryAfterFor(503, "30", NOW), 30);
    for (const status of [200, 400, 401, 404, 500, 502]) {
      assert.equal(retryAfterFor(status, "30", NOW), null, `status ${status}`);
    }
  });
});

describe("خط‌های موضوع", () => {
  const claimedBy = (topic: string, lane: keyof typeof WORKER_LANES): boolean => {
    const l = WORKER_LANES[lane];
    if (l.topics !== null) return l.topics.includes(topic);
    if (l.exclude !== null) return !l.exclude.includes(topic);
    return true;
  };

  test("web و notify با هم هر موضوع را دقیقاً یک بار می‌پوشانند — از جمله موضوعِ بی‌Handler", () => {
    const topics = [...Object.keys(HANDLERS), "موضوع.ناشناخته", "web.آینده"];
    for (const topic of topics) {
      const owners = (["web", "notify"] as const).filter(l => claimedBy(topic, l));
      assert.equal(owners.length, 1, `${topic} → ${owners.join(",") || "هیچ‌کس"}`);
      assert.ok(claimedBy(topic, "all"), `${topic} در all`);
    }
  });

  test("خط web فقط موضوع‌های Push سایت است و هر سه Handler دارند", () => {
    assert.deepEqual(
      Object.keys(HANDLERS).filter(t => claimedBy(t, "web")).sort(),
      [...WEB_TOPICS].sort(),
    );
    for (const t of WEB_TOPICS) assert.ok(HANDLERS[t], t);
  });

  test("هشدار چک و سلامت فقط در خطی ساخته می‌شوند که مصرفشان می‌کند", () => {
    assert.equal(WORKER_LANES.web.producers, false);
    assert.equal(WORKER_LANES.notify.producers, true);
    assert.equal(WORKER_LANES.all.producers, true);
    for (const t of ["cheque.due", "health.alert"]) {
      assert.ok(claimedBy(t, "notify") && !claimedBy(t, "web"), t);
    }
  });
});

describe("سرعت حلقه — محدود در هر سه حالت", () => {
  const run = (outcomes: ({ ok: true; claimed: number } | { ok: false })[], intervalMs = 5_000, batch = 20) => {
    let state: PaceState = { backlog: 0, errors: 0 };
    return outcomes.map(o => {
      const next = nextPace(state, o, intervalMs, batch);
      state = next.state;
      return next.delayMs;
    });
  };

  test("دستهٔ پر بی‌درنگ، ولی حداکثر MAX_BACKLOG_STREAK بار پیاپی", () => {
    const delays = run(Array.from({ length: MAX_BACKLOG_STREAK + 2 }, () => ({ ok: true as const, claimed: 20 })));
    assert.deepEqual(delays.slice(0, MAX_BACKLOG_STREAK), Array(MAX_BACKLOG_STREAK).fill(0));
    assert.equal(delays[MAX_BACKLOG_STREAK], 5_000, "پس از سقف یک فاصلهٔ عادی");
    assert.equal(delays[MAX_BACKLOG_STREAK + 1], 0, "و بعد دوباره تخلیه");
  });

  test("دستهٔ ناقص یا خالی: همان فاصلهٔ پیکربندی", () => {
    assert.deepEqual(run([{ ok: true, claimed: 0 }, { ok: true, claimed: 19 }]), [5_000, 5_000]);
  });

  test("خطا: دوبرابرشونده با سقف، و اولین دور سالم صفرش می‌کند", () => {
    const delays = run([
      ...Array.from({ length: 8 }, () => ({ ok: false as const })),
      { ok: true, claimed: 0 }, { ok: false },
    ]);
    assert.deepEqual(delays, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 5_000, 10_000]);
    assert.ok(delays.every(d => d <= MAX_ERROR_BACKOFF_MS));
  });

  test("فاصلهٔ پیکربندی بلندتر از سقف خطا کوتاه نمی‌شود", () => {
    assert.deepEqual(run([{ ok: false }, { ok: false }], 120_000), [120_000, 120_000]);
  });
});

test("اجارهٔ کمتر از بودجهٔ یک پیام رد می‌شود", () => {
  assert.doesNotThrow(() => assertLease(MESSAGE_BUDGET_SECONDS));
  assert.doesNotThrow(() => assertLease(120));
  for (const bad of [0, 30, MESSAGE_BUDGET_SECONDS - 1, 3601, 90.5]) {
    assert.throws(() => assertLease(bad), /اجارهٔ Worker/, String(bad));
  }
});

describe("فرستنده‌ها Retry-After سنجیده را به خطا می‌رسانند", () => {
  const isTransient = (seconds: number | null) => (e: unknown) =>
    e instanceof SmsError && e.permanent === false && e.retryAfterSeconds === seconds;

  test("Push سایت: ۴۲۹ با هدر معتبر، و هدر نامعتبر نادیده", async () => {
    const make = (retryAfter: string | null) => makeWebPushSender(
      { enabled: true, baseUrl: "https://shop.example.com", secret: "s" },
      {
        resolveTarget: async raw => ({ url: new URL(raw), ip: "203.0.113.10", ips: ["203.0.113.10"] }),
        post: async () => ({ status: 429, retryAfter }),
      },
    );
    await assert.rejects(() => make("90").send({ topic: "web.stock_push", payload: {} }), isTransient(90));
    await assert.rejects(() => make("soon").send({ topic: "web.stock_push", payload: {} }), isTransient(null));
    await assert.rejects(() => make(null).send({ topic: "web.stock_push", payload: {} }), isTransient(null));
  });

  test("Webhook: ۴۲۹ و ۴۰۸ دیگر نامهٔ مرده نمی‌سازند؛ ۵۰۳ هدر را می‌برد؛ ۴۰۰ همچنان دائمی", async () => {
    const original = globalThis.fetch;
    const sender = makeWebhookSender({ enabled: true, url: "https://x/y", token: "synthetic-test-token" });
    const payload = { kind: "invoice" as const, invoiceNumber: "۱", customerName: null, mobile: "09120000000", amountRial: "1", link: "https://x/i/t" };
    try {
      for (const [status, header, expect] of [
        [429, "120", isTransient(120)],
        [408, null, isTransient(null)],
        [503, "Tue, 20 Oct 2099 12:10:00 GMT", isTransient(null)], // بیش از یک روز → نادیده
        [503, "45", isTransient(45)],
      ] as const) {
        globalThis.fetch = (async () => new Response(null, {
          status, headers: header === null ? {} : { "retry-after": header },
        })) as typeof fetch;
        await assert.rejects(() => sender.send(payload), expect, `status ${status}`);
      }
      globalThis.fetch = (async () => new Response(null, { status: 400, headers: { "retry-after": "5" } })) as typeof fetch;
      await assert.rejects(() => sender.send(payload),
        (e: unknown) => e instanceof SmsError && e.permanent && e.retryAfterSeconds === null);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("پیامک: ۴۲۹ هدر را می‌برد", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("busy", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch;
      const sms = makeSender({ provider: "kavenegar", sender: "1000", apiKey: "synthetic-test-key" });
      await assert.rejects(() => sms.send("09120000000", "x"), isTransient(30));
    } finally {
      globalThis.fetch = original;
    }
  });
});
