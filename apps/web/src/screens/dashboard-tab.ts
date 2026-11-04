/** زبانهٔ بخش داشبورد در نشانی (`dashboard.tab`)؛ تعریف زبانه‌ها در رجیستری ناوبری است. */
import { useUrlTab } from "../lib/use-url-state.ts";
import { dashboardTabs, type DashboardTab, type NavAccess } from "../lib/navigation.ts";

export function useDashboardTab(access: NavAccess) {
  const tabs = dashboardTabs(access.verdicts);
  const [tab, setTab] = useUrlTab<DashboardTab>("dashboard.tab", tabs, "overview");
  return { tabs, tab, setTab };
}
