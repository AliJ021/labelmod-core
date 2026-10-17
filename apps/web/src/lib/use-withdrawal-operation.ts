import { useCallback, useEffect, useState } from "react";
import { bonusStorageKey, parseBonusOperation, persistBonusOperation, type BonusBody, type BonusOperation } from "./bonuses.ts";
import { parseWithdrawalOperation, persistWithdrawalOperation, withdrawalStorageKey, type WithdrawalBody, type WithdrawalOperation } from "./withdrawal-operation.ts";

/**
 * عملیات ماندگار با شناسهٔ ثابت — مشترک دفتر برداشت و پاداش.
 *
 * بدنه و کلید **پیش از** ارسال در `localStorage` می‌نشینند و تا روشن‌شدن نتیجه
 * می‌مانند؛ دادهٔ خراب هرگز بی‌صدا به کلید تازه تبدیل نمی‌شود و ثبت تازه را
 * می‌بندد. رویداد `storage` تب‌های دیگر را هم‌گام می‌کند.
 */
export function useDurableOperation<Body, Op extends { key: string; body: Body }>(userId: string, slot: string,
  parse: (raw: string | null) => Op | null, persist: (body: Body, key: string) => Op) {
  const [state, setState] = useState<{ pending: Op | null; error: string }>(() => {
    try { return { pending: parse(localStorage.getItem(slot)), error: "" }; }
    catch { return { pending: null, error: "بازیابی عملیات ذخیره‌شده ممکن نشد؛ ثبت تازه تا بررسی پشتیبانی بسته است." }; }
  });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== slot) return;
      try { setState({ pending: parse(event.newValue), error: "" }); }
      catch { setState(s => ({ ...s, error: "عملیات در تب دیگر خوانا نیست؛ ثبت تازه بسته است." })); }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [slot, parse]);
  function prepare(body: Body) {
    if (!userId || state.error) throw new Error(state.error || "هویت کاربر هنوز مشخص نیست.");
    const pending = persist(body, crypto.randomUUID());
    setState({ pending, error: "" });
    return pending;
  }
  function clear(key = state.pending?.key) {
    const current = parse(localStorage.getItem(slot));
    if (current && current.key === key) {
      localStorage.removeItem(slot);
      setState({ pending: null, error: "" });
    }
  }
  return { ...state, prepare, clear };
}

export function useWithdrawalOperation(userId: string, target: string) {
  const parse = useCallback((raw: string | null) => parseWithdrawalOperation(raw, userId, target), [userId, target]);
  return useDurableOperation<WithdrawalBody, WithdrawalOperation>(userId, withdrawalStorageKey(userId, target), parse,
    (body, key) => persistWithdrawalOperation(localStorage, userId, target, body, key));
}

export function useBonusOperation(userId: string, target: string) {
  const parse = useCallback((raw: string | null) => parseBonusOperation(raw, userId, target), [userId, target]);
  return useDurableOperation<BonusBody, BonusOperation>(userId, bonusStorageKey(userId, target), parse,
    (body, key) => persistBonusOperation(localStorage, userId, target, body, key));
}
