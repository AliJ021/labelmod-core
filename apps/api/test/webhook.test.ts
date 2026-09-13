/**
 * پل پیام‌رسان — و سه چیزی که بی‌صدا خراب می‌کنند.
 *
 * این ماژول لینک فاکتور را به یک Webhook می‌فرستد. لینک یک **توکن**
 * دارد، پس هر نشانی‌ای امن نیست؛ و هر شکستی هم دائمی نیست.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
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
          enabled: true, url: "https://x/y", token: undefined,
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
});
