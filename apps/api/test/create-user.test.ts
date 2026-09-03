/**
 * ابزار ساخت کاربر — بخش‌هایی که به دیتابیس نیاز ندارند.
 *
 * چرا تست: این تنها راه باز کردن یک استقرار تازه است. اگر آرگومان‌ها
 * بی‌صدا بد خوانده شوند یا رمز از مولد ضعیف بیاید، خرابی‌اش در روز
 * اول دیده نمی‌شود.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassword, parseArgs } from "../src/cli/create-user.ts";

test("خواندن آرگومان‌ها", async (t) => {
  await t.test("حداقل‌ها", () => {
    const a = parseArgs(["--username", "ali", "--name", "علی جوادی"]);
    assert.equal(a.username, "ali");
    assert.equal(a.name, "علی جوادی");
    assert.deepEqual(a.roles, ["admin"]); // پیش‌فرض
    assert.equal(a.branch, null);
    assert.equal(a.mobile, null);
  });

  await t.test("چند نقش با کاما", () => {
    const a = parseArgs(["--username", "x", "--name", "y", "--role", "admin, accountant"]);
    assert.deepEqual(a.roles, ["admin", "accountant"]);
  });

  await t.test("بدون نام کاربری یا نام، خطای فارسی", () => {
    assert.throws(() => parseArgs(["--username", "ali"]), /استفاده:/);
    assert.throws(() => parseArgs([]), /استفاده:/);
  });
});

test("رمز تولیدشده", async (t) => {
  await t.test("طول پیش‌فرض ۲۴ — بالاتر از حداقل ۱۲ کاراکتر بند ۷ SECURITY.md", () => {
    assert.equal(generatePassword().length, 24);
  });

  await t.test("هیچ کاراکتر مبهمی ندارد", () => {
    // این رمز روی کاغذ نوشته و دستی تایپ می‌شود.
    for (let i = 0; i < 200; i++) {
      assert.doesNotMatch(generatePassword(), /[O0lI1]/);
    }
  });

  await t.test("تکرار نمی‌شود", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generatePassword());
    assert.equal(seen.size, 500);
  });

  await t.test("هر کاراکتر از الفبای مجاز است", () => {
    assert.match(generatePassword(64), /^[a-zA-Z2-9]+$/);
  });
});
