/**
 * «مرجوعی‌های امروز» (طرح ۱۰، تصمیم مالک ۲۰۲۶/۱۱/۰۹) — فهرست فقط‌خواندنی برگ‌های ثبت‌شدهٔ امروز.
 *
 * «امروز» تاریخ کاری سرور است و هر مبلغ همان ستونی است که `post_return` نوشته؛ این کامپوننت هیچ مبلغی
 * حساب نمی‌کند. با هر ثبت تازه (`version`) دوباره از سرور خوانده می‌شود. خواندنِ ناموفق «خطا» است، نه فهرست خالی.
 */
import { useEffect, useState } from "react";
import { Solid } from "./Glass.tsx";
import { SectionHeader } from "./ui/PageHeader.tsx";
import { DataTable, type Column } from "./ui/DataTable.tsx";
import { Money } from "./ui/Money.tsx";
import { Ltr } from "./ui/Bidi.tsx";
import { ResultState } from "./ResultState.tsx";
import { api, ApiError } from "../lib/api.ts";
import { formatClock, formatQty } from "../lib/format.ts";

export interface TodayReturn {
  id: string;
  number: string | null;
  kind: string;
  occurredAt: string;
  createdByName: string | null;
  invoiceNumber: string | null;
  firstItem: string | null;
  lineCount: number;
  totalQty: string;
  sellable: number;
  defective: number;
  notRestocked: number;
  netAmount: string;
  refundAmount: string;
  refundMethod: string | null;
  drawerName: string | null;
}

/** وضعیت کالا از سه شمارش سرور؛ فقط برچسب است، نه محاسبه. */
function condition(r: TodayReturn): string {
  const parts = [
    r.sellable ? `سالم · برگشت به قفسه${r.lineCount > 1 ? ` (${formatQty(String(r.sellable))})` : ""}` : null,
    r.defective ? `معیوب${r.lineCount > 1 ? ` (${formatQty(String(r.defective))})` : ""}` : null,
    r.notRestocked ? `بدون بازگشت موجودی${r.lineCount > 1 ? ` (${formatQty(String(r.notRestocked))})` : ""}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("، ") : "—";
}

const COLUMNS: readonly Column<TodayReturn>[] = [
  { key: "number", header: "برگ", cell: (r) => <span className="cell-stack">
    <span><Ltr>{r.number ?? "—"}</Ltr>{r.kind === "exchange" ? <span className="muted small"> · تعویض</span> : null}</span>
    <small className="muted">{formatClock(r.occurredAt)}{r.createdByName ? ` · ${r.createdByName}` : ""}</small></span> },
  { key: "invoice", header: "فاکتور", cell: (r) => r.invoiceNumber ? <Ltr>{r.invoiceNumber}</Ltr> : <span className="muted">—</span> },
  { key: "item", header: "کالا", cell: (r) => r.firstItem ? `${r.firstItem}${r.lineCount > 1 ? ` و ${formatQty(String(r.lineCount - 1))} قلم دیگر` : ""}` : "—" },
  { key: "condition", header: "وضعیت کالا", cell: condition },
  { key: "refund", header: "بازپرداخت", numeric: true, cell: (r) => <span className="cell-stack">
    <Money rial={r.refundAmount} unit={false} />
    <small className="muted">{[r.refundMethod, r.drawerName ? `شیفت ${r.drawerName}` : null].filter(Boolean).join(" · ") || "—"}</small></span> },
];

export function TodayReturns({ version }: { version: number }) {
  const [rows, setRows] = useState<TodayReturn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api.get<{ businessDate: string; returns: TodayReturn[] }>("/returns/today").then(
      (r) => { if (alive) setRows(r.returns); },
      (e: unknown) => { if (alive) setError(e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد."); });
    return () => { alive = false; };
  }, [version]);
  return <Solid as="section" className="list-card" aria-labelledby="returns-today">
    <SectionHeader id="returns-today" title="مرجوعی‌های امروز" description="برگ‌های ثبت‌شدهٔ امروز؛ اثر مالی در سند بستن دوره." />
    {error ? <ResultState kind="error" title="مرجوعی‌های امروز خوانده نشد" description={`${error} این به معنای «مرجوعی‌ای نیست» نیست.`} />
      // فهرست خالی متن ساده است، نه «وضعیت» زنده: این صفحه پیام زندهٔ «عملیات … ثبت شد» دارد و دو ناحیهٔ
      // زنده یعنی صفحه‌خوان «مرجوعی‌ای نیست» را هم‌زمان با «ثبت شد» بخواند.
      : rows !== null && rows.length === 0 ? <p className="list-card-body muted">امروز مرجوعی‌ای ثبت نشده است.</p>
      : <DataTable<TodayReturn> caption="مرجوعی‌های امروز؛ مبلغ‌ها به تومان" stack loading={rows === null} rows={rows ?? []}
          rowKey={(r) => r.id} columns={COLUMNS} />}
  </Solid>;
}
