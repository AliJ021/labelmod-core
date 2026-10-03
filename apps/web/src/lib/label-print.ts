/**
 * چاپ گروهی لیبل بارکد — منطق خالص (اندازه، سقف‌ها، فهرست چاپ).
 *
 * سقف‌ها همان سقف‌های `POST /labels` در `catalog-routes.ts` هستند؛ این‌جا
 * فقط برای بازخورد فوری‌اند و سرور دوباره می‌سنجد.
 */

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
export const ROLL_LIMITS = { minWidth: 20, maxWidth: 120, minHeight: 10, maxHeight: 120 } as const;

export interface LabelSize { layout: LabelLayout; width: number; height: number }

export interface QueueItem {
  variationId: string;
  productId: string;
  productName: string;
  sku: string;
  color: string | null;
  size: string | null;
  count: number;
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
    if (existing) existing.count = clampCount(existing.count + count);
    else out.push({ ...add, count });
  }
  return out;
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

/** چرا این درخواست ارسال نمی‌شود — `null` یعنی معتبر. */
export function labelRequestProblem(items: readonly { count: number }[], size: LabelSize): string | null {
  const total = queueTotal(items);
  if (items.length === 0 || total === 0) return "هیچ لیبلی انتخاب نشده است.";
  if (items.length > MAX_ITEMS) return `حداکثر ${MAX_ITEMS} تنوع در هر نوبت چاپ.`;
  if (items.some((i) => !Number.isInteger(i.count) || i.count < 1 || i.count > MAX_PER_VARIANT))
    return `تعداد هر تنوع باید بین ۱ و ${MAX_PER_VARIANT} باشد.`;
  if (total > MAX_TOTAL) return `حداکثر ${MAX_TOTAL} لیبل در هر نوبت؛ اکنون ${total}.`;
  if (size.layout === "roll") {
    const { minWidth, maxWidth, minHeight, maxHeight } = ROLL_LIMITS;
    if (!(size.width >= minWidth && size.width <= maxWidth)) return `عرض لیبل باید بین ${minWidth} و ${maxWidth} میلی‌متر باشد.`;
    if (!(size.height >= minHeight && size.height <= maxHeight)) return `ارتفاع لیبل باید بین ${minHeight} و ${maxHeight} میلی‌متر باشد.`;
  }
  return null;
}

/** بدنهٔ `POST /labels` — شکل همان قرارداد موجود. */
export function labelRequestBody(items: readonly { variationId: string; count: number }[], size: LabelSize) {
  return {
    items: items.filter((i) => i.count > 0).map((i) => ({ variationId: i.variationId, count: i.count })),
    layout: size.layout,
    ...(size.layout === "roll" ? { rollWidthMm: size.width, rollHeightMm: size.height } : {}),
  };
}

/** عرض کمتر از این، EAN-13 کامل را با ماژول ۰٫۲۵mm جا نمی‌دهد (سرور هشدار می‌دهد). */
export function scanRiskWidth(width: number): boolean {
  return width - 1 < 0.25 * 113;
}
