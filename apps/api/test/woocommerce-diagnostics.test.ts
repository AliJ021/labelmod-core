import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readPinnedJson, testWooConnection } from "../src/platform/woocommerce-diagnostics.ts";
import { resolveSafeTarget, type HttpRequestFn } from "../src/worker/web-push.ts";

const config = { siteUrl: "https://shop.example.test/store", secret: randomBytes(32).toString("hex") };
const resolve = async (url: string) => resolveSafeTarget(url, async () => ["203.0.113.4"]);
const report = {
  protocol: 1, pluginVersion: "1.2.0", wooVersion: "10.0.0", siteUrl: config.siteUrl,
  branchId: "", warehouseId: "", apiKeyConfigured: true, stockPolling: true, pricePolling: false,
  cronDisabled: false, stockScheduled: true,
  mapping: { linkedProducts: 3, orderIdentity: "sku", stockIdentity: "variationId" }, order: null,
};

test("تست امضاشده فقط مسیر تشخیص را می‌زند؛ تکرار nonce تازه دارد و هیچ سفارش نمی‌فرستد", async () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const result = await testWooConnection(config, 42, { resolve, read: async (target, body, headers) => {
      assert.equal(target.url.pathname, "/store/wp-json/lmc/v1/diagnostics");
      assert.deepEqual(target.ips, ["203.0.113.4"]);
      assert.deepEqual(JSON.parse(body), { orderId: 42 });
      const expected = createHmac("sha256", config.secret).update(`${headers["x-lmc-timestamp"]}.${headers["x-lmc-nonce"]}.${body}`).digest("hex");
      assert.equal(headers["x-lmc-signature"], "sha256=" + expected);
      assert.ok(!nonces.has(headers["x-lmc-nonce"]!)); nonces.add(headers["x-lmc-nonce"]!);
      return { status: 200, body: { ...report, ignoredSecret: "do-not-return" } };
    } });
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes("do-not-return"));
  }
});

test("مقصد داخلی، mixed DNS، HTTP و نشانی دارای راز پیش از ارسال رد می‌شوند", async () => {
  for (const siteUrl of ["http://shop.example.test", "https://127.0.0.1", "https://user:secret@shop.example.test", "https://shop.example.test/?secret=abc", "https://shop.example.test/#secret"]) {
    const r = await testWooConnection({ ...config, siteUrl }, undefined, { resolve, read: async () => { assert.fail("نباید متصل شود"); } });
    assert.equal(r.code, "unsafe_target");
    assert.ok(!JSON.stringify(r).includes("abc"));
  }
  const r = await testWooConnection(config, undefined, { resolve: url => resolveSafeTarget(url, async () => ["203.0.113.4", "10.0.0.1"]) });
  assert.equal(r.code, "unsafe_target");
});

test("خطاها و پاسخ نامعتبر/سایت دیگر موفقیت نمی‌شوند و متن خام را افشا نمی‌کنند", async () => {
  for (const [status, code] of [[302, "redirect"], [401, "authentication"], [403, "authentication"], [404, "plugin_route"], [503, "remote_unavailable"], [200, "invalid_response"]] as const) {
    let calls = 0;
    const r = await testWooConnection(config, undefined, { resolve, read: async () => { calls++; return { status, body: { message: config.secret } }; } });
    assert.equal(r.code, code); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(r).includes(config.secret));
  }
  const mismatch = await testWooConnection(config, undefined, { resolve, read: async () => ({ status: 200, body: { ...report, siteUrl: "https://other.test" } }) });
  assert.equal(mismatch.code, "site_mismatch");
  const network = await testWooConnection(config, undefined, { resolve, read: async () => { throw new Error(config.secret); } });
  assert.equal(network.code, "network"); assert.ok(!JSON.stringify(network).includes(config.secret));
  assert.equal((await testWooConnection({ ...config, secret: undefined })).code, "missing_secret");
});

test("حمل‌ونقل IP بررسی‌شده را نگه می‌دارد و بدنهٔ بزرگ را قطع می‌کند", async () => {
  const target = await resolve(config.siteUrl);
  for (const oversized of [false, true]) {
    let destroyed = false;
    const send: HttpRequestFn = (options, callback) => {
      assert.equal(options.hostname, "shop.example.test");
      assert.equal(options.method, "POST");
      assert.ok(options.lookup);
      options.lookup!("shop.example.test", { all: true }, (error, addresses) => {
        assert.equal(error, null); assert.deepEqual(addresses, [{ address: "203.0.113.4", family: 4 }]);
      });
      const req = new EventEmitter() as ReturnType<HttpRequestFn>;
      req.destroy = ((error: Error) => { destroyed = true; queueMicrotask(() => req.emit("error", error)); return req; }) as typeof req.destroy;
      req.end = (() => {
        queueMicrotask(() => {
          const res = Readable.from([Buffer.from(oversized ? "x".repeat(32769) : '{"ok":true}')]) as Parameters<Parameters<HttpRequestFn>[1]>[0];
          res.statusCode = 200; callback(res);
        }); return req;
      }) as typeof req.end;
      return req;
    };
    if (oversized) { await assert.rejects(readPinnedJson(target, "{}", {}, send)); assert.equal(destroyed, true); }
    else assert.deepEqual(await readPinnedJson(target, "{}", {}, send), { status: 200, body: { ok: true } });
  }
});
