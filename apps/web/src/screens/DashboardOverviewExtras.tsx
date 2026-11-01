/**
 * طرح ۱۰ — دو بخش پایین «نمای کلی» داشبورد، همان پیش‌نمایش:
 *
 * ۱. کارت‌های رسیدگی: کمبود موجودی، شیفت‌های باز، چک سررسیدگذشته و طلب از مشتریان. همه از همان
 *    پاسخ «کارهای عملیاتی» (`/dashboard/operations`) و فقط با `report.view`؛ بخش بی‌مجوز `denied`
 *    است و کارتش ساخته نمی‌شود — نه صفر. آستانهٔ تعریف‌نشده «نامعلوم» است.
 * ۲. آخرین فروش‌های امروز همین شعبه: پنج ردیف اول همان `GET /invoices` (پیش‌نویس در آن نیست) و
 *    فقط با مجوز ناحیهٔ فاکتورها. هیچ مبلغی این‌جا جمع یا ساخته نمی‌شود؛ «مانده» ستون SQL است.
 */
import { useCallback } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { dashboardOperations, DRILL, lowStockLink } from "../lib/dashboard-operations.ts";
import { navigate } from "../lib/use-url-state.ts";
import { channelLabel, formatCount } from "../lib/format.ts";
import { toman } from "../lib/money.ts";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Solid } from "../components/Glass.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { Money } from "../components/ui/Money.tsx";
import { StatusBadge, type StatusState } from "../components/ui/Status.tsx";

function Go({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="overview-card-link" href={href} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(href); }}>{children}</a>;
}

interface Card { key: string; icon: IconName; tone: "good" | "warn" | "crit" | "info"; title: string; body: React.ReactNode; href: string | null }

export function OverviewCards({ branchId, links }: { branchId: string; links: { reports: boolean; treasury: boolean } }) {
  const load = useCallback((signal: AbortSignal) => dashboardOperations.read(branchId, { signal }), [branchId]);
  const q = useLatestQuery({ key: `overview-ops:${branchId}`, load });
  if (!q.data) return null;
  const o = q.data;
  const cards: Card[] = [];
  if (o.lowStock.state === "ready") cards.push({ key: "low", icon: "box", tone: o.lowStock.total > 0 ? "warn" : "good",
    title: `${formatCount(o.lowStock.total)} ردیف زیر آستانه`, body: `تنوع و انبار با موجودی کمتر از ${o.lowStock.threshold}`,
    href: links.reports ? lowStockLink(branchId) : null });
  else if (o.lowStock.state === "unknown") cards.push({ key: "low", icon: "box", tone: "info", title: "کمبود موجودی نامعلوم", body: o.lowStock.reason, href: null });
  if (o.shifts.state === "ready") cards.push({ key: "shifts", icon: "register", tone: o.shifts.carriedOverCount > 0 ? "warn" : "good",
    title: `${formatCount(o.shifts.openCount)} شیفت باز`, body: o.shifts.carriedOverCount > 0 ? `${formatCount(o.shifts.carriedOverCount)} شیفت از روز کاری قبل باز مانده` : "شیفتی از روز قبل باز نمانده",
    href: links.reports ? DRILL.shifts : null });
  if (o.cheques.state === "ready") {
    const overdue = o.cheques.received.overdue.count + o.cheques.issued.overdue.count;
    cards.push({ key: "cheques", icon: "doc", tone: overdue > 0 ? "crit" : "good",
      title: overdue > 0 ? `${formatCount(overdue)} چک سررسیدگذشته` : "چک سررسیدگذشته‌ای نیست",
      body: <>دریافتی نزدیک به سررسید: {formatCount(o.cheques.received.dueSoon.count)}</>, href: links.treasury ? DRILL.cheques : null });
  }
  if (o.receivables.state === "ready") cards.push({ key: "owed", icon: "people", tone: "info",
    title: "طلب از مشتریان", body: <><Money rial={BigInt(o.receivables.owed.amount)} size="sm" /> · {formatCount(o.receivables.owed.count)} مشتری</>,
    href: links.reports ? DRILL.receivables : null });
  if (cards.length === 0) return null;
  return <section className="overview-cards" aria-label="رسیدگی امروز">
    {cards.map(c => {
      const inner = <>
        <span className={`overview-card-icon tone-${c.tone}`} aria-hidden="true"><Icon name={c.icon} size="sm" /></span>
        <span className="overview-card-text"><strong>{c.title}</strong><small>{c.body}</small></span>
        {c.href ? <Icon name="chevron" size="sm" /> : null}
      </>;
      return <Solid key={c.key} as="article" className="overview-card" aria-label={c.title}>{c.href ? <Go href={c.href}>{inner}</Go> : <div className="overview-card-link">{inner}</div>}</Solid>;
    })}
  </section>;
}

interface Row { id: string; number: string | null; status: string; creatorName: string | null; customerName: string | null; occurredAt: string;
  payableAmount: string; paymentMethods: string; channel?: string; remainingAmount?: string }
const STATUS: Record<string, [StatusState, string]> = {
  finalized: ["active", "قطعی"], paid: ["completed", "تسویه‌شده"], cancelled: ["cancelled", "لغوشده"],
  returned: ["warning", "مرجوع‌شده"], partially_returned: ["warning", "مرجوعی جزئی"],
};
const time = (v: string) => new Intl.DateTimeFormat("fa-IR", { timeStyle: "short", timeZone: "Asia/Tehran" }).format(new Date(v));

export function RecentSales({ branchId, today, invoicesHref }: { branchId: string; today: string; invoicesHref: string }) {
  const load = useCallback((signal: AbortSignal) => {
    const q = new URLSearchParams({ status: "all", search: "", page: "1", branchId, from: today, to: today });
    return api.get<{ rows: Row[] }>(`/invoices?${q}`, { signal });
  }, [branchId, today]);
  const q = useLatestQuery({ key: `recent:${branchId}:${today}`, load });
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  const rows = (q.data?.rows ?? []).slice(0, 5);
  return <Solid as="section" className="list-card recent-sales" aria-labelledby="recent-sales-title">
    <SectionHeader id="recent-sales-title" title="آخرین فروش‌ها" description="فاکتورهای نهایی‌شدهٔ امروز در همین شعبه؛ پیش‌نویس فروش نیست."
      actions={<Go href={invoicesHref}><span className="btn"><Icon name="receipt" size="sm" />همهٔ فاکتورها</span></Go>} />
    {q.error ? <p className="muted">فاکتورهای امروز خوانده نشد؛ این به معنای «فروشی نیست» نیست.</p>
      : !q.data ? <p className="muted">در حال دریافت…</p>
      : rows.length === 0 ? <p className="empty">امروز هنوز فاکتوری نهایی نشده است.</p>
      : <div className="scroll-x"><table className="grid">
          <caption className="sr-only">آخرین فاکتورهای امروز؛ مبلغ‌ها به تومان</caption>
          <thead><tr><th>شمارهٔ فاکتور</th><th>مشتری</th><th>کانال</th><th>روش دریافت</th><th className="num">خالص (تومان)</th><th className="num">مانده</th><th>وضعیت</th></tr></thead>
          <tbody>{rows.map(r => {
            const [state, label] = STATUS[r.status] ?? ["unknown", "نامعلوم"];
            return <tr key={r.id}>
              <td><span className="num">{r.number ?? "بدون شماره"}</span><small>{time(r.occurredAt)} · {r.creatorName ?? "—"}</small></td>
              <td>{r.customerName ?? "مشتری عمومی"}</td>
              <td>{r.channel ? channelLabel(r.channel) : "—"}</td>
              <td>{r.paymentMethods || "بدون دریافت"}</td>
              <td className="num">{toman(BigInt(r.payableAmount))}</td>
              <td className="num">{r.remainingAmount && BigInt(r.remainingAmount) > 0n ? <span className="invoice-due">{toman(BigInt(r.remainingAmount))}</span> : "—"}</td>
              <td><StatusBadge state={state} label={label} /></td>
            </tr>;
          })}</tbody>
        </table></div>}
  </Solid>;
}
