import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { PAGE_SIZE, type WithdrawalItem, type WithdrawalRevision } from "../lib/withdrawals.ts";
import { Button } from "./ui/Controls.tsx";
import { DataTable, type Column } from "./ui/DataTable.tsx";
import { Money } from "./ui/Money.tsx";
import { StatusBadge } from "./ui/Status.tsx";

/**
 * تکه‌های مشترک دفتر برداشت — برداشت‌های من و دفتر مدیر کل یک زبان دارند.
 *
 * صفر یک عدد واقعی است («۰ تومان»، اصلاح مدیر)، نه «—». وضعیت همیشه آیکون +
 * برچسب است، نه فقط رنگ. هیچ‌جا «پرداخت شد» یا «از صندوق رفت» گفته نمی‌شود:
 * این دفتر اثر مالی ندارد.
 */
export function WithdrawalStatus({ item }: { item: Pick<WithdrawalItem, "version"> }) {
  return item.version > 1
    ? <StatusBadge state="active" label={`اصلاح‌شده · نسخهٔ ${formatCount(item.version)}`} />
    : <StatusBadge state="completed" label="ثبت‌شده" />;
}

/** خط زمانی نسخه‌ها: چه کسی، کی، چه مقداری و چرا — نسخهٔ قبلی هرگز پاک نمی‌شود. */
export function WithdrawalHistory({ history, caption }: { history: readonly WithdrawalRevision[]; caption: string }) {
  const columns: Column<WithdrawalRevision>[] = [
    { key: "v", header: "نسخه", cell: h => h.version === 1 ? "ثبت" : `اصلاح ${formatCount(h.version - 1)}` },
    { key: "at", header: "زمان", cell: h => <span className="cell-nowrap">{formatJalaliMoment(h.at)}</span> },
    { key: "actor", header: "ثبت‌کننده", cell: h => h.actor.name },
    { key: "amount", header: "مبلغ", numeric: true, cell: h => <Money rial={h.amount} size="sm" /> },
    { key: "reason", header: "دلیل برداشت", cell: h => h.reason },
    { key: "note", header: "دلیل اصلاح", cell: h => h.note ?? <span className="muted">—<span className="sr-only">ندارد (ثبت اولیه)</span></span> },
  ];
  return <DataTable caption={caption} columns={columns} rows={history} rowKey={h => String(h.version)} density="compact" stack />;
}

/** صفحه‌بندی سرور؛ «بعدی» فقط وقتی سرور ردیف بیشتری گزارش کند. */
export function Pager({ page, total, label, onPage }: { page: number; total: number; label: string; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return <nav className="pager" aria-label={label}>
    <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>قبلی</Button>
    <span className="pager-state">صفحهٔ {formatCount(page)} از {formatCount(pages)}؛ {formatCount(total)} ثبت</span>
    <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>بعدی</Button>
  </nav>;
}
