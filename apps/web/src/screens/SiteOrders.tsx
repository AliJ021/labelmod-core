/**
 * «سفارش‌های سایت» — فهرست و جزئیات سفارش ووکامرس برای مدیر؛ فقط‌خواندنی.
 *
 * - داده هر بار مستقیم از سایت خوانده می‌شود (امضاشده، بی‌کش). «نامعلوم» با دلیل نشان داده می‌شود، نه
 *   فهرست خالی. هیچ دکمه‌ای سفارش را تغییر نمی‌دهد؛ ویرایش جایش پیشخوان ووکامرس است.
 * - فیلتر، صفحه و سفارش انتخاب‌شده در نشانی صفحه‌اند (`useUrlState`)، پس پیوند قابل اشتراک است.
 * - هر خواندن قبلی لغو می‌شود و پاسخ دیررس بی‌اثر است (همان الگوی نسل داشبورد).
 * - دادهٔ شخصی همان حداقل افزونه است: نام صورت‌حساب؛ نه تلفن، نه نشانی.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { useUrlState } from "../lib/use-url-state.ts";
import {
  coreState, isOrderStatus, ORDER_STATUS_LABEL, ORDER_STATUSES, orderStatusState, siteOrders,
  type OrderSummary, type OrdersPage, type OrderView,
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

const money = (rial: string | null) => rial === null
  ? <span className="muted" title="مبلغ سایت به ریالِ دقیق تبدیل نشد">نامعلوم</span>
  : <Money rial={rial} exact size="sm" />;

export function SiteOrders() {
  const [statusParam, setStatusParam] = useUrlState("site-orders.status");
  const [pageParam, setPageParam] = useUrlState("site-orders.page");
  const [orderParam, setOrderParam] = useUrlState("site-orders.order");
  const status = isOrderStatus(statusParam) ? statusParam : null;
  const page = /^[1-9]\d{0,2}$/.test(pageParam) ? Number(pageParam) : 1;
  const orderId = /^[1-9]\d{0,15}$/.test(orderParam) ? Number(orderParam) : null;

  const [list, reload] = useLatest<OrdersPage>(signal => siteOrders.list(page, status, { signal }), [page, status]);

  return <div className="stack">
    <PageHeader title="سفارش‌های سایت"
      context="مستقیم از سایت و فقط خواندنی؛ ویرایش، لغو و استرداد از پیشخوان ووکامرس انجام می‌شود."
      meta={list.state === "done" ? <span className="nowrap">خوانده‌شده {formatJalaliMoment(list.data.fetchedAt)}</span> : undefined}
      actions={<Button onClick={reload} disabled={list.state === "loading"}>به‌روزرسانی</Button>} />
    <FilterBar label="فیلتر سفارش‌ها" onReset={status ? () => { setStatusParam(""); setPageParam(""); } : undefined}>
      <Field label="وضعیت سفارش">
        <select value={status ?? ""} onChange={e => { setStatusParam(e.target.value); setPageParam(""); setOrderParam(""); }}>
          <option value="">همهٔ وضعیت‌ها</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
        </select>
      </Field>
    </FilterBar>
    <OrdersList load={list} page={page} selected={orderId}
      onPage={p => { setPageParam(p === 1 ? "" : String(p)); setOrderParam(""); }}
      onSelect={id => setOrderParam(id === null ? "" : String(id))} onRetry={reload} />
    {orderId !== null ? <OrderPanel key={orderId} id={orderId} onClose={() => setOrderParam("")} /> : null}
  </div>;
}

function Unavailable({ title, message, code, onRetry }: { title: string; message: string; code: string; onRetry: () => void }) {
  return <ResultState kind="error" title={title} reference={code} actionLabel="تلاش دوباره" onAction={onRetry}
    description={`${message} این به معنای «سفارشی نیست» نیست.`} />;
}

function OrdersList({ load, page, selected, onPage, onSelect, onRetry }: {
  load: Load<OrdersPage>; page: number; selected: number | null;
  onPage: (p: number) => void; onSelect: (id: number | null) => void; onRetry: () => void;
}) {
  const columns: Column<OrderSummary>[] = [
    { key: "number", header: "سفارش", cell: r => <Ltr>#{r.number}</Ltr> },
    { key: "date", header: "تاریخ", cell: r => r.createdAt ? <span className="nowrap">{formatJalaliMoment(r.createdAt)}</span> : <span className="muted">—</span> },
    { key: "customer", header: "مشتری", cell: r => r.customerName || <span className="muted">بی‌نام</span> },
    { key: "status", header: "وضعیت سایت", cell: r => <StatusBadge state={orderStatusState(r.status)} label={ORDER_STATUS_LABEL[r.status]} /> },
    { key: "core", header: "ثبت در Core", cell: r => { const c = coreState(r.core); return <StatusBadge state={c.state} label={c.label} quiet />; } },
    { key: "items", header: "کالا", numeric: true, cell: r => <span className="num">{formatCount(r.itemCount)}</span> },
    { key: "total", header: "مبلغ", numeric: true, cell: r => money(r.totalRial) },
  ];
  return <Solid as="section" className="pad" aria-labelledby="site-orders-list">
    <SectionHeader id="site-orders-list" title="فهرست سفارش‌ها"
      description={load.state === "done" && load.data.state === "ready"
        ? `${formatCount(load.data.total)} سفارش؛ تازه‌ترین اول`
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
                empty={{ title: "در این صفحه سفارشی نیست.", description: "فیلتر وضعیت یا صفحه را عوض کنید." }} />
              {load.data.pages > 1 ? <nav className="site-orders-pager" aria-label="صفحه‌های سفارش">
                <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>صفحهٔ قبل</Button>
                <span className="num" aria-current="page">صفحهٔ {formatCount(page)} از {formatCount(load.data.pages)}</span>
                <Button disabled={page >= load.data.pages} onClick={() => onPage(page + 1)}>صفحهٔ بعد</Button>
              </nav> : null}
            </>}
  </Solid>;
}

function OrderPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const [load, reload] = useLatest<OrderView>(signal => siteOrders.get(id, { signal }), [id]);
  type Item = Extract<OrderView, { state: "ready" }>["order"]["items"][number] & { line: number };
  const columns: Column<Item>[] = [
    { key: "name", header: "کالا", cell: r => r.name },
    { key: "sku", header: "SKU", cell: r => r.sku ? <Ltr>{r.sku}</Ltr> : <span className="muted">—</span> },
    { key: "qty", header: "تعداد", numeric: true, cell: r => <span className="num">{formatCount(r.quantity)}</span> },
    { key: "total", header: "مبلغ", numeric: true, cell: r => money(r.totalRial) },
  ];
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
            : <OrderDetailView order={load.data.order} columns={columns} />}
  </Solid>;
}

type Detail = Extract<OrderView, { state: "ready" }>["order"];
function OrderDetailView({ order, columns }: { order: Detail; columns: Column<Detail["items"][number] & { line: number }>[] }) {
  const core = coreState(order.core);
  return <div className="stack">
    <dl className="site-order-facts">
      <div><dt>وضعیت سایت</dt><dd><StatusBadge state={orderStatusState(order.status)} label={ORDER_STATUS_LABEL[order.status]} /></dd></div>
      <div><dt>ثبت در Core</dt><dd><StatusBadge state={core.state} label={core.label} /></dd></div>
      <div><dt>تاریخ</dt><dd>{order.createdAt ? formatJalaliMoment(order.createdAt) : "—"}</dd></div>
      <div><dt>مشتری</dt><dd>{order.customerName || "بی‌نام"}</dd></div>
      <div><dt>روش پرداخت</dt><dd>{order.paymentMethod || "—"}</dd></div>
      <div><dt>جمع سفارش</dt><dd>{money(order.totalRial)}</dd></div>
      <div><dt>هزینهٔ ارسال</dt><dd>{money(order.shippingRial)}</dd></div>
      <div><dt>تخفیف</dt><dd>{money(order.discountRial)}</dd></div>
    </dl>
    <DataTable caption={`اقلام سفارش #${order.number}`} columns={columns}
      rows={order.items.map((item, i) => ({ ...item, line: i + 1 }))} rowKey={r => String(r.line)}
      density="compact" stack empty={{ title: "این سفارش قلم کالایی ندارد." }} />
    {order.itemsTruncated ? <p className="muted small" role="note">فقط ۱۰۰ قلم اول نشان داده شده است؛ فهرست کامل در پیشخوان ووکامرس است.</p> : null}
  </div>;
}
