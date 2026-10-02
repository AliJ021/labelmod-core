/**
 * رجیستری واحد ناوبری — یک طبقه‌بندی، چند نمایش (docs/UI_PATTERNS.md، «ناوبری»).
 *
 * نوار کناری دسکتاپ، نوار پایین موبایل، برگهٔ «بیشتر» و جست‌وجوی بخش‌ها
 * همه از همین فهرست ساخته می‌شوند. مقصد تازه یعنی یک سطر اینجا، نه
 * سه ویرایش در سه کامپوننت.
 *
 * `anyOf` فقط برای **نمایش** است: مقصدی که کاربر هیچ‌کدام از
 * عملیاتش را ندارد پنهان می‌شود تا رد سرور تجربهٔ عادی نباشد. دروازهٔ
 * واقعی همچنان `identity.can()` در سرور است؛ اینجا هیچ تصمیم دسترسی
 * گرفته نمی‌شود که سرور دوباره نگیرد.
 *
 * ⚠️ نمایش **محافظه‌کار** است (یافتهٔ F-110-01): مقصد مجوزدار فقط با پاسخ
 *    صریح «allow» دیده می‌شود. «نامعلوم» — پیش از پاسخ یا پس از خطای شبکه —
 *    هرگز «مجاز» تعبیر نمی‌شود؛ وگرنه کل طبقه‌بندی مدیریتی پیش از پاسخ
 *    سرور به صندوق‌دار نشان داده می‌شد و با خطای شبکه همان‌جا می‌ماند.
 *
 * ⚠️ `anyOf: []` یعنی «برای هر کاربر واردشده»:
 *    - داشبورد: خلاصهٔ امروز برای صندوق‌دار هم باز است (`/reports/daily`).
 *    - تنظیمات: بخش‌های شخصی (نمایش، PIN، ورود دومرحله‌ای) برای همه است؛
 *      بخش‌های مدیریتی درون آن از `settings-registry.ts` جدا سنجیده می‌شوند.
 */
import type { IconName } from "../components/Icon.tsx";
import { SETTINGS_OPERATIONS, settingsAnyOf } from "./settings-registry.ts";

export const NAV_GROUPS = [
  { key: "daily", label: "کار روزانه" },
  { key: "stock", label: "کالا و انبار" },
  { key: "money", label: "مالی و گزارش" },
  { key: "people", label: "اشخاص" },
  { key: "system", label: "سامانه" },
] as const;
export type NavGroup = (typeof NAV_GROUPS)[number]["key"];

/** Bookmarkable application state; financial drafts remain on the server. */
export const ZONES = [
  { key: "dashboard", label: "داشبورد", icon: "dashboard", navGroup: "daily", mobilePrimary: true, anyOf: [] },
  { key: "pos", label: "صندوق", icon: "register", navGroup: "daily", mobilePrimary: true, anyOf: ["sale.create"] },
  { key: "invoices", label: "فاکتورها", icon: "receipt", navGroup: "daily", mobilePrimary: true, anyOf: ["sale.create", "return.same_day", "return.late"] },
  { key: "returns", label: "مرجوعی", icon: "return", navGroup: "daily", mobilePrimary: false, anyOf: ["return.same_day", "return.late"] },
  { key: "catalog", label: "کالا و قیمت", icon: "tag", navGroup: "stock", mobilePrimary: true, anyOf: ["catalog.manage"] },
  { key: "purchasing", label: "انبار و خرید", icon: "box", navGroup: "stock", mobilePrimary: false, anyOf: ["stock.receive"] },
  { key: "treasury", label: "خزانه و چک", icon: "vault", navGroup: "money", mobilePrimary: false, anyOf: ["treasury.manage"] },
  { key: "customers", label: "مشتریان", icon: "people", navGroup: "people", mobilePrimary: false, anyOf: ["customer.manage"] },
  { key: "reports", label: "گزارش‌ها", icon: "chart", navGroup: "money", mobilePrimary: false, anyOf: ["report.view"] },
  { key: "settings", label: "تنظیمات", icon: "settings", navGroup: "system", mobilePrimary: false, anyOf: [] },
] as const satisfies readonly {
  key: string; label: string; icon: IconName; navGroup: NavGroup; mobilePrimary: boolean; anyOf: readonly string[];
}[];
export type Zone = (typeof ZONES)[number]["key"];
export type ZoneEntry = (typeof ZONES)[number];

/**
 * ترتیب نمایش ناوبری: گروه به گروه، و داخل گروه همان ترتیب ZONES.
 * سرعنوان گروه از `group` می‌آید و TabList خودش آن را می‌کشد.
 */
export type NavItem = ZoneEntry & { group: string };
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap(g =>
  ZONES.filter(z => z.navGroup === g.key).map(z => ({ ...z, group: g.label })));

/** همهٔ عملیاتی که نمایش ناوبری به آن‌ها وابسته است — مقصدها و بخش‌های تنظیمات. */
export const NAV_OPERATIONS: readonly string[] = [...new Set([...ZONES.flatMap(z => z.anyOf), ...SETTINGS_OPERATIONS])];

export type Verdict = "allow" | "deny" | "unknown";

/**
 * وضعیت پاسخ‌های مجوز، نه فقط خودِ پاسخ‌ها:
 *   loading   هنوز همهٔ پرسش‌ها برنگشته‌اند.
 *   ready     همه برگشتند (allow یا deny).
 *   degraded  دست‌کم یکی نرسید؛ همان «نامعلوم» می‌ماند و پنهان است.
 */
export type AccessState = "loading" | "ready" | "degraded";
export interface NavAccess {
  state: AccessState;
  verdicts: ReadonlyMap<string, Verdict>;
  retry: () => void;
}

/**
 * دسترسی به یک مقصد از روی `anyOf`:
 *   allow    بی‌شرط (`[]`) یا دست‌کم یک عملیات صریحاً مجاز
 *   deny     همهٔ عملیات صریحاً رد
 *   unknown  هنوز پاسخ نیامده یا نرسیده — **نه** مجاز
 */
export function accessOf(anyOf: readonly string[], verdicts: ReadonlyMap<string, Verdict>): Verdict {
  if (anyOf.length === 0 || anyOf.some(op => verdicts.get(op) === "allow")) return "allow";
  return anyOf.every(op => verdicts.get(op) === "deny") ? "deny" : "unknown";
}

/**
 * کدام مقصدها دیده شوند؟ فقط «allow» — با یک استثنا: بخشی که همین حالا
 * باز است دیده می‌شود، وگرنه زبانهٔ انتخاب‌شده و پنل نشانی‌اش ناپدید
 * می‌شدند. آن بخش را کاربر خودش باز کرده؛ برچسبش افشای تازه‌ای نیست و
 * سرور همچنان دادهٔ پشتش را می‌سنجد.
 */
export function visibleZones(verdicts: ReadonlyMap<string, Verdict>, current: Zone): NavItem[] {
  return NAV_ITEMS.filter(z => z.key === current || accessOf(z.anyOf, verdicts) === "allow");
}

/**
 * جای‌نگهدارهای «در حال بررسی»: مقصدهای مجوزداری که هنوز پاسخ ندارند، فقط
 * در `loading`. برچسب و گروهشان نشان داده نمی‌شود (همان افشایی که
 * بسته شد)؛ فقط جایشان تا نوار با آمدن پاسخ جابه‌جا نشود.
 */
export function pendingZones(access: Pick<NavAccess, "state" | "verdicts">, current: Zone): NavItem[] {
  if (access.state !== "loading") return [];
  return NAV_ITEMS.filter(z => z.key !== current && accessOf(z.anyOf, access.verdicts) === "unknown");
}

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632)))
    .replace(/[‌‍\s]+/g, " ").trim();
}

export function routeUrl(zone: Zone, section?: string): string {
  const params = new URLSearchParams({ page: zone });
  if (section) params.set(`${zone}.tab`, section);
  return `/?${params}`;
}

function zoneOps(zone: Zone): readonly string[] {
  return ZONES.find(z => z.key === zone)?.anyOf ?? [];
}
export interface Feature {label: string; words: string; href: string; anyOf: readonly string[]}
export const FEATURES: readonly Feature[] = [
  ...ZONES.map(z => ({ label: z.label, words: z.label, href: routeUrl(z.key), anyOf: z.anyOf })),
  { label: "چاپ فاکتور و پیش‌نویس‌ها", words: "رسید چاپ پیش نویس رهاشده", href: routeUrl("invoices"), anyOf: zoneOps("invoices") },
  { label: "فروش هر کاربر", words: "صندوق دار فروشنده ثبت کننده نهایی کننده", href: routeUrl("reports", "staff"), anyOf: ["report.view"] },
  { label: "ساخت و تغییر PIN", words: "پین رمز قفل PIN", href: routeUrl("settings", "pin"), anyOf: settingsAnyOf("pin") },
  { label: "ورود دومرحله‌ای و پیامک", words: "امنیت پیامک OTP", href: routeUrl("settings", "twofactor"), anyOf: settingsAnyOf("twofactor") },
  { label: "برداشت‌های من", words: "برداشت مساعده دریافت شخصی ثبت برداشت", href: routeUrl("settings", "withdrawals"), anyOf: settingsAnyOf("withdrawals") },
  { label: "دفتر برداشت پرسنل", words: "برداشت پرسنل کارکنان مساعده اصلاح مدیر", href: routeUrl("settings", "withdrawal-log"), anyOf: settingsAnyOf("withdrawal-log") },
  { label: "چاپ لیبل بارکد کالا", words: "بارکد لیبل چاپ برچسب", href: "/?page=catalog&catalog.labels=1", anyOf: ["catalog.manage"] },
  { label: "موجودی و گردش کالا", words: "انبار موجودی گردش", href: routeUrl("reports", "stock"), anyOf: ["report.view"] },
  { label: "کدینگ حساب", words: "دفتر حساب کدینگ", href: routeUrl("settings", "accounts"), anyOf: settingsAnyOf("accounts") },
  { label: "دستگاه‌ها و PIN صندوق", words: "تایید دستگاه صندوق", href: routeUrl("settings", "devices"), anyOf: settingsAnyOf("devices") },
  { label: "رسید خرید", words: "خرید تامین کننده رسید", href: routeUrl("purchasing", "receipts"), anyOf: ["stock.receive"] },
  { label: "انبارگردانی", words: "شمارش کسری موجودی", href: routeUrl("purchasing", "count"), anyOf: ["stock.count"] },
  { label: "تنظیم اسنپ‌پی", words: "اسنپ پی پرداخت تسویه", href: routeUrl("settings", "snappay"), anyOf: settingsAnyOf("snappay") },
  { label: "پشتیبان‌گیری و بازیابی", words: "بکاپ backup دانلود ریستور restore", href: routeUrl("settings", "backups"), anyOf: settingsAnyOf("backups") },
];

/**
 * کارهای پرتکرار داشبورد — از همین رجیستری، نه فهرست جدا (دستهٔ ۱ گسترش).
 *
 * `anyOf` هر کار از **مقصدش** می‌آید (`zoneOps` یا همان سطر `FEATURES`)، پس
 * هیچ عملیات تازه‌ای پرسیده نمی‌شود و معماری مجوز دومی ساخته نمی‌شود. همان
 * قاعدهٔ محافظه‌کار ناوبری: فقط allow صریح دیده می‌شود؛ پیش از پاسخ فقط
 * جای‌نگهدار بی‌برچسب؛ پس از خطا پنهان با پیام آرام. سرور همچنان دروازه است.
 */
export interface QuickAction { key: string; href: string; name: string; icon: IconName; anyOf: readonly string[] }
export const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: "new-sale", href: routeUrl("pos"), name: "فروش جدید", icon: "register", anyOf: zoneOps("pos") },
  { key: "drafts", href: "/?page=invoices&invoices.status=draft", name: "رسیدگی به پیش‌نویس‌ها", icon: "receipt", anyOf: zoneOps("invoices") },
  { key: "labels", href: "/?page=catalog&catalog.labels=1", name: "چاپ لیبل بارکد", icon: "print", anyOf: FEATURES.find(f => f.href === "/?page=catalog&catalog.labels=1")?.anyOf ?? zoneOps("catalog") },
  { key: "invoices", href: routeUrl("invoices"), name: "فاکتورها و چاپ رسید", icon: "receipt", anyOf: zoneOps("invoices") },
];

export interface QuickActionView {
  /** فقط کارهای صریحاً مجاز. */
  visible: QuickAction[];
  /** تعداد جای‌نگهدار بی‌برچسب — فقط در `loading`. */
  pending: number;
  /** پاسخ بعضی رسید نه؛ آن کارها پنهان‌اند و پیام «بررسی دوباره» لازم است. */
  degraded: boolean;
}
export function quickActionView(access: Pick<NavAccess, "state" | "verdicts">): QuickActionView {
  const verdict = (a: QuickAction) => accessOf(a.anyOf, access.verdicts);
  const unknown = QUICK_ACTIONS.filter(a => verdict(a) === "unknown").length;
  return {
    visible: QUICK_ACTIONS.filter(a => verdict(a) === "allow"),
    pending: access.state === "loading" ? unknown : 0,
    degraded: access.state === "degraded" && unknown > 0,
  };
}
