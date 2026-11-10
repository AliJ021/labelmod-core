/**
 * منحنی نرم نمودار (خواستهٔ مالک، ۲۰۲۶/۱۱/۰۲: «نمودار خطی، نرم و سافت، نه خشک»).
 *
 * درون‌یابی **یکنوای مکعبی** (Fritsch–Carlson، همان `curveMonotoneX` مشهور): منحنی از
 * همهٔ نقطه‌ها می‌گذرد و میان دو نقطه **هرگز** از بازهٔ همان دو مقدار بیرون نمی‌زند.
 * منحنی معمولیِ هموار (Catmull-Rom، Bezier آزاد) بیش‌جهش دارد: میان ساعت صفر و ساعت
 * پرفروش زیر صفر می‌رود، یعنی نمودار مالی عددی نشان می‌دهد که هرگز نبوده. این‌جا نه.
 *
 * فقط هندسه است: ورودی مختصات پیکسلی است، نه مبلغ. x می‌تواند کاهشی باشد (RTL).
 */
export type Pt = readonly [number, number];

const r = (n: number) => Math.round(n * 10) / 10;

/** شیب مماس هر نقطه: میانگین هماهنگ شیب‌های دو طرف؛ اگر جهت عوض شود یا یک طرف تخت باشد، صفر. */
function tangents(p: readonly Pt[]): number[] {
  const n = p.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1]![0] - p[i]![0];
    d.push(dx === 0 ? 0 : (p[i + 1]![1] - p[i]![1]) / dx);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const a = d[i - 1]!, b = d[i]!;
    m[i] = a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  }
  // سر و ته: شیب یک‌طرفه را چنان محدود کن که اولین/آخرین پاره بیش‌جهش نکند.
  for (const [i, s] of [[0, d[0]], [n - 1, d[n - 2]]] as const) {
    if (s === undefined) continue;
    if (s === 0 || m[i]! * s < 0) m[i] = 0;
    else if (Math.abs(m[i]!) > 3 * Math.abs(s)) m[i] = 3 * s;
  }
  return m;
}

/** نقطه‌های کنترل Bezier میان هر دو نقطهٔ پیاپی. */
export function smoothSegments(p: readonly Pt[]): { c1: Pt; c2: Pt; to: Pt }[] {
  if (p.length < 2) return [];
  const m = tangents(p);
  const out: { c1: Pt; c2: Pt; to: Pt }[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i]!, [x1, y1] = p[i + 1]!;
    const h = (x1 - x0) / 3;
    out.push({ c1: [x0 + h, y0 + m[i]! * h], c2: [x1 - h, y1 - m[i + 1]! * h], to: [x1, y1] });
  }
  return out;
}

/** مسیر SVG نرم از یک دنبالهٔ پیوسته؛ یک نقطه = فقط `M`. */
export function smoothPath(p: readonly Pt[]): string {
  if (p.length === 0) return "";
  const [x, y] = p[0]!;
  return `M${r(x)} ${r(y)}` + smoothSegments(p).map(s =>
    ` C${r(s.c1[0])} ${r(s.c1[1])} ${r(s.c2[0])} ${r(s.c2[1])} ${r(s.to[0])} ${r(s.to[1])}`).join("");
}

/** سطح زیر همان منحنی تا خط `base` (تزئینی؛ همان هندسهٔ خط). */
export function smoothArea(p: readonly Pt[], base: number): string {
  if (p.length < 2) return "";
  const first = p[0]!, last = p[p.length - 1]!;
  return `M${r(first[0])} ${r(base)} L${r(first[0])} ${r(first[1])}` + smoothSegments(p).map(s =>
    ` C${r(s.c1[0])} ${r(s.c1[1])} ${r(s.c2[0])} ${r(s.c2[1])} ${r(s.to[0])} ${r(s.to[1])}`).join("")
    + ` L${r(last[0])} ${r(base)} Z`;
}
