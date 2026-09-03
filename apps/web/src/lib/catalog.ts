/**
 * لایه داده کالا و قیمت — تایپ‌ها و تماس‌ها، بدون منطق UI.
 *
 * ── قاعده‌ای که اینجا هم وارونه است ─────────────────────────────────
 *
 * `lib/pos.ts` صریح می‌گوید «قیمت از کلاینت نمی‌آید». آن درباره
 * **فروش** است: صندوق‌دار قیمت را تعیین نمی‌کند. ولی قیمت فروش خودش
 * باید یک جا وارد شود، وگرنه هیچ‌وقت در دیتابیس نیست — و اینجا همان
 * جاست. مثل `lib/purchasing.ts`، عمداً در فایل جدا تا کسی که
 * `pos.ts` را می‌خواند فکر نکند قاعده شکسته شده.
 *
 * محافظ اینجا «از دیتابیس بخوان» نیست، سه چیز دیگر است:
 * مجوز `price.change` که فقط مدیر دارد، ممنوعیتش برای نشست بازشده با
 * PIN، و ردّ حسابرسی با مقدار پیش و پس.
 *
 * ── آنچه تغییر نمی‌کند ──────────────────────────────────────────────
 *
 * **پول رشته است.** هر مبلغی که می‌آید یا می‌رود `string` است، نه
 * `number`. تبدیل فقط در `lib/money.ts` و فقط برای نمایش.
 */
import { api, type RequestOptions } from "./api.ts";

export interface Product {
  id: string;
  code: string;
  nameInternal: string;
  nameWeb: string | null;
  brandId: string | null;
  brandName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  season: string | null;
  collection: string | null;
  fabric: string | null;
  fit: string | null;
  originCountry: string | null;
  taxRateCode: string;
  notes: string | null;
  status: string;
  variationCount: number;
  /**
   * چند تنوعِ این مدل قیمت دارند.
   *
   * تزئین نیست: تنوع بدون قیمت اصلاً فروخته نمی‌شود — `addLine` خطا
   * می‌دهد. پس این عدد همان چیزی است که می‌گوید کدام مدل هنوز آماده
   * فروش نیست.
   */
  pricedCount: number;
}

export interface Variation {
  id: string;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string | null;
  status: string;
  /** قیمت باز — ریال به‌صورت رشته، یا `null` وقتی هنوز قیمتی ثبت نشده. */
  price: string | null;
  priceKind: string | null;
  priceSince: string | null;
  /**
   * حرکت انبار یا سطر فاکتور دارد، پس رنگ و سایزش دیگر عوض نمی‌شود.
   * سرور هم همین را اجبار می‌کند؛ این پرچم فقط برای این است که کاربر
   * دکمه‌ای نبیند که سرور بعداً ردش می‌کند.
   */
  locked: boolean;
}

export interface PriceHistoryEntry {
  amount: string;
  kind: string;
  reason: string | null;
  validFrom: string;
  /** `null` یعنی قیمت جاری. */
  validTo: string | null;
  byUser: string | null;
}

export interface ProductInput {
  code?: string;
  nameInternal: string;
  nameWeb?: string;
  brandId?: string;
  categoryId?: string;
  season?: string;
  collection?: string;
  fabric?: string;
  fit?: string;
  originCountry?: string;
  notes?: string;
}

export type PriceKind = "regular" | "markdown" | "promo";

/**
 * فهرست رنگ یا سایز از یک ورودی متنی.
 *
 * ⚠️ ویرگول **فارسی** (`،` U+060C) هم جدا می‌کند، نه فقط لاتین.
 *    صفحه‌کلید فارسی همان را می‌زند و اگر فقط `,` را می‌شناختیم،
 *    «سبز، مشکی، سرمه‌ای» یک رنگ با نام سه‌تایی می‌شد — و بعد یک
 *    بارکد برای چیزی که سه کالاست.
 *
 * تکراری‌ها هم حذف می‌شوند: «مشکی، مشکی» دو تنوع نمی‌سازد (سرور هم
 * ردش می‌کند، ولی کاربر نباید عددِ غلط را در پیش‌نمای فرم ببیند).
 */
export function splitList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,،;؛\n]/)) {
    const t = part.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export const catalog = {
  products: (opts: { search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.search) q.set("search", opts.search);
    if (opts.status) q.set("status", opts.status);
    const qs = q.toString();
    return api.get<{ products: Product[] }>(`/products${qs ? `?${qs}` : ""}`);
  },

  product: (id: string) =>
    api.get<{ product: Product; variations: Variation[] }>(`/products/${id}`),

  refData: () =>
    api.get<{
      brands: Array<{ id: string; name: string }>;
      categories: Array<{ id: string; name: string; path: string }>;
    }>("/products/ref-data"),

  createProduct: (input: ProductInput & { code: string }, opts?: RequestOptions) =>
    api.post<{ id: string; replayed: boolean }>("/products", input, opts),

  updateProduct: (id: string, input: ProductInput) =>
    api.patch<{ ok: boolean }>(`/products/${id}`, input),

  setProductStatus: (id: string, status: "active" | "archived", reason?: string) =>
    api.patch<{ ok: boolean }>(`/products/${id}/status`, {
      status,
      ...(reason ? { reason } : {}),
    }),

  generateVariations: (
    productId: string,
    input: { colors: string[]; sizes: string[]; price?: string },
  ) =>
    api.post<{ createdCount: number; skippedCount: number }>(
      `/products/${productId}/variations/generate`,
      input,
    ),

  setVariationStatus: (
    id: string,
    status: "active" | "paused" | "preorder" | "archived",
  ) => api.patch<{ ok: boolean }>(`/variations/${id}/status`, { status }),

  amendVariation: (id: string, input: { color?: string; size?: string }) =>
    api.patch<{ ok: boolean }>(`/variations/${id}`, input),

  /** تغییر قیمت یک تنوع. `PUT` است چون عملیات مطلق و تکرارپذیر است. */
  setPrice: (
    variationId: string,
    input: { amount: string; kind?: PriceKind; reason?: string },
  ) => api.put<{ ok: boolean }>(`/variations/${variationId}/price`, input),

  /** قیمت‌گذاری گروهی — سرور همه را در یک تراکنش می‌زند. */
  setPriceBulk: (input: {
    variationIds: string[];
    amount: string;
    kind?: PriceKind;
    reason?: string;
  }) => api.put<{ updated: number }>("/prices", input),

  priceHistory: (variationId: string) =>
    api.get<{ history: PriceHistoryEntry[] }>(
      `/variations/${variationId}/price-history`,
    ),
};
