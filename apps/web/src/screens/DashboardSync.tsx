/**
 * همگام‌سازی سایت در داشبورد (دستهٔ C، مصوب مالک) — فقط‌خواندنی، فقط با allow صریح `settings.view`.
 *
 * دو جهت جدا، هر کدام با شمار دقیق هر حالت:
 * - **Core → سایت** (موجودی، قیمت، خرید حضوری) از صف Outbox همین سامانه: در صف، زمان‌بندی‌شده، در حال
 *   ارسال (اجارهٔ معتبر)، تلاش دوباره، اجارهٔ منقضی (Worker ایستاد — خرابی، نه تصمیم) و متوقف (تلاش‌ها
 *   تمام شد / رد قطعی). نمونهٔ پیام‌های مشکل‌دار با «N از کل» و بی متن خطا یا Payload.
 * - **سایت → Core** (سفارش، مرجوعی، رزرو) از تله‌متری امضاشدهٔ افزونه. خوانده نشد = «نامعلوم» با دلیل؛
 *   شمارِ گزارش‌نشده «—» است، نه صفر، و تا یکی نامعلوم است «سالم» گفته نمی‌شود.
 *
 * هیچ دکمهٔ ارسال دوباره‌ای اینجا نیست: پیام متوقف خودکار تکرار نمی‌شود و زنده‌کردنش تصمیم انسانی در
 * «سلامت سیستم» است. به‌روزرسانی داشبورد همین بخش را هم در زنجیرهٔ خودش می‌خواند (`register`).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import {
  coreRows, coreVerdict, formatAge, SAMPLE_STATE_LABEL, stockSync, topicLabel, wooRows, wooVerdict,
  type CoreToWoo, type StockSync, type SyncRow, type WooToCore,
} from "../lib/stock-sync.ts";
import { Solid } from "../components/Glass.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusIcon } from "../components/ui/Status.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import type { PeriodReload } from "./DashboardPeriod.tsx";

type Load =
  | { state: "loading" }
  | { state: "ready"; data: StockSync }
  | { state: "denied" }
  | { state: "error"; message: string; reference: string | null };

export function DashboardSync({ register }: { register?: (reload: PeriodReload | null) => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const titleId = useId();
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
      const data = await stockSync.read({ signal: controller.signal });
      if (current()) setLoad({ state: "ready", data });
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 403) {
        setLoad({ state: "denied" });
        return;
      }
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
  }, [read]);
  // Unmount: خواندنِ در راه لغو و هر پاسخ دیررس بی‌اثر.
  useEffect(() => () => { gen.current++; inflight.current?.abort(); }, []);

  useEffect(() => {
    register?.(signal => read(true, signal));
    return () => register?.(null);
  }, [register, read]);

  // ۴۰۳ سرور یعنی این نقش نمی‌بیند — بخش پنهان می‌شود، نه «سالم» و نه خطا.
  if (load.state === "denied") return null;

  return <Solid as="section" className="pad sync" aria-labelledby={titleId}>
    <SectionHeader id={titleId} title="همگام‌سازی سایت"
      description={load.state === "ready"
        ? <>دو جهت جدا؛ فقط خواندنی. وضعیت از <span className="nowrap">{formatJalaliMoment(load.data.checkedAt)}</span></>
        : "دو جهت جدا؛ فقط خواندنی."} />
    {load.state === "loading"
      ? <div aria-busy="true"><Skeleton variant="text" lines={3} label="در حال خواندن وضعیت همگام‌سازی…" /></div>
      : load.state === "error"
        ? <ResultState kind="error" title="وضعیت همگام‌سازی خوانده نشد" reference={load.reference}
            description={`${load.message} این به معنای «صف خالی» نیست.`} />
        : <div className="sync-grid">
            <CoreSide data={load.data.coreToWoo} />
            <WooSide data={load.data.wooToCore} />
          </div>}
  </Solid>;
}

const countColumns: Column<SyncRow>[] = [
  { key: "label", header: "وضعیت", cell: r => r.label },
  { key: "count", header: "شمار", numeric: true, cell: r => <Count row={r} /> },
  { key: "hint", header: "یعنی", cell: r => <span className="muted small">{r.hint}</span> },
];

function Count({ row }: { row: SyncRow }) {
  if (row.count === null) return <span className="sync-unknown" aria-label="نامعلوم" title="افزونه این شمار را گزارش نکرد">—</span>;
  return <span className={`num sync-count sync-count--${row.tone}`}>{formatCount(row.count)}</span>;
}

function Verdict({ state, label }: { state: Parameters<typeof StatusIcon>[0]["state"]; label: string }) {
  return <p className={`sync-verdict sync-verdict--${state}`} role="status"><StatusIcon state={state} /><span>{label}</span></p>;
}

function CoreSide({ data }: { data: CoreToWoo }) {
  const id = useId();
  const verdict = coreVerdict(data);
  type Item = CoreToWoo["sample"]["items"][number];
  const sampleColumns: Column<Item>[] = [
    { key: "topic", header: "موضوع", cell: r => topicLabel(r.topic) },
    { key: "state", header: "وضعیت", cell: r => SAMPLE_STATE_LABEL[r.state] },
    { key: "attempts", header: "تلاش", numeric: true, cell: r => <span className="num">{formatCount(r.attempts)}</span> },
    { key: "age", header: "سن", cell: r => formatAge(r.ageSeconds) },
    { key: "id", header: "شناسه", cell: r => <Ltr>{r.id}</Ltr> },
  ];
  return <section className="sync-side" aria-labelledby={id}>
    <h3 className="section-title sync-subtitle" id={id}>Core → سایت <span className="muted small">موجودی، قیمت، خرید حضوری</span></h3>
    <Verdict {...verdict} />
    <DataTable caption="صف ارسال به سایت به تفکیک وضعیت" columns={countColumns} rows={coreRows(data)} rowKey={r => r.key} density="compact" stack />
    <p className="sync-meta muted small">
      {data.oldestOpenSeconds === null ? "پیام بازی در صف نیست" : <>قدیمی‌ترین پیام باز: {formatAge(data.oldestOpenSeconds)}</>}
      {" · "}
      {data.lastSentAt === null ? "ارسال موفقی ثبت نشده" : <>آخرین ارسال موفق: <span className="nowrap">{formatJalaliMoment(data.lastSentAt)}</span></>}
      {" · "}خوراک دوره‌ای هر {formatCount(data.reconcileMinutes)} دقیقه
    </p>
    {data.sample.total > 0
      ? <>
          <h4 className="sync-sample-title">نمونهٔ {formatCount(data.sample.items.length)} از {formatCount(data.sample.total)} پیام مشکل‌دار</h4>
          <DataTable caption="نمونهٔ پیام‌های مشکل‌دار ارسال به سایت" columns={sampleColumns} rows={data.sample.items} rowKey={r => r.id} density="compact" stack />
          <p className="muted small">پیام متوقف خودکار دوباره فرستاده نمی‌شود؛ بررسی و ارسال دوباره فقط از «سلامت سیستم».</p>
        </>
      : null}
  </section>;
}

function WooSide({ data }: { data: WooToCore }) {
  const id = useId();
  const verdict = wooVerdict(data);
  return <section className="sync-side" aria-labelledby={id}>
    <h3 className="section-title sync-subtitle" id={id}>سایت → Core <span className="muted small">سفارش، مرجوعی، رزرو</span></h3>
    <Verdict {...verdict} />
    {data.state === "unknown"
      ? <p className="muted small">هیچ شماری نشان داده نمی‌شود؛ نبودِ گزارش به معنای «صف خالی» نیست.</p>
      : <>
          <DataTable caption="صف افزونه به سمت Core به تفکیک وضعیت" columns={countColumns} rows={wooRows(data.counts)} rowKey={r => r.key} density="compact" stack />
          <p className="muted small">«—» یعنی افزونه این شمار را گزارش نکرد، نه صفر. سطر ناموفق Action Scheduler شمار سطر است، نه شمار کار.</p>
        </>}
    <p className="sync-meta muted small">گزارش افزونه از <span className="nowrap">{formatJalaliMoment(data.fetchedAt)}</span> (حداکثر ۳۰ ثانیه کهنه)</p>
  </section>;
}
