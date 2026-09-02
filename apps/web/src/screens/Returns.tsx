/**
 * مرجوعی — از روی رسیدِ دست مشتری.
 *
 * ناحیه «متوسط» ADR-002: کارت‌ها شیشه‌ای، ولی هر سطر و هر عددی که
 * خوانده می‌شود مات. مرجوعی مثل صندوق زیر فشار صف نیست، ولی مبلغی که
 * از کشو بیرون می‌رود باید بی‌ابهام خوانده شود.
 *
 * ── جریان ─────────────────────────────────────────────────────────
 *
 *   شماره رسید → فاکتور → انتخاب اقلام → علت → مبلغ → ثبت
 *
 * دو تماس جدا لازم است و عمداً یکی نشده‌اند: `POST /returns` یک
 * **پیش‌نویس** می‌سازد و `POST /returns/:id/post` است که واقعاً کالا
 * را برمی‌گرداند و پول را بیرون می‌دهد. اگر دومی روی شبکه بشکند،
 * پیش‌نویس در `draft` می‌ماند و دکمه همان را دوباره ثبت می‌کند — نه
 * اینکه برگ دوم بسازد.
 *
 * ── چه چیزی اینجا تصمیم گرفته نمی‌شود ─────────────────────────────
 *
 * **مجوز.** بازپرداخت نقدی شیفت باز می‌خواهد و مبلغ بالا تأیید مدیر؛
 * هر دو را `returnGate` سمت سرور می‌سنجد و **دوباره** هنگام ثبت.
 * کپی‌کردن آن قواعد اینجا یعنی دو تعریف. پیام فارسی سرور همان چیزی
 * است که نشان داده می‌شود.
 *
 * **مبلغ نهایی.** آنچه این صفحه حساب می‌کند یک **پیشنهاد** است با
 * همان فرمول سرور. سقفش را دیتابیس می‌گذارد: «بازپرداخت از پول
 * واقعاً دریافت‌شده بیشتر نمی‌شود».
 */
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import {
  pos,
  type Branch,
  type Invoice,
  type PaymentMethod,
  type Returnable as ReturnableView,
  type ReturnReason,
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
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [view, setView] = useState<ReturnableView | null>(null);
  const [selection, setSelection] = useState<Selection>(new Map());

  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [refund, setRefund] = useState("");
  const [method, setMethod] = useState("");

  const [draft, setDraft] = useState<SaleReturn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [keys] = useState(() => new ActionKeys());

  useEffect(() => {
    void (async () => {
      try {
        const [b, m, r] = await Promise.all([
          pos.branches(),
          pos.paymentMethods(),
          pos.returnReasons(),
        ]);
        setBranches(b.branches);
        setMethods(m.methods);
        setReasons(r.reasons);
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

  const lookup = () =>
    guarded(async () => {
      setDone(null);
      setDraft(null);
      const inv = await pos.invoiceByNumber(number.trim(), branchId);
      const returnable = await pos.returnable(inv.id);
      setInvoice(inv);
      setView(returnable);
      setSelection(new Map());
      setRefund("");
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

  const submit = () =>
    guarded(async () => {
      if (!invoice || typedRefund === null) return;

      // بدنه **یک بار** ساخته می‌شود و هم به سرور می‌رود و هم نام عمل
      // را می‌سازد. اگر این دو از هم جدا شوند، کلید و بدنه می‌توانند
      // ناهم‌خوان شوند — دقیقاً همان چیزی که `actionFor` جلویش را
      // می‌گیرد.
      const body = {
        invoiceId: invoice.id,
        reasonCode: reason,
        refundAmount: typedRefund.toString(),
        lines: selectionToLines(selection),
        ...(note.trim() === "" ? {} : { reasonNote: note.trim() }),
        ...(method === "" ? {} : { refundMethod: method }),
      };

      // پیش‌نویس فقط یک بار ساخته می‌شود. اگر ثبت روی شبکه شکسته
      // باشد، همان پیش‌نویس دوباره ثبت می‌شود — نه برگ دوم.
      //
      // نام عمل از **بدنه** ساخته می‌شود، نه فقط از شناسه فاکتور:
      // Retry با همان فرم همان کلید را می‌برد (پس Replay می‌شود)، ولی
      // اگر صندوق‌دار پس از یک شکست مبلغ یا اقلام را اصلاح کند کلید
      // تازه می‌گیرد. با کلید ثابت، آن اصلاح ۴۰۹ می‌گرفت و صفحه تا
      // Reload گیر می‌کرد.
      const sheet =
        draft ??
        (await keys.run(actionFor(`return:${invoice.id}`, body), (key) =>
          pos.createReturn(body, { idempotencyKey: key }),
        ));
      setDraft(sheet);

      const posted = await keys.run(`return-post:${sheet.id}`, (key) =>
        pos.postReturn(sheet.id, { idempotencyKey: key }),
      );

      setDone(`برگ مرجوعی ${posted.number ?? ""} ثبت شد.`);
      setDraft(null);
      setInvoice(null);
      setView(null);
      setSelection(new Map());
      setNumber("");
      setRefund("");
      setReason("");
      setNote("");
    });

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
        <h2 style={{ marginTop: 0 }}>مرجوعی</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          شماره رسیدِ دست مشتری را وارد کنید.
        </p>

        {branches.length > 1 ? (
          <div className="stack" style={{ gap: "var(--s-2)", marginBottom: "var(--s-3)" }}>
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                className={b.id === branchId ? "btn btn--primary" : "btn"}
                onClick={() => setBranchId(b.id)}
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
            <label htmlFor="ret-no">شماره فاکتور</label>
            <input
              id="ret-no"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="F-1405-000123"
              autoComplete="off"
            />
          </Solid>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || number.trim() === "" || branchId === ""}
          >
            {busy ? "…" : "پیدا کن"}
          </button>
        </form>
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

      {view && invoice ? (
        <>
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

            <label className="auth-field">
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
                  onClick={() => setMethod(m.code)}
                  disabled={busy}
                >
                  {m.name}
                </button>
              ))}
            </div>
            {chosen?.kind === "cash" ? (
              <p className="muted small" style={{ margin: 0 }}>
                بازپرداخت نقدی شیفت باز می‌خواهد — وگرنه پول از کشو می‌رود ولی در شمارش
                نمی‌آید.
              </p>
            ) : null}

            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !ready || typedRefund === null}
              onClick={() => void submit()}
            >
              {busy ? "…" : draft ? "ثبت دوباره" : "ثبت مرجوعی"}
            </button>
          </Solid>
        </>
      ) : null}
    </div>
  );
}
