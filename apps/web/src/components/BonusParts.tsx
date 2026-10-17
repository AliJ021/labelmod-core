import { formatJalaliMoment } from "../lib/format.ts";
import { ORIGIN_LABEL, STATUS_LABEL, type BonusItem, type BonusStatus as Status } from "../lib/bonuses.ts";
import { Money } from "./ui/Money.tsx";
import { StatusBadge, type StatusState } from "./ui/Status.tsx";

/**
 * تکه‌های مشترک دفتر پاداش — «پاداش‌های من» و دفتر مدیر یک زبان دارند.
 *
 * وضعیت همیشه آیکون + برچسب است، نه فقط رنگ. هیچ‌جا «پرداخت شد» گفته
 * نمی‌شود: «تسویه‌شده» وضعیت دفتر است و اثر مالی ندارد.
 */
const STATE: Readonly<Record<Status, StatusState>> = { pending: "pending", approved: "active", rejected: "cancelled", settled: "completed" };

export function BonusStatus({ status }: { status: Status }) {
  return <StatusBadge state={STATE[status]} label={STATUS_LABEL[status]} />;
}

/** خط زمانی یک پاداش: ثبت، تصمیم، تسویه — هر گام با نام، زمان سرور و یادداشت. */
export function BonusTimeline({ item }: { item: BonusItem }) {
  return <dl className="settings-facts">
    <div><dt>مبلغ</dt><dd><Money rial={item.amount} exact /></dd></div>
    <div><dt>دلیل</dt><dd>{item.reason}</dd></div>
    <div><dt>منشأ</dt><dd>{ORIGIN_LABEL[item.origin]} · {item.createdBy} · {formatJalaliMoment(item.createdAt)}</dd></div>
    <div><dt>وضعیت</dt><dd><BonusStatus status={item.status} /></dd></div>
    {item.origin === "request" ? <div><dt>بررسی</dt><dd>{item.decidedAt
      ? <>{item.status === "rejected" ? "رد" : "تأیید"} · {item.decidedBy} · {formatJalaliMoment(item.decidedAt)}{item.decisionNote ? <span className="cell-sub">{item.decisionNote}</span> : null}</>
      : "هنوز بررسی نشده"}</dd></div> : null}
    <div><dt>تسویه</dt><dd>{item.settledAt
      ? <>{item.settledBy} · {formatJalaliMoment(item.settledAt)}<span className="cell-sub">{item.settlementNote}</span></>
      : "تسویه نشده"}</dd></div>
  </dl>;
}
