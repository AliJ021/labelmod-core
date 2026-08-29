/**
 * رسم EAN-13 — از رقم به میله، و از میله دوباره به رقم.
 *
 * چرا خودمان می‌نویسیم و کتابخانه اضافه نمی‌کنیم: کدگذاری EAN-13 یک
 * مشخصه بسته و کوچک است، و `SECURITY.md` بند ۵ می‌گوید هر وابستگی
 * تازه باید دلیل روشن داشته باشد. صد خط منطق قطعی، کمتر از یک وابستگی
 * تازه در زنجیره تأمین هزینه دارد.
 *
 * **چرا رمزگشا هم هست:** جدول‌های L/G/R را می‌شود اشتباه رونویسی کرد و
 * نتیجه‌اش باز هم «شبیه بارکد» به نظر می‌رسد — تا وقتی یک بارکدخوان
 * واقعی جلوی صندوق نخواندش. رمزگشا اجازه می‌دهد تست، رفت‌وبرگشت را
 * بسنجد: هر بارکدی که رسم می‌شود باید دوباره به همان رقم‌ها برگردد.
 * این یک ادعای واقعی است، نه تکرار همان جدول در تست.
 */
import { ean13CheckDigit } from "./barcode.ts";

/**
 * الگوی «چپ-فرد» (L) برای ارقام ۰ تا ۹.
 *
 * تنها جدولی که رونویسی می‌شود. دو جدول دیگر از همین ساخته می‌شوند:
 *   R = متمم بیتی L        (چپ-زوجِ سمت راست)
 *   G = وارونه‌ی R          (چپ-زوج)
 * پس یک اشتباه رونویسی فقط یک جا می‌تواند باشد، نه سه جا.
 */
const L_CODES = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];

const R_CODES = L_CODES.map((c) => flip(c));
const G_CODES = R_CODES.map((c) => reverse(c));

/**
 * رقم اول در میله‌ها **کدگذاری نمی‌شود** — الگوی زوج/فرد شش رقم بعدی
 * را تعیین می‌کند. `0` یعنی L و `1` یعنی G.
 *
 * همین است که EAN-13 را از EAN-8 جدا می‌کند و باعث می‌شود بارکدخوان
 * بتواند جهت اسکن را هم تشخیص دهد.
 */
const PARITY = [
  "000000",
  "001011",
  "001101",
  "001110",
  "010011",
  "011001",
  "011100",
  "010101",
  "010110",
  "011010",
];

const GUARD_SIDE = "101";
const GUARD_CENTER = "01010";

/** کل نوار: ۹۵ ماژول. */
export const EAN13_MODULES = 95;

function flip(code: string): string {
  return [...code].map((b) => (b === "0" ? "1" : "0")).join("");
}

function reverse(code: string): string {
  return [...code].reverse().join("");
}

export class BarcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarcodeError";
  }
}

/**
 * بارکد ۱۳ رقمی → رشته ۹۵ نویسه‌ای از `0` (سفید) و `1` (سیاه).
 */
export function ean13Modules(barcode: string): string {
  if (!/^\d{13}$/.test(barcode)) {
    throw new BarcodeError("بارکد باید دقیقاً ۱۳ رقم باشد");
  }
  if (ean13CheckDigit(barcode.slice(0, 12)) !== barcode[12]) {
    throw new BarcodeError("رقم کنترل بارکد نمی‌خواند");
  }

  const digits = [...barcode].map((d) => d.charCodeAt(0) - 48);
  const parity = PARITY[digits[0] as number] as string;

  let out = GUARD_SIDE;
  for (let i = 0; i < 6; i++) {
    const d = digits[i + 1] as number;
    out += parity[i] === "0" ? (L_CODES[d] as string) : (G_CODES[d] as string);
  }
  out += GUARD_CENTER;
  for (let i = 0; i < 6; i++) {
    out += R_CODES[digits[i + 7] as number] as string;
  }
  out += GUARD_SIDE;
  return out;
}

/**
 * رشته ۹۵ ماژولی → بارکد ۱۳ رقمی، یا `null` اگر معتبر نباشد.
 *
 * فقط برای تست است — ولی تستی که این را می‌سنجد، واقعاً می‌سنجد که
 * جدول‌ها درست‌اند، نه اینکه همان جدول را دوباره نوشته باشد.
 */
export function decodeEan13Modules(modules: string): string | null {
  if (modules.length !== EAN13_MODULES) return null;
  if (modules.slice(0, 3) !== GUARD_SIDE) return null;
  if (modules.slice(45, 50) !== GUARD_CENTER) return null;
  if (modules.slice(92, 95) !== GUARD_SIDE) return null;

  let parity = "";
  let digits = "";
  for (let i = 0; i < 6; i++) {
    const chunk = modules.slice(3 + i * 7, 10 + i * 7);
    const asL = L_CODES.indexOf(chunk);
    const asG = G_CODES.indexOf(chunk);
    if (asL >= 0) {
      parity += "0";
      digits += String(asL);
    } else if (asG >= 0) {
      parity += "1";
      digits += String(asG);
    } else {
      return null;
    }
  }

  const first = PARITY.indexOf(parity);
  if (first < 0) return null;

  let right = "";
  for (let i = 0; i < 6; i++) {
    const chunk = modules.slice(50 + i * 7, 57 + i * 7);
    const d = R_CODES.indexOf(chunk);
    if (d < 0) return null;
    right += String(d);
  }

  const barcode = String(first) + digits + right;
  if (ean13CheckDigit(barcode.slice(0, 12)) !== barcode[12]) return null;
  return barcode;
}

export interface SvgOptions {
  /** پهنای هر ماژول به میلی‌متر. استاندارد SC2 برابر ۰٫۳۳ است. */
  moduleMm?: number;
  /** بلندی میله به میلی‌متر، بدون احتساب رقم‌های زیر آن. */
  heightMm?: number;
}

/**
 * بارکد → SVG آماده چاپ، با رقم‌های خوانا زیر میله‌ها.
 *
 * سه نکته که بارکد خوانا را از بارکد تزئینی جدا می‌کند:
 *
 * ۱. **حاشیه آرام (Quiet Zone).** استاندارد دست‌کم ۹ ماژول سفید در چپ و
 *    ۷ در راست می‌خواهد. بدون آن، اسکنر ابتدای نوار را پیدا نمی‌کند —
 *    و این شایع‌ترین دلیل «چرا نمی‌خواند» است.
 * ۲. **میله‌های نگهبان بلندترند.** اسکنر از همین‌ها مرکز و لبه را
 *    می‌یابد.
 * ۳. **اندازه به میلی‌متر، نه پیکسل.** برچسب چاپ می‌شود؛ پیکسل روی کاغذ
 *    معنا ندارد و بزرگ‌نمایی مرورگر می‌تواند خرابش کند.
 */
export function ean13Svg(barcode: string, opts: SvgOptions = {}): string {
  const m = opts.moduleMm ?? 0.33;
  const barH = opts.heightMm ?? 18;

  const quietLeft = 11;
  const quietRight = 7;
  const modules = ean13Modules(barcode);
  const totalModules = quietLeft + EAN13_MODULES + quietRight;

  const textH = 3.2;
  const width = totalModules * m;
  const height = barH + textH;

  // میله‌های نگهبان تا پایین ادامه می‌یابند
  const guardIndexes = new Set<number>();
  for (const start of [0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]) {
    guardIndexes.add(start);
  }

  let bars = "";
  for (let i = 0; i < EAN13_MODULES; i++) {
    if (modules[i] !== "1") continue;
    const x = (quietLeft + i) * m;
    const h = guardIndexes.has(i) ? barH + textH * 0.55 : barH;
    bars += `<rect x="${round(x)}" y="0" width="${round(m)}" height="${round(h)}"/>`;
  }

  // رقم‌ها **یکی‌یکی** روی مرکز گروه هفت‌ماژولی خودشان می‌نشینند.
  //
  // نسخه اول یک `<text>` برای هر شش‌تایی می‌گذاشت با `letter-spacing`
  // و `text-anchor="middle"`. نتیجه در چاپ واقعی دیده شد: فاصله‌ی پس
  // از **آخرین** رقم هم در پهنا حساب می‌شود ولی در مرکزچینی نه، پس کل
  // گروه به راست می‌لغزید و رقم آخر از لبه بیرون می‌زد و بریده می‌شد.
  //
  // جای هر رقم مشتق‌شدنی است، پس حدس زدنش خطاست:
  //   گروه چپ  i → ماژول‌های ۳+۷i تا ۹+۷i، مرکز ۶٫۵+۷i
  //   گروه راست i → ماژول‌های ۵۰+۷i تا ۵۶+۷i، مرکز ۵۳٫۵+۷i
  const fs = round(textH * 0.95);
  const baseline = round(height - 0.2);
  const digits = [...barcode];

  const at = (moduleCenter: number, glyph: string): string =>
    `<text x="${round((quietLeft + moduleCenter) * m)}" y="${baseline}" ` +
    `font-size="${fs}" text-anchor="middle">${glyph}</text>`;

  // رقم اول بیرون از نوار، وسط حاشیه آرام چپ
  let text = at(-5.5, digits[0] as string);
  for (let i = 0; i < 6; i++) text += at(6.5 + 7 * i, digits[i + 1] as string);
  for (let i = 0; i < 6; i++) text += at(53.5 + 7 * i, digits[i + 7] as string);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}mm" height="${round(height)}mm" ` +
    `viewBox="0 0 ${round(width)} ${round(height)}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="بارکد ${barcode}">` +
    `<rect width="${round(width)}" height="${round(height)}" fill="#fff"/>` +
    `<g fill="#000">${bars}</g>` +
    `<g fill="#000" font-family="monospace" direction="ltr">${text}</g>` +
    `</svg>`
  );
}

/** سه رقم اعشار کافی است و خروجی را از نماد نمایی دور نگه می‌دارد. */
function round(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
