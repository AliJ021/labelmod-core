import { test, expect } from "@playwright/test";
import { labelRowProblem, ROW_LIMITS } from "../src/lib/label-print.ts";

/*
 * سازندهٔ برچسب در `apps/api` است و ایمیج وب (Dockerfile) آن را ندارد؛
 * `tsc` بیلد وب هم e2e را می‌سنجد. پس ماژول با مسیر **رشته‌ای** و فقط در
 * زمان اجرا بار می‌شود (CI کل مخزن را دارد) و این‌جا فقط شکل لازم تعریف شده.
 */
interface LabelItem { barcode: string | null; sku: string; productName: string; brand?: string | null; color: string | null; size: string | null; priceRial: bigint | null; count: number }
interface RollRow { columns: number; gapMm: number; mediaWidthMm: number; offsetXMm: number; startSlot: number }
interface LabelModule {
  labelPage(items: LabelItem[], opts: { layout: "roll" | "a4"; shopName: string; rollMm?: { width: number; height: number }; rollRow?: RollRow }): string;
  labelGeometry(layout: "roll" | "a4", width: number, height: number): { nameLines: number };
  ROLL_PRESETS_MM: ReadonlyArray<{ width: number; height: number }>;
  ROLL_MIN_WIDTH_MM: number; ROLL_MIN_HEIGHT_MM: number;
  rollRowProblem(widthMm: number, row: RollRow): string | null;
  ROLL_PRINTABLE_MAX_MM: number; ROLL_MEDIA_MIN_MM: number; ROLL_MEDIA_MAX_MM: number;
  ROLL_ROW_LIMITS: { maxColumns: number; maxGapMm: number; maxOffsetMm: number };
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


/*
 * رول دو‌ستونهٔ ۵۰×۳۰ (BIXOLON XD3-40t). فاصله و لاینر این‌جا نمونه‌اند، نه
 * اندازه‌گیری رول مالک. ادعا: هر خانه دقیقاً در میلی‌متر خودش از لبهٔ چپ کاغذ،
 * ستون ۱ چپ فیزیکی (مستقل از RTL)، تمام محتوای لیبل داخل خانهٔ خودش، و هر ردیف
 * یک صفحه به اندازهٔ کل ردیف. PDF فقط از Chromium ساخته می‌شود (Playwright).
 * این‌ها چاپ فیزیکی را ثابت نمی‌کنند؛ پذیرش فیزیکی با چاپ و اسکن مالک است.
 */
const ROW: RollRow = { columns: 2, gapMm: 3, mediaWidthMm: 106, offsetXMm: -0.5, startSlot: 1 };
const PX_PER_MM = 96 / 25.4;
for (const startSlot of [1, 2]) {
  test(`two-across 50x30 row (start ${startSlot}): slots at exact mm, content inside each slot, one page per row`, async ({ page, browserName }) => {
    const { label, makeEan13 } = await load();
    const items = [...itemsFor(makeEan13), { barcode: "12345678901234567", sku: "LM-LEGACY", productName: "کد قدیمی", color: null, size: null, priceRial: 1_000n, count: 2 }];
    const row = { ...ROW, startSlot };
    const html = label.labelPage(items, { layout: "roll", shopName: "Label Mod", rollMm: { width: 50, height: 30 }, rollRow: row });
    await page.setContent(html);
    await page.emulateMedia({ media: "print" });
    const m = await page.$$eval(".row", (rows, px) => rows.map((r) => {
      const rr = r.getBoundingClientRect();
      return { dir: getComputedStyle(r).direction, w: rr.width / px, h: rr.height / px, slots: Array.from(r.querySelectorAll<HTMLElement>(".slot")).map((s) => {
        const sr = s.getBoundingClientRect();
        const lab = s.querySelector(".label");
        const out: string[] = [];
        if (lab) for (const e of [lab, ...Array.from(lab.querySelectorAll("*"))]) {
          const x = e.getBoundingClientRect();
          if (x.width === 0 && x.height === 0) continue;
          if (x.left < sr.left - 0.5 || x.right > sr.right + 0.5 || x.top < sr.top - 0.5 || x.bottom > sr.bottom + 0.5) out.push(`${e.tagName}.${e.getAttribute("class")}`);
        }
        return { slot: Number(s.dataset.slot), left: (sr.left - rr.left) / px, w: sr.width / px, h: sr.height / px, filled: lab !== null,
          shop: s.querySelector(".shop")?.textContent ?? null, labelDir: lab ? getComputedStyle(lab).direction : null, out };
      }) };
    }), PX_PER_MM);
    const n = 3 + 2;
    expect(m.length).toBe(Math.ceil((n + startSlot - 1) / 2));
    for (const r of m) {
      expect(r.dir).toBe("ltr");
      expect(r.w).toBeCloseTo(106, 1); expect(r.h).toBeCloseTo(30, 1);
      expect(r.slots.map((s) => s.slot)).toEqual([1, 2]);
      expect(r.slots[0]!.left).toBeCloseTo(1, 1);
      expect(r.slots[1]!.left).toBeCloseTo(54, 1);
      for (const s of r.slots) {
        expect([s.w, s.h].map((v) => Math.round(v * 10) / 10)).toEqual([50, 30]);
        expect(s.out).toEqual([]);
        if (s.filled) { expect(s.labelDir).toBe("rtl"); expect(s.shop).toBe("Label Mod"); }
      }
    }
    expect(m.flatMap((r) => r.slots.filter((s) => s.filled)).length).toBe(n);
    expect(m[0]!.slots[0]!.filled).toBe(startSlot === 1);
    if (browserName === "chromium") {
      const pages = (pdf: Buffer) => {
        const t = pdf.toString("latin1");
        const boxes = [...t.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((b) => [Number(b[1]) / 72 * 25.4, Number(b[2]) / 72 * 25.4]);
        return { count: (t.match(/\/Type\s*\/Page(?!s)/g) ?? []).length, boxes };
      };
      const now = pages(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      expect(now.count).toBe(m.length);
      expect(now.boxes.length, "ابعاد هر صفحه خوانده شد، نه حلقهٔ خالی").toBe(now.count);
      for (const [w, h] of now.boxes) { expect(w!).toBeCloseTo(106, 0); expect(h!).toBeCloseTo(30, 0); }
      // کنترل منفی: رندرر قدیمی (بی rollRow) هر لیبل را یک صفحهٔ ۵۰×۳۰ می‌کند — همان که روی رول دو‌ستونه وسط فاصله می‌افتاد.
      await page.setContent(label.labelPage(items, { layout: "roll", shopName: "Label Mod", rollMm: { width: 50, height: 30 } }));
      const old = pages(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      expect(old.count).toBe(n);
      expect(old.boxes.length).toBe(n);
      for (const [w] of old.boxes) expect(w!).toBeCloseTo(50, 0);
    }
  });
}

test("web row validation mirrors the server: same limits and same accept/reject on a grid", async () => {
  const { label } = await load();
  expect(ROW_LIMITS).toEqual({ printableMax: label.ROLL_PRINTABLE_MAX_MM, mediaMin: label.ROLL_MEDIA_MIN_MM, mediaMax: label.ROLL_MEDIA_MAX_MM,
    maxColumns: label.ROLL_ROW_LIMITS.maxColumns, maxGap: label.ROLL_ROW_LIMITS.maxGapMm, maxOffset: label.ROLL_ROW_LIMITS.maxOffsetMm });
  const mismatches: string[] = [];
  for (const width of [30, 40, 50, 58]) for (const columns of [1, 2, 3]) for (const gapMm of [-1, 0, 2, 3, 4, 5, 21])
    for (const mediaWidthMm of [14, 60, 100, 103, 106, 110, 118, 119]) for (const offsetXMm of [-11, -7, -1.5, -0.5, 0, 1.5, 2, 11]) for (const startSlot of [1, 2, 4]) {
      const row = { columns, gapMm, mediaWidthMm, offsetXMm, startSlot };
      if ((label.rollRowProblem(width, row) === null) !== (labelRowProblem(width, row) === null)) mismatches.push(JSON.stringify({ width, ...row }));
    }
  expect(mismatches).toEqual([]);
});

/*
 * پروفایل اندازه‌گیری‌شدهٔ مالک (لیبل ۵۰×۳۰، لاینر ۱۰۵، فاصلهٔ افقی ۴): هر ردیف دقیقاً یک
 * صفحهٔ ۱۰۵×۳۰ است — ارتفاع سفید لیبل، نه ۳۵ (فاصلهٔ تکرار درایور) — برای ۱، ۲، ۳، ۵، ۲۰ و
 * ۵۰۰ لیبل و شروع از ستون ۲، بی صفحهٔ خالی. عنوان «Label Mod» درشت‌تر بیرون نمی‌زند.
 * PDF فقط در Chromium؛ هندسهٔ print-media در هر موتور.
 */
for (const [n, start] of [[1, 1], [2, 1], [3, 1], [5, 1], [20, 1], [500, 1], [3, 2]] as const) {
  test(`owner two-across 105/4: ${n} labels from column ${start} → one 105×30 page per row, no blank page, title fits`, async ({ page, browserName }) => {
    const { label, makeEan13 } = await load();
    const per = n === 500 ? 5 : 1;
    const items: LabelItem[] = Array.from({ length: n / per }, (_, i) => ({ barcode: makeEan13(3000 + i), sku: `LM-${i}`,
      productName: "شلوار پارچه‌ای رگولار با نام طولانی برای بررسی", color: "سرمه‌ای", size: "XL", priceRial: 99_999_999_995n, count: per }));
    const html = label.labelPage(items, { layout: "roll", shopName: "Label Mod", rollMm: { width: 50, height: 30 },
      rollRow: { columns: 2, gapMm: 4, mediaWidthMm: 105, offsetXMm: 0, startSlot: start } });
    await page.setContent(html);
    await page.emulateMedia({ media: "print" });
    const rows = Math.ceil((n + start - 1) / 2);
    const m = await page.evaluate(() => ({
      rows: document.querySelectorAll(".row").length, labels: document.querySelectorAll(".slot > .label").length,
      shopOverflow: Array.from(document.querySelectorAll<HTMLElement>(".shop")).filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).length,
      firstLeft: Array.from(document.querySelectorAll<HTMLElement>(".row:first-child .slot")).map((e) => e.style.left) }));
    expect(m).toEqual({ rows, labels: n, shopOverflow: 0, firstLeft: ["0.5mm", "54.5mm"] });
    if (browserName === "chromium") {
      const t = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString("latin1");
      const boxes = [...t.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((b) => [Number(b[1]) / 72 * 25.4, Number(b[2]) / 72 * 25.4]);
      expect((t.match(/\/Type\s*\/Page(?!s)/g) ?? []).length).toBe(rows);
      expect(boxes.length).toBe(rows);
      for (const [w, h] of boxes) { expect(w!).toBeCloseTo(105, 0); expect(h!).toBeCloseTo(30, 0); }
    }
  });
}
