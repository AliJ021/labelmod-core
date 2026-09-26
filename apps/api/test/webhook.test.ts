/**
 * پل پیام‌رسان — و سه چیزی که بی‌صدا خراب می‌کنند.
 *
 * این ماژول لینک فاکتور را به یک Webhook می‌فرستد. لینک یک **توکن**
 * دارد، پس هر نشانی‌ای امن نیست؛ و هر شکستی هم دائمی نیست.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SmsError } from "../src/worker/sms.ts";
import { assertHttps, makeWebhookSender } from "../src/worker/webhook.ts";

// `as const` لازم است: `WebhookPayload` یک Union است و `string` خام با
// شاخهٔ `"invoice"` نمی‌خواند.
const payload = {
  kind: "invoice" as const,
  invoiceNumber: "۱۴۰۵-۰۰۱",
  customerName: null,
  mobile: "09120000000",
  amountRial: "1000000",
  link: "https://shop.example/i/tok",
};

describe("Webhook پیام‌رسان", () => {
  test("نشانی http لخت رد می‌شود", () => {
    // لینک فاکتور یک توکن دارد؛ فرستادنش روی HTTP یعنی همان توکن
    // روی شبکه رمزنشده — همان دلیلی که کوکی نشست Secure است.
    assert.throws(() => assertHttps("http://example.com/hook"), SmsError);
    assert.throws(() => assertHttps("نشانی نامعتبر"), SmsError);
    assert.doesNotThrow(() => assertHttps("https://example.com/hook"));
  });

  test("خاموش بودن یک شکست نیست", async () => {
    // اگر خاموشی شکست می‌شد، `platform.outbox_dead` پر می‌شد از
    // چیزهایی که قرار نبود بروند و خطای واقعی همان‌جا گم می‌شد.
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await makeWebhookSender({ enabled: false, url: "https://x/y", token: undefined })
        .send(payload);
      await makeWebhookSender({ enabled: true, url: "  ", token: undefined })
        .send(payload);
      assert.equal(called, false, "وقتی خاموش است نباید درخواستی برود");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("۴xx دائمی است و ۵xx نه", async () => {
    // ⚠️ همان تفکیک پیامک: نشانی غلط با تلاش صدم هم درست نمی‌شود،
    // ولی قطعی لحظه‌ای سرویس نباید یک اطلاع‌رسانی را برای همیشه بکشد.
    const original = globalThis.fetch;
    try {
      for (const [status, permanent] of [
        [400, true], [401, true], [404, true],
        [500, false], [502, false], [503, false],
      ] as const) {
        globalThis.fetch = (async () =>
          new Response(null, { status })) as typeof fetch;
        const sender = makeWebhookSender({
          enabled: true, url: "https://x/y", token: "synthetic-test-token",
        });
        await assert.rejects(
          () => sender.send(payload),
          (e: unknown) =>
            e instanceof SmsError && e.permanent === permanent,
          `status ${status} باید permanent=${permanent} بدهد`,
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("توکن از هدر می‌رود، نه از نشانی", async () => {
    // در نشانی، توکن در لاگ سرور مقصد و در سابقه تنظیمات می‌نشیند.
    let seen: Record<string, string> = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await makeWebhookSender({
        enabled: true, url: "https://x/y", token: "راز",
      }).send(payload);
      assert.equal(seen["authorization"], "Bearer راز");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("اتصال روشن بدون توکن هیچ پیام حساسی ارسال نمی‌کند و قابل تلاش مجدد می‌ماند", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 200 }); };
    try {
      for (const token of [undefined, "", "   ", "\t\n"]) {
        await assert.rejects(() => makeWebhookSender({ enabled: true, url: "https://x/y", token }).send(payload),
          (e: unknown) => e instanceof SmsError && !e.permanent);
      }
      assert.equal(calls, 0);
    } finally { globalThis.fetch = original; }
  });
});

test("Redirect میان دو مبدأ، بدنهٔ حامل لینک را به مقصد دوم نمی‌فرستد", async () => {
  let leaked = 0;
  const target = createServer((req, res) => { leaked++; req.resume(); res.end("ok"); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as AddressInfo).port;
  const origin = createServer((req, res) => {
    req.resume();
    res.writeHead(Number(req.url?.slice(1)), { location: `http://127.0.0.1:${targetPort}/collect` });
    res.end();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as AddressInfo).port;
  const original = globalThis.fetch;
  // فقط انتقال نخست محلی است؛ منطق Redirect همان fetch واقعی Node است.
  globalThis.fetch = (input, init) => original(String(input).replace("https://fixture.invalid", `http://127.0.0.1:${originPort}`), init);
  try {
    for (const status of [307, 308]) {
      await assert.rejects(() => makeWebhookSender({ enabled: true,
        url: `https://fixture.invalid/${status}`, token: "synthetic-token" }).send(payload));
    }
    assert.equal(leaked, 0);
  } finally {
    globalThis.fetch = original;
    origin.closeAllConnections(); target.closeAllConnections();
    await Promise.all([origin, target].map((server) => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))));
  }
});
