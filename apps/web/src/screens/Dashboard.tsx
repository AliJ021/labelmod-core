/**
 * داشبورد — مرکز کنترل امروز، نه ویترین کارت (docs/UI_PATTERNS.md، «داشبورد»).
 *
 * ترتیب خواندن عمدی است:
 *   ۱. چه چیزی رسیدگی می‌خواهد (دوره‌های ثبت‌نشده) — بالاترین اولویت.
 *   ۲. سه شاخص امروز: فروش · وجه دریافتی · سود (design.md) — زبانه‌هایی که
 *      یک پنل مشترک را عوض می‌کنند.
 *   ۳. روند ساعتیِ شاخص انتخاب‌شده — از `/reports/daily/hourly` (مهاجرت ۰۸۳)،
 *      که جمع ساعت‌هایش دقیقاً همان سه کارت است.
 *   ۴. کارهای پرتکرار.
 *
 * هیچ عدد ساختگی روی این صفحه نمی‌نشیند. بخشی که داده یا مجوزش
 * نیست، می‌گوید چرا — نه صفر، نه نمونه.
 */
import { useId, useLayoutEffect, useState } from "react";
import { navigate } from "../lib/use-url-state.ts";
import { Solid } from "../components/Glass.tsx";
import { Icon } from "../components/Icon.tsx";
import { quickActionView, type NavAccess } from "../lib/navigation.ts";
import { ApiError } from "../lib/api.ts";
import { parseRial } from "../lib/money.ts";
import { channelLabel, formatCount, formatGregorian, formatJalali } from "../lib/format.ts";
import {
  canClosePeriod,
  periodNote,
  pos,
  type Branch,
  type DailyHourly,
  type DailyReport,
  type UnpostedRow,
} from "../lib/pos.ts";
import { hourlyView, METRIC_COPY, type Metric } from "../lib/dashboard-hourly.ts";
import { session } from "../lib/session.ts";
import { Money } from "../components/ui/Money.tsx";
import { Kpi, KpiTabs, type KpiTab } from "../components/ui/Kpi.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge, StatusIcon } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { BarChart } from "../components/ui/BarChart.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ResultState } from "../components/ResultState.tsx";

/**
 * روند ساعتی خلاصه روز. `denied`: سرور این جزئیات را نداد (همان دروازهٔ
 * خلاصه روز است، پس در عمل با خودِ کارت‌ها می‌آید) — آن‌وقت کارت‌ها زبانه
 * نمی‌شوند، چون پنلی برای نشان‌دادن نیست.
 */
type Hourly = { state: "loading" } | { state: "ready"; data: DailyHourly } | { state: "error" } | { state: "denied" };

export function Dashboard({ access }: { access: NavAccess }) {
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
  const [hourly, setHourly] = useState<Hourly>({ state: "loading" });
  /**
   * زبانهٔ انتخاب‌شده **محلی** است، نه در نشانی: داشبورد هیچ وضعیت نشانی‌ای
   * ندارد و انتخاب شاخص یک نمای گذرای همان صفحه است، نه مقصدی برای پیوند.
   * هر سه روند با یک درخواست آمده‌اند؛ تغییر زبانه هیچ درخواستی نمی‌سازد.
   */
  const [metric, setMetric] = useState<Metric>("sales");
  const tabsId = useId();

  /**
   * ⚠️ زنجیرهٔ بارگذاری با Unmount لغو می‌شود. قفل و خروج داشبورد را
   *    Unmount می‌کنند؛ بی این لغو، زنجیره درخواست بعدی را **پس از قفل**
   *    می‌فرستاد و Reload بعدی آن را وسط راه قطع می‌کرد — همان خطای
   *    WebKit در آزمون قفل/خروج.
   * ⚠️ **Layout، نه useEffect.** پاک‌سازی useEffect پس از commit و در یک Task
   *    جدا اجرا می‌شود؛ صفحهٔ قفل دیده می‌شد، پاسخی که در این فاصله می‌رسید
   *    زنجیره را لغونشده می‌یافت و «auth/can» را پس از قفل می‌فرستاد (CI روی
   *    WebKit پربار). پاک‌سازی Layout در خودِ commit حذف اجرا می‌شود.
   */
  useLayoutEffect(() => {
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

        // روند ساعتی همان روز کاریِ کارت‌ها (تاریخ از پاسخ سرور، نه ساعت
        // مرورگر) و همان دروازه. یک درخواست برای هر سه شاخص؛ ۴۰۳ حالت
        // «بی‌جزئیات» است نه خطا، و خطای واقعی فقط همین بخش را می‌گیرد.
        try {
          const data = await pos.dailyHourly(first.id, report.businessDate, { signal });
          if (signal.aborted) return;
          setHourly({ state: "ready", data });
        } catch (err) {
          if (signal.aborted) return;
          setHourly(err instanceof ApiError && err.status === 403 ? { state: "denied" } : { state: "error" });
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
  // سود بی `cost.view` نامعلوم است: کارتش می‌ماند (با دلیل)، ولی زبانه‌اش انتخاب نمی‌شود
  // و پنل هرگز روند سود را نمی‌سازد — نه صفر، نه ستون.
  const profitKnown = report.profitAmount !== null && (hourly.state !== "ready" || hourly.data.profitVisible);
  const selected: Metric = metric === "profit" && !profitKnown ? "sales" : metric;
  const kpis: KpiTab<Metric>[] = [
    { key: "sales", label: "فروش", icon: "receipt", primary: true,
      value: <Money rial={sales} size="xl" />,
      note: report.returnCount > 0
        ? `${formatCount(report.invoiceCount)} فاکتور · ${formatCount(report.returnCount)} مرجوعی`
        : `${formatCount(report.invoiceCount)} فاکتور` },
    { key: "received", label: "وجه دریافتی", icon: "card",
      value: <Money rial={received} size="xl" />,
      state: credit > 0n ? "warning" : "completed",
      note: credit > 0n ? <><Money rial={credit} size="sm" /> هنوز نرسیده</> : "همه پول رسیده" },
    // سود `null` یعنی این کاربر `cost.view` ندارد — نه اینکه سود صفر بوده.
    // نشان‌دادن «۰» به‌جایش، به صندوق‌دار می‌گفت فروشگاه امروز ضرر کرده.
    { key: "profit", label: "سود", icon: "chart", unavailable: !profitKnown,
      value: report.profitAmount === null ? <span className="kpi-unknown" aria-label="نامعلوم">—</span> : <Money rial={report.profitAmount} size="xl" />,
      state: report.profitAmount === null ? "warning" : "completed",
      note: report.profitAmount === null ? "برای دیدن سود، دسترسی بهای تمام‌شده لازم است" : "پس از بهای تمام‌شده" },
  ];

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
      {hourly.state === "denied"
        ? <section className="kpis kpis--band" aria-label="شاخص‌های امروز">
            {kpis.map(k => <Kpi key={k.key} label={k.label} icon={k.icon} emphasis={k.primary ?? false} value={k.value} state={k.state} note={k.note} />)}
          </section>
        : <>
            <KpiTabs items={kpis} value={selected} onChange={setMetric} label="شاخص‌های امروز" panelId={`${tabsId}-panel`} idPrefix={`${tabsId}-tab`} />
            <HourlyPanel id={`${tabsId}-panel`} metric={selected} hourly={hourly} />
          </>}
      </Solid>

      <QuickActions access={access} />
    </div>
  );
}

/**
 * کارهای پرتکرار — فقط آنچه این نقش واقعاً می‌تواند (`QUICK_ACTIONS` در
 * رجیستری ناوبری). در حال بررسی: جای‌نگهدار بی‌برچسب، تا نوار نپرد و برچسب
 * ممنوع حتی در DOM نیاید. نرسیدن پاسخ: پنهان + پیام آرام با «بررسی دوباره».
 */
function QuickActions({ access }: { access: NavAccess }) {
  const view = quickActionView(access);
  if (view.visible.length === 0 && view.pending === 0 && !view.degraded) return null;
  return <nav className="quick-actions" aria-label="کارهای پرتکرار" aria-busy={view.pending > 0 || undefined}>
    {view.visible.map(a =>
      <a className="quick-action" key={a.key} href={a.href} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(a.href); }}>
        <Icon name={a.icon} />
        <span>{a.name}</span>
      </a>)}
    {Array.from({ length: view.pending }, (_, i) => <span key={`p${i}`} className="quick-action quick-action--pending" aria-hidden="true" />)}
    {view.degraded ? <p className="quick-actions-note" role="status">
      <StatusIcon state="unknown" />دسترسی بعضی کارها بررسی نشد.
      <button type="button" className="link" onClick={access.retry}>بررسی دوباره</button>
    </p> : null}
  </nav>;
}

/**
 * روند ساعتیِ شاخص انتخاب‌شده — پنل مشترکِ سه زبانه. هر شاخص عنوان، توضیح،
 * حالت خالی و نمودار خودش را دارد؛ متن «فروش» زیر «سود» نمی‌ماند. داده برای
 * هر سه یک بار آمده و اینجا فقط انتخاب می‌شود. ساعت‌های زودتر سمت راست.
 */
function HourlyPanel({ id, metric, hourly }: { id: string; metric: Metric; hourly: Exclude<Hourly, { state: "denied" }> }) {
  const copy = METRIC_COPY[metric];
  let body;
  if (hourly.state === "loading") body = <Skeleton variant="chart" lines={1} label={`در حال بارگذاری ${copy.title}…`} />;
  else if (hourly.state === "error") body = <ResultState kind="error" title="روند ساعتی خوانده نشد." description="کارت‌های بالا معتبرند؛ این بخش را بعداً دوباره ببینید." />;
  else {
    const view = hourlyView(hourly.data.hours, metric);
    body = view.kind === "unknown"
      ? <ResultState kind="denied" title="روند سود برای این نقش در دسترس نیست." description="دیدن سود به دسترسی بهای تمام‌شده نیاز دارد." />
      : view.kind === "empty"
        ? <ResultState title={copy.empty[0]} description={copy.empty[1]} />
        : <BarChart title={copy.chart} labelHeader="ساعت" valueHeader={copy.value} summary={view.summary} bars={view.bars} />;
  }
  // نام پنل عنوان خودش است («روند وجه دریافتی ساعتی»)، نه زبانه: ارجاع به زبانه متن کامل
  // آن (برچسب + مبلغ + یادداشت) را نام پنل می‌کرد. پیوند زبانه ↔ پنل با `aria-controls` است.
  const headingId = `${id}-h`;
  return <section className="today-trend" id={id} role="tabpanel" aria-labelledby={headingId} tabIndex={0} aria-busy={hourly.state === "loading" || undefined}>
    <SectionHeader id={headingId} title={copy.title} description={copy.description} />
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
