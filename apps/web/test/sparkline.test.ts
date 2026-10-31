/** نمودار کوچک کارت شاخص: تجمعی، راست‌به‌چپ، و «نرسیده» صفر نیست. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sparkPath } from "../src/lib/sparkline.ts";

const points = (d: string) => d.split(/[ML]/).filter(Boolean).map(p => p.trim().split(" ").map(Number) as [number, number]);

describe("نمودار کوچک شاخص", () => {
  test("کمتر از دو ساعت رسیده، خطی ندارد", () => {
    assert.equal(sparkPath([], 100, 30), null);
    assert.equal(sparkPath([5n, null, null], 100, 30), null);
  });

  test("تجمعی است و ساعت زودتر سمت راست می‌نشیند", () => {
    const p = points(sparkPath([10n, 10n, 10n], 100, 30)!);
    assert.equal(p.length, 3);
    assert.deepEqual(p.map(q => q[0]), [100, 50, 0]);
    // تجمعی رو به بالا: y کوچک‌تر یعنی بالاتر.
    assert.ok(p[0]![1] > p[1]![1] && p[1]![1] > p[2]![1]);
  });

  test("ساعت نرسیده پایان خط است، نه صفر", () => {
    const p = points(sparkPath([10n, 20n, null, null], 90, 30)!);
    assert.equal(p.length, 2);
    assert.equal(p[1]![0], 0, "آخرین نقطهٔ رسیده تا لبهٔ چپ کشیده می‌شود");
  });

  test("منفی (مرجوعی) حفظ می‌شود و خط ثابت وسط می‌نشیند", () => {
    const neg = points(sparkPath([-30n, 10n], 100, 30)!);
    assert.ok(neg[0]![1] > neg[1]![1], "تجمعی از −۳۰ به −۲۰ بالا می‌رود");
    const flat = points(sparkPath([0n, 0n], 100, 30)!);
    assert.deepEqual(flat.map(q => q[1]), [15, 15]);
  });

  test("مبلغ بزرگ‌تر از دقت number هندسه را نمی‌شکند", () => {
    const big = 10n ** 20n;
    const p = points(sparkPath([big, big, big], 100, 30)!);
    assert.ok(p.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && y >= 2 && y <= 28));
  });
});
