/**
 * صف امن هنگام اختلال شبکه.
 *
 * ── چرا این امن است، و «حالت آفلاین کامل» نیست ──────────────────────
 *
 * `CLAUDE.md` می‌گوید «حالت آفلاین کامل» ساخته نشود، و آن هنوز برقرار
 * است: صندوقی که آفلاین **فاکتور بسازد** یعنی شماره‌گذاری سند، بررسی
 * موجودی و قیمت‌گذاری در مرورگر انجام شود — سه چیزی که کل معماری این
 * پروژه عمداً در دیتابیس گذاشته.
 *
 * آنچه اینجا هست چیز دیگری است: درخواستی که **سرور آن را قبول کرده
 * بود اگر شبکه قطع نمی‌شد**، تا برگشت شبکه نگه داشته و دوباره فرستاده
 * می‌شود. هیچ تصمیم مالی در مرورگر گرفته نمی‌شود؛ فقط یک بایت روی
 * سیم دوباره می‌رود.
 *
 * ── چرا این کار بی‌خطر است ──────────────────────────────────────────
 *
 * چون هر Endpoint تغییردهنده وضعیت از روز اول `Idempotency-Key`
 * می‌پذیرد و `lib/idempotency.ts` درج Inbox را **پیش از** اثر و در
 * همان تراکنش انجام می‌دهد. یعنی ارسال دوباره یک درخواست، اثر دوم
 * نمی‌سازد — Replay می‌گیرد.
 *
 * ⚠️ **درخواست بدون کلید Idempotency صف نمی‌شود.** بدون آن، ارسال
 *    دوباره یعنی فاکتور دوم یا پرداخت دوم. صف کردنش خطرناک‌تر از
 *    شکست‌دادنش است، پس صریح رد می‌شود.
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
 * آیا این خطا «نرسید» است یا «رد شد»؟
 *
 * همان تفکیکی که `SmsError.permanent` در Worker دارد، و به همان
 * دلیل: شماره غلط با تلاش صدم هم درست نمی‌شود، ولی قطعی لحظه‌ای شبکه
 * نباید یک فروش را برای همیشه بکشد.
 *
 * ⚠️ فقط خطای **شبکه** صف می‌شود. پاسخ ۴۰۹ یا ۴۲۲ یعنی سرور شنید و
 *    رد کرد — صف کردنش یعنی همان رد بارها تکرار شود و کاربر هیچ‌وقت
 *    نفهمد چرا فروشش ثبت نشد.
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

/** صف در حافظه — پایه تست، و پشتیبانِ مرورگری که IndexedDB ندارد. */
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
  /** درخواست‌هایی که سرور صریح ردشان کرد — از صف بیرون رفتند. */
  rejected: QueuedRequest[];
}

export class OfflineQueue {
  readonly #store: QueueStore;
  readonly #send: (r: QueuedRequest) => Promise<void>;
  /** بیش از این تلاش، یعنی چیزی جز شبکه ایراد دارد. */
  readonly #maxAttempts: number;

  constructor(opts: {
    store: QueueStore;
    send: (r: QueuedRequest) => Promise<void>;
    maxAttempts?: number;
  }) {
    this.#store = opts.store;
    this.#send = opts.send;
    this.#maxAttempts = opts.maxAttempts ?? 10;
  }

  /**
   * افزودن به صف.
   *
   * ⚠️ بدون کلید Idempotency رد می‌شود. ارسال دوباره‌ی درخواستی که
   * کلید ندارد، اثر دوم می‌سازد — فاکتور دوم، پرداخت دوم.
   */
  async enqueue(r: Omit<QueuedRequest, "queuedAt" | "attempts">): Promise<void> {
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

  /**
   * ارسال دوباره همه.
   *
   * ⚠️ ترتیب حفظ می‌شود و اولین شکست **شبکه‌ای** بقیه را متوقف
   * می‌کند. اگر ادامه می‌داد، فروش دوم پیش از اول به سرور می‌رسید و
   * شماره‌گذاری سند بی‌ترتیب می‌شد.
   *
   * ولی شکست **غیرشبکه‌ای** متوقف نمی‌کند: آن درخواست از صف بیرون
   * می‌رود و بقیه ادامه می‌دهند — یک فاکتور رد‌شده نباید صف را برای
   * همیشه ببندد.
   */
  async flush(): Promise<FlushResult> {
    const rows = await this.#store.all();
    const out: FlushResult = { sent: 0, failed: 0, rejected: [] };

    for (const r of rows) {
      try {
        await this.#send(r);
        await this.#store.remove(r.id);
        out.sent += 1;
      } catch (err) {
        if (isNetworkFailure(err)) {
          const next = { ...r, attempts: r.attempts + 1 };
          if (next.attempts >= this.#maxAttempts) {
            // ده بار شکست شبکه‌ای پشت‌سرهم یعنی چیزی جز شبکه ایراد
            // دارد. نگه‌داشتنش تا ابد یعنی صف هرگز خالی نشود و کاربر
            // هرگز نفهمد.
            await this.#store.remove(r.id);
            out.rejected.push(next);
          } else {
            await this.#store.put(next);
            out.failed += 1;
          }
          break;
        }
        // سرور شنید و رد کرد. تکرارش همان رد را تکرار می‌کند.
        await this.#store.remove(r.id);
        out.rejected.push(r);
      }
    }
    return out;
  }
}
