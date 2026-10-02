import { test } from "node:test";
import assert from "node:assert/strict";
import { tomanExact } from "../src/lib/money.ts";
import { moneyParts } from "../src/lib/format.ts";

test("تومان دقیق: یک ریال، بازهٔ زیر یک تومان، صفر و مبلغ صحیح", () => {
  for (const [rial, expected] of [
    [1n, "0٫1"], [1001n, "100٫1"], [1009n, "100٫9"],
    [0n, "0"], [12500000n, "1٬250٬000"],
    [-1n, "−0٫1"], [-1009n, "−100٫9"],
    [900719925474099300n, "90٬071٬992٬547٬409٬930"],
    [900719925474099301n, "90٬071٬992٬547٬409٬930٫1"],
    [999999999999999999n, "99٬999٬999٬999٬999٬999٫9"],
  ] as const) assert.equal(tomanExact(rial), expected);
});

test("اجزای مبلغ دقیق علامت و متن خواندنی را حفظ می‌کنند", () => {
  assert.deepEqual(moneyParts("-1", false, true), {
    digits: "0٫1", scale: "", sign: "negative", spoken: "منفی 0٫1 تومان",
  });
  assert.deepEqual(moneyParts("0", false, true), {
    digits: "0", scale: "", sign: "zero", spoken: "0 تومان",
  });
  assert.equal(moneyParts("1001", false, true).digits, "100٫1");
  assert.equal(moneyParts("1009", false, true).digits, "100٫9");
  assert.equal(moneyParts("999999999999999999", true, true).digits, "99٬999٬999٬999٬999٬999٫9");
  assert.throws(() => moneyParts(1001 as unknown as string, false, true), /رشته/);
});

test("حالت پیش‌فرض و فشردهٔ صفحه‌های دیگر تغییر نمی‌کنند", () => {
  assert.equal(moneyParts("1009").digits, "100");
  assert.deepEqual(moneyParts("123456789000", true), {
    digits: "12٫3", scale: "میلیارد", sign: "positive", spoken: "12٫3 میلیارد تومان",
  });
});
