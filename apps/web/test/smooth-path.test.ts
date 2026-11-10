/** منحنی نرم نمودار: از همهٔ نقطه‌ها می‌گذرد و هرگز عددی را که نبوده نشان نمی‌دهد (بی بیش‌جهش). */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { smoothArea, smoothPath, smoothSegments, type Pt } from "../src/lib/smooth-path.ts";

const bez = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

function assertNoOvershoot(p: readonly Pt[]) {
  const segs = smoothSegments(p);
  assert.equal(segs.length, p.length - 1);
  segs.forEach((s, i) => {
    const [x0, y0] = p[i]!, [x1, y1] = p[i + 1]!;
    assert.deepEqual(s.to, [x1, y1], "منحنی از خودِ نقطه می‌گذرد");
    const lo = Math.min(y0, y1) - 1e-9, hi = Math.max(y0, y1) + 1e-9;
    const xl = Math.min(x0, x1) - 1e-9, xh = Math.max(x0, x1) + 1e-9;
    for (let k = 0; k <= 50; k++) {
      const t = k / 50;
      const y = bez(y0, s.c1[1], s.c2[1], y1, t), x = bez(x0, s.c1[0], s.c2[0], x1, t);
      assert.ok(y >= lo && y <= hi, `پارهٔ ${i}: y=${y} بیرون از [${lo}, ${hi}] — بیش‌جهش`);
      assert.ok(x >= xl && x <= xh, `پارهٔ ${i}: x به عقب برنمی‌گردد`);
    }
  });
}

describe("منحنی نرم یکنوا", () => {
  test("ساعت صفر کنار ساعت پرفروش زیر صفر نمی‌رود (بیش‌جهش منحنی معمولی)", () => {
    // y پیکسلی: بزرگ‌تر یعنی پایین‌تر؛ ۱۸۰ = خط صفر.
    assertNoOvershoot([[0, 180], [50, 180], [100, 20], [150, 180], [200, 180]]);
  });
  test("جهت راست‌به‌چپ (x کاهشی) هم یکنوا می‌ماند", () => {
    assertNoOvershoot([[600, 150], [500, 140], [400, 60], [300, 70], [200, 10]]);
  });
  test("داده‌های تصادفی بازتولیدپذیر — هیچ پاره‌ای بیرون از دو نقطه‌اش نمی‌رود", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 200; run++) {
      const n = 2 + Math.floor(rnd() * 14);
      const p: Pt[] = Array.from({ length: n }, (_, i) => [i * 40, Math.round(rnd() * 200)] as const);
      assertNoOvershoot(run % 2 ? p : p.map(([x, y]) => [600 - x, y] as const));
    }
  });
  test("مسیر SVG: یک نقطه فقط M، چند نقطه M و C؛ سطح بسته تا خط پایه", () => {
    assert.equal(smoothPath([]), "");
    assert.equal(smoothPath([[10, 20]]), "M10 20");
    const d = smoothPath([[0, 10], [10, 20], [20, 5]]);
    assert.match(d, /^M0 10 C[^C]+ C[^C]+$/);
    assert.ok(d.endsWith("20 5"));
    const a = smoothArea([[0, 10], [10, 20]], 30);
    assert.match(a, /^M0 30 L0 10 C.+ L10 30 Z$/);
    assert.equal(smoothArea([[0, 10]], 30), "");
  });
});
