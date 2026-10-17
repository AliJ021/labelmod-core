import { routeUrl, type NavAccess } from "../lib/navigation.ts";
import { PERSONNEL_SECTIONS, personnelView, personnelWriteAccess, type PersonnelKey } from "../lib/personnel-registry.ts";
import { useUrlState } from "../lib/use-url-state.ts";
import { SettingsNavigation, TabPanels, useTabsId, type TabItem } from "../components/Tabs.tsx";
import { useMediaQuery } from "../lib/use-media-query.ts";
import { SettingsBlocked } from "./Settings.tsx";
import { MyWithdrawals } from "./MyWithdrawals.tsx";
import { WithdrawalLog } from "./WithdrawalLog.tsx";
import { MyBonuses } from "./MyBonuses.tsx";
import { BonusLog } from "./BonusLog.tsx";

/**
 * برداشت و پاداش — ناحیهٔ منوی اصلی (خواستهٔ مالک: بیرون از تنظیمات).
 *
 * همان پوسته و قاعدهٔ نمایش تنظیمات (`registryView`): «من»ها برای هر کاربر
 * واردشده؛ دفترهای مدیر فقط با «allow» صریح mount می‌شوند — نه با زبانهٔ
 * پنهان، نه با پیوند مستقیم. سرور همچنان دروازه است.
 *
 * ⚠️ هر دو دفتر فقط ثبت‌اند: هیچ اثری بر صندوق، دفتر حسابداری، انبار یا حقوق.
 */
export function Personnel({ access, currentUserId }: { access: NavAccess; currentUserId: string }) {
  const [requested, setRequested] = useUrlState("personnel.tab");
  const setTab = (key: PersonnelKey) => setRequested(key);
  const tabsId = useTabsId();
  const mobile = useMediaQuery("(max-width: 767px)");
  const view = personnelView(requested === "" ? null : requested, access);
  const tab = view.selected;
  const navItems = PERSONNEL_SECTIONS.flatMap((s): TabItem<PersonnelKey>[] => view.visible.includes(s)
    ? [{ key: s.key, label: s.label, group: s.group }]
    : view.pending.includes(s) ? [{ key: s.key, label: "", pending: true }] : []);
  const panels = view.visible.map(s => ({ key: s.key, label: s.label }));

  return (
    <div className="settings-layout">
      <SettingsNavigation hrefFor={key => routeUrl("personnel", key)} id={tabsId} items={navItems} value={tab} onChange={setTab} mobile={mobile} label="برداشت و پاداش" />
      {view.blocked ? <SettingsBlocked reason={view.blocked} onRetry={access.retry} title="برداشت و پاداش" /> : null}
      <TabPanels id={tabsId} items={panels} value={tab} className="settings-content" mobileLabel={mobile}>
      {tab === "withdrawals" ? (
        <MyWithdrawals key={currentUserId} currentUserId={currentUserId} />
      ) : tab === "bonuses" ? (
        <MyBonuses key={currentUserId} currentUserId={currentUserId} />
      ) : tab === "withdrawal-log" ? (
        <WithdrawalLog key={currentUserId} currentUserId={currentUserId} write={personnelWriteAccess("withdrawal-log", access.verdicts)} writeState={access.state} />
      ) : tab === "bonus-log" ? (
        <BonusLog key={currentUserId} currentUserId={currentUserId} write={personnelWriteAccess("bonus-log", access.verdicts)} writeState={access.state} />
      ) : null}
      </TabPanels>
    </div>
  );
}
