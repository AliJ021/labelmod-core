/**
 * رجیستری بخش‌های «برداشت و پاداش» — ناحیهٔ منوی اصلی (مهاجرت ۰۸۴/۰۸۸/۰۹۸).
 *
 * برداشت پیش‌تر زیر تنظیمات بود؛ خواستهٔ مالک: برداشت و پاداش از تنظیمات
 * بیرون و در منوی اصلی با نقش‌ها. همان قاعدهٔ نمایش تنظیمات (`registryView`):
 * شخصی برای هر کاربر واردشده، مدیریتی فقط با «allow» صریح؛ «نامعلوم» هرگز.
 *
 *   withdrawals     GET /withdrawals/mine — فقط نشست؛ مالک از نشست، نه از درخواست
 *   bonuses         GET /bonuses/mine     — فقط نشست؛ ذی‌نفع از نشست
 *   withdrawal-log  GET /withdrawals (+ نشست کامل، دامنهٔ شعبه)  withdrawal.view_all
 *                   POST …/corrections، …/settlements             withdrawal.correct (`writeAnyOf`)
 *   bonus-log       GET /bonuses (+ نشست کامل، دامنهٔ شعبه)       bonus.view_all
 *                   POST …/decisions، /awards، /settlements       bonus.manage (`writeAnyOf`)
 *
 * ⚠️ نمایش است، نه مجوز: سرور هر درخواست را با `identity.can()` و دامنهٔ شعبه
 *    می‌سنجد و Triggerهای دیتابیس پشت آن‌اند.
 */
import { registryOperations, registryView, registryWriteAccess, type RegistryView, type SettingsScope } from "./settings-registry.ts";

export const PERSONNEL_SECTIONS = [
  { key: "withdrawals", label: "برداشت‌های من", group: "حساب من", scope: "personal", anyOf: [] },
  { key: "bonuses", label: "پاداش‌های من", group: "حساب من", scope: "personal", anyOf: [] },
  { key: "withdrawal-log", label: "دفتر برداشت پرسنل", group: "مدیریت", scope: "admin", anyOf: ["withdrawal.view_all"], writeAnyOf: ["withdrawal.correct"] },
  { key: "bonus-log", label: "دفتر پاداش پرسنل", group: "مدیریت", scope: "admin", anyOf: ["bonus.view_all"], writeAnyOf: ["bonus.manage"] },
] as const satisfies readonly {
  key: string; label: string; group: string; scope: SettingsScope; anyOf: readonly string[]; writeAnyOf?: readonly string[];
}[];
export type PersonnelKey = (typeof PERSONNEL_SECTIONS)[number]["key"];
export type PersonnelSection = (typeof PERSONNEL_SECTIONS)[number];

export const PERSONNEL_OPERATIONS: readonly string[] = registryOperations(PERSONNEL_SECTIONS);

type Verdict = "allow" | "deny" | "unknown";
type Access = { state: "loading" | "ready" | "degraded"; verdicts: ReadonlyMap<string, Verdict> };

export function personnelView(requested: string | null, access: Access): RegistryView<PersonnelSection> {
  return registryView(PERSONNEL_SECTIONS, requested, access);
}
export function personnelWriteAccess(key: PersonnelKey, verdicts: ReadonlyMap<string, Verdict>): Verdict {
  return registryWriteAccess(PERSONNEL_SECTIONS, key, verdicts);
}
export function personnelAnyOf(key: PersonnelKey): readonly string[] {
  return PERSONNEL_SECTIONS.find(s => s.key === key)?.anyOf ?? [];
}

/**
 * پیوند قدیمیِ تنظیمات → نشانی تازه، یا `null` اگر پیوند قدیمی نیست.
 *
 * نشانک‌ها و پیوندهای ذخیره‌شده (`?page=settings&settings.tab=withdrawals`)
 * نمی‌شکنند: زبانه و فیلترهای صفحه (`settings.wd*` → `personnel.wd*`) منتقل
 * می‌شوند و بقیهٔ پارامترها دست‌نخورده می‌مانند. خالص است تا آزمون شود.
 */
const LEGACY_TABS: Readonly<Record<string, PersonnelKey>> = { withdrawals: "withdrawals", "withdrawal-log": "withdrawal-log" };
export function legacyPersonnelUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get("settings.tab");
  if (params.get("page") !== "settings" || tab === null || !(tab in LEGACY_TABS)) return null;
  const next = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "page") next.set("page", "personnel");
    else if (key === "settings.tab") next.set("personnel.tab", LEGACY_TABS[tab]!);
    else if (/^settings\.wd/.test(key)) next.set(`personnel.${key.slice("settings.".length)}`, value);
    else next.append(key, value);
  }
  return `/?${next}`;
}
