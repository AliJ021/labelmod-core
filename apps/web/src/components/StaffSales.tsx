import { useCallback, useId } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useUrlState } from "../lib/use-url-state.ts";
import { formatCount } from "../lib/format.ts";
import type { Period } from "../lib/reports.ts";
import { ResultState } from "./ResultState.tsx";
import { Solid } from "./Glass.tsx";
import { Field } from "./ui/Controls.tsx";
import { DataTable, type Column } from "./ui/DataTable.tsx";
import { Money } from "./ui/Money.tsx";
import { SectionHeader } from "./ui/PageHeader.tsx";
import { Skeleton } from "./ui/Skeleton.tsx";
import { ReportFilters, type PeriodFilters } from "./ReportFilters.tsx";

interface Row { userId: string | null; userName: string | null; invoiceCount: string; grossAmount: string; discountAmount: string; returnedAmount: string; netSalesAmount: string }

/**
 * فروش هر کاربر. مبنای انتساب (نهایی‌کننده یا ثبت‌کنندهٔ پیش‌نویس) در نشانی
 * می‌ماند؛ سرور همان را می‌سنجد و هیچ عددی اینجا ساخته نمی‌شود.
 */
export function StaffSales({ period, filters }: { period: Period; filters: PeriodFilters }) {
  const [basis, setBasis] = useUrlState("reports.staffBasis", "finalizer");
  const id = useId();
  const { from, to, branchId } = period;
  const load = useCallback((signal: AbortSignal) => {
    const params = new URLSearchParams({ from, to, basis });
    if (branchId) params.set("branchId", branchId);
    return api.get<{ rows: Row[] }>(`/reports/staff-sales?${params}`, { signal });
  }, [from, to, branchId, basis]);
  const q = useLatestQuery({ key: JSON.stringify([from, to, branchId, basis]), load });
  const columns: Column<Row>[] = [
    { key: "user", header: "کاربر", cell: r => r.userName ?? "نامعلوم" },
    { key: "count", header: "فاکتور قطعی", numeric: true, cell: r => formatCount(Number(r.invoiceCount)) },
    { key: "gross", header: "فروش ناخالص", numeric: true, cell: r => <Money rial={r.grossAmount} unit={false} size="sm" /> },
    { key: "discount", header: "تخفیف", numeric: true, cell: r => <Money rial={r.discountAmount} unit={false} size="sm" /> },
    { key: "returned", header: "مرجوعی", numeric: true, cell: r => <Money rial={r.returnedAmount} unit={false} size="sm" /> },
    { key: "net", header: "فروش خالص", numeric: true, cell: r => <Money rial={r.netSalesAmount} unit={false} size="sm" /> },
  ];
  return <>
    <ReportFilters filters={filters} extra={<Field label="مبنای انتساب">
      <select value={basis} onChange={e => setBasis(e.target.value)}>
        <option value="finalizer">نهایی‌کنندهٔ فاکتور</option>
        <option value="creator">ثبت‌کنندهٔ پیش‌نویس</option>
      </select>
    </Field>} />
    <Solid as="section" className="report-section" aria-labelledby={id}>
      <SectionHeader id={id} title="فروش کاربران"
        description="پیش‌نویس‌ها فروش نیستند. مرجوعیِ ثبت‌شده در این بازه به فروشندهٔ فاکتور اصلی نسبت داده می‌شود؛ مبلغ‌ها بدون مالیات و کرایه و به تومان‌اند. سوابق بدون هویت معتبر «نامعلوم» می‌مانند." />
      {q.loading ? <Skeleton variant="row" lines={4} label="در حال دریافت گزارش…" />
        : q.error ? (q.error instanceof ApiError && q.error.status === 403
          ? <ResultState kind="denied" title={q.error.message} />
          : <ResultState kind="error" title={q.error instanceof ApiError ? q.error.message : "دریافت گزارش ممکن نشد."} reference={q.error instanceof ApiError ? q.error.correlationId : null} />)
        : !q.data?.rows.length ? <ResultState title="فروش یا مرجوعی ثبت‌شده‌ای در این بازه نیست." />
        : <DataTable caption="فروش کاربران" columns={columns} rows={q.data.rows} stack rowKey={r => r.userId ?? "unknown"} />}
    </Solid>
  </>;
}
