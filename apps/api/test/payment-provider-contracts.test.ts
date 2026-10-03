import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderContractError, requireSupportedChannel, type ProviderRequest, type ProviderTransport } from "../src/payments/providers/contract.ts";
import { parseSnappayCallback, SnappayClient, type SnappayAttempt, type SnappayOrder } from "../src/payments/providers/snappay.ts";

const config = { baseUrl: "https://api.provider.test", channel: "online", paymentPageOrigins: ["https://pay.provider.test"], returnUrl: "https://merchant.test/payment/callback" };
const stored: SnappayAttempt = { transactionId: "12345", paymentToken: "synthetic.token==", amount: "900719925474099301", state: "pending" };
const order: SnappayOrder = {
  amount: "900719925474099301", discountAmount: "0", externalSourceAmount: "0", mobile: "09120000000",
  returnURL: "https://merchant.test/payment/callback", transactionId: "12345",
  cartList: [{ cartId: 1, cartItems: [{ id: 2, name: "کالای نمونه", category: "پوشاک", amount: "900719925474099301", count: 1, commissionType: 100 }],
    isShipmentIncluded: true, isTaxIncluded: true, shippingAmount: "0", taxAmount: "0", totalAmount: "900719925474099301" }],
};
function fixture(body: string, status = 200) {
  const calls: ProviderRequest[] = [];
  const transport: ProviderTransport = async request => { calls.push(request); return { status, body }; };
  return { calls, client: new SnappayClient(config, transport) };
}

test("درخواست توکن: مسیر مستند و عدد JSON ریالی بدون افت دقت", async () => {
  const { client, calls } = fixture('{"successful":true,"response":{"paymentToken":"synthetic.token==","paymentPageUrl":"https://pay.provider.test/start"}}');
  assert.deepEqual(await client.createToken("server-secret", order), {
    kind: "ok", value: { paymentToken: "synthetic.token==", paymentPageUrl: "https://pay.provider.test/start", state: "pending" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.provider.test/api/online/payment/v1/token");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.redirect, "error");
  assert.match(calls[0]?.body ?? "", /"amount":900719925474099301[,}]/);
  assert.doesNotMatch(calls[0]?.body ?? "", /900719925474099300/);
});

test("توکن خرید بدون تطبیق سبد، شناسه یا نشانی بازگشت ارسال نمی‌شود", async () => {
  const { client, calls } = fixture("{}");
  for (const modified of [
    { ...order, amount: "900719925474099300" },
    { ...order, transactionId: "12345678901" },
    { ...order, returnURL: "https://other.test/callback" },
    { ...order, amount: 1000 as unknown as string },
  ]) await assert.rejects(client.createToken("secret", modified), ProviderContractError);
  assert.equal(calls.length, 0);
});

test("احراز هویت فقط در انتقال سمت سرور و با فرم مستند است", async () => {
  const { client, calls } = fixture('{"access_token":"synthetic-access","token_type":"bearer","expires_in":3600}');
  assert.deepEqual(await client.authenticate({ clientId: "client", clientSecret: "secret", username: "merchant", password: "p&a" }),
    { kind: "ok", value: { accessToken: "synthetic-access", expiresIn: 3600 } });
  assert.equal(calls[0]?.url, "https://api.provider.test/api/online/v1/oauth/token");
  assert.equal(calls[0]?.headers.Authorization, "Basic Y2xpZW50OnNlY3JldA==");
  assert.equal(calls[0]?.body, "grant_type=password&scope=online-merchant&username=merchant&password=p%26a");
});

test("پیشنهاد اقساط از پاسخ درگاه می‌آید و مبلغ ریالی عیناً فرستاده می‌شود", async () => {
  const { client, calls } = fixture('{"successful":true,"response":{"eligible":true,"title_message":"عنوان نمونه","description":"شرح نمونه"}}');
  assert.deepEqual(await client.eligible("secret", "900719925474099301", ["INSTALLMENT", "FINANCING"]),
    { kind: "ok", value: { eligible: true, title_message: "عنوان نمونه", description: "شرح نمونه" } });
  assert.equal(calls[0]?.url, "https://api.provider.test/api/online/offer/v1/eligible?amount=900719925474099301&paymentMethodTypes=INSTALLMENT%2CFINANCING");
});

test("callback دست‌کاری‌شده حتی یک ریال یا شناسهٔ متفاوت را رد می‌کند", () => {
  for (const body of [
    { transactionId: "12345", amount: "900719925474099300", state: "OK" },
    { transactionId: "54321", amount: "900719925474099301", state: "OK" },
    { transactionId: "12345", amount: Number("900719925474099301"), state: "OK" },
    { transactionId: "12345", amount: "9.00719925474099301e17", state: "OK" },
  ]) assert.throws(() => parseSnappayCallback("POST", body, stored), ProviderContractError);
  assert.throws(() => parseSnappayCallback("GET", {}, stored), ProviderContractError);
});

test("callback تکراری همچنان نامطمئن است؛ شکست نیز revert خودکار نیست", () => {
  const body = { transactionId: "12345", amount: "900719925474099301", state: "OK" };
  for (let i = 0; i < 2; i++) assert.deepEqual(parseSnappayCallback("POST", body, stored),
    { kind: "untrusted_callback", transactionId: "12345", signal: "verify_candidate" });
  assert.deepEqual(parseSnappayCallback("POST", { ...body, state: "FAILED" }, stored),
    { kind: "untrusted_callback", transactionId: "12345", signal: "review_required" });
});

test("Verify پایان پرداخت نیست؛ Settle الزامی و Cancel فقط پس از آن است", async () => {
  const { client, calls } = fixture('{"successful":true,"response":{"transactionId":"12345"}}');
  assert.deepEqual(await client.verify("secret", stored), { kind: "ok", value: { state: "verified", requires: "settle" } });
  await assert.rejects(client.settle("secret", stored), ProviderContractError);
  await assert.rejects(client.cancel("secret", { ...stored, state: "verified" }), ProviderContractError);
  await assert.rejects(client.verify("secret", { ...stored, state: "verified" }), ProviderContractError);
  assert.deepEqual(await client.settle("secret", { ...stored, state: "verified" }), { kind: "ok", value: { state: "settled" } });
  assert.deepEqual(await client.cancel("secret", { ...stored, state: "settled" }), { kind: "ok", value: { state: "cancelled" } });
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ["/api/online/payment/v1/verify", "/api/online/payment/v1/settle", "/api/online/payment/v1/cancel"]);
  assert.equal(calls[0]?.body, '{"paymentToken":"synthetic.token=="}');
});

test("پاسخ Verify با شناسهٔ خرید دیگر معتبر نیست", async () => {
  const { client } = fixture('{"successful":true,"response":{"transactionId":"54321"}}');
  assert.deepEqual(await client.verify("secret", stored), { kind: "unknown", reason: "response" });
});

test("استعلام: مبلغ JSON بزرگ بدون گردشدن و حالت نهایی فقط از پاسخ معتبر", async () => {
  const { client, calls } = fixture('{"successful":true,"response":{"transactionId":"12345","status":"SETTLE","amount":900719925474099301}}');
  assert.deepEqual(await client.status("secret", { ...stored, state: "unknown" }), { kind: "ok", value: { state: "SETTLE" } });
  assert.equal(calls[0]?.url, "https://api.provider.test/api/online/payment/v1/status?paymentToken=synthetic.token%3D%3D");
  for (const body of [
    '{"successful":true,"response":{"transactionId":"12345","status":"SETTLE","amount":900719925474099300}}',
    '{"successful":true,"response":{"transactionId":"54321","status":"SETTLE","amount":900719925474099301}}',
    '{"successful":true,"response":{"transactionId":"12345","status":"NEW_STATE","amount":900719925474099301}}',
  ]) assert.deepEqual(await fixture(body).client.status("secret", stored), { kind: "unknown", reason: "response" });
});

test("timeout حتی برای انتقال‌دهندهٔ بی‌توجه به abort محدود است؛ retry خودکار ندارد", async () => {
  const calls: ProviderRequest[] = [];
  const client = new SnappayClient({ ...config, timeoutMs: 10 }, request => { calls.push(request); return new Promise(() => {}); });
  assert.deepEqual(await client.verify("secret", stored), { kind: "unknown", reason: "timeout" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signal.aborted, true);
});

test("خطا و پاسخ خام ممکن است راز داشته باشند؛ خروجی پاک و نامعلوم می‌ماند", async () => {
  const client = new SnappayClient(config, async () => { throw new Error("Authorization: Bearer secret-mobile-09120000000"); });
  assert.deepEqual(await client.verify("secret", stored), { kind: "unknown", reason: "transport" });
  assert.deepEqual(await fixture('{"successful":false,"errorData":{"message":"private-credential"}}').client.verify("secret", stored),
    { kind: "unknown", reason: "response" });
  assert.deepEqual(await fixture("sensitive diagnostic", 502).client.verify("secret", stored), { kind: "unknown", reason: "http" });
});

test("تغییر مسیر، کانال اثبات‌نشده و دیجی‌پی بی‌قرارداد بسته می‌مانند", async () => {
  for (const channel of ["in_store", "shareable_link", "settlement_statement"]) {
    assert.throws(() => new SnappayClient({ ...config, channel }, async () => { throw new Error("نباید اجرا شود"); }), ProviderContractError);
  }
  assert.throws(() => requireSupportedChannel("digipay", "online"), { code: "unsupported" });
  assert.throws(() => new SnappayClient({ ...config, baseUrl: "http://api.provider.test" }, async () => ({ status: 200, body: "{}" })), ProviderContractError);
  const { client } = fixture('{"successful":true,"response":{"paymentToken":"synthetic","paymentPageUrl":"https://attacker.test/"}}');
  assert.deepEqual(await client.createToken("secret", order), { kind: "unknown", reason: "response" });
  assert.throws(() => client.revert(), { code: "unsupported" });
  assert.throws(() => client.update(), { code: "unsupported" });
});
