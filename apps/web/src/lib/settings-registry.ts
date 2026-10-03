/**
 * رجیستری واحد بخش‌های تنظیمات — شخصی جدا از مدیریتی (یافتهٔ F-110-02).
 *
 * ناوبری تنظیمات، انتخاب زبانه، پیوند مستقیم و جست‌وجوی بخش‌ها همه از
 * همین فهرست می‌خوانند. بخش تازه یعنی یک سطر اینجا با عملیاتی که **سرور**
 * برای بارگذاری همان صفحه می‌سنجد؛ نه حدس، نه نام نقش.
 *
 * شخصی (`anyOf: []`): برای هر کاربر واردشده، چون دادهٔ خودِ اوست.
 *   appearance  فقط مرورگر؛ هیچ درخواستی به سرور ندارد.
 *   pin         GET/POST /auth/pin — فقط نشست، روی کاربر خودش.
 *   twofactor   /auth/2fa و /auth/2fa/sms/* — فقط نشست، روی کاربر خودش.
 *   withdrawals /withdrawals/mine — فقط نشست؛ مالک از نشست، نه از درخواست (۰۸۴).
 *
 * مدیریتی: عملیات همان است که مسیر **خواندنِ** آن صفحه در API می‌سنجد
 * (`requireForSession` یا `guard`). تغییر در بعضی بخش‌ها مجوز سخت‌تری دارد
 * (مثلاً `settings.security`) و خود صفحه آن را با `canEdit` نشان می‌دهد.
 *   keys         GET /settings                       settings.view
 *   health       GET /health/alerts، /dead-letters   settings.view
 *   backups      GET /backups (+ نشست کامل، همهٔ شعب) backup.view
 *   accounts     GET /accounts                       settings.view
 *   mapping      GET /posting-rules                  settings.view
 *   snappay      GET /snappay/config (+ همهٔ شعب)     settings.view
 *                PUT همان مسیر                        settings.security (`writeAnyOf`)
 *   terminals    GET /settlement-terms، /terminal-drivers، /device-drivers  settings.view
 *   opening      GET /tafsili (ثبت: settings.security)  settings.view
 *   staff        GET /users، /roles                  user.manage
 *   withdrawal-log GET /withdrawals (+ نشست کامل، دامنهٔ شعبه)  withdrawal.view_all
 *                POST …/corrections                   withdrawal.correct (`writeAnyOf`)
 *   permissions  GET /permission-rules               settings.security
 *   devices      GET /devices، /sessions             device.manage
 *
 * ⚠️ این فقط هم‌راستایی نمایش است، نه جایگزین مجوز: سرور همچنان هر درخواست
 *    را می‌سنجد، و دامنهٔ شعبه (بکاپ، اسنپ‌پی) هم فقط در سرور است.
 */
export type SettingsScope = "personal" | "admin";

export const SETTINGS_SECTIONS = [
  { key: "appearance", label: "نمایش و عملکرد", group: "حساب من", scope: "personal", anyOf: [] },
  { key: "pin", label: "PIN من — ساخت و تغییر", group: "حساب من", scope: "personal", anyOf: [] },
  { key: "twofactor", label: "ورود دومرحله‌ای", group: "حساب من", scope: "personal", anyOf: [] },
  { key: "withdrawals", label: "برداشت‌های من", group: "حساب من", scope: "personal", anyOf: [] },
  { key: "keys", label: "تنظیمات", group: "عمومی", scope: "admin", anyOf: ["settings.view"] },
  { key: "health", label: "سلامت سیستم", group: "عمومی", scope: "admin", anyOf: ["settings.view"] },
  { key: "woocommerce", label: "اتصال ووکامرس", group: "عمومی", scope: "admin", anyOf: ["settings.view"] },
  { key: "backups", label: "پشتیبان‌گیری و بازیابی", group: "عمومی", scope: "admin", anyOf: ["backup.view"] },
  { key: "accounts", label: "کدینگ حساب", group: "مالی و فروش", scope: "admin", anyOf: ["settings.view"] },
  { key: "mapping", label: "نگاشت حساب", group: "مالی و فروش", scope: "admin", anyOf: ["settings.view"] },
  { key: "snappay", label: "اسنپ‌پی", group: "مالی و فروش", scope: "admin", anyOf: ["settings.view"], writeAnyOf: ["settings.security"] },
  { key: "digipay", label: "دیجی‌پی", group: "مالی و فروش", scope: "admin", anyOf: ["settings.view"], writeAnyOf: ["settings.security"] },
  { key: "terminals", label: "پایانه‌ها", group: "مالی و فروش", scope: "admin", anyOf: ["settings.view"] },
  { key: "opening", label: "افتتاحیه و تفصیلی", group: "مالی و فروش", scope: "admin", anyOf: ["settings.view"] },
  { key: "staff", label: "پرسنل", group: "کاربران و امنیت", scope: "admin", anyOf: ["user.manage"] },
  { key: "withdrawal-log", label: "دفتر برداشت پرسنل", group: "کاربران و امنیت", scope: "admin", anyOf: ["withdrawal.view_all"], writeAnyOf: ["withdrawal.correct"] },
  { key: "permissions", label: "مجوزها", group: "کاربران و امنیت", scope: "admin", anyOf: ["settings.security"] },
  { key: "devices", label: "دستگاه‌ها", group: "کاربران و امنیت", scope: "admin", anyOf: ["device.manage"] },
] as const satisfies readonly {
  key: string; label: string; group: string; scope: SettingsScope; anyOf: readonly string[];
  /**
   * بخشی که صفحه‌اش خودش (نه ردیف‌به‌ردیف از پاسخ سرور، مثل `canEdit`) فرم
   * تغییر دارد و مسیر **نوشتنش** مجوز سخت‌تری از خواندن می‌خواهد (B1-02).
   */
  writeAnyOf?: readonly string[];
}[];
export type SettingsKey = (typeof SETTINGS_SECTIONS)[number]["key"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** عملیاتی که نمایش تنظیمات به آن وابسته است؛ همراه پرسش‌های ناوبری فرستاده می‌شود. */
export const SETTINGS_OPERATIONS: readonly string[] = [...new Set(SETTINGS_SECTIONS.flatMap(s => [...s.anyOf, ...writeOps(s)]))];

export function settingsAnyOf(key: SettingsKey): readonly string[] {
  return SETTINGS_SECTIONS.find(s => s.key === key)?.anyOf ?? [];
}

function writeOps(section: SettingsSection): readonly string[] {
  return "writeAnyOf" in section ? section.writeAnyOf : [];
}

type Verdict = "allow" | "deny" | "unknown";
function opsAccess(ops: readonly string[], verdicts: ReadonlyMap<string, Verdict>): Verdict {
  if (ops.length === 0 || ops.some(op => verdicts.get(op) === "allow")) return "allow";
  return ops.every(op => verdicts.get(op) === "deny") ? "deny" : "unknown";
}
function sectionAccess(section: SettingsSection, verdicts: ReadonlyMap<string, Verdict>): Verdict {
  return opsAccess(section.anyOf, verdicts);
}

/**
 * آیا فرم **تغییر** این بخش نشان داده شود؟ فقط `allow` صریح؛ «در حال بررسی»
 * و «بررسی نشد» (`unknown`) مثل «رد» فقط‌خواندنی‌اند و هرگز لحظه‌ای کنترل
 * قابل‌نوشتن نمی‌سازند. بخشی که `writeAnyOf` ندارد، همان مجوز خواندن را دارد.
 * سرور همچنان دروازهٔ واقعی است (B1-02).
 */
export function settingsWriteAccess(key: SettingsKey, verdicts: ReadonlyMap<string, Verdict>): Verdict {
  const section = SETTINGS_SECTIONS.find(s => s.key === key);
  if (!section) return "deny";
  const ops = writeOps(section);
  return opsAccess(ops.length > 0 ? ops : section.anyOf, verdicts);
}

/**
 * تصمیم نمایش تنظیمات برای یک نشانی:
 *
 *   visible   فقط بخش‌های صریحاً مجاز (شخصی همیشه).
 *   pending   بخش‌های مدیریتیِ بی‌پاسخ، فقط در `loading` — برای جای‌نگهدار.
 *   selected  بخشی که **mount می‌شود**؛ هرگز بخشی که «allow» ندارد.
 *   blocked   چرا چیزی mount نشد: هنوز در حال بررسی، بررسی نشد، یا رد شد.
 *
 * بدون `settings.tab`: پیش‌فرض نخستین بخش مدیریتی مجاز است، وگرنه نخستین
 * بخش شخصی. تا پاسخ نیامده پیش‌فرض انتخاب نمی‌شود، تا مدیر یک لحظه صفحهٔ
 * شخصی نبیند و بعد به «تنظیمات» بپرد.
 */
export interface SettingsView {
  visible: SettingsSection[];
  pending: SettingsSection[];
  selected: SettingsKey | null;
  blocked: "loading" | "degraded" | "denied" | null;
}
export function settingsView(requested: string | null, access: { state: "loading" | "ready" | "degraded"; verdicts: ReadonlyMap<string, Verdict> }): SettingsView {
  const verdicts = access.verdicts;
  const visible = SETTINGS_SECTIONS.filter(s => sectionAccess(s, verdicts) === "allow");
  const pending = access.state === "loading" ? SETTINGS_SECTIONS.filter(s => sectionAccess(s, verdicts) === "unknown") : [];
  const target = SETTINGS_SECTIONS.find(s => s.key === requested);
  if (target) {
    const verdict = sectionAccess(target, verdicts);
    if (verdict === "allow") return { visible, pending, selected: target.key, blocked: null };
    if (verdict === "deny") return { visible, pending, selected: null, blocked: "denied" };
    return { visible, pending, selected: null, blocked: access.state === "loading" ? "loading" : "degraded" };
  }
  if (access.state === "loading") return { visible, pending, selected: null, blocked: "loading" };
  const fallback = visible.find(s => s.scope === "admin") ?? visible[0];
  return { visible, pending, selected: fallback?.key ?? null, blocked: fallback ? null : "degraded" };
}
