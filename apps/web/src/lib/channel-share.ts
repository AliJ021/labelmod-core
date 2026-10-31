/**
 * هندسهٔ دونات «فروش به تفکیک کانال» (طرح ۱۰). فقط هندسه: هیچ مبلغ یا درصدی
 * از اینجا نمایش داده نمی‌شود؛ مبلغ هر کانال از سرور است (مهاجرت ۱۰۸).
 *
 * دونات فقط وقتی معنا دارد که همهٔ کانال‌ها فروش نامنفی داشته باشند و جمع
 * مثبت باشد. مرجوعیِ بیش از فروشِ یک کانال در همان روز، سهم منفی می‌سازد و
 * دونات آن را دروغ نشان می‌داد؛ آن‌وقت فقط فهرست می‌ماند (`null`).
 */
export interface Arc { channel: string; start: number; length: number }

export function channelArcs(rows: readonly { channel: string; salesAmount: string }[]): Arc[] | null {
  const values = rows.map(r => BigInt(r.salesAmount));
  if (values.some(v => v < 0n)) return null;
  const total = values.reduce((t, v) => t + v, 0n);
  if (total <= 0n) return null;
  let start = 0;
  return rows.map((r, i) => {
    // نسبت به‌صورت عدد صحیح ده‌هزارم محاسبه می‌شود تا تبدیل bigint بزرگ به number دقت را نبرد.
    const length = Number((values[i]! * 10000n) / total) / 10000;
    const arc = { channel: r.channel, start, length };
    start += length;
    return arc;
  }).filter(a => a.length > 0);
}
