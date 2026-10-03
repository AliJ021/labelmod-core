import { useEffect, useState } from "react";
import { parseWithdrawalOperation, persistWithdrawalOperation, withdrawalStorageKey, type WithdrawalBody, type WithdrawalOperation } from "./withdrawal-operation.ts";

export function useWithdrawalOperation(userId: string, target: string) {
  const [state, setState] = useState<{ pending: WithdrawalOperation | null; error: string }>(() => {
    try { return { pending: parseWithdrawalOperation(localStorage.getItem(withdrawalStorageKey(userId, target)), userId, target), error: "" }; }
    catch { return { pending: null, error: "بازیابی عملیات ذخیره‌شده ممکن نشد؛ ثبت تازه تا بررسی پشتیبانی بسته است." }; }
  });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== withdrawalStorageKey(userId, target)) return;
      try { setState({ pending: parseWithdrawalOperation(event.newValue, userId, target), error: "" }); }
      catch { setState(s => ({ ...s, error: "عملیات در تب دیگر خوانا نیست؛ ثبت تازه بسته است." })); }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [userId, target]);
  function prepare(body: WithdrawalBody) {
    if (!userId || state.error) throw new Error(state.error || "هویت کاربر هنوز مشخص نیست.");
    const pending = persistWithdrawalOperation(localStorage, userId, target, body, crypto.randomUUID());
    setState({ pending, error: "" });
    return pending;
  }
  function clear(key = state.pending?.key) {
    const slot = withdrawalStorageKey(userId, target);
    const current = parseWithdrawalOperation(localStorage.getItem(slot), userId, target);
    if (current && current.key === key) {
      localStorage.removeItem(slot);
      setState({ pending: null, error: "" });
    }
  }
  return { ...state, prepare, clear };
}
