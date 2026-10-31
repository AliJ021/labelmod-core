/**
 * ردیف شاخص‌های «کالا و قیمت» (طرح ۱۰). همهٔ اعداد از SQL‌اند (`/products/summary`).
 * «زیر آستانه» همان شمار کمبود موجودی داشبورد است (مهاجرت ۱۰۴)؛ آستانهٔ تعریف‌نشده
 * «نامعلوم» با دلیل است، نه صفر. ارزش بی `cost.view`
 * «—» با دلیل است، هرگز صفر. خطای خواندن ردیف را پنهان می‌کند و فهرست کالا کار می‌کند.
 */
import { useCallback } from "react";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { catalog } from "../lib/catalog.ts";
import { formatCount } from "../lib/format.ts";
import { Kpi } from "./ui/Kpi.tsx";
import { Money } from "./ui/Money.tsx";
import { useBranchOperations } from "../lib/use-branch-operations.ts";

export function CatalogSummaryRow() {
  const load = useCallback((signal: AbortSignal) => catalog.summary({ signal }), []);
  const q = useLatestQuery({ key: "catalog-summary", load });
  const ops = useBranchOperations();
  const low = ops?.ops.lowStock;
  if (q.error || !q.data) return null;
  const d = q.data;
  return <section className="solid kpis kpis--band catalog-summary" aria-label="خلاصهٔ کالا و قیمت">
    <Kpi label="کالای فعال" value={<span className="kpi-count">{formatCount(d.activeProducts)}</span>}
      note={`${formatCount(d.activeVariations)} تنوع فعال`} />
    <Kpi label="ارزش موجودی به بها" value={<Money rial={d.inventoryValue === null ? null : BigInt(d.inventoryValue)} size="lg" />}
      note={d.inventoryValue === null ? "دیدن بها دسترسی بهای تمام‌شده می‌خواهد" : "انبارهای شعبه‌های شما"} />
    {low && low.state !== "denied" ? <Kpi label="زیر آستانه"
      value={low.state === "ready" ? <span className="kpi-count">{formatCount(low.total)}</span> : <span className="kpi-unknown" aria-label="نامعلوم">—</span>}
      note={low.state === "ready" ? `ردیف تنوع و انبار · آستانه ${low.threshold}` : low.reason} /> : null}
    <Kpi label="ثبت یا تغییر قیمت" value={<span className="kpi-count">{formatCount(d.pricesLast30Days)}</span>}
      note="در ۳۰ روز گذشته" />
  </section>;
}
