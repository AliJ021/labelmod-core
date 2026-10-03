import { useState, type RefObject } from "react";
import { Ltr } from "../ui/Bidi.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { Icon } from "../Icon.tsx";
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
export function CustomerSummary({ customer, loading, error, mobile, onMobile, onAttach, busy, inputRef,
  nameForMobile, onConfirmName, onCancelName, canManage, onSaveName }: {
  customer: InvoiceCustomer | null;
  loading: boolean;
  error: string | null;
  mobile: string;
  onMobile: (v: string) => void;
  onAttach: () => void;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  nameForMobile: string | null;
  onConfirmName: (name: string) => void;
  onCancelName: () => void;
  canManage: boolean;
  onSaveName: (name: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [fullName, setFullName] = useState("");
  const editing = customer === null || changing;
  const empty = normalizeDigits(mobile).trim() === "";
  return <section className="pos-customer" aria-label="مشتری">
    {customer ? <div className="pos-customer-card">
      <span className="pos-customer-avatar" aria-hidden="true"><Icon name="user" size="sm" /></span>
      <div className="pos-customer-who">
        <strong>{customer.fullName?.trim() ? customer.fullName : "مشتری بی‌نام"}</strong>
        <span className="muted small">{customer.mobile ? <Ltr>{customer.mobile}</Ltr> : null}
          {customer.status === "blocked" ? null : <span className="pos-customer-state"><Icon name="check" size="sm" /> وصل به این فاکتور</span>}</span>
      </div>
      {customer.status === "blocked" ? <StatusBadge state="failed" label="مسدود — نسیه ممکن نیست" /> : null}
      {!changing ? <Button variant="quiet" disabled={busy} onClick={() => { setChanging(true); requestAnimationFrame(() => inputRef.current?.focus()); }}>تغییر مشتری</Button> : null}
      {!customer.fullName?.trim() && canManage ? <Button variant="quiet" disabled={busy} onClick={() => { setFullName(""); setEditingName(true); }}>تکمیل نام مشتری</Button> : null}
    </div> : loading ? <p className="muted small" role="status">در حال خواندن مشتری…</p> : null}
    {customer && !customer.fullName?.trim() && !canManage ? <p className="muted small">نام این مشتری ثبت نشده است؛ تکمیل نام به مجوز مدیریت مشتری نیاز دارد.</p> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {nameForMobile !== null || (editingName && customer && !customer.fullName?.trim()) ? <form className="pos-customer-form" onSubmit={(e) => {
      e.preventDefault(); if (busy || !fullName.trim()) return;
      if (nameForMobile !== null) onConfirmName(fullName.trim()); else onSaveName(fullName.trim());
    }}>
      <Field label="نام و نام خانوادگی مشتری"><input value={fullName} maxLength={120} required disabled={busy}
        onChange={(e) => setFullName(e.target.value)} autoComplete="off" /></Field>
      <Button type="submit" disabled={busy || !fullName.trim()}>{nameForMobile !== null ? "ثبت نام و افزودن مشتری" : "ذخیره نام مشتری"}</Button>
      <Button variant="quiet" disabled={busy} onClick={() => { onCancelName(); setEditingName(false); setFullName(""); }}>انصراف</Button>
      {nameForMobile !== null ? <p className="muted small">مشتری تازه با شمارهٔ <Ltr>{nameForMobile}</Ltr>؛ پیش از ثبت، نام را وارد کنید.</p> : null}
    </form> : null}
    {editing ? <form className="pos-customer-form" onSubmit={(e) => { e.preventDefault(); if (!empty && !busy && nameForMobile === null) { setFullName(""); onAttach(); setChanging(false); } }}>
      <Field label={customer ? "شمارهٔ مشتری تازه" : "موبایل مشتری"} optional={customer === null}>
        <input ref={inputRef} type="text" inputMode="numeric" autoComplete="off" value={mobile} disabled={busy}
          onChange={(e) => onMobile(e.target.value)} />
      </Field>
      <Button type="submit" disabled={busy || empty || nameForMobile !== null}>{customer ? "تغییر مشتری" : "افزودن مشتری"}</Button>
      {changing ? <Button variant="quiet" onClick={() => setChanging(false)}>انصراف</Button> : null}
    </form> : null}
  </section>;
}
