import { test, expect } from "@playwright/test";

/*
 * سازندهٔ برچسب در `apps/api` است و ایمیج وب (Dockerfile) آن را ندارد؛
 * `tsc` بیلد وب هم e2e را می‌سنجد. پس ماژول با مسیر **رشته‌ای** و فقط در
 * زمان اجرا بار می‌شود (CI کل مخزن را دارد) و این‌جا فقط شکل لازم تعریف شده.
 */
interface LabelItem { barcode: string | null; sku: string; productName: string; brand?: string | null; color: string | null; size: string | null; priceRial: bigint | null; count: number }
interface LabelModule {
  labelPage(items: LabelItem[], opts: { layout: "roll" | "a4"; shopName: string; rollMm?: { width: number; height: number } }): string;
  labelGeometry(layout: "roll" | "a4", width: number, height: number): { nameLines: number };
  ROLL_PRESETS_MM: ReadonlyArray<{ width: number; height: number }>;
  ROLL_MIN_WIDTH_MM: number; ROLL_MIN_HEIGHT_MM: number;
}
const LABEL_MODULE = "../../api/src/catalog/label.ts";
const BARCODE_MODULE = "../../api/src/catalog/barcode.ts";
const load = async () => ({
  label: (await import(LABEL_MODULE)) as LabelModule,
  makeEan13: ((await import(BARCODE_MODULE)) as { makeEan13(serial: number): string }).makeEan13,
});

/** اندازه‌های آماده (همان `ROLL_PRESETS_MM` — آزمون اول برابری را می‌سنجد) + کمینه و بیشینه. */
const PRESETS = [[30, 20], [40, 25], [40, 30], [50, 25], [50, 30], [58, 40], [60, 40]].map(([width, height]) => ({ width: width!, height: height! }));

/**
 * هندسهٔ واقعی برچسب در موتور مرورگر — نه فقط حساب میلی‌متری.
 * هر ردیف و SVG بارکد باید داخل جعبهٔ داخلی برچسب (پس از padding) بماند،
 * قیمت افقی بریده نشود و نام فقط سطر کامل داشته باشد.
 */
const itemsFor = (makeEan13: (n: number) => string): LabelItem[] => [
  { barcode: makeEan13(1201), sku: "LM-1201", brand: "لیبل مد کلاسیک", productName: "شلوار پارچه‌ای رگولار با نام طولانی برای بررسی چیدمان و شکست سطر", color: "سرمه‌ای", size: "XL", priceRial: 99_999_999_995n, count: 1 },
  { barcode: makeEan13(1202), sku: "LM-1202", productName: "شال", color: null, size: null, priceRial: 3_500_000n, count: 1 },
  { barcode: null, sku: "LM-1203-LONG-SKU", productName: "کالای بی‌بارکد", color: "کرم", size: "M", priceRial: null, count: 1 },
];
const sizes = [...PRESETS, { width: 31, height: 20 }, { width: 35, height: 22 }, { width: 120, height: 120 }];

test("label geometry spec covers the server's presets and minimum size", async () => {
  const { label } = await load();
  expect(PRESETS).toEqual(label.ROLL_PRESETS_MM.map((p) => ({ width: p.width, height: p.height })));
  expect([label.ROLL_MIN_WIDTH_MM, label.ROLL_MIN_HEIGHT_MM]).toEqual([30, 20]);
});

for (const s of [...sizes.map((x) => ({ layout: "roll" as const, ...x })), { layout: "a4" as const, width: 70, height: 37 }]) {
  test(`label ${s.layout} ${s.width}x${s.height}: rows, price and quiet zone stay inside the inner box in reference order`, async ({ page }) => {
    const { label, makeEan13 } = await load();
    await page.setContent(label.labelPage(itemsFor(makeEan13), { layout: s.layout, shopName: "لیبل مد", ...(s.layout === "roll" ? { rollMm: s } : {}) }));
    await page.emulateMedia({ media: "print" });
    const g = label.labelGeometry(s.layout, s.width, s.height);
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
        const desc = label.querySelector<HTMLElement>(".desc")!;
        const lh = parseFloat(getComputedStyle(desc).lineHeight);
        if (Math.abs(desc.clientHeight - nameLines * lh) > 1) out.push(`#${li} desc ${desc.clientHeight}px is not ${nameLines} complete lines of ${lh}px`);
        const lines = Array.from(desc.querySelectorAll<HTMLElement>(".l"));
        if (lines.length !== nameLines) out.push(`#${li} desc has ${lines.length} lines, expected ${nameLines}`);
        for (const l of lines) if (l.getBoundingClientRect().height > lh + 0.5) out.push(`#${li} desc line wraps (${l.getBoundingClientRect().height}px)`);
        const order = ["shop", "code", "desc", "price"].map((c) => label.querySelector(`.${c}`)?.getBoundingClientRect().top ?? null).filter((t): t is number => t !== null);
        if (order.some((t, n) => n > 0 && t < order[n - 1]!)) out.push(`#${li} row order broken`);
      });
      return out;
    }, g.nameLines);
    expect(problems).toEqual([]);
  });
}
