/**
 * کارهای عملیاتی شعبهٔ کاربر (`/dashboard/operations`) برای ردیف شاخص‌های صفحه‌ها
 * (طرح ۱۰: مشتریان و کالا). همان پاسخ داشبورد است، پس هر بخش بی‌مجوز `denied` و
 * «آستانهٔ تعریف‌نشده» `unknown` است — نه صفر. شعبه همان اولین شعبهٔ دامنهٔ کاربر است و
 * نامش کنار عدد می‌آید؛ لیبل مد یک شعبهٔ حضوری دارد.
 */
import { useCallback } from "react";
import { useLatestQuery } from "./use-latest-query.ts";
import { pos, type Branch } from "./pos.ts";
import { dashboardOperations, type DashboardOperations } from "./dashboard-operations.ts";

export function useBranchOperations(): { branch: Branch; ops: DashboardOperations } | null {
  const load = useCallback(async (signal: AbortSignal) => {
    const { branches } = await pos.branches({ signal });
    const branch = branches[0];
    if (!branch) return null;
    return { branch, ops: await dashboardOperations.read(branch.id, { signal }) };
  }, []);
  const q = useLatestQuery({ key: "branch-operations", load });
  return q.error ? null : q.data ?? null;
}
