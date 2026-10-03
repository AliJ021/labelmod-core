import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { pos, type Invoice, type PaymentMethod, type Warehouse } from "../lib/pos.ts";
import { PosProductPicker } from "./PosProductPicker.tsx";
import { Money } from "./ui/Money.tsx";
import { SafeAction } from "./ui/SafeAction.tsx";

interface Quote { token: string; returnedValue: string; replacementValue: string; debt: string; funds: string;
  debtApplied: string; transferAmount: string; fundedTransfer: string; collectAmount: string; refundAmount: string; policy: string }
export function ExchangePanel({ invoice, lines, reasonCode, reasonNote, returnWarehouseId, warehouses, methods, locked, run, verify }: {
  invoice: Invoice; lines: Array<{ invoiceLineId: string; qty: string; restock?: boolean; condition?: "sellable" | "defective" }>;
  reasonCode: string; reasonNote: string; returnWarehouseId: string; warehouses: Warehouse[]; methods: PaymentMethod[]; locked: boolean;
  run: (body: unknown) => Promise<void>; verify: () => Promise<boolean>;
}) {
  const [warehouseId, setWarehouseId] = useState(invoice.warehouseId);
  const [items, setItems] = useState<Array<{ id: string; name: string; sku: string; qty: string }>>([]);
  const [quote, setQuote] = useState<{ value: Quote; body: string } | null>(null);
  const [collectMethod, setCollectMethod] = useState("cash");
  const [collectReference, setCollectReference] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [refundReference, setRefundReference] = useState("");
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [sources, setSources] = useState<Array<{ id: string; methodCode?: string; reference: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [collectionMethods, setCollectionMethods] = useState<PaymentMethod[]>([]);
  useEffect(() => {
    let active = true;
    void pos.paymentMethods(invoice.branchId).then(r => {
      if (active) setCollectionMethods(r.methods.filter(m => ["cash", "card_reader", "gateway", "transfer"].includes(m.kind)));
    }).catch(() => { if (active) setError("روش‌های دریافت این شعبه خوانده نشد"); });
    return () => { active = false; };
  }, [invoice.branchId]);
  const body = { invoiceId: invoice.id, warehouseId, returnWarehouseId, lines,
    replacements: items.map(i => ({ variationId: i.id, qty: i.qty })), reasonCode,
    ...(reasonNote.trim() ? { reasonNote: reasonNote.trim() } : {}) };
  const currentQuote = quote?.body === JSON.stringify(body) ? quote.value : null;
  async function pick(id: string) {
    const item = await api.get<{ id: string; name: string; sku: string }>(`/exchanges/variation/${id}`);
    setItems(current => [...current, { ...item, qty: "1" }]);
  }
  async function preview() {
    setBusy(true); setError("");
    try {
      const [value, refundSources] = await Promise.all([
        api.post<Quote>("/exchanges/quote", body),
        api.get<{ payments: Array<{ id: string; methodCode?: string; reference: string }> }>(`/invoices/${invoice.id}/refund-sources`),
      ]);
      setQuote({ value, body: JSON.stringify(body) }); setSources(refundSources.payments);
    } catch (e) { setError(e instanceof ApiError ? e.message : "پیش‌نمایش خوانده نشد"); }
    finally { setBusy(false); }
  }
  return <section className="solid pad stack" aria-label="تعویض">
    <h3>تعویض — کالای جایگزین</h3>
    <label className="auth-field">انبار کالای جایگزین<select value={warehouseId} disabled={locked || busy} onChange={e => setWarehouseId(e.target.value)}>
      {warehouses.filter(w => !["defective", "in_transit"].includes(w.kind)).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select></label>
    <PosProductPicker warehouseId={warehouseId} busy={locked || busy} onPick={pick} />
    <div className="row" style={{ flexWrap: "wrap" }}>{invoice.lines.filter(l => lines.some(x => x.invoiceLineId === l.id)).map(l =>
      <button className="btn" type="button" key={l.id} disabled={locked || busy} onClick={() => void pick(l.variationId).catch(() => setError("کالا خوانده نشد"))}>
        جایگزین با همان تنوع: {l.productName} · {l.sku}
      </button>)}</div>
    {items.map((item, index) => <div className="row" key={`${item.id}-${index}`}>
      <span>{item.name} · {item.sku}</span>
      <label>تعداد<input aria-label={`تعداد جایگزین ${index + 1}`} inputMode="decimal" value={item.qty} disabled={locked || busy}
        onChange={e => setItems(current => current.map((v, i) => i === index ? { ...v, qty: e.target.value } : v))} /></label>
      <button className="btn" type="button" disabled={locked || busy} onClick={() => setItems(current => current.filter((_, i) => i !== index))}>حذف</button>
    </div>)}
    <button className="btn" type="button" disabled={locked || busy || !lines.length || !items.length || !reasonCode} onClick={() => void preview()}>۱. محاسبه و بررسی تسویه</button>
    {error ? <p role="alert">{error}</p> : null}
    {currentQuote ? <>
      <dl>
        <dt>ارزش برگشتی</dt><dd><Money rial={currentQuote.returnedValue} /></dd>
        <dt>ارزش جایگزین</dt><dd><Money rial={currentQuote.replacementValue} /></dd>
        <dt>بدهی قبلی</dt><dd><Money rial={currentQuote.debt} /></dd>
        <dt>کاهش بدهی قبلی</dt><dd><Money rial={currentQuote.debtApplied} /></dd>
        <dt>انتقال ارزش به جایگزین</dt><dd><Money rial={currentQuote.transferAmount} /></dd>
        <dt>دریافت اختلاف</dt><dd><Money rial={currentQuote.collectAmount} /></dd>
        <dt>بازپرداخت اختلاف</dt><dd><Money rial={currentQuote.refundAmount} /></dd>
      </dl>
      <p>{currentQuote.policy === "debt_first" ? "سیاست مدیر: ابتدا کاهش بدهی قبلی، سپس تسویه جایگزین." : "سیاست مدیر: بدهی قبلی حفظ می‌شود؛ فقط اختلاف قیمت تسویه می‌شود."}</p>
      {BigInt(currentQuote.collectAmount)>0n ? <>
        <label className="auth-field">روش دریافت اختلاف<select value={collectMethod} disabled={locked} onChange={e => setCollectMethod(e.target.value)}>
          {collectionMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select></label>
        <label className="auth-field">پیگیری دریافت تأییدشده<input value={collectReference} disabled={locked} onChange={e => setCollectReference(e.target.value)} /></label>
      </> : null}
      {BigInt(currentQuote.refundAmount)>0n ? <>
        <label className="auth-field">روش بازپرداخت اختلاف<select value={refundMethod} disabled={locked} onChange={e => { setRefundMethod(e.target.value); setRefundPaymentId(""); setRefundReference(""); }}>
          {methods.filter(m => m.code !== "snappay" && m.code !== "digipay").map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
          {[...new Set(sources.map(s => s.methodCode ?? "snappay"))].map(code => <option key={code} value={code}>{code === "digipay" ? "دیجی‌پی" : "اسنپ‌پی"} — برگشت تأییدشده</option>)}
        </select></label>
        {(refundMethod === "snappay" || refundMethod === "digipay") ? <>
          <label className="auth-field">پرداخت اصلی<select value={refundPaymentId} disabled={locked} onChange={e => setRefundPaymentId(e.target.value)}>
            <option value="">انتخاب کنید</option>{sources.filter(s => (s.methodCode ?? "snappay") === refundMethod).map(s => <option key={s.id} value={s.id}>{s.reference}</option>)}
          </select></label>
          <label className="auth-field">پیگیری برگشت تأییدشده<input value={refundReference} disabled={locked} onChange={e => setRefundReference(e.target.value)} /></label>
        </> : null}
      </> : null}
      <SafeAction trigger="۲. بررسی نهایی تعویض" title="تأیید نهایی تعویض" triggerVariant="primary" disabled={locked}
        summary={<><p>دریافت: <Money rial={currentQuote.collectAmount} /></p><p>بازپرداخت: <Money rial={currentQuote.refundAmount} /></p></>}
        consequence="بازگشت کالای انتخاب‌شده، خروج جایگزین و تسویه مالی با هم ثبت می‌شوند. فقط وجه واقعاً تأییدشده را ثبت کنید."
        confirmLabel="اقلام و تسویه را تأیید می‌کنم؛ ثبت تعویض" pendingLabel="در حال ثبت تعویض…"
        run={() => run({ ...body, token: currentQuote.token, confirmed: true, collectMethod, refundMethod,
          ...(collectReference.trim() ? { collectReference: collectReference.trim() } : {}),
          ...((refundMethod === "snappay" || refundMethod === "digipay") ? { refundReference: refundReference.trim(), refundPaymentId } : {}) })}
        verify={verify} onDone={() => undefined} />
    </> : null}
  </section>;
}
