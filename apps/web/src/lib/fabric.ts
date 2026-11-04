/** «#rrggbb» توکن به سه‌تایی ۰ تا ۱؛ مقدار نامعتبر یعنی نکشیدن، نه رنگ دلخواه. */
export function tokenRgb(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
