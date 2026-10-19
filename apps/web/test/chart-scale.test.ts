import { test } from "node:test";
import assert from "node:assert/strict";
import { niceScale } from "../src/lib/chart-scale.ts";

test("گام گرد، مرز از گام، و صفر همیشه درون بازه", () => {
  const s = niceScale([1_234_000n, 200_000n]);
  assert.equal(s.min, 0n);
  assert.ok(s.max >= 1_234_000n && s.max <= 1_234_000n * 2n, "بازه بی‌جهت بزرگ نمی‌شود");
  assert.ok(s.ticks.length >= 3 && s.ticks.length <= 6);
  for (let i = 1; i < s.ticks.length; i++) assert.equal(s.ticks[i]! - s.ticks[i - 1]!, s.ticks[1]! - s.ticks[0]!, "گام یکنواخت");
  assert.ok(s.ticks.includes(0n));
  assert.deepEqual(niceScale([1_234_000n]), { min: 0n, max: 1_500_000n, ticks: [0n, 500_000n, 1_000_000n, 1_500_000n] });
});

test("منفی زیر صفر می‌ماند؛ نه صفر می‌شود نه قدرمطلق", () => {
  const s = niceScale([200_000n, -50_000n, 120_000n]);
  assert.ok(s.min < 0n && s.min <= -50_000n);
  assert.ok(s.max >= 200_000n);
  assert.ok(s.ticks.includes(0n));
  const allNeg = niceScale([-30n, -7n]);
  assert.equal(allNeg.max, 0n, "همه منفی: صفر سقف است");
  assert.ok(allNeg.min <= -30n);
});

test("همه صفر یا بی داده: فقط صفر؛ دقت bigint فراتر از Number", () => {
  assert.deepEqual(niceScale([]), { min: 0n, max: 0n, ticks: [0n] });
  assert.deepEqual(niceScale([0n, 0n]), { min: 0n, max: 0n, ticks: [0n] });
  const big = 9_007_199_254_740_993_000n; // بیش از MAX_SAFE_INTEGER
  const s = niceScale([big]);
  assert.ok(s.max >= big, "مرز بالا از بزرگ‌ترین مقدار کمتر نیست");
  assert.equal(typeof s.max, "bigint");
});
