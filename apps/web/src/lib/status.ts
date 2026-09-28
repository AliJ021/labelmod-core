/**
 * زبان واحد وضعیت — نگاشت حالت معنایی به لحن، شکل آیکون و برچسب پیش‌فرض
 * (docs/UI_PATTERNS.md، «وضعیت»). کامپوننت نمایش در components/ui/Status.tsx.
 */
import type { IconName } from "../components/Icon.tsx";

export type StatusState =
  | "draft" | "pending" | "active" | "completed" | "failed" | "cancelled"
  | "archived" | "warning" | "attention" | "offline" | "unknown";

export type StatusTone = "neutral" | "info" | "good" | "warn" | "crit" | "accent";

export const STATUS: Record<StatusState, { tone: StatusTone; icon: IconName; label: string }> = {
  draft: { tone: "neutral", icon: "receipt", label: "پیش‌نویس" },
  pending: { tone: "info", icon: "clock", label: "در انتظار" },
  active: { tone: "accent", icon: "sparkle", label: "فعال" },
  completed: { tone: "good", icon: "check", label: "انجام‌شده" },
  failed: { tone: "crit", icon: "close", label: "ناموفق" },
  cancelled: { tone: "neutral", icon: "close", label: "لغوشده" },
  archived: { tone: "neutral", icon: "box", label: "بایگانی" },
  warning: { tone: "warn", icon: "alert", label: "هشدار" },
  attention: { tone: "crit", icon: "alert", label: "نیاز به رسیدگی" },
  offline: { tone: "warn", icon: "offline", label: "قطع اتصال" },
  unknown: { tone: "info", icon: "info", label: "نامعلوم" },
};
