/**
 * تشخیص بارکدخوان از تایپ انسان.
 *
 * اسکنر سیمی (اکسیوم و تقریباً هر اسکنر بازار) خودش را **کیبورد**
 * معرفی می‌کند: کاراکترها را تایپ می‌کند و آخرش Enter می‌زند. یعنی
 * سیستم‌عامل هیچ فرقی میان اسکن و تایپ نمی‌گذارد و ما باید بگذاریم.
 *
 * ── چرا از روی سرعت، نه از روی فوکوس ──────────────────────────────
 *
 * راه ساده‌تر این بود: یک ورودی مخفی که همیشه فوکوس دارد. ولی صندوق
 * فرم هم دارد — مبلغ نقد، شمارش کشو، دلیل تخفیف. لحظه‌ای که
 * صندوق‌دار در یکی از آن‌ها تایپ می‌کند، ورودی مخفی فوکوس ندارد و
 * اسکن **داخل همان فیلد** می‌ریزد: «۱۲۰۰۰۰۰۰۰۲۰۰۱۲۳۴۵۶۷۸۹۰۱۲» به‌جای
 * مبلغ. یک بار که این بیفتد، صندوق‌دار دیگر به سیستم اعتماد نمی‌کند.
 *
 * سرعت تایپ این دو را قطعی از هم جدا می‌کند. اسکنر کل رشته را در
 * چند ده میلی‌ثانیه می‌فرستد؛ سریع‌ترین تایپیست انسانی هم زیر ۵۰
 * میلی‌ثانیه بین دو کلید نمی‌رود، آن هم نه ۱۳ بار پشت سر هم.
 *
 * ── چرا فقط رقم ───────────────────────────────────────────────────
 *
 * بارکد داخلی این پروژه EAN-13 است (پیشوند ۲۰) و بارکد کارخانه هم
 * عددی است. پس هر کلید غیر رقمی وسط رشته یعنی «این اسکن نبود» و
 * بافر دور انداخته می‌شود — نه اینکه نادیده گرفته شود و رشته ناقص
 * بماند.
 */

/**
 * بیشترین فاصله مجاز میان دو کلید در یک اسکن (میلی‌ثانیه).
 *
 * اسکنرهای رایج ۵ تا ۲۰ میلی‌ثانیه می‌دهند. ۵۰ حاشیه امن است بدون
 * اینکه به قلمرو تایپ انسان برسد.
 */
const MAX_GAP_MS = 50;

/**
 * کوتاه‌ترین رشته‌ای که «بارکد» حساب می‌شود.
 *
 * EAN-8 هشت رقم است. کوتاه‌تر از آن، احتمالاً کسی روی صفحه‌کلید عددی
 * تند عدد زده — و ما نباید آن را اسکن بخوانیم.
 */
const MIN_LENGTH = 8;

/** بلندترین بارکدی که می‌پذیریم — همان سقفی که سرور روی `barcode` دارد. */
const MAX_LENGTH = 64;

/**
 * پسوند Enter/Tab گاهی کمی دیرتر از رقم آخر می‌رسد (اسکنر بی‌سیم، صف رویداد).
 * تا این مدت پس از رقم آخرِ یک رشتهٔ سریع **کامل**، همان پسوند اسکن را تمام می‌کند؛
 * پیش‌تر هر فاصلهٔ بیش از ۵۰ms بافر را پاک می‌کرد و اسکن کامل گم می‌شد.
 */
const TERMINATOR_GRACE_MS = 250;


/**
 * کلید رقمی، صرف‌نظر از چیدمان کیبورد. اسکنر HID کد کلید ردیف بالا را می‌فرستد و
 * با چیدمان فارسی ویندوز `key` رقم فارسی (۰–۹) یا عربی (٠–٩) می‌شود؛ همان رقم است،
 * پس به ASCII برمی‌گردد. هیچ نویسهٔ دیگری عوض یا حذف نمی‌شود.
 */
function digitOf(key: string): string | null {
  if (key.length !== 1) return null;
  if (key >= "0" && key <= "9") return key;
  const c = key.charCodeAt(0);
  if (c >= 0x06f0 && c <= 0x06f9) return String(c - 0x06f0);
  if (c >= 0x0660 && c <= 0x0669) return String(c - 0x0660);
  return null;
}

export interface ScanOptions {
  maxGapMs?: number;
  minLength?: number;
  maxLength?: number;
}

/** نتیجه هر کلید. */
export type ScanStep =
  /** کلید بخشی از یک اسکن احتمالی است — کاربر نباید اثرش را ببیند. */
  | { kind: "consumed" }
  /** یک بارکد کامل خوانده شد. */
  | { kind: "scanned"; barcode: string }
  /** ربطی به اسکن نداشت — بگذار مثل همیشه کار کند. */
  | { kind: "ignored" };

/**
 * بافر اسکن — عمداً بدون هیچ وابستگی به DOM.
 *
 * `push` زمان را **پارامتر می‌گیرد** نه اینکه از `Date.now()` بخواند،
 * تا تست بتواند سناریوی «انسان تند تایپ می‌کند» را واقعاً بسازد و
 * نه اینکه به `sleep` تکیه کند.
 */
export class ScanBuffer {
  readonly #maxGap: number;
  readonly #min: number;
  readonly #max: number;

  #chars: string[] = [];
  #last = 0;

  constructor(opts: ScanOptions = {}) {
    this.#maxGap = opts.maxGapMs ?? MAX_GAP_MS;
    this.#min = opts.minLength ?? MIN_LENGTH;
    this.#max = opts.maxLength ?? MAX_LENGTH;
  }

  /** رشته‌ای که تا حالا جمع شده — برای پاک‌کردن اثر نشتی. */
  get pending(): string {
    return this.#chars.join("");
  }

  reset(): void {
    this.#chars = [];
    this.#last = 0;
  }

  /**
   * یک کلید را می‌خوراند و می‌گوید با آن چه کند.
   *
   * @param key مقدار `KeyboardEvent.key`
   * @param at  زمان رویداد به میلی‌ثانیه (`event.timeStamp` یا `Date.now()`)
   */
  push(key: string, at: number, repeat = false): ScanStep {
    // کلیدِ نگه‌داشته‌شده (تکرار خودکار سیستم‌عامل، حدود ۳۳ms) اسکن نیست، حتی اگر تند باشد.
    if (repeat) { this.reset(); return { kind: "ignored" }; }
    const gap = this.#chars.length === 0 ? 0 : at - this.#last;
    const terminator = key === "Enter" || (key === "Tab" && this.#chars.length >= this.#min);
    // پسوندِ کمی دیررس پس از یک رشتهٔ سریع کامل هنوز همان اسکن است.
    if (terminator && this.#chars.length >= this.#min && gap <= TERMINATOR_GRACE_MS) {
      const barcode = this.pending;
      this.reset();
      if (barcode.length <= this.#max) return { kind: "scanned", barcode };
      return { kind: "ignored" };
    }

    // فاصله زیاد یعنی هر چه در بافر بود، تایپ انسان بوده. دور انداخته
    // می‌شود و این کلید **از نو** شروع می‌کند — نه اینکه به دنباله
    // قبلی بچسبد و یک بارکد ساختگی بسازد.
    if (this.#chars.length > 0 && gap > this.#maxGap) this.reset();

    // Enter پسوند پیش‌فرض اسکنرهاست؛ Tab هم پسوند رایج است، ولی فقط وقتی یک
    // رشتهٔ سریعِ کامل پیش از آن آمده باشد (وگرنه همان Tab انسانی است).
    if (key === "Enter" || (key === "Tab" && this.#chars.length >= this.#min)) {
      const barcode = this.pending;
      this.reset();
      if (barcode.length >= this.#min && barcode.length <= this.#max) {
        return { kind: "scanned", barcode };
      }
      // Enterِ انسانی — مثلاً تأیید یک فرم. دست نمی‌زنیم.
      return { kind: "ignored" };
    }

    // فقط رقم (هر چیدمانی). هر چیز دیگری وسط رشته یعنی اسکن نبوده.
    const digit = digitOf(key);
    if (digit === null) {
      this.reset();
      return { kind: "ignored" };
    }

    this.#last = at;
    this.#chars.push(digit);

    // رشته‌ای که از سقف رد شد، بارکد نیست.
    if (this.#chars.length > this.#max) {
      this.reset();
      return { kind: "ignored" };
    }

    // کلید **اول** هنوز قابل تشخیص از تایپ انسان نیست، پس عبورش
    // می‌دهیم. از کلید دوم به بعد که فاصله کوتاه بوده، می‌دانیم اسکن
    // در جریان است و جلوی اثرش را می‌گیریم.
    //
    // یعنی حداکثر **یک رقم** ممکن است در فیلد فوکوس‌دار نشت کند؛
    // `pending` را داریم تا فراخوان بتواند همان یکی را پاک کند.
    return this.#chars.length === 1 ? { kind: "ignored" } : { kind: "consumed" };
  }

}

/**
 * رقم اولِ اسکن پیش از تشخیص در کادر فوکوس‌دار نشسته است. اگر کادر دقیقاً همان
 * مقدار پیشین به‌اضافهٔ همان یک نویسه در جای مکان‌نما را دارد، به مقدار پیشین
 * برمی‌گردد (با رویداد `input` تا state کنترل‌شدهٔ React هم برگردد). هر حالت دیگری —
 * کادر فقط‌خواندنی، متن تغییرکرده، مکان‌نمای دیگر — دست نمی‌خورد.
 */
export interface FieldSnapshot { el: HTMLInputElement | HTMLTextAreaElement; value: string; start: number; end: number; key: string }

export function snapshotField(target: EventTarget | null, key: string): FieldSnapshot | null {
  const el = target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
  if (el.readOnly || el.disabled) return null;
  let start: number | null, end: number | null;
  try { start = el.selectionStart; end = el.selectionEnd; } catch { return null; }
  if (start === null || end === null) return null;
  return { el, value: el.value, start, end, key };
}

export function retractLeak(s: FieldSnapshot | null): boolean {
  if (!s || !s.el.isConnected) return false;
  const expected = s.value.slice(0, s.start) + s.key + s.value.slice(s.end);
  if (s.el.value !== expected) return false;
  const proto = s.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(s.el, s.value);
  try { s.el.setSelectionRange(s.start, s.end); } catch { /* نوع بی مکان‌نما */ }
  s.el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
