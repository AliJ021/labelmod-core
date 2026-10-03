/**
 * انتخاب‌گر پرداخت صندوق — منطق خالص، بی React (test/pos-payments.test.ts).
 *
 * ── چیدمان، از نیاز مالک محصول (POS-05 تا POS-09) ──
 *
 *   ردیف ۱        کارت‌خوان، تمام‌عرض — ثبت دستی پرداختی که روی دستگاه تأیید شده؛
 *                 هیچ اتصال سخت‌افزار یا PSP وجود ندارد.
 *   ردیف ۲        اسنپ‌پی | دیجی‌پی — **همیشه** هر دو، هم‌وزن و هم‌ردیف.
 *   روش‌های بیشتر  نقدی · کارت‌به‌کارت · درگاه (ثبت دستی) · امتیاز · کارت هدیه
 *   جدا از روش‌ها  «ثبت نسیه» (CreditCheckout) — نسیه روش پرداخت نیست.
 *
 * ── اینکه چه چیزی **قابل انتخاب** است فقط از پاسخ سرور می‌آید ──
 *
 * جای هر خانه را کد تعیین می‌کند؛ قابل‌انتخاب‌بودن را نه. خانه‌ای که پشتوانهٔ
 * سرور ندارد دیده می‌شود ولی **ناموجود** است و دلیلش را می‌گوید — نه پنهان (نیاز
 * مالک از دست می‌رفت) و نه فعالِ جعلی (پرداخت ساختگی):
 *
 *   - اسنپ‌پی فقط وقتی قابل انتخاب است که سرور برای **همین شعبه** فرستاده باشد
 *     (`GET /payment-methods?branchId=`)؛ وگرنه «برای این شعبه تنظیم نشده».
 *   - دیجی‌پی در این مخزن **هیچ پشتوانه‌ای ندارد**: نه ردیف `payment_method`، نه
 *     حساب، نه قاعدهٔ ثبت، نه API. پس حتی اگر روزی ردیفی با کد `digipay` برسد،
 *     بی پیاده‌سازی قابل انتخاب نمی‌شود — هیچ مسیری از این خانه به ثبت پرداخت نیست.
 *   - کانال «لینک پرداخت» هیچ ارائه‌دهنده، ساخت لینک یا Callback در سرور ندارد؛
 *     دیده می‌شود و ناموجود است. فقط «حضوری» (همان ثبت دستی تأییدشده) کار می‌کند.
 *   - هر `kind` ناشناخته و `credit` هرگز روش پرداخت نمی‌شوند.
 */
import { ApiError } from "./api.ts";
import type { InvoiceSettlement, PaymentIntentStatus, PaymentMethod } from "./pos.ts";
import type { PendingPayment } from "./pending-payment.ts";

export type PaymentGroup = "primary" | "provider" | "more";

export interface PaymentOption {
  code: string;
  name: string;
  kind: string;
  requiresRef: boolean;
  group: PaymentGroup;
  /** فقط نقد باقی پول می‌دهد؛ بقیه حداکثر تا مانده. */
  allowsChange: boolean;
  /** `null` یعنی قابل انتخاب؛ متن یعنی چرا نه — همیشه دیده می‌شود. */
  unavailableReason: string | null;
}

export type ChannelKey = "in_person" | "link";

/** کانال پرداخت یک ارائه‌دهنده — «حضوری» یا «لینک پرداخت». */
export interface PaymentChannel {
  key: ChannelKey;
  label: string;
  /** `null` یعنی پشتوانهٔ سرور دارد؛ متن یعنی چرا نه. */
  unavailableReason: string | null;
}

/** خانهٔ ثابت ردیف دوم — همیشه دیده می‌شود، چه قابل انتخاب باشد چه نه. */
export interface ProviderSlot {
  key: "snappay" | "digipay";
  label: string;
  /** روشی که سرور فرستاده و قابل ثبت است؛ `null` یعنی هیچ مسیر ثبتی از این خانه نیست. */
  option: PaymentOption | null;
  unavailableReason: string | null;
  channels: PaymentChannel[];
}

export interface PaymentLayout {
  primary: PaymentOption[];
  providers: ProviderSlot[];
  more: PaymentOption[];
}

export const NEEDS_CUSTOMER_REASON = "ابتدا مشتری را به فاکتور وصل کنید.";
export const SNAPPAY_NOT_CONFIGURED = "اسنپ‌پی برای این شعبه تنظیم نشده است.";
export const DIGIPAY_NOT_IMPLEMENTED = "دیجی‌پی هنوز به سیستم وصل نشده است؛ پرداخت دیجی‌پی را اینجا نمی‌شود ثبت کرد.";
export const LINK_NOT_IMPLEMENTED = "ساخت لینک پرداخت هنوز در سرور پیاده نشده است؛ پرداخت را حضوری بگیرید.";

/** خانه‌هایی که بی پیاده‌سازی در سرور هرگز به روش قابل انتخاب تبدیل نمی‌شوند. */
const NOT_IMPLEMENTED = new Set(["digipay"]);

function placement(m: PaymentMethod): { group: PaymentGroup; rank: number } | null {
  const code = m.code.toLowerCase();
  if (NOT_IMPLEMENTED.has(code)) return null;
  if (code === "snappay") return { group: "provider", rank: 1 };
  switch (m.kind) {
    case "card_reader": return { group: "primary", rank: 1 };
    case "cash": return { group: "more", rank: 1 };
    case "transfer": return { group: "more", rank: 2 };
    case "gateway": return { group: "more", rank: 3 };
    case "points": return { group: "more", rank: 4 };
    case "gift_card": return { group: "more", rank: 5 };
    default: return null; // credit و هر نوع ناشناخته
  }
}

export function needsCustomer(kind: string): boolean {
  return kind === "points" || kind === "gift_card";
}

export function paymentLayout(methods: readonly PaymentMethod[], ctx: { hasCustomer: boolean }): PaymentLayout {
  const placed = methods.flatMap((m) => {
    const p = placement(m);
    if (!p) return [];
    const option: PaymentOption = {
      code: m.code, name: m.name, kind: m.kind, requiresRef: m.requiresRef, group: p.group,
      allowsChange: m.kind === "cash",
      unavailableReason: needsCustomer(m.kind) && !ctx.hasCustomer ? NEEDS_CUSTOMER_REASON : null,
    };
    return [{ option, rank: p.rank }];
  }).sort((a, b) => a.rank - b.rank || a.option.code.localeCompare(b.option.code));
  const of = (g: PaymentGroup) => placed.filter((p) => p.option.group === g).map((p) => p.option);
  const snappay = of("provider").find((o) => o.code.toLowerCase() === "snappay") ?? null;
  const link: PaymentChannel = { key: "link", label: "لینک پرداخت", unavailableReason: LINK_NOT_IMPLEMENTED };
  return {
    primary: of("primary"),
    providers: [
      { key: "snappay", label: "اسنپ‌پی", option: snappay, unavailableReason: snappay ? null : SNAPPAY_NOT_CONFIGURED,
        channels: [{ key: "in_person", label: "حضوری", unavailableReason: snappay ? null : SNAPPAY_NOT_CONFIGURED }, link] },
      { key: "digipay", label: "دیجی‌پی", option: null, unavailableReason: DIGIPAY_NOT_IMPLEMENTED,
        channels: [{ key: "in_person", label: "حضوری", unavailableReason: DIGIPAY_NOT_IMPLEMENTED }, link] },
    ],
    more: of("more"),
  };
}

/** همهٔ روش‌های **قابل ثبت** به ترتیب نمایش — خانهٔ ناموجود هیچ روشی ندارد. */
export function allOptions(layout: PaymentLayout): PaymentOption[] {
  return [...layout.primary, ...layout.providers.flatMap((p) => (p.option ? [p.option] : [])), ...layout.more];
}

/** کانالی که ثبت با آن ممکن است؛ فقط «حضوری»، و فقط وقتی خانه پشتوانه دارد. */
export function usableChannel(slot: ProviderSlot, key: ChannelKey): boolean {
  return slot.option !== null && slot.channels.some((c) => c.key === key && c.unavailableReason === null);
}

/**
 * سقف مبلغ یک روش: غیرنقدی تا مانده، نقد بی‌سقف (باقی پول). همان قاعدهٔ
 * سرور (`non_cash_overpayment`)؛ اینجا فقط برای اینکه صندوق‌دار پیش از کلیک بفهمد.
 */
export function maxAmount(option: Pick<PaymentOption, "allowsChange">, remaining: bigint): bigint | null {
  return option.allowsChange ? null : remaining > 0n ? remaining : 0n;
}

export type AmountCheck =
  | { ok: true; amount: bigint }
  | { ok: false; reason: "invalid" | "zero" | "over_max" | "nothing_due"; max?: bigint };

/** `amount === null` یعنی ورودی خالی ← همان مانده (رایج‌ترین حالت). */
export function checkAmount(option: Pick<PaymentOption, "allowsChange">, typed: bigint | null | "invalid", remaining: bigint): AmountCheck {
  if (typed === "invalid") return { ok: false, reason: "invalid" };
  const amount = typed ?? remaining;
  const max = maxAmount(option, remaining);
  if (max === 0n) return { ok: false, reason: "nothing_due" };
  if (amount <= 0n) return { ok: false, reason: "zero" };
  if (max !== null && amount > max) return { ok: false, reason: "over_max", max };
  return { ok: true, amount };
}

// ── پرداخت با نتیجهٔ نامعلوم (UI_PATTERNS §۵ بند ۷، F-115-01) ───────────

/**
 * یک «قصد پرداخت» — هویتش `key` است: همان `Idempotency-Key` ارسال و همان
 * `client_event_id` ردیف پرداخت در سرور. تا وضعیتش نهایی نشود، همین کلید و همین
 * بدنه است؛ کلید تازه فقط برای قصد تازه.
 */
export interface PaymentIntent {
  key: string;
  invoiceId: string;
  methodCode: string;
  methodName: string;
  amount: bigint;
  refNo: string;
}

/**
 * چرا قصد هنوز باز است:
 *   ambiguous       پاسخ قطعی نرسید (شبکه، ۵xx، Idempotency).
 *   not_found_yet   سرور ردیفی با این شناسه **هنوز** ندارد — ممکن است در راه باشد.
 *   retry_rejected  ارسال دوبارهٔ همان قصد رد شد؛ نسخهٔ اول هنوز نهایی نیست.
 *   mismatch        ردیف این شناسه با بدنهٔ قصد نمی‌خواند — سرپرست باید ببیند.
 */
export type UnresolvedReason = "ambiguous" | "not_found_yet" | "retry_rejected" | "mismatch";

export type PaymentPhase =
  | { kind: "idle" }
  | { kind: "submitting"; intent: PaymentIntent }
  | { kind: "unknown"; intent: PaymentIntent; reason: UnresolvedReason; detail?: string }
  | { kind: "checking"; intent: PaymentIntent };

/** آیا انتخاب روش و مبلغ قفل است؟ هر حالتی جز `idle`. */
export function paymentLocked(p: PaymentPhase): boolean {
  return p.kind !== "idle";
}

/**
 * پاسخ ناموفق: «رد قطعی» یا «نامعلوم»؟
 *
 * - ۴xx با پیام دامنه = سرور جواب داده و جواب «نه» است؛ اثری نمانده.
 * - قطع شبکه، ۵xx، ۴۰۸، و دو کد Idempotency = شاید نشسته باشد.
 *   `idempotency_key_reused` یعنی همین کلید پیش‌تر با درخواست دیگری
 *   رفته — خطای فنی خام نشان داده نمی‌شود؛ وضعیت بررسی می‌شود.
 */
export function paymentFailureKind(err: unknown): "rejected" | "unknown" {
  if (err instanceof ApiError) {
    if (err.code === "idempotency_in_flight" || err.code === "idempotency_key_reused") return "unknown";
    if (err.status === 408) return "unknown";
    return err.status < 500 ? "rejected" : "unknown";
  }
  return "unknown";
}

export type IntentVerdict = "recorded" | "not_recorded_final" | "unresolved" | "mismatch";

/**
 * حکم «بررسی وضعیت» — فقط از پاسخ سرور دربارهٔ **همین شناسه**.
 *
 * جمع دریافتی فاکتور هیچ نقشی ندارد: پرداخت دیگری با همان مبلغ (تب دیگر، دستگاه
 * دیگر، یا همین صندوق) آن را دقیقاً به اندازهٔ این قصد بالا می‌برد و «ثبت شد»
 * جعلی می‌ساخت. و «پیدا نشد» فقط «هنوز پیدا نشد» است — تراکنشِ در راه دیده
 * نمی‌شود — پس قصد باز می‌ماند تا سرور حالت **نهایی** بدهد:
 *   recorded              ردیف همین شناسه، با همین روش و مبلغ و پیگیری.
 *   not_recorded_final    شناسه مهر شده، مال درخواست دیگری است، یا فاکتور دیگر
 *                         پیش‌نویس نیست — این قصد هرگز ثبت نمی‌شود.
 *   unresolved            هنوز پیدا نشد؛ فقط همان قصد با همان کلید.
 *   mismatch              ردیف هست ولی بدنه‌اش این قصد نیست.
 */
export function resolveIntentStatus(intent: Pick<PaymentIntent, "methodCode" | "amount" | "refNo">, status: PaymentIntentStatus): IntentVerdict {
  switch (status.state) {
    case "recorded": {
      const p = status.payment;
      return p.methodCode === intent.methodCode && BigInt(p.amount) === intent.amount && (p.refNo ?? "") === intent.refNo
        && p.status === "succeeded" ? "recorded" : "mismatch";
    }
    case "abandoned": case "key_conflict": case "invoice_closed": return "not_recorded_final";
    case "not_found": return "unresolved";
  }
}

/** شکل پایدار قصد (`pending-payment.ts`) — مبلغ رشتهٔ ریالی، هرگز `number`. */
export function intentToPending(intent: PaymentIntent, ctx: { actorId: string; shiftId: string }, state: PendingPayment["state"]): PendingPayment {
  return { actorId: ctx.actorId, invoiceId: intent.invoiceId, shiftId: ctx.shiftId, key: intent.key,
    methodCode: intent.methodCode, methodName: intent.methodName, amount: intent.amount.toString(), refNo: intent.refNo, state };
}

export function intentFromPending(p: PendingPayment): PaymentIntent {
  return { key: p.key, invoiceId: p.invoiceId, methodCode: p.methodCode, methodName: p.methodName, amount: BigInt(p.amount), refNo: p.refNo };
}

/** بدنهٔ ارسال — یک تعریف، تا تکرار همان قصد دقیقاً همان بدنه را ببرد. */
export function paymentBody(intent: PaymentIntent): { methodCode: string; amount: string; refNo?: string } {
  return { methodCode: intent.methodCode, amount: intent.amount.toString(), ...(intent.refNo === "" ? {} : { refNo: intent.refNo }) };
}

// ── «ثبت شد» از تسویهٔ قطعی سرور (F-115-02) ────────────────────────────

export interface FinalAmounts { payable: bigint; paid: bigint; received: bigint; change: bigint; credit: bigint }

/**
 * مبلغ‌های صفحهٔ «ثبت شد» — فقط از `settlement` سرور، نه از تصویر کلاینت پیش از
 * نهایی‌سازی. نبودنش (`null` یا نیامدن) خطاست، نه صفر: صفحه حدس نمی‌زند.
 */
export function finalAmounts(settlement: InvoiceSettlement | null | undefined): FinalAmounts | null {
  if (!settlement) return null;
  return { payable: BigInt(settlement.payableAmount), paid: BigInt(settlement.paidAmount),
    received: BigInt(settlement.receivedAmount), change: BigInt(settlement.changeAmount), credit: BigInt(settlement.dueAmount) };
}

// ── جمع‌ها ──────────────────────────────────────────────────────────

export interface CheckoutTotals {
  gross: bigint;
  discount: bigint;
  tax: bigint;
  shipping: bigint;
  payable: bigint;
  received: bigint;
  remaining: bigint;
  change: bigint;
}

/** همه از پاسخ سرور؛ اینجا فقط مانده و باقی پول با bigint. */
export function checkoutTotals(inv: { grossAmount: string; discountAmount: string; taxAmount: string; shippingAmount: string; payableAmount: string } | null, received: bigint): CheckoutTotals {
  const n = (v: string | undefined) => (v === undefined ? 0n : BigInt(v));
  const payable = inv ? n(inv.payableAmount) : 0n;
  const left = payable - received;
  return {
    gross: inv ? n(inv.grossAmount) : 0n,
    discount: inv ? n(inv.discountAmount) : 0n,
    tax: inv ? n(inv.taxAmount) : 0n,
    shipping: inv ? n(inv.shippingAmount) : 0n,
    payable,
    received,
    remaining: left > 0n ? left : 0n,
    change: left < 0n ? -left : 0n,
  };
}

/** «۴ ردیف · ۸ عدد» — تعداد ردیف و جمع تعداد دو چیز جدایند. */
export function cartCounts(lines: readonly { qty: string }[]): { lines: number; units: number } {
  return { lines: lines.length, units: lines.reduce((n, l) => n + Number(l.qty), 0) };
}

/** پیام فارسیِ قابل اقدام برای خطاهای مهم صندوق؛ بقیه همان پیام سرور. */
export function checkoutErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "credit_needs_customer": return "برای فروش نسیه ابتدا مشتری را انتخاب کنید.";
      case "insufficient_stock": return `موجودی تغییر کرده است — ${err.message}`;
      case "non_cash_overpayment": return "مبلغ از مانده فاکتور بیشتر است. حداکثر مبلغ برای این روش، همان مانده است؛ مبلغ اضافه را فقط نقد می‌شود گرفت.";
      case "snappay_not_configured": return "اسنپ‌پی برای این شعبه تنظیم نیست؛ روش دیگری انتخاب کنید.";
      case "credit_not_a_payment": return "نسیه روش پرداخت نیست؛ مشتری را وصل کنید و «ثبت نسیه» را بزنید.";
      case "idempotency_key_reused":
      case "idempotency_in_flight": return "نتیجهٔ درخواست قبلی هنوز روشن نیست؛ «بررسی وضعیت» را بزنید.";
      default: return err.message;
    }
  }
  return "ارتباط با سرور برقرار نشد.";
}
