import { useSyncExternalStore } from "react";

/**
 * وضعیت شبکهٔ **همین دستگاه** از مرورگر.
 *
 * `navigator.onLine` فقط قطعی آشکار را می‌بیند (نبودِ هیچ شبکه‌ای)؛
 * «متصل» تضمین نمی‌کند سرور در دسترس است. پس فقط حالت قطع نمایش
 * داده می‌شود و هرگز «سرور سالم است» ادعا نمی‌شود.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    callback => {
      window.addEventListener("online", callback);
      window.addEventListener("offline", callback);
      return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); };
    },
    () => navigator.onLine,
    () => true,
  );
}
