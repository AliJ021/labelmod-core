/**
 * Code128 — سازگاری با بارکدهای ذخیره‌شدهٔ قدیمی (مثل کد ۱۷ رقمی دشت).
 *
 * ── چرا ─────────────────────────────────────────────────────────────
 *
 * بارکدهای کالاهای واردشده از سیستم قبلی EAN-13 نیستند (مثلاً
 * `20514161201032064`، ۱۷ رقم با بخش‌هایی که قاعده‌شان معلوم نیست). آن
 * رشته همان چیزی است که روی برچسب‌های چاپ‌شده و در بارکدخوان‌ها نشسته؛
 * پس **عیناً** رمز می‌شود: نه به عدد تبدیل می‌شود (`Number()` روی ۱۷ رقم
 * دقت را از دست می‌دهد)، نه شماره‌گذاری تازه، نه بخشی ساخته می‌شود.
 * تولید EAN-13 داخلی (`barcode.ts`) دست نمی‌خورد.
 *
 * ── رمزگذاری ────────────────────────────────────────────────────────
 *
 * زیرمجموعهٔ C برای جفت‌رقم‌ها و B برای بقیهٔ نویسه‌های چاپی ASCII؛
 * انتخاب زیرمجموعه حریصانه و استاندارد است. ۱۷ رقم = Start C + هشت جفت +
 * CODE B + رقم آخر + وارسی + Stop = ۱۴۵ ماژول، و با حاشیهٔ سکوت ۱۰ ماژولی
 * هر طرف ۱۶۵ ماژول (۴۱٫۲۵mm در ماژول ۰٫۲۵mm).
 *
 * رمزگشای مستقل (zxing-wasm) در `apps/web/test/code128-decode.test.ts`
 * خروجی را دوباره به همان رشته برمی‌گرداند.
 */
import { BarcodeError } from "./barcode-svg.ts";

/** پهنای میله/فاصله‌های هر نماد ۰ تا ۱۰۶ (۱۰۶ = Stop، ۱۳ ماژول). */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
] as const;

const START_B = 104;
const START_C = 105;
const CODE_B = 100; // در زیرمجموعهٔ C
const CODE_C = 99; // در زیرمجموعهٔ B
const STOP = 106;

/** حاشیهٔ سکوت هر طرف — ۱۰ ماژول (حداقل استاندارد). */
export const CODE128_QUIET_MODULES = 10;

/** فقط نویسه‌های چاپی ASCII؛ هر چیز دیگری رمز نمی‌شود، حدس هم زده نمی‌شود. */
export function isCode128Encodable(value: string): boolean {
  return value.length > 0 && value.length <= 48 && /^[\x20-\x7E]+$/.test(value);
}

/** مقدار نمادها (بدون وارسی و Stop) با انتخاب حریصانهٔ B/C. */
function symbolValues(value: string): number[] {
  const out: number[] = [];
  let set: "B" | "C" | null = null;
  const digitRun = (from: number) => {
    let n = 0;
    while (from + n < value.length && value.charCodeAt(from + n) >= 48 && value.charCodeAt(from + n) <= 57) n++;
    return n;
  };
  let i = 0;
  while (i < value.length) {
    const run = digitRun(i);
    // C وقتی می‌صرفد که دست‌کم ۴ رقم در ابتدا/انتها یا ۶ رقم در میانه باشد.
    const atEdge = i === 0 || i + run === value.length;
    if (run >= (atEdge ? 4 : 6) || (set === "C" && run >= 2)) {
      if (set !== "C") { out.push(set === null ? START_C : CODE_C); set = "C"; }
      const pairs = Math.floor(run / 2);
      for (let p = 0; p < pairs; p++) out.push(Number(value.slice(i + 2 * p, i + 2 * p + 2)));
      i += pairs * 2;
      continue;
    }
    if (set !== "B") { out.push(set === null ? START_B : CODE_B); set = "B"; }
    out.push(value.charCodeAt(i) - 32);
    i++;
  }
  return out;
}

/** نوار ماژول‌ها (۱ = میله) — بدون حاشیهٔ سکوت. */
export function code128Modules(value: string): string {
  if (!isCode128Encodable(value)) {
    throw new BarcodeError("بارکد فقط نویسه‌های چاپی ASCII می‌پذیرد و رمز نشد");
  }
  const symbols = symbolValues(value);
  const check = symbols.reduce((sum, v, idx) => sum + v * (idx === 0 ? 1 : idx), 0) % 103;
  let bits = "";
  for (const v of [...symbols, check, STOP]) {
    const widths = PATTERNS[v] as string;
    for (let k = 0; k < widths.length; k++) bits += (k % 2 === 0 ? "1" : "0").repeat(Number(widths[k]));
  }
  return bits;
}

/** طول کامل با حاشیهٔ سکوت هر دو طرف — ورودی `labelGeometry`. */
export function code128TotalModules(value: string): number {
  return code128Modules(value).length + 2 * CODE128_QUIET_MODULES;
}

/**
 * SVG به میلی‌متر، هم‌قرارداد `ean13Svg`: میله‌ها بالا، رشتهٔ خوانا وسطِ
 * زیر میله‌ها، و حاشیهٔ سکوت سفید جزء پهنای SVG.
 */
export function code128Svg(value: string, opts: { moduleMm?: number; heightMm?: number } = {}): string {
  const m = opts.moduleMm ?? 0.25;
  const barH = opts.heightMm ?? 12;
  const bits = code128Modules(value);
  const textH = 3.2;
  const width = (bits.length + 2 * CODE128_QUIET_MODULES) * m;
  const height = barH + textH;

  // میله‌های پیوسته یک مستطیل می‌شوند، نه یک مستطیل برای هر ماژول.
  let bars = "";
  for (let i = 0; i < bits.length;) {
    if (bits[i] !== "1") { i++; continue; }
    let j = i;
    while (j < bits.length && bits[j] === "1") j++;
    bars += `<rect x="${round((CODE128_QUIET_MODULES + i) * m)}" y="0" width="${round((j - i) * m)}" height="${round(barH)}"/>`;
    i = j;
  }
  // اندازهٔ رشتهٔ خوانا تا در پهنای نوار جا شود (تک‌فاصله ≈ ۰٫۶em).
  const fs = Math.min(textH * 0.95, (bits.length * m) / (value.length * 0.6));
  const text = `<text x="${round(width / 2)}" y="${round(height - 0.2)}" font-size="${round(fs)}" text-anchor="middle">${escapeXml(value)}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}mm" height="${round(height)}mm" ` +
    `viewBox="0 0 ${round(width)} ${round(height)}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="بارکد ${escapeXml(value)}">` +
    `<rect width="${round(width)}" height="${round(height)}" fill="#fff"/>` +
    `<g fill="#000">${bars}</g>` +
    `<g fill="#000" font-family="monospace" direction="ltr">${text}</g>` +
    `</svg>`
  );
}

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** سه رقم اعشار کافی است و خروجی را از نماد نمایی دور نگه می‌دارد. */
function round(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** برای آزمون: جدول همان ۱۰۷ نماد است و هر نماد (جز Stop) ۱۱ ماژول. */
export const CODE128_PATTERNS: readonly string[] = PATTERNS;
