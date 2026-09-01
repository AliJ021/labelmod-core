/**
 * کلید Idempotency — یک کلید به‌ازای هر **عمل کاربر**.
 *
 * این ظریف‌ترین بخش اتصال صندوق است و اگر اشتباه شود، بی‌صدا اشتباه
 * می‌شود. دو خطای متقارن ممکن است:
 *
 *   کلید تازه روی Retry   → یک اسکن، دو بار شمرده می‌شود
 *   کلید ثابت برای همیشه  → اسکن دوم عمدی، Replay اسکن اول می‌شود
 *
 * هیچ‌کدام خطا نمی‌دهند. اولی موجودی و پول را خراب می‌کند، دومی
 * صندوق‌دار را وامی‌دارد فکر کند اسکنر خراب است.
 *
 * قاعده درست: کلید به **عمل** گره می‌خورد، نه به درخواست HTTP و نه
 * به Render. تا وقتی عمل تمام نشده، هر تلاش دوباره همان کلید را
 * می‌برد؛ به‌محض موفقیت، کلید دور انداخته می‌شود تا عمل بعدی کلید
 * تازه بگیرد.
 *
 * ── چرا یک کلاس و نه `useState` ────────────────────────────────────
 *
 * React ممکن است یک کامپوننت را دوباره Render کند یا (در حالت
 * Strict) اثر را دو بار اجرا کند. کلیدی که داخل Render ساخته شود،
 * روی همان Retry که باید نجاتش بدهد عوض می‌شود. اینجا کلید در یک
 * `Map` بیرون از چرخه Render می‌نشیند.
 */

/** شناسه تصادفی — `crypto.randomUUID` در هر مرورگر هدف این پروژه هست. */
function freshKey(): string {
  return crypto.randomUUID();
}

export class ActionKeys {
  readonly #keys = new Map<string, string>();
  readonly #mint: () => string;

  /** `mint` فقط برای تست تزریق می‌شود. */
  constructor(mint: () => string = freshKey) {
    this.#mint = mint;
  }

  /**
   * کلید این عمل. بار اول می‌سازد، بارهای بعد **همان** را می‌دهد.
   *
   * `action` باید عمل را یکتا بشناسد — مثلاً `finalize:<invoiceId>`
   * یا `scan:<invoiceId>:<شماره اسکن>`. دو عمل متفاوت با یک نام،
   * دومی را Replay اولی می‌کند.
   */
  keyFor(action: string): string {
    const existing = this.#keys.get(action);
    if (existing !== undefined) return existing;
    const fresh = this.#mint();
    this.#keys.set(action, fresh);
    return fresh;
  }

  /** عمل تمام شد — کلید دیگر لازم نیست. */
  clear(action: string): void {
    this.#keys.delete(action);
  }

  /** فقط برای تست و پاک‌سازی هنگام خروج. */
  clearAll(): void {
    this.#keys.clear();
  }

  get size(): number {
    return this.#keys.size;
  }

  /**
   * عمل را با کلید پایدار اجرا می‌کند و در موفقیت کلید را آزاد.
   *
   * شکست عمداً کلید را نگه می‌دارد: تلاش بعدی باید **همان** کلید را
   * ببرد، وگرنه اگر شکست فقط در شبکه بوده و سرور کارش را کرده باشد،
   * تلاش دوم اثر دوم می‌سازد.
   */
  async run<T>(action: string, fn: (key: string) => Promise<T>): Promise<T> {
    const key = this.keyFor(action);
    const out = await fn(key);
    this.clear(action);
    return out;
  }
}

/**
 * شمارنده اسکن — هر کشیدن اسکنر یک عمل تازه است.
 *
 * بدون این، همه اسکن‌های یک فاکتور یک نام عمل می‌گرفتند و دومی
 * Replay اولی می‌شد: صندوق‌دار سه بار اسکن می‌کرد و تعداد روی یک
 * می‌ماند.
 */
export class ScanCounter {
  #n = 0;

  /** نام عمل برای اسکن بعدی. */
  next(invoiceId: string): string {
    this.#n += 1;
    return `scan:${invoiceId}:${this.#n}`;
  }

  reset(): void {
    this.#n = 0;
  }
}
