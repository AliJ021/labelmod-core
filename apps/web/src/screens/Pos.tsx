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
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, ScanCounter } from "../lib/action-key.ts";
import { canFinalize, changeRial, lineGross, remainingRial, steppedQty } from "../lib/cart.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { isNetworkFailure } from "../lib/offline-queue.ts";
import { forgetCart, readCart, rememberCart } from "../lib/open-cart.ts";
import { pendingLabel, saleQueue, summarize, type PendingSummary } from "../lib/sale-queue.ts";
import { pos, type Branch, type Invoice, type InvoiceLine, type PaymentMethod, type DraftPayment, type Shift } from "../lib/pos.ts";
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
              <span className="num">{toman(parseRial(l.unitPrice))}</span>
              {" به‌جای "}
              <span className="num">{toman(parseRial(l.listPrice))}</span>
            </>
          )}
        </span>
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
        <span className="num" aria-live="polite">
          {Number(l.qty)}
        </span>
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
      <span className="num line-total">{toman(parseRial(l.netAmount))}</span>
      <button
        type="button"
        className="line-drop"
        onClick={() => on.openPrice(l.id)}
        aria-label={`تغییر قیمت ${l.productName}`}
        title="قیمت دستی"
      >
        ﷼
      </button>
      <button
        type="button"
        className="line-drop"
        onClick={() => on.openDiscount(l.id)}
        aria-label={`تخفیف ${l.productName}`}
        title="تخفیف"
      >
        ٪
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
  const [branchId, setBranchId] = useUrlState("pos.branch");
  const [warehouseId, setWarehouseId] = useUrlState("pos.warehouse");
  const [shift, setShift] = useState<Shift | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [received, setReceived] = useState(0n);
  const [lastPrintedInvoice, setLastPrintedInvoice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setBusy] = useState(false);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [scanStorageError, setScanStorageError] = useState<string | null>(null);
  const scanRunning = useRef(false);
  const mutationRunning = useRef(false);
  const pendingScanRef = useRef<PendingScan | null>(null);
  const busy = working || pendingScan !== null || scanStorageError !== null;
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
  const [draftRefund, setDraftRefund] = useState<{ invoiceId: string; payments: DraftPayment[] } | null>(null);
  const [discounting, setDiscounting] = useState<string | null>(null);
  const [pricing, setPricing] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  /** شماره مشتری — **اختیاری**. فروش ناشناس کارِ عادی است. */
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
        const [b, m] = await Promise.all([pos.branches(), pos.paymentMethods()]);
        setBranches(b.branches);
        setMethods(m.methods);
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
    const saved = readCart(shift.id);
    if (!saved) return;
    void (async () => {
      try {
        const inv = await pos.invoice(saved.invoiceId);
        if (inv.status === "draft" && inv.createdBy === actorId && inv.shiftId === shift.id && inv.branchId === shift.branchId && shift.userId === actorId && shift.status === "open") {
          setInvoice(inv);
          setReceived(parseRial(inv.receivedAmount));
          setNote("سبد نیمه‌تمام قبلی برگردانده شد.");
        } else {
          forgetCart();
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

  async function guarded(fn: () => Promise<void>) {
    if (busy) return false;
    if (pendingScanRef.current || scanStorageError || scanRunning.current || mutationRunning.current) return false;
    mutationRunning.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks) throw new Error("برای ثبت ایمن، مرورگر به‌روز و اتصال امن لازم است.");
      await navigator.locks.request(`labelmod-pos:${actorId}`, {ifAvailable:true}, async lock => {
        if (!lock) throw new Error("عملیات صندوق در تب دیگری جریان دارد.");
        const intent = readPendingScan(actorId);
        if (intent) { pendingScanRef.current = intent; setPendingScan(intent); throw new Error("ابتدا اسکن معلق را بررسی کنید."); }
        await fn();
      });
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    } finally {
      mutationRunning.current = false; setBusy(false);
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
  const attachCustomer = () =>
    guarded(async () => {
      if (!invoice) return;
      const m = normalizeDigits(mobile).trim();
      if (m === "") return;
      setInvoice(await pos.attachCustomer(invoice.id, { mobile: m }));
      setNote("مشتری به این فاکتور وصل شد.");
    });

  const takePayment = (methodCode: string, amountRial: bigint, refNo?: string) =>
    guarded(async () => {
      if (!invoice) return;
      // ── چرا کلید از `received` ساخته می‌شود و نه از یک شمارنده ──
      //
      // نام عمل باید روی **Retry همان پرداخت** ثابت بماند و برای
      // **پرداخت بعدی** عوض شود. `received` هر دو را می‌دهد: تا وقتی
      // پرداختی ثبت نشده تغییر نمی‌کند (پس Retry همان کلید را
      // می‌برد)، و به‌محض ثبت بالا می‌رود.
      //
      // شمارنده — مثل `ScanCounter` — اینجا **بدتر** بود: هر Retry
      // یک عدد جلو می‌رفت و کلید تازه می‌گرفت، یعنی پرداختی که فقط
      // پاسخش در شبکه گم شده بود، دوباره از مشتری گرفته می‌شد.
      //
      // ⚠️ این به یک ثابت دور وابسته است: `addPaymentIn` وضعیت
      // `succeeded` می‌نویسد و `paidSoFar` همان را می‌شمارد. اگر روزی
      // درگاهی اضافه شود که پرداخت را `pending` ثبت کند، `received`
      // بالا نمی‌رود و پرداخت **عمدیِ** بعدی Replay اولی می‌شود. آن
      // روز این کلید باید شناسه خودِ پرداخت را هم بگیرد.
      const out = await keys.current.run(`pay:${invoice.id}:${received}`, (key) =>
        pos.pay(
          invoice.id,
          {
            methodCode,
            amount: amountRial.toString(),
            ...(refNo === undefined || refNo === "" ? {} : { refNo }),
          },
          { idempotencyKey: key },
        ),
      );
      setInvoice(out.invoice);
      // «چقدر گرفته‌ایم» از جمع سرور می‌آید، نه از مبلغی که فرستادیم.
      setReceived(parseRial(out.receivedAmount));
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
   */
  const finalize = () =>
    guarded(async () => {
      if (!invoice) return;
      const action = `finalize:${invoice.id}`;
      const key = keys.current.keyFor(action);
      const amount = parseRial(invoice.payableAmount);
      try {
        const done = await pos.finalize(invoice.id, { idempotencyKey: key });
        setNote(`فاکتور ${done.number ?? ""} ثبت شد.`);
        setLastPrintedInvoice(invoice.id);
      } catch (err) {
        // خطای قاعده‌ای (موجودی، دوره بسته، پرداخت ناکافی) صف نمی‌شود:
        // سرور جواب داده و جوابش «نه» است.
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
        setNote("شبکه قطع است — فروش در صف نشست و با وصل‌شدن خودکار ارسال می‌شود.");
      }
      keys.current.clear(action);
      forgetCart();
      setInvoice(null);
      setReceived(0n);
      scans.current.reset();
    });

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

  const payable = invoice ? parseRial(invoice.payableAmount) : 0n;
  const lines = invoice?.lines ?? [];
  const count = lines.reduce((n, l) => n + Number(l.qty), 0);

  return (
    <div className={`pos${lines.length ? " pos--has-items" : ""}`}>
      {lines.length > 0 && <aside className="pos-mobile-summary solid" aria-label="خلاصهٔ پرداخت">
        <span>{count} قلم · مانده <strong className="num">{toman(remainingRial(payable, received))}</strong> تومان</span>
        <button className="btn btn--primary" type="button" onClick={() => document.querySelector<HTMLElement>(".pay")?.scrollIntoView({block:"start",behavior:"instant"})}>رفتن به پرداخت</button>
      </aside>}
      {/* تنها سطح شیشه‌ای این صفحه: نوار بالا، که لایه کنترلی است. */}
      <Glass as="header" radius="md" className="pos-bar" refract={false}>
        <span className="pill">{count} قلم</span>
        <a className="tool" href="/?page=invoices&invoices.status=draft" onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(e.currentTarget.href); }}>پیش‌نویس‌ها</a>
        <button type="button" className="tool" disabled={busy || !invoice} onClick={() => {
          if (!invoice || busy) return;
          forgetCart(); setInvoice(null); setReceived(0n); scans.current.reset();
          setNote("پیش‌نویس در سرور ذخیره است و از بخش فاکتورها قابل ادامه است.");
        }}>ذخیره و فروش جدید</button>
        {/* دوربین فقط وقتی باز می‌شود که کاربر بخواهد — روی دسکتاپ
            با بارکدخوان سیمی، هیچ‌وقت. */}
        <button type="button" className="tool" onClick={() => setCamera((v) => !v)}>
          {camera ? "بستن دوربین" : "دوربین"}
        </button>
        <button type="button" className="tool" onClick={() => setClosing((v) => !v)}>
          بستن شیفت
        </button>
      </Glass>

      {lastPrintedInvoice && <a className="btn" href={`/api/invoices/${lastPrintedInvoice}/print`} target="_blank" rel="noopener">چاپ فاکتور ثبت‌شده</a>}
      {scanStorageError && <p className="solid pos-alert" role="alert">{scanStorageError}</p>}
      {pendingScan && <div className="solid pad" role="status">
        <p>نتیجهٔ اسکن هنوز قطعی نیست. برای جلوگیری از ثبت دوباره، ابتدا همین اسکن را تعیین تکلیف کنید.</p>
        <button type="button" className="btn" disabled={working} onClick={() => void addByBarcode("", undefined, true)}>بررسی و تلاش دوبارهٔ همان اسکن</button>
      </div>}

      <PosProductPicker key={warehouseId} warehouseId={warehouseId} busy={busy} onPick={(id) => addByBarcode("", id)} />

      {/* عنصر ساده با کلاس `solid`، نه کامپوننت `Solid`: آن `role`
          نمی‌گیرد و اینجا اعلام زنده لازم است تا صندوق‌دار خطا را
          بشنود، نه فقط ببیند. سطح شیشه‌ای هم داخلش نیست که Context
          لازم شود. */}
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note ? (
        <p className="solid pos-alert" role="status">
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

      {camera ? (
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

      <div className="pos-body">
        <Solid as="section" className="cart">
          <h2 className="sr-only">سبد خرید</h2>
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
              {lines.length === 0 && (
                <li className="empty">سبد خالی است — نام محصول را جست‌وجو یا بارکد را اسکن کنید</li>
              )}
            </ul>
          </fieldset>

          {/*
            شماره مشتری — **اختیاری**، و عمداً پایین سبد.

            بالای صفحه یعنی صندوق‌دار حس کند باید اول شماره بگیرد و
            صف بایستد. اینجا یعنی وقتی سبد بسته می‌شود پرسیده شود، یا
            اصلاً نشود: فروش ناشناس کارِ عادی است.

            فایده‌اش دو چیز است و هر دو برای مشتری: سابقه خرید، و
            دیده‌شدن همین خرید در حساب کاربری سایت.
          */}
          {invoice ? (
            <div className="pos-customer row" style={{ gap: "var(--s-2)" }}>
              <label className="sr-only" htmlFor="pos-mobile">
                شماره موبایل مشتری (اختیاری)
              </label>
              {/*
                `type="text"` نه `type="tel"` و نه `type="number"` —
                صفحه‌کلید فارسی «۰۹۱۲» می‌فرستد و ورودی عددی مرورگر
                آن را دور می‌اندازد.
              */}
              <input
                id="pos-mobile"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder={
                  invoice.customerId === null
                    ? "موبایل مشتری (اختیاری)"
                    : "مشتری وصل است — برای تغییر شماره تازه بزنید"
                }
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => void attachCustomer()}
                disabled={busy || normalizeDigits(mobile).trim() === ""}
              >
                {invoice.customerId === null ? "افزودن مشتری" : "تغییر مشتری"}
              </button>
            </div>
          ) : null}

          {invoice ? <GiftPanel invoice={invoice} onChange={setInvoice} /> : null}
        </Solid>

        <PayPanel
          invoiceId={invoice?.id ?? null}
          methods={methods}
          payable={payable}
          received={received}
          canFinalize={canFinalize({
            status: invoice?.status ?? "none",
            lineCount: lines.length,
            payable,
            received,
          })}
          busy={busy}
          hasCart={invoice !== null && lines.length > 0}
          onPay={takePayment}
          onFinalize={() => void finalize()}
          onAbandon={() => void abandon()}
        />
      </div>
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
    <Solid className="line-discount stack" style={{ gap: "var(--s-2)" }}>
      <label className="auth-field">
        <span>
          قیمت واحد (تومان)
          {listPrice === null ? null : ` — قیمت فهرست ${toman(listPrice)}`}
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
    <Solid className="line-discount stack" style={{ gap: "var(--s-2)" }}>
      <label className="auth-field">
        <span>تخفیف (تومان) — حداکثر {toman(gross)}</span>
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
  );
}

function PayPanel({
  invoiceId,
  methods,
  payable,
  received,
  canFinalize: allowed,
  busy,
  hasCart,
  onPay,
  onFinalize,
  onAbandon,
}: {
  invoiceId: string | null;
  methods: PaymentMethod[];
  payable: bigint;
  received: bigint;
  canFinalize: boolean;
  busy: boolean;
  hasCart: boolean;
  onPay: (methodCode: string, amount: bigint, refNo?: string) => Promise<boolean>;
  onFinalize: () => void;
  onAbandon: () => void;
}) {
  const [method, setMethod] = useState("");
  const [amount, setAmount] = useState("");
  const [refNo, setRefNo] = useState("");

  const remaining = remainingRial(payable, received);
  const change = changeRial(payable, received);
  const chosen = methods.find((m) => m.code === method) ?? null;

  // پیش‌فرض مبلغ: همان مانده. رایج‌ترین حالت، پرداخت کامل است.
  const typed = amount.trim() === "" ? remaining : rialFromTomanInput(amount);

  return (
    <Solid as="aside" className="pay">
      <h2 style={{ fontSize: "1rem", margin: 0 }}>پرداخت نقدی، کارت‌خوان یا ترکیبی</h2>
      <p className="muted small">برای پرداخت ترکیبی، مبلغ بخش اول را با یک روش دریافت کنید؛ سپس روش بعدی را برای مانده انتخاب کنید.</p>
      {invoiceId && received > 0n ? <PaymentBreakdown invoiceId={invoiceId} received={received} /> : null}
      <div className="total">
        <span className="muted">قابل پرداخت</span>
        <strong className="num total-value">{toman(payable)}</strong>
        <span className="muted small">تومان</span>
      </div>

      {received > 0n ? (
        <p className="muted small" style={{ margin: 0 }}>
          دریافت‌شده: <span className="num">{toman(received)}</span>
          {remaining > 0n ? (
            <>
              {" · "}مانده: <span className="num">{toman(remaining)}</span>
            </>
          ) : null}
          {change > 0n ? (
            <>
              {" · "}باقی پول: <strong className="num">{toman(change)}</strong>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="stack" style={{ gap: "var(--s-2)" }}>
        {methods.map((m) => (
          <button
            key={m.code}
            type="button"
            className={m.code === method ? "btn btn--primary" : "btn"}
            onClick={() => setMethod(m.code)}
            disabled={!hasCart || busy}
          >
            {m.name}
          </button>
        ))}
      </div>

      {chosen ? (
        <>
          <label className="auth-field">
            <span>مبلغ (تومان) — خالی یعنی همه مانده</span>
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={toman(remaining)}
            />
          </label>
          {chosen.code === "snappay" && <p className="muted">ثبت دستی پرداخت تأییدشدهٔ اسنپ‌پی؛ شماره پیگیری واقعی را وارد کنید.</p>}
          {chosen.requiresRef ? (
            <label className="auth-field">
              <span>شماره پیگیری</span>
              <input value={refNo} onChange={(e) => setRefNo(e.target.value)} />
            </label>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || typed === null || typed <= 0n || (chosen.requiresRef && refNo === "")}
            onClick={async () => {
              if (typed !== null && typed > 0n) {
                if (await onPay(chosen.code, typed, refNo)) { setAmount(""); setRefNo(""); }
              }
            }}
          >
            دریافت وجه
          </button>
        </>
      ) : null}

      <button type="button" className="btn btn--primary" disabled={!allowed || busy} onClick={onFinalize}>
        نهایی‌کردن فاکتور
      </button>
      <button type="button" className="btn btn--quiet" disabled={!hasCart || busy} onClick={onAbandon}>
        رها کردن سبد
      </button>
    </Solid>
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
    <ul>{payments.map((p) => <li key={p.id}>{p.name}: {toman(parseRial(p.amount))} تومان</li>)}</ul>
    {blocked ? <p role="alert">پرداخت نامشخص یا تسویه‌شده نیازمند بررسی حسابدار است و از این مسیر برگشت نمی‌خورد.</p> : null}
    <label className="auth-field">دلیل برگشت<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
    {external ? <label className="auth-field">شماره پیگیری برگشت بانکی<input value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} /></label> : null}
    <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />برگشت وجه لازم را انجام داده‌ام و لغو این پیش‌نویس را تأیید می‌کنم.</label>
    <button type="button" className="btn btn--primary" disabled={busy || blocked || !confirmed || reason.trim().length < 3 || (external && !ref.trim())}
      onClick={() => onConfirm(reason.trim(), ref)}>ثبت برگشت و لغو پیش‌نویس</button>
    <button type="button" className="btn btn--quiet" disabled={busy} onClick={onCancel}>انصراف</button>
  </Solid></section>;
}
