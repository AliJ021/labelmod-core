/**
 * گزارش‌ها — الگوی «گزارش» (docs/UI_PATTERNS.md §۳): سرصفحه ← زبانه ←
 * نوار فیلتر (بازه و دامنه) ← خلاصه ← جدول ← خروجی.
 *
 * ADR-002: گزارش مالی ناحیهٔ «متوسط» است — جدول عدد **مات** و پرتضاد. پس هر
 * بخش یک سطح مات است با سرعنوان، ابزار و جدول؛ کارت در کارت نه.
 *
 * ── چهار چیزی که این صفحه عمداً نمی‌کند ─────────────────────────────
 *
 * **هیچ عددی حساب نمی‌کند.** جمع، سود، حاشیه و مانده تجمعی همه از SQL
 * می‌آیند. تنها جمعی که اینجا زده می‌شود، جمع ستون‌های جدولِ جلوی چشم
 * است — و آن هم با `bigint`، نه `number`. نمودار ساعتی هم فقط همان
 * سطرهای سرور را به‌ازای ساعت با `bigint` جمع می‌کند.
 *
 * **«امروز» را از ساعت مرورگر نمی‌گیرد.** بازه پیش‌فرض از
 * `GET /reports/daily` می‌آید که `platform.business_date()` را
 * برمی‌گرداند. تبلتی که ساعتش عقب باشد، بازه‌ای می‌ساخت که فروش امروز
 * را نداشت.
 *
 * **شعبه را تحمیل نمی‌کند.** `branchId` فرستاده نمی‌شود مگر کاربر
 * انتخاب کند؛ سرور خودش دامنه را می‌گذارد. حذف پارامتر هیچ دری باز
 * نمی‌کند.
 *
 * **بهای `null` را صفر نشان نمی‌دهد.** کاربر بدون `cost.view` در
 * ستون بها و سود «—» می‌بیند (`<Money rial={null}>`). صفر یعنی «سود
 * نداشتی»؛ «—» یعنی «اجازه دیدنش را نداری». یکی‌کردنشان یعنی سرپرست
 * فکر کند فروشگاه ضرر کرده.
 */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { SnappayReport } from "../components/SnappayReport.tsx";
import { StaffSales } from "../components/StaffSales.tsx";
import { TabList, TabPanels, useTabsId } from "../components/Tabs.tsx";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { ReportFilters, type PeriodFilters } from "../components/ReportFilters.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Money, Percent, Qty } from "../components/ui/Money.tsx";
import { Kpi } from "../components/ui/Kpi.tsx";
import { BarChart, type Bar } from "../components/ui/BarChart.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { JalaliDateHint, useJalaliDraft } from "../components/ui/JalaliDate.tsx";
import { routeUrl } from "../lib/navigation.ts";
import { useUrlState, useUrlTab } from "../lib/use-url-state.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { ApiError } from "../lib/api.ts";
import { parseRial } from "../lib/money.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { channelLabel, formatCount, formatHour, formatJalali, formatJalaliMoment, formatMoney } from "../lib/format.ts";
import { jalaliInputOf, parseJalaliDate, periodLabel, readJalaliPeriod } from "../lib/report-filters.ts";
import { pos, type Branch, type Warehouse } from "../lib/pos.ts";
import {
  MOVEMENT_KIND,
  PARTY_LABEL,
  csvUrl,
  defaultPeriod,
  periodCsvUrl,
  reports,
  sumRialOrNull as sumRial,
  type BasketRow,
  type CompareRow,
  type CustomerBasketRow,
  type HourlyRow,
  type LedgerRow,
  type MovementRow,
  type PartyRow,
  type Period,
  type ProfitRow,
  type SalesRow,
  type ShiftRow,
  type TrialRow,
  type ValuationRow,
} from "../lib/reports.ts";
import { previousPeriod } from "../lib/jalali-period.ts";

const TABS = [
  { key: "manager", label: "پنل مدیریتی" },
  { key: "sales", label: "فروش" },
  { key: "staff", label: "فروش کاربران" },
  { key: "snappay", label: "اسنپ‌پی" },
  { key: "profit", label: "سود کالا" },
  { key: "stock", label: "موجودی" },
  { key: "ledger", label: "دفتر حساب" },
  { key: "trial", label: "تراز آزمایشی" },
  { key: "parties", label: "دریافتنی و پرداختنی" },
  { key: "cash", label: "مغایرت نقد" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** زبانه‌هایی که بازهٔ تاریخ در پرس‌وجویشان نیست — نوار فیلتر همین را صریح می‌گوید. */
const PERIODLESS: Partial<Record<TabKey, string>> = {
  parties: "مانده تا همین لحظه است؛ بازهٔ تاریخ روی این گزارش اثری ندارد.",
  stock: "موجودی و ارزش تا همین لحظه است؛ بازهٔ تاریخ فقط روی کاردکس اثر دارد.",
};

type LoadError = { message: string; reference: string | null; status: number | null };
function loadError(err: unknown): LoadError {
  if (err instanceof ApiError) return { message: err.message, reference: err.correlationId, status: err.status };
  return { message: "ارتباط با سرور برقرار نشد.", reference: null, status: null };
}

export function Reports() {
  const tabsId = useTabsId();
  const [tab, setTab] = useUrlTab("reports.tab", TABS, "sales");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [allBranches, setAllBranches] = useState(false);
  const [branchId, setBranchId] = useUrlState("reports.branch");
  const [fromRaw, setFrom] = useUrlState("reports.from");
  const [toRaw, setTo] = useUrlState("reports.to");
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [attempt, setAttempt] = useState(0);
  // نشانی و درخواست ISO میلادی می‌مانند؛ کاربر جلالی می‌نویسد و می‌بیند.
  const fromUrl = fromRaw || period?.from || "";
  const toUrl = toRaw || period?.to || "";
  const [fromText, setFromText] = useJalaliDraft(fromUrl);
  const [toText, setToText] = useJalaliDraft(toUrl);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setError(null);
    void (async () => {
      try {
        const { branches: list, allBranches: all } = await pos.branches({ signal });
        if (signal.aborted) return;
        setAllBranches(all);
        setBranches(list);
        const first = list[0];
        if (!first) {
          setError({ message: "به هیچ شعبه‌ای دسترسی ندارید.", reference: null, status: 403 });
          return;
        }
        // بازه پیش‌فرض از **تاریخ کاری سرور** ساخته می‌شود.
        const daily = await pos.dailyReport(first.id, undefined, { signal });
        if (signal.aborted) return;
        setPeriod(defaultPeriod(daily.businessDate));
      } catch (err) {
        if (!signal.aborted) setError(loadError(err));
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const header = <PageHeader title="گزارش‌ها"
    context="همهٔ اعداد از دفتر و انبار سرور می‌آیند؛ «امروز» را سرور تعیین می‌کند، نه ساعت این دستگاه." />;

  if (error) {
    return <div className="report-page">
      {header}
      <Solid className="pad">
        <ResultState kind={error.status === 403 ? "denied" : "error"} title={error.message} reference={error.reference}
          {...(error.status === 403 ? {} : { actionLabel: "تلاش دوباره", onAction: () => setAttempt(n => n + 1) })} />
      </Solid>
    </div>;
  }
  if (!period) {
    return <div className="report-page">
      {header}
      <Skeleton variant="row" lines={3} label="در حال آماده‌سازی گزارش‌ها…" />
    </div>;
  }

  // بازه از دو فیلد جلالی خوانده می‌شود؛ تاریخ نیمه‌تایپ یا ناموجود فقط خطای کنار فیلد است و
  // نشانی آخرین تاریخ معتبر را نگه می‌دارد. تا خطا هست، هیچ درخواست بازه‌داری فرستاده نمی‌شود.
  const read = readJalaliPeriod(fromText, toText);
  const issue = read.issue;
  const from = read.from ?? fromUrl;
  const to = read.to ?? toUrl;
  const typeDate = (text: string, setText: (t: string) => void, setIso: (iso: string) => void) => {
    setText(text);
    const r = parseJalaliDate(text);
    if (r.kind === "ok") setIso(r.iso);
  };
  const p: Period = { from, to, ...(branchId === "" ? {} : { branchId }) };
  const branchName = branches.find(b => b.id === branchId)?.name;
  const changed = fromRaw !== "" || toRaw !== "" || branchId !== "" || fromText !== jalaliInputOf(fromUrl) || toText !== jalaliInputOf(toUrl);
  const range = periodLabel(from, to);
  const periodless = PERIODLESS[tab];

  const filters: PeriodFilters = {
    fields: <>
      {/* `inputMode="decimal"`: صفحه‌کلید عددی گوشی «/» ندارد؛ «.» یا هشت رقم پشت‌هم هم پذیرفته است. */}
      <Field label="از تاریخ" hint={<JalaliDateHint iso={read.from} example="مثلاً ۱۴۰۵/۰۶/۰۱" />} error={issue?.field === "from" ? issue.message : null}>
        <input type="text" inputMode="decimal" autoComplete="off" className="num" value={fromText} placeholder="۱۴۰۵/۰۶/۰۱"
          onChange={e => typeDate(e.target.value, setFromText, setFrom)} />
      </Field>
      <Field label="تا تاریخ" hint={<JalaliDateHint iso={read.to} example="مثلاً ۱۴۰۵/۰۶/۳۱" />} error={issue?.field === "to" ? issue.message : null}>
        <input type="text" inputMode="decimal" autoComplete="off" className="num" value={toText} placeholder="۱۴۰۵/۰۶/۳۱"
          onChange={e => typeDate(e.target.value, setToText, setTo)} />
      </Field>
      {branches.length > 1 ? <Field label="شعبه">
        <select value={branchId} onChange={e => setBranchId(e.target.value)}>
          <option value="">همه شعبه‌ها</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field> : null}
    </>,
    summary: <>
      {range ? <>بازه: <strong>{range}</strong> (هر دو سر شامل)</> : "بازه کامل نیست؛ گزارش پس از اصلاح تاریخ‌ها خوانده می‌شود."}
      {branches.length > 1 ? <> · {branchName ? <>شعبه: <strong>{branchName}</strong></> : "همه شعبه‌های در دسترس"}</> : null}
      {periodless ? <> · {periodless}</> : null}
    </>,
    onReset: changed ? () => {
      setFrom(""); setTo(""); setBranchId("");
      setFromText(jalaliInputOf(period.from)); setToText(jalaliInputOf(period.to));
    } : undefined,
  };

  // بازهٔ نیمه‌تایپ به سرور نمی‌رود؛ گزارش‌های بی‌بازه (مانده اشخاص) منتظرش نمی‌مانند.
  // موجودی هم لحظه‌ای است و فقط کاردکسِ زیرش بازه دارد، پس جدول ارزش می‌ماند و
  // تنها کاردکس منتظر بازهٔ کامل می‌ماند (B1-03).
  const blocked = issue !== null && tab !== "parties" && tab !== "stock";

  return (
    <div className="report-page">
      {header}
      <TabList hrefFor={key => routeUrl("reports", key)} id={tabsId} items={TABS} value={tab} onChange={setTab} label="گزارش‌ها" />
      <TabPanels id={tabsId} items={TABS} value={tab} className="report-panel">
        {blocked ? <>
          <ReportFilters filters={filters} />
          <Solid className="pad"><ResultState title="بازهٔ تاریخ کامل نیست." description={issue?.message ?? ""} /></Solid>
        </> : tab === "snappay" ? (
          <><ReportFilters filters={filters} /><SnappayReport period={p} /></>
        ) : tab === "staff" ? (
          <StaffSales period={p} filters={filters} />
        ) : tab === "manager" ? (
          <><ReportFilters filters={filters} /><ManagerPanel period={p} /></>
        ) : tab === "sales" ? (
          <><ReportFilters filters={filters} /><SalesReport period={p} /></>
        ) : tab === "profit" ? (
          <><ReportFilters filters={filters} /><ProfitReport period={p} /></>
        ) : tab === "stock" ? (
          <StockReport period={p} periodIssue={issue?.message ?? null} branches={branches} allBranches={allBranches} filters={filters} />
        ) : tab === "ledger" ? (
          <LedgerReport period={p} filters={filters} />
        ) : tab === "trial" ? (
          <><ReportFilters filters={filters} /><TrialReport period={p} /></>
        ) : tab === "parties" ? (
          <PartyReport filters={filters} />
        ) : (
          <><ReportFilters filters={filters} /><CashReport period={p} /></>
        )}
      </TabPanels>
    </div>
  );
}

// ── زیرساخت مشترک بخش گزارش ──────────────────────────────────────────

/**
 * پرس‌وجوی یک بخش گزارش: لغو با ترک صفحه، فقط آخرین پاسخ، تلاش دوباره.
 *
 * سه حالتی که اگر یکی‌شان جا بیفتد، جدول خالی «داده نیست» و «خطا خورد»
 * را یکی نشان می‌دهد — و کاربر گزارش غلط را باور می‌کند.
 */
function useReport<T>(key: readonly unknown[], load: (signal: AbortSignal) => Promise<T[]>, enabled = true) {
  const [version, setVersion] = useState(0);
  const id = JSON.stringify(key);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- هویت پرس‌وجو همان `key` صریح است
  const run = useCallback(load, [id]);
  const q = useLatestQuery({ key: id, version, load: run, enabled });
  return {
    rows: q.data,
    error: q.error === null ? null : loadError(q.error),
    loading: q.loading,
    retry: () => setVersion(v => v + 1),
  };
}
type ReportQuery<T> = ReturnType<typeof useReport<T>>;

/**
 * یک بخش گزارش روی یک سطح مات: سرعنوان، توضیح، خروجی CSV و بدنه.
 *
 * گزارش خالی دکمهٔ دانلود نمی‌گیرد: فایلی با فقط سرستون، کاربر را به این
 * فکر می‌اندازد که دانلود خراب بوده.
 */
function ReportSection<T>({ title, description, query, csv, empty, children, level = 2 }: {
  title: string;
  description?: ReactNode;
  query: ReportQuery<T>;
  csv?: string;
  empty: string;
  children: (rows: T[]) => ReactNode;
  level?: 2 | 3;
}) {
  const id = useId();
  const rows = query.rows;
  const ready = rows !== null && rows.length > 0;
  return <Solid as="section" className="report-section" aria-labelledby={id}>
    <SectionHeader id={id} title={title} level={level} {...(description ? { description } : {})}
      {...(csv && ready ? { actions: <CsvLink href={csv} title={title} /> } : {})} />
    {query.error ? <ReportError error={query.error} onRetry={query.retry} />
      : query.loading || rows === null ? <Skeleton variant="row" lines={4} label={`در حال بارگذاری ${title}…`} />
      : rows.length === 0 ? <ResultState title={empty} />
      : children(rows)}
  </Solid>;
}

/**
 * ۴۰۳ «بی‌مجوز» است نه خرابی: پیام سرور (نام دسترسی لازم) بدون تلاش دوباره.
 * بقیه خطا با شناسهٔ پیگیری و «تلاش دوباره» که فقط دوباره می‌خواند.
 */
function ReportError({ error, onRetry }: { error: LoadError; onRetry: () => void }) {
  if (error.status === 403) return <ResultState kind="denied" title={error.message} description="این گزارش برای نقش شما باز نیست. اگر لازمش دارید، از مدیر بخواهید." />;
  return <ResultState kind="error" title={error.message} reference={error.reference} actionLabel="تلاش دوباره" onAction={onRetry} />;
}

/**
 * دکمه دانلود CSV.
 *
 * یک `<a download>` ساده، نه `fetch` و `Blob`: سرور
 * `Content-Disposition: attachment` می‌فرستد و مرورگر خودش ذخیره
 * می‌کند — بدون اینکه هزاران سطر اول در حافظه بنشیند. نشانی همان
 * Endpoint و همان فیلترهای جلوی چشم است، پس فایل چیزی بیش از صفحه نمی‌گوید.
 */
function CsvLink({ href, title }: { href: string; title: string }) {
  return <a className="btn btn--quiet csv-link" href={href} download title={`دانلود CSV — ${title}، با همین فیلترها`}>دانلود CSV</a>;
}

/** مبلغ ستون جدول: بی واحد (واحد در توضیح بخش است)، `null` = «—». */
function Cell({ rial }: { rial: string | null }) {
  return <Money rial={rial} unit={false} size="sm" />;
}

function JalaliDate({ iso }: { iso: string }) {
  return <span className="cell-nowrap" title={iso}>{formatJalali(iso)}</span>;
}

const TOMAN = "مبالغ به تومان.";

/** سطرهای بی‌شناسه (کاردکس، گردش حساب) کلید پایدارشان را از ترتیب سرور می‌گیرند. */
function indexed<T>(rows: readonly T[]): (T & { index: number })[] {
  return rows.map((r, index) => ({ ...r, index }));
}

// ── پنل مدیریتی ─────────────────────────────────────────────────────

/**
 * سه پرسشی که با جدول فروش جواب ندارند: کدام ساعت شلوغ است، نسبت به
 * ماه قبل بهتر شدیم یا بدتر، و ده قلمِ امروز را چند نفر بردند.
 *
 * ⚠️ این زبانه پشت `report.customer_insight` است و در Seed فقط مدیر
 * داردش. کاربری که ندارد ۴۰۳ می‌گیرد و حالت «بی‌مجوز» را با پیام سرور
 * می‌بیند — نه یک صفحه خالی که شبیه خرابی است.
 */
function ManagerPanel({ period }: { period: Period }) {
  const prev = previousPeriod({ from: period.from, to: period.to });
  return <>
    <CompareSection period={period} prev={prev} />
    <HourlyReport period={period} />
    <BasketReport period={period} />
    <CustomerBasketReport period={period} />
  </>;
}

/**
 * مقایسه با دوره مبنا.
 *
 * دوره مبنا **همان بازه، یک ماه جلالی عقب‌تر** است و در
 * `lib/jalali-period.ts` حساب می‌شود — نه در سرور، چون حساب ماه
 * میلادی با تقویمی که مالک می‌بیند نمی‌خواند.
 */
function CompareSection({ period, prev }: { period: Period; prev: { from: string; to: string } }) {
  const query = useReport<CompareRow>([period.from, period.to, period.branchId, prev.from, prev.to],
    async signal => (await reports.compare(period, prev, { signal })).rows);
  return <ReportSection title="فروش خالص در برابر دورهٔ مبنا" query={query}
    description={<>دورهٔ مبنا: {periodLabel(prev.from, prev.to) ?? `${prev.from} تا ${prev.to}`} — همان بازه، یک ماه جلالی عقب‌تر.</>}
    empty="در این بازه و دوره مبنا، فروشی ثبت نشده است.">
    {rows => <section className="kpis kpis--band" aria-label="مقایسهٔ کانال‌ها">
      {rows.map(r => <Kpi key={r.channel} label={`فروش خالص — ${channelLabel(r.channel)}`}
        value={<Money rial={r.netAmount} size="lg" />}
        note={<><Trend row={r} /> · دورهٔ مبنا: <Money rial={r.prevNetAmount} size="sm" /> · {formatCount(r.prevInvoiceCount)} فاکتور</>} />)}
    </section>}
  </ReportSection>;
}

/**
 * رشد یا افت: شکل + واژه + عدد؛ رنگ به‌تنهایی حامل معنا نیست.
 *
 * ⚠️ `deltaPercent === null` یعنی دوره مبنا صفر بوده. «—» نشان داده
 * می‌شود، نه «۰٪»: رشد از هیچ به فروش، صفر درصد نیست.
 */
function Trend({ row }: { row: CompareRow }) {
  const word = row.direction === "up" ? "رشد" : row.direction === "down" ? "افت" : "بدون تغییر";
  if (row.deltaPercent === null) return <span>{word}؛ دورهٔ مبنا صفر بود</span>;
  return <span className="nowrap">{word} <Percent value={Math.abs(row.deltaPercent)} trend={row.direction} /></span>;
}

/**
 * فروش به تفکیک ساعتِ کاری. ساعت از سرور می‌آید، نه از ساعت مرورگر.
 *
 * نمودار: جمع همان سطرها به‌ازای ساعت (همهٔ روزها و کانال‌ها) با `bigint`؛
 * ساعت‌های زودتر سمت راست (قرارداد نمودار زمانی RTL). جدول زیرش همهٔ
 * سطرهای سرور را بی‌کم‌وکاست دارد.
 */
function HourlyReport({ period }: { period: Period }) {
  const query = useReport<HourlyRow>([period.from, period.to, period.branchId],
    async signal => (await reports.hourly(period, { signal })).rows);
  return <ReportSection title="فروش به تفکیک ساعت" query={query} description={`${TOMAN} ساعت‌های زودتر سمت راست نمودار.`}
    csv={periodCsvUrl("/reports/hourly", period)} empty="در این بازه فروشی ثبت نشده است.">
    {rows => {
      const totals = new Map<number, bigint>();
      let max = 0n;
      for (const r of rows) {
        const v = parseRial(r.netAmount);
        totals.set(r.hourOfDay, (totals.get(r.hourOfDay) ?? 0n) + v);
        if (v > max) max = v;
      }
      const bars: Bar[] = [...totals.keys()].sort((a, b) => a - b).map(h => {
        const value = totals.get(h) ?? 0n;
        return { key: String(h), label: formatHour(h), value, display: `${formatMoney(value)} تومان` };
      });
      const peak = bars.reduce<Bar | null>((m, b) => (!m || b.value > m.value ? b : m), null);
      const columns: Column<HourlyRow>[] = [
        { key: "date", header: "تاریخ", cell: r => <JalaliDate iso={r.businessDate} /> },
        { key: "hour", header: "ساعت", cell: r => <bdi className="num">{`${String(r.hourOfDay).padStart(2, "0")}:00`}</bdi> },
        { key: "channel", header: "کانال", cell: r => channelLabel(r.channel) },
        { key: "invoices", header: "فاکتور", numeric: true, cell: r => formatCount(r.invoiceCount) },
        { key: "qty", header: "قلم", numeric: true, cell: r => <Qty value={r.itemQty} /> },
        { key: "net", header: "فروش خالص", numeric: true, cell: r => <Cell rial={r.netAmount} /> },
        { key: "ratio", header: "نسبت به بیشینه", cell: r => <span className="hbar" aria-hidden="true"
          style={{ width: max === 0n ? "0%" : `${Number((parseRial(r.netAmount) * 100n) / max)}%` }} /> },
      ];
      return <>
        <BarChart title="فروش خالص هر ساعت در کل بازه (تومان)" labelHeader="ساعت" valueHeader="فروش خالص" bars={bars}
          summary={peak && peak.value > 0n ? `بیشترین فروش: ساعت ${peak.label} با ${peak.display}` : "در این بازه فروش مثبتی نیست."} />
        <DataTable caption="فروش به تفکیک ساعت" columns={columns} rows={rows} bounded
          rowKey={r => `${r.businessDate}-${r.hourOfDay}-${r.channel}`} />
      </>;
    }}
  </ReportSection>;
}

/** «ده قلم را یک نفر برد یا ده نفر؟» */
function BasketReport({ period }: { period: Period }) {
  const query = useReport<BasketRow>([period.from, period.to, period.branchId],
    async signal => (await reports.basket(period, { signal })).rows);
  const columns: Column<BasketRow>[] = [
    { key: "date", header: "تاریخ", cell: r => <JalaliDate iso={r.businessDate} /> },
    { key: "channel", header: "کانال", cell: r => channelLabel(r.channel) },
    { key: "invoices", header: "فاکتور", numeric: true, cell: r => formatCount(r.invoiceCount) },
    { key: "known", header: "مشتری شناخته", numeric: true, cell: r => formatCount(r.knownCustomers) },
    { key: "anon", header: "بی‌شماره", numeric: true, cell: r => formatCount(r.anonymousCount) },
    { key: "qty", header: "قلم", numeric: true, cell: r => <Qty value={r.itemQty} /> },
    { key: "per", header: "میانگین قلم", numeric: true, cell: r => <Qty value={r.qtyPerInvoice} /> },
    { key: "net", header: "فروش خالص", numeric: true, cell: r => <Cell rial={r.netAmount} /> },
  ];
  return <ReportSection title="تحلیل سبد" query={query} csv={periodCsvUrl("/reports/basket", period)}
    description={`فاکتور بی‌شماره جدا شمرده می‌شود — نه «یک مشتری» فرض. ${TOMAN}`} empty="در این بازه فروشی ثبت نشده است.">
    {rows => <DataTable caption="تحلیل سبد" columns={columns} rows={rows} bounded rowKey={r => `${r.businessDate}-${r.channel}`} />}
  </ReportSection>;
}

/** همان پرسش، در سطح شخص. */
function CustomerBasketReport({ period }: { period: Period }) {
  const query = useReport<CustomerBasketRow>([period.from, period.to, period.branchId],
    async signal => (await reports.customerBasket(period, { signal })).rows);
  const columns: Column<CustomerBasketRow>[] = [
    { key: "name", header: "نام", cell: r => r.fullName ?? "—" },
    { key: "mobile", header: "موبایل", cell: r => (r.mobile ? <Ltr>{r.mobile}</Ltr> : "—") },
    { key: "invoices", header: "فاکتور", numeric: true, cell: r => formatCount(r.invoiceCount) },
    { key: "qty", header: "قلم", numeric: true, cell: r => <Qty value={r.itemQty} /> },
    { key: "net", header: "مبلغ خرید", numeric: true, cell: r => <Cell rial={r.netAmount} /> },
    { key: "last", header: "آخرین خرید", cell: r => <JalaliDate iso={r.lastPurchase} /> },
  ];
  return <ReportSection title="خرید هر مشتری" query={query} csv={periodCsvUrl("/reports/customer-basket", period)}
    description={`پنجاه مشتری نخست. ${TOMAN}`} empty="در این بازه هیچ خریدی به نام مشتری ثبت نشده است.">
    {rows => <DataTable caption="خرید هر مشتری" columns={columns} rows={rows} stack rowKey={r => r.customerId} />}
  </ReportSection>;
}

// ── فروش دوره‌ای ─────────────────────────────────────────────────────

function SalesReport({ period }: { period: Period }) {
  const query = useReport<SalesRow>([period.from, period.to, period.branchId],
    async signal => (await reports.sales(period, { signal })).rows);
  const columns: Column<SalesRow>[] = [
    { key: "date", header: "تاریخ", cell: r => <JalaliDate iso={r.businessDate} /> },
    { key: "channel", header: "کانال", cell: r => channelLabel(r.channel) },
    { key: "invoices", header: "فاکتور", numeric: true, cell: r => formatCount(r.invoiceCount) },
    { key: "gross", header: "ناخالص", numeric: true, cell: r => <Cell rial={r.grossAmount} /> },
    { key: "discount", header: "تخفیف", numeric: true, cell: r => <Cell rial={r.discountAmount} /> },
    { key: "net", header: "خالص", numeric: true, cell: r => <Cell rial={r.netAmount} /> },
    { key: "returns", header: "مرجوعی", numeric: true, cell: r => r.returnCount === 0
      ? <Money rial="0" unit={false} size="sm" />
      : <><Cell rial={r.returnAmount} /> <span className="cell-sub">{formatCount(r.returnCount)} برگ</span></> },
    { key: "cogs", header: "بهای تمام‌شده", numeric: true, cell: r => <Cell rial={r.cogsAmount} /> },
    { key: "profit", header: "سود", numeric: true, cell: r => <Cell rial={r.profitAmount} /> },
  ];
  return <ReportSection title="فروش به تفکیک روز و کانال" query={query} csv={periodCsvUrl("/reports/sales", period)}
    description={`${TOMAN} «—» در بها و سود یعنی دسترسی بهای تمام‌شده ندارید، نه صفر.`} empty="در این بازه فروشی ثبت نشده است.">
    {rows => {
      const net = sumRial(rows.map(r => r.netAmount));
      const ret = sumRial(rows.map(r => r.returnAmount));
      const profit = sumRial(rows.map(r => r.profitAmount));
      return <DataTable caption="فروش به تفکیک روز و کانال" columns={columns} rows={rows} stack bounded
        rowKey={r => `${r.businessDate}-${r.channel}`}
        foot={{ label: "جمع بازه", cells: { net: <Cell rial={net === null ? null : net.toString()} />, returns: <Cell rial={ret === null ? null : ret.toString()} />, profit: <Cell rial={profit === null ? null : profit.toString()} /> } }} />;
    }}
  </ReportSection>;
}

// ── سود کالا ─────────────────────────────────────────────────────────

function ProfitReport({ period }: { period: Period }) {
  const query = useReport<ProfitRow>([period.from, period.to, period.branchId],
    async signal => (await reports.profitByProduct(period, { signal })).rows);
  const columns: Column<ProfitRow>[] = [
    { key: "product", header: "کالا", cell: r => <>{r.productName}<span className="cell-sub">{r.color} · {r.size}</span></> },
    { key: "sku", header: "SKU", cell: r => <Ltr>{r.sku}</Ltr> },
    { key: "sold", header: "فروخته", numeric: true, cell: r => <Qty value={r.qtySold} /> },
    { key: "returned", header: "برگشتی", numeric: true, cell: r => <Qty value={r.qtyReturned} /> },
    { key: "net", header: "فروش خالص", numeric: true, cell: r => <Cell rial={r.netAmount} /> },
    { key: "cogs", header: "بها", numeric: true, cell: r => <Cell rial={r.cogsAmount} /> },
    { key: "profit", header: "سود", numeric: true, cell: r => <Cell rial={r.profitAmount} /> },
    { key: "margin", header: "حاشیه", numeric: true, cell: r => <Percent value={r.marginPercent} /> },
  ];
  return <ReportSection title="سود به تفکیک کالا" query={query} csv={periodCsvUrl("/reports/profit-by-product", period)}
    description={`پنجاه کالای نخست. ${TOMAN} حاشیهٔ «—» یعنی فروش خالص صفر شده و درصد بی‌معناست.`}
    empty="در این بازه کالایی فروخته نشده — یا دسترسی بهای تمام‌شده ندارید.">
    {rows => <DataTable caption="سود به تفکیک کالا" columns={columns} rows={rows} stack bounded rowKey={r => r.variationId} />}
  </ReportSection>;
}

// ── موجودی و کاردکس ──────────────────────────────────────────────────

function StockReport({ period, periodIssue, branches, allBranches, filters }: {
  period: Period; periodIssue: string | null; branches: Branch[]; allBranches: boolean; filters: PeriodFilters;
}) {
  const warehouses: Warehouse[] = branches.flatMap(b => b.warehouses);
  const fallback = allBranches ? "" : (warehouses[0]?.id ?? "");
  const [warehouseRaw, setWarehouse] = useUrlState("reports.warehouse");
  // انباری که در نشانی مانده ولی در دامنهٔ این کاربر نیست، پذیرفته نمی‌شود.
  const warehouseId = warehouses.some(w => w.id === warehouseRaw) ? warehouseRaw : fallback;
  const [picked, setPicked] = useState<ValuationRow | null>(null);

  const query = useReport<ValuationRow>([warehouseId, allBranches], async signal => {
    if (!allBranches && warehouseId === "") return [];
    return (await reports.valuation(warehouseId === "" ? undefined : warehouseId, { signal })).rows;
  });

  const columns: Column<ValuationRow>[] = [
    { key: "warehouse", header: "انبار", cell: r => r.warehouseName },
    { key: "product", header: "کالا", cell: r => <>{r.productName}<span className="cell-sub">{r.color} · {r.size}</span></> },
    { key: "sku", header: "SKU", cell: r => <Ltr>{r.sku}</Ltr> },
    { key: "onHand", header: "موجودی فیزیکی", numeric: true, cell: r => <Qty value={r.onHand} /> },
    { key: "reserved", header: "رزروشده", numeric: true, cell: r => <Qty value={r.reserved} /> },
    { key: "available", header: "قابل‌فروش", numeric: true, cell: r => <Qty value={r.available} /> },
    { key: "unitCost", header: "بهای واحد", numeric: true, cell: r => <Cell rial={r.unitCost} /> },
    { key: "value", header: "ارزش", numeric: true, cell: r => <Cell rial={r.totalValue} /> },
  ];

  const extra = warehouses.length > 0 ? <Field label="انبار">
    <select value={warehouseId} onChange={e => { setWarehouse(e.target.value === fallback ? "" : e.target.value); setPicked(null); }}>
      {allBranches ? <option value="">همه انبارها</option> : null}
      {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select>
  </Field> : null;

  return <>
    <ReportFilters filters={filters} extra={extra} />
    <ReportSection title="موجودی و ارزش دفتری" query={query} empty="موجودی‌ای برای نمایش نیست — یا دسترسی بهای تمام‌شده ندارید."
      description={`${TOMAN} رزرو سفارش، موجودی قابل‌فروش را کم می‌کند؛ خروج فیزیکی و اثر مالی هنگام ثبت قطعی فروش انجام می‌شود. موجودی انبار معیوب، در راه یا غیرفعال قابل‌فروش نیست. «کاردکس» گردش همان کالا را در بازهٔ انتخابی زیر همین جدول باز می‌کند.`}
      csv={csvUrl("/reports/inventory-valuation", warehouseId === "" ? "" : `warehouseId=${encodeURIComponent(warehouseId)}`)}>
      {rows => {
        const totalValue = rows.reduce((a, r) => a + parseRial(r.totalValue), 0n);
        return <DataTable caption="موجودی و ارزش دفتری" columns={columns} rows={rows} stack bounded
          rowKey={r => `${r.warehouseId}-${r.variationId}`}
          rowActions={r => {
            const open = picked?.variationId === r.variationId && picked.warehouseId === r.warehouseId;
            return <Button variant="quiet" aria-expanded={open} onClick={() => setPicked(open ? null : r)}>
              {open ? "بستن کاردکس" : "کاردکس"}<span className="sr-only"> {r.productName} {r.color} {r.size}</span>
            </Button>;
          }}
          foot={{ label: "جمع ارزش", cells: { value: <Cell rial={totalValue.toString()} /> } }} />;
      }}
    </ReportSection>
    {picked === null ? null : periodIssue !== null
      // کاردکس انتخاب‌شده می‌ماند و پس از اصلاح بازه خوانده می‌شود؛ تاریخ نیمه‌تایپ به سرور نمی‌رود.
      ? <Solid className="pad"><ResultState title={`کاردکس — ${picked.productName} · ${picked.color} ${picked.size}: بازهٔ تاریخ کامل نیست.`} description={periodIssue} /></Solid>
      : <Kardex period={period} variationId={picked.variationId}
        title={`${picked.productName} · ${picked.color} ${picked.size}`}
        {...(warehouseId === "" ? {} : { warehouseId })} />}
  </>;
}

function Kardex({ period, variationId, warehouseId, title }: {
  period: Period; variationId: string; warehouseId?: string | undefined; title: string;
}) {
  const query = useReport<MovementRow>([period.from, period.to, variationId, warehouseId],
    async signal => (await reports.movements(period, variationId, warehouseId, { signal })).rows);
  const columns: Column<MovementRow & { index: number }>[] = [
    { key: "at", header: "زمان", cell: r => <span className="cell-nowrap">{formatJalaliMoment(r.occurredAt)}</span> },
    { key: "warehouse", header: "انبار", cell: r => r.warehouseName },
    { key: "kind", header: "نوع", cell: r => MOVEMENT_KIND[r.kind] ?? "حرکت دیگر" },
    { key: "qty", header: "تعداد", numeric: true, cell: r => <Qty value={r.qty} /> },
    { key: "running", header: "مانده", numeric: true, cell: r => <Qty value={r.runningQty} /> },
    { key: "unitCost", header: "بهای واحد", numeric: true, cell: r => <Cell rial={r.unitCost} /> },
    { key: "delta", header: "تغییر ارزش", numeric: true, cell: r => <Cell rial={r.valueDelta} /> },
  ];
  return <ReportSection title={`کاردکس — ${title}`} level={3} query={query} description={TOMAN}
    csv={periodCsvUrl("/reports/stock-movements", period, { variationId, warehouseId })}
    empty="در این بازه حرکتی برای این کالا ثبت نشده است.">
    {rows => <DataTable caption={`کاردکس — ${title}`} columns={columns} rows={indexed(rows)} bounded rowKey={r => String(r.index)} />}
  </ReportSection>;
}

// ── دفتر حساب ────────────────────────────────────────────────────────

function LedgerReport({ period, filters }: { period: Period; filters: PeriodFilters }) {
  const [applied, setApplied] = useUrlState("reports.account");
  const [code, setCode] = useState(applied);
  useEffect(() => setCode(applied), [applied]);
  const query = useReport<LedgerRow>([period.from, period.to, period.branchId, applied],
    async signal => (await reports.accountLedger(period, applied, { signal })).rows, applied !== "");
  const columns: Column<LedgerRow & { index: number }>[] = [
    { key: "date", header: "تاریخ", cell: r => <JalaliDate iso={r.entryDate} /> },
    { key: "entry", header: "سند", cell: r => <Ltr>{r.entryNumber}</Ltr> },
    { key: "desc", header: "شرح", cell: r => r.description ?? "—" },
    { key: "party", header: "طرف حساب", cell: r => r.partyName ?? "—" },
    { key: "debit", header: "بدهکار", numeric: true, cell: r => <Cell rial={r.debit} /> },
    { key: "credit", header: "بستانکار", numeric: true, cell: r => <Cell rial={r.credit} /> },
    { key: "running", header: "مانده", numeric: true, cell: r => <Cell rial={r.running} /> },
  ];
  function submit(e: FormEvent) {
    e.preventDefault();
    setApplied(code.trim());
  }
  return <>
    <ReportFilters filters={filters} extra={<form className="filter-inline" onSubmit={submit} aria-label="انتخاب حساب">
      <Field label="کد حساب" hint="از «تنظیمات ← کدینگ حساب»؛ فقط سند تأییدشده و نهایی.">
        <input type="text" inputMode="numeric" className="num" value={code} placeholder="1301"
          onChange={e => setCode(normalizeDigits(e.target.value))} />
      </Field>
      <Button variant="primary" type="submit" disabled={code.trim() === ""}>نمایش</Button>
    </form>} />
    {applied === "" ? <Solid className="pad"><ResultState title="کد حساب را وارد کنید تا گردش آن در این بازه نمایش داده شود." /></Solid>
      : <ReportSection title={`گردش حساب ${applied}`} query={query} description={TOMAN}
          csv={periodCsvUrl("/reports/account-ledger", period, { code: applied })} empty="این حساب در این بازه گردشی نداشته است.">
          {rows => <DataTable caption={`گردش حساب ${applied}`} columns={columns} rows={indexed(rows)} bounded rowKey={r => String(r.index)} />}
        </ReportSection>}
  </>;
}

// ── تراز آزمایشی ─────────────────────────────────────────────────────

function TrialReport({ period }: { period: Period }) {
  const query = useReport<TrialRow>([period.from, period.to, period.branchId],
    async signal => (await reports.trialBalance(period, { signal })).rows);
  const columns: Column<TrialRow>[] = [
    { key: "code", header: "کد", cell: r => <Ltr>{r.code}</Ltr> },
    { key: "name", header: "نام حساب", cell: r => r.name },
    { key: "opening", header: "مانده اول دوره", numeric: true, cell: r => <Cell rial={r.openingBalance} /> },
    { key: "debit", header: "بدهکار", numeric: true, cell: r => <Cell rial={r.debit} /> },
    { key: "credit", header: "بستانکار", numeric: true, cell: r => <Cell rial={r.credit} /> },
    { key: "closing", header: "مانده پایان", numeric: true, cell: r => <Cell rial={r.closingBalance} /> },
  ];
  return <ReportSection title="تراز آزمایشی بازه" query={query} csv={periodCsvUrl("/reports/trial-balance", period)}
    description={TOMAN} empty="در این بازه سندی ثبت نشده است.">
    {rows => {
      const dr = rows.reduce((a, r) => a + parseRial(r.debit), 0n);
      const cr = rows.reduce((a, r) => a + parseRial(r.credit), 0n);
      // جمع دو ستون باید برابر باشد. اگر روزی نبود، یعنی سندی نامتوازن به دفتر
      // رفته — یک خطای مالی، نه نمایشی. پس صریح و با `alert` گفته می‌شود.
      return <DataTable caption="تراز آزمایشی بازه" columns={columns} rows={rows} bounded rowKey={r => r.code}
        foot={{ label: "جمع", cells: {
          debit: <Cell rial={dr.toString()} />, credit: <Cell rial={cr.toString()} />,
          closing: dr === cr
            ? <StatusBadge state="completed" label="متوازن" />
            : <span role="alert"><StatusBadge state="attention" label="نامتوازن" /></span>,
        } }} />;
    }}
  </ReportSection>;
}

// ── دریافتنی و پرداختنی ──────────────────────────────────────────────

function PartyReport({ filters }: { filters: PeriodFilters }) {
  const [kindRaw, setKind] = useUrlState("reports.partyType");
  const kind = kindRaw in PARTY_LABEL ? kindRaw : "";
  const query = useReport<PartyRow>([kind], async signal => (await reports.partyBalances(kind === "" ? undefined : kind, { signal })).rows);
  const columns: Column<PartyRow>[] = [
    { key: "code", header: "کد تفصیلی", cell: r => <Ltr>{r.code}</Ltr> },
    { key: "name", header: "نام", cell: r => r.partyName ?? "بی‌نام" },
    { key: "type", header: "نوع", cell: r => PARTY_LABEL[r.partyType] ?? "شخص دیگر" },
    { key: "parent", header: "سرفصل", cell: r => r.parentName },
    { key: "debit", header: "بدهکار", numeric: true, cell: r => <Cell rial={r.debit} /> },
    { key: "credit", header: "بستانکار", numeric: true, cell: r => <Cell rial={r.credit} /> },
    { key: "balance", header: "مانده", numeric: true, cell: r => <Cell rial={r.balance} /> },
  ];
  return <>
    <ReportFilters filters={filters} extra={<Field label="نوع شخص">
      <select value={kind} onChange={e => setKind(e.target.value)}>
        <option value="">همه</option>
        <option value="customer">مشتری</option>
        <option value="supplier">تأمین‌کننده</option>
      </select>
    </Field>} />
    <ReportSection title="مانده اشخاص" query={query} empty="مانده‌ای برای نمایش نیست."
      description={`مانده از تفصیلی سند ساخته می‌شود، نه از یک جدول موازی؛ مانده صفر نمی‌آید. ${TOMAN}`}
      csv={csvUrl("/reports/party-balances", kind === "" ? "" : `partyType=${encodeURIComponent(kind)}`)}>
      {rows => <DataTable caption="مانده اشخاص" columns={columns} rows={rows} stack bounded rowKey={r => `${r.partyType}-${r.partyId}`} />}
    </ReportSection>
  </>;
}

// ── مغایرت‌گیری نقد ──────────────────────────────────────────────────

function CashReport({ period }: { period: Period }) {
  const query = useReport<ShiftRow>([period.from, period.to, period.branchId],
    async signal => (await reports.cashReconciliation(period, { signal })).rows);
  const columns: Column<ShiftRow>[] = [
    { key: "shift", header: "شیفت", cell: r => <span className="cell-nowrap">{formatJalaliMoment(r.openedAt)}</span> },
    { key: "user", header: "صندوق‌دار", cell: r => r.userName },
    { key: "opening", header: "اول", numeric: true, cell: r => <Cell rial={r.openingCash} /> },
    { key: "sales", header: "فروش نقدی", numeric: true, cell: r => <Cell rial={r.cashSales} /> },
    { key: "refunds", header: "بازپرداخت", numeric: true, cell: r => <Cell rial={r.cashRefunds} /> },
    { key: "in", header: "ورودی", numeric: true, cell: r => <Cell rial={r.cashIn} /> },
    { key: "out", header: "خروجی", numeric: true, cell: r => <Cell rial={r.cashOut} /> },
    { key: "expected", header: "انتظار", numeric: true, cell: r => <Cell rial={r.expectedCash} /> },
    { key: "counted", header: "شمرده", numeric: true, cell: r => <Cell rial={r.countedCash} /> },
    // مغایرت صفر یک خبر خوب است و باید دیده شود؛ ناصفر یک هشدار با مبلغ علامت‌دار.
    // شیفت باز هنوز شمرده نشده: «شیفت باز»، نه صفر.
    { key: "variance", header: "مغایرت", cell: r => r.variance === null
      ? <StatusBadge state="active" label="شیفت باز" />
      : parseRial(r.variance) === 0n
        ? <StatusBadge state="completed" label="بدون مغایرت" />
        : <span className="nowrap"><StatusBadge state="attention" label="مغایرت" /> <Cell rial={r.variance} /></span> },
  ];
  return <ReportSection title="شمارش کشو در برابر انتظار" query={query} csv={periodCsvUrl("/reports/cash-reconciliation", period)}
    description={TOMAN} empty="در این بازه شیفتی باز نشده است.">
    {rows => <DataTable caption="شمارش کشو در برابر انتظار" columns={columns} rows={rows} stack bounded rowKey={r => r.shiftId} />}
  </ReportSection>;
}
