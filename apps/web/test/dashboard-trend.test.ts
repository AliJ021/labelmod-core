/**
 * روند سه شاخص داشبورد — ساعتی (مهاجرت ۰۸۳)، روزانه و ماهانه (۰۹۳) — منطق خالص نمایش.
 *
 * ثابت مالی (Σ ساعت‌ها = کارت، سطل = Σ خلاصهٔ روزها) در `db/test/daily-summary-*.sql`
 * و آزمون API سنجیده می‌شود؛ اینجا فقط اینکه نمایش هیچ مبلغی را نمی‌سازد، نمی‌اندازد
 * یا علامتش را عوض نمی‌کند، «نامعلوم» / «خالی» / «صفر» / «هنوز نیامده» از هم جدا
 * می‌مانند، و مرزهای ماه جلالی درست‌اند.
 * رفتار مرورگر (زبانه، کیبورد، درخواست) در `e2e/dashboard-kpi.spec.ts` است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addDays, bucketPoints, hourAxis, hourPoints, METRIC_COPY, METRICS, trendBounds, trendCopy, trendView,
  type Metric, type TrendPoint,
} from "../src/lib/dashboard-trend.ts";
import { toJalali } from "../src/lib/jalali-period.ts";
import type { DailyBucket, DailyHour } from "../src/lib/pos.ts";

/** همان سطح قرارداد قبلی: نمای ساعتیِ روز کامل‌شده. */
const hourlyView = (hours: DailyHour[], metric: Metric, currentHour: number | null = null) =>
  trendView(hourPoints(hours, currentHour), metric, "hour");
/** ستون‌های شاخص انتخاب‌شده، به‌شکل قرارداد پیشین (کلید ساعت، مقدار، نمایش). */
const barsOf = (hours: DailyHour[], metric: Metric) => {
  const points = hourPoints(hours, null);
  const v = trendView(points, metric, "hour");
  if (v.kind !== "chart") return [];
  const s = v.series.find(x => x.metric === metric)!;
  return points.map((p, i) => ({ key: p.key, value: s.values[i]!, display: s.displays[i]! }));
};

const day = (over: Record<number, Partial<DailyHour>> = {}, profitVisible = true): DailyHour[] =>
  Array.from({ length: 24 }, (_, hour) => ({
    hour, salesAmount: "0", receivedAmount: "0", profitAmount: profitVisible ? "0" : null,
    invoiceCount: 0, returnCount: 0, paymentCount: 0, ...over[hour],
  }));

// همان سناریوی آزمون SQL: فروش ۹ و ۱۱ و ۱۴ (زیر بها)، مرجوعی ۱۶، آخرین دقیقه ۲۳.
const STORE = day({
  9: { salesAmount: "2000000", receivedAmount: "2000000", profitAmount: "1200000", invoiceCount: 1, paymentCount: 1 },
  11: { salesAmount: "1000000", profitAmount: "600000", invoiceCount: 1 },
  14: { salesAmount: "900000", receivedAmount: "900000", profitAmount: "-300000", invoiceCount: 1, paymentCount: 1 },
  16: { salesAmount: "-1000000", receivedAmount: "-1000000", profitAmount: "-600000", returnCount: 1, paymentCount: 1 },
  23: { salesAmount: "1000000", receivedAmount: "1000000", profitAmount: "600000", invoiceCount: 1, paymentCount: 1 },
});

const total = (bars: { value: bigint }[]) => bars.reduce((t, b) => t + b.value, 0n);
const isChart = (v: ReturnType<typeof trendView>) => v.kind === "chart";

describe("روند ساعتی داشبورد", () => {
  test("محور مشترک: ۸ تا ۲۲ به‌علاوهٔ ساعت فعال بیرون از آن — برای هر سه شاخص یکی", () => {
    assert.deepEqual(hourAxis(day()), Array.from({ length: 15 }, (_, i) => i + 8));
    assert.deepEqual(hourAxis(STORE), Array.from({ length: 16 }, (_, i) => i + 8), "ساعت ۲۳ افزوده شد");
    const early = day({ 6: { paymentCount: 1, receivedAmount: "5000" } });
    assert.equal(hourAxis(early)[0], 6, "پرداخت ساعت ۶ هم محور را باز می‌کند");
    const axes = METRICS.map(m => barsOf(STORE, m.key).map(b => b.key));
    assert.deepEqual(axes[0], axes[1]); assert.deepEqual(axes[1], axes[2]);
  });

  test("هیچ مبلغی نمی‌افتد: جمع ستون‌ها همان جمع ۲۴ ساعت است (bigint، بی تلورانس)", () => {
    const sum = (k: "salesAmount" | "receivedAmount" | "profitAmount") => STORE.reduce((t, h) => t + BigInt(h[k] as string), 0n);
    for (const [metric, key] of [["sales", "salesAmount"], ["received", "receivedAmount"], ["profit", "profitAmount"]] as const) {
      assert.equal(hourlyView(STORE, metric).kind, "chart");
      assert.equal(total(barsOf(STORE, metric)), sum(key), metric);
    }
    // همان اعداد آزمون SQL: فروش ۳٬۹۰۰٬۰۰۰، دریافتی ۲٬۹۰۰٬۰۰۰، سود ۱٬۵۰۰٬۰۰۰ ریال.
    assert.equal(sum("salesAmount"), 3_900_000n);
    assert.equal(sum("receivedAmount"), 2_900_000n);
    assert.equal(sum("profitAmount"), 1_500_000n);
  });

  test("علامت منفی حفظ می‌شود — نه صفر، نه قدرمطلق — در ستون، نمایش و خلاصه", () => {
    const profit = hourlyView(STORE, "profit");
    assert.equal(profit.kind, "chart");
    if (profit.kind !== "chart") return;
    const at = (h: string) => barsOf(STORE, "profit").find(b => b.key === h)!;
    assert.equal(at("14").value, -300_000n);
    assert.equal(at("16").value, -600_000n);
    assert.equal(at("16").display, "−60٬000 تومان", "نمایش جدول صفحه‌خوان علامت دارد");
    assert.match(profit.summary, /بیشترین سود: ساعت ۹ با 120٬000 تومان/);
    assert.match(profit.summary, /کمترین: ساعت ۱۶ با −60٬000 تومان/);
    assert.equal(barsOf(STORE, "sales").find(b => b.key === "16")!.value, -1_000_000n, "مرجوعی در ساعت خودش کم شد");
  });

  test("سود null «نامعلوم» است؛ هرگز نمودار صفر نمی‌سازد", () => {
    const hidden = day({ 9: { salesAmount: "2000000", invoiceCount: 1 } }, false);
    assert.deepEqual(hourlyView(hidden, "profit"), { kind: "unknown" });
    assert.equal(hourlyView(hidden, "sales").kind, "chart", "فروش مستقل از بها می‌ماند");
    const sales = hourlyView(hidden, "sales");
    if (sales.kind === "chart") assert.deepEqual(sales.series.map(x => x.metric), ["sales"], "پیش‌فرض فقط شاخص انتخاب‌شده");
    const compared = trendView(hourPoints(hidden, null), "sales", "hour", true);
    assert.equal(compared.kind, "chart");
    if (compared.kind === "chart") assert.deepEqual(compared.series.map(x => x.metric), ["sales", "received"], "در مقایسه هم خط سود نامعلوم کشیده نمی‌شود");
    // حتی یک ساعتِ null کافی است: نیمه‌معلوم را کامل نشان نمی‌دهیم.
    const partial = day({ 9: { salesAmount: "1", invoiceCount: 1 }, 10: { profitAmount: null } });
    assert.deepEqual(hourlyView(partial, "profit"), { kind: "unknown" });
  });

  test("«خالی» یعنی نبود رویداد، نه جمع صفر", () => {
    assert.deepEqual(hourlyView(day(), "sales"), { kind: "empty" });
    assert.deepEqual(hourlyView(day(), "received"), { kind: "empty" });
    assert.deepEqual(hourlyView(day(), "profit"), { kind: "empty" });
    // فروش نسیه: فروش هست، وجهی نیامده — دریافتی «خالی» است، فروش نه.
    const credit = day({ 11: { salesAmount: "1000000", profitAmount: "600000", invoiceCount: 1 } });
    assert.equal(hourlyView(credit, "sales").kind, "chart");
    assert.deepEqual(hourlyView(credit, "received"), { kind: "empty" });
    // دریافت و بازپرداخت برابر: جمع صفر ولی رویداد هست — نمودار، نه «وجهی نیامده».
    const netZero = day({ 10: { receivedAmount: "500000", paymentCount: 1 }, 12: { receivedAmount: "-500000", paymentCount: 1 } });
    assert.ok(isChart(hourlyView(netZero, "received")));
    assert.equal(total(barsOf(netZero, "received")), 0n);
  });

  test("هر شاخص متن خودش را دارد؛ متن فروش زیر دیگری نمی‌ماند", () => {
    const titles = new Set(METRICS.map(m => METRIC_COPY[m.key].title));
    assert.equal(titles.size, 3);
    for (const m of ["received", "profit"] as const) {
      assert.doesNotMatch(METRIC_COPY[m].title + METRIC_COPY[m].chart + METRIC_COPY[m].empty.join(""), /فروش ساعتی|فروش هر ساعت|فروش خالص/);
    }
    assert.deepEqual(METRICS.map(m => m.label), ["فروش", "وجه دریافتی", "سود"]);
  });
});

describe("روند — هنوز نیامده، روزانه و ماهانه", () => {
  test("ساعتِ پس از ساعت جاری «هنوز نیامده» است، نه صفر؛ ساعت جاری ناقص", () => {
    const points = hourPoints(STORE, 14);
    const at = (h: number) => points.find(p => p.key === String(h))!;
    assert.equal(at(14).partial, true);
    assert.equal(at(14).pending, false);
    for (const h of [15, 16, 22, 23]) {
      assert.equal(at(h).pending, true, `${h}`);
      assert.deepEqual(at(h).values, { sales: null, received: null, profit: null }, "بی مقدار، نه 0n");
    }
    const v = trendView(points, "sales", "hour");
    assert.equal(v.kind, "chart");
    if (v.kind !== "chart") return;
    const sales = v.series.find(x => x.metric === "sales")!;
    assert.equal(sales.values[points.indexOf(at(16))], null);
    assert.equal(sales.displays[points.indexOf(at(16))], "هنوز نرسیده");
    assert.match(v.note ?? "", /ساعت ۱۴ هنوز تمام نشده/);
    assert.match(v.note ?? "", /۹ ساعت بعدی هنوز نرسیده/);
    // روز کامل‌شده: هیچ «هنوز نیامده».
    assert.equal(hourPoints(STORE, null).some(p => p.pending || p.partial), false);
  });

  test("مرزهای روزانه: ۳۰ سطل یک‌روزه تا امروز؛ آخرین مرز فرداست", () => {
    const b = trendBounds("day", "2026-03-01");
    assert.equal(b.length, 31);
    assert.equal(b[0], "2026-01-31");
    assert.equal(b[29], "2026-03-01");
    assert.equal(b[30], "2026-03-02");
    for (let i = 1; i < b.length; i++) assert.equal(addDays(b[i - 1]!, 1), b[i]);
  });

  test("مرزهای ماهانه: ۱۲ ماه جلالیِ کامل از روز اول، ماه جاری تا امروز (کبیسه و اسفند)", () => {
    // ۱۴۰۳ کبیسه است: ۳۰ اسفند ۱۴۰۳ = 2025-03-20؛ امروز ۵ فروردین ۱۴۰۴.
    const today = "2025-03-25";
    const b = trendBounds("month", today);
    assert.equal(b.length, 13);
    assert.equal(b[12], "2025-03-26", "آخرین مرز فرداست، نه پایان ماه");
    assert.deepEqual(toJalali(b[11]!), { year: 1404, month: 1, day: 1 });
    assert.deepEqual(toJalali(b[10]!), { year: 1403, month: 12, day: 1 });
    assert.equal(addDays(b[11]!, -1), "2025-03-20", "اسفند کبیسه ۳۰ روز است");
    for (let i = 0; i < 12; i++) {
      const j = toJalali(b[i]!);
      assert.equal(j.day, 1, `سطل ${i} از روز اول ماه`);
      if (i > 0) {
        const prev = toJalali(b[i - 1]!);
        assert.equal((prev.month % 12) + 1, j.month, "ماه‌ها پشت‌هم، بی جاافتادگی");
      }
    }
    assert.deepEqual(toJalali(b[0]!), { year: 1403, month: 2, day: 1 });
  });

  test("سطل‌ها: برچسب جلالی، نقطهٔ ناقص از سرور، صفرِ بی‌رویداد «خالی» است", () => {
    const bucket = (from: string, over: Partial<DailyBucket> = {}): DailyBucket => ({
      from, to: from, partial: false, salesAmount: "0", receivedAmount: "0", profitAmount: "0",
      invoiceCount: 0, returnCount: 0, paymentCount: 0, ...over,
    });
    const months = [bucket("2026-08-23"), bucket("2026-09-23", { to: "2026-10-11", partial: true, salesAmount: "5000000", profitAmount: "1000000", invoiceCount: 3 })];
    const points = bucketPoints(months, "month");
    assert.deepEqual(points.map(p => p.label), ["شهریور", "مهر"]);
    assert.deepEqual(points.map(p => p.long), ["شهریور ۱۴۰۵", "مهر ۱۴۰۵"]);
    assert.deepEqual(points.map(p => p.partial), [false, true]);
    const v = trendView(points, "sales", "month");
    assert.equal(v.kind, "chart");
    if (v.kind === "chart") {
      assert.match(v.summary, /بیشترین فروش: مهر ۱۴۰۵ با 500٬000 تومان/);
      assert.match(v.note ?? "", /این ماه هنوز تمام نشده/);
    }
    assert.deepEqual(trendView(points, "received", "month"), { kind: "empty" }, "وجهی نیامده — خالی، نه خط صفر");
    const days = bucketPoints([bucket("2026-09-21"), bucket("2026-09-22"), bucket("2026-09-23")], "day");
    assert.deepEqual(days.map(p => p.label), ["۳۰ شهریور", "۳۱", "۱ مهر"], "ماه در اولین نقطه و آغاز ماه");
    const hidden = bucketPoints([bucket("2026-09-21", { profitAmount: null, invoiceCount: 1, salesAmount: "1" })], "day");
    assert.deepEqual(trendView(hidden, "profit", "day"), { kind: "unknown" });
  });

  test("متن هر دانه‌بندی جداست و ساعتی همان متن پیشین است", () => {
    for (const m of METRICS) assert.deepEqual(trendCopy(m.key, "hour"), METRIC_COPY[m.key]);
    assert.equal(trendCopy("sales", "day").title, "روند فروش روزانه");
    assert.equal(trendCopy("received", "month").chart, "وجه دریافتی هر ماه (تومان)");
    assert.match(trendCopy("sales", "month").description, /۱۲ ماه شمسی اخیر/);
    assert.match(trendCopy("sales", "day").description, /۳۰ روز اخیر/);
    const titles = new Set((["hour", "day", "month"] as const).flatMap(g => METRICS.map(m => trendCopy(m.key, g).title)));
    assert.equal(titles.size, 9);
  });

  test("نمایش هیچ مبلغی جمع نمی‌زند: سری‌ها همان مقدار نقطه‌اند", () => {
    const pts: TrendPoint[] = hourPoints(STORE, null);
    const v = trendView(pts, "received", "hour");
    if (v.kind !== "chart") throw new Error("chart");
    for (const s of v.series) assert.deepEqual(s.values, pts.map(p => p.values[s.metric]));
  });
});

describe("زبانه‌های شاخص — ساختار", () => {
  const kpi = readFileSync(new URL("../src/components/ui/Kpi.tsx", import.meta.url), "utf8");
  const dash = readFileSync(new URL("../src/screens/Dashboard.tsx", import.meta.url), "utf8");
  test("زبانه روی button بومی با معنای کامل ARIA", () => {
    const tabs = kpi.slice(kpi.indexOf("export function KpiTabs"));
    assert.match(tabs, /role="tablist"/);
    assert.match(tabs, /<button key=\{item\.key\} type="button" role="tab"/);
    for (const attr of ["aria-selected", "aria-controls", "aria-labelledby", "aria-describedby", "aria-disabled", "tabIndex"]) assert.match(tabs, new RegExp(attr));
    assert.match(tabs, /rtl \? "ArrowLeft" : "ArrowRight"/, "پیکان‌ها با جهت محاسبه‌شده");
    assert.match(tabs, /if \(!item\.unavailable\) onChange/, "زبانهٔ در دسترس‌نبودن انتخاب نمی‌شود");
  });
  test("داشبورد یک پنل مشترک دارد و یک درخواست برای هر سه روند", () => {
    assert.match(dash, /role="tabpanel"/);
    assert.equal(dash.match(/pos\.dailyHourly\(/g)?.length, 1);
    assert.equal(dash.match(/pos\.dailyTrend\(/g)?.length, 1, "روزانه/ماهانه یک مسیر دارند");
    assert.match(dash, /trendBounds\(next, report\.businessDate\)/, "مرز از «امروز» سرور، نه ساعت مرورگر");
    assert.doesNotMatch(dash, /new Date\(/, "داشبورد ساعت مرورگر را نمی‌خواند");
    assert.doesNotMatch(dash, /reports\.hourly\(/, "روند قدیمی (بی مرجوعی) دیگر منبع داشبورد نیست");
    assert.doesNotMatch(dash, /useUrlState|useUrlTab/, "انتخاب زبانه محلی است، نه در نشانی");
    // زبانه‌های **بخش** (طرح ۱۰) مقصد ناوبری‌اند: تعریفشان در رجیستری و خواندنشان از نشانی بیرون از این فایل.
    assert.match(dash, /useDashboardTab\(access\)/);
  });
});
