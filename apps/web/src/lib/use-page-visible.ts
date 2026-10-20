import { useSyncExternalStore } from "react";

/**
 * آیا این زبانه دیده می‌شود؟ (`document.visibilityState`)
 *
 * به‌روزرسانی خودکار فقط وقتی صفحه دیده می‌شود: زبانهٔ پنهان نه شبکه مصرف می‌کند نه سرور
 * را صدا می‌زند، و با دیده‌شدن دوباره اگر موعد گذشته باشد همان لحظه به‌روز می‌شود.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    callback => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
    () => document.visibilityState !== "hidden",
    () => true,
  );
}
