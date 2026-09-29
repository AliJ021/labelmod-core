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
 * ⚠️ `anyOf: []` یعنی «برای هر کاربر واردشده»:
 *    - داشبورد: خلاصهٔ امروز برای صندوق‌دار هم باز است (`/reports/daily`).
 *    - تنظیمات: PIN و ورود دومرحله‌ای شخصی همین‌جاست و صندوق‌دار
 *      `settings.view` ندارد؛ پنهان‌کردنش راه PIN را می‌بست.
 */
import type { IconName } from "../components/Icon.tsx";

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

/** همهٔ عملیاتی که نمایش ناوبری به آن‌ها وابسته است. */
export const NAV_OPERATIONS: readonly string[] = [...new Set(ZONES.flatMap(z => z.anyOf))];

export type Verdict = "allow" | "deny" | "unknown";

/**
 * کدام مقصدها دیده شوند؟
 *
 * - هنوز نپرسیده یا پاسخ نیامده (`unknown`) → دیده می‌شود. پنهان‌کردن
 *   با خطای شبکه یعنی کاربر راه بخش مجازش را گم کند؛ سرور همچنان
 *   دروازه است.
 * - بخشی که همین حالا باز است همیشه دیده می‌شود، وگرنه زبانهٔ انتخاب‌شده
 *   و پنل نشانی‌اش ناپدید می‌شدند.
 */
export function visibleZones(verdicts: ReadonlyMap<string, Verdict>, current: Zone): NavItem[] {
  return NAV_ITEMS.filter(z => z.key === current || z.anyOf.length === 0 ||
    z.anyOf.some(op => (verdicts.get(op) ?? "unknown") !== "deny"));
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
  { label: "ساخت و تغییر PIN", words: "پین رمز قفل PIN", href: routeUrl("settings", "pin"), anyOf: [] },
  { label: "ورود دومرحله‌ای و پیامک", words: "امنیت پیامک OTP", href: routeUrl("settings", "twofactor"), anyOf: [] },
  { label: "چاپ لیبل بارکد کالا", words: "بارکد لیبل چاپ برچسب", href: "/?page=catalog&catalog.labels=1", anyOf: ["catalog.manage"] },
  { label: "موجودی و گردش کالا", words: "انبار موجودی گردش", href: routeUrl("reports", "stock"), anyOf: ["report.view"] },
  { label: "کدینگ حساب", words: "دفتر حساب کدینگ", href: routeUrl("settings", "accounts"), anyOf: ["settings.view"] },
  { label: "دستگاه‌ها و PIN صندوق", words: "تایید دستگاه صندوق", href: routeUrl("settings", "devices"), anyOf: ["settings.security"] },
  { label: "رسید خرید", words: "خرید تامین کننده رسید", href: routeUrl("purchasing", "receipts"), anyOf: ["stock.receive"] },
  { label: "انبارگردانی", words: "شمارش کسری موجودی", href: routeUrl("purchasing", "count"), anyOf: ["stock.count"] },
  { label: "تنظیم اسنپ‌پی", words: "اسنپ پی پرداخت تسویه", href: routeUrl("settings", "snappay"), anyOf: ["settings.security"] },
  { label: "پشتیبان‌گیری و بازیابی", words: "بکاپ backup دانلود ریستور restore", href: routeUrl("settings", "backups"), anyOf: ["backup.view"] },
];
