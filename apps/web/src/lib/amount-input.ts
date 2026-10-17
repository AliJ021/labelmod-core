/** Display-only grouping. Invalid text stays invalid; no rounding or Number conversion. */
export function ungroupAmount(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632)))
    .replace(/[,٬]/g, "");
}

export function groupAmount(value: string): string {
  const raw = ungroupAmount(value);
  if (!/^-?\d*(?:[.٫]\d*)?$/.test(raw)) return value;
  return raw.replace(/^-?\d*/, whole => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
}

export function amountCaret(display: string, significant: number): number {
  if (significant <= 0) return 0;
  let count = 0;
  for (let i = 0; i < display.length; i++) {
    if (display[i] !== "," && display[i] !== "٬") count++;
    if (count === significant) return i + 1;
  }
  return display.length;
}
