import { useState, type RefObject } from "react";
import { Ltr } from "../ui/Bidi.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { Icon } from "../Icon.tsx";
import { normalizeDigits } from "../../lib/settings-value.ts";
import { parseJalaliDate } from "../../lib/report-filters.ts";
import type { InvoiceCustomer } from "../../lib/pos.ts";

/**
 * مشتری سبد — الزام انتخاب از سیاست جاری صندوق می‌آید.
 *
 * وصل‌شدن همان مسیر قبلی است (شماره ← `sales.normalize_mobile`). وقتی وصل است،
 * نام، شماره و وضعیتش آشکارا دیده می‌شود تا پیش از نسیه یا مصرف امتیاز معلوم باشد
 * فاکتور به نام کیست. «تغییر مشتری» همان مسیر با شمارهٔ تازه است.
 *
 * ⚠️ «حذف مشتری از پیش‌نویس» عمداً نیست: API آن را ندارد و پیش‌نویسی که امتیاز یا
 *    کارت هدیهٔ همان مشتری را مصرف کرده، بی او معنا ندارد. برای فروش ناشناس، سبد را
 *    رها کنید یا فروش تازه بزنید. (docs/UI_PATTERNS.md، صندوق)
 */
export function CustomerSummary({ customer, loading, error, mobile, onMobile, onAttach, busy, inputRef, required = false,
  nameForMobile, onConfirmName, onCancelName, canManage, onSaveName }: {
  customer: InvoiceCustomer | null;
  required?: boolean;
  loading: boolean;
  error: string | null;
  mobile: string;
  onMobile: (v: string) => void;
  onAttach: () => void;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  nameForMobile: string | null;
  onConfirmName: (name: string, title: "mr" | "ms", birthDate?: string, consentSms?: boolean, consentMarketing?: boolean) => void;
  onCancelName: () => void;
  canManage: boolean;
  onSaveName: (name: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState<"mr" | "ms">("mr");
  const [receiptConsent, setReceiptConsent] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [dob, setDob] = useState("");
  const parsed = dob.trim() ? parseJalaliDate(dob) : null;
  const editing = customer === null || changing || (required && !customer.mobile?.trim());
  const empty = normalizeDigits(mobile).trim() === "";
  return <section className="pos-customer" aria-label="مشتری">
    {customer ? <div className="pos-customer-card">
      <span className="pos-customer-avatar" aria-hidden="true"><Icon name="user" size="sm" /></span>
      <div className="pos-customer-who">
        <strong>{customer.fullName?.trim() ? customer.fullName : "نام مشتری ثبت نشده"}</strong>
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
      if (nameForMobile !== null) { if (parsed && parsed.kind !== "ok") return; onConfirmName(fullName.trim(), title, parsed?.iso, receiptConsent, marketingConsent); } else onSaveName(fullName.trim());
    }}>
      <div className="customer-name-fields">{nameForMobile !== null && <div className="segmented" role="group" aria-label="عنوان مشتری">
        {(["mr","ms"] as const).map(value => <button key={value} type="button" aria-pressed={title === value}
          className="btn" disabled={busy} onClick={() => setTitle(value)}>{value === "mr" ? "آقا" : "خانم"}</button>)}
      </div>}
      <Field label="نام و نام خانوادگی مشتری"><input value={fullName} maxLength={120} required disabled={busy} autoFocus
        onChange={(e) => setFullName(e.target.value)} autoComplete="off" /></Field></div>
      {nameForMobile !== null && <Field label="تاریخ تولد شمسی" optional error={parsed && parsed.kind !== "ok" ? "تاریخ شمسی معتبر وارد کنید." : null}>
        <input dir="ltr" inputMode="text" placeholder="۱۳۷۰/۰۱/۲۵" value={dob} disabled={busy} onChange={e => setDob(e.target.value)} />
      </Field>}
      {nameForMobile !== null && <fieldset className="stack"><legend>درخواست مشتری برای پیامک</legend>
        <label><input type="checkbox" checked={receiptConsent} onChange={e => setReceiptConsent(e.target.checked)} /> دریافت رسید خرید با پیامک</label>
        <label><input type="checkbox" checked={marketingConsent} onChange={e => setMarketingConsent(e.target.checked)} /> دریافت پیشنهادها و پیام‌های بازاریابی</label>
      </fieldset>}
      <Button type="submit" disabled={busy || !fullName.trim()}>{nameForMobile !== null ? "ثبت نام و افزودن مشتری" : "ذخیره نام مشتری"}</Button>
      <Button variant="quiet" disabled={busy} onClick={() => { onCancelName(); setEditingName(false); setFullName(""); }}>انصراف</Button>
      {nameForMobile !== null ? <p className="muted small">مشتری تازه با شمارهٔ <Ltr>{nameForMobile}</Ltr>؛ پیش از ثبت، نام را وارد کنید.</p> : null}
    </form> : null}
    {editing && nameForMobile === null ? <form className="pos-customer-form" onSubmit={(e) => { e.preventDefault(); if (!empty && !busy) { setFullName(""); setTitle("mr"); setDob(""); setReceiptConsent(false); setMarketingConsent(false); onAttach(); setChanging(false); } }}>
      <Field label={customer ? "شمارهٔ مشتری تازه" : required ? "موبایل مشتری (الزامی)" : "موبایل مشتری"} optional={customer === null && !required}>
        <input ref={inputRef} type="tel" inputMode="tel" autoComplete="off" value={mobile} disabled={busy} required={required}
          placeholder="۰۹XXXXXXXXX" onChange={(e) => onMobile(e.target.value)} />
      </Field>
      <Button type="submit" disabled={busy || empty || nameForMobile !== null}>{customer ? "تغییر مشتری" : "افزودن مشتری"}</Button>
      {changing ? <Button variant="quiet" onClick={() => setChanging(false)}>انصراف</Button> : null}
      {!required && customer === null ? <p className="muted small pos-customer-hint">فروش بی‌نام ممکن است؛ شمارهٔ تکراری مشتری دوم نمی‌سازد.</p> : null}
    </form> : null}
  </section>;
}
