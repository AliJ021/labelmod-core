import type { ReactNode } from "react";

/**
 * آیکون کارکردی — یک خانواده، یک قلم (docs/DESIGN_SYSTEM.md، «آیکون»).
 *
 * شبکهٔ ۲۴، خط ۱٫۷، سر و گوشهٔ گرد، بدون پر. آیکون تازه باید همین
 * هندسه را داشته باشد؛ بستهٔ آیکون شخص ثالث اضافه نمی‌شود (وابستگی
 * تازه و خانوادهٔ دوم). آیکون همیشه تزئینی است (`aria-hidden`): نام
 * دسترس‌پذیر از متن یا `aria-label` کنترل می‌آید.
 *
 * جهت: فلش‌هایی که معنای «جلو/عقب» دارند در RTL قرینه می‌شوند
 * (`.icon--mirror`)؛ ساعت، نمودار و علامت‌ها قرینه نمی‌شوند.
 */
export type IconName =
  | "search" | "close" | "user" | "lock" | "logout" | "sun" | "moon" | "monitor" | "key"
  | "dashboard" | "register" | "receipt" | "return" | "tag" | "box" | "vault" | "people"
  | "chart" | "settings" | "more" | "bell" | "check" | "alert" | "info" | "clock"
  | "refresh" | "plus" | "filter" | "sort" | "download" | "print" | "offline" | "shield"
  | "database" | "chevron" | "external" | "card" | "link" | "sparkle";

const paths: Record<IconName, ReactNode> = {
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  logout: <><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M9 12h12m-4-4 4 4-4 4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20.5 13.5A8.5 8.5 0 0 1 10.5 3a8.5 8.5 0 1 0 10 10.5Z" />,
  monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8m-4-5v5" /></>,
  key: <><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8m-5-5 3-3m0 6 3-3" /></>,
  dashboard: <><rect x="3.5" y="3.5" width="7" height="9" rx="2" /><rect x="13.5" y="3.5" width="7" height="5" rx="2" /><rect x="13.5" y="11.5" width="7" height="9" rx="2" /><rect x="3.5" y="15.5" width="7" height="5" rx="2" /></>,
  register: <><path d="M4 10h16l-1.2 9.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 10Z" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M9.5 15h5" /></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  return: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  tag: <><path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8a1 1 0 0 1 .7.3l7.7 7.7a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0l-7.7-7.7a1 1 0 0 1-.3-.7Z" /><circle cx="8.5" cy="8.5" r="1.5" /></>,
  box: <><path d="m3.5 7.5 8.5-4 8.5 4v9l-8.5 4-8.5-4v-9Z" /><path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9" /></>,
  vault: <><rect x="3" y="4" width="18" height="15" rx="2.5" /><circle cx="12" cy="11.5" r="3.5" /><path d="M12 8v1m0 5v1m-3.5-3.5h1m5 0h1M6 19v2m12-2v2" /></>,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20v-1.5A5.5 5.5 0 0 1 8.5 13h1a5.5 5.5 0 0 1 5.5 5.5V20" /><path d="M15.5 4.8a3.2 3.2 0 0 1 0 6.4M17.5 13.2A5.5 5.5 0 0 1 21 18.5V20" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-5M12 16V8M16 16v-3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.6a7.4 7.4 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 2.6 1.5l.5 2.6h4l.5-2.6a7.4 7.4 0 0 0 2.6-1.5l2.3 1 2-3.4-2-1.5Z" /></>,
  more: <><circle cx="6" cy="6" r="1.6" /><circle cx="12" cy="6" r="1.6" /><circle cx="18" cy="6" r="1.6" /><circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /><circle cx="6" cy="18" r="1.6" /><circle cx="12" cy="18" r="1.6" /><circle cx="18" cy="18" r="1.6" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 10v4.5M12 17.2v.3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.8v.2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  filter: <path d="M4 5h16l-6.2 7.4V19l-3.6 1.6v-8.2L4 5Z" />,
  sort: <path d="M8 4v16m0 0-3.5-3.5M8 20l3.5-3.5M16 20V4m0 0-3.5 3.5M16 4l3.5 3.5" />,
  download: <><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5" /><path d="M4.5 19.5h15" /></>,
  print: <><path d="M7 9V3.5h10V9" /><rect x="3.5" y="9" width="17" height="8" rx="2" /><path d="M7 14h10v6.5H7z" /></>,
  offline: <><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12.8a10 10 0 0 1 4.2-2.6M14.8 10.2A10 10 0 0 1 19 12.8M2 9.2a15 15 0 0 1 4.3-2.8M12 5a15 15 0 0 1 10 4.2" /><path d="M12 20h.01" /></>,
  shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></>,
  chevron: <path d="m15 6-6 6 6 6" />,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>,
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19M6.5 15h4" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  sparkle: <path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2L12 3.5Z" />,
};

/** فهرست نام‌ها برای UI Kit و تست خانواده. */
export const ICON_NAMES = Object.keys(paths) as IconName[];

export function Icon({ name, size, mirror = false }: { name: IconName; size?: "sm" | "md" | "lg"; mirror?: boolean }) {
  const cls = `icon${size ? ` icon--${size}` : ""}${mirror ? " icon--mirror" : ""}`;
  return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
