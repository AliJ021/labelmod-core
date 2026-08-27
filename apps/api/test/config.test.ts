import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/lib/config.ts";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("پیکربندی", () => {
  test("بدون DATABASE_URL بالا نمی‌آید", () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });

  test("پیش‌فرض‌های امن", () => {
    const c = loadConfig(base);
    assert.equal(c.HOST, "127.0.0.1", "پیش‌فرض نباید روی همه رابط‌ها گوش بدهد");
    assert.equal(c.isProduction, false);
    assert.equal(c.COOKIE_NAME, "labelmod_session");
  });

  test("PORT نامعتبر بالا نمی‌آید", () => {
    assert.throws(() => loadConfig({ ...base, PORT: "70000" }));
    assert.throws(() => loadConfig({ ...base, PORT: "نه‌عدد" }));
  });

  test("تولید شناخته می‌شود", () => {
    assert.equal(loadConfig({ ...base, NODE_ENV: "production" }).isProduction, true);
  });
});
