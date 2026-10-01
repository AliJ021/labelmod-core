/**
 * قصد پرداختی که نتیجه‌اش روشن نیست — پایدار تا Reload آن را گم نکند (F-115-01).
 *
 * ── چرا لازم است ──
 *
 * کلید پرداخت قبلاً فقط در حافظهٔ صفحه (`ActionKeys`) بود. پرداختی که پاسخش گم
 * شده و بعد صفحه Reload شود، کلیدش را از دست می‌داد: صندوق‌دار همان پرداخت را با
 * کلید **تازه** دوباره می‌فرستاد و اگر اولی نشسته بود، پول دو بار ثبت می‌شد.
 *
 * ── چه چیزی ذخیره می‌شود ──
 *
 * فقط آنچه برای ساختن **همان** درخواست و بررسی **همان** شناسه لازم است: فاکتور،
 * شیفت، کلید (= `client_event_id` سرور)، روش، مبلغ ریالی و شمارهٔ پیگیری — چون
 * سرور بدنه را با بدنهٔ همان کلید مقایسه می‌کند. هیچ رازی اینجا نیست.
 *
 * ── قاعده‌ها، همان قاعده‌های اسکن معلق (`pending-scan.ts`) ──
 *
 * - **پیش از** ارسال نوشته می‌شود؛ نوشتن ناموفق یعنی ارسال نشود.
 * - دادهٔ خراب پاک نمی‌شود و خطا می‌دهد: «پرداخت معلقی نیست» برای قصدی که
 *   خوانده نشده، از هر خطایی خطرناک‌تر است.
 * - قصد دیگری را بازنویسی نمی‌کند و پاک‌کردن فقط با همان کلید است.
 * - فقط پس از حالت **نهایی** سرور پاک می‌شود (ثبت شد، مهر شد، فاکتور بسته شد)
 *   یا پس از ردِ قطعیِ نخستین ارسال.
 */
import type { KeyValueStorage } from "./queue-store.ts";

export interface PendingPayment {
  actorId: string;
  invoiceId: string;
  shiftId: string;
  /** همان `Idempotency-Key` و `client_event_id`. */
  key: string;
  methodCode: string;
  methodName: string;
  /** ریال، رقم خالص — پول هرگز `number` نیست. */
  amount: string;
  refNo: string;
  /** `sending` پیش از ارسال؛ `unresolved` پس از پاسخ نامعلوم. */
  state: "sending" | "unresolved";
}

const storageKey = (actorId: string) => `labelmod_pending_payment_v1:${actorId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ["actorId", "invoiceId", "shiftId", "key", "methodCode", "methodName", "amount", "refNo", "state"];
const BROKEN = "پرداخت معلق خوانده نشد؛ داده حفظ شد. پیش از پرداخت تازه با پشتیبانی تماس بگیرید.";

export function readPendingPayment(actorId: string, store: KeyValueStorage = localStorage): PendingPayment | null {
  const raw = store.getItem(storageKey(actorId));
  if (!raw) return null;
  let r: Partial<PendingPayment> & Record<string, unknown>;
  try { r = JSON.parse(raw) as typeof r; } catch { throw new Error(BROKEN); }
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (!r || typeof r !== "object" || Object.keys(r).some((k) => !FIELDS.includes(k)) ||
      r.actorId !== actorId || ![r.actorId, r.invoiceId, r.shiftId, r.key].every((v) => typeof v === "string" && UUID.test(v)) ||
      !str(r.methodCode, 64) || r.methodCode === "" || !str(r.methodName, 200) ||
      typeof r.amount !== "string" || !/^[1-9][0-9]{0,17}$/.test(r.amount) || !str(r.refNo, 64) ||
      (r.state !== "sending" && r.state !== "unresolved"))
    throw new Error(BROKEN);
  return r as PendingPayment;
}

/** نوشتن یا به‌روزکردن وضعیت **همان** قصد؛ قصد دیگری را هرگز بازنویسی نمی‌کند. */
export function writePendingPayment(p: PendingPayment, store: KeyValueStorage = localStorage): void {
  const existing = readPendingPayment(p.actorId, store);
  if (existing && existing.key !== p.key)
    throw new Error("پرداخت دیگری هنوز تعیین تکلیف نشده است؛ ابتدا وضعیت همان را بررسی کنید.");
  if (existing && JSON.stringify({ ...existing, state: p.state }) !== JSON.stringify(p))
    throw new Error("بدنهٔ پرداخت معلق عوض نمی‌شود؛ همان پرداخت با همان شناسه بررسی یا تکرار می‌شود.");
  store.setItem(storageKey(p.actorId), JSON.stringify(p));
}

export function clearPendingPayment(actorId: string, expectedKey: string, store: KeyValueStorage = localStorage): void {
  const existing = readPendingPayment(actorId, store);
  if (existing && existing.key !== expectedKey)
    throw new Error("پرداخت معلق تغییر کرده است؛ پرداخت دیگر پاک نشد.");
  store.removeItem(storageKey(actorId));
}
