import { Accent, type AccentName } from "./ui/Accent.tsx";
import { Icon } from "./Icon.tsx";

/**
 * حالت خالی، بارگذاری و خطای یک ناحیه (docs/UI_PATTERNS.md، «حالت‌ها»).
 *
 * `accent` فقط برای حالت‌های معنادار (اولین استفاده، موفقیت، بکاپ) است؛
 * «جست‌وجو نتیجه نداشت» تصویر نمی‌گیرد. `reference` شناسهٔ پیگیری
 * بی‌راز است که کاربر می‌تواند به پشتیبانی بدهد.
 *
 * `denied` حالت «بی‌مجوز» است (UI_PATTERNS §۶): خطای سامانه نیست، پس
 * `alert` نمی‌شود؛ نشانهٔ قفل + متن می‌گیرد، نه فقط رنگ.
 */
export function ResultState({ title, description, actionLabel, onAction, kind = "empty", accent, reference }: {
  title: string; description?: string; actionLabel?: string | undefined; onAction?: () => void;
  kind?: "empty" | "loading" | "error" | "denied"; accent?: AccentName; reference?: string | null;
}) {
  return <div className={`result-state result-state--${kind}`}>
    {accent ? <Accent name={accent} /> : null}
    <p role={kind === "error" ? "alert" : "status"} className="result-title">{kind === "denied" ? <Icon name="lock" size="sm" /> : null}{title}</p>
    {description ? <p className="muted">{description}</p> : null}
    {reference ? <p className="field-hint">شناسهٔ پیگیری: <bdi className="num">{reference}</bdi></p> : null}
    {actionLabel && onAction ? <button type="button" className="btn btn--quiet" onClick={onAction}>{actionLabel}</button> : null}
  </div>;
}
