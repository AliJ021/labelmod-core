/**
 * اندازهٔ لیبل — یک انتخاب برای کل صفحه، نه یکی برای هر بخش.
 *
 * رول لیبل‌زن یک واقعیت فیزیکیِ همین دستگاه است. تا پیش از این، صفحهٔ کالا
 * و فهرست چاپ گروهی هر کدام اندازهٔ جدای خودشان را داشتند: اندازهٔ ۴۰×۲۵
 * انتخاب‌شده در صفحهٔ کالا در فهرست گروهی دوباره ۵۰×۳۰ می‌شد و نوبت گروهی
 * با اندازهٔ غلط روی رول می‌رفت. حالا هر دو از همین‌جا می‌خوانند.
 *
 * در `localStorage` می‌نشیند چون رول تا تعویض بعدی همان است؛ نبودِ
 * ذخیره‌ساز (حالت خصوصی) فقط یادآوری را از دست می‌دهد و پیش‌فرض ۵۰×۳۰ می‌ماند.
 * این تنظیم هیچ اثر مالی یا انباری ندارد و سرور اندازه را دوباره می‌سنجد.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_PRESET, LABEL_PRESETS, type LabelLayout } from "./label-print.ts";

/**
 * `columns` = «1» رول تک‌ستونی قدیمی یا «2» رول دو‌ستونه (BIXOLON XD3-40t).
 * `gap` و `media` اندازه‌گیری کاربرند و پیش‌فرض ندارند (خالی = «اندازه‌گیری نشده»)؛
 * `offset` جبران جابه‌جایی پس از ردیف کالیبراسیون است (پیش‌فرض ۰).
 */
export interface LabelSizeChoice { layout: LabelLayout; preset: string; width: string; height: string; columns: "1" | "2"; gap: string; media: string; offset: string }

const KEY = "labelmod.label-size.v1";
export const DEFAULT_SIZE_CHOICE: LabelSizeChoice = { layout: "roll", preset: DEFAULT_PRESET, width: "50", height: "30", columns: "1", gap: "", media: "", offset: "0" };

/** فقط شکل معتبر پذیرفته می‌شود؛ هر چیز دیگر یعنی پیش‌فرض، نه حدس. */
export function parseSizeChoice(raw: string | null): LabelSizeChoice {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (typeof v !== "object" || v === null) return DEFAULT_SIZE_CHOICE;
    const o = v as Record<string, unknown>;
    const layout = o.layout === "a4" ? "a4" : o.layout === "roll" ? "roll" : null;
    const preset = typeof o.preset === "string" && (o.preset === "custom" || LABEL_PRESETS.some((p) => p.id === o.preset)) ? o.preset : null;
    if (layout === null || preset === null || typeof o.width !== "string" || typeof o.height !== "string") return DEFAULT_SIZE_CHOICE;
    // پروفایل قدیمی (بی ستون/فاصله) همان رول تک‌ستونی می‌ماند، نه پیش‌فرض تازه.
    const str = (v: unknown, fallback: string) => typeof v === "string" ? v.slice(0, 8) : fallback;
    return { layout, preset, width: o.width.slice(0, 8), height: o.height.slice(0, 8),
      columns: o.columns === "2" ? "2" : "1", gap: str(o.gap, ""), media: str(o.media, ""), offset: str(o.offset, "0") };
  } catch { return DEFAULT_SIZE_CHOICE; }
}

function read(): LabelSizeChoice {
  try { return parseSizeChoice(globalThis.localStorage?.getItem(KEY) ?? null); } catch { return DEFAULT_SIZE_CHOICE; }
}

let choice = read();
const listeners = new Set<() => void>();

export const labelSize = {
  set(patch: Partial<LabelSizeChoice>) {
    choice = { ...choice, ...patch };
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(choice)); } catch { /* فقط یادآوری از دست می‌رود */ }
    for (const l of listeners) l();
  },
};

export function useLabelSizeChoice(): LabelSizeChoice {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => choice,
    () => choice,
  );
}
