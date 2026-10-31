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
    {shifts ? <Solid as="section" className="pad" aria-labelledby="treasury-drawers">
      <SectionHeader id="treasury-drawers" title="کشوهای باز" description="کشو از شعبه پیدا می‌شود، نه از کاربر عامل؛ با دو کشوی باز، انتخاب کشو اجباری است." />
      {shifts.open.length === 0 ? <p className="muted">کشوی بازی نیست.</p> : <ul className="desk-list">
        {shifts.open.map(sh => <li key={sh.id}>
          <span><strong>{sh.userName}</strong><small>باز از {formatJalaliMoment(sh.openedAt)}</small></span>
          {sh.carriedOver ? <StatusBadge state="warning" label="ماندهٔ دیروز" /> : <StatusBadge state="active" label="باز" quiet />}
        </li>)}
      </ul>}
    </Solid> : null}
    {terminals.length ? <Solid as="section" className="pad" aria-labelledby="treasury-terminals">
      {/* پیوند تنظیمات اینجا نیست: مقصد ناوبری فقط با allow صریح نشان داده می‌شود و این بخش آن را نمی‌داند. */}
      <SectionHeader id="treasury-terminals" title="پایانه‌ها و درگاه‌ها" description="کارمزد و دورهٔ تسویه به‌ازای هر پایانه در تنظیمات ← پایانه‌ها است، نه یک تنظیم عمومی." />
      <ul className="desk-list">
        {terminals.map(t => <li key={t.id}>
          <span><strong>{t.name}</strong><small>{ACCOUNT_KIND[t.kind] ?? t.kind} · سرفصل <Ltr>{t.ledgerAccountCode}</Ltr></small></span>
        </li>)}
      </ul>
    </Solid> : null}
  </div>;
}
