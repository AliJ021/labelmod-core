import { useState, type RefObject } from "react";
import { Ltr } from "../ui/Bidi.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { normalizeDigits } from "../../lib/settings-value.ts";
import type { InvoiceCustomer } from "../../lib/pos.ts";

/**
 * مشتری سبد — **اختیاری**؛ فروش ناشناس کار عادی است.
 *
 * وصل‌شدن همان مسیر قبلی است (شماره ← `sales.normalize_mobile`). وقتی وصل است،
 * نام، شماره و وضعیتش آشکارا دیده می‌شود تا پیش از نسیه یا مصرف امتیاز معلوم باشد
 * فاکتور به نام کیست. «تغییر مشتری» همان مسیر با شمارهٔ تازه است.
 *
 * ⚠️ «حذف مشتری از پیش‌نویس» عمداً نیست: API آن را ندارد و پیش‌نویسی که امتیاز یا
 *    کارت هدیهٔ همان مشتری را مصرف کرده، بی او معنا ندارد. برای فروش ناشناس، سبد را
 *    رها کنید یا فروش تازه بزنید. (docs/UI_PATTERNS.md، صندوق)
 */
export function CustomerSummary({ customer, loading, error, mobile, onMobile, onAttach, busy, inputRef }: {
  customer: InvoiceCustomer | null;
  loading: boolean;
  error: string | null;
  mobile: string;
  onMobile: (v: string) => void;
  onAttach: () => void;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [changing, setChanging] = useState(false);
  const editing = customer === null || changing;
  const empty = normalizeDigits(mobile).trim() === "";
  return <section className="pos-customer" aria-label="مشتری">
    {customer ? <div className="pos-customer-card">
      <div className="pos-customer-who">
        <strong>{customer.fullName?.trim() ? customer.fullName : "مشتری بی‌نام"}</strong>
        {customer.mobile ? <span className="muted small"><Ltr>{customer.mobile}</Ltr></span> : null}
      </div>
      {customer.status === "blocked" ? <StatusBadge state="failed" label="مسدود — نسیه ممکن نیست" />
        : <StatusBadge state="active" label="وصل به این فاکتور" quiet />}
      {!changing ? <Button variant="quiet" disabled={busy} onClick={() => { setChanging(true); requestAnimationFrame(() => inputRef.current?.focus()); }}>تغییر مشتری</Button> : null}
    </div> : loading ? <p className="muted small" role="status">در حال خواندن مشتری…</p> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {editing ? <form className="pos-customer-form" onSubmit={(e) => { e.preventDefault(); if (!empty && !busy) { onAttach(); setChanging(false); } }}>
      <Field label={customer ? "شمارهٔ مشتری تازه" : "موبایل مشتری"} optional={customer === null}>
        <input ref={inputRef} type="text" inputMode="numeric" autoComplete="off" value={mobile} disabled={busy}
          onChange={(e) => onMobile(e.target.value)} />
      </Field>
      <Button type="submit" disabled={busy || empty}>{customer ? "تغییر مشتری" : "افزودن مشتری"}</Button>
      {changing ? <Button variant="quiet" onClick={() => setChanging(false)}>انصراف</Button> : null}
    </form> : null}
  </section>;
}
