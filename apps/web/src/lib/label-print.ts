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
/**
 * همان `ROLL_MIN_WIDTH_MM` و `ROLL_MIN_HEIGHT_MM` سرور (`catalog/label.ts`)؛
 * کوچک‌تر، برچسب خوانا ساخته نمی‌شود و سرور هم ۴۲۲ می‌دهد.
 */
export const ROLL_LIMITS = { minWidth: 30, maxWidth: 120, minHeight: 20, maxHeight: 120 } as const;

export interface LabelSize { layout: LabelLayout; width: number; height: number }

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
  if (size.layout !== "roll") return null;
  const { minWidth, maxWidth, minHeight, maxHeight } = ROLL_LIMITS;
  if (!(size.width >= minWidth && size.width <= maxWidth))
    return `عرض لیبل باید بین ${fa(minWidth)} و ${fa(maxWidth)} میلی‌متر باشد؛ باریک‌تر از ${fa(minWidth)} میلی‌متر بارکد با حاشیهٔ سکوت و قیمت کامل جا نمی‌شوند.`;
  if (!(size.height >= minHeight && size.height <= maxHeight))
    return `ارتفاع لیبل باید بین ${fa(minHeight)} و ${fa(maxHeight)} میلی‌متر باشد؛ کوتاه‌تر از ${fa(minHeight)} میلی‌متر نام، قیمت و بارکد خوانا با هم جا نمی‌شوند.`;
  return null;
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
  return parts.length === 0 ? null : `${parts.join("؛ ")}. پیش از چاپ قیمت را تعیین کنید یا تعداد آن تنوع را صفر کنید.`;
}

/** بدنهٔ `POST /labels` — شکل همان قرارداد موجود. */
export function labelRequestBody(items: readonly { variationId: string; count: number }[], size: LabelSize) {
  return {
    items: items.filter((i) => i.count > 0).map((i) => ({ variationId: i.variationId, count: i.count })),
    layout: size.layout,
    ...(size.layout === "roll" ? { rollWidthMm: size.width, rollHeightMm: size.height } : {}),
  };
}
