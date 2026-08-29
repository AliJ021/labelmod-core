/**
 * تم و حالت عملکرد.
 *
 * هر دو روی `<html>` می‌نشینند، نه در State ری‌اکت — چون CSS باید
 * ببیندشان و چون باید **پیش از اولین رنگ** اعمال شوند. اسکریپت کوچکی
 * در `index.html` همین‌ها را از `localStorage` می‌خواند تا صفحه با تم
 * غلط بالا نیاید و بعد بپرد.
 */

export type Theme = "light" | "dark" | "system";
/** `off` یعنی کاربر صریحاً شیشه را خواسته، حتی اگر سیستم کم‌شفافیت بخواهد. */
export type Perf = "on" | "off" | "system";

const THEME_KEY = "lm.theme";
const PERF_KEY = "lm.perf";

/** `localStorage` در پنجره ناشناس یا با تنظیمات سخت‌گیر، پرتاب می‌کند. */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ترجیح ذخیره نشد — صفحه باید باز هم کار کند. */
  }
}

export function getTheme(): Theme {
  const v = safeGet(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getPerf(): Perf {
  const v = safeGet(PERF_KEY);
  return v === "on" || v === "off" ? v : "system";
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  safeSet(THEME_KEY, theme);
}

export function setPerf(perf: Perf): void {
  const root = document.documentElement;
  if (perf === "system") root.removeAttribute("data-perf");
  else root.setAttribute("data-perf", perf);
  safeSet(PERF_KEY, perf);
}

/**
 * آیا همین حالا شیشه واقعاً خاموش است؟
 *
 * سه چیز می‌تواند خاموشش کند: کلید کاربر، ترجیح سیستمی، و نبودِ
 * پشتیبانی مرورگر. برای نمایش وضعیت به کاربر، هر سه باید دیده شوند —
 * وگرنه کلیدی نشان می‌دهیم که «روشن» است ولی اثری ندارد.
 */
export function glassIsOff(): boolean {
  const perf = getPerf();
  if (perf === "on") return true;
  if (perf === "off") return false;
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-transparency: reduce)").matches;
  const unsupported =
    typeof CSS === "undefined" ||
    !CSS.supports("backdrop-filter", "blur(1px)");
  return reduced || unsupported;
}
