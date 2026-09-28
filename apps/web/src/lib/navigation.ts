/** Bookmarkable application state; financial drafts remain on the server. */
export const ZONES = [
  { key: "dashboard", label: "داشبورد" }, { key: "pos", label: "صندوق" },
  { key: "invoices", label: "فاکتورها" },
  { key: "returns", label: "مرجوعی" }, { key: "catalog", label: "کالا و قیمت" },
  { key: "purchasing", label: "انبار و خرید" }, { key: "treasury", label: "خزانه و چک" },
  { key: "customers", label: "مشتریان" }, { key: "reports", label: "گزارش‌ها" },
  { key: "settings", label: "تنظیمات" },
] as const;
export type Zone = (typeof ZONES)[number]["key"];

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632)))
    .replace(/[\u200c\u200d\s]+/g, " ").trim();
}

export function routeUrl(zone: Zone, section?: string): string {
  const params = new URLSearchParams({ page: zone });
  if (section) params.set(`${zone}.tab`, section);
  return `/?${params}`;
}

const zonePermissions: Record<Zone, readonly string[]> = {
  dashboard: ["report.view"], pos: ["sale.create"], invoices: ["sale.create", "return.same_day", "return.late"],
  returns: ["return.same_day", "return.late"], catalog: ["catalog.manage"], purchasing: ["stock.receive"],
  treasury: ["treasury.manage"], customers: ["customer.manage"], reports: ["report.view"], settings: ["settings.view"],
};
export interface Feature {label: string; words: string; href: string; anyOf: readonly string[]}
export const FEATURES: readonly Feature[] = [
  ...ZONES.map(z => ({ label: z.label, words: z.label, href: routeUrl(z.key), anyOf: zonePermissions[z.key] })),
  { label: "چاپ فاکتور و پیش‌نویس‌ها", words: "رسید چاپ پیش نویس رهاشده", href: routeUrl("invoices"), anyOf: zonePermissions.invoices },
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
