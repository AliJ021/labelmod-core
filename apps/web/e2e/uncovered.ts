/**
 * «کاربر این را کامل می‌بیند و چیزی رویش نیست» — از دید کاربر، نه از کلاس CSS.
 *
 * جایگزین آزمون هندسهٔ `.pay-scroll` (بازطراحی مصوب مالک): جعبهٔ عنصر کاملاً درون پنجره است
 * و در پنج نقطه (مرکز و چهار گوشهٔ کمی داخل‌تر) بالاترین عنصر خودش یا فرزندش است — پس نه پایان
 * چسبان ستون پرداخت، نه خلاصهٔ پایین موبایل، نه چیز دیگری آن را نپوشانده است.
 */
import { expect, type Locator } from "@playwright/test";

export async function expectUncovered(target: Locator, what: string): Promise<void> {
  const result = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 0 && r.height > 0;
    const pts = [[0.5, 0.5], [0.1, 0.15], [0.9, 0.15], [0.1, 0.85], [0.9, 0.85]] as const;
    const covered = pts.map(([x, y]) => {
      const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
      return hit && (hit === el || el.contains(hit)) ? null : hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "nothing";
    }).filter((c): c is string => c !== null);
    return { inView, covered, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight } };
  });
  expect(result.inView, `${what}: کامل درون پنجره ${JSON.stringify(result.rect)}`).toBe(true);
  expect(result.covered, `${what}: هیچ عنصری رویش نیست`).toEqual([]);
}
