/**
 * گسترش نظام طراحی، دستهٔ ۱ — گزارش‌ها: منطق خالص فیلتر، جمع ستون و
 * هم‌ارزی مهاجرت پول (`toman` میراث ← `Money`/`formatMoney`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIsoDate, jalaliHint, periodIssue, periodLabel } from "../src/lib/report-filters.ts";
import { sumRialOrNull } from "../src/lib/reports.ts";
import { parseRial, toman } from "../src/lib/money.ts";
import { formatMoney, moneyParts } from "../src/lib/format.ts";

describe("فیلتر بازهٔ گزارش", () => {
  test("فقط تاریخ ISO کامل و واقعی پذیرفته است", () => {
    assert.equal(isIsoDate("2026-09-01"), true);
    assert.equal(isIsoDate("2026-02-29"), false, "۲۰۲۶ کبیسه نیست");
    assert.equal(isIsoDate("2026-09-31"), false);
    assert.equal(isIsoDate("2026-9-1"), false, "نیمه‌تایپ");
    assert.equal(isIsoDate(""), false);
    assert.equal(isIsoDate("۲۰۲۶-۰۹-۰۱"), false, "رقم فارسی پیش از normalizeDigits معتبر نیست");
  });
  test("خطای بازه کنار همان فیلد و «تا» پیش از «از» رد می‌شود", () => {
    assert.equal(periodIssue("2026-09-01", "2026-09-30"), null);
    assert.equal(periodIssue("2026-09-05", "2026-09-05"), null, "یک روز مجاز است");
    assert.equal(periodIssue("2026-09", "2026-09-30")?.field, "from");
    assert.equal(periodIssue("2026-09-01", "")?.field, "to");
    assert.equal(periodIssue("2026-09-30", "2026-09-01")?.field, "to");
  });
  test("برچسب جلالی بازه همان تاریخ‌های ارسالی است، نه تفسیر تازه", () => {
    assert.equal(periodLabel("2026-09-01", "2026-09-16"), "۱۰ شهریور ۱۴۰۵ تا ۲۵ شهریور ۱۴۰۵");
    assert.equal(periodLabel("2026-09-16", "2026-09-16"), "۲۵ شهریور ۱۴۰۵");
    assert.equal(periodLabel("2026-09-16", "2026-09-01"), null);
    assert.equal(jalaliHint("2026-09-1"), null);
  });
});

describe("جمع ستون گزارش", () => {
  test("bigint دقیق بالای محدودهٔ امن number", () => {
    assert.equal(sumRialOrNull(["9007199254740993", "10"]), 9007199254741003n);
    assert.equal(sumRialOrNull([]), 0n);
    assert.equal(sumRialOrNull(["-50000", "50000"]), 0n);
  });
  test("یک سطر بی‌مجوز جمع را نامعلوم می‌کند — نه جمع ناقص", () => {
    assert.equal(sumRialOrNull(["1000", null, "2000"]), null);
    assert.equal(sumRialOrNull([null, "2000"]), null, "میراث: `null ?? 0n` این را ۲۰۰۰ می‌کرد");
  });
});

describe("مهاجرت پول در گزارش‌ها — هم‌ارزی با قالب میراث", () => {
  // قالب میراث: `toman(parseRial(v))`. همان ارقام، همان گرد کردن (تقسیم صحیح
  // قدرمطلق بر ده)، همان علامت «−»؛ فقط واحد و رنگ در کامپوننت اضافه شد.
  const cases = ["0", "5", "9", "10", "15", "-5", "-15", "-50000", "12340000", "1000000000000", "9007199254740993"];
  for (const v of cases) {
    test(`ارقام و علامت ${v}`, () => {
      assert.equal(formatMoney(v), toman(parseRial(v)));
      const p = moneyParts(v);
      assert.equal(p.sign, parseRial(v) > 0n ? "positive" : parseRial(v) < 0n ? "negative" : "zero");
    });
  }
  test("صفر «0» است و «—» فقط برای null", () => {
    assert.equal(formatMoney("0"), "0");
    const src = readFileSync(new URL("../src/components/ui/Money.tsx", import.meta.url), "utf8");
    assert.match(src, /rial === null/, "Money باید null را «—» کند، نه صفر");
  });
  test("صفحه‌های گزارش دیگر قالب میراث `toman` را مستقیم صدا نمی‌زنند", () => {
    for (const f of ["../src/screens/Reports.tsx", "../src/components/SnappayReport.tsx", "../src/components/StaffSales.tsx"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.doesNotMatch(src, /\btoman\(/, `${f}: پول فقط با Money`);
      assert.doesNotMatch(src, /toLocaleString\(/, `${f}: عدد و تاریخ از format.ts`);
      assert.doesNotMatch(src, /BigInt\(/, `${f}: رشتهٔ ریالی فقط از parseRial`);
    }
  });
});
