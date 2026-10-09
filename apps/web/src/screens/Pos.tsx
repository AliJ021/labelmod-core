import { useUrlState, navigate } from "../lib/use-url-state.ts";
import { readPendingScan, writePendingScan, clearPendingScan, type PendingScan } from "../lib/pending-scan.ts";
/**
 * صندوق فروشگاهی — ناحیه مات.
 *
 * ADR-002 اینجا را «حداقلی» گذاشته و سه دلیل فنی داشت:
 *
 * ۱. **تضاد زیر نور فروشگاه.** صندوق‌دار زیر مهتابی و گاهی آفتابِ کنار
 *    ویترین کار می‌کند و باید عدد قیمت را در کسری از ثانیه بخواند.
 * ۲. **هزینه رندر.** `backdrop-filter` روی تبلت ارزان یعنی افت فریم در
 *    اسکرول سبد و تأخیر در اسکن پشت‌سرهم. صندوق کند، صف می‌سازد.
 * ۳. **راهنمای خود اپل.** شیشه به لایه کنترلی تعلق دارد، نه به محتوا.
 *
 * پس اینجا **فقط نوار بالا** شیشه‌ای است. سبد، جمع، دکمه‌ها و همه
 * اعداد `solid`اند. این تصمیم را با «زیباتر می‌شود» عوض نکنید — بودجه
 * افزودن قلم به سبد **زیر ۱۰۰ میلی‌ثانیه** است و هر افکتی که بشکندش
 * حذف می‌شود.
 *
 * ── قواعدی که این صفحه نمی‌تواند دورشان بزند ──────────────────────
 *
 * **هیچ عددی اینجا حساب نمی‌شود.** جمع سطر، جمع فاکتور و قابل پرداخت
 * همه از پاسخ سرور می‌آیند و در SQL ساخته شده‌اند. تنها چیزی که این
 * صفحه حساب می‌کند «مانده» و «باقی پول» است — و آن هم در `lib/cart.ts`
 * با `bigint` و تست.
 *
 * **قیمت هرگز فرستاده نمی‌شود.** صندوق فقط بارکد و تعداد می‌دهد.
 *
 * **هر عمل کاربر یک کلید Idempotency دارد** که روی Retry ثابت می‌ماند
 * و برای عمل بعدی تازه می‌شود — `lib/action-key.ts`.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraScan } from "../components/CameraScan.tsx";
import { PosProductPicker } from "../components/PosProductPicker.tsx";
import { PaymentBreakdown } from "../components/PaymentBreakdown.tsx";
import { Solid } from "../components/Glass.tsx";
import { Icon } from "../components/Icon.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, ScanCounter } from "../lib/action-key.ts";
import { canFinalize, lineGross, steppedQty } from "../lib/cart.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { Money } from "../components/ui/Money.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { PaymentSelector } from "../components/pos/PaymentSelector.tsx";
import { CheckoutSummary } from "../components/pos/CheckoutSummary.tsx";
import { CustomerSummary } from "../components/pos/CustomerSummary.tsx";
import { CreditCheckout } from "../components/pos/CreditCheckout.tsx";
import { SaleComplete, type CompletedSale } from "../components/pos/SaleComplete.tsx";
import { cartCounts, checkoutErrorMessage, checkoutTotals, finalAmounts, intentFromPending, intentToPending, paymentBody,
  paymentFailureKind, paymentLayout, resolveIntentStatus, type PaymentIntent, type PaymentOption, type PaymentPhase,
  type UnresolvedReason } from "../lib/pos-payments.ts";
import { clearPendingPayment, readPendingPayment, writePendingPayment, type PendingPayment } from "../lib/pending-payment.ts";
import { formatCount } from "../lib/format.ts";
import { session } from "../lib/session.ts";
import { people } from "../lib/people.ts";
import { isNetworkFailure } from "../lib/offline-queue.ts";
import { forgetCart, readCart, rememberCart } from "../lib/open-cart.ts";
import { pendingLabel, saleQueue, summarize, type PendingSummary } from "../lib/sale-queue.ts";
import { pos, type Branch, type Invoice, type InvoiceCustomer, type PaymentIntentStatus, type InvoiceLine, type PaymentMethod, type DraftPayment, type Shift } from "../lib/pos.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { ScanBuffer } from "../lib/scanner.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

/**
 * سطری که دیگر تعدادش از مسیر «+/−» عوض نمی‌شود.
 *
 * همان شرطی که `sales.set_line_qty` و `InvoiceService.setLineQty`
 * دارند. اینجا تکرار شده تا کاربر **پیش از** کلیک بفهمد؛ دروازه
 * همچنان سرور است.
 */
function adjusted(line: { discountAmount: string; listPrice: string | null }): boolean {
  return line.listPrice !== null || parseRial(line.discountAmount) > 0n;
}

/**
 * یک سطر سبد — کامپوننت جدا و **memo**شده.
 *
 * ── چرا جدا شد (FND-016) ────────────────────────────────────────────
 *
 * بودجهٔ مصوب ADR-002: «افزودن قلم به سبد زیر ۱۰۰ میلی‌ثانیه روی
 * ضعیف‌ترین دستگاه هدف. هر افکتی که این را بشکند، حذف می‌شود — بدون
 * بحث.» اندازه‌گیری در مرورگر واقعی نشان داد از ۵۰ قلم شکسته می‌شود و
 * هزینه **کارِ جاوااسکریپت کلاینت** است، نه شبکه و نه نوشتن DOM:
 * React سطرهای قبلی را دوباره Render می‌کرد حتی وقتی خروجی‌شان عوض
 * نشده بود.
 *
 * ── و چرا مقایسه‌کنندهٔ دستی، نه memo پیش‌فرض ────────────────────────
 *
 * ⚠️ `setInvoice(out.invoice)` کل فاکتور را از **پاسخ سرور** می‌نشاند،
 *    پس هر سطر یک شیء **تازه** است و مقایسهٔ سطحیِ پیش‌فرض همیشه
 *    «عوض شده» می‌گفت. یعنی `memo` بی مقایسه‌کنندهٔ خودش هیچ اثری
 *    نداشت — یک بهینه‌سازی که به‌نظر انجام شده و نشده.
 *
 *    پس مقایسه روی همان میدان‌هایی است که این سطر واقعاً می‌کشد.
 *    میدان تازه‌ای که به نمایش اضافه شود، باید اینجا هم اضافه شود —
 *    وگرنه سطر به‌روز نمی‌شود. به همین دلیل فهرست صریح است، نه
 *    `JSON.stringify`.
 */
export interface RowActions {
  changeQty: (lineId: string, current: string, delta: number) => void;
  remove: (lineId: string) => void;
  applyPrice: (lineId: string, priceRial: bigint, why: string) => void;
  applyDiscount: (lineId: string, amountRial: bigint, why: string) => void;
  openPrice: (lineId: string) => void;
  openDiscount: (lineId: string) => void;
  closePanels: () => void;
}

function sameLine(a: Readonly<CartLineProps>, b: Readonly<CartLineProps>): boolean {
  if (a.panel !== b.panel || a.on !== b.on || a.error !== b.error) return false;
  const x = a.line;
  const y = b.line;
  return (
    x.id === y.id &&
    x.productName === y.productName &&
    x.sku === y.sku &&
    x.qty === y.qty &&
    x.unitPrice === y.unitPrice &&
    x.listPrice === y.listPrice &&
    x.discountAmount === y.discountAmount &&
    x.netAmount === y.netAmount
  );
}

interface CartLineProps {
  line: InvoiceLine;
  error?: string | undefined;
  /** پنل بازِ همین سطر — یا هیچ. */
  panel: "price" | "discount" | null;
  /** دیسپچر **پایدار**؛ اگر هر Render تازه ساخته شود، memo بی‌اثر است. */
  on: RowActions;
}

const CartLine = memo(function CartLine({ line: l, panel, on, error }: CartLineProps) {
  const locked = adjusted(l);
  return (
    <li>
      <div className="line-name">
        <strong>{l.productName}</strong>
        <span className="muted small">
          {l.sku}
          {/*
            قیمت فهرست فقط وقتی نوشته می‌شود که سطر واقعاً دستکاری شده
            باشد. صندوق‌دار باید ببیند از چه عددی پایین آمده — وگرنه
            تایپ اشتباه تا لحظه پرداخت پیدا نمی‌شود.

            این **دو قیمت روی فاکتور** نیست: فاکتور چاپی همان یک عدد را
            دارد و این فقط روی صفحه سبد است.
          */}
          {l.listPrice === null ? null : (
            <>
              {" · "}
              <Money rial={l.unitPrice} size="sm" unit={false} />
              {" به‌جای "}
              <Money rial={l.listPrice} size="sm" />
            </>
          )}
        </span>
        <span className="muted small">هر عدد <Money rial={l.unitPrice} size="sm" /></span>
      </div>
      {/*
        سطری که تخفیف خورده یا قیمتش دستی عوض شده، تعدادش از این مسیر
        عوض نمی‌شود — و این تصمیم سرور است، نه سلیقه صفحه: تخفیف یک
        **مبلغ مطلق** برای تعدادِ آن لحظه است و با تغییر تعداد یا درصد
        کاهش بی‌صدا عوض می‌شود یا مبلغ ثبت‌شده.

        دکمه‌ها غیرفعال‌اند نه پنهان: صندوق‌دار باید بفهمد چرا، نه اینکه
        دکمه ناپدید شود. بدون این، کلیک روی «+» فقط یک خطای سرور می‌داد
        که همان حرف را دیرتر می‌زد.

        ⚠️ `disabled={busy}` اینجا **نیست**: `fieldset[disabled]` بالادست
           همین کار را بومی می‌کند و وابستگی سطر به `busy` را قطع
           می‌کند — همان چیزی که memo را واقعی کرد (FND-016).
      */}
      <div className="qty">
        <button
          type="button"
          onClick={() => on.changeQty(l.id, l.qty, -1)}
          aria-label={`کم کردن ${l.productName}`}
          disabled={locked}
          title={locked ? QTY_LOCKED : undefined}
        >
          −
        </button>
        {/* بی aria-live: اعلام زندهٔ هر سطر صفحه‌خوان را پرحرف می‌کرد. یک ناحیهٔ
            زنده برای کل صندوق هست (قابل پرداخت، مانده، وضعیت). */}
        <span className="num">{Number(l.qty)}</span>
        <button
          type="button"
          onClick={() => on.changeQty(l.id, l.qty, 1)}
          aria-label={`اضافه کردن ${l.productName}`}
          disabled={locked}
          title={locked ? QTY_LOCKED : undefined}
        >
          +
        </button>
      </div>
      <button type="button" className="line-total line-total-edit" aria-label={`ویرایش قیمت ${l.productName}`}
        aria-expanded={panel === "price"} onClick={() => on.openPrice(l.id)}><span className="line-total-label">جمع ردیف</span><Money rial={l.netAmount} /></button>
      {/*
        برچسب متنی، نه نویسهٔ ریال (U+FDFC) و درصد: آن نویسه کنار مبلغِ **تومانی** سطر روی
        صفحه «ریال» خوانده می‌شد — یعنی مبلغ سطر ده برابر کمتر دیده می‌شد.
      */}
      <button
        type="button"
        className="line-tool"
        onClick={() => on.openPrice(l.id)}
        aria-label={`تغییر قیمت ${l.productName}`}
        aria-expanded={panel === "price"}
      >
        قیمت
      </button>
      <button
        type="button"
        className="line-tool"
        onClick={() => on.openDiscount(l.id)}
        aria-label={`تخفیف ${l.productName}`}
        aria-expanded={panel === "discount"}
      >
        تخفیف
      </button>
      <button
        type="button"
        className="line-drop"
        onClick={() => on.remove(l.id)}
        aria-label={`حذف ${l.productName}`}
      >
        ✕
      </button>
      {error && <p className="line-error" role="alert">{error}</p>}
      {panel === "price" ? (
        <PricePanel
          unitPrice={parseRial(l.unitPrice)}
          listPrice={l.listPrice === null ? null : parseRial(l.listPrice)}
          busy={false}
          onApply={(price, why) => on.applyPrice(l.id, price, why)}
          onCancel={on.closePanels}
        />
      ) : null}
      {panel === "discount" ? (
        <DiscountPanel
          gross={lineGross(l)}
          current={parseRial(l.discountAmount)}
          busy={false}
          onApply={(amount, why) => on.applyDiscount(l.id, amount, why)}
          onCancel={on.closePanels}
        />
      ) : null}
    </li>
  );
}, sameLine);

const QTY_LOCKED =
  "تعداد سطری که تخفیف خورده یا قیمتش دستی عوض شده از اینجا تغییر نمی‌کند؛ سطر را حذف و دوباره ثبت کنید.";

/** انبار پیش‌فرض: قفسه فروشگاه، نه انبار پشتیبان یا کالای معیوب. */
function defaultWarehouse(b: Branch) {
  return b.warehouses.find((w) => w.kind === "store") ?? b.warehouses[0];
}

export function Pos({ actorId }: { actorId: string }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [policy, setPolicy] = useState<{ branchId: string; requireCustomer: boolean } | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyRetry, setPolicyRetry] = useState(0);
  const [branchId, setBranchId] = useUrlState("pos.branch");
  const [warehouseId, setWarehouseId] = useUrlState("pos.warehouse");
  const [shift, setShift] = useState<Shift | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [received, setReceived] = useState(0n);
  /** فروش تمام‌شده — تا «فروش بعدی» روی صفحه می‌ماند (Batch 2.1). */
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const completedRef = useRef<CompletedSale | null>(null);
  completedRef.current = completed;
  /** قصد پرداختی که نتیجه‌اش روشن نیست — تا روشن شدن، روش و مبلغ قفل‌اند. */
  const [payPhase, setPayPhase] = useState<PaymentPhase>({ kind: "idle" });
  const [customer, setCustomer] = useState<InvoiceCustomer | null>(null);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const customerInput = useRef<HTMLInputElement>(null);
  /** فقط نمایش؛ دروازهٔ `sale.credit` سرور است. «نامعلوم» مجاز نیست. */
  const [canCredit, setCanCredit] = useState(false);
  const [canManageCustomer, setCanManageCustomer] = useState(false);
  const [nameForMobile, setNameForMobile] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setBusy] = useState(false);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [scanStorageError, setScanStorageError] = useState<string | null>(null);
  const scanRunning = useRef(false);
  const mutationRunning = useRef(false);
  const pendingScanRef = useRef<PendingScan | null>(null);
  /** ذخیرهٔ پرداخت معلق خوانده نشد — مثل اسکن معلق، تا روشن‌شدن هیچ عمل مالی‌ای نه. */
  const [paymentStoreError, setPaymentStoreError] = useState<string | null>(null);
  const busy = working || pendingScan !== null || scanStorageError !== null || paymentStoreError !== null;
  useEffect(() => {
    const sync = () => {
      try { const p = readPendingScan(actorId); pendingScanRef.current = p; setPendingScan(p); }
      catch (e) { setScanStorageError(e instanceof Error ? e.message : "ذخیرهٔ اسکن در دسترس نیست."); }
    };
    sync(); window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [actorId]);
  const [lineErrors, setLineErrors] = useState<Record<string,string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftRefund, setDraftRefund] = useState<{ invoiceId: string; payments: DraftPayment[] } | null>(null);
  const [discounting, setDiscounting] = useState<string | null>(null);
  const [pricing, setPricing] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  /** شماره مشتری؛ اختیاری یا الزامی طبق تنظیم جاری صندوق. */
  const [mobile, setMobile] = useState("");
  /**
   * فروش‌های معلق در صف آفلاین (FND-002).
   *
   * ⚠️ جدا از `error` است و جدا می‌ماند: `error` با هر عمل تازه پاک
   *    می‌شود (`guarded` صریح `setError(null)` می‌زند) ولی فروشِ معلق
   *    با عمل بعدی از بین نمی‌رود. یکی‌کردنشان یعنی صندوق‌دار پس از
   *    اسکن بعدی دیگر نبیند که فروش قبلی نرفته است.
   */
  const [pending, setPending] = useState<PendingSummary>({ total: 0, parked: 0 });
  /** صف خوانده نشد — دادهٔ خراب، یا مرورگری بدون ذخیرهٔ پایدار. */
  const [queueError, setQueueError] = useState<string | null>(null);

  // بیرون از چرخه Render: کلیدی که داخل Render ساخته شود، دقیقاً روی
  // همان Retry که باید نجاتش بدهد عوض می‌شود.
  const keys = useRef(new ActionKeys());
  const scans = useRef(new ScanCounter());
  const buffer = useRef(new ScanBuffer());

  const branch = branches.find((b) => b.id === branchId) ?? null;

  // ── بارگذاری اولیه ────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [b, credit] = await Promise.all([pos.branches(), session.can("sale.credit").catch(() => null)]);
        setBranches(b.branches);
        setCanCredit(credit?.verdict === "allow");
        void session.can("customer.manage").then((r) => setCanManageCustomer(r.verdict === "allow")).catch(() => setCanManageCustomer(false));
        // یک شعبه یعنی انتخابی در کار نیست. صندوق‌دار نباید هر روز
        // یک فهرست یک‌گزینه‌ای را تأیید کند.
        const only = b.branches.length === 1 ? b.branches[0] : undefined;
        if (only && !new URLSearchParams(window.location.search).has("pos.branch")) {
          setBranchId(only.id);
          setWarehouseId(defaultWarehouse(only)?.id ?? "");
        }
      } catch (err) {
        setError(message(err));
      } finally {
        setReady(true);
      }
    })();
  }, [setBranchId, setWarehouseId]);

  /*
   * روش‌های پرداخت **همین شعبه** — اسنپ‌پی فقط وقتی سرور برای این شعبه حساب
   * معتبر دیده باشد می‌آید (همان سنجش ثبت پرداخت).
   */
  useEffect(() => {
    if (branchId === "") return;
    let alive = true;
    setMethods([]);
    void pos.paymentMethods(branchId).then((m) => { if (alive) setMethods(m.methods); })
      .catch((err: unknown) => { if (alive) setError(message(err)); });
    return () => { alive = false; };
  }, [branchId]);

  // بازگشت از تنظیمات یا از تب دیگر، سیاست قبلی را نگه نمی‌دارد.
  useEffect(() => {
    if (!branchId) return;
    let controller: AbortController;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setPolicy(null); setPolicyError(null);
      void pos.policy(branchId, { signal }).then((value) => {
        if (!signal.aborted) setPolicy({ branchId, ...value });
      }).catch((err: unknown) => {
        if (!signal.aborted) setPolicyError(message(err));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [branchId, policyRetry]);

  const policyReady = policy?.branchId === branchId;
  const linkedCustomer = customer?.id === invoice?.customerId ? customer : null;
  const customerMissing = policyReady && policy.requireCustomer && (!invoice?.customerId || !linkedCustomer?.mobile?.trim());
  const customerGate = !policyReady || customerMissing;

  // مشتری وصل‌شده — با هر تغییر `customerId` از سرور خوانده می‌شود.
  const invoiceIdForCustomer = invoice?.id ?? null;
  const customerId = invoice?.customerId ?? null;
  useEffect(() => {
    setCustomerError(null);
    if (!invoiceIdForCustomer || !customerId) { setCustomer(null); setCustomerLoading(false); return; }
    const c = new AbortController();
    setCustomer(null);
    setCustomerLoading(true);
    pos.invoiceCustomer(invoiceIdForCustomer, { signal: c.signal })
      .then((r) => { if (!c.signal.aborted) setCustomer(r.customer); })
      .catch((err: unknown) => { if (!c.signal.aborted) { setCustomer(null); setCustomerError(`مشتری خوانده نشد: ${message(err)}`); } })
      .finally(() => { if (!c.signal.aborted) setCustomerLoading(false); });
    return () => c.abort();
  }, [invoiceIdForCustomer, customerId]);

  // شیفت جاری همین کاربر در همین شعبه.
  useEffect(() => {
    if (branchId === "") return;
    void (async () => {
      try {
        setShift(await pos.currentShift(branchId));
      } catch (err) {
        setError(message(err));
      }
    })();
  }, [branchId]);

  /**
   * سبدی که با Reload یتیم شده بود، برمی‌گردد.
   *
   * `receivedAmount` هم با همان یک تماس می‌آید — بدون آن، سبد
   * بازیابی‌شده «دریافتی صفر» نشان می‌داد و همان مبلغ **دوباره** از
   * مشتری گرفته می‌شد.
   *
   * پیش‌نویسی که دیگر پیش‌نویس نیست (یا پاک شده) فقط فراموش می‌شود؛
   * خطا دادنش به صندوق‌دار چیزی نمی‌گوید و جلوی فروش تازه را می‌گیرد.
   */
  useEffect(() => {
    if (!shift || invoice) return;
    /*
     * پرداخت نامعلومِ پیش از Reload (F-115-01) — سبدش اولویت دارد، چون قصد به همان
     * فاکتور گره خورده است. کلید تازه ساخته نمی‌شود: همان قصد قفل برمی‌گردد.
     */
    let held: PendingPayment | null = null;
    try { held = readPendingPayment(actorId); } catch (e) { setPaymentStoreError(e instanceof Error ? e.message : "ذخیرهٔ پرداخت معلق در دسترس نیست."); return; }
    const saved = readCart(shift.id);
    const target = held?.invoiceId ?? saved?.invoiceId;
    if (!target) return;
    void (async () => {
      try {
        const inv = await pos.invoice(target);
        if (inv.status === "draft" && inv.createdBy === actorId && inv.shiftId === shift.id && inv.branchId === shift.branchId && shift.userId === actorId && shift.status === "open") {
          setInvoice(inv);
          setReceived(parseRial(inv.receivedAmount));
          if (held) {
            rememberCart({ invoiceId: inv.id, shiftId: shift.id });
            setPayPhase({ kind: "unknown", intent: intentFromPending(held), reason: "ambiguous" });
            setNote("پرداختی که نتیجه‌اش روشن نبود با همان شناسه برگردانده شد؛ پیش از هر کاری وضعیتش را بررسی کنید.");
          } else setNote("سبد نیمه‌تمام قبلی برگردانده شد.");
        } else {
          forgetCart();
          // فاکتوری که دیگر پیش‌نویس نیست، اثبات نهایی سرور را دارد؛ همان را می‌پرسیم.
          if (held) await settleIntent(intentFromPending(held), await pos.paymentIntent(held.invoiceId, held.key), "ambiguous");
        }
      } catch (e) {
        setError(message(e));
      }
    })();
    // فقط هنگام تغییر شیفت — نه با هر تغییر سبد.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift]);

  /**
   * سبد جاری — **یک تعریف**، و عمداً یک مقدار همگام.
   *
   * ⚠️ این را `ensureInvoice` و `addByBarcode` هر دو می‌خوانند. اگر
   *    شرطش دو جا نوشته می‌شد، یکی‌شان دیر یا زود عقب می‌ماند.
   */
  const openDraft = invoice && invoice.status === "draft" ? invoice : null;

  /** فاکتور پیش‌نویس، در صورت نبود ساخته می‌شود. */
  const ensureInvoice = useCallback(async (): Promise<Invoice> => {
    if (openDraft) return openDraft;
    const created = await keys.current.run(`create:${shift?.id ?? branchId}`, (key) =>
      pos.createInvoice({ branchId, warehouseId, channel: "pos" }, { idempotencyKey: key }),
    );
    setInvoice(created);
    setReceived(0n);
    scans.current.reset();
    // شناسه در حافظه مرورگر می‌نشیند تا Reload آن را یتیم نکند.
    if (shift) rememberCart({ invoiceId: created.id, shiftId: shift.id });
    return created;
  }, [openDraft, shift, branchId, warehouseId]);

  const addByBarcode = useCallback(async (barcode: string, variationId?: string, retry = false) => {
    // روی صفحهٔ «ثبت شد»، اسکن فروش بعدی را بی‌صدا شروع نمی‌کند: باقی پول هنوز
    // روی صفحه است و فقط «فروش بعدی» آن را برمی‌دارد.
    if (completedRef.current && !retry) { setError("برای فروش تازه، اول «فروش بعدی» را بزنید."); return; }
    if (scanRunning.current || mutationRunning.current || scanStorageError || (pendingScanRef.current && !retry)) {
      setError("عملیات قبلی هنوز تأیید نشده است؛ پس از بررسی دوباره اسکن کنید."); return;
    }
    scanRunning.current = true;
    setBusy(true); setError(null);
    try {
      if (!navigator.locks) throw new Error("برای ثبت ایمن اسکن، مرورگر به‌روز و اتصال امن لازم است.");
      await navigator.locks.request(`labelmod-pos:${actorId}`, {ifAvailable:true}, async lock => {
      if (!lock) throw new Error("عملیات صندوق در تب دیگری جریان دارد؛ پس از پایان آن دوباره تلاش کنید.");
      let intent = readPendingScan(actorId);
      pendingScanRef.current = intent; setPendingScan(intent);
      if (intent && !retry) throw new Error("اسکن معلق در تب دیگری ثبت شده است؛ ابتدا همان اسکن را بررسی کنید.");
      if (!intent && retry) throw new Error("اسکن معلق قبلاً تعیین تکلیف شده است؛ فاکتور را تازه‌سازی کنید.");
      if (!intent) {
        const inv = openDraft ?? await ensureInvoice();
        if (!shift || inv.shiftId !== shift.id) throw new Error("شیفت فاکتور معتبر نیست.");
        intent = { actorId, invoiceId: inv.id, shiftId: shift.id, key: crypto.randomUUID(),
          body: { ...(variationId ? { variationId } : { barcode }), qty: "1" } };
        // Persistence must succeed before sending an increment.
        writePendingScan(intent);
        pendingScanRef.current = intent; setPendingScan(intent);
      }
      if (intent.actorId !== actorId || intent.shiftId !== shift?.id)
        throw new Error("اسکن معلق متعلق به این کاربر و شیفت نیست؛ بررسی مدیر لازم است.");
      try {
      const out = await pos.scan(intent.invoiceId, intent.body, { idempotencyKey: intent.key });
      if (out.invoice.id !== intent.invoiceId) throw new Error("پاسخ اسکن تأیید نشد.");
      setInvoice(out.invoice);
      clearPendingScan(actorId, intent.key); pendingScanRef.current = null; setPendingScan(null);
      } catch (err) {
        // فقط رد قطعی همین عملیات می‌تواند رکورد خودش را پاک کند؛ قفل هنوز برقرار است.
        if (err instanceof ApiError && [400, 409, 422].includes(err.status) && err.code !== "idempotency_in_flight") {
          clearPendingScan(actorId, intent.key); pendingScanRef.current = null; setPendingScan(null);
        }
        throw err;
      }
      });
    } catch (err) {
      setError(message(err));
    } finally { scanRunning.current = false; setBusy(false); }
  }, [actorId, openDraft, ensureInvoice, shift, scanStorageError]);

  // ── ستون پرداخت در قاب پنجره ─────────────────────────────────────
  //
  // ستون چسبان باید از همان جایی که شروع می‌شود تا پایین پنجره جا شود، وگرنه
  // «نهایی‌کردن» پیش از هر اسکرولی زیر خط دید می‌افتاد (نوار عملیات و پیام‌ها
  // بالای ستون‌اند). سقف ارتفاع از فاصلهٔ واقعی ستون تا بالای سند حساب می‌شود و
  // پایان ستون (`.pay-finish`) درون آن می‌چسبد. ResizeObserver پس از چیدمان صدا
  // زده می‌شود، پس هیچ چیدمان همگامی به بودجهٔ افزودن قلم (۱۰۰ms) اضافه نمی‌شود.
  //
  // ⚠️ نوشتن در همان Callback ممنوع است: سقف تازه اندازهٔ همان ظرفی را عوض می‌کند که
  //    دیده می‌شود، و WebKit آن را «ResizeObserver loop completed with undelivered
  //    notifications» به‌عنوان خطای صفحه پرتاب می‌کند. نوشتن به فریم بعد می‌رود و فقط
  //    وقتی عدد واقعاً عوض شده باشد — پس دور بعد چیزی نمی‌نویسد و حلقه بسته می‌شود.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const pay = root.querySelector<HTMLElement>(".pay");
        if (!pay) return;
        const top = pay.getBoundingClientRect().top + window.scrollY;
        const max = `${Math.max(360, Math.round(window.innerHeight - top - 16))}px`;
        if (pay.style.getPropertyValue("--pay-max") !== max) pay.style.setProperty("--pay-max", max);
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    window.addEventListener("resize", fit);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", fit); };
  }, [shift, ready, branchId, warehouseId]);

  // ── بارکدخوان ─────────────────────────────────────────────────────
  //
  // در فاز Capture و روی کل سند، نه روی یک ورودی: اسکنر خودش را
  // کیبورد معرفی می‌کند و ممکن است هر جای صفحه فوکوس باشد. تصمیم
  // «اسکن بود یا تایپ» در `ScanBuffer` است و از روی سرعت گرفته
  // می‌شود، نه از روی فوکوس.
  useEffect(() => {
    if (!shift) return;
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
      const step = buffer.current.push(e.key, e.timeStamp);
      if (step.kind === "consumed") {
        // اسکن در جریان است — نگذار کاراکترها در فیلدی که فوکوس دارد بریزند.
        e.preventDefault();
      } else if (step.kind === "scanned") {
        e.preventDefault();
        void addByBarcode(step.barcode);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [shift, addByBarcode]);

  // ── عمل‌ها ────────────────────────────────────────────────────────

  /**
   * خواندن صف معلق‌ها.
   *
   * ⚠️ خطای خواندن **نمایش داده می‌شود** و صف را پاک نمی‌کند. «۰ در
   *    انتظار» برای صفی که خوانده نشده، دروغ است — و از هر خطایی
   *    خطرناک‌تر، چون آرام‌بخش است.
   */
  const refreshPending = useCallback(async () => {
    try {
      setPending(summarize(await saleQueue().pending()));
      setQueueError(null);
    } catch (err) {
      setQueueError(message(err));
    }
  }, []);

  /**
   * تلاش برای ارسال صف.
   *
   * بی‌صدا اجرا می‌شود: شکست شبکه یعنی «هنوز قطع است»، نه یک خطای تازه
   * که روی صفحه بیاید. همان `pending` کافی است.
   */
  const flushQueue = useCallback(async () => {
    try {
      await saleQueue().flush();
    } catch {
      /* خطای ارسال در همان ردیف صف ثبت می‌شود؛ نشانگر معلق‌ها نشانش می‌دهد. */
    }
    await refreshPending();
  }, [refreshPending]);

  /**
   * تلاش دستی روی ردیف‌های پارک‌شده.
   *
   * ⚠️ ردیف پارک‌شده با `flush` خودکار **برداشته نمی‌شود** — و این
   *    درست است: علتش یک «نه»ی سرور بوده، نه قطعی شبکه. پس آزادکردنش
   *    باید تصمیم آدم باشد. `retry()` همان شناسه، همان کلید و همان
   *    بدنه را نگه می‌دارد، پس اگر سرور بار اول کارش را کرده باشد،
   *    Replay می‌گیرد نه اثر دوم.
   */
  const retryParked = useCallback(async () => {
    try {
      const q = saleQueue();
      for (const r of await q.pending()) {
        if (r.pausedReason !== undefined) await q.retry(r.id);
      }
    } catch (err) {
      setQueueError(message(err));
      return;
    }
    await flushQueue();
  }, [flushQueue]);

  /**
   * وصل‌شدن شبکه → تلاش خودکار. و یک تلاش هنگام باز شدن صفحه.
   *
   * ⚠️ رویداد `online` مرورگر **تضمین نیست** (Wi-Fi وصل و اینترنت قطع،
   *    همان چیزی است که `navigator.onLine` نمی‌فهمد). پس دکمهٔ دستی هم
   *    هست و تکیهٔ کامل به این رویداد نمی‌شود.
   */
  useEffect(() => {
    void flushQueue();
    const onOnline = () => void flushQueue();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushQueue]);

  /**
   * اجرای انحصاری یک عمل صندوق — قفل همین تب (`mutationRunning`) و قفل میان
   * تب‌ها (`navigator.locks`)، و ردّ هر کاری تا اسکن معلق تعیین تکلیف نشده.
   *
   * خطا **بالا می‌رود**؛ `guarded` آن را به نوار خطا می‌برد و `SafeAction` به
   * پنجرهٔ خودش. ردّ پیش‌شرط (عمل دیگر در جریان) یک `ApiError` ۴۰۹ است تا عمل
   * ایمن آن را «انجام نشد» بداند، نه «نامعلوم» — هیچ درخواستی نرفته است.
   */
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const refuse = (text: string) => new ApiError(409, "pos_busy", text, null);
    if (pendingScanRef.current || scanStorageError || paymentStoreError || scanRunning.current || mutationRunning.current)
      throw refuse("عملیات قبلی هنوز تأیید نشده است؛ پس از بررسی دوباره تلاش کنید.");
    mutationRunning.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks) throw refuse("برای ثبت ایمن، مرورگر به‌روز و اتصال امن لازم است.");
      return await navigator.locks.request(`labelmod-pos:${actorId}`, {ifAvailable:true}, async lock => {
        if (!lock) throw refuse("عملیات صندوق در تب دیگری جریان دارد.");
        const intent = readPendingScan(actorId);
        if (intent) { pendingScanRef.current = intent; setPendingScan(intent); throw refuse("ابتدا اسکن معلق را بررسی کنید."); }
        return await fn();
      });
    } finally {
      mutationRunning.current = false; setBusy(false);
    }
  }

  async function guarded(fn: () => Promise<void>) {
    if (busy) return false;
    try {
      await exclusive(fn);
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  }

  const openShift = (openingCash: string) =>
    guarded(async () => {
      try {
        setShift(await pos.openShift({ branchId, openingCash }));
      } catch (err) {
        // همان درسِ اسکن، روی یک مسیر دیگر: اگر سرور شیفت را باز کند
        // ولی پاسخ در راه گم شود، صندوق‌دار خطا می‌بیند و صفحه هنوز
        // «شیفت باز نیست» نشان می‌دهد — در حالی که **دارد**. تلاش
        // دوباره هم `shift_already_open` می‌گیرد، که درست است ولی
        // به کسی که می‌خواست شیفت باز کند می‌گوید «اول ببندش».
        //
        // پس وضعیت واقعی خوانده می‌شود. اگر شیفت باز شده باشد، همان
        // نشان داده می‌شود و کار ادامه پیدا می‌کند.
        try {
          const actual = await pos.currentShift(branchId);
          if (actual) {
            setShift(actual);
            return;
          }
        } catch {
          /* شبکه هنوز قطع است — همان خطای اصلی گفته می‌شود */
        }
        throw err;
      }
    });

  const changeQty = (lineId: string, current: string, delta: number) =>
    guarded(async () => {
      if (!invoice) return;
      const next = steppedQty(current, delta);
      // رسیدن به صفر یعنی حذف — یک عمل دیگر با ردّ حسابرسی متفاوت.
      try {
        const updated = next === null ? await pos.removeLine(invoice.id, lineId) : await pos.setLineQty(invoice.id, lineId, next);
        setInvoice(updated); setLineErrors(errors => {const clean={...errors}; delete clean[lineId]; return clean;});
      } catch (e) { setLineErrors(errors => ({...errors, [lineId]:message(e)})); throw e; }

    });

  const removeLine = (lineId: string) =>
    guarded(async () => {
      if (!invoice) return;
      setInvoice(await pos.removeLine(invoice.id, lineId));
    });

  const applyDiscount = (lineId: string, amountRial: bigint, why: string) =>
    guarded(async () => {
      if (!invoice) return;
      setInvoice(
        await pos.setLineDiscount(invoice.id, lineId, {
          discountAmount: amountRial.toString(),
          ...(why.trim() === "" ? {} : { discountReason: why.trim() }),
        }),
      );
      setDiscounting(null);
    });

  /**
   * قیمت دستی روی سطر — «مثل دشت».
   *
   * `Idempotency-Key` نمی‌گیرد و لازم هم ندارد: مقدار **مطلق** است،
   * پس تلاش دوباره همان قیمت را می‌نویسد نه یک اثر دوم — همان دلیلی
   * که `setLineQty` و تخفیف هم کلید ندارند.
   *
   * سقف کاهش، مجوز نوشتن قیمت و اجبار دلیل هیچ‌کدام اینجا نیستند.
   * سرور ۴۰۳/۴۲۸/۴۰۹ فارسی می‌دهد و همان در نوار خطا دیده می‌شود.
   */
  const applyPrice = (lineId: string, priceRial: bigint, why: string) =>
    guarded(async () => {
      if (!invoice) return;
      setInvoice(
        await pos.setLinePrice(invoice.id, lineId, {
          unitPrice: priceRial.toString(),
          ...(why.trim() === "" ? {} : { priceOverrideReason: why.trim() }),
        }),
      );
      setPricing(null);
    });

  /**
   * دیسپچرِ **پایدار** سطر سبد.
   *
   * ⚠️ بی این، `React.memo` روی `CartLine` بی‌اثر بود: Handlerهای بالا
   *    در هر Render تازه ساخته می‌شوند، پس Prop سطر عوض می‌شد و
   *    مقایسهٔ memo همیشه «تغییر کرده» می‌گفت.
   *
   * `useRef` آخرین نسخهٔ Handlerها را نگه می‌دارد و شیء بیرونی
   * **یک بار** ساخته می‌شود. پس سطر یک Prop ثابت می‌بیند و همیشه
   * تازه‌ترین تابع را صدا می‌زند — نه یک Closure کهنه.
   */
  const live = useRef({ changeQty, removeLine, applyPrice, applyDiscount,
                        setPricing, setDiscounting });
  live.current = { changeQty, removeLine, applyPrice, applyDiscount,
                   setPricing, setDiscounting };

  const rowActions = useMemo<RowActions>(
    () => ({
      changeQty: (id, qty, d) => void live.current.changeQty(id, qty, d),
      remove: (id) => void live.current.removeLine(id),
      applyPrice: (id, p, why) => void live.current.applyPrice(id, p, why),
      applyDiscount: (id, a, why) => void live.current.applyDiscount(id, a, why),
      openPrice: (id) => {
        live.current.setDiscounting(null);
        live.current.setPricing((cur) => (cur === id ? null : id));
      },
      openDiscount: (id) => {
        live.current.setPricing(null);
        live.current.setDiscounting((cur) => (cur === id ? null : id));
      },
      closePanels: () => {
        live.current.setPricing(null);
        live.current.setDiscounting(null);
      },
    }),
    [],
  );

  /**
   * چسباندن مشتری به سبد.
   *
   * نرمال‌سازی واقعی در دیتابیس است (`sales.normalize_mobile`)؛
   * `normalizeDigits` فقط رقم فارسی و عربی را لاتین می‌کند چون
   * صفحه‌کلید فارسی «۰۹۱۲…» می‌فرستد.
   */
  const attachCustomer = (fullName?: string) =>
    guarded(async () => {
      const m = fullName === undefined ? normalizeDigits(mobile).trim() : nameForMobile;
      if (m === "") return;
      if (!m) return;
      const inv = await ensureInvoice();
      try {
        setInvoice(await pos.attachCustomer(inv.id, { mobile: m, requireNameForNew: true, ...(fullName === undefined ? {} : { fullName }) }));
      } catch (err) {
        if (err instanceof ApiError && err.code === "customer_name_required") { setNameForMobile(m); return; }
        throw err;
      }
      setNameForMobile(null);
      setMobile("");
      setNote("مشتری به این فاکتور وصل شد.");
    });

  const saveCustomerName = (fullName: string) => guarded(async () => {
    if (!customer || !canManageCustomer || customer.fullName?.trim()) return;
    await people.updateCustomer(customer.id, { fullName });
    if (invoice) setCustomer((await pos.invoiceCustomer(invoice.id)).customer);
  });

  /**
   * ثبت یک پرداخت — با چرخهٔ «نتیجهٔ نامعلوم» (UI_PATTERNS §۵ بند ۷، F-115-01).
   *
   * ── هویت قصد، کلید خودش است ──
   *
   * هر قصد یک `key` تصادفی می‌گیرد که همان `Idempotency-Key` و در سرور همان
   * `client_event_id` است، و **پیش از** ارسال در `pending-payment` می‌نشیند — پس
   * Reload آن را گم نمی‌کند. تا سرور حالت نهایی ندهد، فقط همین قصد با همین کلید و
   * همین بدنه: نه روش تازه، نه مبلغ تازه، نه کلید تازه.
   *
   * ⚠️ جمع دریافتی هرگز هویت این پرداخت را ثابت نمی‌کند: پرداخت دیگری با همان
   *    مبلغ (تب یا دستگاه دیگر) آن را دقیقاً به اندازهٔ همین قصد بالا می‌برد. بررسی
   *    وضعیت فقط `GET /invoices/:id/payment-intents/:key` است.
   * ⚠️ `navigator.locks` فقط هماهنگی میان تب‌هاست، نه اثبات مالی.
   *
   * ردِ قطعیِ **نخستین** ارسال اثری نگذاشته (همان درخواست تنها نسخه بود)، پس قصد
   * پاک و ورودی برای اصلاح حفظ می‌شود. ردِ **ارسال دوباره** چنین اثباتی ندارد —
   * نسخهٔ اول ممکن است هنوز در راه باشد — پس قصد باز می‌ماند تا بررسی یا مهر.
   */
  const submitPayment = (intent: PaymentIntent, retry: boolean) =>
    guarded(async () => {
      if (!invoice || invoice.id !== intent.invoiceId || !invoice.shiftId) return;
      if (!retry) {
        if (customerGate) throw new Error(customerMissing ? "پیش از دریافت وجه، شماره مشتری را ثبت کنید." : "ابتدا سیاست صندوق را دوباره بررسی کنید.");
        const other = readPendingPayment(actorId);
        if (other) {
          if (other.invoiceId === invoice.id) setPayPhase({ kind: "unknown", intent: intentFromPending(other), reason: "ambiguous" });
          throw new Error("پرداخت دیگری هنوز تعیین تکلیف نشده است؛ ابتدا وضعیت همان را بررسی کنید.");
        }
        // نوشتن پایدار شرط ارسال است؛ اگر نشد، چیزی فرستاده نمی‌شود.
        writePendingPayment(intentToPending(intent, { actorId, shiftId: invoice.shiftId }, "sending"));
      }
      setPayPhase({ kind: "submitting", intent });
      try {
        const out = await pos.pay(intent.invoiceId, paymentBody(intent), { idempotencyKey: intent.key });
        clearPendingPayment(actorId, intent.key);
        setInvoice(out.invoice);
        // «چقدر گرفته‌ایم» از جمع سرور می‌آید — فقط برای نمایش، نه برای هویت پرداخت.
        setReceived(parseRial(out.receivedAmount));
        setPayPhase({ kind: "idle" });
        if (retry) setNote(`پرداخت ${intent.methodName} با همان شناسه ثبت شد.`);
      } catch (err) {
        if (paymentFailureKind(err) === "unknown") { holdIntent(intent, "ambiguous", invoice.shiftId); return; }
        if (retry) { holdIntent(intent, "retry_rejected", invoice.shiftId, checkoutErrorMessage(err)); return; }
        clearPendingPayment(actorId, intent.key);
        setPayPhase({ kind: "idle" });
        setError(checkoutErrorMessage(err));
      }
    });

  /** قصد باز می‌ماند — هم روی صفحه و هم در ذخیرهٔ پایدار. */
  function holdIntent(intent: PaymentIntent, reason: UnresolvedReason, shiftId: string, detail?: string) {
    try { writePendingPayment(intentToPending(intent, { actorId, shiftId }, "unresolved")); }
    catch (e) { setError(e instanceof Error ? e.message : "پرداخت معلق ذخیره نشد."); }
    setPayPhase({ kind: "unknown", intent, reason, ...(detail === undefined ? {} : { detail }) });
  }

  /**
   * حکم سرور دربارهٔ **همین** شناسه. فقط حالت نهایی قصد را می‌بندد و ذخیرهٔ پایدار را
   * پاک می‌کند؛ «هنوز پیدا نشد» قصد را قفل نگه می‌دارد.
   */
  async function settleIntent(intent: PaymentIntent, status: PaymentIntentStatus, reason: UnresolvedReason) {
    const verdict = resolveIntentStatus(intent, status);
    if (verdict === "unresolved" || verdict === "mismatch") {
      // ردِ ارسال دوباره، پس از بررسی هم «هنوز پیدا نشد» است؛ دلیلش دیده می‌ماند.
      setPayPhase({ kind: "unknown", intent, reason: verdict === "mismatch" ? "mismatch" : reason === "retry_rejected" ? reason : "not_found_yet" });
      return;
    }
    clearPendingPayment(actorId, intent.key);
    setPayPhase({ kind: "idle" });
    setNote(verdict === "recorded"
      ? `پرداخت ${intent.methodName} پیش‌تر ثبت شده بود؛ دوباره گرفته نشد.`
      : `سرور تأیید کرد پرداخت ${intent.methodName} هرگز ثبت نمی‌شود؛ می‌توانید پرداخت تازه بگیرید.`);
    try {
      const fresh = await pos.invoice(intent.invoiceId);
      if (fresh.status === "draft") { setInvoice(fresh); setReceived(parseRial(fresh.receivedAmount)); }
    } catch {
      setError("فاکتور تازه خوانده نشد؛ صفحه را تازه کنید تا دریافتی درست دیده شود.");
    }
  }

  const takePayment = (option: PaymentOption, amountRial: bigint, refNo: string) => {
    if (!invoice || payPhase.kind !== "idle") return;
    void submitPayment({ key: crypto.randomUUID(), invoiceId: invoice.id, methodCode: option.code, methodName: option.name,
      amount: amountRial, refNo }, false);
  };

  /** «بررسی وضعیت» — فقط خواندنِ همان شناسه؛ هیچ پرداختی دوباره فرستاده نمی‌شود. */
  const checkPayment = () =>
    guarded(async () => {
      if (payPhase.kind !== "unknown") return;
      const { intent, reason } = payPhase;
      setPayPhase({ kind: "checking", intent });
      let status: PaymentIntentStatus;
      try {
        status = await pos.paymentIntent(intent.invoiceId, intent.key);
      } catch {
        setPayPhase({ kind: "unknown", intent, reason });
        setError("وضعیت هنوز از سرور خوانده نشد؛ اتصال را بررسی کنید و دوباره «بررسی وضعیت» را بزنید.");
        return;
      }
      await settleIntent(intent, status, reason);
    });

  /** ارسال دوبارهٔ **همان** قصد: همان کلید، همان بدنه — Replay اگر نشسته بود. */
  const retryPayment = () => {
    if (payPhase.kind !== "unknown" || payPhase.reason === "mismatch") return;
    void submitPayment(payPhase.intent, true);
  };

  /**
   * «این پرداخت انجام نشده» — شناسه در سرور مهر می‌شود تا نسخهٔ دیرِ همین قصد هرگز
   * ثبت نشود. اگر پیش‌تر نشسته بود، سرور «ثبت شد» می‌گوید و همان پذیرفته می‌شود.
   */
  const abandonPayment = () =>
    guarded(async () => {
      if (payPhase.kind !== "unknown" || payPhase.reason === "mismatch") return;
      const { intent, reason } = payPhase;
      setPayPhase({ kind: "checking", intent });
      let status: PaymentIntentStatus;
      try {
        status = await pos.abandonPaymentIntent(intent.invoiceId, intent.key);
      } catch (err) {
        setPayPhase({ kind: "unknown", intent, reason });
        setError(`لغو این پرداخت ثبت نشد: ${message(err)}`);
        return;
      }
      await settleIntent(intent, status, reason);
    });

  /**
   * نهایی‌کردن فاکتور — و تنها عملی که هنگام قطعی شبکه **صف** می‌شود.
   *
   * ── چرا فقط همین یکی (FND-002) ────────────────────────────────────
   *
   * سطرها و پرداخت‌ها همه آنلاین ثبت شده‌اند، پس فاکتور یک پیش‌نویس
   * کامل **روی سرور** است و نهایی‌کردنش هیچ تصمیمی در مرورگر لازم
   * ندارد. صف‌کردن اسکن یا پرداخت یعنی صفحه عددی نشان بدهد که سرور
   * تأییدش نکرده — همان «حالت آفلاین کامل» که ممنوع است.
   *
   * ⚠️ کلید Idempotency **همان کلید تلاش ناموفق** است، نه یک کلید
   *    تازه: اگر شبکه پس از رسیدن درخواست به سرور قطع شده باشد، فاکتور
   *    همان‌جا نهایی شده و ارسال دوبارهٔ صف باید **Replay** بگیرد، نه
   *    فاکتور دوم. `keyFor` در شکست کلید را نگه می‌دارد؛ به همین دلیل
   *    اینجا از `keys.current.run` استفاده نمی‌شود — آن در موفقیت کلید
   *    را پاک می‌کند و ما باید در **هر دو** مسیر خودمان تصمیم بگیریم.
   *
   * ── عمل ایمن (Batch 2.1) ──
   *
   * از `SafeAction` صدا زده می‌شود (هم «نهایی‌کردن» و هم «ثبت نسیه» — نسیه
   * همین نهایی‌سازی با مانده است و سرور تصمیمش را زیر قفل می‌گیرد). ردّ قطعی با
   * پیام قابل اقدام بالا می‌رود؛ ۵xx «نامعلوم» است و `verifyFinalize` وضعیت را
   * می‌خواند — با همان کلید. موفقیت سبد را پاک نمی‌کند: «ثبت شد» تا «فروش بعدی»
   * می‌ماند.
   */
  const finalize = () =>
    exclusive(async () => {
      if (!invoice) return;
      if (customerGate) throw new Error(customerMissing ? "پیش از نهایی‌کردن، شماره مشتری را ثبت کنید." : "ابتدا سیاست صندوق را دوباره بررسی کنید.");
      const action = `finalize:${invoice.id}`;
      const key = keys.current.keyFor(action);
      const amount = parseRial(invoice.payableAmount);
      try {
        const done = await pos.finalize(invoice.id, { idempotencyKey: key });
        // F-115-02: مبلغ‌ها از تسویهٔ قطعی همین پاسخ، نه از تصویر پیش از نهایی‌سازی.
        completeSale(invoice.id, done.number, finalAmounts(done.settlement), null);
      } catch (err) {
        // خطای قاعده‌ای (موجودی، دوره بسته، نسیه بی مشتری) صف نمی‌شود:
        // سرور جواب داده و جوابش «نه» است.
        if (err instanceof ApiError && err.status < 500 && !isNetworkFailure(err))
          throw new ApiError(err.status, err.code, checkoutErrorMessage(err), err.correlationId);
        if (!isNetworkFailure(err)) throw err;
        /*
         * ⚠️ ترتیب مهم است: اول صف، بعد پاک‌کردن سبد. اگر `enqueue`
         *    خطا بدهد (سهم ذخیره پر، یا مرورگر بدون ذخیرهٔ پایدار)،
         *    خطا بالا می‌رود و سبد **سر جایش می‌ماند** — پس صندوق‌دار
         *    می‌تواند دوباره تلاش کند. برعکسش یعنی فروش هم از صفحه
         *    برود و هم در صف نباشد.
         */
        await saleQueue().enqueue({
          id: action,
          saleContext: { actorId, invoiceId: invoice.id, branchId: invoice.branchId, shiftId: invoice.shiftId ?? "" },
          method: "POST",
          path: `/invoices/${invoice.id}/finalize`,
          body: {},
          idempotencyKey: key,
          label: `فروش ${toman(amount)} تومان`,
        });
        await refreshPending();
        // در صف هنوز تسویه‌ای نیست؛ آخرین عدد سرور فقط «برآورد» نمایش داده می‌شود.
        completeSale(invoice.id, null, null, { payable: amount, received });
      }
      keys.current.clear(action);
      forgetCart();
    });

  /** «آیا نهایی شده؟» — فقط خواندن؛ اگر شده، همان وضعیت موفق نشان داده می‌شود. */
  const verifyFinalize = async () => {
    if (!invoice) return false;
    const fresh = await pos.invoice(invoice.id);
    if (!["finalized", "paid", "partially_returned", "returned"].includes(fresh.status)) return false;
    completeSale(invoice.id, fresh.number, finalAmounts(fresh.settlement), null);
    keys.current.clear(`finalize:${invoice.id}`);
    forgetCart();
    return true;
  };

  function completeSale(invoiceId: string, number: string | null, amounts: CompletedSale["amounts"], estimate: CompletedSale["estimate"]) {
    setCompleted({ invoiceId, number, queued: estimate !== null, amounts, estimate });
    setPayPhase({ kind: "idle" });
  }

  /** «فروش بعدی» — تنها جایی که صفحهٔ «ثبت شد» برداشته و سبد تازه می‌شود. */
  const nextSale = () => {
    forgetCart();
    setCompleted(null);
    setInvoice(null);
    setReceived(0n);
    setMobile("");
    setNameForMobile(null);
    setNote(null);
    setError(null);
    scans.current.reset();
  };

  const closeShift = (countedCash: string, shiftNote: string) =>
    guarded(async () => {
      if (!shift) return;
      const done = await keys.current.run(`close:${shift.id}`, (key) =>
        pos.closeShift(
          shift.id,
          { countedCash, ...(shiftNote === "" ? {} : { note: shiftNote }) },
          { idempotencyKey: key },
        ),
      );
      const variance = done.variance === null ? 0n : parseRial(done.variance);
      setNote(
        variance === 0n
          ? "شیفت بسته شد — بدون مغایرت."
          : `شیفت بسته شد. مغایرت: ${toman(variance)} تومان.`,
      );
      setShift(null);
      setClosing(false);
      forgetCart();
    });

  const abandon = () =>
    guarded(async () => {
      if (!invoice) return;
      try {
        await pos.cancel(invoice.id, "رها شد");
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "invoice_has_payment") throw err;
        const { payments } = await pos.draftPayments(invoice.id);
        setDraftRefund({ invoiceId: invoice.id, payments });
        return;
      }
      forgetCart();
      setInvoice(null);
      setReceived(0n);
      scans.current.reset();
    });

  const confirmDraftRefund = (reason: string, refundReference: string) => guarded(async () => {
    if (!draftRefund) return;
    const body = { reason, confirmed: true as const, paymentIds: draftRefund.payments.map((p) => p.id),
      ...(refundReference.trim() ? { refundReference: refundReference.trim() } : {}) };
    await keys.current.run(`refund-draft:${draftRefund.invoiceId}:${JSON.stringify(body)}`, (key) =>
      pos.refundDraft(draftRefund.invoiceId, body, key));
    setDraftRefund(null);
    forgetCart(); setInvoice(null); setReceived(0n); scans.current.reset();
    setNote("برگشت پرداخت پیش‌نویس ثبت و سبد لغو شد.");
  });

  // ── نماها ─────────────────────────────────────────────────────────

  if (!ready) return <Solid className="pad">در حال بارگذاری…</Solid>;

  if (branches.length === 0) {
    return (
      <Solid className="pad">
        <p style={{ margin: 0 }}>
          به هیچ شعبه‌ای دسترسی ندارید. از مدیر بخواهید نقش شما را به یک شعبه وصل کند.
        </p>
      </Solid>
    );
  }

  if (branchId === "" || warehouseId === "") {
    return (
      <SetupPanel
        branches={branches}
        branchId={branchId}
        onPick={(b, w) => {
          setBranchId(b);
          setWarehouseId(w);
        }}
      />
    );
  }

  if (!shift) {
    return <OpenShiftPanel busy={busy} error={error} onOpen={openShift} branch={branch} />;
  }

  const lines = invoice?.lines ?? [];
  const counts = cartCounts(lines);
  const countLabel = `${formatCount(counts.lines)} ردیف · ${formatCount(counts.units)} عدد`;
  const totals = checkoutTotals(invoice, received);
  const layout = paymentLayout(methods, { hasCustomer: (invoice?.customerId ?? null) !== null });
  const hasCart = invoice !== null && lines.length > 0;
  const payIdle = payPhase.kind === "idle";
  /*
   * «سبد خالیِ تازه» با «پیش‌نویسِ بی‌سطری که پرداخت دارد یا قصدش نامعلوم است» یکی نیست
   * (یافتهٔ Astra، P2). حذف آخرین سطر در میانهٔ یک پرداخت نامعلوم ممکن است و سرور هم
   * می‌پذیردش؛ اگر صفحه آن را «خالی» بخواند، زیر ۹۰۰ کل ستون پرداخت — و راه «بررسی
   * وضعیت» همان قصد — پنهان می‌شد و مبلغ‌های شناخته‌شده «—» نشان داده می‌شدند. چنین
   * پیش‌نویسی فعال است: ستون پرداخت و خلاصهٔ موبایل می‌مانند. پرداخت **تازه** همچنان فقط
   * با سطر (`hasCart`) باز است و هیچ قصدی خودکار بسته، تکرار یا کلیدش عوض نمی‌شود.
   */
  const draftActive = invoice !== null && (hasCart || received > 0n || !payIdle);
  const settled = canFinalize({ status: invoice?.status ?? "none", lineCount: lines.length, payable: totals.payable, received });
  // یک ناحیهٔ زنده برای کل صندوق: قابل پرداخت، مانده و وضعیت اصلی.
  const liveText = completed
    ? (completed.queued ? "فروش در صف ارسال است." : `فاکتور ${completed.number ?? ""} ثبت شد.`) +
      (completed.amounts && completed.amounts.change > 0n ? ` باقی پول ${toman(completed.amounts.change)} تومان.` : "")
    : draftActive
      ? `قابل پرداخت ${toman(totals.payable)} تومان؛ ${totals.change > 0n ? `باقی پول ${toman(totals.change)}` : `مانده ${toman(totals.remaining)}`} تومان.${note ? ` ${note}` : ""}`
      : note ?? "";
  const customerBlock = <CustomerSummary customer={linkedCustomer} loading={customerLoading} error={customerError}
    required={policyReady && policy.requireCustomer}
    mobile={mobile} onMobile={(v) => { setMobile(v); setNameForMobile(null); }} onAttach={() => void attachCustomer()}
    nameForMobile={nameForMobile} onConfirmName={(name) => void attachCustomer(name)} onCancelName={() => setNameForMobile(null)}
    canManage={canManageCustomer} onSaveName={(name) => void saveCustomerName(name)}
    busy={busy} inputRef={customerInput} />;
  const focusCustomer = () => {
    customerInput.current?.scrollIntoView({ block: "center", behavior: "instant" });
    customerInput.current?.focus();
  };

  return (
    <div ref={rootRef} className={`pos${draftActive && !completed ? " pos--has-items" : ""}${!draftActive && !completed ? " pos--empty" : ""}`}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{liveText}</p>
      {draftActive && !completed && <aside className="pos-mobile-summary solid" aria-label="خلاصهٔ پرداخت">
        <span className="pos-mobile-figures"><span className="muted">{countLabel}</span>
          <span>{totals.change > 0n ? "باقی پول" : "مانده"} <Money rial={totals.change > 0n ? totals.change : totals.remaining} size="sm" /></span></span>
        {customerMissing ? <button className="btn btn--primary" type="button" onClick={focusCustomer}>ثبت شماره مشتری</button> : settled && payIdle
          ? <button className="btn btn--primary" type="button" onClick={() => document.querySelector<HTMLElement>(".pay-finish")?.scrollIntoView({block:"center",behavior:"instant"})}>رفتن به نهایی‌سازی</button>
          : <button className="btn btn--primary" type="button" onClick={() => document.querySelector<HTMLElement>(".pay")?.scrollIntoView({block:"start",behavior:"instant"})}>رفتن به پرداخت</button>}
      </aside>}
      {/*
        نوار عملیات — تخت و فشرده، نه یک کارت شیشه‌ای دیگر (بازطراحی بصری Batch 2.1).
        وضعیت شیفت و شعبه آغاز ردیف؛ ابزارها کم‌صدا در انتها. «ردیف» و «عدد» دو
        چیزند: چهار سطر با تعداد دو، «۴ ردیف · ۸ عدد» است، نه «۸ قلم».
      */}
      <header className="pos-bar">
        <div className="pos-context">
          <span className="pos-shift"><span className="dot dot--good" aria-hidden="true">●</span> شیفت باز</span>
          {branch ? <span className="pos-branch">{branch.name}</span> : null}
          <span className="pill">{countLabel}</span>
        </div>
        <div className="pos-tools">
          <a className="tool" href="/?page=invoices&invoices.status=draft" onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(e.currentTarget.href); }}>پیش‌نویس‌ها</a>
          <button type="button" className="tool" disabled={busy || !invoice || completed !== null || !payIdle} onClick={() => {
            if (!invoice || busy) return;
            forgetCart(); setInvoice(null); setReceived(0n); scans.current.reset();
            setNote("پیش‌نویس در سرور ذخیره است و از بخش فاکتورها قابل ادامه است.");
          }}>ذخیره و فروش جدید</button>
          <button type="button" className="tool" disabled={!hasCart || busy || !payIdle || completed !== null} onClick={() => void abandon()}>
            رها کردن سبد
          </button>
          {/* دوربین فقط وقتی باز می‌شود که کاربر بخواهد — روی دسکتاپ
              با بارکدخوان سیمی، هیچ‌وقت. */}
          <button type="button" className="tool" disabled={completed !== null} onClick={() => setCamera((v) => !v)}>
            {camera ? "بستن دوربین" : "دوربین"}
          </button>
          <button type="button" className="tool" onClick={() => setClosing((v) => !v)}>
            بستن شیفت
          </button>
        </div>
      </header>

      {scanStorageError && <p className="solid pos-alert" role="alert">{scanStorageError}</p>}
      {paymentStoreError && <p className="solid pos-alert" role="alert">{paymentStoreError}</p>}
      {pendingScan && <div className="solid pad" role="status">
        <p>نتیجهٔ اسکن هنوز قطعی نیست. برای جلوگیری از ثبت دوباره، ابتدا همین اسکن را تعیین تکلیف کنید.</p>
        <button type="button" className="btn" disabled={working} onClick={() => void addByBarcode("", undefined, true)}>بررسی و تلاش دوبارهٔ همان اسکن</button>
      </div>}

      {/* عنصر ساده با کلاس `solid`، نه کامپوننت `Solid`: آن `role`
          نمی‌گیرد و اینجا اعلام زنده لازم است تا صندوق‌دار خطا را
          بشنود، نه فقط ببیند. سطح شیشه‌ای هم داخلش نیست که Context
          لازم شود. */}
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {/* بی role: یادداشت همراه جمع‌ها در **یک** ناحیهٔ زندهٔ صندوق اعلام می‌شود. */}
      {note ? (
        <p className="solid pos-alert">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      {/*
        نشانگر فروش‌های معلق (FND-002).

        ⚠️ وقتی صف خالی است **هیچ‌چیز** نشان داده نمی‌شود: نشانگری که
           همیشه روی صفحه باشد، دیده نمی‌شود. و `role="status"` نه
           `alert`: صفِ در حال ارسال یک خطا نیست.

        ⚠️ و رنگ تنها حامل معنا نیست — برچسب متنی خودش عدد و وضعیت را
           می‌گوید (بند ۳ قواعد رابط).
      */}
      {pendingLabel(pending) !== null ? (
        <p className="solid pos-alert" role="status">
          <span
            className={pending.parked > 0 ? "dot dot--crit" : "dot dot--warn"}
            aria-hidden="true"
          >
            ●
          </span>{" "}
          {pendingLabel(pending)}
          <button type="button" className="tool" onClick={() => void flushQueue()}>
            ارسال دوباره
          </button>
          {pending.parked > 0 ? (
            <button type="button" className="tool" onClick={() => void retryParked()}>
              آزادکردن ردیف‌های پارک‌شده
            </button>
          ) : null}
        </p>
      ) : null}
      {queueError ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {queueError}
        </p>
      ) : null}

      {camera && !completed ? (
        <CameraScan onCode={(code) => void addByBarcode(code)} onClose={() => setCamera(false)} />
      ) : null}

      {draftRefund ? <DraftRefundPanel payments={draftRefund.payments} busy={busy}
        onCancel={() => setDraftRefund(null)} onConfirm={(reason, ref) => void confirmDraftRefund(reason, ref)} /> : null}
      {closing ? (
        <CloseShiftPanel
          busy={busy}
          openCart={lines.length > 0}
          onClose={(cash, n) => void closeShift(cash, n)}
          onCancel={() => setClosing(false)}
        />
      ) : null}

      {completed ? <SaleComplete sale={completed} onNext={nextSale} /> : <div className="pos-body">
        {/*
          فضای کار: جست‌وجو/اسکن و سبد روی **یک** سطح مات — نه دو کارت تودرتو. سبد
          خالی یک حالت خالیِ فشرده است، نه یک قاب بزرگِ تهی.
        */}
        <Solid as="section" className="cart" aria-label="سبد خرید">
          <h2 className="cart-title">مشتری فاکتور</h2>
          {!policyReady ? <p className="field-hint" role={policyError ? "alert" : "status"}>
            {policyError ? <>تنظیمات صندوق خوانده نشد؛ دریافت وجه تا بررسی آن بسته است. <button type="button" className="tool" onClick={() => setPolicyRetry((n) => n + 1)}>بررسی دوباره</button></> : "در حال بررسی تنظیمات صندوق…"}
          </p> : customerMissing ? <p className="field-hint">شماره مشتری برای این صندوق الزامی است؛ پیش از دریافت وجه آن را ثبت کنید.</p> : null}
          {customerBlock}
          <PosProductPicker key={warehouseId} warehouseId={warehouseId} busy={busy} onPick={(id) => addByBarcode("", id)} />
          <div className="cart-head">
            <h2 className="cart-title">سبد خرید</h2>
            {lines.length ? <span className="cart-count">{countLabel}</span> : null}
          </div>
          {/*
            ⚠️ `fieldset[disabled]` — یک جا، نه ۲۰۰ جا (FND-016).

            پیش از این هر دکمهٔ هر سطر `disabled={busy}` داشت، پس هر
            سطر به `busy` وابسته بود و `React.memo` هیچ اثری نداشت:
            هر اسکن، هر ۲۰۰ سطر را دوباره Render می‌کرد. اندازه‌گیری،
            نه فرض — سهم شبکه و سرور با اندازهٔ سبد عوض نمی‌شد و کار
            جاوااسکریپت کلاینت **پنج برابر** می‌شد:

                سبد   کل p50   شبکه+سرور   کلاینت
                  1     61.9        21.1     40.8
                 50    112.6        21.9     90.7   ✗ بودجه ۱۰۰ms
                200    225.1        25.3    199.8   ✗

            `fieldset[disabled]` همهٔ دکمه‌های فرزند را **بومی**
            غیرفعال می‌کند، پس معنای دسترس‌پذیری حفظ می‌شود و هیچ سطری
            به `busy` وابسته نمی‌ماند.
          */}
          <fieldset className="lines-wrap" disabled={busy}>
            <ul className="lines">
              {lines.map((l) => (
                <CartLine
                  key={l.id}
                  line={l}
                  error={lineErrors[l.id]}
                  panel={pricing === l.id ? "price" : discounting === l.id ? "discount" : null}
                  on={rowActions}
                />
              ))}
            </ul>
          </fieldset>
          {lines.length === 0 ? <div className="cart-empty">
            <span className="cart-empty-icon" aria-hidden="true"><Icon name="register" /></span>
            <div>
              <p className="cart-empty-title">سبد خالی است</p>
              <p className="cart-empty-text">بارکد را اسکن کنید یا نام، کد یا بارکد کالا را در کادر بالا جست‌وجو کنید.</p>
              <p className="cart-empty-hint"><Icon name="info" size="sm" /> بارکدخوان بی‌نیاز به کلیک روی کادر کار می‌کند.</p>
            </div>
          </div> : null}

          {invoice ? <GiftPanel invoice={invoice} onChange={setInvoice} /> : null}
        </Solid>

        {/*
          ستون پرداخت — چسبان در دسکتاپ تا نهایی‌سازی همیشه دیده شود. ترتیب جریان
          مبلغ‌ها ← روش پرداخت (کارت‌خوان، اسنپ‌پی|دیجی‌پی، بیشتر) ← ثبت نسیه ← نهایی‌کردن.
          مشتری در ابتدای سبد است و دریافت وجه تابع سیاست جاری الزام شماره است.
        */}
        <Solid as="aside" className="pay" aria-label="پرداخت">
          <h2 className="cart-title">پرداخت و ثبت فاکتور</h2>
          <CheckoutSummary totals={draftActive ? totals : null} />
          {invoice && received > 0n ? <PaymentBreakdown invoiceId={invoice.id} received={received} /> : null}
          <PaymentSelector layout={layout} remaining={totals.remaining} received={received} phase={payPhase}
            disabled={!hasCart || busy || customerGate} onPay={takePayment} onCheck={() => void checkPayment()}
            onRetry={retryPayment} onAbandon={() => void abandonPayment()} />
          <div className="pay-finish">
            {hasCart ? <CreditCheckout allowed={canCredit} customer={linkedCustomer} remaining={totals.remaining} received={received}
              payable={totals.payable} disabled={busy || !payIdle || !policyReady || (invoice?.customerId != null && (linkedCustomer === null || customerMissing))}
              onAttachCustomer={focusCustomer} run={finalize} verify={verifyFinalize} onDone={() => undefined} /> : null}
            <SafeAction trigger="نهایی‌کردن فاکتور" triggerVariant="primary" title="نهایی‌کردن فاکتور"
              disabled={!settled || busy || !payIdle || customerGate}
              summary={<dl className="checkout-lines">
                <div><dt>قابل پرداخت</dt><dd><Money rial={totals.payable} /></dd></div>
                <div><dt>دریافت‌شده</dt><dd><Money rial={received} /></dd></div>
                <div><dt>باقی پول</dt><dd><Money rial={totals.change} size={totals.change > 0n ? "lg" : "md"} /></dd></div>
              </dl>}
              consequence="شمارهٔ فاکتور صادر و کالا از انبار خارج می‌شود. پس از آن اصلاح فقط با مرجوعی ممکن است."
              confirmLabel="تأیید و نهایی‌کردن" pendingLabel="در حال نهایی‌سازی…"
              run={finalize} verify={verifyFinalize} onDone={() => undefined} />
            {customerMissing && hasCart ? <button type="button" className="btn" onClick={focusCustomer}>ثبت شماره مشتری</button> : null}
            <p className="field-hint pay-finish-why">{!policyReady ? "دریافت وجه پس از خواندن تنظیمات صندوق باز می‌شود."
              : customerMissing ? "برای ادامه، شماره مشتری را ثبت کنید."
              : !hasCart ? "برای نهایی‌کردن، ابتدا کالا به سبد اضافه کنید."
              : !payIdle ? "تا نتیجهٔ پرداخت روشن نشود، نهایی‌کردن بسته است."
                : !settled ? "نهایی‌کردن پس از دریافت کامل مانده باز می‌شود." : "همهٔ مبلغ دریافت شده است؛ فاکتور را نهایی کنید."}</p>
          </div>
        </Solid>
      </div>}
    </div>
  );
}

/** انتخاب شعبه و انبار — فقط وقتی بیش از یکی باشد. */
/**
 * «خرید برای خودم یا برای دیگری؟» و بسته‌بندی هدیه.
 *
 * ── چرا بسته و پیش‌فرض خاموش ───────────────────────────────────────
 *
 * بیشتر فروش‌ها هدیه نیستند. اگر این پنل همیشه باز باشد، صندوق‌دار
 * هر بار از کنارش رد می‌شود و صف می‌ایستد — همان دلیلی که ورودی
 * شماره مشتری هم پایین سبد است، نه بالای صفحه.
 *
 * ── این کامپوننت هیچ کاغذ و رنگی را نمی‌شناسد ──────────────────────
 *
 * فهرست از `GET /gift-options` می‌آید. فروشگاه امسال سه رنگ کاغذ
 * دارد و سال بعد پنج تا؛ افزودنش یک `INSERT` در Seed است.
 */
function GiftPanel({
  invoice,
  onChange,
}: {
  invoice: Invoice;
  onChange: (inv: Invoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<
    Array<{ code: string; kind: string; label: string; price: string }>
  >([]);
  const [recipient, setRecipient] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [wrap, setWrap] = useState(invoice.gift?.wrapCode ?? "");
  const [color, setColor] = useState(invoice.gift?.colorCode ?? "");
  const [flower, setFlower] = useState(invoice.gift?.flowerCode ?? "");
  const [note, setNote] = useState(invoice.gift?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || options.length > 0) return;
    let alive = true;
    void (async () => {
      try {
        const r = await pos.giftOptions();
        if (alive) setOptions(r.options);
      } catch (err) {
        if (alive) setError(message(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, options.length]);

  const of = (kind: string) => options.filter((o) => o.kind === kind);

  async function run(fn: () => Promise<Invoice>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      // پیام نگهبان دیتابیس فارسی و برای کاربر است — همان را نشان
      // می‌دهیم، نه یک «خطا» عمومی.
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="row" style={{ gap: "var(--s-2)" }}>
        <button type="button" className="btn btn--quiet" onClick={() => setOpen(true)}>
          🎁 خرید برای دیگری یا هدیه
        </button>
        {invoice.recipientId !== null || invoice.gift !== null ? (
          <span className="pill">
            <span aria-hidden="true">✓</span>{" "}
            {invoice.recipientId !== null && invoice.gift !== null
              ? "گیرنده و بسته ثبت شد"
              : invoice.recipientId !== null
                ? "گیرنده ثبت شد"
                : "بسته هدیه ثبت شد"}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
      <div className="row between">
        <strong style={{ fontSize: ".95rem" }}>خرید برای دیگری و هدیه</strong>
        <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
          بستن
        </button>
      </div>

      {/*
        گیرنده — یک مشتری واقعی می‌شود، نه چند ستون روی فاکتور. پس
        اندازه‌هایش در پرونده خودش می‌نشیند و سال بعد که خودش آمد،
        پیدا می‌شود.
      */}
      <div className="filters">
        <label className="auth-field">
          <span>موبایل گیرنده</span>
          <input
            type="text"
            inputMode="numeric"
            className="num"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="اختیاری"
            disabled={busy}
          />
        </label>
        <label className="auth-field">
          <span>نام گیرنده</span>
          <input
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || normalizeDigits(recipient).trim() === ""}
          onClick={() =>
            void run(() =>
              pos.setRecipient(invoice.id, {
                mobile: normalizeDigits(recipient).trim(),
                ...(recipientName.trim() === "" ? {} : { fullName: recipientName.trim() }),
              }),
            )
          }
        >
          ثبت گیرنده
        </button>
        {invoice.recipientId !== null ? (
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy}
            onClick={() => void run(() => pos.setRecipient(invoice.id, { mobile: null }))}
          >
            حذف گیرنده
          </button>
        ) : null}
      </div>

      <div className="filters">
        {[
          ["wrap", "شیوه بسته‌بندی", wrap, setWrap] as const,
          ["color", "رنگ بسته", color, setColor] as const,
          ["flower", "گل همراه", flower, setFlower] as const,
        ].map(([kind, label, value, set]) => (
          <label key={kind} className="auth-field">
            <span>{label}</span>
            <select
              className="set-input"
              value={value}
              disabled={busy}
              onChange={(e) => set(e.target.value)}
            >
              <option value="">—</option>
              {of(kind).map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <label className="auth-field">
        <span>یادداشت روی کارت</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          disabled={busy}
          placeholder="اختیاری — روی کارت چاپ می‌شود"
        />
      </label>

      <div className="row" style={{ gap: "var(--s-2)" }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() =>
            void run(() =>
              pos.setGift(invoice.id, {
                wrapCode: wrap === "" ? null : wrap,
                colorCode: color === "" ? null : color,
                flowerCode: flower === "" ? null : flower,
                note: note.trim() === "" ? null : note.trim(),
              }),
            )
          }
        >
          ثبت بسته هدیه
        </button>
        {invoice.gift !== null ? (
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy}
            onClick={() => void run(() => pos.setGift(invoice.id, { isGift: false }))}
          >
            هدیه نیست
          </button>
        ) : null}
        {error !== null ? (
          <span className="set-msg set-msg--crit" role="alert">
            <span aria-hidden="true">⚠</span> {error}
          </span>
        ) : null}
      </div>

      {/*
        قیمت روی برگه هدیه پیش‌فرض پنهان است — درخواست همیشگی خریدار
        هدیه. اینجا فقط گفته می‌شود، چون تصمیمش در سرور پیش‌فرض دارد
        و کسی که بخواهد عوضش کند نادر است.
      */}
      <p className="muted small" style={{ margin: 0 }}>
        قیمت روی برگه هدیه چاپ نمی‌شود.
      </p>
    </Solid>
  );
}

function SetupPanel({
  branches,
  branchId,
  onPick,
}: {
  branches: Branch[];
  branchId: string;
  onPick: (branchId: string, warehouseId: string) => void;
}) {
  const picked = branches.find((b) => b.id === branchId) ?? null;
  return (
    <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
      <h2 style={{ margin: 0 }}>شعبه و انبار</h2>
      <div className="stack" style={{ gap: "var(--s-2)" }}>
        {branches.map((b) => (
          <button
            key={b.id}
            type="button"
            className={b.id === branchId ? "btn btn--primary" : "btn"}
            onClick={() => onPick(b.id, defaultWarehouse(b)?.id ?? "")}
          >
            {b.name} <span className="muted small">{b.code}</span>
          </button>
        ))}
      </div>
      {picked && picked.warehouses.length > 1 ? (
        <>
          <h3 style={{ margin: 0 }}>انبار</h3>
          <div className="stack" style={{ gap: "var(--s-2)" }}>
            {picked.warehouses.map((w) => (
              <button
                key={w.id}
                type="button"
                className="btn"
                onClick={() => onPick(picked.id, w.id)}
              >
                {w.name} <span className="muted small">{w.code}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </Solid>
  );
}

/** باز کردن شیفت — بدون آن هیچ فروشی ثبت نمی‌شود. */
function OpenShiftPanel({
  branch,
  busy,
  error,
  onOpen,
}: {
  branch: Branch | null;
  busy: boolean;
  error: string | null;
  onOpen: (openingCash: string) => void;
}) {
  const [cash, setCash] = useState("0");
  const rial = rialFromTomanInput(cash);
  return (
    <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
      <h2 style={{ margin: 0 }}>شیفت باز نیست</h2>
      <p className="muted" style={{ margin: 0 }}>
        {branch?.name} — موجودی ابتدای کشو را وارد کنید.
      </p>
      <label className="auth-field">
        <span>موجودی اولیه (تومان)</span>
        {/* `type="text"` نه `number`: صفحه‌کلید فارسی «۱۵۰۰۰» می‌فرستد
            و ورودی عددی مرورگر آن را دور می‌اندازد. */}
        <input
          type="text"
          inputMode="numeric"
          value={cash}
          onChange={(e) => setCash(e.target.value)}
        />
      </label>
      {error ? (
        <p className="auth-error" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || rial === null}
        onClick={() => rial !== null && onOpen(rial.toString())}
      >
        {busy ? "…" : "باز کردن شیفت"}
      </button>
    </Solid>
  );
}

/**
 * ورودی دستی بارکد.
 *
 * اسکنر از راه شنونده سراسری کار می‌کند و این فیلد لازمش ندارد؛ ولی
 * برچسب خط‌خورده و موبایلِ بدون دوربین باید راهی داشته باشند.
 */

function CloseShiftPanel({
  busy,
  openCart,
  onClose,
  onCancel,
}: {
  busy: boolean;
  openCart: boolean;
  onClose: (countedCash: string, note: string) => void;
  onCancel: () => void;
}) {
  const [cash, setCash] = useState("");
  const [text, setText] = useState("");
  const rial = rialFromTomanInput(cash);

  return (
    <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
      <h2 style={{ margin: 0 }}>بستن شیفت</h2>
      {openCart ? (
        <p className="auth-error" role="alert">
          <span className="dot dot--warn" aria-hidden="true">●</span> سبد باز دارید. تا
          نهایی‌سازی یا رها کردنش، شیفت بسته نمی‌شود.
        </p>
      ) : null}
      <label className="auth-field">
        <span>پول شمرده‌شده در کشو (تومان)</span>
        <input
          type="text"
          inputMode="numeric"
          value={cash}
          onChange={(e) => setCash(e.target.value)}
          autoFocus
        />
      </label>
      <label className="auth-field">
        <span>توضیح (اختیاری)</span>
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || rial === null}
        onClick={() => rial !== null && onClose(rial.toString(), text.trim())}
      >
        {busy ? "…" : "بستن و شمارش"}
      </button>
      <button type="button" className="btn btn--quiet" onClick={onCancel} disabled={busy}>
        انصراف
      </button>
    </Solid>
  );
}

/**
 * تخفیف یک سطر.
 *
 * سقفش اینجا **سنجیده نمی‌شود**: نردبان `sale.discount` →
 * `sale.discount_high` در `permission_rule` است و سرور با همان
 * دروازه‌ای می‌سنجدش که افزودن قلم را. کپی‌کردن آستانه‌ها در UI یعنی
 * دو تعریف — و آن‌که عقب می‌ماند همان است که دور زده می‌شود.
 *
 * تنها چیزی که اینجا سنجیده می‌شود «بیشتر از مبلغ خودِ قلم نباشد»
 * است، و آن هم فقط برای اینکه کاربر پیش از کلیک بفهمد. سرور و
 * دیتابیس هر دو دوباره می‌سنجندش.
 */
/**
 * قیمت دستی روی یک سطر — «مثل دشت».
 *
 * ── چرا قیمت واحد، نه مبلغ سطر ────────────────────────────────────
 *
 * صندوق‌دار قیمتی را می‌نویسد که روی برچسب یا در ذهن مشتری است، و آن
 * قیمت **یک عدد** است نه جمع دو تا. اگر مبلغ سطر گرفته می‌شد، برای
 * تعداد ۳ باید تقسیم می‌کردیم — و تقسیم ریالی باقی‌مانده دارد که یا
 * روی یک قلم می‌نشیند یا گم می‌شود.
 *
 * ── چه چیزی اینجا سنجیده **نمی‌شود** ──────────────────────────────
 *
 * سقف کاهش، مجوز `sale.price_override` و اجبار ثبت دلیل. هر سه سرور
 * و دیتابیس‌اند. تکرارشان اینجا یعنی دو تعریف از یک قاعده مالی، و
 * آنکه عقب می‌ماند همان است که دور زده می‌شود. تنها چیزی که این فرم
 * می‌داند: قیمت باید عددی مثبت باشد.
 *
 * ورودی `type="text"` است نه `type="number"` — صفحه‌کلید فارسی «۴۸»
 * می‌فرستد و ورودی عددی مرورگر آن را دور می‌اندازد.
 */
function PricePanel({
  unitPrice,
  listPrice,
  busy,
  onApply,
  onCancel,
}: {
  unitPrice: bigint;
  listPrice: bigint | null;
  busy: boolean;
  onApply: (price: bigint, why: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(toman(unitPrice).replace(/٬/g, ""));
  const [why, setWhy] = useState("");
  const rial = amount.trim() === "" ? null : rialFromTomanInput(amount);
  const bad = rial === null || rial <= 0n;

  return (
    <div className="line-panel" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
    <Solid className="line-discount stack" style={{ gap: "var(--s-2)" }}>
      <label className="auth-field">
        <span>
          قیمت واحد (تومان)
          {listPrice === null ? null : <> — قیمت فهرست <Money rial={listPrice} size="sm" /></>}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
      </label>
      <label className="auth-field">
        <span>دلیل — بالای آستانه اجباری است</span>
        <input value={why} onChange={(e) => setWhy(e.target.value)} />
      </label>
      {bad && amount.trim() !== "" ? (
        <p className="auth-error" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> قیمت باید عددی بزرگ‌تر
          از صفر باشد.
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || bad}
        onClick={() => rial !== null && rial > 0n && onApply(rial, why)}
      >
        ثبت قیمت
      </button>
      {/*
        برگرداندن به فهرست همان مسیر است — سرور با دیدنِ قیمت فهرست،
        Snapshot و دلیل را پاک می‌کند. دکمه جدا لازم است چون
        صندوق‌داری که اشتباه تایپ کرده، عدد اصلی را از حفظ نمی‌داند.
      */}
      {listPrice === null ? null : (
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={() => onApply(listPrice, "")}
        >
          برگرداندن به قیمت فهرست
        </button>
      )}
      <button type="button" className="btn btn--quiet" onClick={onCancel} disabled={busy}>
        انصراف
      </button>
    </Solid>
    </div>
  );
}

function DiscountPanel({
  gross,
  current,
  busy,
  onApply,
  onCancel,
}: {
  gross: bigint;
  current: bigint;
  busy: boolean;
  onApply: (amount: bigint, why: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(current > 0n ? toman(current).replace(/٬/g, "") : "");
  const [why, setWhy] = useState("");
  const rial = amount.trim() === "" ? 0n : rialFromTomanInput(amount);
  const tooBig = rial !== null && rial > gross;

  return (
    <div className="line-panel" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
    <Solid className="line-discount stack" style={{ gap: "var(--s-2)" }}>
      <label className="auth-field">
        <span>تخفیف (تومان) — حداکثر <Money rial={gross} size="sm" /></span>
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
      </label>
      <label className="auth-field">
        <span>دلیل — بالای آستانه اجباری است</span>
        <input value={why} onChange={(e) => setWhy(e.target.value)} />
      </label>
      {tooBig ? (
        <p className="auth-error" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> تخفیف از مبلغ خودِ قلم
          بیشتر است.
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || rial === null || tooBig}
        onClick={() => rial !== null && !tooBig && onApply(rial, why)}
      >
        اعمال تخفیف
      </button>
      <button type="button" className="btn btn--quiet" onClick={onCancel} disabled={busy}>
        انصراف
      </button>
    </Solid>
    </div>
  );
}

function DraftRefundPanel({ payments, busy, onCancel, onConfirm }: {
  payments: DraftPayment[]; busy: boolean; onCancel: () => void;
  onConfirm: (reason: string, ref: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const external = payments.some((p) => ["card_reader", "gateway", "transfer"].includes(p.kind));
  const blocked = payments.some((p) => p.status !== "succeeded" || p.direction !== "in" ||
    p.settlement_id !== null || p.settled_at !== null || parseRial(p.fee_amount) !== 0n);
  return <section role="region" aria-label="برگشت پرداخت پیش‌نویس"><Solid className="pad">
    <h3>برگشت پرداخت و لغو پیش‌نویس</h3>
    <p>این عملیات پرداخت بانکی انجام نمی‌دهد. وجه نقد را به مشتری برگردانید؛ برای پرداخت بانکی، ابتدا برگشت را در بانک انجام دهید. رزرو اعتبار مشتری آزاد می‌شود.</p>
    <ul>{payments.map((p) => <li key={p.id}>{p.name}: <Money rial={p.amount} /></li>)}</ul>
    {blocked ? <p role="alert">پرداخت نامشخص یا تسویه‌شده نیازمند بررسی حسابدار است و از این مسیر برگشت نمی‌خورد.</p> : null}
    <label className="auth-field">دلیل برگشت<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
    {external ? <label className="auth-field">شماره پیگیری برگشت بانکی<input value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} /></label> : null}
    <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />برگشت وجه لازم را انجام داده‌ام و لغو این پیش‌نویس را تأیید می‌کنم.</label>
    <button type="button" className="btn btn--primary" disabled={busy || blocked || !confirmed || reason.trim().length < 3 || (external && !ref.trim())}
      onClick={() => onConfirm(reason.trim(), ref)}>ثبت برگشت و لغو پیش‌نویس</button>
    <button type="button" className="btn btn--quiet" disabled={busy} onClick={onCancel}>انصراف</button>
  </Solid></section>;
}
