/**
 * مرتب‌سازی درخت کدینگ حساب.
 *
 * چرا این تست ارزش دارد: اگر مرتب‌سازی بشکند، حساب از صفحه **ناپدید**
 * می‌شود بی‌آنکه خطایی بدهد. کاربر فکر می‌کند حساب پاک شده و یکی تازه
 * می‌سازد — و آن‌وقت دو حساب برای یک چیز دارد.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { childLevel, sortTree, type Account } from "../src/lib/admin.ts";

function acct(code: string, parentCode: string | null, level: Account["level"]): Account {
  return {
    code,
    parentCode,
    name: `حساب ${code}`,
    level,
    nature: "debit",
    type: "asset",
    isPostable: level === "moin",
    isActive: true,
    hasChildren: false,
    hasEntries: false,
  };
}

describe("سطح فرزند", () => {
  test("زنجیره چهارسطحی هلو", () => {
    assert.equal(childLevel("group"), "kol");
    assert.equal(childLevel("kol"), "moin");
    assert.equal(childLevel("moin"), "tafsili");
  });

  test("تفصیلی ته درخت است", () => {
    // اگر `null` برنگردد، صفحه دکمه «+ زیرمجموعه» را زیر تفصیلی هم
    // نشان می‌داد و دیتابیس بعداً ردش می‌کرد — خطایی که می‌شد پیش از
    // کلیک جلویش را گرفت.
    assert.equal(childLevel("tafsili"), null);
  });
});

describe("مرتب‌سازی درختی", () => {
  test("هر حساب زیر والدش می‌آید", () => {
    const out = sortTree([
      acct("1101", "11", "moin"),
      acct("1", null, "group"),
      acct("11", "1", "kol"),
    ]);
    assert.deepEqual(out.map((a) => a.code), ["1", "11", "1101"]);
  });

  test("خواهرها بر اساس کد مرتب می‌شوند", () => {
    const out = sortTree([
      acct("1", null, "group"),
      acct("12", "1", "kol"),
      acct("11", "1", "kol"),
    ]);
    assert.deepEqual(out.map((a) => a.code), ["1", "11", "12"]);
  });

  test("مرتب‌سازی الفبایی ساده کافی نیست", () => {
    // این همان چیزی است که نسخه «فقط sort روی کد» می‌شکست: «۱۰» و «۹»
    // الفبایی برعکسِ درخت می‌آیند، و «۹۱» زیر گروه ۹ است نه ۱۰.
    const out = sortTree([
      acct("9", null, "group"),
      acct("10", null, "group"),
      acct("91", "9", "kol"),
      acct("101", "10", "kol"),
    ]);
    assert.deepEqual(out.map((a) => a.code), ["10", "101", "9", "91"]);

    // ادعای واقعی: هر فرزند **بلافاصله** پس از والدش می‌آید.
    const at = (c: string) => out.findIndex((a) => a.code === c);
    assert.equal(at("101"), at("10") + 1);
    assert.equal(at("91"), at("9") + 1);
  });

  test("حسابِ بی‌والد هم دیده می‌شود، نه اینکه ناپدید شود", () => {
    // نباید پیش بیاید (دیتابیس والد را اجبار می‌کند)، ولی اگر پیش
    // آمد، ناپدید شدنش از قلم‌افتادن بدتر است: کاربر حساب تازه
    // می‌سازد و دو حساب برای یک چیز پیدا می‌شود.
    const out = sortTree([acct("1", null, "group"), acct("7701", "77", "moin")]);
    assert.equal(out.length, 2);
    assert.ok(out.some((a) => a.code === "7701"), "حساب یتیم باید دیده شود");
  });

  test("حلقه در درخت صفحه را معلق نمی‌کند", () => {
    // دیتابیس جلویش را می‌گیرد، ولی صفحه نباید به آن تکیه کند — یک
    // حلقه یعنی مرورگر برای همیشه بچرخد.
    const a = acct("11", "12", "kol");
    const b = acct("12", "11", "kol");
    const out = sortTree([a, b]);
    assert.equal(out.length, 2, "هر دو باید بیایند، بدون حلقه بی‌پایان");
  });

  test("ورودی خالی", () => {
    assert.deepEqual(sortTree([]), []);
  });
});
