import { DraftRefundPanel } from "../components/pos/DraftRefundPanel.tsx";
import { AmountInput } from "../components/ui/AmountInput.tsx";
import { Dialog } from "../components/ui/Dialog.tsx";
import { Field, Segmented } from "../components/ui/Controls.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { Note } from "../components/ui/Note.tsx";
import { useUrlState, navigate } from "../lib/use-url-state.ts";
import { readPendingScan, appendScans, bindScanCart, clearPendingScan, type PendingScan } from "../lib/pending-scan.ts";
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
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CameraScan } from "../components/CameraScan.tsx";
import { PosProductPicker } from "../components/PosProductPicker.tsx";
import { PaymentBreakdown } from "../components/PaymentBreakdown.tsx";
import { Solid } from "../components/Glass.tsx";
import { Icon } from "../components/Icon.tsx";
import { api, ApiError } from "../lib/api.ts";
import { ActionKeys, ScanCounter } from "../lib/action-key.ts";
import { canFinalize, lineGross, steppedQty } from "../lib/cart.ts";
import { exactTomanInput, parseRial, rialFromExactTomanInput, rialFromTomanInput, toman } from "../lib/money.ts";
import { Money } from "../components/ui/Money.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { PaymentSelector } from "../components/pos/PaymentSelector.tsx";
import { CheckoutSummary } from "../components/pos/CheckoutSummary.tsx";
import { CustomerSummary } from "../components/pos/CustomerSummary.tsx";
import { CreditCheckout } from "../components/pos/CreditCheckout.tsx";
import { SaleComplete, type CompletedSale } from "../components/pos/SaleComplete.tsx";
import { printReceipt } from "../lib/receipt-print.ts";
import { cartCounts, checkoutErrorMessage, checkoutTotals, finalAmounts, intentFromPending, intentToPending, paymentBody,
  paymentFailureKind, paymentLayout, resolveIntentStatus, type PaymentIntent, type PaymentOption, type PaymentPhase,
  type UnresolvedReason } from "../lib/pos-payments.ts";
import { clearPendingPayment, readPendingPayment, writePendingPayment, type PendingPayment } from "../lib/pending-payment.ts";
import { formatCount, formatJalaliMoment, formatQty } from "../lib/format.ts";
import { formatClock } from "../lib/dashboard-freshness.ts";
import { StatusBadge } from "../components/ui/Status.tsx";
import { quantityUnits, saleQuantity } from "../lib/sale-quantity.ts";
import { session } from "../lib/session.ts";
import { people } from "../lib/people.ts";
import { isNetworkFailure } from "../lib/offline-queue.ts";
import { forgetCart, readCart, rememberCart } from "../lib/open-cart.ts";
import { pendingLabel, saleQueue, summarize, type PendingSummary } from "../lib/sale-queue.ts";
import { pos, type Branch, type Invoice, type InvoiceCustomer, type PaymentIntentStatus, type InvoiceLine, type PaymentMethod, type DraftPayment, type Shift } from "../lib/pos.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { onSettingSaved } from "../lib/settings-events.ts";
import { ScanBuffer, retractLeak, snapshotField, type FieldSnapshot } from "../lib/scanner.ts";

function message(err: unknown): string {
  if (err instanceof ApiError || (err instanceof Error && /^[آ-ی]/u.test(err.message))) return err.message;
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
  setQty: (lineId: string, qty: string) => void;
  changeQty: (lineId: string, current: string, delta: number) => void;
  remove: (lineId: string) => void;
  applyPrice: (lineId: string, priceRial: bigint, why: string) => void;
  applyDiscount: (lineId: string, amountRial: bigint, why: string) => void;
  openPrice: (lineId: string) => void;
  openDiscount: (lineId: string) => void;
  closePanels: () => void;
}

function sameLine(a: Readonly<CartLineProps>, b: Readonly<CartLineProps>): boolean {
  if (a.panel !== b.panel || a.on !== b.on || a.error !== b.error || a.allowFractional !== b.allowFractional) return false;
  const x = a.line;
  const y = b.line;
  return (
    x.id === y.id &&
    x.productName === y.productName &&
    x.sku === y.sku && x.color === y.color && x.size === y.size &&
    x.qty === y.qty &&
    x.unitPrice === y.unitPrice &&
    x.listPrice === y.listPrice &&
    x.discountAmount === y.discountAmount &&
    x.netAmount === y.netAmount
  );
}

interface CartLineProps {
  allowFractional: boolean;
  line: InvoiceLine;
  error?: string | undefined;
  /** پنل بازِ همین سطر — یا هیچ. */
  panel: "price" | "discount" | null;
  /** دیسپچر **پایدار**؛ اگر هر Render تازه ساخته شود، memo بی‌اثر است. */
  on: RowActions;
}

function QuantityInput({ qty, name, disabled, apply }: { qty: string; name: string; disabled: boolean; apply: (qty: string) => void }) {
  const [value, setValue] = useState(qty);
  useEffect(() => { setValue(qty); }, [qty]);
  const parsed = saleQuantity(value, true);
  const changed = parsed !== saleQuantity(qty, true);
  return <label>تعداد
    <input aria-label={`تعداد ${name}`} dir="ltr" inputMode="decimal" value={value} disabled={disabled}
      onChange={e => setValue(e.target.value)} style={{ width: "6rem" }} />
    {value !== qty ? <button type="button" disabled={disabled || parsed === null || !changed}
      onClick={() => { if (parsed !== null) apply(parsed); }}>ثبت تعداد</button> : null}
    {parsed === null ? <span role="alert">تعداد مثبت با حداکثر سه رقم اعشار وارد کنید.</span> : null}
  </label>;
}

const CartLine = memo(function CartLine({ line: l, panel, on, error, allowFractional }: CartLineProps) {
  const locked = adjusted(l);
  const legacyFraction = !allowFractional && (quantityUnits(l.qty) ?? 0n) % 1000n !== 0n;
  return (
    <li>
      <div className="line-name">
        <strong>{l.productName}</strong>
        <span className="muted small">
          {/* کد کالا عمداً در سبد نیست (تصمیم مالک، pos-usability) — شرح و رنگ و سایز کافی است. */}
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
      </div>
      {/* طرح ۱۰: رنگ و سایز تراشه‌اند، در ستون خودشان. */}
      <div className="line-variant">
        {l.color ? <span className="line-chip">{l.color}</span> : null}
        {l.size ? <span className="line-chip line-chip--size">{l.size}</span> : null}
      </div>
      <div className="line-unit">
        <button type="button" className="line-unit-edit" aria-label={`ویرایش قیمت ${l.productName}`}
          aria-expanded={panel === "price"} onClick={() => on.openPrice(l.id)}>
          <span className="line-unit-label">قیمت واحد</span> <Money rial={l.unitPrice} size="sm" /> <span className="line-unit-action">ویرایش</span>
        </button>
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
          disabled={locked || legacyFraction}
          title={locked ? QTY_LOCKED : undefined}
        >
          −
        </button>
        {/* بی aria-live: اعلام زندهٔ هر سطر صفحه‌خوان را پرحرف می‌کرد. یک ناحیهٔ
            زنده برای کل صندوق هست (قابل پرداخت، مانده، وضعیت). */}
        {allowFractional ? <QuantityInput qty={l.qty} name={l.productName} disabled={locked} apply={qty => on.setQty(l.id, qty)} />
          : <span className="num">{formatQty(l.qty)}</span>}
        <button
          type="button"
          onClick={() => on.changeQty(l.id, l.qty, 1)}
          aria-label={`اضافه کردن ${l.productName}`}
          disabled={locked || legacyFraction}
          title={locked ? QTY_LOCKED : undefined}
        >
          +
        </button>
      </div>
      {legacyFraction ? <p className="field-hint">تعداد اعشاری قبلی حفظ شده است؛ تغییر آن نیازمند فعال‌کردن فروش اعشاری در تنظیمات است.</p> : null}
      <div className="line-total"><span className="line-total-label">جمع ردیف</span><Money rial={l.netAmount} /></div>
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

/** حالت صندوق: فروش حضوری با شیفت، یا فروش اینستاگرام بی شیفت (مهاجرت ۱۰۵). */
export type PosMode = "store" | "instagram";

/**
 * زمینهٔ فروش اینستاگرام — به‌جای شیفت.
 *
 * فروش اینستاگرام کشوی نقد ندارد و روی هیچ شیفتی نمی‌نشیند (`shift_id` تهی؛ دوره ثبتش
 * channel_day/instagram است). ولی صندوق هر سبد، اسکن معلق و پرداخت معلق را به یک «زمینه»
 * گره می‌زند تا سبد زمینهٔ دیگری به آن نچسبد. این زمینه **شناسهٔ شعبه** است: یک UUID پایدار
 * که هرگز با شناسهٔ یک شیفت برابر نمی‌شود. هیچ‌جا به سرور فرستاده نمی‌شود.
 */
function instagramContext(branchId: string, actorId: string): Shift {
  return { id: branchId, branchId, userId: actorId, openedAt: "", openingCash: "0", closedAt: null,
    countedCash: null, expectedCash: null, variance: null, status: "open" };
}

/** کلید زمینهٔ یک فاکتور: شیفتش، یا برای فروش اینستاگرام شعبه‌اش؛ هیچ‌کدام یعنی ناشناخته. */
function contextKey(inv: Invoice): string | null {
  return inv.shiftId ?? (inv.channel === "instagram" ? inv.branchId : null);
}

/**
 * صندوق — حالت را از مجوز سرور می‌خواند، نه از نقش.
 *
 * `sale.create` صندوق فروشگاه است و `instagram.pos.sell` حالت اینستاگرام. کسی که فقط دومی
 * را دارد (اپراتور اینستاگرام) مستقیم به حالت اینستاگرام می‌رود و دکمهٔ تغییر حالت نمی‌بیند؛
 * کسی که هر دو را دارد (مدیر) پیش‌فرض صندوق فروشگاه است و با `pos.mode=instagram` عوض می‌کند.
 * هر حالت یک نمونهٔ جدا (`key`) است، پس سبد، کلیدها و قصدهای یک حالت به دیگری نمی‌رسند.
 * دروازهٔ واقعی همچنان سرور است: کانال در `POST /invoices` و Trigger مهاجرت ۱۰۵ تعیین می‌شود.
 */
export function Pos({ actorId }: { actorId: string }) {
  const [access, setAccess] = useState<{ store: boolean; instagram: boolean } | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [modeParam, setModeParam] = useUrlState("pos.mode");
  useEffect(() => {
    let alive = true;
    setAccessError(null);
    void Promise.all([session.can("sale.create"), session.can("instagram.pos.sell")])
      .then(([store, ig]) => { if (alive) setAccess({ store: store.verdict === "allow", instagram: ig.verdict === "allow" }); })
      .catch((err: unknown) => { if (alive) setAccessError(message(err)); });
    return () => { alive = false; };
  }, [attempt]);
  if (accessError) return <Solid className="pad"><p role="alert">دسترسی صندوق خوانده نشد: {accessError}</p>
    <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>بررسی دوباره</button></Solid>;
  if (!access) return <Solid className="pad">در حال بارگذاری…</Solid>;
  // «نامعلوم» حالت نمی‌سازد: فقط allow صریح. بی هیچ‌کدام، صفحهٔ صندوق فروشگاه با رد سرور می‌ماند.
  const mode: PosMode = access.instagram && (!access.store || modeParam === "instagram") ? "instagram" : "store";
  const onMode = access.store && access.instagram ? (next: PosMode) => setModeParam(next === "instagram" ? "instagram" : "") : null;
  // فهرست فاکتورها (`requireInvoiceRead`) برای نقش محدود اینستاگرام بسته است؛ پیوندش هم نشان داده نمی‌شود.
  return <PosScreen key={mode} actorId={actorId} mode={mode} onMode={onMode} browseInvoices={access.store} />;
}

function PosScreen({ actorId, mode, onMode, browseInvoices }: {
  actorId: string; mode: PosMode; onMode: ((next: PosMode) => void) | null; browseInvoices: boolean;
}) {
  const instagram = mode === "instagram";
  const [branches, setBranches] = useState<Branch[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [policy, setPolicy] = useState<{ branchId: string; requireCustomer: boolean; creditEnabled?: boolean; allowFractionalQty?: boolean } | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyRetry, setPolicyRetry] = useState(0);
  const [branchId, setBranchId] = useUrlState("pos.branch");
  const [warehouseId, setWarehouseId] = useUrlState("pos.warehouse");
  const [shift, setShift] = useState<Shift | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [received, setReceived] = useState(0n);
  /** فروش تمام‌شده — تا «فروش بعدی» روی صفحه می‌ماند (Batch 2.1). */
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const [printOnComplete, setPrintOnComplete] = useState(false);
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
  const [proformaPrinting, setProformaPrinting] = useState(false);
  const proformaJob = useRef<AbortController | null>(null);
  useEffect(() => () => proformaJob.current?.abort(), [invoice?.id]);
  const busy = working || proformaPrinting || pendingScan !== null || scanStorageError !== null || paymentStoreError !== null;
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
  /** موجودی اول با شمارش پایان شیفت قبل نخواند؛ فرم باز کردن، دلیل می‌خواهد. */
  const [openingMismatch, setOpeningMismatch] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftRefund, setDraftRefund] = useState<{ invoiceId: string; payments: DraftPayment[] } | null>(null);
  const [discounting, setDiscounting] = useState<string | null>(null);
  const [pricing, setPricing] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
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
  /**
   * وعدهٔ بازیابی پیش‌نویس. `ensureInvoice` پیش از ساختن فاکتور تازه منتظرش می‌ماند و اگر پیش‌نویس
   * برگشته بود همان را می‌گیرد. فقط کنارگذاشتن عمدی سبد (`dropCart`) یا بازیابی ناموفق پاکش می‌کند.
   */
  const restoring = useRef<Promise<Invoice | null> | null>(null);
  const dropCart = () => { forgetCart(); restoring.current = null; };
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
    // ذخیرهٔ همین تنظیم در تب دیگر؛ تبِ دیده‌شده‌ای که focus نمی‌گیرد هم تازه می‌شود.
    const unsubscribe = onSettingSaved((key) => { if (key === "pos.require_customer" || key === "sales.credit_enabled" || key === "sales.allow_fractional_qty") refresh(); });
    return () => { controller.abort(); window.removeEventListener("focus", refresh); unsubscribe(); };
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

  // شیفت جاری همین کاربر در همین شعبه — یا در حالت اینستاگرام، زمینهٔ بی‌شیفت همان شعبه.
  useEffect(() => {
    if (branchId === "") return;
    if (instagram) { setShift(instagramContext(branchId, actorId)); return; }
    void (async () => {
      try {
        setShift(await pos.currentShift(branchId));
      } catch (err) {
        setError(message(err));
      }
    })();
  }, [branchId, instagram, actorId]);

  /**
   * سبدی که به همین زمینه تعلق دارد: در صندوق فروشگاه همان شیفت؛ در حالت اینستاگرام
   * فاکتور کانال اینستاگرامِ بی‌شیفتِ همین شعبه. یک تعریف، برای بازیابی و اسکن.
   */
  const belongs = useCallback((inv: Invoice, ctx: Shift) => instagram
    ? inv.channel === "instagram" && inv.shiftId === null && inv.branchId === ctx.id
    : inv.channel !== "instagram" && inv.shiftId === ctx.id, [instagram]);

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
    /*
     * ⚠️ تا بازیابی تمام نشده، اسکن نباید فاکتور تازه بسازد. پیش از این، بارکدی که در همان
     *    چند صد میلی‌ثانیهٔ خواندن پیش‌نویس می‌رسید `POST /invoices` می‌زد؛ بعد بازیابی
     *    `setInvoice` را با پیش‌نویس قدیمی جایگزین می‌کرد و قلم اسکن‌شده روی یک پیش‌نویس
     *    یتیم می‌ماند و بی‌صدا از سبد می‌افتاد (CI، webkit-dark-1920). `ensureInvoice` حالا
     *    منتظر همین وعده است و اگر پیش‌نویس برگشت، همان را می‌گیرد.
     */
    let settle: (inv: Invoice | null) => void = () => undefined;
    restoring.current = new Promise<Invoice | null>((resolve) => { settle = resolve; });
    void (async () => {
      let restored: Invoice | null = null;
      try {
        const inv = await pos.invoice(target);
        if (inv.status === "draft" && inv.createdBy === actorId && belongs(inv, shift) && inv.branchId === shift.branchId && shift.userId === actorId && shift.status === "open") {
          restored = inv;
          setInvoice(inv);
          setReceived(parseRial(inv.receivedAmount));
          if (held) {
            rememberCart({ invoiceId: inv.id, shiftId: shift.id });
            setPayPhase({ kind: "unknown", intent: intentFromPending(held), reason: "ambiguous" });
            setNote("پرداختی که نتیجه‌اش روشن نبود با همان شناسه برگردانده شد؛ پیش از هر کاری وضعیتش را بررسی کنید.");
          } else setNote("سبد نیمه‌تمام قبلی برگردانده شد.");
        } else if (held && inv.status === "draft" && inv.createdBy === actorId && (inv.channel === "instagram") !== instagram) {
          // پرداخت نامعلومِ سبدی در حالت دیگر صندوق: نه فراموش، نه حدس — همان حالت باید بررسی‌اش کند.
          setError(`پرداختی که نتیجه‌اش روشن نیست به سبدی در ${instagram ? "صندوق فروشگاه" : "حالت اینستاگرام"} تعلق دارد؛ به همان حالت برگردید و وضعیتش را بررسی کنید.`);
        } else {
          forgetCart();
          // فاکتوری که دیگر پیش‌نویس نیست، اثبات نهایی سرور را دارد؛ همان را می‌پرسیم.
          if (held) await settleIntent(intentFromPending(held), await pos.paymentIntent(held.invoiceId, held.key), "ambiguous");
        }
      } catch (e) {
        setError(message(e));
      } finally {
        settle(restored);
        // ⚠️ بازیابی موفق، وعدهٔ حل‌شده را نگه می‌دارد تا سبد **عمداً** کنار گذاشته شود (`dropCart`).
        //    پاک‌کردن پس از حل یا حتی پس از commit کافی نبود: اسکنی که با بستار پیش از commit می‌رسید
        //    `openDraft` تهی می‌دید و وعده را هم پاک‌شده (CI، chromium-light-1920؛ با لاگ زمان‌دار و
        //    کندسازی ۴ برابر CPU بازتولید شد).
        if (restored === null) restoring.current = null;
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
  const [staff, setStaff] = useState<{key:string; names:{id:string;name:string}[]; selected:string} | null>(null);
  useEffect(() => {
    if (instagram || !shift) return;
    const abort = new AbortController();
    void api.get<{ sellers:{id:string;name:string}[]; sessionId:string }>(`/pos/sellers?branchId=${shift.branchId}`, {signal:abort.signal})
      .then(({sellers, sessionId}) => {
        if (abort.signal.aborted) return;
        const key = `pos-seller:${sessionId}:${shift.id}`;
        const previous = sessionStorage.getItem(key);
        setStaff({key, names:sellers, selected:sellers.some(s => s.id === previous) ? previous! : actorId});
      }).catch(err => { if (!abort.signal.aborted) setError(message(err)); });
    return () => abort.abort();
  }, [actorId, shift, instagram]);
  const currentStaff = shift && staff?.key.endsWith(`:${shift.id}`) ? staff : null;
  const displayedSellerId = invoice ? invoice.sellerId ?? invoice.createdBy ?? "" : currentStaff?.selected ?? "";
  const invoiceSellerName = invoice?.sellerName ?? (!invoice?.sellerId || invoice.sellerId === invoice.createdBy ? invoice?.createdByName : null);
  const sellerInRoster = currentStaff?.names.some(person => person.id === displayedSellerId);
  const sellerForDraft = useCallback(() => {
    if (instagram || !shift) return undefined;
    if (currentStaff) return currentStaff.selected === actorId ? undefined : currentStaff.selected;
    if (Object.keys(sessionStorage).some(k => k.startsWith("pos-seller:") && k.endsWith(`:${shift.id}`)))
      throw new Error("انتخاب ثبت‌کنندهٔ این شیفت در حال بازیابی است. پس از نمایش نام دوباره تلاش کنید.");
    return undefined;
  }, [instagram, shift, currentStaff, actorId]);
  async function changeSeller(id: string) {
    if (!currentStaff || busy) return;
    await guarded(async () => {
      if (invoice) setInvoice(await api.patch<Invoice>(`/invoices/${invoice.id}/seller`, {sellerId:id}));
      sessionStorage.setItem(currentStaff.key,id);
      setStaff({...currentStaff,selected:id});
    });
  }
  const openDraft = invoice && invoice.status === "draft" ? invoice : null;

  /** فاکتور پیش‌نویس، در صورت نبود ساخته می‌شود. */
  const ensureInvoice = useCallback(async (): Promise<Invoice> => {
    if (openDraft) return openDraft;
    // بازیابی در راه: همان پیش‌نویس برگشتی، نه فاکتور دوم (توضیح در اثر بازیابی بالا).
    const pending = restoring.current;
    if (pending) {
      const restored = await pending;
      if (restored) return restored;
    }
    const sellerId = sellerForDraft();
    const created = await keys.current.run(`create:${shift?.id ?? branchId}`, (key) =>
      pos.createInvoice({ branchId, warehouseId, channel: instagram ? "instagram" : "pos", ...(sellerId && {sellerId}) }, { idempotencyKey: key }),
    );
    setInvoice(created);
    setReceived(0n);
    scans.current.reset();
    // شناسه در حافظه مرورگر می‌نشیند تا Reload آن را یتیم نکند.
    if (shift) rememberCart({ invoiceId: created.id, shiftId: shift.id });
    return created;
  }, [openDraft, shift, branchId, warehouseId, instagram, sellerForDraft]);

  const staging = useRef<PendingScan["body"][]>([]);
  const appendToActive = useRef<((body: PendingScan["body"]) => void) | null>(null);
  const addByBarcode = useCallback(async (barcode: string, variationId?: string, retry = false) => {
    const body: PendingScan["body"] = variationId ? {variationId,qty:"1"} : {barcode,qty:"1"};
    if (scanRunning.current) {
      if (retry) return;
      try {
        if (appendToActive.current) appendToActive.current(body);
        else staging.current.push(body);
      } catch (e) { setError(message(e)); }
      return;
    }
    if (!shift || !branchId || !warehouseId || completedRef.current || mutationRunning.current || proformaJob.current ||
        payPhase.kind !== "idle" || paymentStoreError || scanStorageError || (pendingScanRef.current && !retry)) {
      setError("برای اسکن، سبد فعال و نتیجهٔ قطعی عملیات قبلی لازم است."); return;
    }
    scanRunning.current = true;
    if (!retry) staging.current.push(body);
    setBusy(true); setError(null);
    const sync = () => {
      const head = readPendingScan(actorId);
      pendingScanRef.current = head; setPendingScan(head);
      return head;
    };
    try {
      if (!navigator.locks) throw new Error("اتصال امن و مرورگر به‌روز لازم است.");
      await navigator.locks.request(`labelmod-pos:${actorId}`, {ifAvailable:true}, async lock => {
        if (!lock) throw new Error("صندوق در تب دیگری مشغول است؛ اسکن را تکرار کنید.");
        let head = sync();
        if (head && !retry) throw new Error("ابتدا نتیجهٔ اسکن معلق را بررسی کنید.");
        if (!head && retry) throw new Error("اسکن معلق قبلاً رسیدگی شده است.");
        if (head && head.shiftId !== shift.id) throw new Error("صف اسکن متعلق به شیفت دیگری است.");
        if (readPendingPayment(actorId)) throw new Error("ابتدا وضعیت پرداخت قبلی را بررسی کنید.");
        const restoringCart = restoring.current;
        const restoredId = openDraft?.id ?? readCart(shift.id)?.invoiceId;
        if (head && !head.draft && restoredId && restoredId !== head.invoiceId) throw new Error("صف اسکن به سبد دیگری تعلق دارد.");
        let cartId = head?.invoiceId ?? restoredId ?? crypto.randomUUID();
        const sellerId = !head && !restoredId ? sellerForDraft() : undefined;
        let draft = head?.draft ?? (!head && !restoredId ? {branchId, warehouseId, channel: instagram ? "instagram" as const : "pos" as const,
          ...(sellerId && {sellerId})} : undefined);
        const makeScan = (value: PendingScan["body"]): PendingScan => ({actorId,invoiceId:cartId, shiftId:shift.id,
          key:crypto.randomUUID(), body:value, ...(draft && {draft})});
        appendScans(staging.current.map(makeScan)); staging.current = [];
        appendToActive.current = value => { appendScans([makeScan(value)]); sync(); };
        head = sync();
        const restored = openDraft ?? await restoringCart;
        if (restored && (restored.id !== cartId || !belongs(restored,shift) || restored.reviewReason))
          throw new Error("ابتدا پیش‌نویس همین شیفت را ادامه دهید.");
        if (draft) {
          const create = async () => {
            try { return await pos.createInvoice(draft!, {idempotencyKey:cartId}); }
            catch (e) {
              if (!(e instanceof ApiError) || !([400,422].includes(e.status) || ["seller_unavailable","no_open_shift"].includes(e.code))) throw e;
              let count = 0;
              while (head?.draft && head.invoiceId === cartId) {
                clearPendingScan(actorId,head.key); head=sync(); count++;
              }
              throw new Error(`${message(e)} · ${count.toLocaleString("fa-IR")} اسکن در سبد ثبت نشد. پس از اصلاح، دوباره اسکن کنید.`, {cause:e});
            }
          };
          const created = await create();
          if (!belongs(created,shift) || created.status !== "draft") throw new Error("سبد برای اسکن فعال نیست.");
          bindScanCart(actorId,cartId,created.id); cartId = created.id; draft = undefined;
          rememberCart({invoiceId:cartId,shiftId:shift.id}); setInvoice(created);
          head = sync();
        }
        while (head) {
          try {
            const start = performance.now();
            const out = await pos.scan(head.invoiceId,head.body,{idempotencyKey:head.key});
            performance.clearMeasures("pos-scan-commit");
            performance.measure("pos-scan-commit", {start, end:performance.now()});
            if (out.invoice.id !== head.invoiceId) throw new Error("پاسخ اسکن با سبد تطابق ندارد.");
            setInvoice(out.invoice);
          } catch (err) {
            if (err instanceof ApiError && ([400,409,422].includes(err.status) || err.code === "variation_not_found") && err.code !== "idempotency_in_flight") {
              clearPendingScan(actorId,head.key); sync();
            }
            throw err;
          }
          clearPendingScan(actorId,head.key); head = sync();
        }
        appendToActive.current = null;
      });
    } catch (e) { setError(message(e)); }
    finally { staging.current = []; appendToActive.current = null; scanRunning.current = false; setBusy(false); }
  }, [actorId, openDraft, shift, branchId, warehouseId, instagram, sellerForDraft, belongs, scanStorageError, payPhase.kind, paymentStoreError]);

  // ── ستون پرداخت ──────────────────────────────────────────────────
  //
  // ستون دیگر سقف ارتفاع و اسکرول تودرتو ندارد (بازطراحی مصوب مالک): کادر مبلغ زیر یک
  // ناحیهٔ اسکرول کوچک پنهان می‌شد. صفحه خودش اسکرول می‌شود و فقط «نهایی‌کردن» چسبان است.
  // ارتفاع واقعی آن پایان چسبان `--pay-finish-h` می‌شود (scroll-padding سند در workspace.css)،
  // تا فوکوس و scrollIntoView کادر مبلغ را زیر آن نبرند. نوشتن روی ریشهٔ سند اندازهٔ خودِ
  // پایان را عوض نمی‌کند، پس حلقهٔ ResizeObserver ساخته نمی‌شود؛ باز هم به فریم بعد می‌رود.
  useEffect(() => {
    const pos = rootRef.current;
    if (!pos || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // پایان ممکن است بعداً ساخته یا برداشته شود (سبد تازه، فروش تمام‌شده)؛ هر بار از نو پیدا می‌شود.
        const finish = pos.querySelector<HTMLElement>(".pay-finish");
        const h = finish ? `${Math.ceil(finish.getBoundingClientRect().height) + 16}px` : "";
        if (root.style.getPropertyValue("--pay-finish-h") === h) return;
        if (h) root.style.setProperty("--pay-finish-h", h); else root.style.removeProperty("--pay-finish-h");
      });
    });
    observer.observe(pos);
    const finish = pos.querySelector<HTMLElement>(".pay-finish");
    if (finish) observer.observe(finish);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); root.style.removeProperty("--pay-finish-h"); };
  }, [shift, ready, branchId, warehouseId]);

  // ── بارکدخوان ─────────────────────────────────────────────────────
  //
  // در فاز Capture و روی کل سند، نه روی یک ورودی: اسکنر خودش را
  // کیبورد معرفی می‌کند و ممکن است هر جای صفحه فوکوس باشد. تصمیم
  // «اسکن بود یا تایپ» در `ScanBuffer` است و از روی سرعت گرفته
  // می‌شود، نه از روی فوکوس.
  //
  // ⚠️ رقم اول پیش از تشخیص در کادر فوکوس‌دار می‌نشیند. پیش‌تر هیچ‌کس پاکش نمی‌کرد و
  //    «2» (رقم اول بارکد داخلی) در کادر جست‌وجو می‌ماند. حالا وضعیت کادر پیش از رقم اول
  //    نگه داشته و فقط وقتی اسکن **تأیید شد** دقیقاً برگردانده می‌شود (نه با رقم دوم:
  //    دو کلید تند انسانی نباید رقم اولشان پاک شود). کلید نگه‌داشته‌شده (repeat) اسکن نیست.
  //    پایان اسکن فقط پسوند Enter/Tab اسکنر است (تا ۲۵۰ms دیررس). ثبت خودکار با «مکث» عمداً
  //    نیست: پیشوندِ یک اسکن کندشده خودش می‌تواند بارکد معتبر باشد (۲۰۰۰۰۰۰۴ در ۲۰۰۰۰۰۰۴۰۰۰۰۶).
  //    وضعیت در ref است تا بازسازی `addByBarcode` اسکنِ در جریان را گم نکند.
  const scanLeak = useRef<FieldSnapshot | null>(null);
  const addByBarcodeRef = useRef(addByBarcode);
  addByBarcodeRef.current = addByBarcode;
  useEffect(() => {
    if (!shift) return;
    const scanned = (barcode: string) => { retractLeak(scanLeak.current); scanLeak.current = null; void addByBarcodeRef.current(barcode); };
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
      const snap = snapshotField(e.target, e.key);
      const step = buffer.current.push(e.key, e.timeStamp, e.repeat);
      if (step.kind === "consumed") {
        // اسکن در جریان است — نگذار کاراکترها در فیلدی که فوکوس دارد بریزند.
        e.preventDefault();
      } else if (step.kind === "scanned") {
        e.preventDefault();
        scanned(step.barcode);
      } else {
        // رقم اولِ یک اسکن احتمالی: وضعیت کادر را پیش از نشستن آن نگه دار.
        scanLeak.current = buffer.current.pending.length === 1 ? snap : null;
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [shift]);

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
    if (pendingScanRef.current || scanStorageError || paymentStoreError || scanRunning.current || mutationRunning.current || proformaJob.current)
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
        setOpeningMismatch(false);
      } catch (err) {
        // موجودی اول با شمارش پایان شیفت قبل نمی‌خواند (مهاجرت ۱۲۰). این یک
        // حالت فرم است، نه خطا: کادر دلیل و یادداشت هشدار باز می‌شوند. سرور
        // عدد مورد انتظار را نمی‌گوید (شمارش کور).
        if (err instanceof ApiError && err.code === "opening_cash_mismatch") {
          setOpeningMismatch(true);
          return;
        }
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

  /**
   * باز کردن با دلیل اختلاف — سند مغایرت صندوق می‌زند، پس از `SafeAction`
   * می‌گذرد (UI_PATTERNS بند ۵). خطا بالا می‌رود تا پنجره ردّ یا «نامعلوم» را
   * نشان دهد؛ «بررسی وضعیت» شیفت باز همین شعبه را می‌خواند.
   */
  const openShiftWithReason = (openingCash: string, openingNote: string) =>
    exclusive(() => pos.openShift({ branchId, openingCash, openingNote }));
  const openedShift = async (): Promise<Shift | null> => pos.currentShift(branchId);
  const shiftOpened = (opened: Shift) => { setShift(opened); setOpeningMismatch(false); };

  const changeQty = (lineId: string, current: string, delta: number) =>
    guarded(async () => {
      if (!invoice) return;
      const next = steppedQty(current, delta);
      if (next === null && (quantityUnits(current) === null || delta > 0)) throw new Error("تعداد نامعتبر است");
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
  const setQty = (lineId: string, qty: string) => guarded(async () => {
    if (!invoice) return;
    try {
      setInvoice(await pos.setLineQty(invoice.id, lineId, qty));
      setLineErrors(errors => { const next = { ...errors }; delete next[lineId]; return next; });
    } catch (e) { setLineErrors(errors => ({ ...errors, [lineId]: message(e) })); throw e; }
  });
  const live = useRef({ setQty, changeQty, removeLine, applyPrice, applyDiscount,
                        setPricing, setDiscounting });
  live.current = { setQty, changeQty, removeLine, applyPrice, applyDiscount,
                   setPricing, setDiscounting };

  const rowActions = useMemo<RowActions>(
    () => ({
      setQty: (id, qty) => void live.current.setQty(id, qty),
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
  const attachCustomer = (fullName?: string, salutation?: "mr" | "ms", birthDate?: string) =>
    guarded(async () => {
      const m = fullName === undefined ? normalizeDigits(mobile).trim() : nameForMobile;
      if (m === "") return;
      if (!m) return;
      const inv = await ensureInvoice();
      try {
        setInvoice(await pos.attachCustomer(inv.id, { mobile: m, requireNameForNew: true, ...(salutation && { salutation }), ...(birthDate && { birthDate }), ...(fullName === undefined ? {} : { fullName }) }));
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
      const ctxKey = invoice ? contextKey(invoice) : null;
      if (!invoice || invoice.id !== intent.invoiceId || !ctxKey) return;
      if (!retry) {
        if (customerGate) throw new Error(customerMissing ? "پیش از دریافت وجه، شماره مشتری را ثبت کنید." : "ابتدا سیاست صندوق را دوباره بررسی کنید.");
        const other = readPendingPayment(actorId);
        if (other) {
          if (other.invoiceId === invoice.id) setPayPhase({ kind: "unknown", intent: intentFromPending(other), reason: "ambiguous" });
          throw new Error("پرداخت دیگری هنوز تعیین تکلیف نشده است؛ ابتدا وضعیت همان را بررسی کنید.");
        }
        // نوشتن پایدار شرط ارسال است؛ اگر نشد، چیزی فرستاده نمی‌شود.
        writePendingPayment(intentToPending(intent, { actorId, shiftId: ctxKey }, "sending"));
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
        if (paymentFailureKind(err) === "unknown") { holdIntent(intent, "ambiguous", ctxKey); return; }
        if (retry) { holdIntent(intent, "retry_rejected", ctxKey, checkoutErrorMessage(err)); return; }
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

  const takePayment = (option: PaymentOption, amountRial: bigint, refNo: string, drawerShiftId?: string) => {
    if (!invoice || payPhase.kind !== "idle") return;
    void submitPayment({ key: crypto.randomUUID(), invoiceId: invoice.id, methodCode: option.code, methodName: option.name,
      amount: amountRial, refNo, ...(drawerShiftId === undefined ? {} : { drawerShiftId }) }, false);
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
        completeSale(invoice.id, done.number, finalAmounts(done.settlement), null, printOnComplete);
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
          saleContext: invoice.channel === "instagram"
            ? { actorId, invoiceId: invoice.id, branchId: invoice.branchId, shiftId: invoice.branchId, channel: "instagram" }
            : { actorId, invoiceId: invoice.id, branchId: invoice.branchId, shiftId: invoice.shiftId ?? "" },
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
      dropCart();
    });

  /** «آیا نهایی شده؟» — فقط خواندن؛ اگر شده، همان وضعیت موفق نشان داده می‌شود. */
  const verifyFinalize = async () => {
    if (!invoice) return false;
    const fresh = await pos.invoice(invoice.id);
    if (!["finalized", "paid", "partially_returned", "returned"].includes(fresh.status)) return false;
    completeSale(invoice.id, fresh.number, finalAmounts(fresh.settlement), null);
    keys.current.clear(`finalize:${invoice.id}`);
    dropCart();
    return true;
  };

  function completeSale(invoiceId: string, number: string | null, amounts: CompletedSale["amounts"], estimate: CompletedSale["estimate"], printRequested = false) {
    setCompleted({ invoiceId, number, queued: estimate !== null, amounts, estimate, printOnComplete: printRequested });
    setPayPhase({ kind: "idle" });
  }

  /** «فروش بعدی» — تنها جایی که صفحهٔ «ثبت شد» برداشته و سبد تازه می‌شود. */
  const nextSale = () => {
    dropCart();
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
      dropCart();
    });

  const abandon = () =>
    guarded(async () => {
      if (!invoice) return;
      try {
        await pos.cancel(invoice.id, "رها شد");
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "invoice_has_payment") throw err;
        const { payments } = await pos.draftPayments(invoice.id);
        setDraftRefund({ invoiceId: invoice.id, payments:payments.filter(p=>!["failed","reversed"].includes(p.status)) });
        return;
      }
      dropCart();
      setInvoice(null);
      setReceived(0n);
      scans.current.reset();
    });

  const confirmDraftRefund = (reason: string, refundReference: string, payoutMethod: string) => guarded(async () => {
    if (!draftRefund) return;
    const body = { reason, ...(payoutMethod && {payoutMethod}), confirmed: true as const, paymentIds: draftRefund.payments.map((p) => p.id),
      ...(refundReference.trim() ? { refundReference: refundReference.trim() } : {}) };
    await keys.current.run(`refund-draft:${draftRefund.invoiceId}:${JSON.stringify(body)}`, (key) =>
      pos.refundDraft(draftRefund.invoiceId, body, key));
    setDraftRefund(null);
    dropCart(); setInvoice(null); setReceived(0n); scans.current.reset();
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
    // حالت اینستاگرام شیفت باز نمی‌کند؛ زمینه‌اش در همان رندر بعدی ساخته می‌شود.
    if (instagram) return <Solid className="pad">در حال آماده‌سازی فروش اینستاگرام…</Solid>;
    return <OpenShiftPanel busy={busy} error={error} onOpen={openShift} branch={branch} needsReason={openingMismatch}
      onOpenWithReason={openShiftWithReason} openedShift={openedShift} onOpened={shiftOpened} />;
  }

  const lines = invoice?.lines ?? [];
  const counts = cartCounts(lines);
  const countLabel = `${formatCount(counts.lines)} ردیف · ${formatCount(counts.units)} عدد`;
  const totals = checkoutTotals(invoice, received);
  const layout = paymentLayout(methods, { hasCustomer: (invoice?.customerId ?? null) !== null, instagram });
  const hasCart = invoice !== null && lines.length > 0;
  const payIdle = payPhase.kind === "idle";
  // پیش‌فاکتور فقط برای سبد حضوری است (سرور `channel = pos` می‌خواهد).
  const canPrintProforma = !instagram && hasCart && invoice.status === "draft" && !busy && payIdle && completed === null;
  async function printProforma() {
    if (!canPrintProforma || !invoice || proformaJob.current || mutationRunning.current || scanRunning.current || pendingScanRef.current) return;
    const job = new AbortController();
    proformaJob.current = job;
    setProformaPrinting(true); setError(null);
    try { await printReceipt(invoice.id, job.signal, "proforma"); }
    catch (err) { if (!job.signal.aborted) setError(err instanceof Error ? err.message : "چاپ پیش‌فاکتور آغاز نشد."); }
    finally {
      if (proformaJob.current === job) { proformaJob.current = null; setProformaPrinting(false); }
    }
  }
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
    nameForMobile={nameForMobile} onConfirmName={(name, title, dob) => void attachCustomer(name, title, dob)} onCancelName={() => setNameForMobile(null)}
    canManage={canManageCustomer} onSaveName={(name) => void saveCustomerName(name)}
    busy={busy} inputRef={customerInput} />;
  const focusCustomer = () => {
    customerInput.current?.scrollIntoView({ block: "center", behavior: "instant" });
    customerInput.current?.focus();
  };
  const customerEntry = <>
    {!policyReady ? <p className="field-hint" role={policyError ? "alert" : "status"}>
      {policyError ? <>تنظیمات صندوق خوانده نشد؛ دریافت وجه تا بررسی آن بسته است. <button type="button" className="tool" onClick={() => setPolicyRetry((n) => n + 1)}>بررسی دوباره</button></> : "در حال بررسی تنظیمات صندوق…"}
    </p> : customerMissing ? <p className="field-hint">شماره مشتری برای این صندوق الزامی است؛ پیش از دریافت وجه آن را ثبت کنید.</p> : null}
    {customerBlock}
  </>;

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
        {/* طرح ۱۰: عنوان صفحه — تنها h1 صندوق؛ پیش از این صفحه h1 نداشت. */}
        <h1 className="pos-title">صندوق فروش</h1>
        <div className="pos-context">
          {instagram
            ? <span className="pos-shift pos-shift--instagram"><Icon name="sparkle" size="sm" /> فروش اینستاگرام</span>
            : <span className="pos-shift"><span className="dot dot--good" aria-hidden="true">●</span> شیفت باز{shift?.openedAt ? <> · از <span className="nowrap">{formatClock(Date.parse(shift.openedAt))}</span></> : null}</span>}
          {branch ? <span className="pos-branch"><Icon name="store" size="sm" />{branch.name}{(() => { const w = branch.warehouses.find(x => x.id === warehouseId); return w ? ` · ${w.name}` : ""; })()}</span> : null}
          <span className="pill">{countLabel}</span>
        </div>
        <div className="pos-tools">
          {/* طرح ۱۰: دو حالت در یک کلید دوتایی؛ همان شرط پیشین — با سبد باز حالت عوض نمی‌شود. */}
          {onMode ? <div className="pos-mode"><Segmented label="نوع فروش" value={instagram ? "instagram" : "store"}
            options={[{ key: "store", label: "حضوری" }, { key: "instagram", label: "اینستاگرام" }]}
            disabled={busy || !payIdle || draftActive || completed !== null}
            title={draftActive ? "پیش از تغییر حالت، سبد جاری را نهایی، ذخیره یا رها کنید." : undefined}
            onChange={(next) => { if (next !== (instagram ? "instagram" : "store")) onMode(next); }} /></div> : null}
          {/* بی دسترسی به فهرست فاکتور، پیش‌نویس کنارگذاشته راه برگشتی ندارد؛ پس پیوند هم نیست. */}
          {browseInvoices ? <a className="tool" href="/?page=invoices&invoices.status=draft" onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(e.currentTarget.href); }}>
            <Icon name="receipt" size="sm" />پیش‌نویس‌ها</a> : null}
          {instagram ? null : <button type="button" className="tool" disabled={!canPrintProforma} onClick={() => void printProforma()}>
            <Icon name="print" size="sm" />{proformaPrinting ? "در حال آماده‌سازی پیش‌فاکتور…" : "چاپ پیش‌فاکتور"}
          </button>}
          <button type="button" className="tool" ref={toolsTrigger} aria-haspopup="dialog" aria-expanded={toolsOpen} onClick={() => setToolsOpen(true)}>ابزارهای فروش</button>
          <Dialog open={toolsOpen} onClose={() => setToolsOpen(false)} title="ابزارهای فروش" variant="sheet" returnFocus={() => toolsTrigger.current}>
          <div className="pos-tools-list" onClick={e => {
            if ((e.target as HTMLElement).closest("button:enabled, a")) setToolsOpen(false);
          }}>
          {/* بی دسترسی به فهرست فاکتور، پیش‌نویس کنارگذاشته راه برگشتی ندارد؛ پس فقط «رها کردن». */}
          {browseInvoices ? <>
          <button type="button" className="tool" disabled={busy || !invoice || completed !== null || !payIdle} onClick={() => {
            if (!invoice || busy) return;
            void guarded(async () => {
              await api.patch(`/invoices/${invoice.id}/review`, {hold:true,reason:"تعلیق در صندوق"});
              dropCart(); setInvoice(null); setReceived(0n); scans.current.reset();
              setNote("پیش‌نویس معلق شد؛ از فهرست فاکتورها می‌توانید آن را ادامه دهید.");
            });
          }}>تعلیق پیش‌نویس و فروش جدید</button>
          </> : null}
          <button type="button" className="tool" disabled={!hasCart || busy || !payIdle || completed !== null} onClick={() => void abandon()}>
            رها کردن سبد
          </button>
          {/* دوربین فقط وقتی باز می‌شود که کاربر بخواهد — روی دسکتاپ
              با بارکدخوان سیمی، هیچ‌وقت. */}
          <button type="button" className="tool" disabled={completed !== null} onClick={() => setCamera((v) => !v)}>
            {camera ? "بستن دوربین" : "دوربین"}
          </button>
          {instagram ? null : <button type="button" className="tool" disabled={busy || !payIdle} onClick={() => setClosing((v) => !v)}>
            بستن شیفت
          </button>}
          </div>
          </Dialog>
        </div>
      </header>

      {scanStorageError && <p className="solid pos-alert" role="alert">{scanStorageError}</p>}
      {paymentStoreError && <p className="solid pos-alert" role="alert">{paymentStoreError}</p>}
      {pendingScan && !working && <div className="solid pad" role="status">
        <p>نتیجهٔ اسکن هنوز قطعی نیست. برای جلوگیری از ثبت دوباره، ابتدا همین اسکن را تعیین تکلیف کنید.</p>
        <button type="button" className="btn" disabled={!shift || !branchId || !warehouseId || !payIdle || !!scanStorageError || !!paymentStoreError} onClick={() => void addByBarcode("", undefined, true)}>بررسی و تلاش دوبارهٔ همان اسکن</button>
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
        onCancel={() => setDraftRefund(null)} onConfirm={(reason, ref, payout) => void confirmDraftRefund(reason, ref, payout)} /> : null}
      {closing ? (
        <CloseShiftPanel
          busy={busy}
          openCart={lines.length > 0}
          onClose={(cash, n) => void closeShift(cash, n)}
          onCancel={() => setClosing(false)}
        />
      ) : null}

      {completed ? <SaleComplete sale={completed} onNext={nextSale} /> : <div className="pos-body">
        <div className="pos-workspace">
          {/* طرح ۱۰: یک سند — سربرگ فاکتور، مشتری، اقلام (جست‌وجو و جدول) در یک کارت. شماره فقط در ثبت
              نهایی تخصیص می‌یابد؛ تاریخ همان زمان پیش‌نویس در سرور است و پیش از اولین قلم «—». */}
          <div className="pos-doc-head pos-doc-block">
            <span className="pos-doc-icon" aria-hidden="true"><Icon name="receipt" /></span>
            <div className="pos-doc-title">
              <span className="pos-doc-name"><strong>{instagram ? "فاکتور فروش اینستاگرام" : "فاکتور فروش جدید"}</strong>
                {/* این کارت فقط پیش‌نویس را نشان می‌دهد؛ پس از نهایی‌سازی جایش را «فروش ثبت شد» می‌گیرد. */}
                <StatusBadge state="draft" label="پیش‌نویس" /></span>
              <small>شماره پس از ثبت نهایی اختصاص می‌یابد.</small>
            </div>
            <dl className="pos-doc-meta">
              <div><dt>تاریخ فاکتور</dt><dd>{invoice?.occurredAt ? formatJalaliMoment(invoice.occurredAt) : "—"}</dd></div>
              <div><dt>نوع فروش</dt><dd>{instagram ? "اینستاگرام" : "حضوری"}</dd></div>
              {/* نام از سرور (`createdByName`)؛ پیش از اولین قلم پیش‌نویسی نیست و حدس زده نمی‌شود. */}
              <div><dt>ثبت‌کننده</dt><dd>{currentStaff ? <select aria-label="ثبت‌کننده" value={displayedSellerId}
                disabled={busy || !payIdle} onChange={e => void changeSeller(e.target.value)}>
                {!sellerInRoster && <option value={displayedSellerId} disabled>{invoiceSellerName ?? "—"}</option>}
                {currentStaff.names.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select> : invoiceSellerName ?? "—"}</dd></div>
            </dl>
          </div>
          {/* مشتری همیشه باز و پیش از جست‌وجوست؛ اختیاری/الزامی فقط سیاست فروش (`pos.require_customer`) است، نه چیدمان. */}
          <Solid as="section" className="pos-customer-panel" aria-label="مشتری فاکتور">
            <h2 className="cart-title">مشتری فاکتور</h2>
            {customerEntry}
          </Solid>
          <Solid as="section" className="pos-search-card" aria-label="جست‌وجوی کالا">
            <div className="pos-items-head">
              <strong className="pos-items-title">اقلام فاکتور</strong>
              {lines.length ? <span className="cart-count">{countLabel}</span> : null}
              <small className="pos-items-hint"><Icon name="info" size="sm" />اسکن بارکد بی‌نیاز به کلیک روی کادر</small>
            </div>
            <PosProductPicker key={warehouseId} warehouseId={warehouseId} busy={busy} onPick={(id) => addByBarcode("", id)} />
          </Solid>
        <Solid as="section" className="cart" aria-label="سبد خرید">
          {/* طرح ۱۰: سربرگ سند. شماره فقط در ثبت نهایی تخصیص می‌یابد (قاعدهٔ شماره‌گذاری)؛
              تاریخ همان زمان فاکتور پیش‌نویس در سرور است و پیش از اولین قلم «—». */}
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
            {/* سرستون‌ها فقط نمایشی‌اند (هر سطر برچسب‌های دسترس‌پذیر خودش را دارد) و فقط در چیدمان ستونی دیده می‌شوند. */}
            {lines.length ? <div className="lines-head" aria-hidden="true">
              <span>#</span><span>شرح کالا</span><span>رنگ و سایز</span><span>تعداد</span><span>فی واحد</span><span>مبلغ کل</span><span /><span />
            </div> : null}
            <ul className="lines">
              {lines.map((l) => (
                <CartLine
                  allowFractional={policyReady && policy.allowFractionalQty === true}
                  key={l.id}
                  line={l}
                  error={lineErrors[l.id]}
                  panel={pricing === l.id ? "price" : discounting === l.id ? "discount" : null}
                  on={rowActions}
                />
              ))}
            </ul>
            {lines.length ? <p className="lines-foot"><span>{countLabel}</span><span><Icon name="info" size="sm" /> مبالغ به تومان</span></p> : null}
          </fieldset>
          {lines.length === 0 ? <div className="cart-empty">
            <span className="cart-empty-icon" aria-hidden="true"><Icon name="register" /></span>
            <div>
              <p className="cart-empty-title">سبد خالی است</p>
              <p className="cart-empty-text">بارکد را اسکن کنید یا نام، کد یا بارکد کالا را در کادر بالا جست‌وجو کنید.</p>
              <p className="cart-empty-hint"><Icon name="info" size="sm" /> بارکدخوان بی‌نیاز به کلیک روی کادر کار می‌کند.</p>
            </div>
          </div> : null}

        </Solid>
          {invoice ? <div className="pos-gift-card"><GiftPanel invoice={invoice} onChange={setInvoice} /></div> : null}
        </div>

        {/*
          ستون پرداخت — چسبان در دسکتاپ تا نهایی‌سازی همیشه دیده شود. ترتیب جریان
          مبلغ‌ها ← روش پرداخت (کارت‌خوان، اسنپ‌پی|دیجی‌پی، بیشتر) ← ثبت نسیه ← نهایی‌کردن.
          مشتری در کارت بازشوندهٔ مستقل است و دریافت وجه تابع سیاست جاری الزام شماره است.
        */}
        <Solid as="aside" className="pay" aria-label="پرداخت">
          <div className="pay-summary-fixed">
          <div className="pay-head">
            <h2 className="cart-title">تسویه</h2>
            {/* وضعیت دریافت از همان جمع‌های سرور (`totals`)؛ بی سبد هیچ ادعایی نیست. */}
            {draftActive ? totals.received === 0n ? <StatusBadge state="pending" label="پرداخت‌نشده" />
              : totals.remaining > 0n ? <StatusBadge state="active" label="بخشی دریافت شده" />
              : <StatusBadge state="completed" label="دریافت کامل" /> : null}
          </div>
          <CheckoutSummary totals={draftActive ? totals : null} />
          </div>
          <div className="pay-body">
          {invoice && received > 0n ? <PaymentBreakdown invoiceId={invoice.id} received={received} /> : null}
          <PaymentSelector layout={layout} remaining={totals.remaining} received={received} phase={payPhase}
            {...(instagram && branchId ? { cashBranchId: branchId } : {})}
            disabled={!hasCart || busy || customerGate} onPay={takePayment} onCheck={() => void checkPayment()}
            onRetry={retryPayment} onAbandon={() => void abandonPayment()} />
          </div>
          {hasCart ? <label className="receipt-auto"><input type="checkbox" checked={printOnComplete} disabled={busy || !payIdle}
            onChange={e => setPrintOnComplete(e.target.checked)} /> چاپ رسید بلافاصله پس از ثبت</label> : null}
          {/* فقط همین پایان فشرده چسبان است (≥۹۰۰ و ارتفاع کافی)؛ scroll-padding همان ارتفاع، پس کادرِ فوکوس‌شده زیرش نمی‌رود. */}
          <div className="pay-finish">
            {/* فروش اینستاگرام فقط با پرداخت کامل نهایی می‌شود (مهاجرت ۱۰۵)؛ نسیه پیشنهاد نمی‌شود. */}
            {hasCart && !instagram ? <CreditCheckout allowed={canCredit} creditOff={policyReady && policy.creditEnabled === false} customer={linkedCustomer} remaining={totals.remaining} received={received}
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
                : !settled ? <><Money rial={totals.remaining} size="sm" /> هنوز دریافت نشده است؛ نهایی‌کردن پس از دریافت کامل باز می‌شود.</> : "همهٔ مبلغ دریافت شده است؛ فاکتور را نهایی کنید."}</p>
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
  needsReason,
  onOpenWithReason,
  openedShift,
  onOpened,
}: {
  branch: Branch | null;
  busy: boolean;
  error: string | null;
  onOpen: (openingCash: string) => void;
  /** سرور گفت موجودی با شمارش پایان شیفت قبل نمی‌خواند؛ دلیل اجباری است (مهاجرت ۱۲۰). */
  needsReason: boolean;
  onOpenWithReason: (openingCash: string, openingNote: string) => Promise<Shift>;
  openedShift: () => Promise<Shift | null>;
  onOpened: (shift: Shift) => void;
}) {
  const titleId = useId();
  const [cash, setCash] = useState("0");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const opened = useRef<Shift | null>(null);
  const rial = rialFromTomanInput(cash);
  const reasonText = reason.trim();
  const reasonOk = reasonText.length >= 3;
  const amountError = cash.trim() !== "" && rial === null ? "مبلغ معتبر نیست؛ فقط رقم، بدون اعشار." : null;
  const reasonError = needsReason && touched && !reasonOk ? "دلیل اختلاف را بنویسید (دست‌کم ۳ نویسه)." : null;
  return (
    <Solid as="section" className="settings-section" aria-labelledby={titleId}>
      <SectionHeader id={titleId} title="شیفت باز نیست"
        description={`${branch?.name ?? ""} — پول کشو را بشمارید و وارد کنید.`} />
      <div className="settings-form">
        <Field label="موجودی اولیه (تومان)" error={amountError}
          hint={rial !== null ? <>ثبت می‌شود: <Money rial={rial} exact size="sm" /></> : "بدون اعشار؛ رقم فارسی یا لاتین."}>
          {/* `type="text"` نه `number`: صفحه‌کلید فارسی «۱۵۰۰۰» می‌فرستد
              و ورودی عددی مرورگر آن را دور می‌اندازد. */}
          <AmountInput type="text" inputMode="numeric" autoComplete="off" value={cash} onChange={(e) => setCash(e.target.value)} />
        </Field>
        {needsReason ? (
          <>
            {/* شمارش کور: عدد مورد انتظار عمداً نشان داده نمی‌شود. */}
            <Note tone="warn">این مبلغ با شمارش پایان شیفت قبل نمی‌خواند. دوباره بشمارید؛ اگر مبلغ درست است، دلیل اختلاف را بنویسید. اختلاف به‌عنوان مغایرت صندوق در دفتر ثبت می‌شود.</Note>
            <Field label="دلیل اختلاف" error={reasonError} hint="مثلاً «شمارش آخر شب اشتباه بود». حداکثر ۳۰۰ نویسه.">
              <textarea className="set-input" rows={2} maxLength={300} value={reason}
                onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} autoFocus />
            </Field>
          </>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="settings-actions">
          {needsReason ? (
            <SafeAction trigger="باز کردن با ثبت اختلاف" triggerVariant="primary" title="باز کردن شیفت با ثبت اختلاف"
              disabled={busy || rial === null || !reasonOk}
              summary={rial !== null ? <dl className="settings-facts">
                <div><dt>موجودی اولیه</dt><dd><Money rial={rial} exact /></dd></div>
                <div><dt>دلیل اختلاف</dt><dd>{reasonText}</dd></div>
              </dl> : null}
              consequence="اختلاف این مبلغ با شمارش پایان شیفت قبل به‌عنوان «مغایرت صندوق» در دفتر ثبت می‌شود و دلیل شما کنار آن می‌ماند. اصلاحش با حسابدار است."
              confirmLabel="باز کردن شیفت" pendingLabel="در حال باز کردن…"
              run={async () => { if (rial !== null) opened.current = await onOpenWithReason(rial.toString(), reasonText); }}
              verify={async () => { opened.current = await openedShift(); return opened.current !== null; }}
              onDone={() => { if (opened.current) onOpened(opened.current); }} />
          ) : (
            <button type="button" className="btn btn--primary" disabled={busy || rial === null}
              onClick={() => rial !== null && onOpen(rial.toString())}>
              {busy ? "…" : "باز کردن شیفت"}
            </button>
          )}
        </div>
      </div>
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
        <AmountInput
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
  const [amount, setAmount] = useState(exactTomanInput(unitPrice.toString()));
  const [why, setWhy] = useState("");
  const rial = amount.trim() === "" ? null : rialFromExactTomanInput(amount);
  const bad = rial === null || rial <= 0n;

  return (
    <div className="line-panel" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
    <Solid className="line-discount stack" style={{ gap: "var(--s-2)" }}>
      <label className="auth-field">
        <span>
          قیمت واحد (تومان)
          {listPrice === null ? null : <> — قیمت فهرست <Money rial={listPrice} size="sm" /></>}
        </span>
        <AmountInput
          type="text"
          inputMode="decimal"
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
  const [amount, setAmount] = useState(current > 0n ? exactTomanInput(current.toString()) : "");
  const [why, setWhy] = useState("");
  const [unit, setUnit] = useState<"auto" | "amount" | "percent">(current > 0n ? "amount" : "auto");
  const entered = amount.trim() === "" ? 0n : rialFromExactTomanInput(amount);
  const percent = unit === "percent" || (unit === "auto" && entered !== null && entered <= 1000n);
  const rial = entered === null || entered < 0n || (percent && entered > 1000n) ? null
    : percent ? (gross * entered + 500n) / 1000n : entered;
  const tooBig = rial !== null && rial > gross;

  return (
    <div className="line-panel" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
    <Solid className="line-discount stack" style={{ gap: "var(--s-2)" }}>
      <label className="auth-field">
        <span>نوع تخفیف</span><select value={unit} onChange={e => setUnit(e.target.value as typeof unit)}>
          <option value="auto">خودکار · تا ۱۰۰ درصد، بیشتر به تومان</option>
          <option value="percent">درصد</option><option value="amount">مبلغ به تومان</option>
        </select>
      </label>
      <label className="auth-field">
        <span>تخفیف ({percent ? "درصد" : "تومان"}) — حداکثر <Money rial={gross} size="sm" /></span>
        <AmountInput
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
      </label>
      <label className="auth-field">
        <span>دلیل — بالای آستانه اجباری است</span>
        <input value={why} onChange={(e) => setWhy(e.target.value)} />
      </label>
      {amount && rial !== null && !tooBig && <output>تخفیف این قلم · <Money rial={rial} size="sm" /></output>}
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
