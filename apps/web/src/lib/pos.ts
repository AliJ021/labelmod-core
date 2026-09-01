/**
 * لایه داده صندوق — تایپ‌ها و تماس‌ها، بدون هیچ منطق UI.
 *
 * ── دو قاعده که این فایل نگهشان می‌دارد ────────────────────────────
 *
 * **پول رشته است.** هر مبلغی که از سرور می‌آید یا به سرور می‌رود
 * `string` است، نه `number`. مبالغ ریالی سریع از محدوده دقیق
 * `number` جاوااسکریپت رد می‌شوند و آن‌وقت جمع فاکتور بی‌صدا یکی دو
 * ریال با جمع سطرها فرق می‌کند. تبدیل فقط در `lib/money.ts` و فقط
 * برای **نمایش**.
 *
 * **قیمت از کلاینت نمی‌آید.** هیچ‌کدام از توابع اینجا `unitPrice`
 * نمی‌فرستند. صندوق فقط می‌گوید «این بارکد، این تعداد»؛ قیمت را
 * سرور از `catalog.price` می‌خواند. قیمت دستی مسیر مجوزدار خودش را
 * دارد و مرحله ۳ است.
 *
 * **جمع‌ها از پاسخ سرور خوانده می‌شوند، نه دوباره حساب.** هر تماسی که
 * سبد را عوض می‌کند، **کل فاکتور** را برمی‌گرداند. دو تعریف از یک
 * جمع، دیر یا زود از هم جدا می‌افتند.
 */
import { api, type RequestOptions } from "./api.ts";

// ── تایپ‌ها ─────────────────────────────────────────────────────────

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  /** `store` قفسه فروشگاه، `stock` انبار پشتیبان، `defective` معیوب. */
  kind: string;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  warehouses: Warehouse[];
}

export interface PaymentMethod {
  code: string;
  name: string;
  kind: string;
  /** فرم پرداخت با این می‌فهمد شماره پیگیری بخواهد یا نه. */
  requiresRef: boolean;
}

export interface Shift {
  id: string;
  branchId: string;
  userId: string;
  openedAt: string;
  openingCash: string;
  closedAt: string | null;
  countedCash: string | null;
  expectedCash: string | null;
  variance: string | null;
  status: string;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  variationId: string;
  sku: string;
  productName: string;
  qty: string;
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  discountReason: string | null;
  /** فقط وقتی مقدار دارد که قیمت دستی خورده باشد. */
  listPrice: string | null;
  priceOverrideReason: string | null;
}

export interface Invoice {
  id: string;
  number: string | null;
  branchId: string;
  warehouseId: string;
  shiftId: string | null;
  customerId: string | null;
  channel: string;
  status: string;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  taxAmount: string;
  shippingAmount: string;
  payableAmount: string;
  /** روی پیش‌نویس عمداً صفر است — این ستون را `finalize_invoice` می‌نویسد. */
  paidAmount: string;
  occurredAt: string;
  lines: InvoiceLine[];
}

export interface PaymentResult {
  paymentId: string;
  replayed: boolean;
  /**
   * جمع **همه** پرداخت‌های موفق این فاکتور، نه مبلغ همین پرداخت.
   *
   * از `sum()` سرور می‌آید. در Replay هم جمعِ لحظه پاسخ برمی‌گردد،
   * پس اگر بعدش پرداخت دیگری ثبت شده باشد عدد بزرگ‌تر است.
   */
  receivedAmount: string;
  invoice: Invoice;
}

export interface ScanResult {
  invoice: Invoice;
  /** درخواست تازه اجرا شد یا پاسخ قبلی برگشت. */
  replayed: boolean;
}

export interface CreatedInvoice extends Invoice {
  replayed?: boolean;
}

// ── تماس‌ها ─────────────────────────────────────────────────────────

/** فقط شعبه‌های مجاز همین کاربر، با انبارهای فعالشان. */
export const pos = {
  branches: () => api.get<{ branches: Branch[] }>("/branches"),

  paymentMethods: () => api.get<{ methods: PaymentMethod[] }>("/payment-methods"),

  /** `null` یعنی این کاربر در این شعبه شیفت باز ندارد. */
  currentShift: (branchId: string) =>
    api.get<Shift | null>(`/shifts/current?branchId=${encodeURIComponent(branchId)}`),

  openShift: (input: { branchId: string; openingCash: string }) =>
    api.post<Shift>("/shifts", input),

  closeShift: (
    shiftId: string,
    input: { countedCash: string; note?: string },
    opts?: RequestOptions,
  ) => api.post<Shift & { replayed: boolean }>(`/shifts/${shiftId}/close`, input, opts),

  createInvoice: (
    input: { branchId: string; warehouseId: string; channel?: string; customerId?: string },
    opts?: RequestOptions,
  ) => api.post<CreatedInvoice>("/invoices", input, opts),

  /**
   * یک فاکتور، **با** «چقدر تا حالا گرفته‌ایم».
   *
   * `receivedAmount` فقط از این مسیر می‌آید و لازم است چون
   * `paidAmount` روی پیش‌نویس عمداً صفر است. بدون آن، سبدی که پس از
   * Reload بازیابی می‌شود «دریافتی صفر» نشان می‌داد و همان مبلغ
   * دوباره از مشتری گرفته می‌شد.
   */
  invoice: (id: string) => api.get<Invoice & { receivedAmount: string }>(`/invoices/${id}`),

  /**
   * اسکن — کالای تکراری روی همان سطر شمرده می‌شود.
   *
   * `qty` رشته و عدد صحیح است: صندوق پوشاک کالای تعدادی می‌فروشد و
   * «۱٫۵ پیراهن» یک اشتباه تایپی است. دیتابیس اعشاری می‌پذیرد؛ این
   * محدودیت عمداً فقط اینجا و در Endpoint صندوق است.
   */
  scan: (
    invoiceId: string,
    input: { barcode?: string; variationId?: string; qty?: string },
    opts?: RequestOptions,
  ) => api.post<ScanResult>(`/invoices/${invoiceId}/scan`, input, opts),

  /** تعداد **مطلق** است نه دلتا — کلیک دوم روی «+» دو بار شمرده نمی‌شود. */
  setLineQty: (invoiceId: string, lineId: string, qty: string, opts?: RequestOptions) =>
    api.patch<Invoice>(`/invoices/${invoiceId}/lines/${lineId}`, { qty }, opts),

  removeLine: (invoiceId: string, lineId: string, opts?: RequestOptions) =>
    api.del<Invoice>(`/invoices/${invoiceId}/lines/${lineId}`, opts),

  pay: (
    invoiceId: string,
    input: { methodCode: string; amount: string; refNo?: string; accountId?: string },
    opts?: RequestOptions,
  ) => api.post<PaymentResult>(`/invoices/${invoiceId}/payments`, input, opts),

  finalize: (invoiceId: string, opts?: RequestOptions) =>
    api.post<Invoice>(`/invoices/${invoiceId}/finalize`, {}, opts),

  cancel: (invoiceId: string, reason?: string) =>
    api.post<Invoice>(`/invoices/${invoiceId}/cancel`, reason === undefined ? {} : { reason }),
};
