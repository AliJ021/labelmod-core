/**
 * میان‌برهای سراسری صفحه‌کلید (docs/UI_PATTERNS.md، «کیبورد»).
 *
 * «/» فقط وقتی کاربر در حال تایپ نیست؛ Ctrl/⌘+K همیشه. هیچ میان‌بری
 * کلید تک‌حرفی را درون فیلد متنی نمی‌رباید — اسکنر بارکد صندوق همین
 * کلیدها را مثل صفحه‌کلید می‌فرستد.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  }
  return false;
}

export function isSearchShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">): boolean {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K" || e.key === "ک")) return true;
  return e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
}
