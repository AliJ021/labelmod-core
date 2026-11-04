/**
 * راه‌اندازی هفت‌مرحله‌ای ووکامرس (طرح ۱۰، R05). ادعای اصلی: آنچه فقط افزونه
 * می‌داند پیش از تست «نامعلوم» است، و «نامعلوم» هرگز «انجام‌شده» شمرده نمی‌شود.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupSteps, type WooConfig, type WooResult } from "../src/lib/woocommerce.ts";

const config: WooConfig = { siteUrl: "https://shop.example.test", warehouseId: "w1", pushEnabled: true, signingConfigured: true, priceList: "default" };
// بی pushConfigured: نسخه‌های قدیمی افزونه آن را گزارش نمی‌کنند؛ هر آزمون صریح می‌دهدش.
const remote = (over: Partial<NonNullable<WooResult["remote"]>> = { pushConfigured: true }): NonNullable<WooResult["remote"]> => ({
  pluginVersion: "1.3.5", wooVersion: "10.0.0", siteUrl: config.siteUrl, apiKeyConfigured: true,
  stockPolling: true, pricePolling: false, cronDisabled: false, stockScheduled: true, mapping: { linkedProducts: 3 }, order: null, ...over,
});
const state = (steps: ReturnType<typeof setupSteps>) => Object.fromEntries(steps.map(s => [s.key, s.state]));

describe("راه‌اندازی ووکامرس", () => {
  test("هفت مرحله، به همان ترتیب طرح", () => {
    assert.deepEqual(setupSteps(config, null).map(s => s.key), ["site", "plugin", "api-key", "push", "warehouse", "mapping", "test"]);
  });

  test("پیش از تست، وضعیت افزونه نامعلوم است نه سالم", () => {
    assert.deepEqual(state(setupSteps(config, null)), {
      site: "done", plugin: "unknown", "api-key": "unknown", push: "unknown", warehouse: "done", mapping: "unknown", test: "todo",
    });
  });

  test("تست موفق با همه‌چیز آماده هر هفت را انجام‌شده می‌کند", () => {
    const steps = setupSteps(config, { ok: true, message: "", remote: remote() });
    assert.ok(steps.every(s => s.state === "done"), JSON.stringify(state(steps)));
  });

  test("کلید Push: بله، خیر، و گزارش‌نشده سه حالت جدا هستند", () => {
    const push = (pushConfigured: boolean | undefined) =>
      setupSteps(config, { ok: true, message: "", remote: remote(pushConfigured === undefined ? {} : { pushConfigured }) }).find(s => s.key === "push")!.state;
    assert.equal(push(true), "done");
    assert.equal(push(false), "todo");
    assert.equal(push(undefined), "unknown");
  });

  test("ارسال خاموش یا کلید سرورِ نبوده، مرحلهٔ Push را مانده می‌کند حتی اگر افزونه کلید داشته باشد", () => {
    const r = { ok: true, message: "", remote: remote() };
    assert.equal(setupSteps({ ...config, pushEnabled: false }, r).find(s => s.key === "push")!.state, "todo");
    assert.equal(setupSteps({ ...config, signingConfigured: false }, r).find(s => s.key === "push")!.state, "todo");
  });

  test("نگاشت: شمارش نخوانده نامعلوم است، صفر مانده است", () => {
    const mapping = (linkedProducts: number | null) =>
      setupSteps(config, { ok: true, message: "", remote: remote({ pushConfigured: true, mapping: { linkedProducts } }) }).find(s => s.key === "mapping")!.state;
    assert.equal(mapping(null), "unknown");
    assert.equal(mapping(0), "todo");
    assert.equal(mapping(1), "done");
  });

  test("تست ناموفق بی پاسخ افزونه، هیچ مرحلهٔ افزونه‌ای را انجام‌شده نمی‌کند", () => {
    const steps = state(setupSteps({ ...config, siteUrl: "", warehouseId: "" }, { ok: false, message: "x", remote: null }));
    assert.deepEqual(steps, { site: "todo", plugin: "unknown", "api-key": "unknown", push: "unknown", warehouse: "todo", mapping: "unknown", test: "todo" });
  });
});
