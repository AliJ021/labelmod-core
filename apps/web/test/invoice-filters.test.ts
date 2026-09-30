/**
 * یافتهٔ runtime انسانی پس از دستهٔ ۱ — فیلتر تاریخ فاکتورها هنوز «(میلادی)» و
 * تقویم بومی میلادی بود. قرارداد همان گزارش‌هاست: کاربر جلالی می‌نویسد و می‌بیند،
 * نشانی و درخواست ISO میلادی می‌مانند. تفاوت فقط این است که اینجا هر دو سر اختیاری‌اند.
 *
 * رفتار مرورگر (نشانی، درخواست، بارگذاری، بازگشت) در `e2e/workspace.spec.ts` است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jalaliInputOf, readOptionalJalaliPeriod } from "../src/lib/report-filters.ts";

const source = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("بازهٔ اختیاری جلالی فاکتورها", () => {
  test("هر دو خالی: بی‌مرز و قابل ارسال", () => {
    assert.deepEqual(readOptionalJalaliPeriod("", ""), { from: null, to: null, issue: null });
    assert.deepEqual(readOptionalJalaliPeriod("  ", ""), { from: null, to: null, issue: null }, "فاصلهٔ خالی هم خالی است");
  });
  test("جلالی → ISO؛ رقم فارسی، عربی و لاتین", () => {
    assert.deepEqual(readOptionalJalaliPeriod("۱۴۰۵/۰۷/۰۸", ""), { from: "2026-09-30", to: null, issue: null });
    assert.deepEqual(readOptionalJalaliPeriod("", "١٤٠٥/٠٧/٠٨"), { from: null, to: "2026-09-30", issue: null });
    assert.deepEqual(readOptionalJalaliPeriod("1405/07/01", "1405/07/08"), { from: "2026-09-23", to: "2026-09-30", issue: null });
  });
  test("ISO نشانی → متن جلالی فیلد (بارگذاری دوباره)", () => {
    assert.equal(jalaliInputOf("2026-09-30"), "۱۴۰۵/۰۷/۰۸");
    assert.equal(jalaliInputOf(""), "", "بی‌مرز یعنی فیلد خالی");
    assert.deepEqual(readOptionalJalaliPeriod(jalaliInputOf("2026-09-23"), jalaliInputOf("2026-09-30")), { from: "2026-09-23", to: "2026-09-30", issue: null });
  });
  test("نیمه‌تایپ: خطای کنار همان فیلد، نه درخواست", () => {
    const r = readOptionalJalaliPeriod("1405/07", "");
    assert.equal(r.issue?.field, "from");
    assert.equal(r.issue?.message, "تاریخ را به شکل ۱۴۰۵/۰۶/۱۰ کامل کنید.");
    assert.equal(readOptionalJalaliPeriod("", "1405/0")?.issue?.field, "to");
  });
  test("ناموجود رد می‌شود، گرد نمی‌شود؛ سال کبیسه درست", () => {
    const bad = readOptionalJalaliPeriod("1404/12/30", "");
    assert.equal(bad.issue?.message, "این تاریخ در تقویم جلالی وجود ندارد.", "۱۴۰۴ کبیسه نیست");
    assert.equal(bad.from, null);
    assert.deepEqual(readOptionalJalaliPeriod("1403/12/30", ""), { from: "2025-03-20", to: null, issue: null }, "۱۴۰۳ کبیسه است");
    assert.equal(readOptionalJalaliPeriod("", "1405/07/31").issue?.field, "to", "مهر ۳۰ روزه است");
    assert.equal(readOptionalJalaliPeriod("2026/09/30", "").issue?.message, "سال را جلالی وارد کنید، مثل ۱۴۰۵.");
    assert.equal(readOptionalJalaliPeriod("garbage", "").issue?.field, "from", "مقدار دست‌کاری‌شدهٔ نشانی هم فرستاده نمی‌شود");
  });
  test("بازهٔ معکوس خطای «تا» است؛ یک روز و یک سرِ خالی مجاز", () => {
    const r = readOptionalJalaliPeriod("1405/07/08", "1405/07/01");
    assert.equal(r.issue?.field, "to");
    assert.equal(r.issue?.message, "«تا تاریخ» نباید پیش از «از تاریخ» باشد.");
    assert.equal(readOptionalJalaliPeriod("1405/07/08", "1405/07/08").issue, null);
    assert.equal(readOptionalJalaliPeriod("1405/07/08", "").issue, null);
  });
});

describe("صفحهٔ فاکتورها: یک سامانهٔ جلالی، بی تقویم میلادی بومی", () => {
  const invoices = source("../src/screens/Invoices.tsx");
  test("برچسب «(میلادی)» و input تاریخ بومی حذف شده‌اند", () => {
    assert.doesNotMatch(invoices, /\(میلادی\)/);
    assert.doesNotMatch(invoices, /type="date"/);
    assert.match(invoices, /label="از تاریخ"/);
    assert.match(invoices, /label="تا تاریخ"/);
  });
  test("گزارش‌ها و فاکتورها یک پیاده‌سازی مشترک دارند", () => {
    const reports = source("../src/screens/Reports.tsx");
    for (const [name, src] of [["Invoices", invoices], ["Reports", reports]] as const) {
      assert.match(src, /from "\.\.\/components\/ui\/JalaliDate\.tsx"/, `${name}: از فیلد مشترک`);
      assert.doesNotMatch(src, /function useJalaliDraft|function (Jalali)?DateHint/, `${name}: نسخهٔ محلی ممنوع`);
    }
    assert.match(invoices, /readOptionalJalaliPeriod/, "تجزیه از lib/report-filters.ts");
    assert.match(invoices, /enabled: !selected && issue === null/, "بازهٔ نامعتبر درخواست نمی‌سازد");
  });
});
