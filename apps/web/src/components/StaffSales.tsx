import { useCallback } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useUrlState } from "../lib/use-url-state.ts";
import { toman } from "../lib/money.ts";
import type { Period } from "../lib/reports.ts";
import { ResultState } from "./ResultState.tsx";

interface Row { userId: string | null; userName: string | null; invoiceCount: string; grossAmount: string; discountAmount: string; returnedAmount: string; netSalesAmount: string }
export function StaffSales({ period }: { period: Period }) {
  const [basis, setBasis] = useUrlState("reports.staffBasis", "finalizer");
  const { from, to, branchId } = period;
  const load = useCallback((signal: AbortSignal) => {
    const params = new URLSearchParams({ from, to, basis });
    if (branchId) params.set("branchId", branchId);
    return api.get<{ rows: Row[] }>(`/reports/staff-sales?${params}`, { signal });
  }, [from, to, branchId, basis]);
  const q = useLatestQuery({ key: JSON.stringify([from, to, branchId, basis]), load });
  return <section className="solid pad stack"><h2>فروش کاربران</h2>
    <label className="auth-field">مبنای انتساب<select value={basis} onChange={e => setBasis(e.target.value)}><option value="finalizer">نهایی‌کنندهٔ فاکتور</option><option value="creator">ثبت‌کنندهٔ پیش‌نویس</option></select></label>
    <p className="muted">پیش‌نویس‌ها فروش نیستند. مرجوعیِ ثبت‌شده در این بازه به فروشندهٔ فاکتور اصلی نسبت داده می‌شود؛ مبلغ‌ها بدون مالیات و کرایه و به تومان‌اند. سوابق بدون هویت معتبر «نامعلوم» می‌مانند.</p>
    {q.loading ? <ResultState kind="loading" title="در حال دریافت گزارش…" /> : q.error ? <ResultState kind="error" title={q.error instanceof ApiError ? q.error.message : "دریافت گزارش ممکن نشد."} /> : !q.data?.rows.length ? <ResultState title="فروش یا مرجوعی ثبت‌شده‌ای در این بازه نیست." /> : <div className="scroll-x"><table className="grid"><thead><tr><th>کاربر</th><th>فاکتور قطعی</th><th>فروش ناخالص</th><th>تخفیف</th><th>مرجوعی</th><th>فروش خالص</th></tr></thead>
      <tbody>{q.data.rows.map(r => <tr key={r.userId ?? "unknown"}><td>{r.userName ?? "نامعلوم"}</td><td>{r.invoiceCount}</td>{[r.grossAmount,r.discountAmount,r.returnedAmount,r.netSalesAmount].map((m,i) => <td key={i} className="num">{toman(BigInt(m))}</td>)}</tr>)}</tbody></table></div>}
  </section>;
}
