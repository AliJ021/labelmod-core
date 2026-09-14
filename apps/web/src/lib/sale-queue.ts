/**
 * اتصال صف آفلاین به مسیر فروش — تنها مصرف‌کنندهٔ `OfflineQueue`.
 *
 * ── دامنه، صریح ──────────────────────────────────────────────────────
 *
 * این **حالت آفلاین کامل نیست** و نباید بشود. `CLAUDE.md` تفکیک را
 * روشن گذاشته: صف آفلاین درخواستی را نگه می‌دارد که «سرور قبولش
 * می‌کرد اگر شبکه قطع نمی‌شد». پس فقط **یک** عمل صف می‌شود:
 *
 *   نهایی‌کردن فاکتوری که همهٔ سطرها و پرداخت‌هایش **آنلاین** ثبت شده‌اند.
 *
 * یعنی هیچ تصمیم مالی در مرورگر گرفته نمی‌شود: نه شماره‌گذاری سند، نه
 * بررسی موجودی، نه قیمت‌گذاری، نه کفایت پرداخت. همه‌شان سرور است و
 * همان‌جا می‌ماند. فاکتور تا لحظهٔ ارسال یک **پیش‌نویس روی سرور** است.
 *
 * ⚠️ و آنچه صف نمی‌کند: اسکن بارکد، افزودن سطر، ثبت پرداخت، باز و بستن
 *    شیفت. هر یک از این‌ها به پاسخ سرور **نیاز** دارد (قیمت، موجودی،
 *    مانده) و صف‌کردنشان یعنی صفحه عددی نشان بدهد که هیچ‌کس تأییدش
 *    نکرده.
 *
 * ── و یک ریسک که پنهانش نمی‌کنیم ─────────────────────────────────────
 *
 * `finalize_invoice` در لحظهٔ اجرا موجودی را از انبار خارج می‌کند. اگر
 * میان قطعی و ارسالِ صف، همان کالا از صندوق دیگری فروخته شود، فروشِ
 * صف‌شده رد می‌شود و ردیف با `pausedReason = "response_error"` پارک
 * می‌ماند تا آدمی رسیدگی کند. این از «فروش گم شود» بهتر است و از
 * «موجودی منفی شود» هم بهتر — ولی **نامرئی نیست**: نشانگر معلق‌ها
 * همین را نشان می‌دهد.
 */
import { api } from "./api.ts";
import { OfflineQueue, type QueuedRequest } from "./offline-queue.ts";
import { localQueueStore } from "./queue-store.ts";

/**
 * بازفرست یک درخواست صف‌شده.
 *
 * ⚠️ از همان `api` می‌گذرد که صفحه از آن می‌گذرد، نه یک `fetch` تازه:
 *    کوکی نشست، توکن CSRF و ترجمهٔ خطای فارسی سرور همه آنجا هستند.
 *    یک `fetch` دستی، هر سه را از دست می‌داد و ۴۰۳ بی‌توضیح می‌گرفت.
 */
export async function replay(r: QueuedRequest): Promise<void> {
  if (r.method !== "POST") {
    /*
     * امروز فقط POST صف می‌شود. متد ناشناخته **رد** می‌شود نه اینکه
     * حدس زده شود — ردیفی که با متد اشتباه فرستاده شود، یا اثر
     * نمی‌گذارد یا اثر دیگری می‌گذارد.
     */
    throw new Error(`متد صف‌نشدنی: ${r.method}`);
  }
  await api.post(r.path, r.body ?? {}, { idempotencyKey: r.idempotencyKey });
}

let instance: OfflineQueue | null = null;

/**
 * صف مشترک صفحه.
 *
 * تنبل ساخته می‌شود چون `localStorage` در محیط تست Node وجود ندارد و
 * ساختنِ سطح‌ماژول، هر `import` را می‌شکست.
 */
export function saleQueue(): OfflineQueue {
  instance ??= new OfflineQueue({ store: localQueueStore(), send: replay });
  return instance;
}

/** فقط برای تست. */
export function resetSaleQueue(): void {
  instance = null;
}

export interface PendingSummary {
  /** همهٔ ردیف‌های صف. */
  total: number;
  /** ردیف‌هایی که تلاش خودکار ندارند و آدم باید ببیندشان. */
  parked: number;
}

export function summarize(rows: readonly QueuedRequest[]): PendingSummary {
  return {
    total: rows.length,
    parked: rows.filter((r) => r.pausedReason !== undefined).length,
  };
}

/**
 * متن نشانگر معلق‌ها.
 *
 * ⚠️ «۰ فروش در انتظار» نمایش داده **نمی‌شود**: نشانگری که همیشه هست،
 *    دیده نمی‌شود. `null` یعنی چیزی نشان نده.
 */
export function pendingLabel(s: PendingSummary): string | null {
  if (s.total === 0) return null;
  const head = `${s.total} فروش در انتظار ارسال`;
  return s.parked === 0 ? head : `${head} — ${s.parked} نیازمند رسیدگی`;
}
