/**
 * خواندن بارکد با دوربین موبایل.
 *
 * ── چرا این مسیر اصلاً وجود دارد ──────────────────────────────────
 *
 * سرور بیرون از فروشگاه است. وقتی برق می‌رود، کامپیوتر صندوق خاموش
 * می‌شود ولی سرور و موبایلِ با اینترنت همراه سر جایشان‌اند — پس فروش
 * می‌تواند ادامه پیدا کند. آن ساعت، دوربین موبایل جای بارکدخوان
 * سیمی را می‌گیرد.
 *
 * ── دو پیاده‌سازی، چون دو مرورگر ──────────────────────────────────
 *
 * کروم اندروید `BarcodeDetector` را **بومی** دارد: سریع‌تر، بدون
 * هیچ بایت اضافه‌ای در Bundle. سافاری ندارد، پس آیفون به یک
 * کتابخانه جاوااسکریپتی نیاز دارد.
 *
 * کتابخانه با `import()` **پویا** بار می‌شود، نه در Bundle اصلی:
 * کاربر اندروید هرگز دانلودش نمی‌کند و صفحه ورود سنگین‌تر نمی‌شود.
 * قاعده مخزن می‌گوید «تعداد کم وابستگی خودش یک کنترل امنیتی است» —
 * این راهی است که هزینه‌اش را فقط کسی بدهد که واقعاً لازمش دارد.
 */

/** فرمت‌هایی که این فروشگاه چاپ و می‌خواند. */
export const BARCODE_FORMATS = ["ean_13", "ean_8", "code_128"] as const;

/** یک برچسب تا خروج از کادر یک بار شمرده می‌شود، حتی با تأخیر پردازش. */
export class ScanThrottle {
  #last: string | null = null;
  #absent = 0;

  absentFrame(): void {
    if (++this.#absent >= 3) this.reset();
  }

  accept(code: string): boolean {
    this.#absent = 0;
    if (this.#last === code) return false;
    this.#last = code;
    return true;
  }

  reset(): void {
    this.#last = null;
    this.#absent = 0;
  }
}

/** شکل حداقلی چیزی که مرورگر می‌دهد — تا تست به مرورگر نیاز نداشته باشد. */
interface DetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

interface DetectorCtor {
  new (opts: { formats: readonly string[] }): DetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

/**
 * آیا مرورگر خودش بارکد می‌خواند؟
 *
 * `globalThis` تزریق‌شدنی است تا تست هر دو مسیر را بسنجد بدون اینکه
 * به مرورگر واقعی نیاز باشد.
 */
export function hasNativeDetector(g: Record<string, unknown> = globalThis): boolean {
  return typeof g.BarcodeDetector === "function";
}

/** سازنده آشکارساز بومی، اگر باشد. */
export function nativeDetector(
  g: Record<string, unknown> = globalThis,
  formats: readonly string[] = BARCODE_FORMATS,
): DetectorLike | null {
  if (!hasNativeDetector(g)) return null;
  const Ctor = g.BarcodeDetector as DetectorCtor;
  return new Ctor({ formats });
}

/** تصویر همان فریم دوربین؛ بوم فقط یک بار ساخته و میان فریم‌ها استفاده می‌شود. */
export function videoDetector(
  read: (image: ImageData) => Promise<Array<{ text: string }>>,
  makeCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): DetectorLike {
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null | undefined;
  return {
    async detect(source) {
      const width = source.videoWidth, height = source.videoHeight;
      if (source.readyState < 2 || width === 0 || height === 0) return [];
      canvas ??= makeCanvas();
      context ??= canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("خواندن تصویر دوربین ممکن نیست.");
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(source, 0, 0, width, height);
      const results = await read(context.getImageData(0, 0, width, height));
      return results.map(result => ({ rawValue: result.text }));
    },
  };
}

/** بومی بدون دانلود رمزگشا؛ fallback با glue و WASM از یک نسخه و یک بسته. */
export async function resolveDetector(
  g: Record<string, unknown> = globalThis,
): Promise<DetectorLike> {
  try {
    const ctor = g.BarcodeDetector as DetectorCtor | undefined;
    const formats = await ctor?.getSupportedFormats?.();
    const supported = BARCODE_FORMATS.filter(format => !formats || formats.includes(format));
    const native = supported.includes("ean_13") && supported.includes("code_128") && nativeDetector(g, supported);
    if (native) {
      let misses = 0;
      let fallback: Promise<DetectorLike> | undefined;
      return { async detect(source) {
        if (fallback) return (await fallback).detect(source);
        try {
          const found = await native.detect(source);
          if (found.length) { misses = 0; return found; }
        } catch { misses = 8; }
        if (++misses < 8) return [];
        fallback ??= wasmDetector();
        return (await fallback).detect(source);
      } };
    }
  } catch { /* پشتیبانی ناقص دستگاه؛ رمزگشای همراه برنامه قابل استفاده است. */ }
  return wasmDetector();
}

async function wasmDetector(): Promise<DetectorLike> {

  const mod = await import("zxing-wasm/reader");
  // Vite باینری همین بسته را کنار دارایی‌های برنامه منتشر می‌کند؛ CDN لازم نیست.
  // آماده‌سازی پیش از گرفتن دوربین انجام می‌شود تا خطای WASM دوربین را روشن نگذارد.
  const { default: wasmUrl } = await import("zxing-wasm/reader/zxing_reader.wasm?url");
  await mod.prepareZXingModule({ overrides: { locateFile: () => wasmUrl }, fireImmediately: true });
  return videoDetector(image => mod.readBarcodes(image, { formats: ["EAN13", "EAN8", "Code128"], textMode: "Plain" }));
}

/**
 * پیام خطای دوربین، به زبان کاربر.
 *
 * `NotAllowedError` رایج‌ترین حالت است و پیام پیش‌فرض مرورگر انگلیسی
 * و بی‌ربط است. صندوق‌داری که وسط قطعی برق گوشی دستش است، باید در یک
 * جمله بفهمد چه کند.
 */
export function cameraError(err: unknown): string {
  const name = err !== null && typeof err === "object" ? String((err as Error).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "دسترسی به دوربین داده نشده. از تنظیمات مرورگر اجازه دوربین را بدهید.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "دوربینی پیدا نشد.";
  }
  if (name === "NotReadableError") {
    return "دوربین در اختیار برنامه دیگری است.";
  }
  return "دوربین باز نشد. بارکد را دستی وارد کنید.";
}

/**
 * محدودیت‌های درخواستی از دوربین.
 *
 * `environment` یعنی دوربین پشت — نه سلفی. بدون این، گوشی دوربین جلو
 * را باز می‌کند و کاربر باید برچسب را به خودش نشان بدهد.
 */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: "environment" }, width: {ideal: 1920}, height: {ideal: 1080} },
  audio: false,
};
