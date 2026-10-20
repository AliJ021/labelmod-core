/**
 * داشبورد — مرکز کنترل امروز، نه ویترین کارت (docs/UI_PATTERNS.md، «داشبورد»).
 *
 * ترتیب خواندن (بازطراحی مصوب مالک، ۲۰۲۶/۱۰/۱۸):
 *   ۱. سه شاخص **امروز**: فروش · وجه دریافتی · سود (design.md) — زبانه‌هایی که
 *      یک پنل مشترک را عوض می‌کنند.
 *   ۲. روند **فقط** شاخص انتخاب‌شده، ساعتی/روزانه/ماهانه؛ «مقایسهٔ هر سه» صریح است.
 *      ساعتی از `/reports/daily/hourly` (مهاجرت ۰۸۳، جمع ساعت‌ها همان سه کارت)؛ روزانه
 *      و ماهانه از `/reports/daily/trend` (مهاجرت ۰۹۳، جمع در SQL، ماه جلالی).
 *   ۲٫۵. مرور دوره (`DashboardPeriod`): بازه و دورهٔ مبنا، صندوق/سایت، مرجوعی جدا از
 *      بازپرداخت، ترکیب پرداخت — فقط با `report.view`.
 *   ۳. پیگیری ثبت حسابداری فروش — بازشوندهٔ بسته با شمار و وضعیت واقعی در خلاصه.
 *      این ثبت دورهٔ فروش و شیفت در دفتر است، نه وضعیت کلی سایت یا سامانه.
 *   ۴. کارهای پرتکرار.
 *
 * هیچ عدد ساختگی روی این صفحه نمی‌نشیند. بخشی که داده یا مجوزش
 * نیست، می‌گوید چرا — نه صفر، نه نمونه.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { navigate } from "../lib/use-url-state.ts";
import { Solid } from "../components/Glass.tsx";
import { Icon } from "../components/Icon.tsx";
import { accessOf, quickActionView, routeUrl, type NavAccess } from "../lib/navigation.ts";
import { ApiError } from "../lib/api.ts";
import { parseRial } from "../lib/money.ts";
import { channelLabel, formatCount, formatGregorian, formatJalali } from "../lib/format.ts";
import {
  pos,
  type Branch,
  type DailyHourly,
  type DailyReport,
  type DailyTrend,
  type UnpostedRow,
} from "../lib/pos.ts";
import {
  bucketPoints, DAYS, GRAINS, hourPoints, MONTHS, trendBounds, trendCopy, trendView,
  type Grain, type Metric, type TrendPoint,
} from "../lib/dashboard-trend.ts";
import { attentionItems, type AttentionItem } from "../lib/dashboard-attention.ts";
import { session } from "../lib/session.ts";
import { Money } from "../components/ui/Money.tsx";
import { Kpi, KpiTabs, type KpiTab } from "../components/ui/Kpi.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge, StatusIcon } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { LineChart, tickEvery } from "../components/ui/LineChart.tsx";
import { Segmented } from "../components/ui/Controls.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { DashboardPeriod } from "./DashboardPeriod.tsx";

/**
 * روند ساعتی خلاصه روز. `denied`: سرور این جزئیات را نداد (همان دروازهٔ
 * خلاصه روز است، پس در عمل با خودِ کارت‌ها می‌آید) — آن‌وقت کارت‌ها زبانه
 * نمی‌شوند، چون پنلی برای نشان‌دادن نیست.
 */
type Hourly = { state: "loading" } | { state: "ready"; data: DailyHourly } | { state: "error" } | { state: "denied" };

/**
 * روند روزانه/ماهانه — فقط با انتخاب، یک بار برای هر دانه‌بندی. `denied`: این نقش
 * `report.view` ندارد (صریح از دسترسی ناوبری، یا ۴۰۳ سرور) — نه صفر، نه خطا.
 */
type Trend = { state: "loading" } | { state: "ready"; data: DailyTrend } | { state: "error"; reference: string | null } | { state: "denied" };

/**
 * درآمد ثبت‌نشده. سه «چیزی نیست» از هم جدا می‌مانند: `ready` با آرایهٔ خالی
 * (سنجیدیم و مرتب است)، `denied` (این نقش `cost.view` ندارد — «مرتب» گفتن به او
 * اطمینان بی‌پشتوانه است) و `error` (نتوانستیم بسنجیم؛ ممکن است موردی منتظر باشد).
 */
type Unposted = { state: "loading" } | { state: "ready"; rows: UnpostedRow[] } | { state: "denied" } | { state: "error"; reference: string | null };

export function Dashboard({ access }: { access: NavAccess }) {
  const [branch, setBranch] = useState<Branch | null>(null);
  /** همهٔ شعبه‌های در دامنه و اینکه دامنه سراسری است — برای انتخاب‌گر «مرور دوره». */
  const [scope, setScope] = useState<{ branches: Branch[]; allBranches: boolean }>({ branches: [], allBranches: false });
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  const [unposted, setUnposted] = useState<Unposted>({ state: "loading" });
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
  /** دانه‌بندی روند هم محلی است؛ روزانه و ماهانه فقط با انتخاب و یک بار بار می‌شوند. */
  const [grain, setGrain] = useState<Grain>("hour");
  /** «مقایسهٔ هر سه شاخص» — صریح و محلی؛ پیش‌فرض فقط شاخص انتخاب‌شده. */
  const [compare, setCompare] = useState(false);
  const [trends, setTrends] = useState<Partial<Record<"day" | "month", Trend>>>({});
  /**
   * دانه‌بندی‌هایی که درخواستشان رفته یا رسیده — در ref، نه state: دو کلیک پیش از
   * رندر بعدی دو درخواست نمی‌سازد. Unmount همهٔ درخواست‌های در راه را لغو می‌کند.
   */
  const trendRequested = useRef(new Set<"day" | "month">());
  const trendAbort = useRef<AbortController | null>(null);
  // کنترلر **داخل** افکت ساخته می‌شود: StrictMode افکت را اجرا، پاک و دوباره اجرا
  // می‌کند و ref می‌ماند؛ کنترلرِ ساخته‌شده در `useRef` پس از پاک‌سازی اول لغوشده
  // می‌ماند و هر روند را برای همیشه «در حال بارگذاری» نگه می‌داشت.
  useEffect(() => {
    const c = new AbortController();
    trendAbort.current = c;
    const requested = trendRequested.current;
    return () => { c.abort(); requested.clear(); };
  }, []);
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
    // A document reload does not unmount React. Stop this request chain before
    // a late response starts the next fetch in the departing document (WebKit).
    // A persisted page keeps its requests so a bfcache restore can finish loading.
    const leaving = (event: PageTransitionEvent) => { if (!event.persisted) controller.abort(); };
    window.addEventListener("pagehide", leaving);
    void (async () => {
      try {
        const { branches, allBranches } = await pos.branches({ signal });
        if (signal.aborted) return;
        setScope({ branches, allBranches });
        const first = branches[0];
        if (!first) {
          setError({ message: "به هیچ شعبه‌ای دسترسی ندارید.", reference: null });
          return;
        }
        setBranch(first);
        const report = await pos.dailyReport(first.id, undefined, { signal });
        if (signal.aborted) return;
        setReport(report);

        // درآمد ثبت‌نشده پشت `cost.view` است. ۴۰۳ «این بخش برای این نقش
        // نیست» است، نه خطا؛ ولی خطای واقعی هم «مرتب» یا «بی‌دسترسی» جلوه نمی‌کند.
        try {
          const { rows } = await pos.unpostedRevenue({ signal });
          if (signal.aborted) return;
          setUnposted({ state: "ready", rows });
        } catch (err) {
          if (signal.aborted) return;
          setUnposted(unpostedFailure(err));
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
    return () => { window.removeEventListener("pagehide", leaving); controller.abort(); };
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
    setUnposted({ state: "ready", rows });
    return rows;
  }

  /** «بررسی دوباره» پس از خطا — همان درخواست؛ خطای دوباره همان حالت خطا را نگه می‌دارد. */
  function retryUnposted() {
    setUnposted({ state: "loading" });
    void reload().catch(err => setUnposted(unpostedFailure(err)));
  }

  /**
   * روند روزانه/ماهانه با اولین انتخاب. مرزها از «امروز» سرور (`businessDate`)
   * ساخته می‌شوند، نه ساعت مرورگر. بی `report.view` صریح، درخواستی فرستاده نمی‌شود.
   */
  function chooseGrain(next: Grain) {
    setGrain(next);
    if (next === "hour" || !branch || !report) return;
    if (trendRequested.current.has(next)) return;
    if (access.verdicts.get("report.view") === "deny") {
      setTrends(t => ({ ...t, [next]: { state: "denied" } }));
      return;
    }
    const controller = trendAbort.current;
    if (!controller) return;
    trendRequested.current.add(next);
    const { signal } = controller;
    setTrends(t => ({ ...t, [next]: { state: "loading" } }));
    pos.dailyTrend(branch.id, trendBounds(next, report.businessDate), { signal }).then(
      data => { if (!signal.aborted) setTrends(t => ({ ...t, [next]: { state: "ready", data } })); },
      err => {
        if (signal.aborted) return;
        // خطا دوباره قابل انتخاب است؛ بی‌دسترسی نه.
        const denied = err instanceof ApiError && err.status === 403;
        if (!denied) trendRequested.current.delete(next);
        setTrends(t => ({ ...t, [next]: denied
          ? { state: "denied" }
          : { state: "error", reference: err instanceof ApiError ? err.correlationId : null } }));
      },
    );
  }

  const sales = parseRial(report.salesAmount);
  const received = parseRial(report.receivedAmount);
  // ⚠️ تفاوت فروش و وجه دریافتیِ امروز «طلب» نیست و صفرشدنش «همه پول رسیده» نیست:
  //    دریافتِ امروز می‌تواند بابت فاکتور دیروز باشد و بازپرداخت از آن کم می‌شود
  //    (ریشه دید دریافتی بیش از فروش رخ می‌دهد). فقط مقایسهٔ خنثی، بی ادعای فاکتوری.
  const diff = received - sales;
  const posHref = accessOf(["sale.create"], access.verdicts) === "allow" ? routeUrl("pos") : null;
  const items = unposted.state === "ready" ? attentionItems(unposted.rows, report.businessDate, mayClose, posHref) : [];
  const attention = items.filter(i => i.tone === "attention").length;
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
      note: diff === 0n ? "برابر با فروش امروز"
        : <><Money rial={diff < 0n ? -diff : diff} size="sm" /> {diff < 0n ? "کمتر" : "بیشتر"} از فروش امروز</> },
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
            <TrendPanel id={`${tabsId}-panel`} metric={selected} grain={grain} onGrain={chooseGrain}
              compare={compare} onCompare={setCompare} today={report.businessDate}
              hourly={hourly} trend={grain === "hour" ? undefined : trends[grain]} />
          </>}
      </Solid>

      {/* مرور دوره (دستهٔ B): فقط برای نقش دارای گزارش؛ پیش از پاسخ دسترسی رندر نمی‌شود. */}
      {accessOf(["report.view"], access.verdicts) === "allow"
        ? <DashboardPeriod today={report.businessDate} branches={scope.branches} allBranches={scope.allBranches} />
        : null}

      {/*
        پیگیری ثبت حسابداری فروش — پس از شاخص‌ها و روند، بسته به‌طور پیش‌فرض. خلاصه
        شمار و وضعیت واقعی را می‌گوید (در حال بررسی، خوانده نشد، بی‌دسترسی، پاک، n مورد) —
        خطا هرگز سبز نیست. دکمه‌ها همان SafeAction و همان دروازهٔ سرور‌اند.
      */}
      <Solid as="section" className="pad attention" aria-labelledby="dash-attention">
        <details className="attention-disclosure">
          <summary>
            <span className="attention-title" id="dash-attention">پیگیری ثبت حسابداری فروش</span>
            <AttentionSummary unposted={unposted} attention={attention} info={items.length - attention} />
          </summary>
          <p className="attention-scope">ثبت فروش و بهای تمام‌شدهٔ هر دورهٔ فروش (شیفت صندوق یا روز هر کانال) در دفتر حسابداری.
            این بخش وضعیت کلی سایت یا سامانه نیست. دورهٔ امروز از اینجا بسته نمی‌شود.</p>
          {closed ? <p className="attention-done" role="status"><StatusIcon state="completed" />{closed}</p> : null}
          <ul className="tasks" aria-busy={unposted.state === "loading" || undefined}>
            {unposted.state === "loading" ? (
              <Task state="pending" label="در حال بررسی درآمد ثبت‌نشده…" />
            ) : unposted.state === "denied" ? (
              <Task state="unknown" label="درآمد ثبت‌نشده برای این نقش نمایش داده نمی‌شود"
                cause="دیدن آن به دسترسی بهای تمام‌شده نیاز دارد؛ مدیر یا حسابدار آن را پیگیری می‌کند. این به معنای «همه‌چیز مرتب» نیست."
                note="کاری از شما لازم نیست." />
            ) : unposted.state === "error" ? (
              <Task state="failed" label="وضعیت درآمد ثبت‌نشده خوانده نشد"
                cause="ممکن است دوره‌ای منتظر ثبت در دفتر باشد؛ این خطا به معنای «همه‌چیز مرتب» نیست."
                reference={unposted.reference}
                action={<button type="button" className="btn" onClick={retryUnposted}>بررسی دوباره</button>} />
            ) : items.length === 0 ? (
              <Task state="completed" label="همه درآمدها به دفتر رفته‌اند"
                cause="فروش و بهای تمام‌شدهٔ همهٔ دوره‌ها در دفتر حسابداری ثبت شده است." />
            ) : (
              items.map(item => <AttentionTask key={item.key} item={item}
                onClosed={(outcome, channel, date) => {
                  setClosed(outcome === "verified"
                    ? `بررسی شد: دورهٔ ${channel} در ${date} بسته شده است.`
                    : `دورهٔ ${channel} در ${date} بسته شد.`);
                  void reload().catch(() => {});
                }}
                reload={reload} />)
            )}
          </ul>
        </details>
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

function unpostedFailure(err: unknown): Unposted {
  return err instanceof ApiError && err.status === 403
    ? { state: "denied" }
    : { state: "error", reference: err instanceof ApiError ? err.correlationId : null };
}

/**
 * روند شاخص انتخاب‌شده — پنل مشترکِ سه زبانه، با انتخاب ساعتی/روزانه/ماهانه.
 * هر شاخص و هر دانه‌بندی عنوان، توضیح، حالت خالی و نمودار خودش را دارد؛ متن
 * «فروش» زیر «سود» نمی‌ماند. نمودار همهٔ شاخص‌های معلوم را با هم می‌کشد و خط
 * انتخاب‌شده پررنگ‌تر است. دوره‌های زودتر سمت راست.
 */
function TrendPanel({ id, metric, grain, onGrain, compare, onCompare, today, hourly, trend }: {
  id: string; metric: Metric; grain: Grain; onGrain: (g: Grain) => void;
  compare: boolean; onCompare: (v: boolean) => void; today: string;
  hourly: Exclude<Hourly, { state: "denied" }>; trend: Trend | undefined;
}) {
  const copy = trendCopy(metric, grain);
  const what = grain === "hour" ? "روند ساعتی" : grain === "day" ? "روند روزانه" : "روند ماهانه";
  let body;
  let busy = false;
  if (grain === "hour" ? hourly.state === "loading" : !trend || trend.state === "loading") {
    busy = true;
    body = <Skeleton variant="chart" lines={1} label={`در حال بارگذاری ${copy.title}…`} />;
  } else if (grain === "hour" ? hourly.state === "error" : trend?.state === "error") {
    body = <ResultState kind="error" title={`${what} خوانده نشد.`}
      reference={trend?.state === "error" ? trend.reference : null}
      description={grain === "hour" ? "کارت‌های بالا معتبرند؛ این بخش را بعداً دوباره ببینید." : "کارت‌های بالا معتبرند؛ دوباره همین گزینه را انتخاب کنید."} />;
  } else if (trend?.state === "denied") {
    body = <ResultState kind="denied" title={`${what} برای این نقش در دسترس نیست.`}
      description="روند روزهای گذشته به دسترسی گزارش نیاز دارد؛ روند ساعتی امروز در دسترس است." />;
  } else {
    const points: TrendPoint[] = grain === "hour"
      ? (hourly.state === "ready" ? hourPoints(hourly.data.hours, hourly.data.currentHour) : [])
      : trend?.state === "ready" ? bucketPoints(trend.data.buckets, grain) : [];
    const view = trendView(points, metric, grain, compare);
    const tick = tickEvery(points.length, grain === "hour" ? 16 : 8);
    body = view.kind === "unknown"
      ? <ResultState kind="denied" title={`روند سود برای این نقش در دسترس نیست.`} description="دیدن سود به دسترسی بهای تمام‌شده نیاز دارد." />
      : view.kind === "empty"
        ? <ResultState title={copy.empty[0]} description={copy.empty[1]} />
        : <LineChart title={copy.chart} summary={view.summary} note={view.note}
            xHeader={grain === "hour" ? "ساعت" : grain === "day" ? "روز" : "ماه"}
            points={points.map((p, i) => ({ key: p.key, label: p.label, long: p.long, partial: p.partial, tick: tick(i) }))}
            series={view.series.map(s => ({ key: s.metric, label: s.label, values: s.values, displays: s.displays, emphasis: s.metric === metric }))} />;
  }
  // نام پنل عنوان خودش است («روند وجه دریافتی ساعتی»)، نه زبانه: ارجاع به زبانه متن کامل
  // آن (برچسب + مبلغ + یادداشت) را نام پنل می‌کرد. پیوند زبانه ↔ پنل با `aria-controls` است.
  const headingId = `${id}-h`;
  return <section className="today-trend" id={id} role="tabpanel" aria-labelledby={headingId} tabIndex={0} aria-busy={busy || undefined}>
    <SectionHeader id={headingId} title={copy.title} description={copy.description}
      actions={<Segmented label="بازهٔ روند" options={GRAINS} value={grain} onChange={onGrain} />} />
    <div className="trend-tools">
      {/* کارت‌های بالا همیشه «امروز»اند؛ وقتی بازهٔ روند امروز نیست، صریح گفته می‌شود. */}
      <p className="trend-scope">
        {grain === "hour" ? <>کارت‌ها و نمودار: امروز ({formatJalali(today)})</>
          : <>کارت‌های بالا: فقط امروز ({formatJalali(today)}) · نمودار: {grain === "day" ? `${formatCount(DAYS)} روز اخیر` : `${formatCount(MONTHS)} ماه شمسی اخیر`}</>}
      </p>
      <label className="trend-compare"><input type="checkbox" checked={compare} onChange={e => onCompare(e.target.checked)} />
        مقایسهٔ هر سه شاخص</label>
    </div>
    {body}
  </section>;
}

/**
 * خلاصهٔ بستهٔ «پیگیری ثبت حسابداری فروش» — شمار و وضعیت واقعی، هر حالت جدا:
 * در حال بررسی · خوانده نشد (خطا، نه سبز) · بی‌دسترسی (نامعلوم، نه «مرتب») · n مورد · فقط
 * دورهٔ باز امروز · همه ثبت شده. «n مورد» فقط با شمار واقعی همان فهرست.
 */
function AttentionSummary({ unposted, attention, info }: { unposted: Unposted; attention: number; info: number }) {
  if (unposted.state === "loading") return <StatusBadge state="pending" label="در حال بررسی…" />;
  if (unposted.state === "error") return <StatusBadge state="failed" label="وضعیت خوانده نشد" />;
  if (unposted.state === "denied") return <StatusBadge state="unknown" label="برای این نقش نمایش داده نمی‌شود" />;
  if (attention > 0) return <StatusBadge state="attention" label={`${formatCount(attention)} مورد نیازمند بررسی`} />;
  if (info > 0) return <StatusBadge state="pending" label="دورهٔ امروز هنوز باز است؛ کاری لازم نیست" />;
  return <StatusBadge state="completed" label="همه ثبت شده‌اند" />;
}

/** یک دورهٔ ثبت‌نشده: چه شده، چرا مهم است، و دکمه/پیوند مجاز یا اینکه کار چه کسی است. */
function AttentionTask({ item, onClosed, reload }: {
  item: AttentionItem;
  onClosed: (outcome: "verified" | "done", channel: string, date: string) => void;
  reload: () => Promise<UnpostedRow[]>;
}) {
  const r = item.row;
  const channel = channelLabel(r.channel);
  const date = formatJalali(r.businessDate);
  const action = item.action?.kind === "close" ? <SafeAction
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
    onDone={outcome => onClosed(outcome === "verified" ? "verified" : "done", channel, date)}
  /> : item.action?.kind === "link" ? (() => {
    const { href, label } = item.action;
    return <a className="btn" href={href} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(href); }}>{label}</a>;
  })() : null;
  return <Task state={item.tone === "attention" ? "attention" : "active"} label={item.title} cause={item.cause}
    detail={<Money rial={r.payableAmount} size="sm" />} action={action} note={item.note ?? undefined}
    info={item.tone === "info"} />;
}

function Task({ state, label, cause, note, action, detail, reference, info = false }: {
  state: "completed" | "warning" | "attention" | "active" | "pending" | "unknown" | "failed";
  label: string;
  /** چرا مهم است / چرا این حالت — جملهٔ دوم زیر عنوان. */
  cause?: string | undefined;
  note?: string | undefined;
  action?: React.ReactNode;
  detail?: React.ReactNode;
  reference?: string | null | undefined;
  info?: boolean;
}) {
  return (
    <li className={`task task--${state}${info ? " task--info" : ""}`}>
      <StatusIcon state={state} />
      <span className="task-label">
        {label}
        {cause ? <span className="task-cause">{cause}</span> : null}
        {reference ? <span className="task-cause">شناسهٔ پیگیری: <Ltr>{reference}</Ltr></span> : null}
      </span>
      {detail ? <span className="task-detail">{detail}</span> : null}
      {/*
        دکمه فقط وقتی ساخته می‌شود که کاری برای انجام باشد؛ وگرنه
        یادداشت می‌گوید چرا نه. «هیچ» بدتر از یک جمله است.
      */}
      {action ? <span className="task-action">{action}</span> : note === undefined ? null : <span className="muted small task-note">{note}</span>}
    </li>
  );
}
