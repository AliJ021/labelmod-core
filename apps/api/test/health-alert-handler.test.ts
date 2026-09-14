/**
 * Handler هشدار سلامت — و چهار حالتی که همه‌شان بی‌صدا خراب می‌کنند.
 *
 * این تست دیتابیس لازم ندارد: `handleHealthAlert` فقط تنظیمات و دو
 * فرستنده را می‌بیند. همین هم یک ادعاست — Handlerی که برای تصمیمش به
 * دیتابیس برگردد، یک مسیر خطای تازه دارد.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleHealthAlert } from "../src/worker/handlers.ts";
import { SmsError } from "../src/worker/sms.ts";
import type { NotifySettings } from "../src/worker/settings.ts";
import type { WebhookPayload } from "../src/worker/webhook.ts";
import type { Db } from "../src/db/client.ts";

const BASE: NotifySettings = {
  smsEnabled: true,
  provider: "log",
  sender: "",
  invoiceSms: false,
  invoiceSmsRequiresConsent: true,
  chequeDueSms: false,
  managerMobile: "",
  publicUrl: "https://shop.example",
  maxAttempts: 8,
  webhookEnabled: false,
  webhookUrl: "",
  healthAlerts: true,
  webPushEnabled: false,
  webSiteUrl: "",
};

const PAYLOAD = {
  code: "unposted_revenue",
  business_date: "2026-09-13",
  severity: "critical",
  title: "درآمد ثبت‌نشده در دفتر",
  count: 3,
  detail: "قدیمی‌ترین: 2026-09-11",
};

function ctx(over: Partial<NotifySettings>) {
  const sms: { to: string; text: string }[] = [];
  const hooks: WebhookPayload[] = [];
  return {
    sms,
    hooks,
    // `db` هرگز لمس نمی‌شود؛ Cast عمدی است تا همین را نشان دهد.
    value: {
      db: null as unknown as Db,
      settings: { ...BASE, ...over },
      sms: {
        send: async (to: string, text: string) => {
          sms.push({ to, text });
        },
      },
      webPush: { send: async () => {} },
      webhook: {
        send: async (p: WebhookPayload) => {
          hooks.push(p);
        },
      },
    },
  };
}

const msg = { id: "1", topic: "health.alert", payload: PAYLOAD, attempts: 1 };

describe("هشدار سلامت سیستم", () => {
  test("کلید خاموش: بسته می‌شود، نه ناموفق", async () => {
    /*
     * ⚠️ «خاموش‌بودن یک شکست نیست.» اگر این `fail` می‌شد،
     *    `platform.outbox_dead` پر می‌شد از هشدارهایی که قرار نبود
     *    بروند — و یک خطای واقعی همان‌جا گم می‌شد.
     */
    const c = ctx({ healthAlerts: false });
    const r = await handleHealthAlert(c.value, msg);
    assert.equal(r.done, true);
    assert.match(r.note, /خاموش/);
    assert.equal(c.sms.length, 0);
    assert.equal(c.hooks.length, 0);
  });

  test("هیچ مقصدی تنظیم نشده: بسته می‌شود، نه ناموفق", async () => {
    // موبایل مدیر خالی و Webhook خاموش. ناموفق‌کردنش هشدار را به نامهٔ
    // مرده می‌فرستاد و مالک دو مشکل داشت به‌جای یکی.
    const c = ctx({});
    const r = await handleHealthAlert(c.value, msg);
    assert.equal(r.done, true);
    assert.match(r.note, /مقصدی تنظیم نشده/);
    assert.equal(c.sms.length, 0);
  });

  test("پیامک به مدیر، با نشانهٔ شدت و شمار", async () => {
    const c = ctx({ managerMobile: "09121234567" });
    await handleHealthAlert(c.value, msg);

    assert.equal(c.sms.length, 1);
    const sent = c.sms[0];
    assert.ok(sent);
    assert.equal(sent.to, "09121234567");
    // ⛔ برای critical، نه ⚠️ — مالک باید در یک نگاه فرقشان را ببیند.
    assert.match(sent.text, /^⛔/);
    assert.match(sent.text, /درآمد ثبت‌نشده در دفتر/);
    // شمار با رقم فارسی، چون گیرنده‌اش آدم است نه ماشین.
    assert.match(sent.text, /۳/);
    assert.match(sent.text, /قدیمی‌ترین/);
  });

  test("شدت هشدار نشانهٔ دیگری دارد", async () => {
    const c = ctx({ managerMobile: "09121234567" });
    await handleHealthAlert(c.value, {
      ...msg,
      payload: { ...PAYLOAD, severity: "warn", title: "پیام‌های نرفته", detail: "—" },
    });
    const sent = c.sms[0];
    assert.ok(sent);
    assert.match(sent.text, /^⚠️/);
    // جزئیاتِ «—» یعنی جزئیاتی نیست؛ نباید در متن پیام بیاید.
    assert.doesNotMatch(sent.text, /—/);
  });

  test("Webhook هم می‌رود، و بدنه‌اش شکل health دارد", async () => {
    const c = ctx({ webhookEnabled: true, webhookUrl: "https://hook.example/x" });
    const r = await handleHealthAlert(c.value, msg);

    assert.equal(r.done, true);
    assert.equal(c.sms.length, 0, "موبایل مدیر خالی بود، پس پیامکی نباید برود");
    assert.equal(c.hooks.length, 1);
    const h = c.hooks[0];
    assert.ok(h && h.kind === "health");
    assert.equal(h.code, "unposted_revenue");
    assert.equal(h.count, 3);
    assert.equal(h.businessDate, "2026-09-13");
  });

  test("پیام بدون کد یک خطای دائمی است، نه یک حلقه", async () => {
    // تلاش دوباره کدِ نبوده را پیدا نمی‌کند. Backoff گرفتنش یعنی هشت
    // بار تلاش بی‌فایده و بعد نامهٔ مرده — با هفت تأخیر بی‌دلیل.
    const c = ctx({ managerMobile: "09121234567" });
    await assert.rejects(
      () => handleHealthAlert(c.value, { ...msg, payload: { ...PAYLOAD, code: "" } }),
      (e: unknown) => e instanceof SmsError && e.permanent,
    );
  });
});
