/**
 * بازبینی دستهٔ ۱، یافتهٔ B1-02 — خواندن و نوشتن اسنپ‌پی دو مجوز جدا دارند.
 *
 * `GET /snappay/config` مجوز `settings.view` می‌خواهد و `PUT` همان مسیر
 * `settings.security`. فرم تغییر فقط با allow صریحِ مجوز نوشتن ساخته می‌شود؛
 * «نامعلوم» (در حال بررسی یا بررسی‌نشده) هرگز allow نیست. ادعای سمت سرور از
 * خودِ منبع API خوانده می‌شود، نه از یک کپی.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAV_OPERATIONS, type Verdict } from "../src/lib/navigation.ts";
import { SETTINGS_OPERATIONS, SETTINGS_SECTIONS, settingsView, settingsWriteAccess } from "../src/lib/settings-registry.ts";

const map = (entries: Record<string, Verdict>) => new Map(Object.entries(entries));

describe("اسنپ‌پی — جدایی مجوز خواندن و نوشتن (B1-02)", () => {
  test("مجوز نوشتن رجیستری همان مجوز PUT سرور است و همراه پرسش‌های ناوبری پرسیده می‌شود", () => {
    const source = readFileSync(fileURLToPath(new URL("../../api/src/http/snappay-routes.ts", import.meta.url)), "utf8");
    const guard = source.slice(source.indexOf("async function guard"), source.indexOf('app.get("/snappay/config"'));
    assert.match(guard, /write \? "settings\.security" : "settings\.view"/, "نگهبان سرور: نوشتن settings.security، خواندن settings.view");
    const put = source.slice(source.indexOf('app.put("/snappay/config"'), source.indexOf('app.put("/snappay/config"') + 200);
    assert.match(put, /guard\(req\.session, true\)/, "PUT از شاخهٔ نوشتن نگهبان می‌گذرد");
    const section = SETTINGS_SECTIONS.find(s => s.key === "snappay");
    assert.ok(section && "writeAnyOf" in section);
    assert.deepEqual(section.anyOf, ["settings.view"]);
    assert.deepEqual(section.writeAnyOf, ["settings.security"]);
    assert.ok(SETTINGS_OPERATIONS.includes("settings.security"));
    assert.ok(NAV_OPERATIONS.includes("settings.security"));
  });

  test("فقط-خواندن: بخش دیده می‌شود ولی نوشتن رد است", () => {
    const verdicts = map({ "settings.view": "allow", "settings.security": "deny" });
    assert.equal(settingsView("snappay", { state: "ready", verdicts }).selected, "snappay");
    assert.equal(settingsWriteAccess("snappay", verdicts), "deny");
  });

  test("allow صریح نوشتن فرم را باز می‌کند", () => {
    assert.equal(settingsWriteAccess("snappay", map({ "settings.view": "allow", "settings.security": "allow" })), "allow");
  });

  test("در حال بررسی و بررسی‌نشده allow نیستند", () => {
    // loading: هنوز پاسخی نیامده. degraded: پرسش settings.security نرسید.
    assert.equal(settingsWriteAccess("snappay", map({})), "unknown");
    assert.equal(settingsWriteAccess("snappay", map({ "settings.view": "allow" })), "unknown");
  });

  test("بخش بی writeAnyOf همان مجوز خواندنش را دارد", () => {
    assert.equal(settingsWriteAccess("keys", map({ "settings.view": "allow", "settings.security": "deny" })), "allow");
    assert.equal(settingsWriteAccess("appearance", map({})), "allow");
  });
});
