/**
 * «کشوهای باز» و «پایانه‌ها» در زبانهٔ حرکت پول (طرح ۱۰). هر دو فقط نمایش‌اند:
 * کشوها همان شمار «کارهای عملیاتی» داشبورد است (بی `report.view` پنهان)، و پایانه‌ها
 * همان حساب‌های خزانه‌ای که این صفحه از قبل می‌خواند. کارمزد و دورهٔ تسویه فقط از
 * تنظیمات (`treasury.set_settlement_terms`) عوض می‌شوند، نه از اینجا.
 */
import { useBranchOperations } from "../lib/use-branch-operations.ts";
import { ACCOUNT_KIND, type TreasuryAccount } from "../lib/treasury.ts";
import { formatJalaliMoment } from "../lib/format.ts";
import { Solid } from "./Glass.tsx";
import { SectionHeader } from "./ui/PageHeader.tsx";
import { StatusBadge } from "./ui/Status.tsx";
import { Ltr } from "./ui/Bidi.tsx";

export function TreasuryDesk({ accounts }: { accounts: readonly TreasuryAccount[] }) {
  const ops = useBranchOperations();
  const shifts = ops?.ops.shifts.state === "ready" ? ops.ops.shifts : null;
  const terminals = accounts.filter(a => a.kind === "card_terminal" || a.kind === "gateway");
  if (!shifts && terminals.length === 0) return null;
  return <div className="treasury-desk">
    {shifts ? <Solid as="section" className="list-card" aria-labelledby="treasury-drawers">
      <SectionHeader id="treasury-drawers" title="کشوهای باز" description="کشو از شعبه پیدا می‌شود، نه از کاربر عامل؛ با دو کشوی باز، انتخاب کشو اجباری است." />
      {shifts.open.length === 0 ? <p className="muted">کشوی بازی نیست.</p> : <div className="scroll-x"><table className="grid">
        <caption className="sr-only">کشوهای باز این شعبه</caption>
        <thead><tr><th>کشو</th><th>باز از</th><th>وضعیت</th></tr></thead>
        <tbody>{shifts.open.map(sh => <tr key={sh.id}>
          <td><strong>{sh.userName}</strong></td>
          <td>{sh.openedAt ? formatJalaliMoment(sh.openedAt) : "—"}</td>
          <td>{sh.carriedOver ? <StatusBadge state="warning" label="ماندهٔ دیروز" /> : <StatusBadge state="active" label="باز" quiet />}</td>
        </tr>)}</tbody>
      </table></div>}
    </Solid> : null}
    {terminals.length ? <Solid as="section" className="list-card" aria-labelledby="treasury-terminals">
      {/* پیوند تنظیمات اینجا نیست: مقصد ناوبری فقط با allow صریح نشان داده می‌شود و این بخش آن را نمی‌داند. */}
      <SectionHeader id="treasury-terminals" title="پایانه‌ها و درگاه‌ها" description="کارمزد و دورهٔ تسویه به‌ازای هر پایانه در تنظیمات ← پایانه‌ها است، نه یک تنظیم عمومی." />
      <div className="scroll-x"><table className="grid">
        <caption className="sr-only">پایانه‌ها و درگاه‌ها</caption>
        <thead><tr><th>پایانه</th><th>نوع</th><th>سرفصل</th></tr></thead>
        <tbody>{terminals.map(t => <tr key={t.id}>
          <td><strong>{t.name}</strong></td>
          <td>{ACCOUNT_KIND[t.kind] ?? t.kind}</td>
          <td><Ltr>{t.ledgerAccountCode}</Ltr></td>
        </tr>)}</tbody>
      </table></div>
    </Solid> : null}
  </div>;
}
