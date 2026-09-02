/**
 * لایه داده خرید — تایپ‌ها و تماس‌ها، بدون منطق UI.
 *
 * ── قاعده‌ای که اینجا وارونه است ────────────────────────────────────
 *
 * `lib/pos.ts` صریح می‌گوید «قیمت از کلاینت نمی‌آید». **در خرید
 * می‌آید و باید بیاید**: قیمت خرید تصمیم تأمین‌کننده است و هیچ‌جا در
 * دیتابیس ما نیست؛ انباردار آن را از روی فاکتور کاغذی وارد می‌کند.
 *
 * تفاوت را عمداً در دو فایل جدا نگه داشتیم تا کسی که `pos.ts` را
 * می‌خواند فکر نکند قاعده شکسته شده.
 *
 * ── آنچه تغییر نمی‌کند ──────────────────────────────────────────────
 *
 * **پول رشته است.** هر مبلغی که می‌آید یا می‌رود `string` است، نه
 * `number`. تبدیل فقط در `lib/money.ts` و فقط برای نمایش.
 *
 * **جمع‌ها از پاسخ سرور خوانده می‌شوند.** هر تماسی که رسید را عوض
 * می‌کند، **کل رسید** را برمی‌گرداند. دو تعریف از یک جمع، دیر یا زود
 * از هم جدا می‌افتند.
 */
import { api, type RequestOptions } from "./api.ts";

export interface Supplier {
  id: string;
  code: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  isActive: boolean;
}

export interface PayAccount {
  id: string;
  code: string;
  name: string;
  kind: string;
}

export interface ExpenseAccount {
  code: string;
  name: string;
}

export interface ReceiptLine {
  id: string;
  variationId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  color: string | null;
  size: string | null;
  qty: string;
  unitPrice: string;
  lineAmount: string;
  /** سهم این سطر از هزینه جانبی — پیش از ثبت صفر است. */
  chargeAlloc: string;
  /** بهای تمام‌شده هر واحد پس از تخصیص هزینه — پیش از ثبت صفر است. */
  landedUnitCost: string;
}

export interface ReceiptCharge {
  id: string;
  chargeType: string;
  amount: string;
  allocation: string;
  paidFrom: string;
  payeeType: string;
  payeeName: string | null;
  paidAccountId: string | null;
  paidAccountName: string | null;
  /** سرفصل هزینه دوره — فقط برای تخصیص «بدون تخصیص». */
  expenseAccountCode: string | null;
  expenseAccountName: string | null;
}

export interface Receipt {
  id: string;
  /** تا لحظه ثبت `null` — پیش‌نویس رهاشده شماره نمی‌سوزاند. */
  number: string | null;
  status: string;
  branchId: string;
  warehouseId: string;
  warehouseName: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string | null;
  occurredAt: string;
  postedAt: string | null;
  note: string | null;
  taxAmount: string;
  goodsAmount: string;
  chargesAmount: string;
  supplierPayable: string;
  thirdPartyPayable: string;
  lines: ReceiptLine[];
  charges: ReceiptCharge[];
}

export interface ReceiptSummary {
  id: string;
  number: string | null;
  status: string;
  supplierName: string;
  warehouseName: string;
  occurredAt: string;
  supplierInvoiceNo: string | null;
  lineCount: number;
  goodsAmount: string;
}

/** برچسب فارسی وضعیت — یک تعریف، نه یکی در هر کامپوننت. */
export const RECEIPT_STATUS: Record<string, string> = {
  draft: "پیش‌نویس",
  posted: "ثبت‌شده",
  cancelled: "باطل",
};

/** برچسب فارسی روش تخصیص هزینه. */
export const ALLOCATION_LABEL: Record<string, string> = {
  by_value: "به نسبت مبلغ",
  by_qty: "به نسبت تعداد",
  none: "بدون تخصیص",
};

export const purchasing = {
  suppliers: (q?: string) =>
    api.get<Supplier[]>(`/suppliers${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  createSupplier: (
    input: { code: string; name: string; mobile?: string; phone?: string },
    opts?: RequestOptions,
  ) => api.post<{ id: string; code: string; name: string; tafsiliNo: number }>(
    "/suppliers",
    input,
    opts,
  ),

  /**
   * حساب‌هایی که می‌شود هزینه رسید را از آن‌ها پرداخت کرد.
   *
   * صندوق فروشگاه در این فهرست نیست و نباید باشد: پول کشو فقط از
   * فروش و بازپرداخت حرکت می‌کند، وگرنه شمارش صندوق مغایرت کاذب
   * می‌دهد. دیتابیس هم ردش می‌کند.
   */
  payAccounts: () => api.get<PayAccount[]>("/purchasing/pay-accounts"),

  /**
   * سرفصل‌های هزینه دوره — برای هزینه‌ای که به بهای کالا نمی‌رود.
   *
   * تا مهاجرت ۰۲۶ گزینه «بدون تخصیص» وجود داشت ولی کار نمی‌کرد:
   * تمام مبلغ روی آخرین قلم می‌نشست. حالا سطر سند خودش را دارد و
   * سرفصلش انتخابی است.
   */
  expenseAccounts: () => api.get<ExpenseAccount[]>("/purchasing/expense-accounts"),

  receipts: (status?: string) =>
    api.get<ReceiptSummary[]>(`/receipts${status ? `?status=${status}` : ""}`),

  receipt: (id: string) => api.get<Receipt>(`/receipts/${id}`),

  createReceipt: (
    input: {
      branchId: string;
      warehouseId: string;
      supplierId: string;
      supplierInvoiceNo?: string;
      note?: string;
    },
    opts?: RequestOptions,
  ) => api.post<Receipt & { replayed: boolean }>("/receipts", input, opts),

  updateHead: (
    id: string,
    input: { taxAmount?: string; supplierInvoiceNo?: string | null; note?: string | null },
  ) => api.patch<Receipt>(`/receipts/${id}`, input),

  /**
   * افزودن قلم — با بارکد یا شناسه، همیشه همراه قیمت.
   *
   * کالای تکراری **با همان قیمت** روی یک سطر جمع می‌شود؛ با قیمت
   * متفاوت، سطر تازه. دو نرخ روی یک فاکتور تأمین‌کننده، دو سطر
   * واقعی‌اند.
   */
  addLine: (
    id: string,
    input: { barcode?: string; variationId?: string; qty: string; unitPrice: string },
    opts?: RequestOptions,
  ) => api.post<Receipt & { replayed: boolean }>(`/receipts/${id}/lines`, input, opts),

  /** تعداد و قیمت **مطلق** است، نه دلتا. */
  setLine: (
    id: string,
    lineId: string,
    input: { qty?: string; unitPrice?: string },
  ) => api.patch<Receipt>(`/receipts/${id}/lines/${lineId}`, input),

  removeLine: (id: string, lineId: string) =>
    api.del<Receipt>(`/receipts/${id}/lines/${lineId}`),

  addCharge: (
    id: string,
    input: {
      chargeType: string;
      amount: string;
      allocation: string;
      paidFrom: string;
      payeeType: string;
      payeeName?: string;
      paidAccountId?: string;
      expenseAccountCode?: string;
    },
    opts?: RequestOptions,
  ) => api.post<Receipt & { replayed: boolean }>(`/receipts/${id}/charges`, input, opts),

  removeCharge: (id: string, chargeId: string) =>
    api.del<Receipt>(`/receipts/${id}/charges/${chargeId}`),

  /** ثبت — کالا به انبار، سند به دفتر. Idempotent. */
  post: (id: string, opts?: RequestOptions) =>
    api.post<Receipt & { entryId: string; replayed: boolean }>(`/receipts/${id}/post`, {}, opts),

  cancel: (id: string) => api.post<Receipt>(`/receipts/${id}/cancel`),
};
