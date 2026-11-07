/**
 * روند سه شاخص داشبورد — ساعتی، روزانه، ماهانه — منطق خالص، بی React
 * (test/dashboard-trend.test.ts).
 *
 * داده از دو مسیر است و **هیچ مبلغی اینجا ساخته یا جمع نمی‌شود**:
 *   ساعتی  `/reports/daily/hourly` (مهاجرت ۰۸۳): ۲۴ ساعت که جمعشان همان سه کارت است.
 *   روزانه/ماهانه `/reports/daily/trend` (مهاجرت ۰۹۳): سطل‌هایی که جمعشان در SQL
 *          حساب شده؛ مرز سطل‌ها را همین فایل از تقویم جلالی می‌سازد.
 * هر نقطه یک `bigint` از سرور است. سه قاعده:
 *
 * - «خالی» یعنی نبودِ **رویداد**، نه جمع صفر: روزی که دریافت و بازپرداختش
 *   برابر بوده «وجهی نیامده» نیست. فروش و سود با فاکتور و مرجوعی، وجه
 *   دریافتی با پرداخت.
 * - سودِ `null` (بی `cost.view`) «نامعلوم» است — نه صفر، نه خط.
 * - **آنچه هنوز نیامده صفر نیست:** ساعتِ پس از ساعت جاری خطی ندارد و نقطهٔ
 *   دورهٔ جاری (این ساعت، امروز، این ماه) «ناقص» علامت می‌خورد.
 *   علامت منفی (مرجوعی، فروش زیر بها، بازپرداخت) حفظ می‌شود.
 */
import type { DailyBucket, DailyComparison, DailyHour } from "./pos.ts";
import { parseRial } from "./money.ts";
import { formatCount, formatHour, formatJalali, formatMoney } from "./format.ts";
import { jalaliMonthRange } from "./jalali-period.ts";

export type Metric = "sales" | "received" | "profit";
/** `cumulative`: ساعتیِ «تا این لحظه» (پیش‌فرض، طرح ۱۰)؛ `hour`: فروش هر ساعت جدا (برای شیفت و شلوغی). */
export type Grain = "cumulative" | "hour" | "day" | "month";

export const METRICS: readonly { key: Metric; label: string }[] = [
  { key: "sales", label: "فروش" },
  { key: "received", label: "وجه دریافتی" },
  { key: "profit", label: "سود" },
];

export const GRAINS: readonly { key: Grain; label: string }[] = [
  { key: "cumulative", label: "تا این لحظه" },
  { key: "hour", label: "هر ساعت" },
  { key: "day", label: "روزانه" },
  { key: "month", label: "ماهانه" },
];

/** تعداد نقطه‌های روند روزانه و ماهانه — در متن‌ها هم همین عدد می‌آید. */
export const DAYS = 30;
export const MONTHS = 12;

interface Copy { title: string; description: string; chart: string; value: string; empty: [string, string]; peak: string }

/** عنوان، توضیح و متن‌های روند ساعتی هر شاخص — هیچ‌کدام متن شاخص دیگری را نشان نمی‌دهد. */
export const METRIC_COPY: Record<Metric, Copy> = {
  sales: {
    title: "روند فروش ساعتی",
    description: "فروش هر ساعت امروز، همهٔ کانال‌ها؛ مرجوعی در ساعت خودش کم شده · جمع ساعت‌ها = کارت «فروش»",
    chart: "فروش هر ساعت (تومان)",
    value: "فروش",
    empty: ["هنوز فروشی برای امروز ثبت نشده است.", "با اولین فاکتور نهایی، نمودار ساعتی اینجا ساخته می‌شود."],
    peak: "بیشترین فروش",
  },
  received: {
    title: "روند وجه دریافتی ساعتی",
    description: "پولی که هر ساعت واقعاً رسید؛ بازپرداخت منفی، نسیه و در انتظار بیرون · جمع ساعت‌ها = کارت «وجه دریافتی»",
    chart: "وجه دریافتی هر ساعت (تومان)",
    value: "وجه دریافتی",
    empty: ["هنوز وجهی برای امروز دریافت نشده است.", "با اولین پرداخت موفق، نمودار ساعتی اینجا ساخته می‌شود."],
    peak: "بیشترین دریافت",
  },
  profit: {
    title: "روند سود ساعتی",
    description: "سود هر ساعت پس از بهای تمام‌شده؛ مرجوعی کم و زیان منفی · جمع ساعت‌ها = کارت «سود»",
    chart: "سود هر ساعت (تومان)",
    value: "سود",
    empty: ["هنوز فروشی برای امروز ثبت نشده که سودی داشته باشد.", "با اولین فاکتور نهایی، نمودار ساعتی اینجا ساخته می‌شود."],
    peak: "بیشترین سود",
  },
};

const METRIC_NOTE: Record<Metric, string> = {
  sales: "همهٔ کانال‌ها با هم و مرجوعی در روز خودش کم شده.",
  received: "پولی که واقعاً رسید؛ بازپرداخت منفی است و نسیه و پرداخت در انتظار اینجا نیستند.",
  profit: "پس از بهای تمام‌شده؛ مرجوعی در روز خودش کم شده و زیان منفی است.",
};
const NOUN: Record<Metric, string> = { sales: "فروشی", received: "وجهی", profit: "فروشی که سودی داشته باشد" };

/** متن‌های هر (شاخص، دانه‌بندی). «هر ساعت» همان `METRIC_COPY` است. */
export function trendCopy(metric: Metric, grain: Grain): Copy {
  if (grain === "hour") return METRIC_COPY[metric];
  if (grain === "cumulative") {
    const base = METRIC_COPY[metric];
    const label = METRICS.find(m => m.key === metric)!.label;
    return {
      title: `روند ${label}`,
      description: `${label} تجمعی از آغاز امروز تا این لحظه، همهٔ کانال‌ها؛ ${metric === "received" ? "بازپرداخت کم شده" : "مرجوعی در ساعت خودش کم شده"} · آخرین نقطه = کارت «${label}»`,
      chart: `${label} تجمعی امروز (تومان)`,
      value: label,
      empty: base.empty,
      peak: base.peak,
    };
  }
  const base = METRIC_COPY[metric];
  const label = METRICS.find(m => m.key === metric)!.label;
  const day = grain === "day";
  const span = day ? `${formatCount(DAYS)} روز اخیر` : `${formatCount(MONTHS)} ماه شمسی اخیر`;
  return {
    title: `روند ${label} ${day ? "روزانه" : "ماهانه"}`,
    description: day
      ? `${span} تا امروز، به روز کاری تهران؛ هر نقطه همان خلاصهٔ آن روز است. ${METRIC_NOTE[metric]} روزهای زودتر سمت چپ و امروز سمت راست.`
      : `${span}؛ هر نقطه جمع خلاصهٔ روزهای همان ماه است که در دیتابیس حساب شده و ماه جاری تا امروز است. ${METRIC_NOTE[metric]}`,
    chart: `${label} هر ${day ? "روز" : "ماه"} (تومان)`,
    value: label,
    empty: [
      metric === "received" ? `در ${span} وجهی دریافت نشده است.` : `در ${span} ${NOUN[metric]} ثبت نشده است.`,
      day ? "با اولین فروش یا پرداخت، نمودار روزانه اینجا ساخته می‌شود." : "با اولین فروش یا پرداخت، نمودار ماهانه اینجا ساخته می‌شود.",
    ],
    peak: base.peak,
  };
}

/** یک نقطهٔ روند: یک ساعت، یک روز یا یک ماه. */
export interface TrendPoint {
  key: string;
  /** برچسب کوتاه محور: «۱۸»، «۲۴ شهریور»، «مهر». */
  label: string;
  /** برچسب کامل برای جدول و خلاصه: «ساعت ۱۸»، «۲۴ شهریور ۱۴۰۵»، «مهر ۱۴۰۵». */
  long: string;
  /** دورهٔ جاری که هنوز تمام نشده (این ساعت، امروز، این ماه). */
  partial: boolean;
  /** هنوز نیامده (ساعت پس از ساعت جاری) — مقدار ندارد، نه صفر. */
  pending: boolean;
  values: Record<Metric, bigint | null>;
  events: Record<Metric, boolean>;
  /** فقط در «تا این لحظه»: تجمعی روز قبل تا همین لحظه (از SQL)؛ پس از مرز `null`. */
  yesterday?: Record<Metric, bigint | null>;
}

/** ساعت‌های محور مشترک: ۸ تا ۲۲ و هر ساعتِ دارای فعالیت یا مبلغ غیرصفر. */
export function hourAxis(hours: readonly DailyHour[]): number[] {
  const active = hours.filter(h => h.invoiceCount > 0 || h.returnCount > 0 || h.paymentCount > 0
    || h.salesAmount !== "0" || h.receivedAmount !== "0" || (h.profitAmount !== null && h.profitAmount !== "0")).map(h => h.hour);
  const from = Math.min(8, ...active), to = Math.max(22, ...active);
  return hours.filter(h => h.hour >= from && h.hour <= to).map(h => h.hour);
}

/** ساعت‌های امروز. `currentHour` از سرور است؛ `null` یعنی روزِ کامل‌شده. */
export function hourPoints(hours: readonly DailyHour[], currentHour: number | null): TrendPoint[] {
  const axis = new Set(hourAxis(hours));
  return hours.filter(h => axis.has(h.hour)).map(h => {
    const pending = currentHour !== null && h.hour > currentHour;
    const sold = h.invoiceCount > 0 || h.returnCount > 0;
    return {
      key: String(h.hour), label: formatHour(h.hour), long: `ساعت ${formatHour(h.hour)}`,
      partial: currentHour !== null && h.hour === currentHour, pending,
      values: pending
        ? { sales: null, received: null, profit: null }
        : { sales: parseRial(h.salesAmount), received: parseRial(h.receivedAmount), profit: h.profitAmount === null ? null : parseRial(h.profitAmount) },
      events: { sales: sold, received: h.paymentCount > 0, profit: sold },
    };
  });
}

/**
 * «تا این لحظه»: همان ساعت‌های `hourPoints`، ولی مقدار هر ساعت **تجمعی SQL** است
 * (`hours[].cumulative`) و خط دیروز از `comparison` (روز قبل تا همین لحظه). هیچ جمعی
 * اینجا ساخته نمی‌شود؛ ساعت نیامدهٔ امروز و ساعت پس از مرز دیروز `null` می‌مانند.
 */
export function cumulativePoints(hours: readonly DailyHour[], currentHour: number | null, comparison: DailyComparison | null): TrendPoint[] {
  const byHour = new Map(hours.map(h => [h.hour, h]));
  const yHour = new Map((comparison?.hours ?? []).map(h => [h.hour, h.cumulative]));
  const money = (v: string | null | undefined) => (v === null || v === undefined ? null : parseRial(v));
  return hourPoints(hours, currentHour).map(p => {
    const h = byHour.get(Number(p.key))!;
    const y = yHour.get(Number(p.key)) ?? null;
    return {
      ...p,
      values: p.pending ? p.values
        : { sales: money(h.cumulative.sales), received: money(h.cumulative.received), profit: money(h.cumulative.profit) },
      ...(comparison ? { yesterday: y === null ? { sales: null, received: null, profit: null }
        : { sales: money(y.sales), received: money(y.received), profit: money(y.profit) } } : {}),
    };
  });
}

/** سطل‌های روند روزانه/ماهانه، به همان ترتیب سرور (قدیمی‌تر اول). */
export function bucketPoints(buckets: readonly DailyBucket[], grain: "day" | "month"): TrendPoint[] {
  return buckets.map((b, i) => {
    const [day = "", month = "", year = ""] = formatJalali(b.from).split(" ");
    const sold = b.invoiceCount > 0 || b.returnCount > 0;
    const label = grain === "month" ? month : i === 0 || day === "۱" ? `${day} ${month}` : day;
    return {
      key: b.from, label, long: grain === "month" ? `${month} ${year}` : formatJalali(b.from),
      partial: b.partial, pending: false,
      values: { sales: parseRial(b.salesAmount), received: parseRial(b.receivedAmount), profit: b.profitAmount === null ? null : parseRial(b.profitAmount) },
      events: { sales: sold, received: b.paymentCount > 0, profit: sold },
    };
  });
}

/** `YYYY-MM-DD` ± روز، بی منطقهٔ زمانی. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * مرزهای سطل‌ها برای `/reports/daily/trend`: n+۱ تاریخ صعودی که آخرینش فرداست.
 * `today` از سرور است (`businessDate`)، نه ساعت مرورگر.
 *   روزانه  ۳۰ روز تا امروز، یک سطل برای هر روز.
 *   ماهانه  ۱۲ ماه جلالی تا ماه جاری؛ ماه جاری تا امروز (نیمه‌کاره).
 */
export function trendBounds(grain: "day" | "month", today: string): string[] {
  if (grain === "day") return Array.from({ length: DAYS + 1 }, (_, i) => addDays(today, i - DAYS + 1));
  const starts: string[] = [];
  let from = jalaliMonthRange(today).from;
  for (let i = 0; i < MONTHS; i++) {
    starts.unshift(from);
    from = jalaliMonthRange(addDays(from, -1)).from;
  }
  return [...starts, addDays(today, 1)];
}

/** `kind: "yesterday"` = خط مقایسه با روز قبل تا همین لحظه (همان شاخص)، نه شاخص دیگر. */
export interface TrendSeries { metric: Metric; label: string; values: (bigint | null)[]; displays: string[]; kind?: "yesterday" }

export type TrendView =
  | { kind: "unknown" }
  | { kind: "empty" }
  | { kind: "chart"; series: TrendSeries[]; summary: string; note: string | null };

const display = (v: bigint | null) => (v === null ? "هنوز نرسیده" : `${formatMoney(v)} تومان`);

/**
 * نمای شاخص انتخاب‌شده. پیش‌فرض (بازطراحی مصوب مالک) **فقط همان شاخص** است؛ `compare`
 * صریح همهٔ شاخص‌های **معلوم** را با رنگ و الگوی خط متمایز کنار هم می‌گذارد (خط انتخاب‌شده
 * پررنگ‌تر). سود نامعلوم هیچ خطی ندارد. «خالی» و «نامعلوم» برای شاخص انتخاب‌شده سنجیده می‌شوند.
 */
export function trendView(points: readonly TrendPoint[], metric: Metric, grain: Grain, compare = false, yesterday = false): TrendView {
  const reached = points.filter(p => !p.pending);
  const known = (m: Metric) => reached.every(p => p.values[m] !== null);
  if (metric === "profit" && !known("profit")) return { kind: "unknown" };
  if (grain === "cumulative") return cumulativeView(points, reached, metric, yesterday);
  if (!reached.some(p => p.events[metric])) return { kind: "empty" };
  const series = METRICS.filter(m => known(m.key) && (compare || m.key === metric)).map(m => ({
    metric: m.key, label: m.label,
    values: points.map(p => p.values[m.key]),
    displays: points.map(p => display(p.values[m.key])),
  }));
  const copy = trendCopy(metric, grain);
  const own = reached.map(p => ({ p, v: p.values[metric]! }));
  const peak = own.reduce<typeof own[number] | null>((m, x) => (x.v > 0n && (!m || x.v > m.v) ? x : m), null);
  const low = own.reduce<typeof own[number] | null>((m, x) => (x.v < 0n && (!m || x.v < m.v) ? x : m), null);
  const parts = [
    peak ? `${copy.peak}: ${peak.p.long} با ${display(peak.v)}` : null,
    low ? `کمترین: ${low.p.long} با ${display(low.v)}` : null,
  ].filter((x): x is string => x !== null);
  const current = reached.find(p => p.partial);
  const pending = points.filter(p => p.pending).length;
  const notes = [
    current ? `${grain === "hour" ? current.long : grain === "day" ? "امروز" : "این ماه"} هنوز تمام نشده (نقطهٔ توخالی).` : null,
    pending > 0 ? `${formatCount(pending)} ساعت بعدی هنوز نرسیده و صفر نشان داده نمی‌شود.` : null,
  ].filter((x): x is string => x !== null);
  return {
    kind: "chart", series,
    summary: parts.length ? parts.join(" · ") : `همهٔ ${grain === "hour" ? "ساعت‌ها" : grain === "day" ? "روزها" : "ماه‌ها"} صفر`,
    note: notes.length ? notes.join(" ") : null,
  };
}

/**
 * نمای «تا این لحظه»: خط تجمعی شاخص انتخاب‌شده و، اگر خواسته و مجاز باشد، خط «دیروز تا همین
 * لحظه» از همان شاخص. سود دیروز بی مجوز خطی ندارد.
 *
 * تصمیم مالک (۲۰۲۶/۱۱/۰۷): پیش از اولین رویداد امروز، نمودار خالی نمی‌شود. خط امروز روی صفر
 * ساعت‌های رسیده می‌ماند (صفرِ سرور، واقعی است نه «نامعلوم») و پیام «هنوز … ثبت نشده» در یادداشت
 * می‌آید؛ خط دیروز مثل همیشه. ساعت‌های نرسیده همچنان `null`اند، نه صفر. فقط وقتی هیچ ساعتی
 * نرسیده (دادهٔ ساعتی نیامده) «خالی» است.
 */
function cumulativeView(points: readonly TrendPoint[], reached: readonly TrendPoint[], metric: Metric, yesterday: boolean): TrendView {
  const label = METRICS.find(m => m.key === metric)!.label;
  const yValues = points.map(p => p.yesterday?.[metric] ?? null);
  const showYesterday = yesterday && points.some(p => p.yesterday !== undefined) && yValues.some(v => v !== null);
  const today = reached.some(p => p.events[metric]);
  if (reached.length === 0 && !showYesterday) return { kind: "empty" };
  const series: TrendSeries[] = [{
    metric, label: `${label} امروز`,
    values: points.map(p => p.values[metric]),
    displays: points.map(p => display(p.values[metric])),
  }];
  if (showYesterday) series.push({ metric, kind: "yesterday", label: "دیروز تا همین لحظه", values: yValues, displays: yValues.map(display) });
  const last = [...reached].reverse().find(p => p.values[metric] !== null);
  const yLast = [...yValues].reverse().find(v => v !== null) ?? null;
  const parts = [
    last ? `تا این لحظه: ${display(last.values[metric])}` : null,
    showYesterday && yLast !== null ? `همین لحظهٔ دیروز: ${display(yLast)}` : null,
  ].filter((x): x is string => x !== null);
  const current = reached.find(p => p.partial);
  const pending = points.filter(p => p.pending).length;
  const notes = [
    today ? null : trendCopy(metric, "cumulative").empty[0],
    current ? `${current.long} هنوز تمام نشده (نقطهٔ توخالی).` : null,
    pending > 0 ? `${formatCount(pending)} ساعت بعدی هنوز نرسیده و صفر نشان داده نمی‌شود.` : null,
    showYesterday ? "خط دیروز فقط تا همان لحظهٔ دیروز است، نه کل دیروز." : null,
  ].filter((x): x is string => x !== null);
  return { kind: "chart", series, summary: parts.join(" · ") || "هنوز داده‌ای نیست", note: notes.length ? notes.join(" ") : null };
}
