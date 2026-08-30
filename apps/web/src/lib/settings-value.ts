/**
 * تبدیل مقدار تنظیم میان JSON و ویجت فرم.
 *
 * **این لایه مرجع نیست.** مرجع اعتبارسنجی `platform.set_setting()` در
 * دیتابیس است و همان است که از مسیر psql هم دور زده نمی‌شود. کاری که
 * اینجا می‌شود فقط دو چیز است:
 *
 *   • بازخورد فوری، تا کاربر برای دیدن «نمی‌تواند بیشتر از ۱۰۰ باشد»
 *     منتظر رفت‌وبرگشت شبکه نماند
 *   • تبدیل ورودی متنی به شکل JSON درست (عدد، بله/خیر، آرایه)
 *
 * و **هیچ عددی اینجا ثابت نیست**: بازه‌ها از خودِ فراداده‌ای می‌آیند
 * که سرور فرستاده. اگر ثابت می‌بودند، همان دو نسخه از یک قاعده را
 * می‌ساختند که دیر یا زود از هم جدا می‌شوند.
 */

export type SettingKind =
  | "bool"
  | "int"
  | "money"
  | "percent"
  | "choice"
  | "multichoice"
  | "text"
  | "json";

export interface SettingMeta {
  kind: SettingKind;
  min: number | null;
  max: number | null;
  options: Array<{ value: string; label: string }> | null;
}

export type Parsed =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * رقم فارسی و عربی → لاتین.
 *
 * کاربر ایرانی روی صفحه‌کلید فارسی «۱۲» می‌زند، نه «12». بدون این
 * تبدیل، `Number("۱۲")` مقدار NaN می‌دهد و فرم می‌گوید «عدد نیست» —
 * در حالی که کاربر دقیقاً یک عدد نوشته است.
 *
 * جداکننده هزارگان (`٬` و `,`) و فاصله هم برداشته می‌شوند: کسی که
 * «۱٬۲۰۰» می‌نویسد منظورش ۱۲۰۰ است.
 */
export function normalizeDigits(raw: string): string {
  let out = "";
  for (const ch of raw.trim()) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0x06f0 && c <= 0x06f9) out += String.fromCharCode(48 + (c - 0x06f0)); // ۰-۹
    else if (c >= 0x0660 && c <= 0x0669) out += String.fromCharCode(48 + (c - 0x0660)); // ٠-٩
    else if (ch === "٫") out += ".";
    else if (ch === "٬" || ch === "," || ch === " " || ch === "‌") continue;
    else out += ch;
  }
  return out;
}

/** مقدار JSON → متنی که در `<input>` می‌نشیند. */
export function toInput(kind: SettingKind, value: unknown): string {
  if (kind === "money" || kind === "text" || kind === "choice") {
    return typeof value === "string" ? value : String(value ?? "");
  }
  if (kind === "int" || kind === "percent") {
    return typeof value === "number" ? String(value) : String(value ?? "");
  }
  return JSON.stringify(value ?? null);
}

/** ورودی فرم → مقدار JSON، یا خطای فارسی. */
export function fromInput(meta: SettingMeta, raw: string | boolean | string[]): Parsed {
  const { kind } = meta;

  if (kind === "bool") {
    if (typeof raw !== "boolean") return { ok: false, error: "مقدار باید بله یا خیر باشد" };
    return { ok: true, value: raw };
  }

  if (kind === "multichoice") {
    if (!Array.isArray(raw)) return { ok: false, error: "مقدار باید فهرست باشد" };
    const known = new Set((meta.options ?? []).map((o) => o.value));
    for (const v of raw) {
      if (!known.has(v)) return { ok: false, error: `گزینه «${v}» شناخته‌شده نیست` };
    }
    return { ok: true, value: raw };
  }

  if (typeof raw !== "string") return { ok: false, error: "مقدار نامعتبر است" };

  if (kind === "choice") {
    const known = new Set((meta.options ?? []).map((o) => o.value));
    if (!known.has(raw)) return { ok: false, error: "یکی از گزینه‌ها را انتخاب کنید" };
    return { ok: true, value: raw };
  }

  if (kind === "text") {
    if (raw.trim() === "") return { ok: false, error: "مقدار نمی‌تواند خالی باشد" };
    return { ok: true, value: raw.trim() };
  }

  if (kind === "int" || kind === "percent") {
    const s = normalizeDigits(raw);
    if (s === "") return { ok: false, error: "مقدار نمی‌تواند خالی باشد" };
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: "فقط عدد وارد کنید" };
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, error: "فقط عدد وارد کنید" };
    if (kind === "int" && !Number.isInteger(n)) {
      return { ok: false, error: "فقط عدد صحیح — بدون اعشار" };
    }
    const range = checkRange(meta, n);
    if (range) return { ok: false, error: range };
    return { ok: true, value: n };
  }

  if (kind === "money") {
    // پول در JSON **رشته** است، نه عدد. اگر اینجا `Number` می‌ساختیم،
    // مبالغ ریالی بزرگ بی‌صدا گرد می‌شدند و هیچ خطایی هم نمی‌دادند.
    const s = normalizeDigits(raw);
    if (!/^\d+$/.test(s)) return { ok: false, error: "مبلغ باید عدد صحیح ریالی باشد" };
    const range = checkRange(meta, Number(s));
    if (range) return { ok: false, error: range };
    return { ok: true, value: s };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: "مقدار JSON معتبر نیست" };
  }
}

function checkRange(meta: SettingMeta, n: number): string | null {
  if (meta.min !== null && n < meta.min) return `نمی‌تواند کمتر از ${meta.min} باشد`;
  if (meta.max !== null && n > meta.max) return `نمی‌تواند بیشتر از ${meta.max} باشد`;
  return null;
}

/** مقدار فعلی، به زبان آدمیزاد — برای نمایش خلاصه کنار برچسب. */
export function describeValue(meta: SettingMeta, value: unknown): string {
  if (meta.kind === "bool") return value === true ? "فعال" : "غیرفعال";
  if (meta.kind === "choice") {
    const o = (meta.options ?? []).find((x) => x.value === value);
    return o?.label ?? String(value);
  }
  if (meta.kind === "multichoice" && Array.isArray(value)) {
    return `${value.length} مورد`;
  }
  return String(value);
}
