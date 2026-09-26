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

/**
 * مهار تکرار — مهم‌ترین منطق این فایل.
 *
 * دوربین یک بارکد را **ده‌ها بار در ثانیه** می‌بیند. بدون مهار، یک
 * بار گرفتن گوشی جلوی برچسب، سی قلم به سبد اضافه می‌کرد — و
 * صندوق‌دار تازه سرِ پرداخت می‌فهمید.
 *
 * قاعده: همان بارکد تا `holdMs` دوباره شمرده نمی‌شود؛ بارکد
 * **متفاوت** فوراً پذیرفته می‌شود، چون اسکن پشت‌سرهم دو کالا باید
 * روان باشد.
 */
export class ScanThrottle {
  readonly #hold: number;
  #last: string | null = null;
  #at = 0;

  constructor(holdMs = 1500) {
    this.#hold = holdMs;
  }

  /** آیا این خواندن یک اسکن **تازه** است؟ */
  accept(code: string, at: number): boolean {
    if (code === this.#last && at - this.#at < this.#hold) {
      // همان بارکد، هنوز داخل پنجره: فقط زمان را جلو می‌بریم تا
      // نگه‌داشتنِ ممتد گوشی، پنجره را تمام نکند.
      this.#at = at;
      return false;
    }
    this.#last = code;
    this.#at = at;
    return true;
  }

  reset(): void {
    this.#last = null;
    this.#at = 0;
  }
}

/** شکل حداقلی چیزی که مرورگر می‌دهد — تا تست به مرورگر نیاز نداشته باشد. */
interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
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
): DetectorLike | null {
  if (!hasNativeDetector(g)) return null;
  const Ctor = g.BarcodeDetector as DetectorCtor;
  return new Ctor({ formats: BARCODE_FORMATS });
}

/**
 * آشکارساز، از هر راهی که این مرورگر می‌دهد.
 *
 * اندروید: `BarcodeDetector` بومی — **صفر بایت** اضافه.
 * آیفون: همان API از یک Polyfill، با `import()` پویا.
 *
 * `barcode-detector` عمداً به‌جای یک کتابخانه معمولی انتخاب شد چون
 * **همان رابط** را می‌دهد. یعنی از اینجا به بعد یک مسیر کد داریم نه
 * دو تا — و مسیری که فقط روی یک پلتفرم اجرا می‌شود، همان است که
 * خراب می‌ماند و کسی نمی‌فهمد.
 */
export async function resolveDetector(
  g: Record<string, unknown> = globalThis,
): Promise<DetectorLike> {
  const native = nativeDetector(g);
  if (native) return native;

  const mod = await import("barcode-detector/pure");

  // ── چرا این خط حیاتی است ────────────────────────────────────────
  //
  // `barcode-detector` به‌صورت پیش‌فرض فایل WASM را در **زمان اجرا**
  // از jsDelivr می‌گیرد. برای این پروژه سه دلیل جدا آن را رد می‌کند:
  //
  //   ۱. زنجیره تأمین (SECURITY.md بند ۵) — یک شخص ثالث می‌تواند هر
  //      کدی را به‌عنوان WASM سرو کند، در صفحه‌ای که پول جابه‌جا
  //      می‌کند.
  //   ۲. CSP این پروژه دامنه بیرونی نمی‌دهد و باید هم ندهد.
  //   ۳. دقیقاً همان لحظه‌ای که دوربین لازم می‌شود — قطعی برق، اینترنت
  //      همراه ضعیف — یک دانلود از CDN آخرین چیزی است که می‌خواهیم.
  //
  // `?url` به Vite می‌گوید فایل را کنار بقیه دارایی‌ها بگذارد و آدرس
  // محلی‌اش را بدهد. هیچ درخواستی از دامنه ما بیرون نمی‌رود.
  // ⚠️ محلی‌بودن فایل کافی نیست: **اجرای** WASM هم از CSP اجازه
  // می‌خواهد. یک `script-src` سخت‌گیرانه بدون `wasm-unsafe-eval`،
  // نمونه‌سازی WebAssembly را در مرورگرهای Chromium می‌بندد — و این
  // مسیر همان مسیر Polyfill است، یعنی آیفون و هر مرورگری که
  // `BarcodeDetector` بومی ندارد.
  //
  // امروز هنوز CSP سراسری‌ای وجود ندارد (بند ۶ SECURITY.md آن را
  // می‌خواهد و `docker-compose.yml` هنوز Caddy ندارد). پس این تله
  // برای **روزی** است که اضافه شود: بدون آن کلیدواژه، دوربین بی‌صدا
  // از کار می‌افتد — دقیقاً در قطعی برق، که تنها دلیل وجودش است.
  const { default: wasmUrl } = await import("zxing-wasm/reader/zxing_reader.wasm?url");
  await mod.prepareZXingModule({ overrides: { locateFile: () => wasmUrl }, fireImmediately: true });

  return new mod.BarcodeDetector({ formats: [...BARCODE_FORMATS] }) as DetectorLike;
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
  video: { facingMode: { ideal: "environment" } },
  audio: false,
};
