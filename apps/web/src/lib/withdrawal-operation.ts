import type { CorrectionPayload } from "./withdrawals.ts";

export type WithdrawalBody = { amount: string; reason: string } | CorrectionPayload;
export interface WithdrawalOperation { version: 1; userId: string; target: string; key: string; body: WithdrawalBody }
export const withdrawalStorageKey = (userId: string, target: string) => `labelmod.withdrawal-operation.${userId}.${target}`;

/** Invalid persisted state blocks a new submission; it must never silently become a fresh key. */
export function parseWithdrawalOperation(raw: string | null, userId: string, target: string): WithdrawalOperation | null {
  if (raw === null) return null;
  const v = JSON.parse(raw) as Partial<WithdrawalOperation> | null;
  const b = v?.body;
  if (!v || v.version !== 1 || v.userId !== userId || v.target !== target
    || typeof v.key !== "string" || !/^[a-f0-9-]{36}$/i.test(v.key)
    || !b || typeof b.amount !== "string" || !/^\d{1,18}$/.test(b.amount)
    || typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 500
    || (target !== "create" && (!("expectedVersion" in b) || !Number.isInteger(b.expectedVersion)
      || b.expectedVersion < 1 || typeof b.note !== "string" || !b.note.trim() || b.note.length > 500)))
    throw new Error("عملیات ذخیره‌شده خوانا نیست؛ پیش از ثبت تازه بررسی پشتیبانی لازم است.");
  return v as WithdrawalOperation;
}

export function persistWithdrawalOperation(storage: Pick<Storage, "getItem" | "setItem">,
  userId: string, target: string, body: WithdrawalBody, key: string): WithdrawalOperation {
  const slot = withdrawalStorageKey(userId, target);
  const prior = parseWithdrawalOperation(storage.getItem(slot), userId, target);
  if (prior) {
    if (JSON.stringify(prior.body) !== JSON.stringify(body)) throw new Error("ابتدا نتیجهٔ عملیات قبلی را بررسی کنید.");
    return prior;
  }
  const raw = JSON.stringify({ version: 1, userId, target, key, body });
  const op = parseWithdrawalOperation(raw, userId, target)!;
  storage.setItem(slot, raw); // Must succeed before any POST.
  return op;
}
