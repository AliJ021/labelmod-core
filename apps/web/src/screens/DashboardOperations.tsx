/**
 * کارهای عملیاتی داشبورد (دستهٔ D، مصوب مالک) — شیفت، چک، دریافتنی و کمبود موجودیِ همین شعبه، فقط‌خواندنی.
 *
 * - هر بخش با مجوز خودش از سرور می‌آید؛ بخش `denied` اصلاً رندر نمی‌شود (نه صفر). اگر هیچ بخشی دیده نشود،
 *   کل کارت پنهان است. داشبورد فقط با allow صریح `report.view` رندرش می‌کند؛ بخش چک را سرور با
 *   `cheque.manage` خودش می‌دهد.
 * - خلاصه آرام است: فقط سررسیدگذشته و شیفتِ ماندهٔ دیروز یا مغایرت‌دار «رسیدگی» می‌گیرند؛ بقیه اطلاع‌اند.
 *   جزئیات با پیوند به همان صفحهٔ موجود، فقط وقتی آن مقصد برای این نقش باز است.
 * - به‌روزرسانی داشبورد همین بخش را در زنجیرهٔ خودش می‌خواند (`register`)، با همان قاعدهٔ نسل و تازگی.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { formatCount, formatJalali, formatJalaliMoment, formatQty } from "../lib/format.ts";
import {
  chequesNeedAttention, dashboardOperations, DRILL, lowStockLink,
  type ChequeCell, type ChequesReady, type DashboardOperations as Data, type LowStockReady, type LowStockUnknown,
  type ReceivablesReady, type ShiftsReady,
} from "../lib/dashboard-operations.ts";
import { Solid } from "../components/Glass.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusIcon } from "../components/ui/Status.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { ResultState } from "../components/ResultState.tsx";
import type { PeriodReload } from "./DashboardPeriod.tsx";

type Load = { state: "loading" } | { state: "ready"; data: Data } | { state: "error"; message: string; reference: string | null };

export function DashboardOperations({ branchId, links, register }: {
  branchId: string;
  /** کدام مقصدِ جزئیات برای این نقش باز است (از دسترسی ناوبری). */
  links: { reports: boolean; treasury: boolean };
  register?: (reload: PeriodReload | null) => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const titleId = useId();
  const branch = useRef(branchId);
  branch.current = branchId;
  const gen = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  /** همان الگوی «مرور دوره»: هر خواندن قبلی را لغو می‌کند؛ شکستِ به‌روزرسانی ارقام قبلی را نگه می‌دارد و رد می‌شود. */
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
      const data = await dashboardOperations.read(branch.current, { signal: controller.signal });
      if (current()) setLoad({ state: "ready", data });
    } catch (err) {
      if (!current()) return;
      setLoad(prev => keep && prev.state === "ready" ? prev : err instanceof ApiError
        ? { state: "error", message: err.message, reference: err.correlationId }
        : { state: "error", message: "ارتباط با سرور برقرار نشد.", reference: null });
      if (keep) throw err;
    } finally {
      outer?.removeEventListener("abort", stop);
      if (inflight.current === controller) inflight.current = null;
    }
  }, []);

  useEffect(() => {
    void read(false);
  }, [branchId, read]);
  // Unmount: خواندنِ در راه لغو و هر پاسخ دیررس بی‌اثر.
  useEffect(() => () => { gen.current++; inflight.current?.abort(); }, []);

  useEffect(() => {
    register?.(signal => read(true, signal));
    return () => register?.(null);
  }, [register, read]);

  if (load.state === "ready") {
    const d = load.data;
    if (d.shifts.state === "denied" && d.cheques.state === "denied" && d.receivables.state === "denied"
      && d.lowStock.state === "denied") return null;
  }

  return <Solid as="section" className="pad ops" aria-labelledby={titleId}>
    <SectionHeader id={titleId} title="کارهای عملیاتی" description="شیفت، چک، دریافتنی و کمبود موجودیِ همین شعبه؛ فقط خواندنی." />
    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={3} label="در حال خواندن کارهای عملیاتی…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="کارهای عملیاتی خوانده نشد" reference={load.reference}
            description={`${load.message} این به معنای «کاری نیست» نیست.`} />
        : <div className="ops-grid">
            {load.data.shifts.state === "ready" ? <Shifts data={load.data.shifts} link={links.reports ? DRILL.shifts : null} /> : null}
            {load.data.cheques.state === "ready" ? <Cheques data={load.data.cheques} link={links.treasury ? DRILL.cheques : null} /> : null}
            {load.data.receivables.state === "ready" ? <Receivables data={load.data.receivables} link={links.reports ? DRILL.receivables : null} /> : null}
            {load.data.lowStock.state !== "denied" ? <LowStock data={load.data.lowStock} link={links.reports ? lowStockLink(branchId) : null} /> : null}
          </div>}
  </Solid>;
}

function Tile({ title, verdict, link, linkLabel, children }: {
  title: string; verdict?: { state: Parameters<typeof StatusIcon>[0]["state"]; label: string } | undefined;
  link: string | null; linkLabel: string; children: React.ReactNode;
}) {
  const id = useId();
  return <section className="ops-tile" aria-labelledby={id}>
    <h3 className="section-title ops-subtitle" id={id}>{title}</h3>
    {verdict ? <p className="ops-verdict" role="status"><StatusIcon state={verdict.state} /><span>{verdict.label}</span></p> : null}
    {children}
    {link ? <a className="link ops-link" href={link}>{linkLabel}</a> : null}
  </section>;
}

function Shifts({ data, link }: { data: ShiftsReady; link: string | null }) {
  const verdict = data.carriedOverCount > 0
    ? { state: "attention" as const, label: `${formatCount(data.carriedOverCount)} شیفت از روز کاری قبل باز مانده است` }
    : data.varianceToday > 0
      ? { state: "warning" as const, label: `${formatCount(data.varianceToday)} شیفت بسته‌شدهٔ امروز مغایرت نقد دارد` }
      : data.openCount > 0
        ? { state: "active" as const, label: `${formatCount(data.openCount)} شیفت باز` }
        : { state: "pending" as const, label: "شیفت بازی نیست" };
  return <Tile title="شیفت صندوق" verdict={verdict} link={link} linkLabel="مغایرت‌گیری نقد">
    {data.open.length > 0
      ? <ul className="ops-list">
          {data.open.map(s => <li key={s.id}>
            <span>{s.userName}</span>
            <span className="muted small nowrap">از {formatJalaliMoment(s.openedAt)}</span>
            {s.carriedOver ? <span className="ops-flag">از روز قبل</span> : null}
          </li>)}
        </ul>
      : null}
    {data.openCount > data.open.length
      ? <p className="muted small">نمونهٔ {formatCount(data.open.length)} از {formatCount(data.openCount)} شیفت باز</p>
      : null}
    <p className="muted small ops-meta">بسته‌شدهٔ امروز: {formatCount(data.closedToday)} · با مغایرت: {formatCount(data.varianceToday)}</p>
  </Tile>;
}

function ChequeRow({ label, cell }: { label: string; cell: ChequeCell }) {
  return <div className="ops-row">
    <dt>{label}</dt>
    <dd>{cell.count === 0
      ? <span className="muted">نیست</span>
      : <><span className="num">{formatCount(cell.count)}</span> چک · <Money rial={cell.amount} exact size="sm" />
          {cell.nextDue ? <span className="muted small nowrap"> · نزدیک‌ترین {formatJalali(cell.nextDue)}</span> : null}</>}</dd>
  </div>;
}

function Cheques({ data, link }: { data: ChequesReady; link: string | null }) {
  const soon = data.received.dueSoon.count + data.issued.dueSoon.count;
  const verdict = chequesNeedAttention(data)
    ? { state: "attention" as const, label: "چک سررسیدگذشته‌ای در دست است" }
    : soon > 0
      ? { state: "warning" as const, label: "چک نزدیک به سررسید" }
      : { state: "completed" as const, label: "چک سررسیدگذشته یا نزدیکی نیست" };
  const days = data.warningDays === null ? "" : ` (تا ${formatCount(data.warningDays)} روز)`;
  return <Tile title="سررسید چک" verdict={verdict} link={link} linkLabel="سررسیدهای چک">
    <dl className="ops-dl">
      <ChequeRow label="دریافتی — سررسیدگذشته" cell={data.received.overdue} />
      <ChequeRow label={`دریافتی — نزدیک${days}`} cell={data.received.dueSoon} />
      <ChequeRow label="پرداختی — سررسیدگذشته" cell={data.issued.overdue} />
      <ChequeRow label={`پرداختی — نزدیک${days}`} cell={data.issued.dueSoon} />
    </dl>
  </Tile>;
}

function Receivables({ data, link }: { data: ReceivablesReady; link: string | null }) {
  return <Tile title="ماندهٔ مشتریان" link={link} linkLabel="دریافتنی و پرداختنی">
    <dl className="ops-dl">
      <div className="ops-row">
        <dt>طلب از مشتریان</dt>
        <dd><Money rial={data.owed.amount} exact size="sm" /> <span className="muted small">· {formatCount(data.owed.count)} مشتری</span></dd>
      </div>
      <div className="ops-row">
        <dt>اعتبار مشتریان (بدهی ما)</dt>
        <dd><Money rial={data.credit.amount} exact size="sm" /> <span className="muted small">· {formatCount(data.credit.count)} مشتری</span></dd>
      </div>
    </dl>
    <p className="muted small">ماندهٔ خالص هر مشتری در این شعبه از سند ثبت‌شده؛ چکِ وصول‌نشده هنوز جزو طلب است. این سن طلب یا سررسید نیست.</p>
  </Tile>;
}

/** کمبود موجودی: شمار دقیق، تفکیک انبار فروش، و همان فهرست با پیوند. آستانهٔ نامعلوم «نامعلوم» است، نه صفر. */
function LowStock({ data, link }: { data: LowStockReady | LowStockUnknown; link: string | null }) {
  if (data.state === "unknown") {
    return <Tile title="کمبود موجودی" verdict={{ state: "unknown", label: "شمار کمبود معلوم نیست" }} link={null} linkLabel="">
      <p className="muted small">{data.reason} این به معنای «کمبودی نیست» نیست.</p>
    </Tile>;
  }
  const threshold = formatQty(data.threshold);
  const verdict = data.total > 0
    ? { state: "warning" as const, label: `${formatCount(data.total)} مورد به آستانهٔ ${threshold} یا کمتر رسیده` }
    : { state: "completed" as const, label: `موردی به آستانهٔ ${threshold} نرسیده` };
  return <Tile title="کمبود موجودی" verdict={verdict} link={data.total > 0 ? link : null} linkLabel="فهرست کمبود موجودی">
    {data.warehouses.length > 0
      ? <dl className="ops-dl">
          {data.warehouses.map(w => <div className="ops-row" key={w.id}>
            <dt>{w.name}</dt>
            <dd><span className="num">{formatCount(w.count)}</span> مورد</dd>
          </div>)}
        </dl>
      : <p className="muted small">این شعبه انبار فروش فعالی ندارد.</p>}
    <p className="muted small">هر مورد یک تنوع در یک انبار فروش است: قابل‌فروش (موجودی منهای رزرو) به آستانه یا کمتر، ناموجود هم. تنوعی که هرگز به آن انبار نیامده شمرده نمی‌شود. آستانه در تنظیمات انبار عوض می‌شود.</p>
  </Tile>;
}
