/**
 * چاپ گروهی لیبل بارکد — منطق خالص (اندازه، سقف‌ها، فهرست چاپ).
 *
 * سقف‌ها همان سقف‌های `POST /labels` در `catalog-routes.ts` هستند؛ این‌جا
 * فقط برای بازخورد فوری‌اند و سرور دوباره می‌سنجد.
 */

import { normalizeDigits } from "./settings-value.ts";

export type LabelLayout = "roll" | "a4";

/** اندازه‌های رایج رول لیبل‌زن — همان `ROLL_PRESETS_MM` سمت سرور. */
export const LABEL_PRESETS: ReadonlyArray<{ id: string; width: number; height: number }> = [
  { id: "30x20", width: 30, height: 20 }, { id: "40x25", width: 40, height: 25 },
  { id: "40x30", width: 40, height: 30 }, { id: "50x25", width: 50, height: 25 },
  { id: "50x30", width: 50, height: 30 }, { id: "58x40", width: 58, height: 40 },
  { id: "60x40", width: 60, height: 40 },
];
export const DEFAULT_PRESET = "50x30";
export const MAX_PER_VARIANT = 100;
export const MAX_TOTAL = 500;
export const MAX_ITEMS = 200;
/**
 * همان `ROLL_MIN_WIDTH_MM` و `ROLL_MIN_HEIGHT_MM` سرور (`catalog/label.ts`)؛
 * کوچک‌تر، برچسب خوانا ساخته نمی‌شود و سرور هم ۴۲۲ می‌دهد.
 */
export const ROLL_LIMITS = { minWidth: 30, maxWidth: 120, minHeight: 20, maxHeight: 120 } as const;

/**
 * رول چندستونه — همان `RollRow` سرور (`apps/api/src/catalog/label.ts`). اندازهٔ هر
 * لیبل (`width`/`height`) جدا از کل ردیف است: صفحه = پهنای لاینر × ارتفاع لیبل.
 */
export interface LabelRow { columns: number; gapMm: number; mediaWidthMm: number; offsetXMm: number; startSlot: number }
export interface LabelSize { layout: LabelLayout; width: number; height: number; row?: LabelRow | undefined }

/**
 * همان مرزهای سرور: پهنای چاپ‌پذیر BIXOLON XD3-40t ۱۰۴mm (راهنما، بخش ۷-۱)
 * جدا از پهنای کاغذ ۱۵..۱۱۸mm. سرور دوباره می‌سنجد؛ این‌جا فقط بازخورد فوری است.
 */
export const ROW_LIMITS = { printableMax: 104, mediaMin: 15, mediaMax: 118, maxColumns: 4, maxGap: 20, maxOffset: 10 } as const;

/** لبهٔ چپ هر خانه از لبهٔ چپ کاغذ — همان `rollRowSlots` سرور. */
export function rowSlots(width: number, row: LabelRow): { spanMm: number; leftMm: number[] } {
  const spanMm = row.columns * width + (row.columns - 1) * row.gapMm;
  const start = (row.mediaWidthMm - spanMm) / 2 + row.offsetXMm;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { spanMm: r3(spanMm), leftMm: Array.from({ length: row.columns }, (_, i) => r3(start + i * (width + row.gapMm))) };
}

export interface QueueItem {
  variationId: string;
  productId: string;
  productName: string;
  sku: string;
  color: string | null;
  size: string | null;
  count: number;
  /**
   * قیمت و بارکد هنگام افزودن — فقط برای هشدار پیش از چاپ؛ مقدار روی لیبل را
   * سرور از دیتابیس می‌خواند. نبودن (فهرست ذخیره‌شدهٔ قدیمی) یعنی «نمی‌دانیم»، نه «دارد».
   */
  priced?: boolean;
  hasBarcode?: boolean;
}

/**
 * چاپ گروهی از فهرست کالا: هر تنوعِ **فعال** کالا با همان تعداد، به همان شکل فهرست
 * موجود (`mergeQueue` تکرار را جمع می‌کند، نه دوتا). تنوع بایگانی‌شده لیبل نمی‌گیرد.
 */
export function queueItemsForProduct(
  product: { id: string; name: string },
  variations: readonly { id: string; sku: string; color: string | null; size: string | null; status: string; price: string | null; barcode: string | null }[],
  count: number,
): QueueItem[] {
  const n = clampCount(count);
  if (n === 0) return [];
  return variations.filter((v) => v.status === "active").map((v) => ({
    variationId: v.id, productId: product.id, productName: product.name, sku: v.sku, color: v.color, size: v.size, count: n,
    priced: v.price !== null, hasBarcode: v.barcode !== null && v.barcode !== "",
  }));
}

/** شمارهٔ معتبر از ورودی کاربر (رقم فارسی را فراخوان پیش‌تر نرمال کرده). */
export function clampCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_PER_VARIANT, Math.floor(n));
}

/** افزودن به فهرست: همان تنوع جمع می‌شود (تا سقف هر تنوع)، ترتیب اولین افزودن می‌ماند. */
export function mergeQueue(current: readonly QueueItem[], adds: readonly QueueItem[]): QueueItem[] {
  const out = current.map((i) => ({ ...i }));
  for (const add of adds) {
    const count = clampCount(add.count);
    if (count === 0) continue;
    const existing = out.find((i) => i.variationId === add.variationId);
    if (existing) {
      existing.count = clampCount(existing.count + count);
      // قیمت/بارکد ممکن است میان دو افزودن تعیین یا برداشته شده باشد: فقط مقدار
      // صریح تازه جایگزین می‌شود، تا افزودنِ بی‌فراداده دانستهٔ قبلی را پاک نکند.
      if (add.priced !== undefined) existing.priced = add.priced;
      if (add.hasBarcode !== undefined) existing.hasBarcode = add.hasBarcode;
    } else out.push({ ...add, count });
  }
  return out;
}

/**
 * قیمت/بارکدِ تازهٔ کاتالوگ برای تنوع‌هایی که از قبل در فهرست‌اند — تعداد و
 * ترتیب دست نمی‌خورند و تنوعی به فهرست اضافه نمی‌شود. بی‌تغییر، همان آرایه
 * برمی‌گردد تا ذخیره و رندرِ بی‌دلیل رخ ندهد.
 */
export function syncQueueMeta(
  current: readonly QueueItem[],
  facts: readonly { variationId: string; priced: boolean; hasBarcode: boolean }[],
): readonly QueueItem[] {
  let changed = false;
  const next = current.map((i) => {
    const f = facts.find((x) => x.variationId === i.variationId);
    if (!f || (f.priced === i.priced && f.hasBarcode === i.hasBarcode)) return i;
    changed = true;
    return { ...i, priced: f.priced, hasBarcode: f.hasBarcode };
  });
  return changed ? next : current;
}

export function setQueueCount(current: readonly QueueItem[], variationId: string, count: number): QueueItem[] {
  const n = clampCount(count);
  return n === 0
    ? current.filter((i) => i.variationId !== variationId)
    : current.map((i) => (i.variationId === variationId ? { ...i, count: n } : i));
}

export function queueTotal(items: readonly { count: number }[]): number {
  return items.reduce((sum, i) => sum + i.count, 0);
}

/** دسته‌بندی برای نمایش: هر کالا با تنوع‌هایش، به ترتیب افزودن. */
export function groupByProduct(items: readonly QueueItem[]): Array<{ productId: string; productName: string; items: QueueItem[] }> {
  const groups: Array<{ productId: string; productName: string; items: QueueItem[] }> = [];
  for (const item of items) {
    const g = groups.find((x) => x.productId === item.productId);
    if (g) g.items.push(item);
    else groups.push({ productId: item.productId, productName: item.productName, items: [item] });
  }
  return groups;
}

/** عدد پیام با رقم فارسی — همان رقم‌های بقیهٔ صفحه، نه «30» وسط جملهٔ فارسی. */
const fa = (n: number) => n.toLocaleString("fa-IR");

/**
 * اندازهٔ نامعتبر رول — جدا از سنجش تعداد تا کنار خودِ میدان‌های اندازه دیده
 * شود، حتی پیش از انتخاب هر تنوعی. `null` یعنی معتبر.
 */
export function labelSizeProblem(size: LabelSize): string | null {
  const issues = labelSizeIssues(size);
  return issues.width ?? issues.height ?? issues.row;
}

/**
 * خطای هر بُعد جدا — تا فقط میدانِ واقعاً نامعتبر `aria-invalid` بگیرد و
 * صفحه‌خوان میدان درست را نادرست اعلام نکند.
 */
export function labelSizeIssues(size: LabelSize): { width: string | null; height: string | null; row: string | null } {
  if (size.layout !== "roll") return { width: null, height: null, row: null };
  const { minWidth, maxWidth, minHeight, maxHeight } = ROLL_LIMITS;
  return {
    row: size.row ? labelRowProblem(size.width, size.row) : null,
    width: size.width >= minWidth && size.width <= maxWidth ? null
      : `عرض لیبل باید بین ${fa(minWidth)} و ${fa(maxWidth)} میلی‌متر باشد؛ باریک‌تر از ${fa(minWidth)} میلی‌متر بارکد با حاشیهٔ سکوت و قیمت کامل جا نمی‌شوند.`,
    height: size.height >= minHeight && size.height <= maxHeight ? null
      : `ارتفاع لیبل باید بین ${fa(minHeight)} و ${fa(maxHeight)} میلی‌متر باشد؛ کوتاه‌تر از ${fa(minHeight)} میلی‌متر نام، قیمت و بارکد خوانا با هم جا نمی‌شوند.`,
  };
}

/**
 * عدد میلی‌متری از ورودی؛ خالی یعنی «وارد نشده» (`NaN`)، نه صفر. «−» یونیکد منفی است
 * و «,»/«،» این‌جا ممیز است نه جداکنندهٔ هزارگان (`normalizeDigits` آن را حذف می‌کرد و
 * «1,5» پانزده میلی‌متر می‌شد).
 */
export function parseMm(v: string): number {
  return v.trim() === "" ? Number.NaN : Number(normalizeDigits(v.replace(/[,،]/g, ".")).replace(/[−–]/g, "-"));
}

/** میدانی که خطای ردیف از آن است — تا فقط همان `aria-invalid` بگیرد. */
export type LabelRowField = "gap" | "media" | "offset" | "row";

/**
 * ردیف چندستونه — همان `rollRowProblem` سرور. عددی که وارد نشده (`NaN`) یعنی
 * «اندازه‌گیری نشده»، نه صفر: فاصله و پهنای لاینر پیش‌فرض ندارند.
 */
export function labelRowIssue(width: number, row: LabelRow): { field: LabelRowField; message: string } | null {
  const { printableMax, mediaMin, mediaMax, maxColumns, maxGap, maxOffset } = ROW_LIMITS;
  const at = (field: LabelRowField, message: string) => ({ field, message });
  if (!Number.isFinite(row.gapMm)) return at("gap", "فاصلهٔ افقی میان دو لیبل کنار هم را با خط‌کش اندازه بگیرید و وارد کنید؛ مقدار پیش‌فرض ندارد.");
  if (!Number.isFinite(row.mediaWidthMm)) return at("media", "پهنای کل کاغذ (لاینر) را با خط‌کش اندازه بگیرید و وارد کنید؛ مقدار پیش‌فرض ندارد.");
  if (!Number.isFinite(row.offsetXMm)) return at("offset", "جابه‌جایی افقی را به میلی‌متر وارد کنید (بی جابه‌جایی: ۰).");
  if (!Number.isFinite(width)) return at("row", "اندازهٔ ردیف نامعتبر است.");
  if (!Number.isInteger(row.columns) || row.columns < 1 || row.columns > maxColumns) return at("row", `تعداد ستون باید بین ${fa(1)} و ${fa(maxColumns)} باشد.`);
  if (!Number.isInteger(row.startSlot) || row.startSlot < 1 || row.startSlot > row.columns) return at("row", "خانهٔ شروع باید یکی از ستون‌های همین ردیف باشد.");
  if (row.gapMm < 0 || row.gapMm > maxGap) return at("gap", `فاصلهٔ میان لیبل‌ها باید بین ${fa(0)} و ${fa(maxGap)} میلی‌متر باشد.`);
  if (Math.abs(row.offsetXMm) > maxOffset) return at("offset", `جابه‌جایی افقی باید بین −${fa(maxOffset)} و ${fa(maxOffset)} میلی‌متر باشد.`);
  if (row.mediaWidthMm < mediaMin || row.mediaWidthMm > mediaMax) return at("media", `پهنای کاغذ (لاینر) باید بین ${fa(mediaMin)} و ${fa(mediaMax)} میلی‌متر باشد.`);
  const { spanMm, leftMm } = rowSlots(width, row);
  if (spanMm > printableMax + 1e-9) return at("gap", `کل ردیف لیبل‌ها ${fa(spanMm)} میلی‌متر است و از پهنای چاپ‌پذیر ${fa(printableMax)} میلی‌متر چاپگر بیشتر است.`);
  if (spanMm > row.mediaWidthMm + 1e-9) return at("media", `پهنای کاغذ از کل ردیف لیبل‌ها (${fa(spanMm)} میلی‌متر) کمتر است.`);
  if (leftMm[0]! < -1e-9 || leftMm[leftMm.length - 1]! + width > row.mediaWidthMm + 1e-9) return at("offset", "با این جابه‌جایی افقی بخشی از ردیف بیرون از کاغذ می‌افتد.");
  const margin = Math.max(0, (row.mediaWidthMm - printableMax) / 2);
  if (leftMm[0]! < margin - 1e-9 || leftMm[leftMm.length - 1]! + width > row.mediaWidthMm - margin + 1e-9)
    return at("offset", `با این جابه‌جایی بخشی از ردیف بیرون از پهنای چاپ‌پذیر ${fa(printableMax)} میلی‌متر (وسطِ کاغذ) می‌افتد و چاپ نمی‌شود.`);
  return null;
}

export function labelRowProblem(width: number, row: LabelRow): string | null {
  return labelRowIssue(width, row)?.message ?? null;
}

/** چرا این درخواست ارسال نمی‌شود — `null` یعنی معتبر. */
export function labelRequestProblem(items: readonly { count: number }[], size: LabelSize): string | null {
  const total = queueTotal(items);
  if (items.length === 0 || total === 0) return "هیچ لیبلی انتخاب نشده است.";
  if (items.length > MAX_ITEMS) return `حداکثر ${fa(MAX_ITEMS)} تنوع در هر نوبت چاپ.`;
  if (items.some((i) => !Number.isInteger(i.count) || i.count < 1 || i.count > MAX_PER_VARIANT))
    return `تعداد هر تنوع باید بین ۱ و ${fa(MAX_PER_VARIANT)} باشد.`;
  if (total > MAX_TOTAL) return `حداکثر ${fa(MAX_TOTAL)} لیبل در هر نوبت؛ اکنون ${fa(total)}.`;
  return labelSizeProblem(size);
}

/**
 * هشدار محتوا — مانع چاپ نیست، چون سرور برچسب بی‌قیمت («بدون قیمت») و
 * بی‌بارکد (فقط SKU) را عمداً می‌سازد. ولی لیبلی که قیمت یا بارکد ندارد
 * روی رگال به کار صندوق‌دار نمی‌آید، پس پیش از چاپ صریح گفته می‌شود.
 */
export function labelContentWarning(items: readonly { count: number; priced?: boolean; hasBarcode?: boolean }[]): string | null {
  const chosen = items.filter((i) => i.count > 0);
  const noPrice = chosen.filter((i) => i.priced === false);
  const noBarcode = chosen.filter((i) => i.hasBarcode === false);
  const parts: string[] = [];
  if (noPrice.length > 0)
    parts.push(`${fa(noPrice.length)} تنوع انتخاب‌شده قیمت ندارد و روی لیبلش «بدون قیمت» چاپ می‌شود`);
  if (noBarcode.length > 0)
    parts.push(`${fa(noBarcode.length)} تنوع بارکد ندارد و لیبلش فقط SKU دارد و اسکن نمی‌شود`);
  if (parts.length === 0) return null;
  // راه‌حل همان مشکلِ گفته‌شده: «قیمت تعیین کنید» تنوعِ بی‌بارکد را درست نمی‌کند.
  const fix = noPrice.length > 0 && noBarcode.length > 0 ? "قیمت را تعیین و بارکد را بررسی کنید"
    : noPrice.length > 0 ? "قیمت را تعیین کنید" : "بارکد آن تنوع را بررسی کنید";
  return `${parts.join("؛ ")}. پیش از چاپ ${fix} یا تعداد آن تنوع را صفر کنید.`;
}

/** بدنهٔ `POST /labels` — شکل همان قرارداد موجود. */
export function labelRequestBody(items: readonly { variationId: string; count: number }[], size: LabelSize) {
  return {
    items: items.filter((i) => i.count > 0).map((i) => ({ variationId: i.variationId, count: i.count })),
    layout: size.layout,
    ...(size.layout === "roll" ? { rollWidthMm: size.width, rollHeightMm: size.height } : {}),
    ...(size.layout === "roll" && size.row ? { rollRow: { ...size.row } } : {}),
  };
}

/** بدنهٔ `POST /labels/calibration` — فقط هندسه، بی کالا. `null` وقتی ردیفی نیست. */
export function labelCalibrationBody(size: LabelSize) {
  if (size.layout !== "roll" || !size.row) return null;
  return { rollWidthMm: size.width, rollHeightMm: size.height, rollRow: { ...size.row, startSlot: 1 } };
}
