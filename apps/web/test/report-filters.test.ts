/**
 * گسترش نظام طراحی، دستهٔ ۱ — گزارش‌ها: منطق خالص فیلتر، جمع ستون و
 * هم‌ارزی مهاجرت پول (`toman` میراث ← `Money`/`formatMoney`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIsoDate, jalaliHint, jalaliInputOf, jalaliToIso, parseJalaliDate, periodIssue, periodLabel, readJalaliPeriod } from "../src/lib/report-filters.ts";
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

/**
 * ورود جلالی فیلتر گزارش — یافتهٔ runtime انسانی: فیلتر تاریخ «(میلادی)» بود.
 * کاربر جلالی می‌نویسد؛ درخواست و نشانی همان ISO میلادی می‌مانند. تبدیل همان
 * `Intl` تقویم persian است که صفحه با آن تاریخ نشان می‌دهد.
 */
describe("فیلتر بازهٔ گزارش — ورود جلالی", () => {
  test("جلالی → ISO میلادی: نقاط مرجع شناخته‌شده", () => {
    assert.equal(jalaliToIso({ year: 1405, month: 6, day: 10 }), "2026-09-01");
    assert.equal(jalaliToIso({ year: 1405, month: 6, day: 25 }), "2026-09-16");
    assert.equal(jalaliToIso({ year: 1405, month: 1, day: 1 }), "2026-03-21", "نوروز ۱۴۰۵");
    assert.equal(jalaliToIso({ year: 1404, month: 1, day: 1 }), "2025-03-21", "نوروز ۱۴۰۴");
    assert.equal(jalaliToIso({ year: 1404, month: 10, day: 11 }), "2026-01-01", "گذر سال میلادی");
    assert.equal(jalaliToIso({ year: 1405, month: 12, day: 29 }), "2027-03-20");
  });
  test("کبیسه: ۳۰ اسفند فقط در سال کبیسه وجود دارد و گرد نمی‌شود", () => {
    assert.equal(jalaliToIso({ year: 1403, month: 12, day: 30 }), "2025-03-20", "۱۴۰۳ کبیسه است");
    assert.equal(jalaliToIso({ year: 1404, month: 12, day: 30 }), null, "۱۴۰۴ کبیسه نیست؛ نه ۲۹ اسفند، نه ۱ فروردین");
    assert.equal(jalaliToIso({ year: 1405, month: 7, day: 31 }), null, "مهر ۳۰ روزه است");
    assert.equal(jalaliToIso({ year: 1405, month: 6, day: 31 }), "2026-09-22", "شهریور ۳۱ روزه است");
    assert.equal(jalaliToIso({ year: 1405, month: 13, day: 1 }), null);
    assert.equal(jalaliToIso({ year: 1405, month: 0, day: 1 }), null);
    assert.equal(jalaliToIso({ year: 1405, month: 1, day: 0 }), null);
  });
  test("رفت و برگشت: هر روز یک سال کامل، ISO → متن جلالی → ISO", () => {
    // ۱۴۰۳ (کبیسه) تا پایان ۱۴۰۵: هر روز، هیچ جابه‌جایی یک‌روزه.
    for (let ms = Date.UTC(2024, 2, 20); ms <= Date.UTC(2027, 2, 20); ms += 86_400_000) {
      const iso = new Date(ms).toISOString().slice(0, 10);
      const r = parseJalaliDate(jalaliInputOf(iso));
      assert.deepEqual(r, { kind: "ok", iso }, iso);
    }
  });
  test("ISO → متن فیلد جلالی با رقم فارسی (بازسازی از نشانی)", () => {
    assert.equal(jalaliInputOf("2026-09-01"), "۱۴۰۵/۰۶/۱۰");
    assert.equal(jalaliInputOf("2025-03-20"), "۱۴۰۳/۱۲/۳۰");
    assert.equal(jalaliInputOf("2025-03-21"), "۱۴۰۴/۰۱/۰۱");
    assert.equal(jalaliInputOf(""), "", "بی تاریخ، فیلد خالی");
    assert.equal(jalaliInputOf("2026-09-1"), "2026-09-1", "ISO خراب در نشانی همان‌طور دیده می‌شود تا خطایش پیدا باشد");
  });
  test("ورودی: رقم فارسی/عربی/لاتین، جداکنندهٔ / - . و هشت رقم پشت‌هم", () => {
    for (const text of ["۱۴۰۵/۰۶/۱۰", "1405/06/10", "1405/6/10", "١٤٠٥/٠٦/١٠", "1405-06-10", "1405.06.10", "14050610", " ۱۴۰۵/۶/۱۰ "]) {
      assert.deepEqual(parseJalaliDate(text), { kind: "ok", iso: "2026-09-01" }, text);
    }
  });
  test("نیمه‌تایپ «ناقص» است و ناموجود «نامعتبر» — هیچ‌کدام ISO نمی‌دهند", () => {
    // «1405//10»: ماه پاک شده تا دوباره نوشته شود — هنوز در حال ویرایش است.
    for (const text of ["", "1", "1405", "۱۴۰۵/", "1405/06", "1405/06/", "140506", "1405//10"]) assert.equal(parseJalaliDate(text).kind, "incomplete", text);
    for (const text of ["1404/12/30", "1405/07/31", "1405/13/01", "1405/00/10", "abc", "1405/06/10/1", "1405/006/10"]) assert.equal(parseJalaliDate(text).kind, "invalid", text);
    const gregorian = parseJalaliDate("2026/09/01");
    assert.equal(gregorian.kind, "invalid", "سال میلادی در فیلد جلالی پذیرفته نمی‌شود");
    assert.match(gregorian.kind === "invalid" ? gregorian.message : "", /جلالی/);
  });
  test("بازه: معتبر، ناقص، ناموجود و معکوس؛ خطا کنار همان فیلد", () => {
    assert.deepEqual(readJalaliPeriod("۱۴۰۵/۰۶/۱۰", "۱۴۰۵/۰۶/۲۵"), { from: "2026-09-01", to: "2026-09-16", issue: null });
    assert.deepEqual(readJalaliPeriod("1405/06/25", "1405/06/25"), { from: "2026-09-16", to: "2026-09-16", issue: null }, "یک روز مجاز است");
    const partial = readJalaliPeriod("1405/06", "1405/06/25");
    assert.equal(partial.issue?.field, "from"); assert.equal(partial.from, null); assert.equal(partial.to, "2026-09-16");
    assert.equal(readJalaliPeriod("1405/06/10", "1404/12/30").issue?.field, "to");
    assert.equal(readJalaliPeriod("1405/06/10", "1404/12/30").issue?.message, "این تاریخ در تقویم جلالی وجود ندارد.");
    const reversed = readJalaliPeriod("1405/06/25", "1405/06/10");
    assert.equal(reversed.issue?.field, "to");
    assert.equal(reversed.issue?.message, "«تا تاریخ» نباید پیش از «از تاریخ» باشد.");
    assert.equal(readJalaliPeriod("1405/12/29", "1406/01/01").issue, null, "بازه از روی نوروز");
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
