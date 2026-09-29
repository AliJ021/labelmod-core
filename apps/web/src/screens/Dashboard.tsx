/**
 * داشبورد — مرکز کنترل امروز، نه ویترین کارت (docs/UI_PATTERNS.md، «داشبورد»).
 *
 * ترتیب خواندن عمدی است:
 *   ۱. چه چیزی رسیدگی می‌خواهد (دوره‌های ثبت‌نشده) — بالاترین اولویت.
 *   ۲. سه شاخص امروز: فروش · وجه دریافتی · سود (design.md).
 *   ۳. فروش ساعت‌به‌ساعت امروز — فقط از `/reports/hourly` واقعی.
 *   ۴. کارهای پرتکرار.
 *
 * هیچ عدد ساختگی روی این صفحه نمی‌نشیند. بخشی که داده یا مجوزش
 * نیست، می‌گوید چرا — نه صفر، نه نمونه.
 */
import { useEffect, useState } from "react";
import { navigate } from "../lib/use-url-state.ts";
import { Solid } from "../components/Glass.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { ApiError } from "../lib/api.ts";
import { parseRial } from "../lib/money.ts";
import { channelLabel, formatCount, formatGregorian, formatHour, formatJalali, formatMoney } from "../lib/format.ts";
import {
  canClosePeriod,
  periodNote,
  pos,
  type Branch,
  type DailyReport,
  type UnpostedRow,
} from "../lib/pos.ts";
import { reports, type HourlyRow } from "../lib/reports.ts";
import { session } from "../lib/session.ts";
import { Money } from "../components/ui/Money.tsx";
import { Kpi } from "../components/ui/Kpi.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge, StatusIcon } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { BarChart, type Bar } from "../components/ui/BarChart.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ResultState } from "../components/ResultState.tsx";

/** `null` = این کاربر `report.view` ندارد؛ آرایه = سنجیدیم. */
type Hourly = HourlyRow[] | null | "error";

const QUICK: readonly { href: string; name: string; icon: IconName }[] = [
  { href: "/?page=pos", name: "فروش جدید", icon: "register" },
  { href: "/?page=invoices&invoices.status=draft", name: "رسیدگی به پیش‌نویس‌ها", icon: "receipt" },
  { href: "/?page=catalog&catalog.labels=1", name: "چاپ لیبل بارکد", icon: "print" },
  { href: "/?page=invoices", name: "فاکتورها و چاپ رسید", icon: "receipt" },
];

export function Dashboard() {
  const [branch, setBranch] = useState<Branch | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  /**
   * `null` یعنی «نمی‌دانیم» — این کاربر `cost.view` ندارد.
   *
   * جدا از آرایه خالی که یعنی «سنجیدیم و چیزی نبود». نشان‌دادن
   * «همه‌چیز مرتب است» به کسی که اصلاً اجازه دیدنش را ندارد، یک
   * اطمینان بی‌پشتوانه است.
   */
  const [unposted, setUnposted] = useState<UnpostedRow[] | null>(null);
  /**
   * آیا این کاربر اجازه بستن دوره را دارد؟
   *
   * ⚠️ این یک **راحتی** است، نه دروازه. سرور در لحظه اجرا دوباره
   *    مجوز می‌گیرد.
   */
  const [mayClose, setMayClose] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  const [hourly, setHourly] = useState<Hourly>(null);
  const [hourlyLoading, setHourlyLoading] = useState(true);

  /**
   * ⚠️ زنجیرهٔ بارگذاری با Unmount لغو می‌شود. قفل و خروج داشبورد را
   *    Unmount می‌کنند؛ بی این لغو، زنجیره درخواست بعدی را **پس از قفل**
   *    می‌فرستاد و Reload بعدی آن را وسط راه قطع می‌کرد — همان خطای
   *    WebKit در آزمون قفل/خروج.
   */
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const { branches } = await pos.branches({ signal });
        if (signal.aborted) return;
        const first = branches[0];
        if (!first) {
          setError({ message: "به هیچ شعبه‌ای دسترسی ندارید.", reference: null });
          return;
        }
        setBranch(first);
        const report = await pos.dailyReport(first.id, undefined, { signal });
        if (signal.aborted) return;
        setReport(report);

        // درآمد ثبت‌نشده پشت `cost.view` است. نداشتنش خطا نیست —
        // فقط یعنی این بخش برای این کاربر نیست.
        try {
          const { rows } = await pos.unpostedRevenue({ signal });
          if (signal.aborted) return;
          setUnposted(rows);
        } catch {
          if (signal.aborted) return;
          setUnposted(null);
        }

        // جدا از بالا: اگر پرسش مجوز شکست بخورد، فهرست باید همچنان
        // دیده شود — فقط بدون دکمه.
        try {
          const decision = await session.can("period.close", { signal });
          if (signal.aborted) return;
          setMayClose(decision.verdict === "allow");
        } catch {
          if (signal.aborted) return;
          setMayClose(false);
        }

        // فروش ساعتی پشت `report.view` است؛ صندوق‌دار ندارد و این
        // «خطا» نیست. خطای واقعی جدا نشان داده می‌شود.
        try {
          const { rows } = await reports.hourly({ from: report.businessDate, to: report.businessDate, branchId: first.id }, { signal });
          if (signal.aborted) return;
          setHourly(rows);
        } catch (err) {
          if (signal.aborted) return;
          setHourly(err instanceof ApiError && err.status === 403 ? null : "error");
        } finally {
          if (!signal.aborted) setHourlyLoading(false);
        }
      } catch (err) {
        if (signal.aborted) return;
        setError(err instanceof ApiError
          ? { message: err.message, reference: err.correlationId }
          : { message: "ارتباط با سرور برقرار نشد.", reference: null });
      }
    })();
    return () => controller.abort();
  }, []);

  if (error) {
    return <Solid className="pad"><ResultState kind="error" title={error.message} reference={error.reference}
      description="اتصال را بررسی کنید و صفحه را دوباره بارگذاری کنید." /></Solid>;
  }

  if (!report) {
    return <div className="dashboard">
      <Skeleton variant="text" lines={2} label="در حال بارگذاری…" />
      <div className="kpis"><Skeleton variant="kpi" lines={3} /></div>
    </div>;
  }

  /** فهرست از سرور دوباره خوانده می‌شود، نه از حافظه: اگر بستن نیمه‌کاره مانده باشد، سطر باید بماند. */
  async function reload(): Promise<UnpostedRow[]> {
    const { rows } = await pos.unpostedRevenue();
    setUnposted(rows);
    return rows;
  }

  const sales = parseRial(report.salesAmount);
  const received = parseRial(report.receivedAmount);
  // نسیه = فروخته ولی پولش نیامده. منفی بی‌معناست (پیش‌پرداخت روز
  // قبل)، پس صفر می‌شود تا کارت «−۵۰٬۰۰۰ نسیه» نشان ندهد.
  const credit = sales > received ? sales - received : 0n;
  const attention = unposted?.length ?? 0;

  return (
    <div className="dashboard">
      <PageHeader
        title="امروز"
        context={<>
          {branch?.name} · <span className="nowrap">{formatJalali(report.businessDate, true)}</span>
          {/* میلادی فقط زمینهٔ ثانوی است: کوچک‌تر و کم‌رنگ‌تر، در برگ LTR. */}
          <span className="page-context-secondary"><Ltr mono={false}>{formatGregorian(report.businessDate)}</Ltr></span>
        </>}
      />

      {/*
        نیاز به رسیدگی اول می‌آید: کاری که انجام نشود، عدد فردا را غلط می‌کند.
        «پاک» هم یک پاسخ است و دیده می‌شود.
      */}
      <Solid as="section" className="pad attention" aria-labelledby="dash-attention">
        <SectionHeader id="dash-attention" title="نیاز به رسیدگی"
          actions={unposted && attention > 0 ? <StatusBadge state="attention" label={`${formatCount(attention)} مورد`} /> : null} />
        {closed ? <p className="attention-done" role="status"><StatusIcon state="completed" />{closed}</p> : null}
        <ul className="tasks">
          {unposted === null ? (
            <Task state="warning" label="برای دیدن درآمد ثبت‌نشده، دسترسی بهای تمام‌شده لازم است" />
          ) : unposted.length === 0 ? (
            <Task state="completed" label="همه درآمدها به دفتر رفته‌اند" />
          ) : (
            unposted.map((r) => {
              const channel = channelLabel(r.channel);
              const date = formatJalali(r.businessDate);
              const note = periodNote(r, report.businessDate, mayClose);
              return <Task key={r.batchId} state="attention"
                label={`${formatCount(r.invoiceCount)} فاکتور ${channel} در ${date} هنوز به دفتر نرفته`}
                detail={<Money rial={r.payableAmount} size="sm" />}
                action={canClosePeriod(r, report.businessDate, mayClose) ? <SafeAction
                  trigger="بستن دوره"
                  title={`بستن دورهٔ ${channel} — ${date}`}
                  summary={<dl className="safe-facts">
                    <div><dt>فاکتورها</dt><dd>{formatCount(r.invoiceCount)}</dd></div>
                    <div><dt>مبلغ قابل ثبت</dt><dd><Money rial={r.payableAmount} /></dd></div>
                  </dl>}
                  consequence="درآمد و بهای تمام‌شدهٔ این دوره در دفتر ثبت می‌شود و پس از آن فاکتور تازه‌ای به این دوره نمی‌نشیند. اصلاح بعدی فقط با سند معکوس ممکن است."
                  confirmLabel="بستن دوره و ثبت در دفتر"
                  pendingLabel="در حال بستن…"
                  run={async () => {
                    // کلید Idempotency فرستاده نمی‌شود: سرور آن را از
                    // (شعبه، کانال، تاریخ) می‌سازد و تکرار Replay می‌گیرد.
                    await pos.closeChannelDay({ branchId: r.branchId, channel: r.channel, date: r.businessDate });
                  }}
                  verify={async () => !(await reload()).some(x => x.batchId === r.batchId)}
                  onDone={outcome => {
                    setClosed(outcome === "verified"
                      ? `بررسی شد: دورهٔ ${channel} در ${date} بسته شده است.`
                      : `دورهٔ ${channel} در ${date} بسته شد.`);
                    void reload().catch(() => {});
                  }}
                /> : null}
                note={note}
              />;
            })
          )}
        </ul>
      </Solid>

      {/*
        یک سطح مات برای «امروز»: سه شاخص در یک نوار با خط جداکننده و روند
        ساعتی زیرش — یک فضای کار، نه چند ویجت (بازبینی بصری ۱).
      */}
      <Solid as="section" className="today" aria-label="امروز در یک نگاه">
      <section className="kpis kpis--band" aria-label="شاخص‌های امروز">
        <Kpi label="فروش" icon="receipt" emphasis
          value={<Money rial={sales} size="xl" />}
          note={report.returnCount > 0
            ? `${formatCount(report.invoiceCount)} فاکتور · ${formatCount(report.returnCount)} مرجوعی`
            : `${formatCount(report.invoiceCount)} فاکتور`} />
        <Kpi label="وجه دریافتی" icon="card"
          value={<Money rial={received} size="xl" />}
          state={credit > 0n ? "warning" : "completed"}
          note={credit > 0n ? <><Money rial={credit} size="sm" /> هنوز نرسیده</> : "همه پول رسیده"} />
        {/*
          سود `null` یعنی این کاربر `cost.view` ندارد — نه اینکه سود
          صفر بوده. نشان‌دادن «۰» به‌جایش، به صندوق‌دار می‌گفت
          فروشگاه امروز ضرر کرده.
        */}
        <Kpi label="سود" icon="chart"
          value={report.profitAmount === null ? <span className="kpi-unknown" aria-label="نامعلوم">—</span> : <Money rial={report.profitAmount} size="xl" />}
          state={report.profitAmount === null ? "warning" : "completed"}
          note={report.profitAmount === null ? "برای دیدن سود، دسترسی بهای تمام‌شده لازم است" : "پس از بهای تمام‌شده"} />
      </section>

      <HourlyPanel hourly={hourly} loading={hourlyLoading} />
      </Solid>

      <nav className="quick-actions" aria-label="کارهای پرتکرار">
        {QUICK.map(a =>
          <a className="quick-action" key={a.href} href={a.href} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(a.href); }}>
            <Icon name={a.icon} />
            <span>{a.name}</span>
          </a>)}
      </nav>
    </div>
  );
}

/**
 * فروش ساعت‌به‌ساعت امروز. کانال‌ها جمع می‌شوند — جمع در `bigint`، نه
 * در شناور. بازهٔ نمایش ۸ تا ۲۲ است و هر ساعتِ دارای فروش بیرون از آن
 * هم افزوده می‌شود؛ ساعتی که داده ندارد صفر است، نه حذف.
 */
function HourlyPanel({ hourly, loading }: { hourly: Hourly; loading: boolean }) {
  if (!loading && hourly === null) return null;
  let body;
  if (loading) body = <Skeleton variant="chart" lines={1} label="در حال بارگذاری فروش ساعتی…" />;
  else if (hourly === "error" || hourly === null) body = <ResultState kind="error" title="فروش ساعتی خوانده نشد." description="بقیهٔ داشبورد معتبر است؛ این بخش را بعداً دوباره ببینید." />;
  else {
    const totals = new Map<number, bigint>();
    for (const r of hourly) totals.set(r.hourOfDay, (totals.get(r.hourOfDay) ?? 0n) + parseRial(r.netAmount));
    const hours = [...totals.keys()];
    const from = Math.min(8, ...hours), to = Math.max(22, ...hours);
    const bars: Bar[] = [];
    for (let h = from; h <= to; h++) {
      const value = totals.get(h) ?? 0n;
      bars.push({ key: String(h), label: formatHour(h), value, display: `${formatMoney(value)} تومان` });
    }
    const peak = bars.reduce<Bar | null>((m, b) => (b.value > 0n && (!m || b.value > m.value) ? b : m), null);
    body = peak === null
      ? <ResultState title="هنوز فروشی برای امروز ثبت نشده است." description="با اولین فاکتور نهایی، نمودار ساعتی اینجا ساخته می‌شود." />
      : <BarChart title="فروش خالص هر ساعت (تومان)" labelHeader="ساعت" valueHeader="فروش خالص"
          summary={`بیشترین فروش: ساعت ${peak.label} با ${peak.display}`} bars={bars} />;
  }
  return <section className="today-trend" aria-labelledby="dash-hourly">
    <SectionHeader id="dash-hourly" title="روند فروش ساعتی" description="از گزارش فروش ساعتی؛ همهٔ کانال‌ها با هم. ساعت‌های زودتر سمت راست." />
    {body}
  </section>;
}

function Task({ state, label, note, action, detail }: {
  state: "completed" | "warning" | "attention";
  label: string;
  note?: string | undefined;
  action?: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <li className={`task task--${state}`}>
      <StatusIcon state={state} />
      <span className="task-label">{label}</span>
      {detail ? <span className="task-detail">{detail}</span> : null}
      {/*
        دکمه فقط وقتی ساخته می‌شود که کاری برای انجام باشد؛ وگرنه
        یادداشت می‌گوید چرا نه. «هیچ» بدتر از یک جمله است.
      */}
      {action ? <span className="task-action">{action}</span> : note === undefined ? null : <span className="muted small task-note">{note}</span>}
    </li>
  );
}
