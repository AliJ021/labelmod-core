/**
 * ردیف افقیِ قابل‌اسکرول، مستقل از مدل `scrollLeft` در RTL (یافتهٔ F-110-03).
 *
 * مرورگرها در RTL سه مدل تاریخی داشته‌اند:
 *   negative            0 در آغاز (راست)، منفی به سمت پایان — استاندارد امروز.
 *   positive-ascending  0 در انتهای چپ، بیشینه در آغاز (Chromium پیش از ۸۵).
 *   positive-descending 0 در آغاز، مثبت به سمت پایان (IE و Edge قدیمی).
 *
 * `Math.abs(scrollLeft)` فقط دو مدل اول را یکی می‌کرد و در سومی جای «آغاز» و
 * «پایان» را برعکس می‌گفت. اینجا هیچ تصمیمی از معنای `scrollLeft` گرفته
 * نمی‌شود:
 *
 *   - لبهٔ پنهان از **هندسه**: جای واقعی زبانه‌ها در برابر جعبهٔ دید.
 *   - وسط‌کردن با **بازخورد هندسی**: هر دو جهت امتحان و بهترین نگه داشته
 *     می‌شود. در مدل وارونه، جهت اول بدتر می‌کند و کنار گذاشته می‌شود.
 *
 * هر دو تابع خالص‌اند و در `test/inline-scroll.test.ts` روی هر سه مدل و
 * در LTR سنجیده می‌شوند.
 */
export interface Span { left: number; right: number }

/**
 * کدام لبهٔ **منطقی** محتوای پنهان دارد؟ `content` کران فیزیکی همهٔ زبانه‌هاست.
 * در RTL آغاز سمت راست است؛ در LTR سمت چپ. خطای زیرپیکسلی نادیده گرفته می‌شود.
 */
export function hiddenEdges(view: Span, content: Span, rtl: boolean): { start: boolean; end: boolean } {
  const left = content.left < view.left - 1, right = content.right > view.right + 1;
  return rtl ? { start: right, end: left } : { start: left, end: right };
}

/**
 * هدف را تا جای ممکن به وسط دید می‌برد. `offset` فاصلهٔ فیزیکی مرکز هدف از
 * مرکز دید است (مثبت = سمت راست). مرورگر `scrollLeft` را خودش به بازهٔ مجاز
 * می‌بُرد، پس نزدیک دو سر ردیف فقط تا جای ممکن جلو می‌رود.
 */
export function centerInline(scroller: { scrollLeft: number }, offset: () => number): void {
  const start = scroller.scrollLeft, before = offset();
  if (Math.abs(before) < 1) return;
  let best = { position: start, distance: Math.abs(before) };
  for (const candidate of [start + before, start - before]) {
    scroller.scrollLeft = candidate;
    const distance = Math.abs(offset());
    if (distance < best.distance - 0.5) best = { position: scroller.scrollLeft, distance };
  }
  scroller.scrollLeft = best.position;
}
