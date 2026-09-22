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
 * **قیمت از کلاینت نمی‌آید — مگر از یک مسیر، و آن مسیر مجوزدار است.**
 * `scan`، `setLineQty` و `setLineDiscount` هیچ‌وقت قیمت نمی‌فرستند؛
 * صندوق فقط می‌گوید «این بارکد، این تعداد» و قیمت را سرور از
 * `catalog.price` می‌خواند. تنها استثنا `setLinePrice` است که پشت
 * `sale.price_override` و سقف «کاهش کل» نشسته و با PIN باز نمی‌شود.
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

export interface InvoiceGift {
  wrapCode: string | null;
  colorCode: string | null;
  flowerCode: string | null;
  note: string | null;
  hidePrices: boolean;
}

export interface Invoice {
  id: string;
  number: string | null;
  branchId: string;
  warehouseId: string;
  shiftId: string | null;
  customerId: string | null;
  /** گیرنده، وقتی خرید برای دیگری است. */
  recipientId: string | null;
  gift: InvoiceGift | null;
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

export interface ReturnReason {
  code: string;
  label: string;
}

/** یک سطر فاکتور، از دید «چقدرش هنوز قابل برگشت است». */
export interface ReturnableLine {
  invoiceLineId: string;
  variationId: string;
  soldQty: string;
  returnedQty: string;
  remainingQty: string;
  unitPrice: string;
  netAmount: string;
  returnedNetAmount?: string;
  taxAmount?: string;
  returnedTaxAmount?: string;
}

export interface Returnable {
  invoiceId: string;
  invoiceStatus: string;
  daysSinceSale: number;
  /**
   * مهلت مرجوعی به **ساعت** سنجیده می‌شود، نه روز.
   *
   * گرد کردن روز نمی‌تواند ۴۸ ساعت را بیان کند: با «۲ روز»، فاکتور
   * ۷۱ ساعته هم داخل مهلت شمرده می‌شد.
   */
  hoursSinceSale: number;
  /** دیرتر از مهلت — همچنان ممکن، ولی تأیید مدیر می‌خواهد. */
  late: boolean;
  lines: ReturnableLine[];
}

export interface SaleReturn {
  id: string;
  number: string | null;
  invoiceId: string;
  branchId: string;
  status: string;
  reasonCode: string;
  reasonNote: string | null;
  netAmount: string;
  taxAmount: string;
  refundAmount: string;
  refundMethod: string | null;
  receivableApplied: string;
  creditApplied: string;
  occurredAt: string;
}

export interface DailyReport {
  businessDate: string;
  salesAmount: string;
  receivedAmount: string;
  /** `null` یعنی اجازه دیدن سود نیست — نه اینکه سود صفر بوده. */
  profitAmount: string | null;
  invoiceCount: number;
  returnCount: number;
}

/** درآمدی که هنوز به دفتر نرفته — زنگ خطر داشبورد. */
export interface UnpostedRow {
  batchId: string;
  batchKind: string;
  branchId: string;
  channel: string;
  businessDate: string;
  invoiceCount: number;
  payableAmount: string;
  cogsAmount: string;
}

/**
 * آیا این دوره از داشبورد بسته می‌شود؟
 *
 * سه شرط، و هر سه دلیل مالی دارند — نه سلیقه UI:
 *
 * **فقط دوره کانال.** دوره شیفت با شمردن پول کشو بسته می‌شود؛
 * `sales.close_channel_day` هم فقط `kind = 'channel_day'` را می‌شناسد
 * و برای دوره شیفت خطا می‌دهد.
 *
 * **دوره امروز نه.** بستن دوره یعنی هر فاکتور بعدیِ همان روز و همان
 * کانال با «دوره ثبت این فاکتور قبلاً بسته شده است» رد می‌شود —
 * `sales.resolve_posting_batch` این را اجبار می‌کند. کار شبانه هم به
 * همین دلیل امروز را رد می‌کند. `today` باید از **سرور** بیاید
 * (`platform.business_date()`)، نه از ساعت مرورگر: تبلتی که ساعتش
 * عقب است، دوره امروز را «دیروز» می‌دید.
 *
 * **مجوز `period.close`.** که فقط یک راحتی است؛ دروازه سرور است.
 */
export function canClosePeriod(
  row: UnpostedRow,
  today: string,
  mayClose: boolean,
): boolean {
  return row.batchKind === "channel_day" && row.businessDate !== today && mayClose;
}

/**
 * چرا دکمه‌ای نیست — «هیچ» بدتر از یک جمله است.
 *
 * `undefined` یعنی دکمه هست و توضیحی لازم نیست.
 */
export function periodNote(
  row: UnpostedRow,
  today: string,
  mayClose: boolean,
): string | undefined {
  if (row.batchKind !== "channel_day") return "با بستن شیفت صندوق بسته می‌شود";
  if (row.businessDate === today) return "دوره امروز هنوز باز است";
  if (!mayClose) return "بستن دوره دسترسی حسابدار می‌خواهد";
  return undefined;
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
  branches: () => api.get<{ branches: Branch[]; allBranches: boolean }>("/branches"),

  paymentMethods: () => api.get<{ methods: PaymentMethod[] }>("/payment-methods"),

  /** `null` یعنی این کاربر در این شعبه شیفت باز ندارد. */
  openShifts: (branchId: string) =>
    api.get<Array<{ id: string; userName: string; openedAt: string }>>(`/shifts/open?branchId=${encodeURIComponent(branchId)}`),

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
   * فاکتور از روی **شماره رسید** — نقطه شروع هر مرجوعی.
   *
   * شماره در سطح شعبه یکتاست، نه سراسری، پس `branchId` اجباری است.
   */
  invoiceByNumber: (number: string, branchId: string) =>
    api.get<Invoice & { receivedAmount: string }>(
      `/invoices/lookup?number=${encodeURIComponent(number)}&branchId=${encodeURIComponent(branchId)}`,
    ),

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

  /**
   * تخفیف روی سطر موجود — بدون بازقیمت‌گذاری.
   *
   * سقف و مجوزش را سرور می‌سنجد، با **همان** دروازه‌ای که افزودن قلم
   * می‌سنجد. تخفیف بالای سقف نقش، ۴۰۳ یا ۴۲۸ می‌گیرد نه رد خاموش.
   */
  setLineDiscount: (
    invoiceId: string,
    lineId: string,
    input: { discountAmount: string; discountReason?: string },
    opts?: RequestOptions,
  ) => api.patch<Invoice>(`/invoices/${invoiceId}/lines/${lineId}/discount`, input, opts),

  /**
   * قیمت دستی روی سطر — «مثل دشت».
   *
   * تنها جایی در این فایل که قیمت به سرور می‌رود، و عمداً مسیر خودش
   * را دارد: مجوز `sale.price_override` جدا از سقف تخفیف سنجیده
   * می‌شود و با PIN هم باز نمی‌شود.
   *
   * فرستادن **قیمت فهرست** یعنی «برگرد به فهرست» — سرور خودش
   * Snapshot و دلیل را پاک می‌کند.
   */
  setLinePrice: (
    invoiceId: string,
    lineId: string,
    input: { unitPrice: string; priceOverrideReason?: string },
    opts?: RequestOptions,
  ) => api.patch<Invoice>(`/invoices/${invoiceId}/lines/${lineId}/price`, input, opts),

  /**
   * چسباندن مشتری به سبد — اختیاری.
   *
   * نرمال‌سازی شماره در **دیتابیس** انجام می‌شود، نه اینجا: دو تعریف
   * یعنی مشتری‌ای که یک بار آنلاین و یک بار حضوری خرید کند دو حساب
   * داشته باشد. اینجا فقط رقم فارسی به لاتین می‌شود، چون صفحه‌کلید
   * فارسی «۰۹۱۲…» می‌فرستد.
   */
  attachCustomer: (
    invoiceId: string,
    input: { mobile: string; fullName?: string },
    opts?: RequestOptions,
  ) => api.patch<Invoice>(`/invoices/${invoiceId}/customer`, input, opts),

  /**
   * گیرنده — «خرید برای دیگری».
   *
   * `mobile: null` یعنی گیرنده ندارد و ارجاع پاک می‌شود. شماره از
   * همان `normalize_mobile` دیتابیس می‌گذرد، پس گیرنده یک **مشتری
   * واقعی** می‌شود و اندازه‌هایش در پرونده خودش می‌نشیند.
   */
  setRecipient: (
    invoiceId: string,
    input: { mobile: string | null; fullName?: string },
  ) => api.patch<Invoice>(`/invoices/${invoiceId}/recipient`, input),

  giftOptions: () =>
    api.get<{
      options: Array<{ code: string; kind: string; label: string; price: string }>;
    }>("/gift-options"),

  /** بسته‌بندی هدیه. `isGift: false` سطر را پاک می‌کند. */
  setGift: (
    invoiceId: string,
    input: {
      isGift?: boolean;
      wrapCode?: string | null;
      colorCode?: string | null;
      flowerCode?: string | null;
      note?: string | null;
      hidePrices?: boolean;
    },
  ) => api.put<Invoice>(`/invoices/${invoiceId}/gift`, input),

  removeLine: (invoiceId: string, lineId: string, opts?: RequestOptions) =>
    api.del<Invoice>(`/invoices/${invoiceId}/lines/${lineId}`, opts),

  pay: (
    invoiceId: string,
    input: { methodCode: string; amount: string; refNo?: string; accountId?: string },
    opts?: RequestOptions,
  ) => api.post<PaymentResult>(`/invoices/${invoiceId}/payments`, input, opts),

  finalize: (invoiceId: string, opts?: RequestOptions) =>
    api.post<Invoice>(`/invoices/${invoiceId}/finalize`, {}, opts),

  /**
   * خلاصه یک روز کاری.
   *
   * `profitAmount` وقتی `null` است که کاربر `cost.view` نداشته باشد —
   * **نه صفر**. صفر یک ادعای مالی است؛ «اجازه دیدنش را نداری» ادعای
   * دیگری. یکی‌کردنشان یعنی صندوق‌دار فکر کند فروشگاه ضرر کرده.
   */
  dailyReport: (branchId: string, date?: string) =>
    api.get<DailyReport>(
      `/reports/daily?branchId=${encodeURIComponent(branchId)}` +
        (date === undefined ? "" : `&date=${encodeURIComponent(date)}`),
    ),

  /**
   * دوره‌هایی که درآمدشان هنوز به دفتر نرفته.
   *
   * پشت `cost.view` است، پس صندوق‌دار ۴۰۳ می‌گیرد — و داشبورد باید
   * آن را یک «خطا» نداند، بلکه فقط کارت را نشان ندهد.
   */
  unpostedRevenue: () => api.get<{ rows: UnpostedRow[] }>("/posting-batches/unposted"),

  /**
   * بستن دوره ثبت یک کانال در یک روز — سند فروش و بهای تمام‌شده.
   *
   * **موجودی را دست نمی‌زند.** کالا همان لحظه فروش از انبار خارج شده؛
   * آنچه اینجا بسته می‌شود فقط سند حسابداری است.
   *
   * `Idempotency-Key` نمی‌فرستد و نباید بفرستد: سرور کلید را از
   * (شعبه، کانال، تاریخ) می‌سازد و هدر کلاینت را عمداً نادیده
   * می‌گیرد. هویت این عملیات همان سه‌تایی است، نه هدری که مرورگر
   * تولید کرده.
   */
  closeChannelDay: (input: { branchId: string; channel: string; date: string }) =>
    api.post<{
      batchId: string;
      saleEntry: string | null;
      cogsEntry: string | null;
      replayed: boolean;
    }>("/posting-batches/close-channel-day", input),

  /** علت‌های مجاز مرجوعی با برچسب فارسی — از `platform.setting`. */
  returnReasons: () => api.get<{ reasons: ReturnReason[] }>("/return-reasons"),

  returnable: (invoiceId: string) =>
    api.get<Returnable>(`/invoices/${invoiceId}/returnable`),

  createReturn: (
    input: {
      invoiceId: string;
      reasonCode: string;
      reasonNote?: string;
      refundAmount: string;
      refundMethod?: string;
      shiftId?: string;
      lines: Array<{ invoiceLineId: string; qty: string; restock?: boolean }>;
    },
    opts?: RequestOptions,
  ) => api.post<SaleReturn>("/returns", input, opts),

  /**
   * مقصد کالای سالمِ برگشتی — قفسه یا آوتلت.
   *
   * فقط روی پیش‌نویس کار می‌کند: پس از ثبت، حرکت انبار ثبت شده و
   * تغییرناپذیر است. کالای **معیوب** فارغ از این انتخاب به انبار
   * معیوب می‌رود.
   */
  setReturnWarehouse: (returnId: string, warehouseId: string) =>
    api.put<SaleReturn>(`/returns/${returnId}/warehouse`, { warehouseId }),

  seasons: () =>
    api.get<{ seasons: Array<{ code: string; label: string; climate: string }> }>(
      "/seasons",
    ),

  /** ثبت — اینجاست که کالا برمی‌گردد و پول از کشو بیرون می‌رود. */
  postReturn: (returnId: string, opts?: RequestOptions) =>
    api.post<SaleReturn & { replayed: boolean }>(`/returns/${returnId}/post`, {}, opts),

  cancelReturn: (returnId: string) =>
    api.post<SaleReturn>(`/returns/${returnId}/cancel`, {}),

  cancel: (invoiceId: string, reason?: string) =>
    api.post<Invoice>(`/invoices/${invoiceId}/cancel`, reason === undefined ? {} : { reason }),
};
