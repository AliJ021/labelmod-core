import { test } from "node:test";
import assert from "node:assert/strict";
import { dayCount, deltaDirection, deltaMagnitude, PERIOD_PRESETS, periodRange } from "../src/lib/dashboard-period.ts";
import { addDays } from "../src/lib/dashboard-trend.ts";
import { toJalali } from "../src/lib/jalali-period.ts";

const TODAY = "2026-09-16"; // ۲۵ شهریور ۱۴۰۵

test("بازهٔ غلتان: همان شمار روزِ بلافاصله پیش از آن", () => {
  assert.deepEqual(periodRange("7d", TODAY), { from: "2026-09-10", to: TODAY, prevFrom: "2026-09-03", prevTo: "2026-09-09" });
  assert.deepEqual(periodRange("30d", TODAY), { from: "2026-08-18", to: TODAY, prevFrom: "2026-07-19", prevTo: "2026-08-17" });
});

test("این ماه: از ۱ شهریور تا امروز، در برابر ۱ تا ۲۵ مرداد", () => {
  assert.deepEqual(periodRange("month", TODAY), { from: "2026-08-23", to: TODAY, prevFrom: "2026-07-23", prevTo: "2026-08-16" });
  // روز اول ماه: یک روز در برابر روز اول ماه قبل.
  assert.deepEqual(periodRange("month", "2026-08-23"), { from: "2026-08-23", to: "2026-08-23", prevFrom: "2026-07-23", prevTo: "2026-07-23" });
  // ۳۱ اردیبهشت در برابر کل فروردین (۳۱ روزه) — نه یک ماه میلادی.
  assert.deepEqual(periodRange("month", "2026-05-21"), { from: "2026-04-21", to: "2026-05-21", prevFrom: "2026-03-21", prevTo: "2026-04-20" });
});

test("ماه قبل: مرداد کامل در برابر تیر کامل؛ در فروردین، اسفندِ ۲۹ روزه در برابر بهمن", () => {
  assert.deepEqual(periodRange("lastMonth", TODAY), { from: "2026-07-23", to: "2026-08-22", prevFrom: "2026-06-22", prevTo: "2026-07-22" });
  const r = periodRange("lastMonth", "2026-03-21");
  assert.deepEqual(r, { from: "2026-02-20", to: "2026-03-20", prevFrom: "2026-01-21", prevTo: "2026-02-19" });
  assert.equal(dayCount(r.from, r.to), 29, "اسفند ۱۴۰۴");
  assert.deepEqual([toJalali(r.from), toJalali(r.to)], [{ year: 1404, month: 12, day: 1 }, { year: 1404, month: 12, day: 29 }]);
});

test("ویژگی: برای هر روز سال و هر گزینه، مبنا پیش از دوره و بی هم‌پوشانی است (سرور هم‌پوشانی را رد می‌کند)", () => {
  for (let i = 0; i < 400; i++) {
    const today = addDays("2026-01-01", i);
    for (const { key } of PERIOD_PRESETS) {
      const r = periodRange(key, today);
      assert.ok(r.from <= r.to && r.prevFrom <= r.prevTo, `${key} ${today}`);
      assert.ok(r.prevTo < r.from, `${key} ${today}: هم‌پوشانی`);
      assert.ok(r.to <= today, `${key} ${today}: آینده`);
      assert.ok(dayCount(r.from, r.to) <= 400 && dayCount(r.prevFrom, r.prevTo) <= 400);
      if (key === "7d" || key === "30d") {
        assert.equal(dayCount(r.from, r.to), dayCount(r.prevFrom, r.prevTo), `${key} ${today}: طول برابر`);
        assert.equal(addDays(r.prevTo, 1), r.from, `${key} ${today}: بلافاصله پیش از آن`);
      }
      if (key === "month") {
        assert.equal(toJalali(r.from).day, 1);
        assert.equal(toJalali(r.prevFrom).day, 1);
        assert.ok(dayCount(r.prevFrom, r.prevTo) <= dayCount(r.from, r.to), `${key} ${today}: مبنا بلندتر از دوره نیست`);
      }
      if (key === "lastMonth") {
        assert.equal(addDays(r.to, 1) <= today, true);
        assert.equal(toJalali(addDays(r.to, 1)).day, 1, "پایان ماه کامل");
        assert.equal(addDays(r.prevTo, 1), r.from, "ماه پیش از آن، پشت‌سرهم");
      }
    }
  }
});

test("تفاضل: جهت و قدر مطلق bigint، بی درصد و بی گرد کردن", () => {
  assert.equal(deltaDirection("0"), "flat");
  assert.equal(deltaDirection("-1"), "down");
  assert.equal(deltaDirection("90071992547409930"), "up");
  assert.equal(deltaMagnitude("-90071992547409931"), 90071992547409931n, "بالای MAX_SAFE_INTEGER دقیق می‌ماند");
});
