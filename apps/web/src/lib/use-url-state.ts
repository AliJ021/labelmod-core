import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * وضعیت نشانی — تنها راه جابه‌جایی داخلی برنامه (ناحیه، زبانه، فیلتر).
 *
 * **نگهبان ترک صفحه** هم همین‌جاست، نه در هر صفحه (یافتهٔ B1-01): هر
 * جابه‌جایی داخلی از `navigate()` می‌گذرد و «بازگشت/جلو»ی مرورگر از شنوندهٔ
 * `popstate` همین ماژول. پس پرسش «تغییرات ذخیره‌نشده دور ریخته شود؟»
 * **پیش از** اعلام تغییر نشانی به React پرسیده می‌شود — یعنی پیش از آنکه
 * صفحهٔ دارای پیش‌نویس Unmount شود. لغو یعنی هیچ اتفاقی نیفتاده است.
 *
 * بارگذاری دوباره و بستن زبانه با `beforeunload` همان نگهبان پوشش می‌گیرد.
 */
const changed = "labelmod:navigation";

interface Guard { message: string }
const guards = new Set<Guard>();
/** آخرین نشانیِ پذیرفته‌شده؛ لغوِ «بازگشت» مرورگر به همین برمی‌گردد. */
let committed: string | null = null;
let listening = false;

/** `true` یعنی جابه‌جایی مجاز است؛ با نگهبان فعال، از کاربر پرسیده می‌شود. */
function mayLeave(): boolean {
  const first = guards.values().next();
  return first.done ? true : window.confirm(first.value.message);
}

/** شکل مسیر برنامه: فقط مسیر و پرس‌وجو؛ پرش به `#…` (مثل «رفتن به محتوا») جابه‌جایی نیست. */
const route = (href: string) => { const u = new URL(href); return u.pathname + u.search; };

function onPopState() {
  const previous = committed ?? window.location.href;
  if (route(previous) !== route(window.location.href) && !mayLeave()) {
    // مرورگر نشانی را پیش از این رویداد عوض کرده است؛ همان صفحه را برمی‌گردانیم
    // و به React هیچ تغییری اعلام نمی‌شود — پیش‌نویس و دلیل دست‌نخورده می‌مانند.
    window.history.pushState(window.history.state, "", previous);
    return;
  }
  committed = window.location.href;
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  if (!listening) {
    listening = true;
    committed = window.location.href;
    window.addEventListener("popstate", onPopState);
  }
  window.addEventListener(changed, listener);
  return () => { window.removeEventListener(changed, listener); };
}
const snapshot = () => window.location.search;

/**
 * `force` فقط برای جابه‌جایی‌ای که پس از پایان نشست رخ می‌دهد (خروج، تغییر
 * رمز): آنجا پوسته از قبل Unmount شده و چیزی برای نگه‌داشتن نمانده است.
 */
export function navigate(href: string, replace = false, force = false): void {
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin) return;
  if (target.href === window.location.href) return;
  if (!force && !mayLeave()) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", target);
  committed = window.location.href;
  window.dispatchEvent(new Event(changed));
}

/**
 * نگهبان پیش‌نویس: تا `active` است، هر جابه‌جایی داخلی، بازگشت مرورگر،
 * بارگذاری دوباره و بستن زبانه پیش از دور ریختن تأیید می‌خواهد. با
 * غیرفعال‌شدن یا Unmount، هیچ نگهبان یا شنونده‌ای باقی نمی‌ماند.
 */
export function useNavigationGuard(active: boolean, message: string): void {
  useEffect(() => {
    if (!active) return;
    const guard: Guard = { message };
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    guards.add(guard);
    window.addEventListener("beforeunload", warn);
    return () => { guards.delete(guard); window.removeEventListener("beforeunload", warn); };
  }, [active, message]);
}

export function useUrlState(key: string, fallback = "", replace = false): [string, (value: string) => void] {
  const search = useSyncExternalStore(subscribe, snapshot, () => "");
  const value = new URLSearchParams(search).get(key) ?? fallback;
  const set = useCallback((next: string) => {
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key); else url.searchParams.set(key, next);
    navigate(url.href, replace);
  }, [key, fallback, replace]);
  return [value, set];
}

export function useUrlTab<K extends string>(key: string, items: readonly { key: K }[], fallback: K): [K, (value: K) => void] {
  const [raw, set] = useUrlState(key, fallback);
  return [items.find(item => item.key === raw)?.key ?? fallback, set];
}

export function useUrlFlag(key: string): [boolean, (value: boolean) => void] {
  const [value,setValue]=useUrlState(key);
  const set=useCallback((next:boolean)=>setValue(next?"1":""),[setValue]);
  return [value==="1",set];
}

/** مسیر جاری؛ فقط برای مسیرهای خارج از `?page=` مثل /dev/ui-kit. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname, () => "/");
}
