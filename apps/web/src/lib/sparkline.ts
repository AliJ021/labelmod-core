/**
 * نمودار کوچک کارت شاخص (طرح ۱۰): مسیر SVG «تجمعی تا این لحظه».
 *
 * - جمع ساعت‌ها همان عدد کارت است (مهاجرت ۰۸۳)، پس خط تجمعی به همان عدد ختم می‌شود.
 * - ساعتِ نرسیده (`null`) صفر نیست: خط همان‌جا تمام می‌شود.
 * - زمان مثل نمودار روند راست‌به‌چپ است: ساعت زودتر سمت راست.
 * - هندسه فقط نسبت است؛ هیچ مبلغی از اینجا نمایش داده یا حساب نمی‌شود، پس
 *   تبدیل اختلاف bigint به number برای مختصات پیکسلی بی‌خطر است.
 */
export function sparkPath(values: readonly (bigint | null)[], width: number, height: number, pad = 2): string | null {
  const running: bigint[] = [];
  let sum = 0n;
  for (const v of values) {
    if (v === null) break;
    sum += v;
    running.push(sum);
  }
  if (running.length < 2) return null;
  let min = 0n, max = 0n;
  for (const v of running) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min;
  const last = running.length - 1;
  const y = (v: bigint) => span === 0n ? height / 2 : pad + Number(max - v) / Number(span) * (height - 2 * pad);
  const x = (i: number) => width - (i / last) * width;
  return running.map((v, i) => `${i === 0 ? "M" : "L"}${round(x(i))} ${round(y(v))}`).join(" ");
}

const round = (n: number) => Math.round(n * 10) / 10;
