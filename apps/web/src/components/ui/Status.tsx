import { Icon } from "../Icon.tsx";
import { STATUS, type StatusState } from "../../lib/status.ts";

/**
 * زبان واحد وضعیت (docs/UI_PATTERNS.md، «وضعیت»).
 *
 * هر برچسب کسب‌وکاری («پیش‌نویس فاکتور»، «چک برگشتی»، «دوره باز») به
 * یکی از این حالت‌های معنایی نگاشت می‌شود؛ ماژول‌ها سبک Badge خودشان را
 * نمی‌سازند. رنگ هرگز تنها نیست: هر حالت شکل آیکون خودش را دارد و
 * برچسب متنی همیشه دیده می‌شود.
 */
export { STATUS, type StatusState } from "../../lib/status.ts";

/** Badge وضعیت؛ `label` برچسب کسب‌وکاری است و حالت فقط دستور بصری را می‌دهد. */
export function StatusBadge({ state, label, quiet = false }: { state: StatusState; label?: string; quiet?: boolean }) {
  const s = STATUS[state];
  return <span className={`status status--${s.tone}${quiet ? " status--quiet" : ""}`} data-state={state}>
    <Icon name={s.icon} size="sm" />
    <span>{label ?? s.label}</span>
  </span>;
}

/** فقط نشانهٔ شکل‌دار + نام وضعیت برای صفحه‌خوان؛ متن اصلی کنارش می‌آید. */
export function StatusIcon({ state }: { state: StatusState }) {
  const s = STATUS[state];
  return <span className={`status-icon status--${s.tone}`} data-state={state}>
    <Icon name={s.icon} size="sm" />
    <span className="sr-only">{s.label}: </span>
  </span>;
}
