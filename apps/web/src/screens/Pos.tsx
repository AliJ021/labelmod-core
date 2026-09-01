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
import { useCallback, useEffect, useRef, useState } from "react";
import { CameraScan } from "../components/CameraScan.tsx";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, ScanCounter } from "../lib/action-key.ts";
import { canFinalize, changeRial, remainingRial, steppedQty } from "../lib/cart.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { forgetCart, readCart, rememberCart } from "../lib/open-cart.ts";
import { pos, type Branch, type Invoice, type PaymentMethod, type Shift } from "../lib/pos.ts";
import { ScanBuffer } from "../lib/scanner.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

/** انبار پیش‌فرض: قفسه فروشگاه، نه انبار پشتیبان یا کالای معیوب. */
function defaultWarehouse(b: Branch) {
  return b.warehouses.find((w) => w.kind === "store") ?? b.warehouses[0];
}

export function Pos() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [shift, setShift] = useState<Shift | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [received, setReceived] = useState(0n);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [discounting, setDiscounting] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);

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
        if (only) {
          setBranchId(only.id);
          setWarehouseId(defaultWarehouse(only)?.id ?? "");
        }
      } catch (err) {
        setError(message(err));
      } finally {
        setReady(true);
      }
    })();
  }, []);

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
        if (inv.status === "draft") {
          setInvoice(inv);
          setReceived(parseRial(inv.receivedAmount));
          setNote("سبد نیمه‌تمام قبلی برگردانده شد.");
        } else {
          forgetCart();
        }
      } catch {
        forgetCart();
      }
    })();
    // فقط هنگام تغییر شیفت — نه با هر تغییر سبد.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift]);

  /** فاکتور پیش‌نویس، در صورت نبود ساخته می‌شود. */
  const ensureInvoice = useCallback(async (): Promise<Invoice> => {
    if (invoice && invoice.status === "draft") return invoice;
    const created = await keys.current.run(`create:${shift?.id ?? branchId}`, (key) =>
      pos.createInvoice({ branchId, warehouseId, channel: "pos" }, { idempotencyKey: key }),
    );
    setInvoice(created);
    setReceived(0n);
    scans.current.reset();
    // شناسه در حافظه مرورگر می‌نشیند تا Reload آن را یتیم نکند.
    if (shift) rememberCart({ invoiceId: created.id, shiftId: shift.id });
    return created;
  }, [invoice, shift, branchId, warehouseId]);

  const addByBarcode = useCallback(
    async (barcode: string) => {
      setError(null);
      setBusy(true);
      try {
        const inv = await ensureInvoice();
        // هر کشیدن اسکنر یک عمل تازه است: بدون شمارنده، اسکن دوم
        // Replay اسکن اول می‌شد و تعداد روی یک می‌ماند.
        const out = await keys.current.run(scans.current.next(inv.id), (key) =>
          pos.scan(inv.id, { barcode, qty: "1" }, { idempotencyKey: key }),
        );
        setInvoice(out.invoice);
      } catch (err) {
        setError(message(err));
      } finally {
        setBusy(false);
      }
    },
    [ensureInvoice],
  );

  // ── بارکدخوان ─────────────────────────────────────────────────────
  //
  // در فاز Capture و روی کل سند، نه روی یک ورودی: اسکنر خودش را
  // کیبورد معرفی می‌کند و ممکن است هر جای صفحه فوکوس باشد. تصمیم
  // «اسکن بود یا تایپ» در `ScanBuffer` است و از روی سرعت گرفته
  // می‌شود، نه از روی فوکوس.
  useEffect(() => {
    if (!shift) return;
    function onKey(e: KeyboardEvent) {
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

  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const openShift = (openingCash: string) =>
    guarded(async () => setShift(await pos.openShift({ branchId, openingCash })));

  const changeQty = (lineId: string, current: string, delta: number) =>
    guarded(async () => {
      if (!invoice) return;
      const next = steppedQty(current, delta);
      // رسیدن به صفر یعنی حذف — یک عمل دیگر با ردّ حسابرسی متفاوت.
      setInvoice(
        next === null
          ? await pos.removeLine(invoice.id, lineId)
          : await pos.setLineQty(invoice.id, lineId, next),
      );
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

  const takePayment = (methodCode: string, amountRial: bigint, refNo?: string) =>
    guarded(async () => {
      if (!invoice) return;
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

  const finalize = () =>
    guarded(async () => {
      if (!invoice) return;
      const done = await keys.current.run(`finalize:${invoice.id}`, (key) =>
        pos.finalize(invoice.id, { idempotencyKey: key }),
      );
      setNote(`فاکتور ${done.number ?? ""} ثبت شد.`);
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
      await pos.cancel(invoice.id, "رها شد");
      forgetCart();
      setInvoice(null);
      setReceived(0n);
      scans.current.reset();
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
    <div className="pos">
      {/* تنها سطح شیشه‌ای این صفحه: نوار بالا، که لایه کنترلی است. */}
      <Glass as="header" radius="md" className="pos-bar" refract={false}>
        <ManualScan onSubmit={(code) => void addByBarcode(code)} disabled={busy} />
        <span className="pill">{count} قلم</span>
        {/* دوربین فقط وقتی باز می‌شود که کاربر بخواهد — روی دسکتاپ
            با بارکدخوان سیمی، هیچ‌وقت. */}
        <button type="button" className="tool" onClick={() => setCamera((v) => !v)}>
          {camera ? "بستن دوربین" : "دوربین"}
        </button>
        <button type="button" className="tool" onClick={() => setClosing((v) => !v)}>
          بستن شیفت
        </button>
      </Glass>

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

      {camera ? (
        <CameraScan onCode={(code) => void addByBarcode(code)} onClose={() => setCamera(false)} />
      ) : null}

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
          <ul className="lines">
            {lines.map((l) => (
              <li key={l.id}>
                <div className="line-name">
                  <strong>{l.productName}</strong>
                  <span className="muted small">{l.sku}</span>
                </div>
                <div className="qty">
                  <button
                    type="button"
                    onClick={() => void changeQty(l.id, l.qty, -1)}
                    aria-label={`کم کردن ${l.productName}`}
                    disabled={busy}
                  >
                    −
                  </button>
                  <span className="num" aria-live="polite">
                    {Number(l.qty)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void changeQty(l.id, l.qty, 1)}
                    aria-label={`اضافه کردن ${l.productName}`}
                    disabled={busy}
                  >
                    +
                  </button>
                </div>
                <span className="num line-total">{toman(parseRial(l.netAmount))}</span>
                <button
                  type="button"
                  className="line-drop"
                  onClick={() => setDiscounting(discounting === l.id ? null : l.id)}
                  aria-label={`تخفیف ${l.productName}`}
                  title="تخفیف"
                  disabled={busy}
                >
                  ٪
                </button>
                <button
                  type="button"
                  className="line-drop"
                  onClick={() => void removeLine(l.id)}
                  aria-label={`حذف ${l.productName}`}
                  disabled={busy}
                >
                  ✕
                </button>
                {discounting === l.id ? (
                  <DiscountPanel
                    gross={parseRial(l.unitPrice) * BigInt(Math.trunc(Number(l.qty)))}
                    current={parseRial(l.discountAmount)}
                    busy={busy}
                    onApply={(amount, why) => void applyDiscount(l.id, amount, why)}
                    onCancel={() => setDiscounting(null)}
                  />
                ) : null}
              </li>
            ))}
            {lines.length === 0 && <li className="empty">سبد خالی است — بارکد را اسکن کنید</li>}
          </ul>
        </Solid>

        <PayPanel
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
          onPay={(code, amount, ref) => void takePayment(code, amount, ref)}
          onFinalize={() => void finalize()}
          onAbandon={() => void abandon()}
        />
      </div>
    </div>
  );
}

/** انتخاب شعبه و انبار — فقط وقتی بیش از یکی باشد. */
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
function ManualScan({
  onSubmit,
  disabled,
}: {
  onSubmit: (code: string) => void;
  disabled: boolean;
}) {
  const [code, setCode] = useState("");
  return (
    <form
      className="scan"
      onSubmit={(e) => {
        e.preventDefault();
        const v = code.trim();
        if (v !== "") {
          onSubmit(v);
          setCode("");
        }
      }}
    >
      <label>
        <span className="sr-only">بارکد کالا</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="بارکد را اسکن کنید یا کد کالا را بزنید"
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
        />
      </label>
    </form>
  );
}

/**
 * بستن شیفت — سند فروش، بهای تمام‌شده و مغایرت اینجا زده می‌شوند.
 *
 * مجوزش `shift.close` است و **جدا از فروش**: صندوق‌داری که می‌تواند
 * بفروشد لزوماً نباید بتواند کشو را ببندد. اگر نداشته باشد، سرور ۴۰۳
 * می‌دهد و همان پیام فارسی بالای صفحه می‌نشیند — دکمه را پنهان
 * نمی‌کنیم چون `identity.can()` تنها مرجع است و کپی‌کردن قاعده‌اش در
 * UI یعنی دو تعریف.
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
  methods: PaymentMethod[];
  payable: bigint;
  received: bigint;
  canFinalize: boolean;
  busy: boolean;
  hasCart: boolean;
  onPay: (methodCode: string, amount: bigint, refNo?: string) => void;
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
            onClick={() => {
              if (typed !== null && typed > 0n) {
                onPay(chosen.code, typed, refNo);
                setAmount("");
                setRefNo("");
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
