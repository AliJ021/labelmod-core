/**
 * فرستندهٔ Push سایت — ADR-007 بندهای ۵ و ۶.
 *
 * ── چرا این پرونده وجود دارد ────────────────────────────────────────
 *
 * دو تا از قیدهای این طراحی **امنیتی**اند و هر دو بی‌صدا می‌شکنند:
 *
 *   SSRF   مقصدی که به شبکهٔ داخلی برسد — یا Redirectی که به آن ببرد
 *   امضا   بدنه‌ای که دست‌کاری شود و همچنان پذیرفته شود
 *
 * هیچ‌کدام در عمل خطا نمی‌دهند؛ فقط کار می‌کنند و نباید بکنند.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  isPrivateAddress,
  makeWebPushSender,
  resolveSafeTarget,
  signBody,
  signatureMatches,
} from "../src/worker/web-push.ts";
import { SmsError } from "../src/worker/sms.ts";

const SECRET = "s3cr3t-برای-تست";

const base = {
  enabled: true,
  baseUrl: "https://shop.example.com",
  secret: SECRET,
};

/** هدف امن ساختگی — تست به DNS واقعی وابسته نمی‌شود. */
const safeTarget = async (raw: string) => ({ url: new URL(raw), ip: "203.0.113.10" });

test("محدودهٔ داخلی رد می‌شود — و محدودهٔ عمومی رد نمی‌شود", () => {
  for (const ip of [
    "127.0.0.1", "127.9.9.9", "0.0.0.0", "10.1.2.3", "172.16.0.1",
    "172.31.255.254", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "224.0.0.1", "::1", "::", "fd00::1", "fc00::1", "fe80::1",
    // ⚠️ IPv4 در پوشش IPv6 — بی این حالت، یک حلقهٔ کامل باز بود.
    "::ffff:127.0.0.1", "::ffff:169.254.169.254",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} باید داخلی شمرده شود`);
  }
  // کنترل مثبت: اگر همه‌چیز «داخلی» شمرده شود، این تابع هیچ‌چیز را
  // نمی‌سنجد و هر Push هم شکست می‌خورد.
  for (const ip of ["8.8.8.8", "203.0.113.10", "172.32.0.1", "192.169.0.1", "2001:db8::1"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} باید عمومی شمرده شود`);
  }
  // چیزی که IP نیست، IP امن هم نیست.
  assert.equal(isPrivateAddress("not-an-ip"), true);
});

test("نشانی غیر https رد می‌شود، و خطایش **دائمی** است", async () => {
  await assert.rejects(
    () => resolveSafeTarget("http://shop.example.com/x"),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      // Backoff برای نشانی‌ای که هرگز https نمی‌شود، فقط صف را شلوغ می‌کند.
      assert.equal(e.permanent, true);
      return true;
    },
  );
});

test("نام میزبانی که به IP داخلی برسد رد می‌شود", async () => {
  // ⚠️ سنجش روی **IP نهایی** است نه روی رشته: `localtest.me` یک نام
  //    عمومی است که به 127.0.0.1 می‌رسد — دقیقاً کاری که SSRF می‌کند.
  //    اینجا با یک هدف ساختگی همان مسیر رانده می‌شود، بی وابستگی به DNS.
  const send = makeWebPushSender(base, {
    resolveTarget: async (raw) => {
      const url = new URL(raw);
      const ip = "127.0.0.1";
      if (isPrivateAddress(ip)) {
        throw new SmsError(`مقصد «${url.hostname}» داخلی است`, true);
      }
      return { url, ip };
    },
    fetch: (async () => {
      throw new Error("نباید به fetch برسد");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => send.send({ topic: "web.stock_push", payload: { variationId: "v" } }));
});

test("Redirect دنبال نمی‌شود — و پاسخ ۳xx یک شکست دائمی است", async () => {
  let usedRedirect: string | undefined;
  const send = makeWebPushSender(base, {
    resolveTarget: safeTarget,
    fetch: (async (_u: string, init: RequestInit) => {
      usedRedirect = init.redirect as string | undefined;
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => send.send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      assert.equal(e.permanent, true);
      return true;
    },
  );
  // ⚠️ ادعای اصلی: خودِ درخواست با `manual` رفته. بی آن، fetch خودش
  //    Redirect را دنبال می‌کرد و ۳xx هرگز دیده نمی‌شد — یعنی این تست
  //    سبز می‌ماند و SSRF باز بود.
  assert.equal(usedRedirect, "manual");
});

test("امضا روی بدنهٔ خام است و هدرها کامل می‌روند", async () => {
  const seen: { headers?: Record<string, string>; body?: string } = {};
  const send = makeWebPushSender(base, {
    resolveTarget: safeTarget,
    now: () => 1_789_311_045_000,
    nonce: () => "abcdef0123456789",
    fetch: (async (_u: string, init: RequestInit) => {
      seen.headers = init.headers as Record<string, string>;
      seen.body = init.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });

  await send.send({
    topic: "web.stock_push",
    payload: { variationId: "01a0", sku: "S-1", onHand: 7, version: 42 },
  });

  assert.equal(seen.headers?.["x-lmc-timestamp"], "1789311045");
  assert.equal(seen.headers?.["x-lmc-nonce"], "abcdef0123456789");

  // امضا **مستقل** بازمحاسبه می‌شود، نه با همان تابعی که تولیدش کرده —
  // وگرنه فقط سازگاری تابع با خودش ثابت می‌شد.
  const expected = createHmac("sha256", SECRET)
    .update(`1789311045.abcdef0123456789.${seen.body}`, "utf8")
    .digest("hex");
  assert.equal(seen.headers?.["x-lmc-signature"], `sha256=${expected}`);
});

test("یک بایت تغییر در بدنه، امضا را عوض می‌کند", () => {
  const a = signBody(SECRET, "1", "n", '{"onHand":7}');
  const b = signBody(SECRET, "1", "n", '{"onHand":8}');
  assert.notEqual(a, b);
  // و جداکننده واقعاً جدا می‌کند: بی نقطه، این دو یکی می‌شدند.
  assert.notEqual(signBody(SECRET, "1", "23", "x"), signBody(SECRET, "12", "3", "x"));
});

test("مقایسهٔ امضا با طول متفاوت نمی‌شکند", () => {
  assert.equal(signatureMatches("abc", "abc"), true);
  assert.equal(signatureMatches("abc", "abcd"), false);
  assert.equal(signatureMatches("abc", "abd"), false);
});

test("مسیر مقصد از روی موضوع انتخاب می‌شود", async () => {
  const urls: string[] = [];
  const send = makeWebPushSender(base, {
    resolveTarget: async (raw) => { urls.push(raw); return { url: new URL(raw), ip: "203.0.113.10" }; },
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  await send.send({ topic: "web.price_push", payload: { variationId: "v" } });
  assert.deepEqual(urls, [
    "https://shop.example.com/wp-json/lmc/v1/stock",
    "https://shop.example.com/wp-json/lmc/v1/price",
  ]);
});

test("خاموش‌بودن یک شکست نیست", async () => {
  let called = false;
  const send = makeWebPushSender(
    { ...base, enabled: false },
    { resolveTarget: safeTarget,
      fetch: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch },
  );
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  assert.equal(called, false, "با خاموش‌بودن نباید درخواستی برود");
});

test("کلید نبود → خطا، و **دائمی نیست**", async () => {
  const send = makeWebPushSender({ ...base, secret: undefined }, { resolveTarget: safeTarget });
  await assert.rejects(
    () => send.send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      // مالک می‌تواند کلید را بگذارد و پیام‌های در صف بعداً بروند.
      // دائمی‌کردنش یعنی موجودی امروز برای همیشه نرود.
      assert.equal(e.permanent, false);
      return true;
    },
  );
});

test("«رد شد» از «نرسید» جدا است", async () => {
  const make = (status: number) =>
    makeWebPushSender(base, {
      resolveTarget: safeTarget,
      fetch: (async () => new Response("", { status })) as unknown as typeof fetch,
    });

  // ۴۰۱ یعنی امضا غلط است؛ تلاش صدم هم درستش نمی‌کند.
  await assert.rejects(
    () => make(401).send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => { assert.ok(e instanceof SmsError); assert.equal(e.permanent, true); return true; },
  );
  // ۵۰۳ یعنی سایت الان بالا نیست؛ Backoff بگیرد و دوباره برود.
  await assert.rejects(
    () => make(503).send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => { assert.ok(e instanceof SmsError); assert.equal(e.permanent, false); return true; },
  );
});
