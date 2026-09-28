import type { ReactNode } from "react";
import { ResultState } from "../ResultState.tsx";

/**
 * جدول داده — سطح اصلی کار مالی (docs/UI_PATTERNS.md، «جدول»).
 *
 * - اسکرول افقی **درون** ظرف، هرگز بدنهٔ صفحه؛ ظرف فوکوس‌پذیر است تا با
 *   کیبورد هم لغزانده شود.
 * - سرستون چسبان، ستون عددی هم‌تراز انتها با `tabular-nums`.
 * - مرتب‌سازی با `aria-sort` روی `th` و دکمهٔ واقعی درون آن.
 * - روی موبایل، `stack` هر سطر را کارت می‌کند و برچسب ستون کنار مقدار
 *   می‌نشیند — هیچ ستونی پنهان نمی‌شود.
 * - تراکم از توکن‌ها می‌آید (`data-density`).
 */
export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  sortable?: boolean;
}

export function DataTable<T>({ caption, columns, rows, rowKey, sort, onSort, selected, onSelect, density = "comfortable", loading = false, empty, stack = false, rowActions }: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort?: { key: string; dir: "asc" | "desc" } | undefined;
  onSort?: (key: string) => void;
  selected?: ReadonlySet<string>;
  onSelect?: (key: string, next: boolean) => void;
  density?: "comfortable" | "compact";
  loading?: boolean;
  empty?: { title: string; description?: string };
  stack?: boolean;
  rowActions?: (row: T) => ReactNode;
}) {
  const selectable = selected !== undefined && onSelect !== undefined;
  const span = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);
  return <div className="table-scroll" role="region" aria-label={caption} tabIndex={0} data-density={density}>
    <table className={`ui-table${stack ? " ui-table--stack" : ""}`} aria-busy={loading || undefined}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {selectable ? <th scope="col" className="ui-table-select"><span className="sr-only">انتخاب</span></th> : null}
          {columns.map(c => {
            const dir = sort?.key === c.key ? sort.dir : undefined;
            return <th key={c.key} scope="col" className={c.numeric ? "is-numeric" : undefined}
              aria-sort={c.sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}>
              {c.sortable && onSort
                ? <button type="button" className="ui-table-sort" onClick={() => onSort(c.key)}>
                    {c.header}<span aria-hidden="true" className="ui-table-sort-mark">{dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}</span>
                  </button>
                : c.header}
            </th>;
          })}
          {rowActions ? <th scope="col"><span className="sr-only">کنش‌ها</span></th> : null}
        </tr>
      </thead>
      <tbody>
        {loading ? Array.from({ length: 3 }, (_, i) => <tr key={`s${i}`} className="ui-table-skeleton" aria-hidden="true">
          {Array.from({ length: span }, (_, j) => <td key={j}><span className="skeleton skeleton--text" /></td>)}
        </tr>) : rows.length === 0 ? <tr><td colSpan={span} className="ui-table-empty">
          <ResultState title={empty?.title ?? "موردی برای نمایش نیست."} {...(empty?.description ? { description: empty.description } : {})} />
        </td></tr> : rows.map(row => {
          const key = rowKey(row);
          const isSelected = selected?.has(key) ?? false;
          return <tr key={key} aria-selected={selectable ? isSelected : undefined}>
            {selectable ? <td className="ui-table-select"><input type="checkbox" checked={isSelected} aria-label="انتخاب سطر" onChange={e => onSelect(key, e.target.checked)} /></td> : null}
            {columns.map(c => <td key={c.key} data-label={c.header} className={c.numeric ? "is-numeric" : undefined}>{c.cell(row)}</td>)}
            {rowActions ? <td className="ui-table-actions" data-label="کنش‌ها">{rowActions(row)}</td> : null}
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
