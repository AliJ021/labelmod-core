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
import { session } from "./session.ts";
import { pos } from "./pos.ts";

export function validateSaleRequest(r: QueuedRequest): NonNullable<QueuedRequest["saleContext"]> {
  const c = r.saleContext;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!c || ![c.actorId, c.invoiceId, c.branchId, c.shiftId].every(v => typeof v === "string" && uuid.test(v)) ||
      r.method !== "POST" || r.path !== `/invoices/${c.invoiceId}/finalize` ||
      !r.body || typeof r.body !== "object" || Array.isArray(r.body) || Object.keys(r.body).length !== 0) {
    throw new Error("زمینهٔ معتبر فروش در صف نیست؛ ردیف حفظ شد و نیازمند رسیدگی است.");
  }
  return c;
}

/**
 * بازفرست یک درخواست صف‌شده.
 *
 * ⚠️ از همان `api` می‌گذرد که صفحه از آن می‌گذرد، نه یک `fetch` تازه:
 *    کوکی نشست، توکن CSRF و ترجمهٔ خطای فارسی سرور همه آنجا هستند.
 *    یک `fetch` دستی، هر سه را از دست می‌داد و ۴۰۳ بی‌توضیح می‌گرفت.
 */
export async function replay(r: QueuedRequest): Promise<void> {
  const c = validateSaleRequest(r);
  const who = await session.me();
  if (who?.id !== c.actorId) throw new Error("این فروش متعلق به کاربر فعلی نیست؛ ردیف صف حفظ شد.");
  const invoice = await pos.invoice(c.invoiceId);
  if (invoice.createdBy !== c.actorId || invoice.branchId !== c.branchId || invoice.shiftId !== c.shiftId)
    throw new Error("زمینهٔ فاکتور با صف یکسان نیست؛ ردیف صف حفظ شد.");
  if (invoice.status === "draft") {
    const shift = await pos.currentShift(c.branchId);
    if (shift?.id !== c.shiftId || shift.userId !== c.actorId || shift.status !== "open")
      throw new Error("شیفت این فروش باز نیست؛ ردیف صف حفظ شد.");
  }
  const done = await api.post<{id:string;status:string;number:string}>(`/invoices/${c.invoiceId}/finalize`, {}, { idempotencyKey: r.idempotencyKey });
  if (done.id !== c.invoiceId || !["finalized", "paid", "partially_returned", "returned"].includes(done.status) || !done.number)
    throw new Error("پاسخ نهایی‌سازی تأیید نشد؛ ردیف صف حفظ شد.");
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
