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
import type { DailyBucket, DailyHour } from "./pos.ts";
import { parseRial } from "./money.ts";
import { formatCount, formatHour, formatJalali, formatMoney } from "./format.ts";
import { jalaliMonthRange } from "./jalali-period.ts";

export type Metric = "sales" | "received" | "profit";
export type Grain = "hour" | "day" | "month";

export const METRICS: readonly { key: Metric; label: string }[] = [
  { key: "sales", label: "فروش" },
  { key: "received", label: "وجه دریافتی" },
  { key: "profit", label: "سود" },
];

export const GRAINS: readonly { key: Grain; label: string }[] = [
  { key: "hour", label: "ساعتی" },
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
    description: "فروش هر ساعت امروز؛ همهٔ کانال‌ها با هم و مرجوعی در ساعت خودش کم شده. جمع ساعت‌ها همان کارت «فروش» است. ساعت‌های زودتر سمت راست.",
    chart: "فروش هر ساعت (تومان)",
    value: "فروش",
    empty: ["هنوز فروشی برای امروز ثبت نشده است.", "با اولین فاکتور نهایی، نمودار ساعتی اینجا ساخته می‌شود."],
    peak: "بیشترین فروش",
  },
  received: {
    title: "روند وجه دریافتی ساعتی",
    description: "پولی که هر ساعت واقعاً رسید؛ بازپرداخت منفی است و نسیه و پرداخت در انتظار اینجا نیستند. جمع ساعت‌ها همان کارت «وجه دریافتی» است.",
    chart: "وجه دریافتی هر ساعت (تومان)",
    value: "وجه دریافتی",
    empty: ["هنوز وجهی برای امروز دریافت نشده است.", "با اولین پرداخت موفق، نمودار ساعتی اینجا ساخته می‌شود."],
    peak: "بیشترین دریافت",
  },
  profit: {
    title: "روند سود ساعتی",
    description: "سود هر ساعت پس از بهای تمام‌شده؛ مرجوعی در ساعت خودش کم شده و زیان منفی است. جمع ساعت‌ها همان کارت «سود» است.",
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

/** متن‌های هر (شاخص، دانه‌بندی). ساعتی همان `METRIC_COPY` است. */
export function trendCopy(metric: Metric, grain: Grain): Copy {
  if (grain === "hour") return METRIC_COPY[metric];
  const base = METRIC_COPY[metric];
  const label = METRICS.find(m => m.key === metric)!.label;
  const day = grain === "day";
  const span = day ? `${formatCount(DAYS)} روز اخیر` : `${formatCount(MONTHS)} ماه شمسی اخیر`;
  return {
    title: `روند ${label} ${day ? "روزانه" : "ماهانه"}`,
    description: day
      ? `${span} تا امروز، به روز کاری تهران؛ هر نقطه همان خلاصهٔ آن روز است. ${METRIC_NOTE[metric]} روزهای زودتر سمت راست.`
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

export interface TrendSeries { metric: Metric; label: string; values: (bigint | null)[]; displays: string[] }

export type TrendView =
  | { kind: "unknown" }
  | { kind: "empty" }
  | { kind: "chart"; series: TrendSeries[]; summary: string; note: string | null };

const display = (v: bigint | null) => (v === null ? "هنوز نرسیده" : `${formatMoney(v)} تومان`);

/**
 * نمای شاخص انتخاب‌شده. نمودار همهٔ شاخص‌های **معلوم** را با هم می‌کشد (خط
 * انتخاب‌شده پررنگ‌تر)؛ سود نامعلوم هیچ خطی ندارد. «خالی» و «نامعلوم» برای
 * شاخص انتخاب‌شده سنجیده می‌شوند.
 */
export function trendView(points: readonly TrendPoint[], metric: Metric, grain: Grain): TrendView {
  const reached = points.filter(p => !p.pending);
  const known = (m: Metric) => reached.every(p => p.values[m] !== null);
  if (metric === "profit" && !known("profit")) return { kind: "unknown" };
  if (!reached.some(p => p.events[metric])) return { kind: "empty" };
  const series = METRICS.filter(m => known(m.key)).map(m => ({
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
