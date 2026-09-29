import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from "react";

/**
 * زیرساخت مشترک لایهٔ مودال روی `<dialog>` بومی — Dialog/Sheet و برگهٔ
 * «بیشتر» هر دو از همین می‌گذرند تا دو نظام مودال نداشته باشیم.
 *
 * بومی یعنی به‌رایگان: `showModal()` پشت صحنه را inert می‌کند (نه Tab، نه
 * کلیک، نه صفحه‌خوان)، Esc رویداد `cancel` می‌دهد و لایه بالاتر از همه است.
 * این قلاب فقط سه کار اضافه می‌کند:
 *
 *   ۱. Tab و Shift+Tab داخل لایه می‌چرخند، نه به نوار نشانی مرورگر.
 *   ۲. **هر** بستن — Esc، پس‌زمینه، دکمهٔ بستن، یا بستنِ اجباری مرورگر — از
 *      رویداد `close` می‌گذرد و فوکوس را به مبدأ برمی‌گرداند. Safari با کلیک
 *      به دکمه فوکوس نمی‌دهد، پس مبدأ صریح (`returnFocus`) بر
 *      `document.activeElement` لحظهٔ بازشدن مقدم است.
 *   ۳. بستنی که مرورگر خودش انجام دهد (Esc دوم پشت‌سرهم) به والد خبر داده
 *      می‌شود تا وضعیت React و DOM از هم جدا نشوند؛ لایهٔ بسته‌نشدنی دوباره
 *      باز می‌شود.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.getClientRects().length > 0);
  // گروه رادیویی یک توقف Tab است، مثل رفتار بومی: گزینهٔ انتخاب‌شده، وگرنه نخستین.
  return all.filter(el => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.name === "") return true;
    const group = all.filter((o): o is HTMLInputElement => o instanceof HTMLInputElement && o.type === "radio" && o.name === el.name);
    return el.checked || (!group.some(o => o.checked) && group[0] === el);
  });
}

export function useModalDialog(open: boolean, options: {
  onDismiss: () => void;
  dismissible?: boolean;
  returnFocus?: () => HTMLElement | null;
  initialFocus?: (dialog: HTMLDialogElement) => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const redirect = useRef<HTMLElement | null>(null);
  const isOpen = useRef(open);
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const restore = () => {
    const back = opener.current;
    const target = redirect.current ?? latest.current.returnFocus?.() ?? (back instanceof HTMLElement ? back : null);
    redirect.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  };
  useEffect(() => {
    const el = ref.current;
    isOpen.current = open;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement;
      redirect.current = null;
      el.showModal();
      latest.current.initialFocus?.(el)?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);
  useEffect(() => {
    const el = ref.current;
    // Unmount در حالت باز رویداد close نمی‌دهد؛ فوکوس همان‌جا برمی‌گردد (فقط هنگام Unmount).
    return () => { if (el?.open) restore(); };
  }, []);
  return {
    ref,
    /** مقصد فوکوس همین بستن را عوض می‌کند (مثلاً رفتن به بخش تازه). */
    closeInto(target: HTMLElement | null) { redirect.current = target; },
    props: {
      onCancel(e: SyntheticEvent<HTMLDialogElement>) {
        e.preventDefault();
        if (latest.current.dismissible !== false) latest.current.onDismiss();
      },
      onClose() {
        // مرورگر لایهٔ «بسته‌نشدنی» (عمل مالی در حال اجرا) را به‌زور بست: برمی‌گردد.
        if (isOpen.current && latest.current.dismissible === false) { ref.current?.showModal(); return; }
        restore();
        if (isOpen.current) latest.current.onDismiss();
      },
      onClick(e: ReactMouseEvent<HTMLDialogElement>) {
        // کلیک روی خودِ dialog یعنی پس‌زمینه: محتوا کل جعبه را پر می‌کند.
        if (e.target === e.currentTarget && latest.current.dismissible !== false) latest.current.onDismiss();
      },
      onKeyDown(e: ReactKeyboardEvent<HTMLDialogElement>) {
        // هر Tab را خودش می‌برد، نه فقط دو سر را: ترتیب در همهٔ موتورها یکی است
        // (WebKit به‌طور پیش‌فرض پیوند را در ترتیب Tab نمی‌آورد) و هرگز بیرون نمی‌رود.
        if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
        const items = focusablesIn(e.currentTarget);
        e.preventDefault();
        if (items.length === 0) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
        items[next]!.focus();
      },
    },
  };
}
