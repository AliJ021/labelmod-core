/**
 * تازگی داده‌های داشبورد — منطق خالص، بی React (test/dashboard-freshness.test.ts).
 *
 * داشبورد دادهٔ «امروز» را نشان می‌دهد و صندوق در همین لحظه فروش ثبت می‌کند؛ پس عدد روی صفحه
 * باید بگوید **از کی** است. پنج حالت از هم جدا می‌مانند و هیچ‌کدام سبزِ ساختگی نیست:
 *
 *   loading     هنوز هیچ خواندن موفقی نیست (اسکلت صفحه، نه «۰»).
 *   refreshing  داده‌های قبلی می‌مانند؛ خواندن تازه در راه است.
 *   failed      آخرین به‌روزرسانی ناموفق بود؛ داده‌ها از «ساعت X» اند و این صریح گفته می‌شود.
 *   offline     مرورگر قطعی آشکار شبکه را می‌بیند؛ به‌روزرسانی خودکار تا وصل‌شدن منتظر است.
 *   stale       موفق بود، ولی بیش از STALE_MS گذشته (مثلاً زبانه پنهان بوده).
 *   fresh       موفق و تازه.
 *
 * زمان‌بندی خودکار فقط وقتی صفحه دیده می‌شود: هر REFRESH_MS، و پس از شکست با Backoff نمایی
 * تا MAX_BACKOFF_MS — شکست پیاپی سرور را با درخواست نمی‌کوبد.
 */
export const REFRESH_MS = 60_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
export const STALE_MS = 3 * 60_000;

export type Freshness =
  | { kind: "loading" }
  | { kind: "refreshing"; at: number }
  | { kind: "failed"; at: number; reference: string | null }
  | { kind: "offline"; at: number }
  | { kind: "stale"; at: number }
  | { kind: "fresh"; at: number };

/** فاصلهٔ تلاش بعدی پس از `failures` شکست پیاپی (صفر = عادی). */
export function nextDelay(failures: number): number {
  if (failures <= 0) return REFRESH_MS;
  return Math.min(MAX_BACKOFF_MS, REFRESH_MS * 2 ** Math.min(failures, 10));
}

/** چقدر تا تلاش بعدی مانده (هرگز منفی نیست؛ صفر یعنی همین حالا). */
export function dueIn(now: number, lastAttempt: number | null, failures: number): number {
  if (lastAttempt === null) return 0;
  return Math.max(0, lastAttempt + nextDelay(failures) - now);
}

export function freshness(input: {
  now: number; lastOk: number | null; online: boolean; refreshing: boolean;
  failure: { reference: string | null } | null;
}): Freshness {
  const { now, lastOk, online, refreshing, failure } = input;
  if (lastOk === null) return { kind: "loading" };
  if (!online) return { kind: "offline", at: lastOk };
  if (refreshing) return { kind: "refreshing", at: lastOk };
  if (failure) return { kind: "failed", at: lastOk, reference: failure.reference };
  if (now - lastOk > STALE_MS) return { kind: "stale", at: lastOk };
  return { kind: "fresh", at: lastOk };
}

const FA = new Intl.NumberFormat("fa-IR", { useGrouping: false });
const CLOCK = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** «۱۰:۴۲» — ساعت محلی همین دستگاه (لحظه است، نه تاریخ کاری). */
export function formatClock(ms: number): string {
  return CLOCK.format(new Date(ms));
}

/** «همین حالا» / «۳ دقیقه پیش» / «۲ ساعت پیش» — بی ادعای دقتی بیش از دقیقه. */
export function ageText(now: number, at: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "همین حالا";
  if (minutes < 60) return `${FA.format(minutes)} دقیقه پیش`;
  return `${FA.format(Math.floor(minutes / 60))} ساعت پیش`;
}
