/**
 * «سفارش‌های سایت» — فهرست و جزئیات سفارش ووکامرس برای مدیر؛ فقط‌خواندنی.
 *
 * - داده هر بار مستقیم از سایت خوانده می‌شود (امضاشده، بی‌کش). «نامعلوم» با دلیل نشان داده می‌شود، نه
 *   فهرست خالی. هیچ دکمه‌ای سفارش را تغییر نمی‌دهد؛ ویرایش جایش پیشخوان ووکامرس است.
 * - **صفحه‌بندی پایدار:** صفحهٔ اول یک لنگر زمانی (`until`) برمی‌گرداند و صفحه‌های بعد با همان لنگر خوانده
 *   می‌شوند، پس سفارش تازه ردیف‌ها را جابه‌جا نمی‌کند. «به‌روزرسانی» لنگر را برمی‌دارد. سقفی روی تعداد
 *   صفحه‌های تاریخچه نیست؛ هزینهٔ هر درخواست با ۲۰ سفارش در صفحه محدود است.
 * - وضعیت (شامل زباله‌دان)، تاریخ، روش پرداخت و ارسال، صفحه، لنگر و سفارش انتخاب‌شده در نشانی صفحه‌اند
 *   (`useUrlState`). **عبارت جست‌وجو نه در نشانی صفحه است و نه در نشانی درخواست**: ممکن است تلفن یا ایمیل
 *   مشتری باشد؛ نشانی صفحه در تاریخچهٔ مرورگر می‌ماند و نشانی درخواست در لاگ دسترسی Caddy.
 * - لنگر ثانیهٔ جاری را ندارد؛ سفارشی که با تاریخ گذشته درج یا تاریخش ویرایش شود هنوز می‌تواند صفحه‌ها را
 *   جابه‌جا کند (مرز صریح در README افزونه).
 * - جزئیات همهٔ میدان‌های عملیاتی سفارش را برای مدیر نشان می‌دهد (تماس و نشانی، ویژگی تنوع، تخفیف و مالیات
 *   سطر، هزینه، کوپن، استرداد، یادداشت) — نه متای خام، نه IP. اقلام و یادداشت‌ها صفحه‌بندی‌اند.
 * - هر خواندن قبلی لغو می‌شود و پاسخ دیررس بی‌اثر است (همان الگوی نسل داشبورد).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { navigate, useUrlState } from "../lib/use-url-state.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { parseJalaliDate, readOptionalJalaliPeriod } from "../lib/report-filters.ts";
import {
  addressLines, coreState, isPaymentId, isShippingId, isStatusSlug, moneyView, ORDERS_PAGE_MAX, orderStatusState, siteOrders,
  type Address, type OrderDetail, type OrderItem, type OrderSummary, type OrdersPage, type OrderView, type WooMoney,
} from "../lib/site-orders.ts";
import { Solid } from "../components/Glass.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { FilterBar } from "../components/ui/FilterBar.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { JalaliDateHint, useJalaliDraft } from "../components/ui/JalaliDate.tsx";

type Load<T> = { state: "loading" } | { state: "done"; data: T } | { state: "error"; message: string; reference: string | null };

/** یک خواندن در هر لحظه؛ قبلی لغو و پاسخ دیررس بی‌اثر. */
function useLatest<T>(read: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const gen = useRef(0);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(read, deps);
  useEffect(() => {
    const controller = new AbortController();
    const mine = ++gen.current;
    setLoad({ state: "loading" });
    run(controller.signal).then(
      data => { if (gen.current === mine) setLoad({ state: "done", data }); },
      (err: unknown) => {
        if (gen.current !== mine || controller.signal.aborted) return;
        setLoad(err instanceof ApiError
          ? { state: "error", message: err.message, reference: err.correlationId }
          : { state: "error", message: "ارتباط با سرور برقرار نشد.", reference: null });
      });
    return () => { controller.abort(); };
  }, [run, tick]);
  return [load, () => setTick(t => t + 1)];
}

/** ریالِ دقیق با `Money`؛ ارز دیگر با مبلغ و کد خودش؛ هیچ‌وقت تبدیل حدسی. */
function Amount({ m, currency }: { m: WooMoney; currency: string }) {
  const v = moneyView(m, currency);
  if (v.kind === "rial") return <Money rial={v.rial} exact size="sm" />;
  if (v.kind === "foreign") {
    return <span title="این مبلغ به ارز خود سفارش است و Core قرارداد تبدیلش به ریال را ندارد">
      <Ltr>{v.amount} {v.currency}</Ltr>
    </span>;
  }
  return <span className="muted" title="مبلغ از سایت خوانده نشد">نامعلوم</span>;
}

const PARAM = { status: "site-orders.status", page: "site-orders.page", from: "site-orders.from", to: "site-orders.to",
  payment: "site-orders.payment", shipping: "site-orders.shipping", until: "site-orders.until", order: "site-orders.order" } as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** چند کلید نشانی در یک جابه‌جایی؛ مقدار خالی یعنی حذف. */
function setParams(next: Partial<Record<keyof typeof PARAM, string>>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(next) as [keyof typeof PARAM, string][]) {
    if (v === "") url.searchParams.delete(PARAM[k]); else url.searchParams.set(PARAM[k], v);
  }
  navigate(url.href);
}

export function SiteOrders() {
  const [statusParam] = useUrlState(PARAM.status);
  const [pageParam] = useUrlState(PARAM.page);
  const [fromParam] = useUrlState(PARAM.from);
  const [toParam] = useUrlState(PARAM.to);
  const [paymentParam] = useUrlState(PARAM.payment);
  const [shippingParam] = useUrlState(PARAM.shipping);
  const [untilParam] = useUrlState(PARAM.until);
  const [orderParam] = useUrlState(PARAM.order);
  const status = isStatusSlug(statusParam) ? statusParam : null;
  const payment = isPaymentId(paymentParam) ? paymentParam : null;
  const shipping = isShippingId(shippingParam) ? shippingParam : null;
  const from = ISO_DAY.test(fromParam) ? fromParam : null;
  const to = ISO_DAY.test(toParam) ? toParam : null;
  const pageRaw = /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
  const page = pageRaw <= ORDERS_PAGE_MAX ? pageRaw : 1;
  const until = /^[1-9]\d{0,9}$/.test(untilParam) ? Number(untilParam) : null;
  const orderId = /^[1-9]\d{0,15}$/.test(orderParam) ? Number(orderParam) : null;

  // جست‌وجو فقط در حافظهٔ صفحه؛ با «جست‌وجو» یا Enter اعمال می‌شود، نه با هر نویسه.
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState<string | null>(null);

  const [list, reload] = useLatest<OrdersPage>(signal => siteOrders.list({ page, status, search, from, to, payment, shipping, until }, { signal }),
    [page, status, search, from, to, payment, shipping, until]);
  const ready = list.state === "done" && list.data.state === "ready" ? list.data : null;
  /** فیلتر تازه یعنی صفحهٔ اول، لنگر تازه و بستن جزئیات. */
  const refilter = (next: Partial<Record<keyof typeof PARAM, string>>) => setParams({ ...next, page: "", until: "", order: "" });

  const [fromText, setFromText] = useJalaliDraft(fromParam);
  const [toText, setToText] = useJalaliDraft(toParam);
  const range = readOptionalJalaliPeriod(fromText, toText);
  function typeDate(text: string, setText: (t: string) => void, key: "from" | "to", current: string) {
    setText(text);
    let next = "";
    if (text.trim() !== "") {
      const r = parseJalaliDate(text);
      if (r.kind !== "ok") return;
      next = r.iso;
    }
    const other = key === "from" ? toParam : fromParam;
    if (next === current || (next && other && (key === "from" ? next > other : next < other))) return;
    refilter({ [key]: next });
  }

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    const v = searchDraft.trim();
    setSearch(v === "" ? null : v);
    refilter({});
  }
  const filtered = !!(status || payment || shipping || from || to || search);
  function reset() {
    setSearchDraft(""); setSearch(null); setFromText(""); setToText("");
    refilter({ status: "", payment: "", shipping: "", from: "", to: "" });
  }

  return <div className="stack">
    <PageHeader title="سفارش‌های سایت"
      context="مستقیم از سایت و فقط خواندنی؛ ویرایش، لغو و استرداد از پیشخوان ووکامرس انجام می‌شود."
      meta={list.state === "done" ? <span className="nowrap">خوانده‌شده {formatJalaliMoment(list.data.fetchedAt)}</span> : undefined}
      actions={<Button onClick={() => { if (until === null) reload(); else setParams({ until: "" }); }}
        disabled={list.state === "loading"}>به‌روزرسانی</Button>} />
    <FilterBar label="فیلتر سفارش‌ها" onReset={filtered ? reset : undefined}>
      <form className="site-orders-search" role="search" aria-label="جست‌وجوی سفارش" onSubmit={submitSearch}>
        <Field label="جست‌وجو" hint="شماره سفارش، نام، تلفن یا ایمیل مشتری؛ در نشانی صفحه نگه داشته نمی‌شود.">
          <input type="search" maxLength={100} autoComplete="off" value={searchDraft} onChange={e => setSearchDraft(e.target.value)} />
        </Field>
        <Button type="submit">جست‌وجو</Button>
      </form>
      <Field label="وضعیت سفارش">
        <select value={status ?? ""} onChange={e => refilter({ status: e.target.value })}>
          <option value="">همهٔ وضعیت‌ها</option>
          {/* وضعیت‌ها از خود سایت می‌آیند، وضعیت‌های افزونه‌ای هم. */}
          {(ready?.statuses ?? (status ? [{ slug: status, label: status }] : [])).map(s => <option key={s.slug} value={s.slug}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="روش پرداخت">
        <select value={payment ?? ""} onChange={e => refilter({ payment: e.target.value })}>
          <option value="">همهٔ روش‌ها</option>
          {(ready?.paymentMethods ?? (payment ? [{ id: payment, title: payment }] : [])).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </Field>
      <Field label="روش ارسال">
        <select value={shipping ?? ""} onChange={e => refilter({ shipping: e.target.value })}>
          <option value="">همهٔ روش‌ها</option>
          {(ready?.shippingMethods ?? (shipping ? [{ id: shipping, title: shipping }] : [])).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
      </Field>
      <Field label="از تاریخ" hint={<JalaliDateHint iso={range.from} example="مثلاً ۱۴۰۵/۰۷/۰۱" />} error={range.issue?.field === "from" ? range.issue.message : null}>
        <input type="text" inputMode="decimal" autoComplete="off" className="num" value={fromText} placeholder="۱۴۰۵/۰۷/۰۱"
          onChange={e => typeDate(e.target.value, setFromText, "from", fromParam)} />
      </Field>
      <Field label="تا تاریخ" hint={<JalaliDateHint iso={range.to} example="مثلاً ۱۴۰۵/۰۷/۳۰" />} error={range.issue?.field === "to" ? range.issue.message : null}>
        <input type="text" inputMode="decimal" autoComplete="off" className="num" value={toText} placeholder="۱۴۰۵/۰۷/۳۰"
          onChange={e => typeDate(e.target.value, setToText, "to", toParam)} />
      </Field>
    </FilterBar>
    <OrdersList load={list} page={page} selected={orderId} anchored={until !== null}
      onPage={p => setParams({ page: p === 1 ? "" : String(p), until: ready ? String(ready.until) : "", order: "" })}
      onSelect={id => setParams({ order: id === null ? "" : String(id) })} onRetry={reload} />
    {orderId !== null ? <OrderPanel key={orderId} id={orderId} onClose={() => setParams({ order: "" })} /> : null}
  </div>;
}

function Unavailable({ title, message, code, onRetry }: { title: string; message: string; code: string; onRetry: () => void }) {
  return <ResultState kind="error" title={title} reference={code} actionLabel="تلاش دوباره" onAction={onRetry}
    description={`${message} این به معنای «سفارشی نیست» نیست.`} />;
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const [draft, setDraft] = useState("");
  const target = Number(normalizeDigits(draft.trim()));
  const valid = Number.isInteger(target) && target >= 1 && target <= pages;
  return <nav className="site-orders-pager" aria-label="صفحه‌های سفارش">
    <Button disabled={page <= 1} onClick={() => onPage(1)}>صفحهٔ اول</Button>
    <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>صفحهٔ قبل</Button>
    <span className="num" aria-current="page">صفحهٔ {formatCount(page)} از {formatCount(pages)}</span>
    <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>صفحهٔ بعد</Button>
    <form className="site-orders-goto" onSubmit={e => { e.preventDefault(); if (valid) { onPage(target); setDraft(""); } }}>
      <Field label="رفتن به صفحه">
        <input type="text" inputMode="numeric" autoComplete="off" className="num" value={draft} onChange={e => setDraft(e.target.value)} />
      </Field>
      <Button type="submit" disabled={!valid}>برو</Button>
    </form>
  </nav>;
}

function OrdersList({ load, page, selected, anchored, onPage, onSelect, onRetry }: {
  load: Load<OrdersPage>; page: number; selected: number | null; anchored: boolean;
  onPage: (p: number) => void; onSelect: (id: number | null) => void; onRetry: () => void;
}) {
  const columns: Column<OrderSummary>[] = [
    { key: "number", header: "سفارش", cell: r => <Ltr>#{r.number}</Ltr> },
    { key: "date", header: "تاریخ", cell: r => r.createdAt ? <span className="nowrap">{formatJalaliMoment(r.createdAt)}</span> : <span className="muted">—</span> },
    { key: "customer", header: "مشتری", cell: r => <>{r.customerName || <span className="muted">بی‌نام</span>}{r.customerType === "guest" ? <span className="muted small"> (مهمان)</span> : null}</> },
    { key: "status", header: "وضعیت سایت", cell: r => <StatusBadge state={orderStatusState(r.status)} label={r.statusLabel || r.status} /> },
    { key: "payment", header: "پرداخت", cell: r => r.paymentMethod || <span className="muted">—</span> },
    { key: "core", header: "ثبت در Core", cell: r => { const c = coreState(r.core); return <StatusBadge state={c.state} label={c.label} quiet />; } },
    { key: "items", header: "کالا", numeric: true, cell: r => <span className="num">{formatCount(r.itemCount)}</span> },
    { key: "total", header: "مبلغ", numeric: true, cell: r => <Amount m={r.total} currency={r.currency} /> },
  ];
  const data = load.state === "done" && load.data.state === "ready" ? load.data : null;
  return <Solid as="section" className="pad" aria-labelledby="site-orders-list">
    <SectionHeader id="site-orders-list" title="فهرست سفارش‌ها"
      description={data
        ? `${formatCount(data.total)} سفارش؛ تازه‌ترین اول، تا ${formatJalaliMoment(new Date(data.until * 1000).toISOString())}`
          + (anchored ? " — سفارش‌های تازه‌تر با «به‌روزرسانی»" : "")
        : "تازه‌ترین اول"} />
    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={4} label="در حال خواندن سفارش‌های سایت…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="سفارش‌های سایت خوانده نشد" reference={load.reference}
            description={`${load.message} این به معنای «سفارشی نیست» نیست.`} actionLabel="تلاش دوباره" onAction={onRetry} />
        : load.data.state === "unavailable"
          ? <Unavailable title="سایت پاسخ قابل‌اعتماد نداد" message={load.data.message} code={load.data.code} onRetry={onRetry} />
          : <>
              <DataTable caption="سفارش‌های سایت" columns={columns} rows={load.data.orders} rowKey={r => String(r.id)} stack
                rowActions={r => <Button variant="quiet" aria-pressed={r.id === selected}
                  aria-label={`جزئیات سفارش ${r.number}`} onClick={() => onSelect(r.id === selected ? null : r.id)}>جزئیات</Button>}
                empty={{ title: "در این صفحه سفارشی نیست.", description: "فیلتر یا صفحه را عوض کنید." }} />
              {load.data.pages > 1 ? <Pager page={page} pages={load.data.pages} onPage={onPage} /> : null}
            </>}
  </Solid>;
}

function OrderPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const [itemsPage, setItemsPage] = useState(1);
  const [notesPage, setNotesPage] = useState(1);
  const [load, reload] = useLatest<OrderView>(signal => siteOrders.get(id, itemsPage, notesPage, { signal }), [id, itemsPage, notesPage]);
  return <Solid as="section" className="pad" aria-labelledby="site-order-detail">
    <SectionHeader id="site-order-detail" title={`سفارش #${id}`} actions={<Button variant="quiet" onClick={onClose}>بستن</Button>} />
    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={3} label="در حال خواندن سفارش…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="سفارش خوانده نشد" reference={load.reference} description={load.message}
            actionLabel="تلاش دوباره" onAction={reload} />
        : load.data.state === "not_found"
          ? <ResultState kind="empty" title="این سفارش در سایت پیدا نشد" description="ممکن است حذف شده یا شناسه اشتباه باشد." />
          : load.data.state === "unavailable"
            ? <Unavailable title="سفارش از سایت خوانده نشد" message={load.data.message} code={load.data.code} onRetry={reload} />
            : <OrderDetailView order={load.data.order} onItemsPage={setItemsPage} onNotesPage={setNotesPage} />}
  </Solid>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
const orDash = (v: string) => v || <span className="muted">—</span>;

function AddressBlock({ title, a, email }: { title: string; a: Address; email?: string }) {
  const lines = addressLines(a);
  return <section aria-label={title}>
    <h3 className="site-order-h">{title}</h3>
    {lines.length === 0 && !a.phone && !email ? <p className="muted">ثبت نشده</p> : <address className="site-order-address">
      {lines.map((l, i) => <span key={i}>{l}</span>)}
      {a.phone ? <span>تلفن: <Ltr>{a.phone}</Ltr></span> : null}
      {email ? <span>ایمیل: <Ltr>{email}</Ltr></span> : null}
    </address>}
  </section>;
}

function OrderDetailView({ order, onItemsPage, onNotesPage }: {
  order: OrderDetail; onItemsPage: (p: number) => void; onNotesPage: (p: number) => void;
}) {
  const core = coreState(order.core);
  const c = order.currency;
  const itemPages = Math.max(1, Math.ceil(order.items.total / order.items.perPage));
  const itemColumns: Column<OrderItem>[] = [
    { key: "name", header: "کالا", cell: r => <>{r.name}{r.attributes.length > 0
      ? <span className="muted small site-order-attrs">{r.attributes.map(a => `${a.key}: ${a.value}`).join("، ")}</span> : null}</> },
    { key: "sku", header: "SKU", cell: r => r.sku ? <Ltr>{r.sku}</Ltr> : <span className="muted">—</span> },
    { key: "map", header: "اتصال به Core", cell: r => !r.productExists
      ? <StatusBadge state="unknown" label="کالا در سایت حذف شده" quiet />
      : r.mapped ? <StatusBadge state="completed" label="متصل" quiet /> : <StatusBadge state="warning" label="بی اتصال" quiet /> },
    { key: "qty", header: "تعداد", numeric: true, cell: r => <span className="num">{formatCount(r.quantity)}</span> },
    { key: "subtotal", header: "پیش از تخفیف", numeric: true, cell: r => <Amount m={r.subtotal} currency={c} /> },
    { key: "discount", header: "تخفیف", numeric: true, cell: r => <Amount m={r.discount} currency={c} /> },
    { key: "tax", header: "مالیات", numeric: true, cell: r => <Amount m={r.tax} currency={c} /> },
    { key: "total", header: "جمع", numeric: true, cell: r => <Amount m={r.total} currency={c} /> },
  ];
  return <div className="stack">
    <dl className="site-order-facts">
      <Fact label="وضعیت سایت"><StatusBadge state={orderStatusState(order.status)} label={order.statusLabel || order.status} /></Fact>
      <Fact label="ثبت در Core"><StatusBadge state={core.state} label={core.label} /></Fact>
      <Fact label="تاریخ">{order.createdAt ? formatJalaliMoment(order.createdAt) : "—"}</Fact>
      <Fact label="مشتری">{order.customerName || "بی‌نام"} {order.customerType === "guest" ? "(مهمان)" : "(عضو سایت)"}</Fact>
      <Fact label="ارز سفارش"><Ltr>{c || "نامعلوم"}</Ltr></Fact>
      <Fact label="روش پرداخت">{orDash(order.payment.method)}</Fact>
      <Fact label="شناسهٔ تراکنش">{order.payment.transactionId ? <Ltr>{order.payment.transactionId}</Ltr> : <span className="muted">—</span>}</Fact>
      <Fact label="زمان پرداخت">{order.payment.paidAt ? formatJalaliMoment(order.payment.paidAt) : <span className="muted">پرداخت ثبت نشده</span>}</Fact>
      <Fact label="زمان تکمیل">{order.completedAt ? formatJalaliMoment(order.completedAt) : <span className="muted">تکمیل نشده</span>}</Fact>
      <Fact label="آخرین تغییر">{order.modifiedAt ? formatJalaliMoment(order.modifiedAt) : <span className="muted">—</span>}</Fact>
    </dl>
    <div className="site-order-columns">
      <AddressBlock title="نشانی صورت‌حساب" a={order.billing} email={order.billing.email} />
      <AddressBlock title="نشانی ارسال" a={order.shipping} />
    </div>
    {order.customerNote ? <p role="note"><strong>یادداشت مشتری: </strong>{order.customerNote}</p> : null}

    <DataTable caption={`اقلام سفارش #${order.number}`} columns={itemColumns} rows={order.items.rows} rowKey={r => String(r.id)}
      density="compact" stack empty={{ title: "این صفحه قلم کالایی ندارد." }} />
    {itemPages > 1 ? <nav className="site-orders-pager" aria-label="صفحه‌های اقلام">
      <Button disabled={order.items.page <= 1} onClick={() => onItemsPage(order.items.page - 1)}>اقلام قبلی</Button>
      <span className="num">اقلام {formatCount(order.items.page)} از {formatCount(itemPages)} ({formatCount(order.items.total)} قلم)</span>
      <Button disabled={order.items.page >= itemPages} onClick={() => onItemsPage(order.items.page + 1)}>اقلام بعدی</Button>
    </nav> : null}

    <dl className="site-order-facts" aria-label="جمع‌های سفارش">
      <Fact label="جمع اقلام"><Amount m={order.totals.subtotal} currency={c} /></Fact>
      <Fact label="تخفیف"><Amount m={order.totals.discount} currency={c} /></Fact>
      <Fact label="ارسال"><Amount m={order.totals.shipping} currency={c} /></Fact>
      <Fact label="مالیات"><Amount m={order.totals.tax} currency={c} /></Fact>
      <Fact label="جمع سفارش"><Amount m={order.totals.total} currency={c} /></Fact>
      <Fact label="مستردشده"><Amount m={order.totals.refunded} currency={c} /></Fact>
    </dl>

    {order.shippingLines.length > 0 ? <List title="روش ارسال" rows={order.shippingLines.map((s, i) => ({ key: String(i), label: s.method,
      value: <><Amount m={s.total} currency={c} /> <span className="muted small">مالیات: </span><Amount m={s.tax} currency={c} /></> }))} /> : null}
    {order.fees.length > 0 ? <List title="هزینه‌های اضافه" rows={order.fees.map((f, i) => ({ key: String(i), label: f.name,
      value: <><Amount m={f.total} currency={c} /> <span className="muted small">مالیات: </span><Amount m={f.tax} currency={c} /></> }))} /> : null}
    {order.tracking.length > 0 ? <List title="رهگیری ارسال" rows={order.tracking.map((t, i) => ({ key: String(i),
      label: <>{t.provider || "ارسال"}{t.shippedAt ? ` · ${formatJalaliMoment(t.shippedAt)}` : ""}</>,
      value: t.url ? <a href={t.url} target="_blank" rel="noopener noreferrer"><Ltr>{t.number}</Ltr></a> : <Ltr>{t.number}</Ltr> }))} /> : null}
    {order.coupons.length > 0 ? <List title="کوپن‌ها" rows={order.coupons.map(x => ({ key: x.code, label: <Ltr>{x.code}</Ltr>,
      value: <Amount m={x.discount} currency={c} /> }))} /> : null}
    {order.refunds.length > 0 ? <List title="استردادها" rows={order.refunds.map(r => ({ key: String(r.id),
      label: <>{r.createdAt ? formatJalaliMoment(r.createdAt) : "—"}{r.reason ? ` — ${r.reason}` : ""}</>, value: <Amount m={r.amount} currency={c} /> }))} /> : null}
    {order.refundsTruncated ? <p className="muted small" role="note">فقط ۵۰ استرداد تازه‌تر نشان داده شده است؛ جمع «مستردشده» همهٔ آن‌ها را دارد.</p> : null}

    <section aria-label="ثبت در Core">
      <h3 className="site-order-h">ثبت در Core</h3>
      <dl className="site-order-facts">
        <Fact label="پرداخت تأییدشده">{order.core.paymentConfirmed ? "بله" : "خیر"}</Fact>
        <Fact label="در صف ارسال">{order.core.scheduled ? "بله" : "خیر"}</Fact>
        <Fact label="تلاش‌ها"><span className="num">{formatCount(order.core.attempts)}</span></Fact>
        <Fact label="قلم بی SKU"><span className="num">{formatCount(order.core.missingSku)}</span></Fact>
        <Fact label="قلم بی اتصال"><span className="num">{formatCount(order.core.missingMapping)}</span></Fact>
      </dl>
    </section>

    <section aria-label="یادداشت‌های سفارش">
      <h3 className="site-order-h">یادداشت‌ها</h3>
      {order.notes.rows.length === 0 ? <p className="muted">{order.notes.page > 1 ? "یادداشت دیگری نیست." : "یادداشتی ثبت نشده."}</p>
        : <ol className="site-order-notes">{order.notes.rows.map(n => <li key={n.id}>
            <span className="muted small">{n.createdAt ? formatJalaliMoment(n.createdAt) : "—"} · {n.addedBy || "سیستم"}{n.customerNote ? " · برای مشتری" : ""}</span>
            <span>{n.content}</span>
          </li>)}</ol>}
      {order.notes.page > 1 || order.notes.hasMore ? <nav className="site-orders-pager" aria-label="صفحه‌های یادداشت">
        <Button disabled={order.notes.page <= 1} onClick={() => onNotesPage(order.notes.page - 1)}>یادداشت‌های تازه‌تر</Button>
        <Button disabled={!order.notes.hasMore} onClick={() => onNotesPage(order.notes.page + 1)}>یادداشت‌های قدیمی‌تر</Button>
      </nav> : null}
    </section>
  </div>;
}

function List({ title, rows }: { title: string; rows: { key: string; label: ReactNode; value: ReactNode }[] }) {
  return <section aria-label={title}>
    <h3 className="site-order-h">{title}</h3>
    <dl className="site-order-facts">{rows.map(r => <div key={r.key}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
  </section>;
}
