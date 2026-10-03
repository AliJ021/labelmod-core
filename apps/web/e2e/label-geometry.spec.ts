import { test, expect } from "@playwright/test";
import { labelGeometry, labelPage, ROLL_PRESETS_MM, ROLL_MIN_HEIGHT_MM, ROLL_MIN_WIDTH_MM, type LabelItem } from "../../api/src/catalog/label.ts";
import { makeEan13 } from "../../api/src/catalog/barcode.ts";

/**
 * هندسهٔ واقعی برچسب در موتور مرورگر — نه فقط حساب میلی‌متری.
 * هر ردیف و SVG بارکد باید داخل جعبهٔ داخلی برچسب (پس از padding) بماند،
 * قیمت افقی بریده نشود و نام فقط سطر کامل داشته باشد.
 */
const items: LabelItem[] = [
  { barcode: makeEan13(1201), sku: "LM-1201", productName: "شلوار پارچه‌ای رگولار با نام طولانی برای بررسی چیدمان و شکست سطر", color: "سرمه‌ای", size: "XL", priceRial: 99_999_999_995n, count: 1 },
  { barcode: makeEan13(1202), sku: "LM-1202", productName: "شال", color: null, size: null, priceRial: 3_500_000n, count: 1 },
  { barcode: null, sku: "LM-1203-LONG-SKU", productName: "کالای بی‌بارکد", color: "کرم", size: "M", priceRial: null, count: 1 },
];
const sizes = [...ROLL_PRESETS_MM, { width: ROLL_MIN_WIDTH_MM + 1, height: ROLL_MIN_HEIGHT_MM }, { width: 35, height: 22 }, { width: 120, height: 120 }];

for (const s of [...sizes.map((x) => ({ layout: "roll" as const, ...x })), { layout: "a4" as const, width: 70, height: 37 }]) {
  test(`label ${s.layout} ${s.width}x${s.height}: rows, price and quiet zone stay inside the inner box`, async ({ page }) => {
    await page.setContent(labelPage(items, { layout: s.layout, shopName: "لیبل مد", ...(s.layout === "roll" ? { rollMm: s } : {}) }));
    await page.emulateMedia({ media: "print" });
    const g = labelGeometry(s.layout, s.width, s.height);
    const problems = await page.$$eval(".label", (labels, nameLines) => {
      const out: string[] = [];
      labels.forEach((label, li) => {
        const cs = getComputedStyle(label);
        const r = label.getBoundingClientRect();
        const inner = { l: r.left + parseFloat(cs.paddingLeft), r: r.right - parseFloat(cs.paddingRight),
          t: r.top + parseFloat(cs.paddingTop), b: r.bottom - parseFloat(cs.paddingBottom) };
        const inside = (name: string, e: Element) => {
          const x = e.getBoundingClientRect(), eps = 0.5;
          if (x.left < inner.l - eps || x.right > inner.r + eps || x.top < inner.t - eps || x.bottom > inner.b + eps)
            out.push(`#${li} ${name} [${x.left.toFixed(2)},${x.right.toFixed(2)}]x[${x.top.toFixed(2)},${x.bottom.toFixed(2)}] outside [${inner.l.toFixed(2)},${inner.r.toFixed(2)}]x[${inner.t.toFixed(2)},${inner.b.toFixed(2)}]`);
        };
        for (const row of Array.from(label.children)) inside(row.className, row);
        const svg = label.querySelector("svg"); if (svg) inside("svg", svg);
        const price = label.querySelector<HTMLElement>(".price")!;
        if (price.scrollWidth > price.clientWidth + 1) out.push(`#${li} price clipped ${price.scrollWidth}>${price.clientWidth}`);
        const name = label.querySelector<HTMLElement>(".name")!;
        const lh = parseFloat(getComputedStyle(name).lineHeight);
        if (name.clientHeight < lh - 0.5) out.push(`#${li} name height ${name.clientHeight} < one line ${lh}`);
        if (Math.abs(name.clientHeight - nameLines * lh) > 1) out.push(`#${li} name ${name.clientHeight}px is not ${nameLines} complete lines of ${lh}px`);
      });
      return out;
    }, g.nameLines);
    expect(problems).toEqual([]);
  });
}
