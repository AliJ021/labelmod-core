/**
 * ردیف شاخص‌های «مشتریان» (طرح ۱۰): طلب از مشتریان و اعتبار مشتریان نزد ما، از سند
 * ثبت‌شده — همان اعداد «کارهای عملیاتی» داشبورد. بی `report.view` ردیف نمی‌آید (نه صفر).
 */
import { useBranchOperations } from "../lib/use-branch-operations.ts";
import { formatCount } from "../lib/format.ts";
import { Kpi } from "./ui/Kpi.tsx";
import { Money } from "./ui/Money.tsx";

export function CustomersSummaryRow() {
  const data = useBranchOperations();
  if (!data || data.ops.receivables.state !== "ready") return null;
  const r = data.ops.receivables;
  return <section className="kpis kpi-cards customers-summary" aria-label="طلب و اعتبار مشتریان">
    <Kpi variant="card" label="طلب از مشتریان" value={<Money rial={BigInt(r.owed.amount)} size="lg" />}
      note={`${formatCount(r.owed.count)} مشتری · از سند ثبت‌شده · ${data.branch.name}`} />
    <Kpi variant="card" label="اعتبار مشتریان نزد ما" value={<Money rial={BigInt(r.credit.amount)} size="lg" />}
      note={`${formatCount(r.credit.count)} مشتری · بدهی ما؛ با طلب جمع نمی‌شود`} />
  </section>;
}
