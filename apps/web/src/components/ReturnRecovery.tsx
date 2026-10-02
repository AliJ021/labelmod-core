import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { session } from "../lib/session.ts";
import { operationStorageKey, parseReturnOperation, type ReturnOperation } from "../lib/return-operation.ts";
import { SafeAction } from "./ui/SafeAction.tsx";

export function useReturnOperation(onDone: (number: string) => void) {
  const [userId, setUserId] = useState("");
  const [pending, setPending] = useState<ReturnOperation | null>(null);
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    let alive = true;
    void session.me().then(me => {
      if (!alive) return;
      if (!me) { setStorageError("برای بازیابی عملیات وارد شوید"); return; }
      setUserId(me.id);
      try { setPending(parseReturnOperation(localStorage.getItem(operationStorageKey(me.id)), me.id)); }
      catch (e) { setStorageError(e instanceof Error ? e.message : "ذخیره عملیات در دسترس نیست"); }
    }).catch(() => { if (alive) setStorageError("هویت کاربر برای بازیابی عملیات خوانده نشد"); });
    const changed = (e: StorageEvent) => {
      if (e.key !== operationStorageKey(userId)) return;
      try { setPending(parseReturnOperation(e.newValue, userId)); }
      catch { setStorageError("شناسه عملیات در تب دیگر خوانا نیست؛ بررسی پشتیبانی لازم است"); }
    };
    window.addEventListener("storage", changed);
    return () => { alive = false; window.removeEventListener("storage", changed); };
  }, [userId]);
  function clear(op: ReturnOperation) {
    const current = parseReturnOperation(localStorage.getItem(operationStorageKey(userId)), userId);
    if (current?.key === op.key) localStorage.removeItem(operationStorageKey(userId));
    setPending(current?.key === op.key ? null : current);
  }
  async function verify() {
    const op = pending ?? parseReturnOperation(localStorage.getItem(operationStorageKey(userId)), userId);
    if (!op) throw new Error("عملیاتی برای بررسی پیدا نشد");
    const result = await api.get<{ status: string; number?: string }>(`/${op.kind}/status/${op.key}`);
    if (result.status === "not_found") throw new Error("نتیجه هنوز معلوم نیست؛ عملیات جدید ثبت نکنید");
    if (result.status === "posted") { clear(op); onDone(result.number ?? ""); return true; }
    if (result.status === "abandoned") { clear(op); return false; }
    throw new Error("پاسخ وضعیت معتبر نیست");
  }
  async function run(kind: ReturnOperation["kind"], body: unknown) {
    if (!userId || storageError) throw new Error(storageError || "هویت کاربر هنوز خوانده نشده");
    if (parseReturnOperation(localStorage.getItem(operationStorageKey(userId)), userId))
      throw new Error("عملیات قبلی هنوز نتیجه قطعی ندارد؛ ابتدا وضعیت را بررسی کنید");
    const raw = JSON.stringify({ userId, kind, key: crypto.randomUUID(), version: 1, body });
    const op = parseReturnOperation(raw, userId)!;
    // نوشتن پایدار پیش از شبکه؛ شکست quota هیچ درخواست مالی نمی‌فرستد.
    localStorage.setItem(operationStorageKey(userId), raw);
    setPending(op);
    try {
      const result = await api.post<{ number: string }>(kind === "returns" ? "/returns/commit" : "/exchanges", op.body, { idempotencyKey: op.key });
      clear(op); onDone(result.number);
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && !["idempotency_in_flight", "idempotency_key_reused"].includes(e.code)) clear(op);
      throw e;
    }
  }
  async function retry() {
    if (!userId || storageError) throw new Error(storageError || "هویت کاربر هنوز خوانده نشده");
    const op = parseReturnOperation(localStorage.getItem(operationStorageKey(userId)), userId);
    if (!op?.body || op.version !== 1) throw new Error("بدنه این عملیات قدیمی ذخیره نشده؛ بررسی پشتیبانی لازم است");
    // تنها اقدام صریح کاربر، با همان بدنه و همان کلید؛ شکست دوباره شناسه را پاک نمی‌کند.
    setPending(op);
    const result = await api.post<{ number: string }>(op.kind === "returns" ? "/returns/commit" : "/exchanges", op.body, { idempotencyKey: op.key });
    clear(op); onDone(result.number);
  }
  async function abandon() {
    if (!pending) return;
    await api.post(`/${pending.kind}/status/${pending.key}/abandon`, { noExternalPayment: true });
    await verify();
  }
  return { pending, storageError, ready: !!userId && !storageError, run, verify, retry, abandon };
}

export function ReturnRecovery({ operation }: { operation: ReturnType<typeof useReturnOperation> }) {
  const [error, setError] = useState("");
  if (operation.storageError) return <p role="alert">{operation.storageError}</p>;
  if (!operation.pending) return null;
  return <section className="solid pad stack" aria-label="بازیابی عملیات مالی">
    <h3>نتیجه عملیات در انتظار بررسی</h3>
    <p>پیش از ثبت عملیات تازه، وضعیت همان شناسه بررسی می‌شود. بستن صفحه این شناسه را پاک نمی‌کند.</p>
    <button className="btn btn--primary" type="button" onClick={() => void operation.verify().catch(e => setError(e instanceof Error ? e.message : "وضعیت خوانده نشد"))}>بررسی وضعیت</button>
    {error ? <p role="alert">{error}</p> : null}
    {operation.pending.version === 1 && operation.pending.body ? <SafeAction
      trigger="ارسال دوباره همان عملیات" title="ادامه عملیات با شناسه قبلی"
      summary="همان اقلام، مبالغ و روش تسویه تأییدشده دوباره به سرور فرستاده می‌شود."
      consequence="وجه را دوباره دریافت یا بازپرداخت نکنید. اگر ثبت قبلاً انجام شده باشد، سرور همان نتیجه را برمی‌گرداند."
      confirmLabel="همان درخواست را با همان شناسه ارسال کن" pendingLabel="در حال بازیابی ثبت…"
      run={operation.retry} verify={operation.verify} onDone={() => setError("")} /> :
      <p>بدنه این عملیات قدیمی ذخیره نشده؛ اگر وضعیت پیدا نشد، بررسی پشتیبانی لازم است.</p>}
    <SafeAction trigger="هیچ دریافت یا بازپرداخت بیرونی انجام نشده؛ پایان انتظار" title="بستن قصد انجام‌نشده"
      summary="تنها اگر هیچ وجهی در صندوق یا درگاه جابه‌جا نشده این گزینه را تأیید کنید."
      consequence="سرور با درخواست هم‌زمان تعیین تکلیف می‌کند. اگر ثبت شده باشد همان نتیجه بازیابی می‌شود؛ در غیر این صورت درخواست دیررس مسدود می‌شود."
      confirmLabel="وجهی جابه‌جا نشده؛ بررسی و بستن" pendingLabel="در حال تعیین تکلیف…"
      run={operation.abandon} verify={operation.verify} onDone={() => setError("")} />
  </section>;
}
