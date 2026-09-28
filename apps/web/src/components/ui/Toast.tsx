import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { STATUS, type StatusState } from "./Status.tsx";

/**
 * Toast — فقط بازخورد **گذرا** (docs/UI_PATTERNS.md، «اعلان‌ها»).
 *
 * سه ردهٔ اعلان از هم جدا می‌مانند:
 *   گذرا        «ذخیره شد» — Toast، خودبه‌خود می‌رود.
 *   نیازمند عمل  «دوره باز مانده» — داخل صفحه، کنار همان داده، با دکمه.
 *   پایدار      «بکاپ ۳ روز است اجرا نشده» — بنر/سلامت سیستم، تا رفع.
 * خطای مالی و وضعیت نامعلوم هرگز Toast نیستند: کاربر نباید با رفتن یک
 * پیام، از یک مغایرت بی‌خبر بماند.
 *
 * ناحیه `aria-live` است ولی نقش `status` ندارد تا با پیام وضعیت
 * خودِ صفحه‌ها رقابت نکند.
 */
interface ToastItem { id: number; message: string; state: Extract<StatusState, "completed" | "pending" | "warning" | "unknown"> }
const ToastContext = createContext<(message: string, state?: ToastItem["state"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback((message: string, state: ToastItem["state"] = "completed") => {
    const id = next.current++;
    setItems(list => [...list.slice(-2), { id, message, state }]);
  }, []);
  const value = useMemo(() => push, [push]);
  return <ToastContext.Provider value={value}>
    {children}
    <div className="toast-region" aria-live="polite" aria-relevant="additions">
      {items.map(item => <ToastView key={item.id} item={item} onDone={() => setItems(list => list.filter(i => i.id !== item.id))} />)}
    </div>
  </ToastContext.Provider>;
}

function ToastView({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;
    const t = window.setTimeout(onDone, 5000);
    return () => window.clearTimeout(t);
  }, [hover, onDone]);
  const s = STATUS[item.state];
  return <div className={`toast status--${s.tone}`} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
    <Icon name={s.icon} size="sm" />
    <span>{item.message}</span>
    <button type="button" className="icon-button toast-close" aria-label="بستن اعلان" onClick={onDone}><Icon name="close" size="sm" /></button>
  </div>;
}

export function useToast() {
  return useContext(ToastContext);
}
