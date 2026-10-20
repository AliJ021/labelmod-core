/**
 * مرور دوره در داشبورد (دستهٔ B، مصوب مالک) — زیر «امروز».
 *
 * یک بازه (۷ روز، ۳۰ روز، این ماه، ماه قبل) و دورهٔ مبنای آن کنار هم؛ صندوق جدا از
 * سایت؛ میانگین فاکتور؛ **مرجوعی (ارزش کالای برگشتی) جدا از بازپرداخت (پول پس‌داده)**؛
 * و ترکیب روش پرداخت. هر عدد، جمع و تفاضل از `/reports/dashboard/period` (۰۹۹) و
 * دقیق است؛ هیچ درصدی ساخته نمی‌شود — تفاوت به تومان و با «بیشتر/کمتر» گفته می‌شود.
 *
 * - فقط برای نقشی با `report.view` دیده می‌شود (تا پاسخ دسترسی نیامده، اصلاً رندر نمی‌شود).
 * - شعبه: دامنهٔ سراسری «همهٔ شعبه‌ها» را هم دارد؛ تک‌شعبه انتخابی ندارد.
 * - هر تغییر انتخاب درخواست قبلی را لغو می‌کند و فقط پاسخِ آخرین انتخاب می‌نشیند.
 * - بی فاکتور میانگین «—» است، بی `cost.view` سود «—» با دلیل — هیچ‌کدام صفر نیست.
 */
import { useEffect, useId, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { channelLabel, formatCount, formatJalali } from "../lib/format.ts";
import { pos, type Branch, type DashboardPeriod as PeriodData, type PeriodPayments, type PeriodSales } from "../lib/pos.ts";
import {
  dayCount, deltaDirection, deltaMagnitude, PERIOD_PRESETS, periodRange, type PeriodPreset,
} from "../lib/dashboard-period.ts";
import { Solid } from "../components/Glass.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { Segmented } from "../components/ui/Controls.tsx";
import { Kpi } from "../components/ui/Kpi.tsx";
import { Money } from "../components/ui/Money.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { ResultState } from "../components/ResultState.tsx";

type Load = { state: "loading" } | { state: "ready"; data: PeriodData } | { state: "error"; message: string; reference: string | null };

/** «همهٔ شعبه‌ها» در انتخاب‌گر؛ به سرور `branchId` نمی‌رود و سرور دامنه را می‌سنجد. */
const ALL = "all";

export function DashboardPeriod({ today, branches, allBranches }: { today: string; branches: readonly Branch[]; allBranches: boolean }) {
  const [preset, setPreset] = useState<PeriodPreset>("7d");
  const [branch, setBranch] = useState<string>(allBranches && branches.length > 1 ? ALL : (branches[0]?.id ?? ALL));
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const titleId = useId();
  const branchFieldId = useId();
  const range = periodRange(preset, today);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    pos.dashboardPeriod({ branchId: branch === ALL ? null : branch, ...periodRange(preset, today) }, { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setLoad({ state: "ready", data }); },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(err instanceof ApiError
          ? { state: "error", message: err.message, reference: err.correlationId }
          : { state: "error", message: "ارتباط با سرور برقرار نشد.", reference: null });
      },
    );
    return () => controller.abort();
  }, [preset, branch, today]);

  const days = dayCount(range.from, range.to);
  const prevDays = dayCount(range.prevFrom, range.prevTo);
  const showBranch = branches.length > 1;

  return <Solid as="section" className="pad period" aria-labelledby={titleId}>
    <SectionHeader id={titleId} title="مرور دوره"
      description={<>
        <span className="nowrap">{formatJalali(range.from)}</span> تا <span className="nowrap">{formatJalali(range.to)}</span>
        {" "}({formatCount(days)} روز{range.to === today ? "، امروز هنوز تمام نشده" : ""}) در برابر{" "}
        <span className="nowrap">{formatJalali(range.prevFrom)}</span> تا <span className="nowrap">{formatJalali(range.prevTo)}</span>
        {" "}({formatCount(prevDays)} روز)
      </>} />
    <div className="period-controls">
      <Segmented label="بازهٔ مرور" options={PERIOD_PRESETS} value={preset} onChange={setPreset} />
      {showBranch
        ? <label className="period-branch" htmlFor={branchFieldId}>
            <span>شعبه</span>
            <select id={branchFieldId} value={branch} onChange={e => setBranch(e.target.value)}>
              {allBranches ? <option value={ALL}>همهٔ شعبه‌ها</option> : null}
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        : null}
    </div>

    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={3} label="در حال خواندن دوره…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="مرور دوره خوانده نشد" reference={load.reference}
            description={`${load.message} این به معنای «فروشی نبود» نیست.`} />
        : <PeriodBody data={load.data} />}
  </Solid>;
}

/** «۱۲٬۰۰۰ تومان بیشتر از دورهٔ قبل» — تفاضل از سرور، بی درصد. */
function Versus({ previous, delta, kind = "money" }: { previous: string | number | null; delta: string | number | null; kind?: "money" | "count" }) {
  if (previous === null || delta === null) return <>دورهٔ قبل: <Money rial={null} size="sm" unknownLabel="بی فاکتور در یکی از دو دوره" /></>;
  const d = String(delta);
  const dir = deltaDirection(d);
  const amount = kind === "money" ? <Money rial={deltaMagnitude(d)} size="sm" exact /> : <>{formatCount(Number(deltaMagnitude(d)))}</>;
  return <>دورهٔ قبل: {kind === "money" ? <Money rial={String(previous)} size="sm" exact /> : formatCount(Number(previous))}
    {" · "}{dir === "flat" ? "بدون تغییر" : <>{amount} {dir === "up" ? "بیشتر" : "کمتر"}</>}</>;
}

function PeriodBody({ data }: { data: PeriodData }) {
  const cur = data.current.totals;
  const prev = data.previous.totals;
  const d = data.delta.totals;
  const pay = data.current.payments.totals;
  const prevPay = data.previous.payments.totals;
  const payDelta = data.delta.payments.totals;
  const avgDelta = cur.averageInvoice === null || prev.averageInvoice === null ? null : d.averageInvoice;

  return <>
    <section className="kpis kpis--band period-kpis" aria-label="جمع دوره">
      <Kpi variant="band" emphasis label="فروش خالص" icon="receipt" value={<Money rial={cur.salesAmount} size="lg" exact />}
        note={<Versus previous={prev.salesAmount} delta={d.salesAmount} />} />
      <Kpi variant="band" label="میانگین فاکتور" value={<Money rial={cur.averageInvoice} size="lg" exact unknownLabel="فاکتوری در این دوره نیست" />}
        note={<Versus previous={prev.averageInvoice} delta={avgDelta} />} />
      <Kpi variant="band" label="شمار فاکتور" value={<span className="num kpi-count">{formatCount(cur.invoiceCount)}</span>}
        note={<Versus previous={prev.invoiceCount} delta={d.invoiceCount} kind="count" />} />
      <Kpi variant="band" label="دریافت خالص" icon="card" value={<Money rial={pay.netAmount} size="lg" exact />}
        note={<Versus previous={prevPay.netAmount} delta={payDelta.netAmount} />} />
      <Kpi variant="band" label="مرجوعی (ارزش کالای برگشتی)" value={<Money rial={cur.returnAmount} size="lg" exact />}
        note={<>{formatCount(cur.returnCount)} برگ · <Versus previous={prev.returnAmount} delta={d.returnAmount} /></>} />
      <Kpi variant="band" label="بازپرداخت (پول پس‌داده)" value={<Money rial={pay.refundedAmount} size="lg" exact />}
        note={<>{formatCount(pay.refundCount)} پرداخت · <Versus previous={prevPay.refundedAmount} delta={payDelta.refundedAmount} /></>} />
      {data.profitVisible
        ? <Kpi variant="band" label="سود" icon="chart" value={<Money rial={cur.profitAmount} size="lg" exact />}
            note={<Versus previous={prev.profitAmount} delta={d.profitAmount} />} />
        : <Kpi variant="band" label="سود" icon="chart" state="warning" value={<Money rial={null} size="lg" unknownLabel="بدون دسترسی بهای تمام‌شده" />}
            note="برای دیدن سود، دسترسی بهای تمام‌شده لازم است" />}
    </section>
    <p className="period-note">مرجوعی ارزش کالایی است که برگشت؛ بازپرداخت پولی است که واقعاً پس داده شد. مرجوعیِ فاکتور نسیه بدهی را کم می‌کند و پولی برنمی‌گرداند.
      تفاوت‌ها مطلق و به تومان‌اند، نه درصد.</p>

    <ChannelTable data={data} />
    <PaymentTable data={data} />
  </>;
}

type ChannelRow = PeriodSales & { channel: string; deltaSales: string };

function ChannelTable({ data }: { data: PeriodData }) {
  const rows: ChannelRow[] = data.current.channels.map(c => ({
    ...c, deltaSales: data.delta.channels.find(x => x.channel === c.channel)?.salesAmount ?? "0",
  }));
  const columns: Column<ChannelRow>[] = [
    { key: "channel", header: "کانال", cell: r => channelLabel(r.channel) },
    { key: "count", header: "فاکتور", numeric: true, cell: r => <span className="num">{formatCount(r.invoiceCount)}</span> },
    { key: "gross", header: "فروش", numeric: true, cell: r => <Money rial={r.grossAmount} exact /> },
    { key: "returns", header: "مرجوعی", numeric: true, cell: r => <Money rial={r.returnAmount} exact /> },
    { key: "net", header: "فروش خالص", numeric: true, cell: r => <Money rial={r.salesAmount} exact /> },
    { key: "avg", header: "میانگین فاکتور", numeric: true, cell: r => <Money rial={r.averageInvoice} exact unknownLabel="فاکتوری نیست" /> },
    { key: "delta", header: "خالص در برابر دورهٔ قبل", numeric: true, cell: r => <Delta value={r.deltaSales} /> },
  ];
  const t = data.current.totals;
  return <section className="period-table" aria-label="صندوق و سایت">
    <h3 className="section-title period-subtitle">صندوق و سایت</h3>
    <DataTable caption="فروش دوره به تفکیک کانال" columns={columns} rows={rows} rowKey={r => r.channel} stack density="compact"
      foot={{ label: "جمع", cells: {
        count: <span className="num">{formatCount(t.invoiceCount)}</span>, gross: <Money rial={t.grossAmount} exact />,
        returns: <Money rial={t.returnAmount} exact />, net: <Money rial={t.salesAmount} exact />,
        avg: <Money rial={t.averageInvoice} exact unknownLabel="فاکتوری نیست" />, delta: <Delta value={data.delta.totals.salesAmount} />,
      } }} />
  </section>;
}

type MethodRow = PeriodPayments & { methodCode: string; methodName: string; deltaNet: string };

function PaymentTable({ data }: { data: PeriodData }) {
  // سرور روش‌های هر دو دوره را می‌دهد: روشی که فقط در دورهٔ قبل پول داشت، اینجا صفر
  // است و تفاضلش منفی — «این دوره هیچ» یک خبر است و پنهان نمی‌شود.
  const rows: MethodRow[] = data.current.payments.methods.map(m => ({
    ...m, deltaNet: data.delta.payments.methods.find(x => x.methodCode === m.methodCode)?.netAmount ?? "0",
  }));
  const columns: Column<MethodRow>[] = [
    { key: "method", header: "روش", cell: r => r.methodName },
    { key: "in", header: "دریافتی", numeric: true, cell: r => <Money rial={r.receivedAmount} exact /> },
    { key: "out", header: "بازپرداخت", numeric: true, cell: r => <Money rial={r.refundedAmount} exact /> },
    { key: "net", header: "خالص", numeric: true, cell: r => <Money rial={r.netAmount} exact /> },
    { key: "count", header: "شمار دریافت", numeric: true, cell: r => <span className="num">{formatCount(r.paymentCount)}</span> },
    { key: "delta", header: "خالص در برابر دورهٔ قبل", numeric: true, cell: r => <Delta value={r.deltaNet} /> },
  ];
  const t = data.current.payments.totals;
  return <section className="period-table" aria-label="ترکیب پرداخت">
    <h3 className="section-title period-subtitle">ترکیب پرداخت</h3>
    <DataTable caption="پول موفق دوره به تفکیک روش پرداخت" columns={columns} rows={rows} rowKey={r => r.methodCode} stack density="compact"
      empty={{ title: "در این دوره پرداخت موفقی ثبت نشده است.", description: "پرداخت در انتظار یا نامشخص پول شمرده نمی‌شود." }}
      {...(rows.length === 0 ? {} : { foot: { label: "جمع", cells: {
        in: <Money rial={t.receivedAmount} exact />, out: <Money rial={t.refundedAmount} exact />, net: <Money rial={t.netAmount} exact />,
        count: <span className="num">{formatCount(t.paymentCount)}</span>, delta: <Delta value={data.delta.payments.totals.netAmount} />,
      } } })} />
  </section>;
}

/** تفاضل با علامت و کلمه — رنگ فقط تقویت است. */
function Delta({ value }: { value: string }) {
  const dir = deltaDirection(value);
  if (dir === "flat") return <span className="period-delta">بدون تغییر</span>;
  return <span className="period-delta"><Money rial={deltaMagnitude(value)} exact size="sm" /> {dir === "up" ? "بیشتر" : "کمتر"}</span>;
}
