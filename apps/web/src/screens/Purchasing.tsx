/**
 * انبار و خرید — رسید خرید.
 *
 * ناحیه «متوسط» ADR-002: کارت‌ها شیشه‌ای، ولی هر سطر و هر عددی که
 * خوانده می‌شود مات. کار انبار طولانی است و خستگی چشم مهم؛ ولی مثل
 * صندوق زیر فشار صف نیست.
 *
 * ── جریان ─────────────────────────────────────────────────────────
 *
 *   تأمین‌کننده و انبار → پیش‌نویس → اسکن اقلام با قیمت →
 *   هزینه جانبی → ثبت
 *
 * ── سه چیزی که این صفحه عمداً انجام **نمی‌دهد** ────────────────────
 *
 * **جمع نمی‌زند.** هر تماسی که رسید را عوض می‌کند کل رسید را
 * برمی‌گرداند و جمع‌ها از همان‌جا خوانده می‌شوند. دو تعریف از یک جمع
 * دیر یا زود از هم جدا می‌افتند.
 *
 * **بهای تمام‌شده را پیش‌بینی نمی‌کند.** `landedUnitCost` تا لحظه ثبت
 * صفر است و همین نشان داده می‌شود. یک «پیش‌نمای» محاسبه‌شده در
 * مرورگر، دومین پیاده‌سازی الگوریتم تخصیص می‌شد — و آن نسخه‌ای که
 * دیده می‌شود با آنچه ثبت می‌شود فرق می‌کرد.
 *
 * **مجوز را حدس نمی‌زند.** اگر کاربر `stock.receive` نداشته باشد،
 * سرور ۴۰۳ با پیام فارسی می‌دهد و همان نشان داده می‌شود.
 *
 * ── قاعده‌ای که اینجا وارونه است ──────────────────────────────────
 *
 * صندوق قیمت نمی‌فرستد. **این صفحه می‌فرستد** — قیمت خرید تصمیم
 * تأمین‌کننده است. توضیح کامل در `lib/purchasing.ts`.
 */
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { pos, type Branch } from "../lib/pos.ts";
import {
  ALLOCATION_LABEL,
  RECEIPT_STATUS,
  purchasing,
  type ExpenseAccount,
  type PayAccount,
  type Receipt,
  type ReceiptSummary,
  type Supplier,
} from "../lib/purchasing.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

/** تاریخ برای خواندن، نه برای محاسبه — تقویم فارسی از خود مرورگر. */
function shortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function Purchasing() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<ExpenseAccount[]>([]);

  const [list, setList] = useState<ReceiptSummary[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const [supplierId, setSupplierId] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");

  // فرم قلم
  const [barcode, setBarcode] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");

  // فرم هزینه
  const [chargeOpen, setChargeOpen] = useState(false);
  const [chargeType, setChargeType] = useState("حمل");
  const [chargeAmount, setChargeAmount] = useState("");
  const [allocation, setAllocation] = useState("by_value");
  const [paidFrom, setPaidFrom] = useState("payable");
  const [payeeType, setPayeeType] = useState("supplier");
  const [payAccountId, setPayAccountId] = useState("");
  const [expenseCode, setExpenseCode] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [keys] = useState(() => new ActionKeys());

  const branch = branches.find((b) => b.id === branchId) ?? null;
  const editable = receipt !== null && receipt.status === "draft";

  useEffect(() => {
    void (async () => {
      try {
        const b = await pos.branches();
        setBranches(b.branches);
        const first = b.branches[0];
        if (first) {
          setBranchId(first.id);
          setWarehouseId(first.warehouses[0]?.id ?? "");
        }
        const [s, p, e, l] = await Promise.all([
          purchasing.suppliers(),
          purchasing.payAccounts(),
          purchasing.expenseAccounts(),
          purchasing.receipts(),
        ]);
        setSuppliers(s);
        setPayAccounts(p);
        setExpenseAccounts(e);
        setList(l);
      } catch (err) {
        setError(message(err));
      }
    })();
  }, []);

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

  const refreshList = async () => setList(await purchasing.receipts());

  const startDraft = () =>
    guarded(async () => {
      setDone(null);
      const body = {
        branchId,
        warehouseId,
        supplierId,
        ...(invoiceNo.trim() === "" ? {} : { supplierInvoiceNo: invoiceNo.trim() }),
      };
      // نام عمل از **بدنه** ساخته می‌شود: Retry با همان فرم همان کلید
      // را می‌برد (Replay)، ولی اگر کاربر پس از یک شکست تأمین‌کننده را
      // عوض کند کلید تازه می‌گیرد. با کلید ثابت، آن اصلاح ۴۰۹
      // می‌گرفت و صفحه تا Reload گیر می‌کرد.
      const draft = await keys.run(actionFor("receipt", body), (key) =>
        purchasing.createReceipt(body, { idempotencyKey: key }),
      );
      setReceipt(draft);
      setInvoiceNo("");
      await refreshList();
    });

  const open = (id: string) =>
    guarded(async () => {
      setDone(null);
      setReceipt(await purchasing.receipt(id));
    });

  const addLine = () =>
    guarded(async () => {
      if (!receipt) return;
      const rial = rialFromTomanInput(price);
      if (rial === null) throw new ApiError(400, "bad_price", "قیمت خرید معتبر نیست.", null);

      const body = {
        barcode: barcode.trim(),
        qty: qty.trim(),
        unitPrice: rial.toString(),
      };
      const next = await keys.run(actionFor(`line:${receipt.id}`, body), (key) =>
        purchasing.addLine(receipt.id, body, { idempotencyKey: key }),
      );
      setReceipt(next);
      setBarcode("");
      setQty("1");
      // قیمت عمداً پاک نمی‌شود: یک محموله معمولاً چند قلم با یک نرخ
      // دارد و پاک‌کردنش یعنی تایپ دوباره در هر اسکن.
    });

  const setLineQty = (lineId: string, nextQty: string) =>
    guarded(async () => {
      if (!receipt) return;
      setReceipt(await purchasing.setLine(receipt.id, lineId, { qty: nextQty }));
    });

  const removeLine = (lineId: string) =>
    guarded(async () => {
      if (!receipt) return;
      setReceipt(await purchasing.removeLine(receipt.id, lineId));
    });

  const addCharge = () =>
    guarded(async () => {
      if (!receipt) return;
      const rial = rialFromTomanInput(chargeAmount);
      if (rial === null) throw new ApiError(400, "bad_amount", "مبلغ هزینه معتبر نیست.", null);

      const body = {
        chargeType: chargeType.trim(),
        amount: rial.toString(),
        allocation,
        paidFrom,
        payeeType,
        ...(paidFrom === "treasury" && payAccountId !== ""
          ? { paidAccountId: payAccountId }
          : {}),
        ...(allocation === "none" && expenseCode !== ""
          ? { expenseAccountCode: expenseCode }
          : {}),
      };
      const next = await keys.run(actionFor(`charge:${receipt.id}`, body), (key) =>
        purchasing.addCharge(receipt.id, body, { idempotencyKey: key }),
      );
      setReceipt(next);
      setChargeAmount("");
      setChargeOpen(false);
    });

  const removeCharge = (chargeId: string) =>
    guarded(async () => {
      if (!receipt) return;
      setReceipt(await purchasing.removeCharge(receipt.id, chargeId));
    });

  const post = () =>
    guarded(async () => {
      if (!receipt) return;
      const posted = await keys.run(`receipt-post:${receipt.id}`, (key) =>
        purchasing.post(receipt.id, { idempotencyKey: key }),
      );
      setReceipt(posted);
      setDone(`رسید ${posted.number ?? ""} ثبت شد — کالا وارد انبار و سند به دفتر رفت.`);
      await refreshList();
    });

  const cancel = () =>
    guarded(async () => {
      if (!receipt) return;
      setReceipt(await purchasing.cancel(receipt.id));
      await refreshList();
    });

  const goods = receipt ? parseRial(receipt.goodsAmount) : 0n;
  const charges = receipt ? parseRial(receipt.chargesAmount) : 0n;

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      {/* ── رسید تازه ─────────────────────────────────────────────── */}
      <Glass as="section" className="pad" live>
        <h2 style={{ marginTop: 0 }}>انبار و خرید</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          رسید خرید تا لحظه ثبت هیچ اثری بر انبار و دفتر ندارد — و شماره هم نمی‌گیرد.
        </p>

        <div className="stack" style={{ gap: "var(--s-3)" }}>
          {branches.length > 1 ? (
            <label className="auth-field">
              <span>شعبه</span>
              <select
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  const b = branches.find((x) => x.id === e.target.value);
                  setWarehouseId(b?.warehouses[0]?.id ?? "");
                }}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="auth-field">
            <span>انبار مقصد</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {(branch?.warehouses ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          <label className="auth-field">
            <span>تأمین‌کننده</span>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— انتخاب کنید —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>

          <label className="auth-field">
            <span>شماره فاکتور تأمین‌کننده (اختیاری)</span>
            <input
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              autoComplete="off"
            />
          </label>

          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || supplierId === "" || warehouseId === ""}
            onClick={() => void startDraft()}
          >
            {busy ? "…" : "رسید خرید تازه"}
          </button>
        </div>
      </Glass>

      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {done ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {done}
        </p>
      ) : null}

      {/* ── رسید باز ──────────────────────────────────────────────── */}
      {receipt ? (
        <Solid as="section" className="pad stack" style={{ gap: "var(--s-3)" }}>
          <div className="row" style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, flex: "1 1 auto" }}>
              {receipt.number ?? "پیش‌نویس بی‌شماره"} — {receipt.supplierName}
            </h3>
            <span className="chip">{RECEIPT_STATUS[receipt.status] ?? receipt.status}</span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            انبار {receipt.warehouseName} · {shortDate(receipt.occurredAt)}
            {receipt.supplierInvoiceNo ? ` · فاکتور ${receipt.supplierInvoiceNo}` : ""}
          </p>

          {editable ? (
            <form
              className="stack"
              style={{ gap: "var(--s-2)" }}
              onSubmit={(e) => {
                e.preventDefault();
                void addLine();
              }}
            >
              <span className="muted small">افزودن قلم — بارکد را اسکن کنید</span>
              <div className="rcpt-add">
                <input
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="بارکد"
                  autoComplete="off"
                  aria-label="بارکد"
                />
                {/*
                  `type="text"` نه `type="number"`: صفحه‌کلید فارسی «۴۸»
                  می‌فرستد و ورودی عددی مرورگر آن را دور می‌اندازد.
                */}
                <input
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  inputMode="decimal"
                  placeholder="تعداد"
                  aria-label="تعداد"
                />
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="numeric"
                  placeholder="قیمت خرید (تومان)"
                  aria-label="قیمت خرید به تومان"
                />
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={busy || barcode.trim() === "" || price.trim() === ""}
                >
                  افزودن
                </button>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                همان کالا با همان قیمت روی یک سطر جمع می‌شود؛ با قیمت متفاوت، سطر تازه.
              </p>
            </form>
          ) : null}

          {receipt.lines.length === 0 ? (
            <p className="empty">هنوز قلمی اضافه نشده.</p>
          ) : (
            <ul className="lines">
              {receipt.lines.map((l) => (
                <li key={l.id}>
                  <div className="line-name">
                    <strong>{l.productName}</strong>
                    <span className="muted small">
                      {l.sku}
                      {l.color ? ` · ${l.color}` : ""}
                      {l.size ? ` · ${l.size}` : ""} · {toman(parseRial(l.unitPrice))} تومان
                      {receipt.status === "posted"
                        ? ` · بهای تمام‌شده ${toman(parseRial(l.landedUnitCost))}`
                        : ""}
                    </span>
                  </div>
                  {editable ? (
                    <div className="qty">
                      <button
                        type="button"
                        onClick={() => void setLineQty(l.id, String(Number(l.qty) - 1))}
                        disabled={busy || Number(l.qty) <= 1}
                        aria-label={`کم کردن ${l.productName}`}
                      >
                        −
                      </button>
                      <span className="num">{Number(l.qty)}</span>
                      <button
                        type="button"
                        onClick={() => void setLineQty(l.id, String(Number(l.qty) + 1))}
                        disabled={busy}
                        aria-label={`اضافه کردن ${l.productName}`}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <span className="num">{Number(l.qty)}</span>
                  )}
                  <span className="num line-total">{toman(parseRial(l.lineAmount))}</span>
                  {editable ? (
                    <button
                      type="button"
                      className="line-drop"
                      onClick={() => void removeLine(l.id)}
                      disabled={busy}
                      aria-label={`حذف ${l.productName}`}
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {/* ── هزینه جانبی ─────────────────────────────────────── */}
          <div className="stack" style={{ gap: "var(--s-2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
              <span className="muted small" style={{ flex: "1 1 auto" }}>
                هزینه جانبی (حمل، ترخیص، بسته‌بندی)
              </span>
              {editable ? (
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => setChargeOpen(!chargeOpen)}
                  aria-expanded={chargeOpen}
                >
                  {chargeOpen ? "بستن" : "افزودن هزینه"}
                </button>
              ) : null}
            </div>

            {receipt.charges.length > 0 ? (
              <ul className="lines">
                {receipt.charges.map((c) => (
                  <li key={c.id}>
                    <div className="line-name">
                      <strong>{c.chargeType}</strong>
                      <span className="muted small">
                        {ALLOCATION_LABEL[c.allocation] ?? c.allocation}
                        {c.allocation === "none"
                          ? ` → ${c.expenseAccountName ?? "هزینه حمل و ارسال"}`
                          : ""}
                        {c.paidFrom === "treasury"
                          ? ` · پرداخت‌شده از ${c.paidAccountName ?? "خزانه"}`
                          : c.payeeType === "other"
                            ? " · بدهی به شخص ثالث"
                            : " · بدهی به تأمین‌کننده"}
                      </span>
                    </div>
                    <span className="num line-total">{toman(parseRial(c.amount))}</span>
                    {editable ? (
                      <button
                        type="button"
                        className="line-drop"
                        onClick={() => void removeCharge(c.id)}
                        disabled={busy}
                        aria-label={`حذف ${c.chargeType}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {chargeOpen && editable ? (
              <div className="stack" style={{ gap: "var(--s-2)" }}>
                <label className="auth-field">
                  <span>عنوان هزینه</span>
                  <input value={chargeType} onChange={(e) => setChargeType(e.target.value)} />
                </label>
                <label className="auth-field">
                  <span>مبلغ (تومان)</span>
                  <input
                    value={chargeAmount}
                    onChange={(e) => setChargeAmount(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className="auth-field">
                  <span>چطور روی بهای کالا بنشیند</span>
                  <select value={allocation} onChange={(e) => setAllocation(e.target.value)}>
                    <option value="by_value">به نسبت مبلغ هر قلم</option>
                    <option value="by_qty">به نسبت تعداد هر قلم</option>
                    <option value="none">اصلاً ننشیند — هزینه دوره است</option>
                  </select>
                </label>
                {allocation === "none" ? (
                  <label className="auth-field">
                    <span>سرفصل هزینه</span>
                    <select value={expenseCode} onChange={(e) => setExpenseCode(e.target.value)}>
                      <option value="">— پیش‌فرض: هزینه حمل و ارسال —</option>
                      {expenseAccounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="auth-field">
                  <span>پول از کجا رفته</span>
                  <select value={paidFrom} onChange={(e) => setPaidFrom(e.target.value)}>
                    <option value="payable">هنوز نرفته — بدهی است</option>
                    <option value="treasury">از حساب پرداخت شده</option>
                  </select>
                </label>
                {paidFrom === "treasury" ? (
                  <label className="auth-field">
                    <span>از کدام حساب</span>
                    <select
                      value={payAccountId}
                      onChange={(e) => setPayAccountId(e.target.value)}
                    >
                      <option value="">— انتخاب کنید —</option>
                      {payAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="auth-field">
                    <span>بدهی به چه کسی</span>
                    <select value={payeeType} onChange={(e) => setPayeeType(e.target.value)}>
                      <option value="supplier">همان تأمین‌کننده</option>
                      <option value="other">شخص ثالث (باربری…)</option>
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={
                    busy ||
                    chargeAmount.trim() === "" ||
                    (paidFrom === "treasury" && payAccountId === "")
                  }
                  onClick={() => void addCharge()}
                >
                  ثبت هزینه
                </button>
                <p className="muted small" style={{ margin: 0 }}>
                  صندوق فروشگاه در فهرست حساب‌ها نیست: پول کشو فقط از فروش و بازپرداخت
                  حرکت می‌کند، وگرنه شمارش صندوق مغایرت کاذب می‌دهد.
                </p>
              </div>
            ) : null}
          </div>

          {/* ── جمع‌ها ─────────────────────────────────────────── */}
          <div className="total">
            <span>بهای کالا</span>
            <span className="num total-value">{toman(goods)}</span>
          </div>
          {charges > 0n ? (
            <div className="total">
              <span>هزینه جانبی</span>
              <span className="num total-value">{toman(charges)}</span>
            </div>
          ) : null}
          <div className="total">
            <span>بدهی به تأمین‌کننده</span>
            <span className="num total-value">{toman(parseRial(receipt.supplierPayable))}</span>
          </div>
          {parseRial(receipt.thirdPartyPayable) > 0n ? (
            <div className="total">
              <span>بدهی به شخص ثالث</span>
              <span className="num total-value">
                {toman(parseRial(receipt.thirdPartyPayable))}
              </span>
            </div>
          ) : null}

          {editable ? (
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || receipt.lines.length === 0}
                onClick={() => void post()}
              >
                {busy ? "…" : "ثبت رسید"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void cancel()}
              >
                ابطال پیش‌نویس
              </button>
            </div>
          ) : null}

          {receipt.status === "posted" ? (
            <p className="muted small" style={{ margin: 0 }}>
              رسید ثبت‌شده تغییر نمی‌کند. اصلاح فقط با یک سند معکوس.
            </p>
          ) : null}
        </Solid>
      ) : null}

      {/* ── رسیدهای اخیر ─────────────────────────────────────────── */}
      <Solid as="section" className="pad">
        <h3 style={{ marginTop: 0 }}>رسیدهای اخیر</h3>
        {list.length === 0 ? (
          <p className="empty">هنوز رسیدی ثبت نشده.</p>
        ) : (
          <ul className="lines">
            {list.map((r) => (
              <li key={r.id}>
                <div className="line-name">
                  <strong>{r.number ?? "پیش‌نویس"}</strong>
                  <span className="muted small">
                    {r.supplierName} · {r.warehouseName} · {shortDate(r.occurredAt)} ·{" "}
                    {r.lineCount} قلم
                  </span>
                </div>
                <span className="chip">{RECEIPT_STATUS[r.status] ?? r.status}</span>
                <span className="num line-total">{toman(parseRial(r.goodsAmount))}</span>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void open(r.id)}
                  disabled={busy}
                >
                  باز کن
                </button>
              </li>
            ))}
          </ul>
        )}
      </Solid>
    </div>
  );
}
