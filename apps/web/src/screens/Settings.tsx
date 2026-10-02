import { routeUrl, type NavAccess } from "../lib/navigation.ts";
import { SETTINGS_SECTIONS, settingsView, settingsWriteAccess, type SettingsKey } from "../lib/settings-registry.ts";
import { Icon } from "../components/Icon.tsx";
import { SnappaySettings } from "./SnappaySettings.tsx";
import { WooCommerceSettings } from "./WooCommerceSettings.tsx";
import { Backups } from "./Backups.tsx";
import { useUrlState } from "../lib/use-url-state.ts";
import { SettingsNavigation, TabPanels, useTabsId, type TabItem } from "../components/Tabs.tsx";
import { useMediaQuery } from "../lib/use-media-query.ts";
/**
 * تنظیمات — ناحیه «متوسط» ADR-002: ناوبری بخش‌ها + محتوای **مات**. عددی که
 * تایپ می‌شود و دکمه‌ای که فشرده می‌شود باید پرتضاد باشند، پس فرم‌ها هرگز
 * روی شیشه نمی‌نشینند (گسترش نظام طراحی، دستهٔ ۱).
 *
 * کلیدهای `platform.setting` در `SettingKeys.tsx` است و هیچ کلیدی را
 * hardcode نمی‌کند؛ همه از `GET /settings` می‌آیند.
 */
import { Solid } from "../components/Glass.tsx";
import { SettingKeys } from "./SettingKeys.tsx";
import { Accounts } from "./Accounts.tsx";
import { PostingRules } from "./PostingRules.tsx";
import { Health } from "./Health.tsx";
import { Terminals } from "./Terminals.tsx";
import { Permissions } from "./Permissions.tsx";
import { Opening } from "./Opening.tsx";
import { Devices } from "./Devices.tsx";
import { Appearance } from "./Appearance.tsx";
import { Staff } from "./Staff.tsx";
import { TwoFactor } from "./TwoFactor.tsx";
import { PersonalPin } from "./PersonalPin.tsx";

/**
 * پوسته ناحیه تنظیمات — ده زیرتب.
 *
 * چرا زیرتب و نه ناحیه سطح‌بالا: نوار بالای صفحه را صندوق‌دار هم
 * می‌بیند، و سه تبِ تازه‌ای که اجازه بازکردنشان را ندارد فقط شلوغی
 * است. این سه پشت `settings.security`‌اند و جایشان همین‌جاست.
 *
 * فهرست زیرتب‌ها اینجا نوشته شده چون **صفحه‌اند، نه داده** — برخلاف
 * کلیدهای تنظیمات که از سرور می‌آیند. اگر روزی صفحه تازه‌ای اضافه شود،
 * یک ردیف اینجا اضافه می‌شود؛ ولی هیچ‌کدام از این چهار صفحه محتوایش را
 * hardcode نمی‌کند.
 */
/**
 * بخش‌ها از `lib/settings-registry.ts` می‌آیند: شخصی جدا از مدیریتی، و هر
 * بخش مدیریتی با همان عملیاتی که سرور برای خواندنش می‌سنجد (F-110-02).
 *
 * هیچ بخش مدیریتی بی پاسخ صریح «allow» **mount نمی‌شود** — نه با انتخاب
 * زبانهٔ پنهان، نه با پیوند مستقیم. پیوند مستقیم به بخش ردشده برچسبش را در
 * ناوبری نشان نمی‌دهد و فقط پیام «دسترسی ندارید» می‌گیرد؛ تا پاسخ نیامده
 * «در حال بررسی» است و اگر نرسید، «بررسی دوباره». سرور همچنان دروازه است.
 */
export function Settings({ access, currentUserId, onOwnPassword }: { access: NavAccess; currentUserId: string; onOwnPassword: () => void }) {
  const [requested, setRequested] = useUrlState("settings.tab");
  const setTab = (key: SettingsKey) => setRequested(key);
  const tabsId = useTabsId();
  const mobile = useMediaQuery("(max-width: 767px)");
  const view = settingsView(requested === "" ? null : requested, access);
  const tab = view.selected;
  const navItems = SETTINGS_SECTIONS.flatMap((s): TabItem<SettingsKey>[] => view.visible.includes(s)
    ? [{ key: s.key, label: s.label, group: s.group }]
    : view.pending.includes(s) ? [{ key: s.key, label: "", pending: true }] : []);
  const panels = view.visible.map(s => ({ key: s.key, label: s.label }));

  return (
    <div className="settings-layout">
      <SettingsNavigation hrefFor={key => routeUrl("settings", key)} id={tabsId} items={navItems} value={tab} onChange={setTab} mobile={mobile} />
      {view.blocked ? <SettingsBlocked reason={view.blocked} onRetry={access.retry} /> : null}
      <TabPanels id={tabsId} items={panels} value={tab} className="settings-content" mobileLabel={mobile}>

      {tab === "keys" ? (
        <SettingKeys onOpenTerminals={() => setTab("terminals")} />
      ) : tab === "appearance" ? (
        <Appearance />
      ) : tab === "accounts" ? (
        <Accounts />
      ) : tab === "mapping" ? (
        <PostingRules />
      ) : tab === "snappay" ? (
        <SnappaySettings write={settingsWriteAccess("snappay", access.verdicts)} writeState={access.state} />
      ) : tab === "woocommerce" ? (
        <WooCommerceSettings />
      ) : tab === "backups" ? (
        <Backups />
      ) : tab === "terminals" ? (
        <Terminals />
      ) : tab === "permissions" ? (
        <Permissions />
      ) : tab === "staff" ? (
        <Staff currentUserId={currentUserId} onOwnPassword={onOwnPassword} />
      ) : tab === "pin" ? (
        <PersonalPin />
      ) : tab === "twofactor" ? (
        <TwoFactor />
      ) : tab === "devices" ? (
        <Devices />
      ) : tab === "health" ? (
        <Health />
      ) : tab === "opening" ? (
        <Opening />
      ) : null}
      </TabPanels>
    </div>
  );
}

/** چرا بخشی mount نشد — هر سه حالت آرام و بی‌اثر؛ هیچ‌کدام درخواستی به بخش نمی‌فرستد. */
function SettingsBlocked({ reason, onRetry }: { reason: "loading" | "degraded" | "denied"; onRetry: () => void }) {
  if (reason === "loading") return <Solid as="section" className="pad settings-content settings-state" aria-labelledby="settings-state-title">
    <h2 id="settings-state-title" className="sr-only">تنظیمات</h2>
    <p className="muted" role="status">در حال بررسی دسترسی…</p>
  </Solid>;
  if (reason === "degraded") return <Solid as="section" className="pad settings-content settings-state" aria-labelledby="settings-state-title">
    <h2 id="settings-state-title">دسترسی این بخش بررسی نشد</h2>
    <p className="muted" role="status">پاسخ سرور نرسید؛ تا بررسی نشود این بخش باز نمی‌شود.</p>
    <button type="button" className="btn" onClick={onRetry}>بررسی دوباره</button>
  </Solid>;
  return <Solid as="section" className="pad settings-content settings-state" aria-labelledby="settings-state-title">
    <h2 id="settings-state-title"><Icon name="lock" /> دسترسی ندارید</h2>
    <p className="muted">این بخش تنظیمات برای نقش شما باز نیست. اگر لازمش دارید، از مدیر بخواهید.</p>
  </Solid>;
}
