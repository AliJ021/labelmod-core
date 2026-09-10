/**
 * صف درخواست هنگام اختلال شبکه. حذف فقط پس از موفقیت send مجاز است؛
 * خطا یا پایان تلاش خودکار، تأیید ثبت درخواست نیست.
 *
 * فرستنده باید پاسخ معتبر همان درخواست را بررسی و کلید Idempotency را
 * حفظ کند. این کلاس به‌تنهایی ذخیرهٔ دائمی، رمزنگاری، انتساب دستگاه و
 * کاربر یا گردش‌کار فروش اضطراری را فراهم نمی‌کند.
 */

/** یک درخواست منتظر. */
export interface QueuedRequest {
  /** شناسه محلی صف — برای حذف پس از موفقیت. */
  id: string;
  method: string;
  path: string;
  body: unknown;
  /** بدون این، صف نمی‌پذیرد. */
  idempotencyKey: string;
  /** برای نمایش به کاربر: «۳ فروش در انتظار ارسال». */
  label: string;
  queuedAt: number;
  attempts: number;
  /** نیازمند رسیدگی؛ با flush بعدی خودکار ارسال نمی‌شود. */
  pausedReason?: "retry_limit" | "response_error";
}

export interface QueueStore {
  all(): Promise<QueuedRequest[]>;
  put(r: QueuedRequest): Promise<void>;
  remove(id: string): Promise<void>;
}

export class OfflineQueueError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OfflineQueueError";
  }
}

/**
 * خطاهایی که تلاش خودکار آن‌ها مجاز است. خطاهای دیگر برای رسیدگی
 * متوقف می‌شوند، اما درخواست از ذخیره حذف نمی‌شود. هیچ‌کدام از این
 * دسته‌بندی‌ها اثبات نمی‌کند که سرور درخواست را ثبت نکرده است.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch شکست خورد
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; status?: unknown; code?: unknown };
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  // ۵۰۲/۵۰۳/۵۰۴ یعنی واسط جواب داد ولی سرویس بالا نبود.
  if (typeof e.status === "number" && [502, 503, 504].includes(e.status)) return true;
  return false;
}

/** ذخیرهٔ حافظه‌ای برای تست؛ با بسته‌شدن صفحه از بین می‌رود. */
export function memoryStore(): QueueStore {
  const rows = new Map<string, QueuedRequest>();
  return {
    all: async () => [...rows.values()].sort((a, b) => a.queuedAt - b.queuedAt),
    put: async (r) => {
      rows.set(r.id, r);
    },
    remove: async (id) => {
      rows.delete(id);
    },
  };
}

export interface FlushResult {
  sent: number;
  failed: number;
  /** درخواست‌های نیازمند رسیدگی؛ همچنان در ذخیره باقی می‌مانند. */
  rejected: QueuedRequest[];
}

export class OfflineQueue {
  readonly #store: QueueStore;
  readonly #send: (r: QueuedRequest) => Promise<void>;
  /** سقف تلاش خودکار؛ رسیدن به آن مجوز حذف داده نیست. */
  readonly #maxAttempts: number;
  #flushing: Promise<FlushResult> | null = null;

  constructor(opts: {
    store: QueueStore;
    send: (r: QueuedRequest) => Promise<void>;
    maxAttempts?: number;
  }) {
    this.#store = opts.store;
    this.#send = opts.send;
    this.#maxAttempts = opts.maxAttempts ?? 10;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new OfflineQueueError("bad_max_attempts", "تعداد تلاش باید عدد صحیح مثبت باشد.");
    }
  }

  /**
   * افزودن به صف.
   *
   * ⚠️ بدون کلید Idempotency رد می‌شود. ارسال دوباره‌ی درخواستی که
   * کلید ندارد، اثر دوم می‌سازد — فاکتور دوم، پرداخت دوم.
   */
  async enqueue(r: Omit<QueuedRequest, "queuedAt" | "attempts" | "pausedReason">): Promise<void> {
    if (r.idempotencyKey.trim() === "") {
      throw new OfflineQueueError(
        "no_idempotency_key",
        "درخواست بدون کلید Idempotency صف نمی‌شود — ارسال دوباره‌اش اثر دوم می‌سازد.",
      );
    }
    await this.#store.put({ ...r, queuedAt: Date.now(), attempts: 0 });
  }

  async pending(): Promise<QueuedRequest[]> {
    return await this.#store.all();
  }

  /** پس از رفع علت توقف؛ همان شناسه، کلید و بدنه حفظ می‌شوند. */
  async retry(id: string): Promise<void> {
    const row = (await this.#store.all()).find((r) => r.id === id);
    if (!row) throw new OfflineQueueError("request_not_found", "درخواست در صف یافت نشد.");
    const next = { ...row, attempts: 0 };
    delete next.pausedReason;
    await this.#store.put(next);
  }

  /**
   * ارسال دوباره همه.
   *
   * ⚠️ ترتیب حفظ می‌شود و اولین شکست **شبکه‌ای** بقیه را متوقف
   * می‌کند. اگر ادامه می‌داد، فروش دوم پیش از اول به سرور می‌رسید و
   * شماره‌گذاری سند بی‌ترتیب می‌شد.
   *
   * درخواست متوقف‌شده در ذخیره می‌ماند و از تلاش خودکار کنار گذاشته
   * می‌شود. قفل این نمونه فقط flushهای همین نمونه را یکی می‌کند؛
   * هماهنگی چند تب به ذخیره و لایهٔ دستگاه نیاز دارد.
   */
  flush(): Promise<FlushResult> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#flushPending().finally(() => { this.#flushing = null; });
    return this.#flushing;
  }

  async #flushPending(): Promise<FlushResult> {
    const rows = await this.#store.all();
    const out: FlushResult = { sent: 0, failed: 0, rejected: [] };

    for (const r of rows) {
      if (r.pausedReason) continue;
      try {
        await this.#send(r);
      } catch (err) {
        if (isNetworkFailure(err)) {
          const next: QueuedRequest = { ...r, attempts: r.attempts + 1 };
          if (next.attempts >= this.#maxAttempts) {
            next.pausedReason = "retry_limit";
            out.rejected.push(next);
          } else {
            out.failed += 1;
          }
          await this.#store.put(next);
          break;
        }
        const next: QueuedRequest = {
          ...r, attempts: r.attempts + 1, pausedReason: "response_error",
        };
        await this.#store.put(next);
        out.rejected.push(next);
        continue;
      }
      // خطای ذخیره پس از ACK نباید خطای پاسخ سرور تلقی یا پنهان شود.
      await this.#store.remove(r.id);
      out.sent += 1;
    }
    return out;
  }
}
