import type { ReactNode } from "react";
import { FilterBar } from "./ui/FilterBar.tsx";

/**
 * فیلدهای مشترک بازه و شعبهٔ گزارش‌ها؛ هر گزارش می‌تواند فیلد خودش را
 * (انبار، نوع شخص، کد حساب، مبنای انتساب) کنارش بگذارد. وضعیت در نشانی است.
 */
export interface PeriodFilters { fields: ReactNode; summary: ReactNode; onReset: (() => void) | undefined }

export function ReportFilters({ filters, extra }: { filters: PeriodFilters; extra?: ReactNode }) {
  return <FilterBar label="فیلتر گزارش" summary={filters.summary} onReset={filters.onReset}>
    {filters.fields}
    {extra}
  </FilterBar>;
}
