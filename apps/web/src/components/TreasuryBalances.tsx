/**
 * ماندهٔ دفتری حساب‌های خزانه (طرح ۱۰) — ردیف بالای «خزانه و چک».
 *
 * عدد **دفتر** است، نه شمارش کشو: فقط سند تأییدشده و قطعی، همان تعریف تراز
 * آزمایشی؛ فروش امروز تا بستن دوره در آن نیست و همین زیر هر عدد نوشته می‌شود.
 * مانده به‌ازای سرفصل است؛ حساب‌های خزانهٔ هم‌سرفصل کنار هم نام برده می‌شوند.
 * بی `report.view` (۴۰۳) ردیف اصلاً نمی‌آید — نه صفر و نه خطا.
 */
import { useCallback } from "react";
import { ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { ACCOUNT_KIND, treasury } from "../lib/treasury.ts";
import { formatJalali } from "../lib/format.ts";
import { Kpi } from "./ui/Kpi.tsx";
import { Money } from "./ui/Money.tsx";
import { Ltr } from "./ui/Bidi.tsx";

export function TreasuryBalances() {
  const load = useCallback((signal: AbortSignal) => treasury.balances({ signal }), []);
  const q = useLatestQuery({ key: "treasury-balances", load });
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  if (q.error) return <p className="solid pad" role="status">ماندهٔ دفتری خوانده نشد؛ این به معنای صفر نیست.</p>;
  if (!q.data || q.data.balances.length === 0) return null;
  return <section className="solid kpis kpis--band treasury-balances" aria-label="ماندهٔ دفتری حساب‌های خزانه">
    {q.data.balances.map(b => <Kpi key={b.code}
      label={b.kinds.map(k => ACCOUNT_KIND[k] ?? k).join(" و ") + " — " + b.accountName}
      value={<Money rial={BigInt(b.balance)} size="xl" />}
      note={<><Ltr>{b.code}</Ltr> · {b.treasuryAccounts} · ماندهٔ دفتر{b.lastEntry ? ` تا ${formatJalali(b.lastEntry)}` : ""}</>} />)}
  </section>;
}
