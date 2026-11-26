import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSender, meliCredit, SmsError } from "../src/worker/sms.ts";

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
    assert.equal(e.uncertain, true);
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

test("approved OTP uses a shared line and preserves positional arguments", async t => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /send\/shared\//);
    assert.deepEqual(JSON.parse(String(init.body)), { bodyId: 524, to, args: ["003129"] });
    return Response.json({ recId: "12345678" });
  });
  const sender = makeSender({ ...config, sender: "", otpPattern: 524 });
  assert.equal(await sender.send(to, "unused", { purpose: "otp", args: ["003129"] }), "12345678");
  await assert.rejects(sender.send(to, "free text"), /فرستنده/);
});

test("panel uses account credentials and the receipt pattern; credit probe never sends SMS", async t => {
  const connection = { ...config, accountName:"shop", transport:"panel" as const, sender:"", invoicePattern:12 };
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    const params = init.body as URLSearchParams;
    assert.equal(params.get("username"), "shop");
    assert.equal(params.get("password"), config.apiKey);
    if (url.endsWith("GetCredit")) return Response.json({ RetStatus: 1, Value: "0" });
    assert.equal(params.get("text"), "23;12500");
    assert.equal(params.get("bodyId"), "12");
    return Response.json({ RetStatus: 1, Value: "987654321" });
  });
  assert.equal(await meliCredit(connection), 0);
  await makeSender(connection).send(to, "unused", { purpose: "invoice", args:["23","12500"] });
  assert.deepEqual(calls.map(url=>url.split("/").at(-1)), ["GetCredit","BaseServiceNumber"]);
});

test("manager alerts use the selected shared patterns without a sender line", async t=>{
  const calls: Array<{bodyId:number;args:string[]}>=[];
  t.mock.method(globalThis,"fetch",async(url:string,init:RequestInit)=>{
    assert.ok(url.includes("/send/shared/"));
    calls.push(JSON.parse(String(init.body)));
    return Response.json({recId:"3741437414",status:""});
  });
  const sender=makeSender({...config,sender:"",chequePattern:31,healthPattern:32});
  await sender.send(to,"آزمون",{purpose:"cheque",args:["دریافتی","500,000","امروز سررسید است"]});
  await sender.send(to,"آزمون",{purpose:"health",args:["بکاپ دیر شده","1"]});
  assert.deepEqual(calls.map(({bodyId,args})=>[bodyId,args]),[
    [31,["دریافتی","500,000","امروز سررسید است"]],[32,["بکاپ دیر شده","1"]]
  ]);
});
