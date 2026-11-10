/**
 * زبانهٔ حرکت پول، طرح ۱۰ (WP4 دستهٔ ۴): «شیفت‌ها و کشوها»، «حرکت‌های نقد غیرفروشی امروز» و
 * «پایانه‌ها و تسویه». هر سه فقط نمایش‌اند و هیچ عددی را مرورگر حساب نمی‌کند.
 *
 * - کشوها و حرکت‌ها از `GET /treasury/drawers`: «انتظار نقد» کشوی باز همان فرمول بستن شیفت است
 *   (`sales.shift_expected_cash`، مهاجرت ۱۱۰)؛ شمرده و مغایرت فقط پس از شمارش وجود دارند، پس پیش از
 *   آن «پس از شمارش» نوشته می‌شود، نه صفر. بی `report.view` بخش کشوها اصلاً نمی‌آید.
 * - علامت مبلغ حرکت از دید کشو و از SQL است (خروج منفی).
 * - کارمزد، دورهٔ تسویه و درایور پایانه فقط از تنظیمات عوض می‌شوند و فقط با `settings.view` خوانده
 *   می‌شوند؛ بی آن مجوز ستون‌ها «—» با توضیح‌اند، نه صفر.
 */
import { useCallback, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { admin, type SettlementTerm, type TerminalDriver } from "../lib/admin.ts";
import { formatClock, formatCount, formatJalaliMoment } from "../lib/format.ts";
import { ACCOUNT_KIND, PURPOSE_LABEL, treasury, type DrawerMove, type DrawerShift, type TreasuryAccount } from "../lib/treasury.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { Solid } from "./Glass.tsx";
import { SectionHeader } from "./ui/PageHeader.tsx";
import { StatusBadge } from "./ui/Status.tsx";
import { Money } from "./ui/Money.tsx";
import { Ltr } from "./ui/Bidi.tsx";
import { DataTable, type Column } from "./ui/DataTable.tsx";

/** متن اصلی و زیرنویس یک خانه با هم می‌مانند؛ در کارت گوشی هم از هم جدا نمی‌شوند. */
const stack = (...parts: ReactNode[]) => <span className="cell-stack">{parts}</span>;
const muted = (text: string) => <span className="muted">{text}</span>;

const SHIFT_COLUMNS: readonly Column<DrawerShift>[] = [
  { key: "drawer", header: "کشو", cell: s => stack(<strong key="n">{s.userName}</strong>, <small key="s" className="cell-sub">باز {formatJalaliMoment(s.openedAt)}</small>) },
  { key: "status", header: "وضعیت", cell: s => s.status === "open"
    ? (s.carriedOver ? <StatusBadge state="warning" label="ماندهٔ دیروز" /> : <StatusBadge state="active" label="باز" quiet />)
    : stack(<StatusBadge key="b" state="completed" label="بسته" quiet />, s.closedAt ? <small key="t" className="cell-sub">{formatJalaliMoment(s.closedAt)}</small> : null) },
  { key: "opening", header: "موجودی اول", numeric: true, cell: s => <Money rial={BigInt(s.openingCash)} /> },
  { key: "expected", header: "انتظار نقد", numeric: true, cell: s => <span className="drawer-expected"><Money rial={s.expectedCash === null ? null : BigInt(s.expectedCash)} /></span> },
  { key: "counted", header: "شمرده‌شده", numeric: true, cell: s => s.countedCash === null ? muted("—") : <Money rial={BigInt(s.countedCash)} /> },
  { key: "variance", header: "مغایرت", numeric: true, cell: s => {
    if (s.status === "open") return muted("پس از شمارش");
    if (s.variance === null) return <Money rial={null} unknownLabel="مغایرت ثبت نشده" />;
    const v = BigInt(s.variance);
    if (v === 0n) return <span className="drawer-variance" data-tone="good">ندارد</span>;
    return <span className="drawer-variance" data-tone={v < 0n ? "crit" : "warn"} title={v < 0n ? "کسری" : "اضافه"}><Money rial={v} /></span>;
  } },
];

const MOVE_COLUMNS: readonly Column<DrawerMove>[] = [
  { key: "time", header: "ساعت", cell: m => <span className="num">{formatClock(m.occurredAt)}</span> },
  { key: "drawer", header: "کشو", cell: m => m.drawerName ?? <StatusBadge state="warning" label="بی شیفت" /> },
  { key: "memo", header: "شرح", cell: m => stack(<span key="m">{m.note ?? PURPOSE_LABEL[m.purpose] ?? m.purpose}</span>, m.createdByName ? <small key="c" className="cell-sub">ثبت‌شده: {m.createdByName}</small> : null) },
  { key: "counterpart", header: "طرف حساب", cell: m => m.counterpartName === null && m.counterpartCode === null
    ? (PURPOSE_LABEL[m.purpose] ?? "—")
    : <span className="cell-inline">{m.counterpartCode ? <Ltr>{m.counterpartCode}</Ltr> : null}{m.counterpartName ? <span>{m.counterpartName}</span> : null}</span> },
  { key: "amount", header: "مبلغ", numeric: true, cell: m => {
    const v = BigInt(m.drawerAmount);
    return <span className="drawer-variance" data-tone={v < 0n ? "crit" : v > 0n ? "good" : undefined} title={v < 0n ? "خروج از کشو" : v > 0n ? "ورود به کشو" : undefined}><Money rial={v} /></span>;
  } },
];

export function TreasuryDesk({ branchId, version }: { branchId: string | null; version: number }) {
  const [retry, setRetry] = useState(0);
  const load = useCallback((signal: AbortSignal) => treasury.drawers(branchId!, { signal }), [branchId]);
  const q = useLatestQuery({ key: `drawers:${branchId ?? ""}`, version: version + retry * 1000, load, enabled: branchId !== null });
  if (branchId === null) return null;
  if (q.error) return <p className="solid pos-alert" role="alert">
    <span className="dot dot--crit" aria-hidden="true">●</span> کشوها و حرکت‌های نقد امروز خوانده نشدند.{" "}
    <button type="button" className="btn btn--quiet" onClick={() => setRetry(n => n + 1)}>تلاش دوباره</button>
  </p>;
  const data = q.data;
  return <>
    {data === null || data.shiftsVisible ? <Solid as="section" className="list-card drawer-card" aria-labelledby="treasury-drawers" aria-busy={data === null || undefined}>
      <SectionHeader id="treasury-drawers" title="شیفت‌ها و کشوها" description="کشو از شعبه پیدا می‌شود، نه از کاربر عامل؛ با دو کشوی باز، انتخاب کشو اجباری است. انتظار نقد کشوی باز با همان فرمول بستن شیفت حساب می‌شود." />
      <DataTable<DrawerShift> caption="شیفت‌ها و کشوهای امروز و دیروز" stack loading={data === null} rows={data?.shifts ?? []} rowKey={s => s.id}
        columns={SHIFT_COLUMNS} empty={{ title: "امروز و دیروز کشویی باز نشده." }} />
    </Solid> : null}
    <Solid as="section" className="list-card drawer-card" aria-labelledby="treasury-cash-today" aria-busy={data === null || undefined}>
      <SectionHeader id="treasury-cash-today" title="حرکت‌های نقد غیرفروشی امروز" description="هر حرکتی که از کشوی صندوق رد شود به شیفت باز همان شعبه می‌چسبد؛ وگرنه شمارش کشو مغایرت کاذب می‌دهد." />
      <DataTable<DrawerMove> caption="حرکت‌های نقد غیرفروشی امروز" stack loading={data === null} rows={data?.moves ?? []} rowKey={m => m.id}
        columns={MOVE_COLUMNS} empty={{ title: "امروز حرکت نقدی غیرفروشی ثبت نشده." }} />
    </Solid>
  </>;
}

interface TerminalRow { account: TreasuryAccount; terms: SettlementTerm | null; driver: TerminalDriver | null }

/** پایانه‌ها و تسویه — کارمزد، دوره و درایور فقط با `settings.view` و از همان مسیرهای تنظیمات. */
export function TreasuryTerminals({ accounts }: { accounts: readonly TreasuryAccount[] }) {
  const terminals = accounts.filter(a => a.kind === "card_terminal" || a.kind === "gateway");
  const load = useCallback(async (signal: AbortSignal) => {
    const verdict = await api.get<{ verdict: string }>("/auth/can?operation=settings.view", { signal });
    if (verdict.verdict !== "allow") return { allowed: false as const };
    const [terms, drivers] = await Promise.all([admin.settlementTerms(signal), admin.terminalDrivers(signal)]);
    return { allowed: true as const, terms: terms.terms, drivers: drivers.terminals };
  }, []);
  const q = useLatestQuery({ key: "treasury-terminal-terms", load, enabled: terminals.length > 0 });
  if (terminals.length === 0) return null;
  const known = q.data?.allowed ? q.data : null;
  const why = q.loading ? "در حال خواندن" : q.error ? "تنظیمات پایانه خوانده نشد" : "بدون دسترسی به تنظیمات پایانه";
  const unknown = <span className="muted" title={why}>—<span className="sr-only">{why}</span></span>;
  const rows: TerminalRow[] = terminals.map(account => ({
    account,
    terms: known?.terms.find(t => t.id === account.id) ?? null,
    driver: known?.drivers.find(d => d.accountId === account.id) ?? null,
  }));
  const columns: readonly Column<TerminalRow>[] = [
    { key: "terminal", header: "پایانه", cell: r => stack(<strong key="n">{r.account.name}</strong>, <small key="k" className="cell-sub">{ACCOUNT_KIND[r.account.kind] ?? r.account.kind}</small>) },
    { key: "account", header: "حساب", cell: r => <Ltr>{r.account.ledgerAccountCode}</Ltr> },
    { key: "fee", header: "کارمزد", numeric: true, cell: r => r.terms ? <bdi className="num">{r.terms.feePercent}٪</bdi> : unknown },
    { key: "days", header: "تسویه", cell: r => r.terms ? `${formatCount(r.terms.settlementDays)} روز` : unknown },
    { key: "driver", header: "درایور", cell: r => !known ? unknown : r.driver?.driverCode
      ? stack(<span key="d">{r.driver.driverLabel ?? r.driver.driverCode}</span>, r.driver.isImplemented ? null : <small key="i" className="cell-sub">پیاده‌نشده</small>)
      : muted("دستی (درایور ثبت‌نشده)") },
  ];
  return <Solid as="section" className="list-card drawer-card" aria-labelledby="treasury-terminals">
    {/* پیوند تنظیمات اینجا نیست: مقصد ناوبری فقط با allow صریح نشان داده می‌شود و این بخش آن را نمی‌داند. */}
    <SectionHeader id="treasury-terminals" title="پایانه‌ها و تسویه" description="کارمزد و دورهٔ تسویه به‌ازای هر پایانه در تنظیمات ← پایانه‌ها است، نه یک تنظیم عمومی." />
    <DataTable<TerminalRow> caption="پایانه‌ها و تسویه" stack rows={rows} rowKey={r => r.account.id} columns={columns} />
  </Solid>;
}
