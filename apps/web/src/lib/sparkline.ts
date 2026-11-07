/**
 * نمودار کوچک کارت شاخص (طرح ۱۰): مسیر SVG «تجمعی تا این لحظه».
 *
 * - ورودی جمع‌های تجمعی SQL است؛ هیچ ساعت یا مبلغی اینجا جمع نمی‌شود.
 * - ساعتِ نرسیده (`null`) صفر نیست: خط همان‌جا تمام می‌شود.
 * - محور زمان مثل طرح ۱۰ و نمودار روند: ساعت زودتر چپ، ساعت جاری راست (تصمیم مالک، ۲۰۲۶/۱۱/۰۶).
 * - هندسه فقط نسبت است؛ هیچ مبلغی از اینجا نمایش داده یا حساب نمی‌شود، پس
 *   تبدیل اختلاف bigint به number برای مختصات پیکسلی بی‌خطر است.
 */
import { smoothPath, type Pt } from "./smooth-path.ts";

export function sparkPoints(values: readonly (bigint | null)[], width: number, height: number, pad = 2): Pt[] | null {
  const running: bigint[] = [];
  for (const v of values) {
    if (v === null) break;
    running.push(v);
  }
  if (running.length < 2) return null;
  let min = 0n, max = 0n;
  for (const v of running) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min;
  const last = running.length - 1;
  const y = (v: bigint) => span === 0n ? height / 2 : pad + Number(max - v) / Number(span) * (height - 2 * pad);
  const x = (i: number) => (i / last) * width;
  return running.map((v, i) => [round(x(i)), round(y(v))]);
}

export function sparkPath(values: readonly (bigint | null)[], width: number, height: number, pad = 2): string | null {
  const points = sparkPoints(values, width, height, pad);
  return points ? smoothPath(points) : null;
}

const round = (n: number) => Math.round(n * 10) / 10;
