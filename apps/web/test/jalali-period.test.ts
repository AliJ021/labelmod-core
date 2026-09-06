/**
 * مرزهای دوره جلالی — و چهار موردی که بی‌صدا می‌شکنند.
 *
 * این توابع تصمیم می‌گیرند «ماه قبل» یعنی چه، و آن تصمیم مستقیم روی
 * فلش سبز/قرمز پنل مدیریتی می‌نشیند. اگر یک روز جابه‌جا شوند، مالک
 * رشد را افت می‌بیند یا برعکس — و هیچ خطایی نمی‌گیرد.
 *
 * چهار جایی که یک پیاده‌سازی ساده‌انگارانه می‌شکند:
 *
 *   ۱. حساب میلادی: `date - 1 month` روی ۳۱ مرداد وسط تیر می‌افتد
 *   ۲. مرز سال: فروردین باید به **اسفند سال قبل** برود
 *   ۳. ماه کوتاه‌تر: ۳۱ فروردین → اسفند ۲۹ یا ۳۰ روزه است
 *   ۴. طول ماه: شش ماه اول ۳۱ روز، شش ماه دوم ۳۰
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  jalaliMonthRange,
  previousPeriod,
  sameDayPreviousJalaliMonth,
  toJalali,
} from "../src/lib/jalali-period.ts";

describe("تقویم جلالی", () => {
  test("تبدیل میلادی به جلالی با تاریخ‌های شناخته", () => {
    // ۱ فروردین همیشه اول سال است — نقطه‌ای که هر تبدیل غلطی آنجا لو می‌رود.
    assert.deepEqual(toJalali("2026-03-21"), { year: 1405, month: 1, day: 1 });
    assert.deepEqual(toJalali("2026-03-20"), { year: 1404, month: 12, day: 29 });
    assert.deepEqual(toJalali("2026-09-06"), { year: 1405, month: 6, day: 15 });
  });

  test("همان روزِ ماه قبل — نه یک ماه میلادی عقب", () => {
    // ۱۵ شهریور → ۱۵ مرداد. حساب میلادی ۶ اوت منهای یک ماه، ۶ ژوئیه
    // می‌داد که ۱۵ تیر است — یک ماه کامل خطا.
    const prev = sameDayPreviousJalaliMonth("2026-09-06");
    assert.deepEqual(toJalali(prev), { year: 1405, month: 5, day: 15 });
  });

  test("۳۱ مرداد → ۳۱ تیر، چون هر دو ۳۱ روزه‌اند", () => {
    const prev = sameDayPreviousJalaliMonth("2026-08-22");
    assert.deepEqual(toJalali(prev), { year: 1405, month: 4, day: 31 });
  });

  test("مرز سال: فروردین به اسفند سال قبل می‌رود", () => {
    const prev = sameDayPreviousJalaliMonth("2026-03-21"); // ۱ فروردین ۱۴۰۵
    assert.deepEqual(toJalali(prev), { year: 1404, month: 12, day: 1 });
  });

  test("روزی که در ماه مقصد نیست، به آخرین روز همان ماه گرد می‌شود", () => {
    // ۳۱ فروردین ۱۴۰۵ → اسفند ۱۴۰۴ که ۳۱ روز ندارد. باید آخرین روز
    // اسفند شود، **نه** ۱ فروردین. اگر به ماه بعد سُر بخورد، دوره
    // مبنا با دوره جاری هم‌پوشانی پیدا می‌کند.
    const src = "2026-04-20"; // ۳۱ فروردین ۱۴۰۵
    assert.deepEqual(toJalali(src), { year: 1405, month: 1, day: 31 });
    const j = toJalali(sameDayPreviousJalaliMonth(src));
    assert.equal(j.year, 1404);
    assert.equal(j.month, 12, "باید در اسفند بماند، نه فروردین");
    assert.ok(j.day === 29 || j.day === 30, `آخرین روز اسفند: ${j.day}`);
  });

  test("بازه ماه جاری از ۱ تا آخرین روز همان ماه است", () => {
    const r = jalaliMonthRange("2026-09-06"); // شهریور ۱۴۰۵
    assert.deepEqual(toJalali(r.from), { year: 1405, month: 6, day: 1 });
    const to = toJalali(r.to);
    assert.equal(to.month, 6, "پایان بازه باید در همان ماه بماند");
    assert.equal(to.day, 31, "شهریور ۳۱ روز دارد");
  });

  test("ماه دوم سال، ۳۰ روزه است — طول ماه ثابت فرض نمی‌شود", () => {
    const r = jalaliMonthRange("2026-11-01"); // آبان ۱۴۰۵
    const to = toJalali(r.to);
    assert.equal(to.month, 8);
    assert.equal(to.day, 30, "آبان ۳۰ روز دارد، نه ۳۱");
  });

  test("دوره مبنا هر دو مرز را یک ماه عقب می‌برد", () => {
    const p = previousPeriod({ from: "2026-08-23", to: "2026-09-22" });
    assert.deepEqual(toJalali(p.from), { year: 1405, month: 5, day: 1 });
    assert.deepEqual(toJalali(p.to), { year: 1405, month: 5, day: 31 });
  });

  test("دوره مبنا هرگز با دوره جاری هم‌پوشانی ندارد", () => {
    // اگر گرد کردن روزِ ناموجود به ماه بعد سُر بخورد، مبنا داخل دوره
    // جاری می‌افتد و رشد در برابر خودش سنجیده می‌شود — عددی که همیشه
    // نزدیک صفر است و هیچ‌کس شک نمی‌کند.
    for (const iso of [
      "2026-04-20", "2026-03-21", "2026-09-06", "2026-11-01",
      "2026-12-21", "2027-03-20",
    ]) {
      const prev = sameDayPreviousJalaliMonth(iso);
      assert.ok(prev < iso, `${iso} → ${prev} باید عقب‌تر باشد`);
    }
  });
});
