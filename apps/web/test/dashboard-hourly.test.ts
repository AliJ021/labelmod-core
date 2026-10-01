/**
 * روند ساعتی سه شاخص داشبورد (مهاجرت ۰۸۳) — منطق خالص نمایش.
 *
 * ثابت مالی (Σ ساعت‌ها = کارت) در `db/test/daily-summary-hourly.sql` و آزمون API
 * سنجیده می‌شود؛ اینجا فقط اینکه نمایش هیچ مبلغی را نمی‌سازد، نمی‌اندازد یا
 * علامتش را عوض نمی‌کند، و «نامعلوم» / «خالی» / «صفر» از هم جدا می‌مانند.
 * رفتار مرورگر (زبانه، کیبورد، درخواست) در `e2e/dashboard-kpi.spec.ts` است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hourAxis, hourlyView, METRIC_COPY, METRICS } from "../src/lib/dashboard-hourly.ts";
import type { DailyHour } from "../src/lib/pos.ts";

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

describe("روند ساعتی داشبورد", () => {
  test("محور مشترک: ۸ تا ۲۲ به‌علاوهٔ ساعت فعال بیرون از آن — برای هر سه شاخص یکی", () => {
    assert.deepEqual(hourAxis(day()), Array.from({ length: 15 }, (_, i) => i + 8));
    assert.deepEqual(hourAxis(STORE), Array.from({ length: 16 }, (_, i) => i + 8), "ساعت ۲۳ افزوده شد");
    const early = day({ 6: { paymentCount: 1, receivedAmount: "5000" } });
    assert.equal(hourAxis(early)[0], 6, "پرداخت ساعت ۶ هم محور را باز می‌کند");
    const axes = METRICS.map(m => { const v = hourlyView(STORE, m.key); return v.kind === "chart" ? v.bars.map(b => b.key) : []; });
    assert.deepEqual(axes[0], axes[1]); assert.deepEqual(axes[1], axes[2]);
  });

  test("هیچ مبلغی نمی‌افتد: جمع ستون‌ها همان جمع ۲۴ ساعت است (bigint، بی تلورانس)", () => {
    const sum = (k: "salesAmount" | "receivedAmount" | "profitAmount") => STORE.reduce((t, h) => t + BigInt(h[k] as string), 0n);
    for (const [metric, key] of [["sales", "salesAmount"], ["received", "receivedAmount"], ["profit", "profitAmount"]] as const) {
      const v = hourlyView(STORE, metric);
      assert.equal(v.kind, "chart");
      if (v.kind === "chart") assert.equal(total(v.bars), sum(key), metric);
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
    const at = (h: string) => profit.bars.find(b => b.key === h)!;
    assert.equal(at("14").value, -300_000n);
    assert.equal(at("16").value, -600_000n);
    assert.equal(at("16").display, "−60٬000 تومان", "نمایش جدول صفحه‌خوان علامت دارد");
    assert.match(profit.summary, /بیشترین سود: ساعت ۹ با 120٬000 تومان/);
    assert.match(profit.summary, /کمترین: ساعت ۱۶ با −60٬000 تومان/);
    const sales = hourlyView(STORE, "sales");
    if (sales.kind === "chart") assert.equal(sales.bars.find(b => b.key === "16")!.value, -1_000_000n, "مرجوعی در ساعت خودش کم شد");
  });

  test("سود null «نامعلوم» است؛ هرگز نمودار صفر نمی‌سازد", () => {
    const hidden = day({ 9: { salesAmount: "2000000", invoiceCount: 1 } }, false);
    assert.deepEqual(hourlyView(hidden, "profit"), { kind: "unknown" });
    assert.equal(hourlyView(hidden, "sales").kind, "chart", "فروش مستقل از بها می‌ماند");
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
    const v = hourlyView(netZero, "received");
    assert.equal(v.kind, "chart");
    if (v.kind === "chart") assert.equal(total(v.bars), 0n);
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
    assert.doesNotMatch(dash, /reports\.hourly\(/, "روند قدیمی (بی مرجوعی) دیگر منبع داشبورد نیست");
    assert.doesNotMatch(dash, /useUrlState|useUrlTab/, "انتخاب زبانه محلی است، نه در نشانی");
  });
});
