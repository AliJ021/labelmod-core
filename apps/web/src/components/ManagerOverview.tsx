/**
 * طرح ۱۰ — بالای «پنل مدیریتی» گزارش‌ها: شبکهٔ شاخص‌های امروز و فروش خالص ۱۴ روز.
 *
 * هر عدد از یک مسیر موجود سرور می‌آید و دروازهٔ همان مسیر را دارد؛ هیچ مبلغی این‌جا جمع یا ساخته نمی‌شود:
 *   فروش، وجه دریافتی و سود امروز ← `/reports/daily` (سود بی `cost.view` همان `null` و «—» است)
 *   ارزش موجودی به بها ← `/products/summary` (بی `cost.view` «—»)
 *   طلب از مشتریان ← `/dashboard/operations`
 *   ماندهٔ دفتری بانک ← `/treasury/balances`
 *   فروش خالص هر روز ← `/reports/daily/trend` (سطل هر روز در SQL)
 * پاسخ ۴۰۳ هر مسیر کارت خودش را پنهان می‌کند — نه صفر، نه خطای صفحه.
 */
import { useCallback } from "react";
import { pos } from "../lib/pos.ts";
import { catalog } from "../lib/catalog.ts";
import { treasury } from "../lib/treasury.ts";
import { dashboardOperations } from "../lib/dashboard-operations.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { trendBounds, bucketPoints } from "../lib/dashboard-trend.ts";
import { formatMoney } from "../lib/format.ts";
import { Kpi } from "./ui/Kpi.tsx";
import { Money } from "./ui/Money.tsx";
import { BarChart } from "./ui/BarChart.tsx";
import { Solid } from "./Glass.tsx";
import { SectionHeader } from "./ui/PageHeader.tsx";

const DAYS = 14;
const ok = <T,>(p: Promise<T>) => p.then(v => v, () => null);

/** `branchId` تهی (گزارش «همهٔ شعبه‌ها») یعنی اولین شعبهٔ دامنهٔ کاربر — شاخص امروز همیشه یک شعبه است. */
export function ManagerOverview({ branchId: chosen }: { branchId?: string | undefined }) {
  const load = useCallback(async (signal: AbortSignal) => {
    const branchId = chosen ?? (await pos.branches({ signal })).branches[0]?.id;
    if (!branchId) return null;
    const daily = await ok(pos.dailyReport(branchId, undefined, { signal }));
    const [summary, ops, balances] = await Promise.all([
      ok(catalog.summary({ signal })), ok(dashboardOperations.read(branchId, { signal })), ok(treasury.balances({ signal })),
    ]);
    const bounds = daily ? trendBounds("day", daily.businessDate).slice(-(DAYS + 1)) : null;
    const trend = bounds ? await ok(pos.dailyTrend(branchId, bounds, { signal })) : null;
    return { daily, summary, ops, balances, trend };
  }, [chosen]);
  const q = useLatestQuery({ key: `manager-overview:${chosen ?? ""}`, load });
  if (!q.data) return null;
  const { daily, summary, ops, balances, trend } = q.data;
  const bank = balances?.balances.find(b => b.kinds.includes("bank")) ?? null;
  const cards = [
    daily ? <Kpi key="sales" variant="card" icon="register" label="فروش امروز" value={<Money rial={BigInt(daily.salesAmount)} size="lg" />} note={`${daily.invoiceCount} فاکتور`} /> : null,
    daily ? <Kpi key="received" variant="card" icon="card" label="وجه دریافتی امروز" value={<Money rial={BigInt(daily.receivedAmount)} size="lg" />} note="فقط دریافت موفق" /> : null,
    daily ? <Kpi key="profit" variant="card" icon="chart" label="سود ناخالص امروز" value={<Money rial={daily.profitAmount === null ? null : BigInt(daily.profitAmount)} size="lg" />}
      note={daily.profitAmount === null ? "دیدن سود دسترسی بهای تمام‌شده می‌خواهد" : "بر پایهٔ بهای لحظهٔ فروش"} /> : null,
    summary ? <Kpi key="stock" variant="card" icon="box" label="ارزش موجودی (به بها)" value={<Money rial={summary.inventoryValue === null ? null : BigInt(summary.inventoryValue)} size="lg" />}
      note={summary.inventoryValue === null ? "دیدن بها دسترسی بهای تمام‌شده می‌خواهد" : "انبارهای شعبه‌های شما"} /> : null,
    ops?.receivables.state === "ready" ? <Kpi key="owed" variant="card" icon="people" label="طلب از مشتریان" value={<Money rial={BigInt(ops.receivables.owed.amount)} size="lg" />} note="از سند ثبت‌شده" /> : null,
    bank ? <Kpi key="bank" variant="card" icon="vault" label={`بانک (${bank.code})`} value={<Money rial={BigInt(bank.balance)} size="lg" />} note="ماندهٔ دفتر، نه صورت‌حساب بانک" /> : null,
  ].filter(Boolean);
  const points = trend ? bucketPoints(trend.buckets, "day") : [];
  return <>
    {cards.length ? <section className="kpis kpi-cards manager-kpis" aria-label="شاخص‌های امروز">{cards}</section> : null}
    {points.length ? <Solid as="section" className="pad manager-trend" aria-labelledby="manager-trend-title">
      <SectionHeader id="manager-trend-title" title={`فروش خالص ${DAYS} روز`} description="هر ستون خلاصهٔ همان روز است که در دیتابیس حساب شده؛ امروز هنوز تمام نشده." />
      <BarChart title={`فروش خالص ${DAYS} روز اخیر (تومان)`} labelHeader="روز" valueHeader="فروش خالص (تومان)"
        summary={`${DAYS} روز تا امروز، شعبهٔ همین گزارش.`}
        bars={points.map(p => { const v = p.values.sales ?? 0n; return { key: p.key, label: p.label, value: v, display: `${formatMoney(v)} تومان` }; })} />
    </Solid> : null}
  </>;
}
