/**
 * ذخیرهٔ **پایدار** صف آفلاین — تنها پیاده‌سازی غیرحافظه‌ای.
 *
 * ── چرا این فایل لازم شد (FND-002) ───────────────────────────────────
 *
 * `offline-queue.ts` از روز اول درست نوشته شده بود و تست هم داشت، ولی
 * تنها `QueueStore` مخزن `memoryStore()` بود که کامنت خودش می‌گفت «برای
 * تست؛ با بسته‌شدن صفحه از بین می‌رود». یعنی صفی که وعده‌اش «فروش را
 * هنگام قطعی نگه می‌دارم» بود، با یک Reload خالی می‌شد — و هیچ‌جا هم
 * وصل نبود.
 *
 * ── چرا `localStorage` و نه IndexedDB ────────────────────────────────
 *
 * ۱. **نوشتن همگام است.** تا `setItem` برنگردد، خط بعدی اجرا نمی‌شود؛
 *    پس وقتی به صندوق‌دار می‌گوییم «در صف است»، واقعاً روی دیسک است.
 *    تراکنش IndexedDB ممکن است در لحظهٔ بسته‌شدن تب باز باشد و
 *    `oncomplete` هرگز نرسد — یعنی همان فروشی که وعده دادیم نگه
 *    می‌داریم.
 * ۲. **حجم مسئله کوچک است.** چند فروش معلق، نه یک پایگاه داده. سهم
 *    ۵ مگابایتی `localStorage` برای این کار چند هزار برابر لازم است.
 * ۳. **قابل بازرسی و قابل آزمون.** یک رشتهٔ JSON که آدم می‌تواند در
 *    Console ببیند، و در تست با یک شیء ساده جایش را بگیرد.
 *
 * ⚠️ و دو چیزی که این فایل عمداً **نمی‌کند**: رمزنگاری (سطح تهدیدش
 *    دستگاه صندوق است، نه شبکه — و کلید رمز هم باید همان‌جا بنشیند)، و
 *    هماهنگی چند تب. قفل `flush` فقط درون‌نمونه‌ای است؛ دو تب که
 *    هم‌زمان Flush کنند، دومی `idempotency_in_flight` می‌گیرد که
 *    `isNetworkFailure` آن را موقتی می‌شناسد (FND-003).
 */
import type { QueuedRequest, QueueStore } from "./offline-queue.ts";

/** همان قراری که `localStorage` دارد — تزریق‌شدنی برای تست. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class QueueStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "QueueStoreError";
  }
}

/**
 * آیا این شیء یک درخواست صف‌شدهٔ سالم است؟
 *
 * ⚠️ سخت‌گیری اینجا **امنیتی** است، نه سلیقه: ردیفی که
 * `idempotencyKey` نداشته باشد و دوباره فرستاده شود، **فاکتور دوم**
 * می‌سازد. پس ردیف ناقص، ردیف نیست.
 */
function valid(row: unknown): row is QueuedRequest {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id !== "" &&
    typeof r.method === "string" && r.method !== "" &&
    typeof r.path === "string" && r.path.startsWith("/") &&
    typeof r.idempotencyKey === "string" && r.idempotencyKey.trim() !== "" &&
    typeof r.label === "string" &&
    typeof r.queuedAt === "number" && Number.isFinite(r.queuedAt) &&
    typeof r.attempts === "number" && Number.isInteger(r.attempts) && r.attempts >= 0
  );
}

export const QUEUE_KEY = "labelmod_sale_queue_v1";

/**
 * ذخیرهٔ پایدار روی `localStorage`.
 *
 * ⚠️ دادهٔ خراب **خطا می‌دهد و صف را پاک نمی‌کند**. وسوسه این است که
 *    `catch { return [] }` بنویسیم تا صفحه بالا بیاید؛ نتیجه‌اش این بود
 *    که صندوق‌دار «۰ فروش در انتظار» می‌دید در حالی که چند فروش در
 *    همان رشته نشسته بود. خطای آشکار، صفرِ دروغین نیست.
 */
export function localQueueStore(opts: {
  storage?: KeyValueStorage;
  key?: string;
} = {}): QueueStore {
  const key = opts.key ?? QUEUE_KEY;
  const storage = opts.storage ?? browserStorage();

  function read(): QueuedRequest[] {
    const raw = storage.getItem(key);
    if (raw === null || raw === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new QueueStoreError(
        "queue_unreadable",
        "صف فروش‌های معلق خوانده نشد. پیش از فروش تازه با پشتیبانی تماس بگیرید — این صف پاک نمی‌شود.",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new QueueStoreError("queue_unreadable", "صف فروش‌های معلق شکل درستی ندارد.");
    }
    const bad = parsed.filter((r) => !valid(r)).length;
    if (bad > 0) {
      throw new QueueStoreError(
        "queue_corrupt_row",
        `${bad} ردیف صف ناقص است و بازفرستادنش اثر دوم می‌ساخت. صف دست‌نخورده ماند.`,
      );
    }
    return (parsed as QueuedRequest[]).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  function write(rows: QueuedRequest[]): void {
    /*
     * ⚠️ `QuotaExceededError` بلعیده نمی‌شود. اگر می‌بلعیدیم، `enqueue`
     *    بی‌صدا موفق می‌شد و فروش هیچ‌جا نمی‌نشست — بدترین حالت ممکن:
     *    صندوق‌دار پیام «در صف است» می‌دید و صف خالی بود.
     */
    storage.setItem(key, JSON.stringify(rows));
  }

  return {
    all: async () => read(),
    put: async (r) => {
      const rows = read().filter((x) => x.id !== r.id);
      rows.push(r);
      write(rows);
    },
    remove: async (id) => {
      const rows = read();
      const left = rows.filter((x) => x.id !== id);
      if (left.length === rows.length) return;
      write(left);
    },
  };
}

/** `localStorage` مرورگر — نبودنش خطای آشکار است، نه سقوط بی‌صدا به حافظه. */
export function browserStorage(): KeyValueStorage {
  const s = typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  if (s === null) {
    throw new QueueStoreError(
      "no_persistent_storage",
      "ذخیرهٔ پایدار در این مرورگر در دسترس نیست — صف فروش آفلاین کار نمی‌کند.",
    );
  }
  return s;
}
