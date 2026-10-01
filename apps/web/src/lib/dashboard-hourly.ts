/**
 * روند ساعتی سه شاخص داشبورد — منطق خالص، بی React (test/dashboard-hourly.test.ts).
 *
 * داده از `/reports/daily/hourly` است (مهاجرت ۰۸۳): ۲۴ ساعت که جمعشان دقیقاً
 * همان سه کارت است. اینجا **هیچ مبلغی ساخته یا جمع نمی‌شود** — فقط هر ساعت
 * به یک ستون نمودار تبدیل می‌شود و `bigint` می‌ماند. سه قاعده:
 *
 * - محور ساعت برای هر سه شاخص **یکی** است (۸ تا ۲۲، به‌علاوهٔ هر ساعتِ دارای
 *   فعالیت بیرون از آن)، تا جابه‌جایی زبانه نمودار را جابه‌جا نکند. ساعتِ
 *   پنهان‌شده همیشه صفر و بی‌فعالیت است، پس هیچ عددی از نمایش نمی‌افتد.
 * - «خالی» یعنی نبودِ **رویداد**، نه جمع صفر: روزی که دریافت و بازپرداختش
 *   برابر بوده «وجهی نیامده» نیست. فروش و سود با فاکتور و مرجوعی، وجه
 *   دریافتی با پرداخت.
 * - سودِ `null` (بی `cost.view`) «نامعلوم» است — نه صفر، نه ستون.
 *   علامت منفی (ساعت مرجوعی، فروش زیر بها، بازپرداخت) حفظ می‌شود.
 */
import type { DailyHour } from "./pos.ts";
import { parseRial } from "./money.ts";
import { formatHour, formatMoney } from "./format.ts";
import type { Bar } from "../components/ui/BarChart.tsx";

export type Metric = "sales" | "received" | "profit";

export const METRICS: readonly { key: Metric; label: string }[] = [
  { key: "sales", label: "فروش" },
  { key: "received", label: "وجه دریافتی" },
  { key: "profit", label: "سود" },
];

/** عنوان، توضیح و متن‌های هر شاخص — هیچ‌کدام متن شاخص دیگری را نشان نمی‌دهد. */
export const METRIC_COPY: Record<Metric, {
  title: string; description: string; chart: string; value: string; empty: [string, string]; peak: string;
}> = {
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

const FIELD: Record<Metric, "salesAmount" | "receivedAmount" | "profitAmount"> = {
  sales: "salesAmount", received: "receivedAmount", profit: "profitAmount",
};

export type HourlyView =
  | { kind: "unknown" }
  | { kind: "empty" }
  | { kind: "chart"; bars: Bar[]; summary: string };

/** ساعت‌های محور مشترک: ۸ تا ۲۲ و هر ساعتِ دارای فعالیت یا مبلغ غیرصفر. */
export function hourAxis(hours: readonly DailyHour[]): number[] {
  const active = hours.filter(h => h.invoiceCount > 0 || h.returnCount > 0 || h.paymentCount > 0
    || h.salesAmount !== "0" || h.receivedAmount !== "0" || (h.profitAmount !== null && h.profitAmount !== "0")).map(h => h.hour);
  const from = Math.min(8, ...active), to = Math.max(22, ...active);
  return hours.filter(h => h.hour >= from && h.hour <= to).map(h => h.hour);
}

export function hourlyView(hours: readonly DailyHour[], metric: Metric): HourlyView {
  if (metric === "profit" && hours.some(h => h.profitAmount === null)) return { kind: "unknown" };
  const events = metric === "received"
    ? hours.some(h => h.paymentCount > 0)
    : hours.some(h => h.invoiceCount > 0 || h.returnCount > 0);
  if (!events) return { kind: "empty" };
  const axis = new Set(hourAxis(hours));
  const copy = METRIC_COPY[metric];
  const bars: Bar[] = hours.filter(h => axis.has(h.hour)).map(h => {
    const value = parseRial(h[FIELD[metric]] as string);
    return { key: String(h.hour), label: formatHour(h.hour), value, display: `${formatMoney(value)} تومان` };
  });
  const peak = bars.reduce<Bar | null>((m, b) => (b.value > 0n && (!m || b.value > m.value) ? b : m), null);
  const low = bars.reduce<Bar | null>((m, b) => (b.value < 0n && (!m || b.value < m.value) ? b : m), null);
  const parts = [
    peak ? `${copy.peak}: ساعت ${peak.label} با ${peak.display}` : null,
    low ? `کمترین: ساعت ${low.label} با ${low.display}` : null,
  ].filter((p): p is string => p !== null);
  return { kind: "chart", bars, summary: parts.length ? parts.join(" · ") : "همهٔ ساعت‌ها صفر" };
}
