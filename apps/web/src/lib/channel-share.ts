/**
 * هندسهٔ دونات «فروش به تفکیک کانال» (طرح ۱۰). فقط هندسه: هیچ مبلغ یا درصدی
 * از اینجا نمایش داده نمی‌شود؛ مبلغ هر کانال از سرور است (مهاجرت ۱۰۸).
 *
 * دونات فقط وقتی معنا دارد که همهٔ کانال‌ها فروش نامنفی داشته باشند و جمع
 * مثبت باشد. مرجوعیِ بیش از فروشِ یک کانال در همان روز، سهم منفی می‌سازد و
 * دونات آن را دروغ نشان می‌داد؛ آن‌وقت فقط فهرست می‌ماند (`null`).
 */
export interface Arc { channel: string; start: number; length: number }

export function channelArcs(rows: readonly { channel: string; salesAmount: string; salesShare: string | null }[]): Arc[] | null {
  // سهم در SQL حساب می‌شود؛ تبدیل سهمِ بی‌واحد به مختصات هندسی محاسبهٔ پول نیست.
  if (!rows.length || rows.some(r => r.salesShare == null || BigInt(r.salesAmount) < 0n)) return null;
  const shares = rows.map(r => Number(r.salesShare));
  if (shares.some(v => !Number.isFinite(v) || v < 0 || v > 1) || !shares.some(v => v > 0)) return null;
  let start = 0;
  return rows.map((r, i) => {
    const length = shares[i]!;
    const arc = { channel: r.channel, start, length };
    start += length;
    return arc;
  }).filter(a => a.length > 0);
}
