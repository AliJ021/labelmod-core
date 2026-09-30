import type { ReactNode } from "react";
import { Button } from "./Controls.tsx";

/**
 * نوار فیلتر — الگوی «فهرست» و «گزارش» (docs/UI_PATTERNS.md §۳).
 *
 * فیلدها (`Field`) در یک ردیف فشرده که در عرض باریک می‌شکند؛ زیرش خلاصهٔ
 * متنیِ فیلتر فعال — تا کسی که به جدول نگاه می‌کند بداند «کدام بازه، کدام
 * شعبه» — و «بازنشانی» اگر چیزی از پیش‌فرض عوض شده. خودِ مقدارها در نشانی
 * (`use-url-state.ts`) می‌مانند؛ این کامپوننت هیچ وضعیتی نگه نمی‌دارد و
 * هیچ پرس‌وجویی نمی‌سازد.
 */
export function FilterBar({ label, children, summary, onReset, resetLabel = "بازنشانی فیلترها" }: {
  label: string;
  children: ReactNode;
  summary?: ReactNode;
  /** فقط وقتی فیلتری از پیش‌فرض عوض شده؛ وگرنه دکمه ساخته نمی‌شود. */
  onReset?: (() => void) | undefined;
  resetLabel?: string;
}) {
  return <section className="filter-bar" aria-label={label}>
    <div className="filter-bar-fields">{children}</div>
    {summary || onReset ? <div className="filter-bar-foot">
      {summary ? <p className="filter-bar-summary" aria-live="polite">{summary}</p> : <span />}
      {onReset ? <Button variant="quiet" onClick={onReset}>{resetLabel}</Button> : null}
    </div> : null}
  </section>;
}
