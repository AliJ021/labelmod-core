/**
 * کارت «تسویه‌نشده» برداشت پرسنل (تصمیم مالک ۲۰۲۶/۱۱/۰۹) — جمع از سرور، بی محاسبه در مرورگر.
 * دفتر برداشت اثر مالی ندارد؛ این عدد فقط می‌گوید چقدر هنوز تسویه نشده است. پاسخ قدیمی‌تر کارتی نمی‌سازد.
 */
import { Kpi } from "./ui/Kpi.tsx";
import { Money } from "./ui/Money.tsx";
import { formatCount } from "../lib/format.ts";

export function WithdrawalUnsettled({ data, note }: { data: { amount: string; count: number } | undefined; note: string }) {
  if (!data) return null;
  return <section className="kpis kpi-cards withdrawal-summary" aria-label="خلاصهٔ برداشت">
    <Kpi variant="card" icon="wallet" label="تسویه‌نشده" value={<Money rial={data.amount} size="lg" />}
      note={data.count === 0 ? "همهٔ برداشت‌ها تسویه شده‌اند" : `${formatCount(data.count)} برداشت باز · ${note}`} />
  </section>;
}
