import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSender, SmsError } from "../src/worker/sms.ts";

const config = { provider: "melipayamak", sender: "500000000000", apiKey: "test-key/not-real" };
const to = "09120000000";
const message = "آزمون قرارداد؛ هیچ پیامکی ارسال نمی‌شود";

test("ملی‌پیامک: قرارداد کلیددار و پذیرش شناسه مثبت", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://console.melipayamak.com/api/send/simple/test-key%2Fnot-real");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers && new Headers(init.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body as string), { from: config.sender, to, text: message });
    assert.ok(init.signal);
    return Response.json({ recId: "3741437414", status: "" });
  });
  await makeSender(config).send("+989120000000", message);
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const payload of [
  {}, null, { recId: 0 }, { recId: -1 }, { recId: "-1" }, { recId: "0" },
  { recId: "1e3" }, { recId: 1.5 }, { recId: 3741437414, status: "اعتبار کافی نیست" },
]) {
  test(`ملی‌پیامک: HTTP 200 با پاسخ ناموفق، موفق ثبت نمی‌شود (${JSON.stringify(payload)})`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    await assert.rejects(makeSender(config).send(to, message), SmsError);
  });
}

test("ملی‌پیامک: پاسخ خراب و متن خطا در گزارش نشت نمی‌کند", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("private-key private-mobile private-text"));
  await assert.rejects(makeSender(config).send(to, message), (e: unknown) => {
    assert.ok(e instanceof SmsError);
    assert.doesNotMatch(e.message, /private-/);
    return true;
  });
});

for (const [status, permanent] of [[401, true], [429, false], [503, false]] as const) {
  test(`ملی‌پیامک: طبقه‌بندی HTTP ${status} بدون انتشار بدنه`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("private-key", { status }));
    await assert.rejects(makeSender(config).send(to, message), (e: unknown) => {
      assert.ok(e instanceof SmsError);
      assert.equal(e.permanent, permanent);
      assert.doesNotMatch(e.message, /private-key/);
      return true;
    });
  });
}

test("ملی‌پیامک: خطای شبکه، کلید داخل URL را افشا نمی‌کند", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`failed ${config.apiKey}`); });
  await assert.rejects(makeSender(config).send(to, message), (e: unknown) => {
    assert.ok(e instanceof SmsError);
    assert.equal(e.permanent, false);
    assert.ok(!e.message.includes(config.apiKey));
    return true;
  });
});

test("ملی‌پیامک: کلید، فرستنده و گیرنده نامعتبر پیش از تماس رد می‌شوند", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ recId: 1 }));
  assert.throws(() => makeSender({ ...config, apiKey: "" }), SmsError);
  assert.throws(() => makeSender({ ...config, sender: "" }), SmsError);
  await assert.rejects(makeSender(config).send("invalid", message), SmsError);
  assert.equal(fetchMock.mock.callCount(), 0);
});
