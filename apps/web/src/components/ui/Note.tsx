import type { ReactNode } from "react";
import { Icon } from "../Icon.tsx";

/**
 * یادداشت راهنمای صفحه (طرح ۱۰): یک قاعدهٔ مالی یا مرز رفتار که کاربر پیش از کار باید بداند.
 * خطا نیست و `role` ندارد: متن ثابت صفحه است، نه نتیجهٔ یک عمل. «هشدار» همیشه آیکون
 * خودش را دارد تا رنگ به‌تنهایی معنا نبرد.
 */
export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return <p className="page-note" data-tone={tone}>
    <Icon name={tone === "warn" ? "alert" : "info"} size="sm" />
    <span>{children}</span>
  </p>;
}
