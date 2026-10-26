/**
 * عملیات ماندگار سفارش اینستاگرام — همان الگوی «اسکن معلق» صندوق (`pending-scan.ts`).
 *
 * هر تغییر (ساخت سفارش، سرآیند، اقلام، رزرو، علامت واریز، ارسال) **پیش از** ارسال با بدنه و کلید
 * Idempotency در `localStorage` می‌نشیند و تا روشن‌شدن نتیجه می‌ماند:
 *
 * - پاسخ گم شد (شبکه یا ۵xx): رکورد می‌ماند، ویرایش‌های همان سفارش قفل می‌شوند و تنها راه «بررسی و تلاش
 *   دوبارهٔ همان عملیات» است — همان بدنه و همان کلید. سرور با همان کلید Replay می‌دهد، پس اگر اثر نشسته
 *   باشد دوباره نمی‌نشیند (قلم دوم، سفارش دوم).
 * - رد قطعی (۴xx به‌جز `idempotency_in_flight`): رکورد پاک می‌شود؛ اثری ننشسته است. ولی در **تلاش دوباره**،
 *   ردِ نشست، مجوز، CSRF یا نرخ چیزی دربارهٔ تلاش اول نمی‌گوید و رکورد با کلید اصلی می‌ماند.
 * - بارگذاری دوباره و تب دیگر همان رکورد را می‌بینند (رویداد `storage`)؛ قفل مرورگر دو تب را هم‌زمان نمی‌گذارد.
 * - دادهٔ خراب هرگز بی‌صدا کلید تازه نمی‌شود؛ ثبت تازه را می‌بندد تا بررسی شود.
 *
 * دامنهٔ هر رکورد (کاربر، سفارش) است — و برای ساخت سفارش (کاربر، «new»): یک عملیات معلق در هر سفارش.
 */
import { ApiError } from "./api.ts";
import type { KeyValueStorage } from "./queue-store.ts";

export type IgOpKind = "create" | "update" | "line.add" | "line.qty" | "line.remove" | "reserve" | "unreserve" | "payment_state" | "shipping";
export interface IgOperation {
  version: 1;
  actorId: string;
  /** شناسهٔ سفارش، یا «new» برای ساخت سفارش. */
  scope: string;
  kind: IgOpKind;
  key: string;
  /** شناسهٔ قلم برای تغییر تعداد و حذف. */
  lineId?: string;
  body: Record<string, unknown>;
  /** متن کوتاه فارسی برای بنر «نتیجه قطعی نیست». */
  label: string;
}

const KINDS: readonly IgOpKind[] = ["create", "update", "line.add", "line.qty", "line.remove", "reserve", "unreserve", "payment_state", "shipping"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const igOperationSlot = (actorId: string, scope: string) => `labelmod.instagram-op.v1.${actorId}.${scope}`;

/** رکورد ذخیره‌شده؛ نبودن = null. دادهٔ ناخوانا خطا می‌دهد و هرگز «نبودن» تعبیر نمی‌شود. */
export function readIgOperation(actorId: string, scope: string, store: KeyValueStorage = localStorage): IgOperation | null {
  const raw = store.getItem(igOperationSlot(actorId, scope));
  if (raw === null) return null;
  let v: Partial<IgOperation> | null;
  try { v = JSON.parse(raw) as Partial<IgOperation> | null; } catch { v = null; }
  const okScope = scope === "new" || UUID.test(scope);
  if (!v || v.version !== 1 || v.actorId !== actorId || v.scope !== scope || !okScope || !UUID.test(actorId)
      || !KINDS.includes(v.kind as IgOpKind) || (scope === "new") !== (v.kind === "create")
      || typeof v.key !== "string" || !UUID.test(v.key)
      || (v.lineId !== undefined && (typeof v.lineId !== "string" || !UUID.test(v.lineId)))
      || ((v.kind === "line.qty" || v.kind === "line.remove") && v.lineId === undefined)
      || !v.body || typeof v.body !== "object" || Array.isArray(v.body)
      || typeof v.label !== "string" || v.label.length < 1 || v.label.length > 200) {
    throw new Error("عملیات معلق سفارش اینستاگرام خوانده نشد؛ داده حفظ شد و ثبت تازه تا بررسی بسته است.");
  }
  return v as IgOperation;
}

/** پیش از ارسال؛ باید موفق شود. عملیات دیگری که هنوز روشن نشده، رد می‌شود و دست نمی‌خورد. */
export function writeIgOperation(op: IgOperation, store: KeyValueStorage = localStorage): void {
  const existing = readIgOperation(op.actorId, op.scope, store);
  if (existing && JSON.stringify(existing) !== JSON.stringify(op)) {
    throw new Error("عملیات دیگری روی همین سفارش هنوز روشن نشده است؛ ابتدا همان را بررسی کنید.");
  }
  store.setItem(igOperationSlot(op.actorId, op.scope), JSON.stringify(op));
  // خواندن دوباره: ذخیره‌ای که بی‌صدا ننشیند (سهم پر، حالت خصوصی) یعنی ارسال بی پشتوانه.
  const back = readIgOperation(op.actorId, op.scope, store);
  if (!back || back.key !== op.key) throw new Error("ذخیرهٔ عملیات پیش از ارسال ممکن نشد؛ چیزی فرستاده نشد.");
}

/** فقط همان عملیات (با همان کلید) پاک می‌شود؛ عملیات تازه‌تر تب دیگر دست نمی‌خورد. */
export function clearIgOperation(actorId: string, scope: string, key: string, store: KeyValueStorage = localStorage): void {
  const existing = readIgOperation(actorId, scope, store);
  if (existing && existing.key !== key) return;
  store.removeItem(igOperationSlot(actorId, scope));
}

/**
 * آیا این شکست «اثر ننشست» را قطعی می‌گوید؟ شبکه، ۵xx و «هنوز در جریان» هرگز.
 *
 * `retry` یعنی همین عملیات پیش‌تر فرستاده شده و نتیجه‌اش نامعلوم مانده است. آنجا ردِ **دروازه‌های پیش از
 * کلید** — نشست منقضی (۴۰۱)، مجوز گرفته‌شده یا CSRF (۴۰۳)، محدودیت نرخ (۴۲۹)، مهلت (۴۰۸) — فقط می‌گوید این
 * تلاش به سرور نرسید، نه اینکه تلاش اول ثبت نشد؛ پس رکورد و کلید اصلی می‌مانند. ردِ کسب‌وکاری (۴۰۰، ۴۰۴، ۴۰۹،
 * ۴۲۲) پس از جست‌وجوی همان کلید در سرور می‌آید (Replay زودتر برمی‌گشت)، پس قطعی است.
 */
export function isDefinitiveRejection(err: unknown, retry = false): boolean {
  if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500 || err.code === "idempotency_in_flight") return false;
  return !(retry && [401, 403, 408, 429].includes(err.status));
}
