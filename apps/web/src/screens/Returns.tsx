/**
 * مرجوعی/تعویض با جست‌وجوی دقیق، انتخاب جزئی، تأیید دوم و بازیابی پایدار.
 * اثر مالی از endpoint اتمیک می‌آید؛ نتیجه نامعلوم فقط بررسی می‌شود.
 */
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { WebRefundRequests } from "./WebRefundRequests.tsx";
import { api, ApiError } from "../lib/api.ts";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { Money } from "../components/ui/Money.tsx";
import { ExchangePanel } from "../components/ExchangePanel.tsx";
import { ReturnRecovery, useReturnOperation } from "../components/ReturnRecovery.tsx";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import {
  pos,
  type Branch,
  type Invoice,
  type PaymentMethod,
  type Returnable as ReturnableView,
  type ReturnReason,
  type Warehouse,
  type SaleReturn,
} from "../lib/pos.ts";
import {
  clampQty,
  hasSelection,
  maxReturnable,
  selectionToLines,
  suggestedRefund,
  type Selection,
} from "../lib/returns.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

export function Returns() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [reasons, setReasons] = useState<ReturnReason[]>([]);

  const [number, setNumber] = useState("");
  const [lookupKind, setLookupKind] = useState<"number" | "phone">("number");
  const [mode, setMode] = useState<"returns" | "exchanges">("returns");
  const [matches, setMatches] = useState<Array<{ id: string; number: string; payableAmount: string }>>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [view, setView] = useState<ReturnableView | null>(null);
  const [selection, setSelection] = useState<Selection>(new Map());
  const [quality, setQuality] = useState<Record<string, { restock: boolean; condition: "sellable" | "defective" }>>({});

  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [refund, setRefund] = useState("");
  const [method, setMethod] = useState("");
  const [refundReference, setRefundReference] = useState("");
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundSources, setRefundSources] = useState<Array<{ id: string; methodCode?: string; reference: string; remaining: string }>>([]);
  const [drawers, setDrawers] = useState<Array<{ id: string; userName: string; openedAt: string }>>([]);
  const [drawerId, setDrawerId] = useState("");

  const [draft, setDraft] = useState<SaleReturn | null>(null);
  /** مقصد کالای سالم. `""` یعنی همان انبار فاکتور. */
  const [destWh, setDestWh] = useState("");
  const [outlets, setOutlets] = useState<Warehouse[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const operation = useReturnOperation((postedNumber) => {
    setDone(`عملیات ${postedNumber} ثبت شد.`);
    setInvoice(null); setView(null); setSelection(new Map()); setRefund("");
  });

  useEffect(() => {
    void (async () => {
      try {
        const [b, m, r] = await Promise.all([
          pos.branches(),
          pos.paymentMethods(),
          pos.returnReasons(),
        ]);
        setBranches(b.branches);
        setMethods(m.methods.filter((x) => ["cash", "card_reader", "gateway", "transfer"].includes(x.kind)));
        setReasons(r.reasons);
        // انبارهای آوتلت همه شعبه‌ها. فهرست شعبه `warehouses` را با
        // `kind` می‌دهد، پس فیلتر اینجا یک تصمیم نمایشی است نه یک
        // دروازه — دروازه سمت سرور است.
        setOutlets(
          b.branches.flatMap((x) => x.warehouses.filter((w) => w.kind === "outlet")),
        );
        if (b.branches.length === 1) setBranchId(b.branches[0]?.id ?? "");
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

  async function loadInvoice(inv: Invoice) {
      const [returnable, open] = await Promise.all([pos.returnable(inv.id), pos.openShifts(inv.branchId)]);
      setDrawers(open);
      setDrawerId(open.length === 1 ? open[0]?.id ?? "" : "");
      const sources = await api.get<{ payments: Array<{ id: string; methodCode?: string; reference: string; remaining: string }> }>(`/invoices/${inv.id}/refund-sources`);
      setRefundSources(sources.payments);
      setRefundPaymentId(sources.payments.length === 1 ? sources.payments[0]!.id : "");
      setRefundReference(""); setMethod("");
      setMethods(current => [...current.filter(m => m.code !== "snappay" && m.code !== "digipay"), ...[...new Set(sources.payments.map(p => p.methodCode ?? "snappay"))].map(code => ({code, name: `${code === "digipay" ? "دیجی‌پی" : "اسنپ‌پی"} — برگشت تأییدشده`, kind: "gateway", requiresRef: true}))]);
      setInvoice(inv);
      setView(returnable);
      setSelection(new Map());
      setQuality({});
      setRefund("");
  }
  const lookup = (before?: string) => guarded(async () => {
    if (operation.pending) throw new Error("ابتدا نتیجه عملیات قبلی را بررسی کنید");
    setDone(null); setDraft(null); setInvoice(null); setView(null);
    if (lookupKind === "phone") {
      const found = await api.get<{ invoices: typeof matches; next: string | null }>(
        `/invoices/by-phone?phone=${encodeURIComponent(number.trim())}&branchId=${branchId}${before ? `&before=${before}` : ""}`);
      setMatches(found.invoices); setNextPage(found.next);
      if (!found.invoices.length) setDone("فاکتوری برای این شماره پیدا نشد.");
    } else {
      setMatches([]); setNextPage(null);
      await loadInvoice(await pos.invoiceByNumber(number.trim(), branchId));
    }
  });

  function setQty(invoiceLineId: string, qty: number) {
    const row = view?.lines.find((l) => l.invoiceLineId === invoiceLineId);
    if (!row) return;
    const next = new Map(selection);
    next.set(invoiceLineId, clampQty(row, qty));
    setSelection(next);
    // مبلغ پیشنهادی با هر تغییر انتخاب به‌روز می‌شود، مگر اینکه
    // صندوق‌دار خودش عددی نوشته باشد — آن‌وقت دست‌نخورده می‌ماند.
    if (refund === "") setDone(null);
  }

  const suggestion = view ? suggestedRefund(view.lines, selection) : 0n;
  const typedRefund = refund.trim() === "" ? suggestion : rialFromTomanInput(refund);
  const selectedLines = selectionToLines(selection).map(l => ({ ...l, ...(quality[l.invoiceLineId] ?? { restock: true, condition: "sellable" as const }) }));

  async function submit() {
    if (!invoice || typedRefund === null) throw new Error("اقلام مرجوعی کامل نیست");
    const body = {
      invoiceId: invoice.id, reasonCode: reason, refundAmount: typedRefund.toString(),
      lines: selectedLines, confirmed: true,
      ...(note.trim() ? { reasonNote: note.trim() } : {}),
      ...(method ? { refundMethod: method } : {}),
      ...((method === "snappay" || method === "digipay") ? { refundReference: refundReference.trim(), refundPaymentId } : {}),
      ...((chosen?.kind === "cash" || method === "") && drawerId ? { shiftId: drawerId } : {}),
      ...(destWh ? { warehouseId: destWh } : {}),
    };
    await operation.run("returns", body);
  }

  /** نام کالا از خودِ فاکتور می‌آید — `returnable` فقط شناسه می‌دهد. */
  function nameOf(invoiceLineId: string) {
    const l = invoice?.lines.find((x) => x.id === invoiceLineId);
    return l ? { name: l.productName, sku: l.sku } : { name: "—", sku: "" };
  }

  const chosen = methods.find((m) => m.code === method) ?? null;
  const ready = invoice !== null && hasSelection(selection) && reason !== "";

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <Glass as="section" className="pad" live>
        <h2 style={{ marginTop: 0 }}>مرجوعی و تعویض</h2>
        <div className="row" role="group" aria-label="نوع عملیات">
          <button className="btn" type="button" disabled={!!operation.pending} aria-pressed={mode === "returns"} onClick={() => setMode("returns")}>مرجوعی</button>
          <button className="btn" type="button" disabled={!!operation.pending} aria-pressed={mode === "exchanges"} onClick={() => setMode("exchanges")}>تعویض</button>
        </div>
        <ReturnRecovery operation={operation} />
        <p className="muted" style={{ marginTop: 0 }}>
          شماره دقیق فاکتور یا شماره همراه ثبت‌شده مشتری را وارد کنید.
        </p>

        {branches.length > 1 ? (
          <div className="stack" style={{ gap: "var(--s-2)", marginBottom: "var(--s-3)" }}>
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                className={b.id === branchId ? "btn btn--primary" : "btn"}
                onClick={() => { setBranchId(b.id); setInvoice(null); setView(null); setMatches([]); }}
                disabled={!!operation.pending}
              >
                {b.name}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="stack"
          style={{ gap: "var(--s-3)" }}
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
        >
          <Solid className="auth-field">
            <label htmlFor="ret-lookup-kind">جست‌وجو با</label>
            <select id="ret-lookup-kind" value={lookupKind} disabled={!!operation.pending} onChange={e => { setLookupKind(e.target.value as "number" | "phone"); setNumber(""); setMatches([]); setNextPage(null); }}>
              <option value="number">شماره فاکتور</option><option value="phone">شماره همراه مشتری</option>
            </select>
            <label htmlFor="ret-no">{lookupKind === "number" ? "شماره فاکتور" : "شماره همراه"}</label>
            <input
              id="ret-no"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder={lookupKind === "number" ? "F-1405-000123" : "۰۹۱۲…"}
              disabled={!!operation.pending}
              autoComplete="off"
            />
          </Solid>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !!operation.pending || !operation.ready || number.trim() === "" || branchId === ""}
          >
            {busy ? "…" : "پیدا کن"}
          </button>
        </form>
        <div className="stack">{matches.map(row => <button className="btn" type="button" key={row.id} disabled={busy || !!operation.pending}
          onClick={() => void guarded(async () => loadInvoice(await api.get<Invoice>(`/invoices/${row.id}`)))}>
          {row.number} · <Money rial={row.payableAmount} />
        </button>)}</div>
        {nextPage ? <button className="btn" disabled={busy || !!operation.pending} onClick={() => void lookup(nextPage)}>صفحه بعد</button> : null}
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

      {mode === "returns" ? <WebRefundRequests key={branchId} branchId={branchId} /> : null}

      {view && invoice ? (
        <fieldset className="stack" disabled={!!operation.pending} style={{ border: 0, padding: 0, minWidth: 0 }}>
          {view.late ? (
            <p className="solid pos-alert" role="status">
              <span className="dot dot--warn" aria-hidden="true">●</span> این فروش{" "}
              {view.hoursSinceSale} ساعت پیش بوده و از مهلت مرجوعی گذشته — ثبتش تأیید
              مدیر می‌خواهد.
            </p>
          ) : null}

          <Solid as="section" className="pad">
            <h3 style={{ marginTop: 0 }}>
              فاکتور {invoice.number} — <span className="num">{toman(parseRial(invoice.netAmount))}</span>{" "}
              تومان
            </h3>
            <ul className="lines">
              {view.lines.map((l) => {
                const max = maxReturnable(l);
                const picked = selection.get(l.invoiceLineId) ?? 0;
                const info = nameOf(l.invoiceLineId);
                return (
                  <li key={l.invoiceLineId}>
                    <div className="line-name">
                      <strong>{info.name}</strong>
                      <span className="muted small">
                        {info.sku} · فروخته {Number(l.soldQty)}
                        {Number(l.returnedQty) > 0
                          ? ` · قبلاً برگشته ${Number(l.returnedQty)}`
                          : ""}
                      </span>
                    </div>
                    <div className="qty">
                      <button
                        type="button"
                        onClick={() => setQty(l.invoiceLineId, picked - 1)}
                        disabled={busy || picked <= 0}
                        aria-label={`کم کردن ${info.name}`}
                      >
                        −
                      </button>
                      <span className="num" aria-live="polite">{picked}</span>
                      <button
                        type="button"
                        onClick={() => setQty(l.invoiceLineId, picked + 1)}
                        disabled={busy || picked >= max}
                        aria-label={`اضافه کردن ${info.name}`}
                      >
                        +
                      </button>
                    </div>
                    <span className="num line-total">
                      {max === 0 ? "کاملاً برگشته" : `حداکثر ${max}`}
                    </span>
                    {picked > 0 ? <label>وضعیت کالای برگشتی<select aria-label={`وضعیت برگشتی ${info.name}`}
                      value={quality[l.invoiceLineId]?.restock === false ? "no_restock" : quality[l.invoiceLineId]?.condition ?? "sellable"}
                      onChange={e => setQuality(current => ({ ...current, [l.invoiceLineId]: { restock: e.target.value !== "no_restock", condition: e.target.value === "defective" ? "defective" : "sellable" } }))}>
                      <option value="sellable">سالم — بازگشت به انبار انتخاب‌شده</option><option value="defective">معیوب — انبار معیوب</option>
                      <option value="no_restock">بدون بازگشت موجودی</option>
                    </select></label> : null}
                  </li>
                );
              })}
            </ul>
          </Solid>

          <Solid as="section" className="pad stack" style={{ gap: "var(--s-3)" }}>
            <h3 style={{ margin: 0 }}>علت و مبلغ</h3>

            <label className="auth-field">
              <span>علت مرجوعی</span>
              {/* فهرست از `platform.setting` می‌آید، نه از کد. */}
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">— انتخاب کنید —</option>
                {reasons.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="auth-field">
              <span>توضیح (اختیاری)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>

            {mode === "returns" ? <><label className="auth-field">
              <span>
                مبلغ بازپرداخت (تومان) — خالی یعنی پیشنهاد سرور:{" "}
                <span className="num">{toman(suggestion)}</span>
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={refund}
                onChange={(e) => setRefund(e.target.value)}
                placeholder={toman(suggestion)}
              />
            </label>

            <div className="stack" style={{ gap: "var(--s-2)" }}>
              <span className="muted small">روش بازپرداخت</span>
              {methods.map((m) => (
                <button
                  key={m.code}
                  type="button"
                  className={m.code === method ? "btn btn--primary" : "btn"}
                  onClick={() => { setMethod(m.code); setRefundPaymentId(""); setRefundReference(""); }}
                  disabled={busy}
                >
                  {m.name}
                </button>
              ))}
            </div>
            {(method === "snappay" || method === "digipay") && <div className="stack solid pad">
              <p>ابتدا برگشت را در پنل {method === "digipay" ? "دیجی‌پی" : "اسنپ‌پی"} تأیید کنید؛ این فرم پولی جابه‌جا نمی‌کند.</p>
              <label>پرداخت اصلی {method === "digipay" ? "دیجی‌پی" : "اسنپ‌پی"}<select value={refundPaymentId} disabled={busy || !!draft} onChange={e => setRefundPaymentId(e.target.value)}>
                <option value="">انتخاب پرداخت</option>{refundSources.filter(p => (p.methodCode ?? "snappay") === method).map(p => <option key={p.id} value={p.id}>{p.reference} · باقی‌مانده {toman(parseRial(p.remaining))} تومان</option>)}
              </select></label>
              <label>شماره پیگیری برگشت تأییدشده<input value={refundReference} maxLength={200} disabled={busy || !!draft} onChange={e => setRefundReference(e.target.value)} /></label>
            </div>}
            {(chosen?.kind === "cash" || method === "") && drawers.length > 1 ? (
              <label className="auth-field">
                <span>صندوق بازپرداخت</span>
                <select value={drawerId} onChange={(e) => setDrawerId(e.target.value)} disabled={busy || draft !== null}>
                  <option value="">صندوق را انتخاب کنید</option>
                  {drawers.map((d) => <option key={d.id} value={d.id}>{d.userName} — {new Date(d.openedAt).toLocaleString("fa-IR")}</option>)}
                </select>
              </label>
            ) : null}
            {chosen?.kind === "cash" ? (
              <p className="muted small" style={{ margin: 0 }}>
                بازپرداخت نقدی شیفت باز می‌خواهد — وگرنه پول از کشو می‌رود ولی در شمارش
                نمی‌آید.
              </p>
            ) : null}

            </> : null}
            {/*
              مقصد کالای سالم — قفسه یا آوتلت.

              ⚠️ فقط وقتی نشان داده می‌شود که آوتلتی تعریف شده باشد.
              یک انتخاب‌گر تک‌گزینه‌ای فقط جای صفحه را می‌گیرد و
              صندوق‌دار را به فکر می‌اندازد که چیزی را جا انداخته.

              کالای **معیوب** اینجا نمی‌آید: آن فارغ از این انتخاب به
              انبار معیوب می‌رود و صندوق‌دار تصمیمی درباره‌اش ندارد.
            */}
            {outlets.length > 0 ? (
              <label className="auth-field">
                <span>کالای سالم کجا برگردد؟</span>
                <select
                  className="set-input"
                  value={destWh}
                  disabled={busy}
                  onChange={(e) => setDestWh(e.target.value)}
                >
                  <option value="">همان‌جا که فروخته شد</option>
                  {outlets.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {mode === "returns" ? <SafeAction trigger="۱. بررسی مرجوعی" title="۲. تأیید نهایی مرجوعی" triggerVariant="primary"
              summary={<p>بازپرداخت: <Money rial={typedRefund} /></p>}
              consequence="فقط اقلام و تعداد انتخاب‌شده به انبار برمی‌گردند و تسویه مالی هم‌زمان ثبت می‌شود."
              confirmLabel="اقلام و مبلغ را تأیید می‌کنم؛ ثبت مرجوعی" pendingLabel="در حال ثبت مرجوعی…"
              disabled={busy || !!operation.pending || !operation.ready || !ready || typedRefund === null || ((method === "snappay" || method === "digipay") && (!refundPaymentId || !refundReference.trim())) || (typedRefund > 0n && (chosen?.kind === "cash" || method === "") && drawers.length > 1 && drawerId === "")}
              run={submit} verify={operation.verify} onDone={() => undefined} /> : null}
          </Solid>
          {mode === "exchanges" ? <ExchangePanel key={invoice.id} invoice={invoice} lines={selectedLines} reasonCode={reason} reasonNote={note}
            returnWarehouseId={destWh || invoice.warehouseId} warehouses={branches.find(b => b.id === invoice.branchId)?.warehouses ?? []}
            methods={methods} locked={busy || !!operation.pending || !operation.ready}
            run={body => operation.run("exchanges", body)} verify={operation.verify} /> : null}
        </fieldset>
      ) : null}
    </div>
  );
}
