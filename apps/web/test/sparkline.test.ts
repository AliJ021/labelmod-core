/** نمودار کوچک کارت شاخص: تجمعی، راست‌به‌چپ، و «نرسیده» صفر نیست. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sparkPath, sparkPoints } from "../src/lib/sparkline.ts";


describe("نمودار کوچک شاخص", () => {
  test("کمتر از دو ساعت رسیده، خطی ندارد", () => {
    assert.equal(sparkPath([], 100, 30), null);
    assert.equal(sparkPath([5n, null, null], 100, 30), null);
  });

  test("تجمعی سرور حفظ می‌شود و ساعت زودتر سمت راست می‌نشیند", () => {
    const p = sparkPoints([10n, 20n, 30n], 100, 30)!;
    assert.equal(p.length, 3);
    assert.deepEqual(p.map(q => q[0]), [100, 50, 0]);
    // تجمعی رو به بالا: y کوچک‌تر یعنی بالاتر.
    assert.ok(p[0]![1] > p[1]![1] && p[1]![1] > p[2]![1]);
  });

  test("ساعت نرسیده پایان خط است، نه صفر", () => {
    const p = sparkPoints([10n, 20n, null, null], 90, 30)!;
    assert.equal(p.length, 2);
    assert.equal(p[1]![0], 0, "آخرین نقطهٔ رسیده تا لبهٔ چپ کشیده می‌شود");
  });

  test("منفی (مرجوعی) حفظ می‌شود و خط ثابت وسط می‌نشیند", () => {
    const neg = sparkPoints([-30n, -20n], 100, 30)!;
    assert.ok(neg[0]![1] > neg[1]![1], "تجمعی از −۳۰ به −۲۰ بالا می‌رود");
    const flat = sparkPoints([0n, 0n], 100, 30)!;
    assert.deepEqual(flat.map(q => q[1]), [15, 15]);
  });

  test("مقادیر تجمعی دوباره جمع نمی‌شوند؛ ساعت بدون تغییر خط افقی دارد", () => {
    const p = sparkPoints([10n, 10n, 10n], 100, 30)!;
    assert.deepEqual(p.map(q => q[1]), [2, 2, 2]);
  });

  test("مسیر نرم از همان آخرین نقطه می‌گذرد", () => {
    const values = [10n, 30n, 5n, 20n];
    const last = sparkPoints(values, 120, 32)!.at(-1)!;
    const path = sparkPath(values, 120, 32)!;
    assert.match(path, / C/);
    assert.ok(path.endsWith(`${last[0]} ${last[1]}`));
  });

  test("مبلغ بزرگ‌تر از دقت number هندسه را نمی‌شکند", () => {
    const big = 10n ** 20n;
    const p = sparkPoints([big, big, big], 100, 30)!;
    assert.ok(p.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && y >= 2 && y <= 28));
  });
});
