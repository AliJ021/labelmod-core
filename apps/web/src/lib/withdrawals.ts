/**
 * دفتر برداشت پرسنل — منطق خالص صفحه (مهاجرت ۰۸۴).
 *
 * **فقط ثبت «مبلغ + دلیل»؛ هیچ اثری بر صندوق، دفتر، انبار یا حقوق.** این
 * فایل هیچ تصمیم مالی یا دسترسی نمی‌گیرد: مالک، زمان، نسخه و مجوز همه از
 * سرور می‌آیند. اینجا فقط ورودی تومانی به ریال رشته‌ای می‌رود (از همان مرز
 * `money.ts`) و پیام خطای کنار فیلد ساخته می‌شود — سرور دوباره می‌سنجد.
 */
import { formatCount } from "./format.ts";
import { rialFromTomanInput } from "./money.ts";

export interface WithdrawalItem {
  id: string;
  owner: { id: string; name: string };
  createdAt: string;
  version: number;
  /** ریال، رشته. «0» یعنی صفر واقعی (اصلاح مدیر)، نه نامعلوم. */
  amount: string;
  reason: string;
  correctedAt: string | null;
  correctedBy: string | null;
}
export interface WithdrawalRevision {
  version: number; amount: string; reason: string; note: string | null;
  actor: { id: string; name: string }; at: string;
}
export interface WithdrawalDetail extends WithdrawalItem {
  history: WithdrawalRevision[];
  /** فقط در دفتر مدیر؛ نمایش است، دروازه سرور است. */
  canCorrect?: boolean;
}
export interface WithdrawalPage { items: WithdrawalItem[]; total: number; page: number; pageSize: number }

export const REASON_MAX = 500;
export const PAGE_SIZE = 20;

/** همان حد سرور: NUMERIC(18,0) و رشتهٔ ۱۸ رقمی. */
const RIAL_MAX = 999_999_999_999_999_999n;

export type AmountCheck = { rial: string; error: null } | { rial: null; error: string | null };

/**
 * مبلغ تومانیِ تایپ‌شده → ریال رشته‌ای.
 *   خالی     خطا نیست (هنوز تایپ نشده) ولی معتبر هم نیست.
 *   صفر      برای ثبت تازه رد؛ برای اصلاح مدیر مجاز (`allowZero`).
 */
export function checkAmount(raw: string, allowZero: boolean): AmountCheck {
  if (raw.trim() === "") return { rial: null, error: null };
  const rial = rialFromTomanInput(raw);
  if (rial === null) return { rial: null, error: "فقط رقم بنویسید؛ مبلغ به تومان و بدون اعشار است." };
  if (rial > RIAL_MAX) return { rial: null, error: "مبلغ بزرگ‌تر از حد مجاز است." };
  if (rial === 0n && !allowZero) return { rial: null, error: "مبلغ برداشت باید بیشتر از صفر باشد." };
  return { rial: rial.toString(), error: null };
}

/** نویسه‌های کنترلی و جهت‌دهی — همان فهرست سرور (`apps/api/src/lib/text.ts`). */
// eslint-disable-next-line no-control-regex -- گرفتنِ همین نویسه‌ها تمام هدف این الگوست
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

export function checkText(raw: string, label: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (v.length > REASON_MAX) return `${label} حداکثر ${formatCount(REASON_MAX)} نویسه است.`;
  if (CONTROL.test(v)) return `${label} نویسهٔ نامجاز دارد.`;
  return null;
}

/** بدنهٔ ثبت، یا `null` اگر هنوز معتبر نیست. */
export function createPayload(amount: string, reason: string): { amount: string; reason: string } | null {
  const a = checkAmount(amount, false);
  if (a.rial === null || reason.trim() === "" || checkText(reason, "دلیل")) return null;
  return { amount: a.rial, reason: reason.trim() };
}

export interface CorrectionPayload { expectedVersion: number; amount: string; reason: string; note: string }

/**
 * بدنهٔ اصلاح، یا دلیل اینکه چرا هنوز فرستادنی نیست. «بی تغییر» را همین‌جا
 * می‌گوید تا مدیر پیش از تأیید بداند؛ سرور هم ۴۲۲ `withdrawal_no_change` می‌دهد.
 */
export function correctionPayload(current: Pick<WithdrawalItem, "version" | "amount" | "reason">,
  draft: { amount: string; reason: string; note: string }): { payload: CorrectionPayload; blocker: null } | { payload: null; blocker: string | null } {
  const a = checkAmount(draft.amount, true);
  if (a.rial === null) return { payload: null, blocker: a.error };
  const reason = draft.reason.trim(), note = draft.note.trim();
  if (reason === "" || checkText(reason, "دلیل")) return { payload: null, blocker: null };
  if (note === "" || checkText(note, "دلیل اصلاح")) return { payload: null, blocker: null };
  if (BigInt(a.rial) === BigInt(current.amount) && reason === current.reason) {
    return { payload: null, blocker: "مبلغ و دلیل همان مقدار فعلی‌اند؛ چیزی برای اصلاح نیست." };
  }
  return { payload: { expectedVersion: current.version, amount: a.rial, reason, note }, blocker: null };
}

/** رقم ریالی → متن تومانیِ قابل ویرایش در فیلد (بی جداکننده، رقم لاتین). */
export function tomanDraft(rial: string): string {
  return (BigInt(rial) / 10n).toString();
}

/**
 * آیا اصلاحِ با نتیجهٔ نامعلوم نشسته است؟ فقط از پاسخ خواندنی سرور:
 * نسخهٔ بعدی همان شرط، با همان مقدار و دلیل اصلاح.
 */
export function correctionLanded(detail: Pick<WithdrawalDetail, "history">, sent: CorrectionPayload): "landed" | "absent" | "superseded" {
  const next = detail.history.find(h => h.version === sent.expectedVersion + 1);
  if (!next) return "absent";
  return next.amount === sent.amount && next.reason === sent.reason && next.note === sent.note ? "landed" : "superseded";
}
