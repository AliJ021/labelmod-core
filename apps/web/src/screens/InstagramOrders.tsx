/**
 * «سفارش اینستاگرام» — ورود دستی سفارش دایرکت، رزرو، تطبیق واریز کارت‌به‌کارت و ارسال.
 * قرارداد: docs/INSTAGRAM-ORDERS.md و lib/instagram-orders.ts.
 *
 * - **پیش‌نویس اثر ندارد.** موجودی فقط با «رزرو» نگه داشته می‌شود و فقط با «تأیید واریز» از انبار کم
 *   می‌شود؛ صفحه همین را صریح می‌گوید تا اپراتور «ارسال‌شده» را با «کسر موجودی» یکی نگیرد.
 * - **سه محور جدا:** وضعیت سفارش، وضعیت واریز و وضعیت ارسال هر کدام نشان خودشان را دارند.
 * - **تأیید واریز** نسخهٔ دیده‌شدهٔ سفارش را می‌فرستد و کلید یکتایش برای همان بدنه ثابت است: پاسخ
 *   گم‌شده با «دوباره» همان عملیات را حل می‌کند، نه دریافت دوم. عکس رسید مدرک پرداخت نیست؛ فقط
 *   تطبیق با صورت‌حساب بانک.
 * - **جست‌وجو** (موبایل، نام کاربری) نه در نشانی صفحه است و نه در نشانی درخواست.
 * - سفارش انتخاب‌شده و فیلتر وضعیت در نشانی صفحه‌اند (`useUrlState`)؛ داده منبعش سرور است.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { navigate, useUrlState } from "../lib/use-url-state.ts";
import { pos, type Branch } from "../lib/pos.ts";
import {
  actionsFor, checkConfirm, instagramOrders, nextShipping, normalizeUsername, parseQty, ORDER_STATUS, PAYMENT_STATE, rialFromToman, statusView,
  SHIPPING_STATE, syncView, type OrderDetail, type OrderLine, type OrderStatus, type OrderSummary, type OrdersPage,
  type ReceivingAccount,
} from "../lib/instagram-orders.ts";
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
import { PosProductPicker } from "../components/PosProductPicker.tsx";

type Load<T> = { state: "loading" } | { state: "done"; data: T } | { state: "error"; message: string; reference: string | null };

function useLatest<T>(read: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): [Load<T>, () => void, (d: T) => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const gen = useRef(0);
  const soft = useRef(false);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(read, deps);
  useEffect(() => {
    const controller = new AbortController();
    const mine = ++gen.current;
    // «به‌روزرسانی» همان موضوع، نمای موجود را برنمی‌دارد: فرم نیمه‌پر و کلید Idempotency عمل
    // در جریان (مثلاً تأیید واریزی که پاسخش گم شد) باید برای تلاش دوباره بمانند.
    const keep = soft.current;
    soft.current = false;
    if (!keep) setLoad({ state: "loading" });
    run(controller.signal).then(
      data => { if (gen.current === mine) setLoad({ state: "done", data }); },
      (err: unknown) => {
        if (gen.current !== mine || controller.signal.aborted) return;
        const failed: Load<T> = err instanceof ApiError
          ? { state: "error", message: err.message, reference: err.correlationId }
          : { state: "error", message: "ارتباط با سرور برقرار نشد.", reference: null };
        setLoad(prev => keep && prev.state === "done" ? prev : failed);
      });
    return () => { controller.abort(); };
  }, [run, tick]);
  // پاسخ عملیات خودش جزئیات تازه است؛ بی خواندن دوباره جایگزین می‌شود و خواندنِ در راه بی‌اثر.
  const replace = useCallback((d: T) => { gen.current++; setLoad({ state: "done", data: d }); }, []);
  const reload = useCallback(() => { soft.current = true; setTick(t => t + 1); }, []);
  return [load, reload, replace];
}

const P = { status: "ig.status", attention: "ig.attention", order: "ig.order", create: "ig.new", page: "ig.page" } as const;
const STATUSES = Object.keys(ORDER_STATUS) as OrderStatus[];
const UUID = /^[0-9a-f-]{36}$/;

function setParams(next: Partial<Record<keyof typeof P, string>>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(next) as [keyof typeof P, string][]) {
    if (v === "") url.searchParams.delete(P[k]); else url.searchParams.set(P[k], v);
  }
  navigate(url.href);
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "ارتباط با سرور برقرار نشد؛ نتیجه را با «به‌روزرسانی» ببینید.";
}

export function InstagramOrders() {
  const [statusParam] = useUrlState(P.status);
  const [attentionParam] = useUrlState(P.attention);
  const [orderParam] = useUrlState(P.order);
  const [createParam] = useUrlState(P.create);
  const [pageParam] = useUrlState(P.page);
  const status = STATUSES.includes(statusParam as OrderStatus) ? statusParam as OrderStatus : null;
  const attention = attentionParam === "1";
  const orderId = UUID.test(orderParam) ? orderParam : null;
  const page = /^[1-9]\d{0,3}$/.test(pageParam) ? Number(pageParam) : 1;

  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState<string | null>(null);
  const [list, reload] = useLatest<OrdersPage>(signal => search
    ? instagramOrders.search(search, { signal })
    : instagramOrders.list({ status, attention, page }, { signal }), [status, attention, page, search]);

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    const v = searchDraft.trim();
    setSearch(v.length >= 2 ? v : null);
  }
  const filtered = !!(status || attention || search);

  return <div className="stack">
    <PageHeader title="سفارش اینستاگرام"
      context="سفارش دایرکت را ثبت، موجودی را رزرو و پس از تطبیق واریز کامل کارت‌به‌کارت نهایی کنید. پیش از تأیید واریز چیزی ارسال نمی‌شود."
      actions={<>
        <Button onClick={reload} disabled={list.state === "loading"}>به‌روزرسانی</Button>
        <Button variant="primary" onClick={() => setParams({ create: "1", order: "" })}>سفارش تازه</Button>
      </>} />
    <FilterBar label="فیلتر سفارش‌ها" onReset={filtered ? () => { setSearch(null); setSearchDraft(""); setParams({ status: "", attention: "", page: "" }); } : undefined}>
      <form className="site-orders-search" role="search" aria-label="جست‌وجوی سفارش اینستاگرام" onSubmit={submitSearch}>
        <Field label="جست‌وجو" hint="شمارهٔ سفارش، موبایل، نام کاربری یا نام مشتری؛ در نشانی صفحه نگه داشته نمی‌شود.">
          <input type="search" maxLength={64} autoComplete="off" value={searchDraft} onChange={e => setSearchDraft(e.target.value)} />
        </Field>
        <Button type="submit">جست‌وجو</Button>
      </form>
      <Field label="وضعیت سفارش">
        <select value={status ?? ""} onChange={e => { setSearch(null); setParams({ status: e.target.value, page: "", attention: "" }); }}>
          <option value="">همه</option>
          {STATUSES.filter(s => s !== "confirming").map(s => <option key={s} value={s}>{ORDER_STATUS[s].label}</option>)}
        </select>
      </Field>
      <Field label="نمایش" hint="رسیدگی: واریز ادعاشده یا مشکوک، یا رزرو سررسیده.">
        <select value={attention ? "1" : ""} onChange={e => { setSearch(null); setParams({ attention: e.target.value, status: "", page: "" }); }}>
          <option value="">همهٔ سفارش‌ها</option>
          <option value="1">فقط نیازمند رسیدگی</option>
        </select>
      </Field>
    </FilterBar>
    {createParam === "1" ? <CreateOrder onCancel={() => setParams({ create: "" })}
      onCreated={id => { setParams({ create: "", order: id }); reload(); }} /> : null}
    <OrdersList load={list} page={page} selected={orderId} searching={search !== null}
      onSelect={id => setParams({ order: id ?? "", create: "" })} onPage={p => setParams({ page: p === 1 ? "" : String(p) })} onRetry={reload} />
    {orderId ? <OrderPanel key={orderId} id={orderId} onClose={() => setParams({ order: "" })} onChanged={reload} /> : null}
  </div>;
}

function OrdersList({ load, page, selected, searching, onSelect, onPage, onRetry }: {
  load: Load<OrdersPage>; page: number; selected: string | null; searching: boolean;
  onSelect: (id: string | null) => void; onPage: (p: number) => void; onRetry: () => void;
}) {
  const columns: Column<OrderSummary>[] = [
    { key: "no", header: "سفارش", cell: r => <Ltr>{r.orderNo}</Ltr> },
    { key: "date", header: "ثبت", cell: r => <span className="nowrap">{formatJalaliMoment(r.createdAt)}</span> },
    { key: "customer", header: "مشتری", cell: r => <>{r.customerName || <span className="muted">بی‌نام</span>}
      {r.instagramUsername ? <span className="muted small"> · <Ltr>@{r.instagramUsername}</Ltr></span> : null}</> },
    { key: "status", header: "سفارش", cell: r => <StatusBadge {...statusView(ORDER_STATUS, r.status)} /> },
    { key: "payment", header: "واریز", cell: r => <StatusBadge {...statusView(PAYMENT_STATE, r.paymentState)} quiet /> },
    { key: "ship", header: "ارسال", cell: r => SHIPPING_STATE[r.shippingState] },
    { key: "deadline", header: "مهلت رزرو", cell: r => r.reservedUntil ? <span className="nowrap">{formatJalaliMoment(r.reservedUntil)}</span> : <span className="muted">—</span> },
    { key: "payable", header: "مبلغ کامل", numeric: true, cell: r => <Money rial={r.payable} exact size="sm" /> },
  ];
  return <Solid as="section" className="pad" aria-labelledby="ig-list">
    <SectionHeader id="ig-list" title={searching ? "نتیجهٔ جست‌وجو" : "فهرست سفارش‌ها"}
      description={load.state === "done" ? `${formatCount(load.data.total)} سفارش؛ تازه‌ترین اول` : "تازه‌ترین اول"} />
    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={4} label="در حال خواندن سفارش‌ها…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="سفارش‌ها خوانده نشد" reference={load.reference}
            description={`${load.message} این به معنای «سفارشی نیست» نیست.`} actionLabel="تلاش دوباره" onAction={onRetry} />
        : <>
            <DataTable caption="سفارش‌های اینستاگرام" columns={columns} rows={load.data.orders} rowKey={r => r.id} stack
              rowActions={r => <Button variant="quiet" aria-pressed={r.id === selected} aria-label={`جزئیات ${r.orderNo}`}
                onClick={() => onSelect(r.id === selected ? null : r.id)}>جزئیات</Button>}
              empty={{ title: "سفارشی نیست.", description: searching ? "عبارت دیگری را جست‌وجو کنید." : "با «سفارش تازه» اولین سفارش دایرکت را ثبت کنید." }} />
            {load.data.pages > 1 ? <nav className="site-orders-pager" aria-label="صفحه‌های سفارش">
              <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>صفحهٔ قبل</Button>
              <span className="num">صفحهٔ {formatCount(page)} از {formatCount(load.data.pages)}</span>
              <Button disabled={page >= load.data.pages} onClick={() => onPage(page + 1)}>صفحهٔ بعد</Button>
            </nav> : null}
          </>}
  </Solid>;
}

function CreateOrder({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [accounts, setAccounts] = useState<ReceivingAccount[]>([]);
  const [form, setForm] = useState({ mobile: "", name: "", username: "", address: "", method: "", shipping: "", account: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new ActionKeys());

  useEffect(() => {
    pos.branches().then(r => {
      setBranches(r.branches);
      const b = r.branches[0];
      if (b) { setBranchId(b.id); setWarehouseId(b.warehouses.find(w => w.kind === "store")?.id ?? b.warehouses[0]?.id ?? ""); }
    }, err => setError(errorText(err)));
  }, []);
  useEffect(() => {
    if (!branchId) return;
    instagramOrders.accounts(branchId).then(r => setAccounts(r.accounts), () => setAccounts([]));
  }, [branchId]);
  const branch = branches?.find(b => b.id === branchId);
  const user = normalizeUsername(form.username);
  const shipping = form.shipping.trim() === "" ? "0" : rialFromToman(form.shipping);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user.ok) { setError(user.message); return; }
    if (shipping === null) { setError("کرایه را به تومان و فقط با رقم وارد کنید."); return; }
    const body = {
      branchId, warehouseId, customerMobile: form.mobile.trim(), customerName: form.name.trim() || undefined,
      instagramUsername: user.value, shipAddress: form.address.trim(), shipMethod: form.method.trim(),
      shippingAmount: shipping, receivingAccountId: form.account || null,
    };
    setBusy(true); setError(null);
    try {
      const d = await instagramOrders.create(body, keys.current.keyFor(actionFor("ig-create", body)));
      keys.current.clear(actionFor("ig-create", body));
      onCreated(d.id);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));

  return <Solid as="section" className="pad" aria-labelledby="ig-create">
    <SectionHeader id="ig-create" title="سفارش تازهٔ اینستاگرام" description="فقط پیش‌نویس ساخته می‌شود؛ تا «رزرو» هیچ موجودی‌ای نگه داشته نمی‌شود."
      actions={<Button variant="quiet" onClick={onCancel}>انصراف</Button>} />
    {branches === null && !error ? <Skeleton variant="text" lines={2} label="در حال خواندن شعبه‌ها…" /> : null}
    <form className="stack" onSubmit={submit} aria-label="سفارش تازه">
      <Field label="شعبه">
        <select value={branchId} onChange={e => { setBranchId(e.target.value); setWarehouseId(branches?.find(b => b.id === e.target.value)?.warehouses[0]?.id ?? ""); }}>
          {(branches ?? []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="انبار ارسال">
        <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
          {(branch?.warehouses ?? []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </Field>
      <Field label="موبایل مشتری" hint="هویت سفارش نیست؛ مشتری می‌تواند چند خرید باز داشته باشد.">
        <input type="tel" inputMode="tel" dir="auto" autoComplete="off" required value={form.mobile} onChange={set("mobile")} />
      </Field>
      <Field label="نام مشتری" optional><input type="text" autoComplete="off" maxLength={120} value={form.name} onChange={set("name")} /></Field>
      <Field label="نام کاربری اینستاگرام" optional error={user.ok ? null : user.message}>
        <input type="text" dir="auto" autoComplete="off" maxLength={40} placeholder="@username" value={form.username} onChange={set("username")} />
      </Field>
      <Field label="نشانی ارسال"><textarea rows={2} maxLength={500} value={form.address} onChange={set("address")} /></Field>
      <Field label="روش ارسال" optional><input type="text" maxLength={80} placeholder="پست پیشتاز، پیک…" value={form.method} onChange={set("method")} /></Field>
      <Field label="کرایهٔ دریافتی (تومان)" optional hint="بخشی از مبلغ کاملی که مشتری واریز می‌کند.">
        <input type="text" inputMode="numeric" className="num" autoComplete="off" value={form.shipping} onChange={set("shipping")} />
      </Field>
      <Field label="حساب مقصد واریز" optional hint="فقط حساب‌های بانکی مجاز همین شعبه.">
        <select value={form.account} onChange={set("account")}>
          <option value="">بعداً انتخاب می‌شود</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.bankName ? ` — ${a.bankName}` : ""}</option>)}
        </select>
      </Field>
      {error ? <p role="alert" className="field-error">{error}</p> : null}
      <div className="row"><Button type="submit" variant="primary" busy={busy} busyLabel="در حال ثبت…" disabled={!branchId || !warehouseId}>ثبت پیش‌نویس</Button></div>
    </form>
  </Solid>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function OrderPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [load, reload, replace] = useLatest<OrderDetail>(signal => instagramOrders.get(id, { signal }), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(name: string, run: () => Promise<OrderDetail>) {
    setBusy(name); setError(null);
    try { replace(await run()); onChanged(); }
    catch (err) { setError(errorText(err)); reload(); }
    finally { setBusy(null); }
  }

  return <Solid as="section" className="pad" aria-labelledby="ig-detail">
    <SectionHeader id="ig-detail" title={load.state === "done" ? `سفارش ${load.data.orderNo}` : "سفارش"}
      actions={<><Button variant="quiet" onClick={reload}>به‌روزرسانی</Button><Button variant="quiet" onClick={onClose}>بستن</Button></>} />
    {error ? <p role="alert" className="field-error">{error}</p> : null}
    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={4} label="در حال خواندن سفارش…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="سفارش خوانده نشد" reference={load.reference} description={load.message} actionLabel="تلاش دوباره" onAction={reload} />
        : <OrderView d={load.data} busy={busy} act={act} />}
  </Solid>;
}

function OrderView({ d, busy, act }: { d: OrderDetail; busy: string | null; act: (name: string, run: () => Promise<OrderDetail>) => Promise<void> }) {
  const a = actionsFor(d);
  const [qty, setQty] = useState("1");
  const [cancelReason, setCancelReason] = useState("");
  const [note, setNote] = useState(d.paymentNote ?? "");
  const [tracking, setTracking] = useState(d.trackingCode ?? "");
  const lineColumns: Column<OrderLine>[] = [
    { key: "item", header: "کالا", cell: r => <>{r.product} <span className="muted small">{[r.color, r.size].filter(Boolean).join(" · ")}</span></> },
    { key: "sku", header: "SKU", cell: r => <Ltr>{r.sku}</Ltr> },
    { key: "qty", header: "تعداد", numeric: true, cell: r => a.editCart
      ? <input type="text" inputMode="numeric" className="num" autoComplete="off" aria-label={`تعداد ${r.product}`} defaultValue={r.qty}
          onBlur={e => { const n = parseQty(e.target.value); if (n !== null && n !== r.qty) void act("qty", () => instagramOrders.setQty(d.id, r.id, n)); }} />
      : <span className="num">{formatCount(r.qty)}</span> },
    { key: "price", header: "فی", numeric: true, cell: r => <Money rial={r.unitPrice} exact size="sm" /> },
    { key: "discount", header: "تخفیف", numeric: true, cell: r => <Money rial={r.discountAmount} exact size="sm" /> },
    { key: "net", header: "جمع", numeric: true, cell: r => <Money rial={r.netAmount} exact size="sm" /> },
    { key: "avail", header: "قابل‌فروش اکنون", numeric: true, cell: r => <span className="num">{r.available}</span> },
    { key: "sync", header: "سایت", cell: r => { const s = syncView(r.sync); return <span title={r.sync.error ?? undefined}>
      <StatusBadge state={s.state} label={s.label} quiet />{r.sync.at ? <span className="muted small"> {formatJalaliMoment(r.sync.at)}</span> : null}</span>; } },
  ];
  return <div className="stack">
    <dl className="site-order-facts">
      <Fact label="سفارش"><StatusBadge {...statusView(ORDER_STATUS, d.status)} /></Fact>
      <Fact label="واریز"><StatusBadge {...statusView(PAYMENT_STATE, d.paymentState)} /></Fact>
      <Fact label="ارسال">{SHIPPING_STATE[d.shippingState] ?? d.shippingState}{d.trackingCode ? <> · <Ltr>{d.trackingCode}</Ltr></> : null}</Fact>
      <Fact label="مهلت رزرو">{d.reservedUntil ? formatJalaliMoment(d.reservedUntil) : <span className="muted">—</span>}</Fact>
      <Fact label="مشتری">{d.customer.name || "بی‌نام"} · <Ltr>{d.customer.mobile ?? "—"}</Ltr>{d.customer.instagramUsername ? <> · <Ltr>@{d.customer.instagramUsername}</Ltr></> : null}</Fact>
      <Fact label="شعبه و انبار">{d.branch.name} · {d.warehouse.name}</Fact>
      <Fact label="نشانی ارسال">{d.shipping.address || <span className="muted">—</span>}</Fact>
      <Fact label="روش ارسال">{d.shipping.method || <span className="muted">—</span>}</Fact>
      <Fact label="فاکتور">{d.invoice.number ? <Ltr>{d.invoice.number}</Ltr> : <span className="muted">پیش‌نویس (بی‌شماره)</span>}</Fact>
    </dl>
    {d.similarOpen.length > 0 ? <p role="note">
      <StatusBadge state="warning" label="سفارش باز مشابه" quiet />{" "}
      این مشتری سفارش باز دیگری هم دارد: {d.similarOpen.map(s => s.orderNo).join("، ")}. اگر همان سفارش است، دوباره ثبت نکنید؛ خرید تازهٔ واقعی منعی ندارد.
    </p> : null}
    {d.status === "cancelled" && d.cancelReason ? <p role="note">دلیل لغو: {d.cancelReason}</p> : null}

    <DataTable caption={`اقلام ${d.orderNo}`} columns={lineColumns} rows={d.lines} rowKey={r => r.id} density="compact" stack
      {...(a.editCart ? { rowActions: (r: OrderLine) => <Button variant="quiet" aria-label={`حذف ${r.product}`} disabled={busy !== null}
        onClick={() => void act("remove", () => instagramOrders.removeLine(d.id, r.id))}>حذف</Button> } : {})}
      empty={a.editCart ? { title: "هنوز قلمی ندارد.", description: "کالا را از جست‌وجوی پایین اضافه کنید." } : { title: "قلمی ندارد." }} />
    {a.editCart ? <section aria-label="افزودن کالا" className="stack">
      <Field label="تعداد قلم تازه" error={parseQty(qty) === null ? "تعداد باید عدد صحیح ۱ تا ۹۹۹ باشد." : null}>
        <input type="text" inputMode="numeric" className="num" autoComplete="off" value={qty} onChange={e => setQty(e.target.value)} />
      </Field>
      <PosProductPicker warehouseId={d.warehouse.id} busy={busy !== null} onPick={async variationId => {
        const n = parseQty(qty);
        if (n === null) return;
        await act("add", () => instagramOrders.addLine(d.id, { variationId, qty: n }));
      }} />
    </section> : null}

    <dl className="site-order-facts" aria-label="مبالغ سفارش">
      <Fact label="جمع اقلام"><Money rial={d.invoice.gross} exact size="sm" /></Fact>
      <Fact label="تخفیف"><Money rial={d.invoice.discount} exact size="sm" /></Fact>
      <Fact label="کرایه"><Money rial={d.invoice.shipping} exact size="sm" /></Fact>
      <Fact label="مبلغ کامل قابل واریز"><Money rial={d.invoice.payable} exact /></Fact>
    </dl>

    <div className="row" role="group" aria-label="کارهای سفارش">
      {a.reserve ? <Button variant="primary" busy={busy === "reserve"} disabled={busy !== null}
        onClick={() => void act("reserve", () => instagramOrders.reserve(d.id))}>{d.status === "expired" ? "رزرو دوباره" : "رزرو موجودی"}</Button> : null}
      {a.unreserve ? <Button disabled={busy !== null} onClick={() => void act("unreserve", () => instagramOrders.unreserve(d.id))}>برگشت به پیش‌نویس (ویرایش سبد)</Button> : null}
    </div>
    {d.status === "reserved" || d.status === "expired" ? <p className="muted small" role="note">
      موجودی رزرو شده فقط از «قابل‌فروش» کم شده؛ کالا تنها با تأیید واریز از انبار خارج و فروش ثبت می‌شود. رزرو منقضی، موجودی را آزاد کرده است و رزرو دوباره آن را از نو می‌سنجد.
    </p> : null}

    {a.markPayment ? <section aria-label="وضعیت واریز پیش از تأیید" className="stack">
      <h3 className="site-order-h">وضعیت واریز پیش از تأیید</h3>
      <p className="muted small">عکس رسید یا گفتهٔ مشتری پرداخت نیست. علامت «ادعاشده» یا «نیازمند رسیدگی» فقط جلوی آزادشدن خودکار رزرو را می‌گیرد.</p>
      <Field label="توضیح"><input type="text" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <div className="row">
        <Button disabled={busy !== null || d.paymentState === "claimed"} onClick={() => void act("claim", () => instagramOrders.markPayment(d.id, "claimed", note))}>مشتری می‌گوید واریز کرده</Button>
        <Button disabled={busy !== null || d.paymentState === "review"} onClick={() => void act("review", () => instagramOrders.markPayment(d.id, "review", note))}>نیازمند رسیدگی</Button>
        <Button variant="quiet" disabled={busy !== null || d.paymentState === "none"} onClick={() => void act("none", () => instagramOrders.markPayment(d.id, "none", null))}>پاک‌کردن علامت</Button>
      </div>
    </section> : null}

    {a.confirm ? <ConfirmPayment d={d} busy={busy} act={act} /> : null}

    {d.payment ? <section aria-label="واریز تطبیق‌شده">
      <h3 className="site-order-h">واریز تطبیق‌شده</h3>
      <dl className="site-order-facts">
        <Fact label="مبلغ"><Money rial={d.payment.amount} exact size="sm" /></Fact>
        <Fact label="حساب مقصد">{d.payment.accountName}</Fact>
        <Fact label="شمارهٔ پیگیری"><Ltr>{d.payment.refNo}</Ltr></Fact>
        <Fact label="زمان واریز">{formatJalaliMoment(d.payment.paidAt)}</Fact>
        <Fact label="تأییدکننده">{d.payment.verifiedBy ?? "—"} · {formatJalaliMoment(d.payment.verifiedAt)}</Fact>
      </dl>
    </section> : null}

    {a.ship ? <section aria-label="ارسال" className="stack">
      <h3 className="site-order-h">ارسال</h3>
      <p className="muted small">کالا هنگام تأیید واریز از موجودی کسر شد؛ تغییر وضعیت ارسال هیچ کسر دیگری نمی‌سازد.</p>
      <Field label="کد رهگیری" optional><input type="text" dir="auto" maxLength={80} value={tracking} onChange={e => setTracking(e.target.value)} /></Field>
      {(() => { const next = nextShipping(d.shippingState); return next ? <Button variant="primary" disabled={busy !== null}
        onClick={() => void act("ship", () => instagramOrders.shipping(d.id, next, tracking.trim() || null))}>{SHIPPING_STATE[next]}</Button> : null; })()}
    </section> : null}

    {d.status === "finalized" ? <section aria-label="مرجوعی">
      <h3 className="site-order-h">مرجوعی و بازپرداخت</h3>
      <p className="muted small">پس از نهایی‌سازی، برگشت کالا یا پول فقط از بخش «مرجوعی» با شمارهٔ فاکتور {d.invoice.number ? <Ltr>{d.invoice.number}</Ltr> : "—"} ثبت می‌شود. بازپرداخت پول به‌تنهایی برگشت کالا نیست.</p>
      {d.returns.length > 0 ? <ul>{d.returns.map(r => <li key={r.id}><Ltr>{r.number ?? "—"}</Ltr> · {r.status} · <Money rial={r.refundAmount} exact size="sm" /></li>)}</ul> : null}
    </section> : null}

    {a.cancel ? <section aria-label="لغو سفارش" className="stack">
      <Field label="دلیل لغو"><input type="text" maxLength={300} value={cancelReason} onChange={e => setCancelReason(e.target.value)} /></Field>
      <Button variant="danger" disabled={busy !== null || cancelReason.trim() === ""}
        onClick={() => void act("cancel", () => instagramOrders.cancel(d.id, cancelReason.trim()))}>لغو سفارش و آزادسازی رزرو</Button>
    </section> : null}
  </div>;
}

function ConfirmPayment({ d, busy, act }: { d: OrderDetail; busy: string | null; act: (name: string, run: () => Promise<OrderDetail>) => Promise<void> }) {
  const [accounts, setAccounts] = useState<ReceivingAccount[] | null>(null);
  const [accountId, setAccountId] = useState(d.receivingAccount?.id ?? "");
  const [amount, setAmount] = useState("");
  const [refNo, setRefNo] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [issue, setIssue] = useState<{ field: string; message: string } | null>(null);
  const keys = useMemo(() => new ActionKeys(), []);
  useEffect(() => { instagramOrders.accounts(d.branch.id).then(r => setAccounts(r.accounts), () => setAccounts([])); }, [d.branch.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const when = paidAt ? new Date(paidAt) : null;
    const amountRial = rialFromToman(amount);
    const c = checkConfirm({ payable: d.invoice.payable, amountRial, refNo, accountId, paidAt: when, now: new Date() });
    if (!c.ok) { setIssue({ field: c.field, message: c.message }); return; }
    setIssue(null);
    const body = { version: d.version, accountId, amount: amountRial!, refNo: refNo.trim(), paidAt: when!.toISOString() };
    // همان بدنه، همان کلید: «دوباره» پس از پاسخ گم‌شده همان عملیات را حل می‌کند.
    await act("confirm", () => instagramOrders.confirm(d.id, body, keys.keyFor(actionFor(`ig-confirm:${d.id}`, body))));
  }

  return <section aria-label="تأیید واریز" className="stack">
    <h3 className="site-order-h">تأیید واریز کارت‌به‌کارت</h3>
    <p className="muted small">پس از دیدن واریز در صورت‌حساب بانک: مبلغ دقیق، حساب مقصد، شمارهٔ پیگیری و زمان واریز را ثبت کنید. با تأیید، فروش نهایی و کالا از انبار کسر می‌شود.</p>
    <form className="stack" onSubmit={submit} aria-label="فرم تأیید واریز">
      <Field label="حساب مقصد" error={issue?.field === "account" ? issue.message : null}>
        <select value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">انتخاب کنید</option>
          {(accounts ?? []).map(a => <option key={a.id} value={a.id}>{a.name}{a.accountNo ? ` — ${a.accountNo}` : ""}</option>)}
        </select>
      </Field>
      <Field label="مبلغ واریز (تومان)" hint={<>باید دقیقاً برابر <Money rial={d.invoice.payable} exact size="sm" /> باشد.</>} error={issue?.field === "amount" ? issue.message : null}>
        <input type="text" inputMode="numeric" className="num" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} />
      </Field>
      <Field label="شمارهٔ پیگیری بانک" error={issue?.field === "ref" ? issue.message : null}>
        <input type="text" dir="auto" maxLength={64} autoComplete="off" value={refNo} onChange={e => setRefNo(e.target.value)} />
      </Field>
      <Field label="زمان واریز" error={issue?.field === "paidAt" ? issue.message : null}>
        <input type="datetime-local" value={paidAt} onChange={e => setPaidAt(e.target.value)} />
      </Field>
      <div className="row">
        <Button type="submit" variant="primary" busy={busy === "confirm"} busyLabel="در حال تأیید…" disabled={busy !== null}>تأیید واریز و نهایی‌سازی</Button>
      </div>
    </form>
  </section>;
}
