/**
 * دفتر پاداش پرسنل — منطق خالص صفحه (مهاجرت ۰۹۸).
 *
 * **فقط ثبت و وضعیت؛ هیچ اثری بر صندوق، دفتر، انبار، حقوق یا پرداخت.**
 * ذی‌نفع، زمان، وضعیت و مجوز همه از سرور می‌آیند؛ اینجا فقط ورودی تومانی به
 * ریال رشته‌ای می‌رود (همان `checkAmount` دفتر برداشت) و بدنه و عملیات
 * ماندگار ساخته می‌شود — سرور دوباره می‌سنجد.
 */
import { checkAmount, checkText, type AmountCheck } from "./withdrawals.ts";

export type BonusStatus = "pending" | "approved" | "rejected" | "settled";
export interface BonusItem {
  id: string;
  owner: { id: string; name: string };
  origin: "request" | "award";
  /** ریال، رشته؛ همیشه مثبت و پس از ثبت تغییرناپذیر. */
  amount: string;
  reason: string;
  createdAt: string;
  createdBy: string;
  status: BonusStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  settledAt: string | null;
  settledBy: string | null;
  settlementNote: string | null;
}
export interface BonusDetail extends BonusItem {
  /** فقط در دفتر مدیر؛ نمایش است، دروازه سرور است. */
  canManage?: boolean;
}
export interface BonusPage { items: BonusItem[]; total: number; page: number; pageSize: number }

export const STATUS_LABEL: Readonly<Record<BonusStatus, string>> = {
  pending: "در انتظار بررسی", approved: "تأییدشده", rejected: "ردشده", settled: "تسویه‌شده",
};
export const ORIGIN_LABEL: Readonly<Record<BonusItem["origin"], string>> = { request: "درخواست کارمند", award: "اعطای مدیر" };

export interface RequestBody { amount: string; reason: string }
export interface AwardBody { ownerId: string; ownerName: string; amount: string; reason: string }
export type DecisionBody = { decision: "approved"; note?: string } | { decision: "rejected"; note: string };
export interface BonusSettlementBody { items: Array<{ id: string; amount: string; ownerName: string }>; note: string }
export type BonusBody = RequestBody | AwardBody | DecisionBody | BonusSettlementBody;

/** همان سنجش برداشت، با پیام «مبلغ پاداش» برای صفر. */
export function checkBonusAmount(amount: string): AmountCheck {
  return checkAmount(amount, false, false, "پاداش");
}

/** بدنهٔ درخواست، یا `null` اگر هنوز معتبر نیست. */
export function requestPayload(amount: string, reason: string): RequestBody | null {
  const a = checkBonusAmount(amount);
  if (a.rial === null || reason.trim() === "" || checkText(reason, "دلیل")) return null;
  return { amount: a.rial, reason: reason.trim() };
}

export function awardPayload(owner: { id: string; name: string } | null, amount: string, reason: string): AwardBody | null {
  const r = requestPayload(amount, reason);
  return owner && r ? { ownerId: owner.id, ownerName: owner.name, ...r } : null;
}

/** رد بی دلیل فرستادنی نیست؛ تأیید یادداشت اختیاری دارد. */
export function decisionPayload(decision: "approved" | "rejected", note: string): DecisionBody | null {
  const n = note.trim();
  if (n !== "" && checkText(n, "یادداشت")) return null;
  if (decision === "rejected") return n ? { decision, note: n } : null;
  return n ? { decision, note: n } : { decision };
}

/** فقط پاداش تأییدشده‌ای که مال خودِ مدیر نیست انتخاب‌شدنی است — همان شرط سرور. */
export function selectable(item: Pick<BonusItem, "status" | "owner">, currentUserId: string): boolean {
  return item.status === "approved" && item.owner.id !== currentUserId;
}

export const bonusStorageKey = (userId: string, target: string) => `labelmod.bonus-operation.${userId}.${target}`;
export interface BonusOperation { version: 1; userId: string; target: string; key: string; body: BonusBody }

const UUID = /^[a-f0-9-]{36}$/i;
const okText = (v: unknown, optional = false): boolean =>
  (optional && v === undefined) || (typeof v === "string" && v.trim() !== "" && v.length <= 500);
const okAmount = (v: unknown) => typeof v === "string" && /^\d{1,18}$/.test(v) && BigInt(v) > 0n;

function validBody(target: string, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  if (target === "request") return okAmount(o.amount) && okText(o.reason);
  if (target === "award") return typeof o.ownerId === "string" && UUID.test(o.ownerId) && okText(o.ownerName) && okAmount(o.amount) && okText(o.reason);
  if (target === "settle") {
    const items = o.items;
    return Array.isArray(items) && items.length >= 1 && items.length <= 500
      && new Set(items.map((i: { id?: unknown }) => i.id)).size === items.length
      && items.every((i: Record<string, unknown>) => typeof i.id === "string" && UUID.test(i.id) && okAmount(i.amount) && okText(i.ownerName))
      && okText(o.note);
  }
  if (target.startsWith("decide.")) {
    return (o.decision === "approved" && okText(o.note, true)) || (o.decision === "rejected" && okText(o.note));
  }
  return false;
}

/** دادهٔ ذخیره‌شدهٔ خراب ثبت تازه را می‌بندد؛ هرگز بی‌صدا به کلید تازه تبدیل نمی‌شود. */
export function parseBonusOperation(raw: string | null, userId: string, target: string): BonusOperation | null {
  if (raw === null) return null;
  const v = JSON.parse(raw) as Partial<BonusOperation> | null;
  if (!v || v.version !== 1 || v.userId !== userId || v.target !== target || typeof v.key !== "string" || !UUID.test(v.key)
    || !validBody(target, v.body)) throw new Error("عملیات ذخیره‌شدهٔ پاداش خوانا نیست؛ ثبت تازه تا بررسی بسته است.");
  return v as BonusOperation;
}

export function persistBonusOperation(storage: Pick<Storage, "getItem" | "setItem">, userId: string, target: string,
  body: BonusBody, key: string): BonusOperation {
  const slot = bonusStorageKey(userId, target);
  const prior = parseBonusOperation(storage.getItem(slot), userId, target);
  if (prior) {
    if (JSON.stringify(prior.body) !== JSON.stringify(body)) throw new Error("ابتدا نتیجهٔ عملیات قبلی را بررسی کنید.");
    return prior;
  }
  const raw = JSON.stringify({ version: 1, userId, target, key, body });
  const op = parseBonusOperation(raw, userId, target)!;
  storage.setItem(slot, raw); // باید پیش از هر POST موفق شود.
  return op;
}
