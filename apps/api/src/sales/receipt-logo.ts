/**
 * لوگوی رسید — فقط فایل اصیل برند، جاسازی‌شده در صفحه.
 *
 * ── منبع ────────────────────────────────────────────────────────────
 *
 * فایل باید **همان** لوگوی منتشرشدهٔ لیبل مد باشد، نه بازسازی (نشانی‌ها در
 * `assets/README.md`). اگر فایل نباشد، رسید همان نشان متنی نام شعبه را
 * چاپ می‌کند؛ لوگوی ساختگی ساخته نمی‌شود.
 *
 * ── چرا data: و نه یک نشانی ─────────────────────────────────────────
 *
 * CSP صفحهٔ رسید فقط `img-src data:` را باز گذاشته و چاپ مستقیم iframe
 * نباید به شبکه وابسته باشد؛ پس تصویر یک بار هنگام بالا آمدن API خوانده و
 * درون HTML گذاشته می‌شود. فایل بزرگ رد می‌شود تا هر رسید سنگین نشود.
 *
 * ── چاپ تک‌رنگ ──────────────────────────────────────────────────────
 *
 * کاغذ حرارتی فقط سیاه دارد. نوع درمان از **خودِ پیکسل‌ها** تعیین می‌شود،
 * نه از نام فایل: لوگوی شفاف (مثلاً سفید روی شفاف برای پس‌زمینهٔ تیره)
 * با `brightness(0)` تمام‌سیاه می‌شود؛ لوگوی با پس‌زمینهٔ مات فقط خاکستری
 * می‌شود، چون سیاه‌کردنش یک مستطیل سیاه چاپ می‌کرد.
 */
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface ReceiptLogo {
  dataUri: string;
  width: number;
  height: number;
  /** `black`: لوگوی شفاف، هر پیکسل دیده‌شده سیاه چاپ شود؛ `gray`: پس‌زمینهٔ مات. */
  treatment: "black" | "gray";
}

/** بزرگ‌تر از این، هر رسید را سنگین می‌کند؛ لوگو باید فشرده تحویل شود. */
const MAX_BYTES = 200 * 1024;
const PNG_SIGNATURE = "89504e470d0a1a0a";

export class ReceiptLogoError extends Error {}

/** تحلیل PNG ۸ بیتی بدون Interlace: ابعاد و اینکه پس‌زمینه شفاف است یا نه. */
export function analyzePng(buf: Buffer): { width: number; height: number; transparent: boolean } {
  if (buf.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) throw new ReceiptLogoError("فایل لوگو PNG نیست");
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    throw new ReceiptLogoError("لوگو باید PNG هشت‌بیتی بدون Interlace باشد");
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = Buffer.alloc(stride), row = Buffer.alloc(stride);
  let transparent = false;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1), filter = raw[base]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x]!, a = x >= channels ? row[x - channels]! : 0, b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let out = v;
      if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      row[x] = out & 0xff;
    }
    for (let x = 0; x < width && !transparent; x++) {
      const alpha = colorType === 6 ? row[x * 4 + 3]! : colorType === 4 ? row[x * 2 + 1]!
        : colorType === 3 ? (trns && row[x]! < trns.length ? trns[row[x]!]! : 255) : 255;
      if (alpha < 250) transparent = true;
    }
    row.copy(prev);
  }
  if (colorType === 3 && !palette) throw new ReceiptLogoError("PNG پالت‌دار بدون PLTE");
  return { width, height, transparent };
}

export function receiptLogoFromBuffer(buf: Buffer): ReceiptLogo {
  if (buf.length > MAX_BYTES) throw new ReceiptLogoError(`لوگوی رسید بزرگ‌تر از ${MAX_BYTES / 1024}KB است`);
  const info = analyzePng(buf);
  return {
    dataUri: `data:image/png;base64,${buf.toString("base64")}`,
    width: info.width,
    height: info.height,
    treatment: info.transparent ? "black" : "gray",
  };
}

const LOGO_FILE = new URL("./assets/receipt-logo.png", import.meta.url);
let cached: ReceiptLogo | null | undefined;

/** لوگوی بسته‌بندی‌شده، یا `null` اگر فایل اصیل هنوز قرار نگرفته است. */
export function receiptLogo(): ReceiptLogo | null {
  if (cached !== undefined) return cached;
  cached = existsSync(LOGO_FILE) ? receiptLogoFromBuffer(readFileSync(LOGO_FILE)) : null;
  return cached;
}
