import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useUrlState, navigate } from "../lib/use-url-state.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { pos, type Branch, type DraftPayment, type Invoice } from "../lib/pos.ts";
import { rememberCart } from "../lib/open-cart.ts";
import { toman } from "../lib/money.ts";
import { ResultState } from "../components/ResultState.tsx";
import { Field } from "../components/ui/Controls.tsx";
import { JalaliDateHint, useJalaliDraft } from "../components/ui/JalaliDate.tsx";
import { parseJalaliDate, readOptionalJalaliPeriod } from "../lib/report-filters.ts";

interface Row {
  id: string; number: string | null; status: string; branchId: string; branchName: string; shiftId: string | null;
  creatorName: string | null; finalizerName: string | null; customerName: string | null;
  occurredAt: string; payableAmount: string; receivedAmount: string; paymentMethods: string;
  canResume: boolean; needsReview: boolean | null;
}
const statusNames: Record<string, string> = { draft: "پیش‌نویس", finalized: "قطعی", paid: "پرداخت‌شده", cancelled: "لغوشده", returned: "مرجوع‌شده", partially_returned: "مرجوعی جزئی" };
const errorMessage = (e: unknown) => e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد.";
const date = (value: string) => new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(new Date(value));

export function Invoices() {
  const [status, setStatus] = useUrlState("invoices.status", "all");
  const [search, setSearch] = useUrlState("invoices.search", "", true);
  const [branch, setBranch] = useUrlState("invoices.branch");
  const [from, setFrom] = useUrlState("invoices.from");
  const [to, setTo] = useUrlState("invoices.to");
  const [page, setPage] = useUrlState("invoices.page", "1");
  const [selected, setSelected] = useUrlState("invoices.id");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // تاریخ: کاربر جلالی می‌نویسد و می‌بیند؛ نشانی و درخواست همان ISO میلادی می‌مانند (همان
  // قرارداد گزارش‌ها). فیلد خالی یعنی بی‌مرز. نیمه‌تایپ، ناموجود یا بازهٔ معکوس فقط خطای
  // کنار فیلد است و هیچ درخواستی نمی‌سازد.
  const [fromText, setFromText] = useJalaliDraft(from);
  const [toText, setToText] = useJalaliDraft(to);
  const range = readOptionalJalaliPeriod(fromText, toText);
  const issue = range.issue;
  function typeDate(text: string, setText: (t: string) => void, current: string, setIso: (iso: string) => void) {
    setText(text);
    // فقط تاریخ کامل و موجود (یا فیلد خالی) به نشانی می‌رود؛ نیمه‌تایپ محلی می‌ماند.
    let next = "";
    if (text.trim() !== "") {
      const r = parseJalaliDate(text);
      if (r.kind !== "ok") return;
      next = r.iso;
    }
    if (next === current) return;
    setIso(next); setPage("1");
  }
  const fromInput = useRef<HTMLInputElement>(null);
  // پنل فیلتر پس از پاک‌کردن تاریخ‌ها باز می‌ماند و تمرکز به «از تاریخ» می‌رود؛ دکمه‌ای
  // که زیر اشاره‌گر ناپدید شود تمرکز را به body می‌برد.
  const [extraOpen, setExtraOpen] = useState(() => !!(branch || from || to));
  function clearDates() {
    setFromText(""); setToText("");
    fromInput.current?.focus();
    if (from) setFrom("");
    if (to) setTo("");
    if (from || to) setPage("1");
  }
  const datesActive = !!(from || to || fromText.trim() || toText.trim());
  useEffect(() => { void pos.branches().then(r => setBranches(r.branches)).catch(e => setError(errorMessage(e))); }, []);
  const key = JSON.stringify([status, search, branch, page, from, to]);
  const load = useCallback((signal: AbortSignal) => {
    const q = new URLSearchParams({ status, search, page });
    if (branch) q.set("branchId", branch);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return api.get<{ rows: Row[]; total: number; pageSize: number }>(`/invoices?${q}`, { signal });
  }, [status, search, branch, page, from, to]);
  const query = useLatestQuery({ key, version: revision, load, delay: search ? 250 : 0, enabled: !selected && issue === null });
  async function resume(row: Row) {
    setError("");
    try {
      const [invoice, shift] = await Promise.all([pos.invoice(row.id), pos.currentShift(row.branchId)]);
      if (!shift || shift.id !== invoice.shiftId || shift.status !== "open" || invoice.createdBy !== shift.userId || invoice.status !== "draft")
        throw new ApiError(409, "draft_context", "این پیش‌نویس در شیفت فعلی قابل ادامه نیست.", null);
      rememberCart({ invoiceId: invoice.id, shiftId: shift.id });
      navigate(`/?page=pos&pos.branch=${encodeURIComponent(row.branchId)}&pos.warehouse=${encodeURIComponent(invoice.warehouseId)}`);
    } catch (e) { setError(errorMessage(e)); }
  }
  if (selected) return <InvoiceDetail id={selected} onBack={() => setSelected("")} />;
  return <section className="stack invoice-center">
    <header className="row between"><div><h1>فاکتورها</h1><p className="muted">فروش‌ها و پیش‌نویس‌های ذخیره‌شده در سرور</p></div>
      <button className="btn" type="button" onClick={() => setRevision(v => v + 1)}>تازه‌سازی</button></header>
    <div className="solid pad invoice-filters">
      <label className="auth-field">شماره یا نام مشتری<input type="search" value={search} maxLength={80} onChange={e => { setSearch(e.target.value); setPage("1"); }} /></label>
      <label className="auth-field">وضعیت<select value={status} onChange={e => { setStatus(e.target.value); setPage("1"); }}><option value="all">همه</option>
        {["draft", "finalized", "cancelled", "returned"].map(s => <option key={s} value={s}>{statusNames[s]}</option>)}</select></label>
      <details className="invoice-extra-filters" open={extraOpen || !!(branch || datesActive || issue)} onToggle={e => setExtraOpen(e.currentTarget.open)}>
      <summary>فیلتر شعبه و تاریخ{branch || from || to ? " · فعال" : ""}</summary>
      <div className="invoice-filter-fields">
      <Field label="شعبه"><select value={branch} onChange={e => { setBranch(e.target.value); setPage("1"); }}><option value="">شعبه‌های مجاز</option>{branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      {/* `inputMode="decimal"`: صفحه‌کلید عددی گوشی «/» ندارد؛ «.» یا هشت رقم پشت‌هم هم پذیرفته است. تقویم بومی میلادی عمداً نیست. */}
      <Field label="از تاریخ" hint={<JalaliDateHint iso={range.from} example="مثلاً ۱۴۰۵/۰۷/۰۱" />} error={issue?.field === "from" ? issue.message : null}>
        <input ref={fromInput} type="text" inputMode="decimal" autoComplete="off" className="num" value={fromText} placeholder="۱۴۰۵/۰۷/۰۱"
          onChange={e => typeDate(e.target.value, setFromText, from, setFrom)} />
      </Field>
      <Field label="تا تاریخ" hint={<JalaliDateHint iso={range.to} example="مثلاً ۱۴۰۵/۰۷/۳۰" />} error={issue?.field === "to" ? issue.message : null}>
        <input type="text" inputMode="decimal" autoComplete="off" className="num" value={toText} placeholder="۱۴۰۵/۰۷/۳۰"
          onChange={e => typeDate(e.target.value, setToText, to, setTo)} />
      </Field>
      </div>
      {datesActive ? <button type="button" className="btn invoice-clear-dates" onClick={clearDates}>پاک‌کردن تاریخ‌ها</button> : null}
      </details>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="solid pad" aria-busy={query.loading}>
      {issue ? <ResultState title="بازهٔ تاریخ کامل نیست." description={issue.message} /> : query.loading ? <ResultState kind="loading" title="در حال دریافت فاکتورها…" /> : query.error ? <ResultState kind="error" title={errorMessage(query.error)} actionLabel="تلاش دوباره" onAction={() => setRevision(v => v + 1)} /> : !query.data?.rows.length ? <ResultState title="فاکتوری با این فیلترها پیدا نشد." /> : <>
        <div className="scroll-x"><table className="grid invoice-table"><caption className="sr-only">فهرست فاکتورها؛ مبلغ‌ها به تومان</caption>
          <thead><tr><th>شماره / وضعیت</th><th>زمان / شعبه</th><th>مشتری</th><th>ثبت‌کننده</th><th>نهایی‌کننده</th><th>مبلغ / دریافتی</th><th>پرداخت‌ها</th><th>عملیات</th></tr></thead>
          <tbody>{query.data.rows.map(row => <tr key={row.id}>
            <td data-label="شماره / وضعیت">{row.number ?? "بدون شماره"}<small>{statusNames[row.status] ?? row.status}{row.needsReview ? " · نیازمند رسیدگی" : ""}</small></td>
            <td data-label="زمان / شعبه">{date(row.occurredAt)}<small>{row.branchName}</small></td><td data-label="مشتری">{row.customerName ?? "مشتری عمومی"}</td>
            <td data-label="ثبت‌کننده">{row.creatorName ?? "نامعلوم"}</td><td data-label="نهایی‌کننده">{row.finalizerName ?? (row.status === "draft" ? "هنوز نهایی نشده" : "نامعلوم")}</td>
            <td data-label="مبلغ / دریافتی" className="num">{toman(BigInt(row.payableAmount))}<small>{toman(BigInt(row.receivedAmount))} دریافتی</small></td><td data-label="روش پرداخت">{row.paymentMethods || "بدون دریافت"}</td>
            <td data-label="عملیات"><button className="btn" type="button" onClick={() => setSelected(row.id)}>جزئیات</button>
              {row.canResume && <button className="btn" type="button" onClick={() => void resume(row)}>ادامهٔ پیش‌نویس</button>}
              {["finalized", "paid", "partially_returned", "returned"].includes(row.status) && <a className="btn" href={`/api/invoices/${row.id}/print`} target="_blank" rel="noopener">چاپ فاکتور</a>}
            </td></tr>)}</tbody></table></div>
        <nav className="row between" aria-label="صفحه‌بندی فاکتورها"><button type="button" className="btn" disabled={Number(page) <= 1} onClick={() => setPage(String(Number(page)-1))}>قبلی</button>
          <span>صفحه {page} · {query.data.total} فاکتور</span><button type="button" className="btn" disabled={Number(page)*50 >= query.data.total} onClick={() => setPage(String(Number(page)+1))}>بعدی</button></nav>
      </>}
    </div>
  </section>;
}

function InvoiceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const load = useCallback((signal: AbortSignal) => api.get<{ invoice: Invoice; payments: DraftPayment[] }>(`/invoices/${encodeURIComponent(id)}/overview`, { signal }), [id]);
  const q = useLatestQuery({ key: id, load });
  const inv = q.data?.invoice;
  return <section className="solid pad stack"><button className="btn" type="button" onClick={onBack}>بازگشت به فاکتورها</button>
    {q.loading ? <ResultState kind="loading" title="در حال دریافت جزئیات…" /> : q.error ? <ResultState kind="error" title={errorMessage(q.error)} /> : inv && <>
      <h1>فاکتور {inv.number ?? "پیش‌نویس"}</h1><p>{statusNames[inv.status] ?? inv.status} · {date(inv.occurredAt)}</p>
      <div className="scroll-x"><table className="grid"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت واحد (تومان)</th><th>مبلغ (تومان)</th></tr></thead>
        <tbody>{inv.lines.map(l => <tr key={l.id}><td>{l.productName}<small>{l.sku}</small></td><td>{l.qty}</td><td>{toman(BigInt(l.unitPrice))}</td><td>{toman(BigInt(l.netAmount))}</td></tr>)}</tbody></table></div>
      <p>قابل پرداخت: <strong>{toman(BigInt(inv.payableAmount))} تومان</strong></p>
      <h2>گردش پرداخت</h2>{q.data?.payments.length ? q.data.payments.map(p => <p key={p.id}>{p.name} · {toman(BigInt(p.amount))} تومان · {p.direction === "in" ? "دریافت" : "برگشت"} · {({succeeded:"موفق",settled:"تسویه‌شده",reconciled:"تطبیق‌شده",reversed:"برگشت‌خورده",failed:"ناموفق",pending:"در انتظار",unknown:"نامشخص"} as Record<string,string>)[p.status] ?? p.status}</p>) : <p>پرداختی ثبت نشده است.</p>}
      {["finalized", "paid", "partially_returned", "returned"].includes(inv.status) && <a className="btn" href={`/api/invoices/${inv.id}/print`} target="_blank" rel="noopener">چاپ فاکتور / ذخیره PDF</a>}
    </>}
  </section>;
}
