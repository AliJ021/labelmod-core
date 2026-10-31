/**
 * فروش به تفکیک کانال (طرح ۱۰) — کارت کنار روند داشبورد.
 *
 * مبلغ هر کانال از سرور است (`/reports/daily/channels`، مهاجرت ۱۰۸) و جمعشان
 * دقیقاً همان کارت «فروش» است؛ مرجوعی و بازپرداخت به کانال فاکتور اصلی می‌خورند.
 * دونات فقط هندسه است و برای صفحه‌خوان پنهان؛ معنا در فهرست کنارش است: نام کانال،
 * مبلغ و شمار فاکتور — رنگ تنها نشانه نیست.
 *
 * همان الگوی «همگام‌سازی سایت»: هر خواندن قبلی را لغو می‌کند، شکستِ به‌روزرسانی ارقام
 * قبلی را نگه می‌دارد، و ۴۰۳ یعنی پنهان، نه «سالم» و نه خطا.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { channelLabel, formatCount } from "../lib/format.ts";
import { pos, type DailyChannels } from "../lib/pos.ts";
import { channelArcs } from "../lib/channel-share.ts";
import { Solid } from "../components/Glass.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { ResultState } from "../components/ResultState.tsx";
import type { PeriodReload } from "./DashboardPeriod.tsx";

type Load = { state: "loading" } | { state: "denied" } | { state: "ready"; data: DailyChannels }
  | { state: "error"; message: string; reference: string | null };

/** رنگ هر کانال از توکن‌های نمودار؛ ترتیب ثابت تا رنگ یک کانال روزبه‌روز عوض نشود. */
const SWATCH: Record<string, string> = { pos: "var(--chart-1)", web: "var(--chart-2)", instagram: "var(--info)", phone: "var(--ink-3)" };
const swatch = (channel: string) => SWATCH[channel] ?? "var(--ink-3)";

export function DashboardChannels({ branchId, date, salesAmount, register }: {
  branchId: string; date: string; salesAmount: string; register?: (reload: PeriodReload | null) => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const titleId = useId();
  const gen = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  const read = useCallback(async (keep: boolean, outer?: AbortSignal): Promise<void> => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const mine = ++gen.current;
    const stop = () => controller.abort();
    outer?.addEventListener("abort", stop);
    const current = () => !controller.signal.aborted && gen.current === mine;
    if (!keep) setLoad({ state: "loading" });
    try {
      const data = await pos.dailyChannels(branchId, date, { signal: controller.signal });
      if (current()) setLoad({ state: "ready", data });
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 403) { setLoad({ state: "denied" }); return; }
      setLoad(prev => keep && prev.state === "ready" ? prev : err instanceof ApiError
        ? { state: "error", message: err.message, reference: err.correlationId }
        : { state: "error", message: "ارتباط با سرور برقرار نشد.", reference: null });
      if (keep) throw err;
    } finally {
      outer?.removeEventListener("abort", stop);
      if (inflight.current === controller) inflight.current = null;
    }
  }, [branchId, date]);

  useEffect(() => { void read(false); }, [read]);
  useEffect(() => () => { gen.current++; inflight.current?.abort(); }, []);
  useEffect(() => {
    register?.(signal => read(true, signal));
    return () => register?.(null);
  }, [register, read]);

  if (load.state === "denied") return null;
  return <Solid as="section" className="pad dashboard-channels" aria-labelledby={titleId} aria-busy={load.state === "loading" || undefined}>
    <SectionHeader id={titleId} title="فروش به تفکیک کانال" description="سهم هر کانال از فروش خالص امروز؛ جمع کانال‌ها همان کارت «فروش» است." />
    {load.state === "loading" ? <Skeleton variant="chart" />
      : load.state === "error" ? <ResultState kind="error" title="فروش کانال‌ها خوانده نشد" description={load.message}
          actionLabel="تلاش دوباره" onAction={() => { void read(false); }} />
      : load.data.channels.length === 0 ? <ResultState title="امروز هنوز فروشی ثبت نشده است." />
      : <ChannelBody data={load.data} salesAmount={salesAmount} />}
  </Solid>;
}

function ChannelBody({ data, salesAmount }: { data: DailyChannels; salesAmount: string }) {
  const arcs = channelArcs(data.channels);
  const invoices = data.channels.reduce((t, c) => t + c.invoiceCount, 0);
  const R = 42, C = 2 * Math.PI * R;
  return <div className="channels-body">
    {arcs ? <figure className="channels-donut" aria-hidden="true">
      <svg viewBox="0 0 100 100" focusable="false">
        <circle className="channels-track" cx="50" cy="50" r={R} />
        {arcs.map(a => <circle key={a.channel} cx="50" cy="50" r={R} stroke={swatch(a.channel)}
          strokeDasharray={`${a.length * C} ${C}`} strokeDashoffset={-a.start * C} />)}
      </svg>
      <figcaption><strong>{formatCount(invoices)}</strong><span>فاکتور امروز</span></figcaption>
    </figure> : null}
    <dl className="channels-list">
      {data.channels.map(c => <div key={c.channel}>
        <dt><span className="channels-swatch" style={{ background: swatch(c.channel) }} aria-hidden="true" />{channelLabel(c.channel)}
          <small>{formatCount(c.invoiceCount)} فاکتور{c.returnCount ? ` · ${formatCount(c.returnCount)} مرجوعی` : ""}</small></dt>
        <dd><Money rial={BigInt(c.salesAmount)} /></dd>
      </div>)}
      <div className="channels-total"><dt>جمع</dt><dd><Money rial={BigInt(salesAmount)} /></dd></div>
    </dl>
  </div>;
}
