import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { suggestPassword } from "../lib/password.ts";
import { Icon } from "./Icon.tsx";

export function PasswordDialog({ name, own = false, onCancel, onApply }: {
  name: string;
  own?: boolean;
  onCancel: () => void;
  onApply: (password: string, currentPassword: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const title = useId();
  const warning = useId();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [suggested, setSuggested] = useState(false);
  const [review, setReview] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [review]);
  const valid = password.length >= 12 && password.length <= 256 && password === confirm && (!own || current.length > 0);
  async function apply() {
    if (!review || !saved || !valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onApply(password, current);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ارتباط برقرار نشد. پیش از تلاش دوباره، وضعیت ورود را بررسی کنید.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return <dialog ref={dialog} className="password-dialog" aria-labelledby={title} aria-describedby={warning} onCancel={(e) => { e.preventDefault(); if (!submitting.current) onCancel(); }}>
    <div className="dialog-heading"><h2 id={title}>{own ? "تغییر رمز من" : `بازنشانی رمز ${name}`}</h2><button type="button" className="icon-button" aria-label="بستن تغییر رمز" disabled={busy} onClick={onCancel}><Icon name="close" /></button></div>
    <form onSubmit={(e) => { e.preventDefault(); if (review) void apply(); else if (valid) { setSaved(false); setReview(true); } }}>
      <p id={warning} className="password-warning">پس از تأیید نهایی، همهٔ نشست‌های {own ? "شما، از جمله همین نشست،" : "این کاربر"} بسته می‌شوند و ورود دوباره با رمز تازه لازم است.</p>
      {error ? <p role="alert">{error}</p> : null}
      {review ? <div className="password-review">
        <p>رمز تازهٔ <strong>{name}</strong> را بررسی و در جای امن، مانند مدیر رمزها، نگه‌داری کنید.</p>
        <output className="password-secret num" dir="ltr" aria-label="رمز تازه">{password}</output>
        <label className="password-check"><input type="checkbox" checked={saved} disabled={busy} onChange={(e) => setSaved(e.target.checked)} /><span>رمز تازه را نگه داشته‌ام و بسته‌شدن نشست‌ها را تأیید می‌کنم.</span></label>
        <div className="dialog-actions"><button type="submit" className="btn btn--primary" disabled={busy || !saved}>{busy ? "در حال تغییر رمز…" : "تأیید نهایی و تغییر رمز"}</button><button type="button" className="btn btn--quiet" disabled={busy} onClick={() => { setReview(false); setSaved(false); setError(null); }}>بازگشت و ویرایش</button><button type="button" className="btn btn--quiet" disabled={busy} onClick={onCancel}>انصراف</button></div>
      </div> : <>
        {own ? <label className="auth-field"><span>رمز فعلی</span><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={256} required dir="ltr" /></label> : null}
        <label className="auth-field"><span>رمز تازه — حداقل ۱۲ کاراکتر</span><input type={suggested ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); setSuggested(false); }} minLength={12} maxLength={256} required dir="ltr" /></label>
        <label className="auth-field"><span>تکرار رمز تازه</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={12} maxLength={256} required aria-invalid={confirm !== "" && password !== confirm} dir="ltr" /></label>
        {confirm !== "" && password !== confirm ? <p role="alert">دو رمز یکسان نیستند.</p> : null}
        {suggested ? <p className="muted small" role="status">این فقط پیشنهاد است؛ رمز حساب هنوز تغییر نکرده است.</p> : null}
        <div className="dialog-actions"><button type="submit" className="btn btn--primary" disabled={!valid}>بررسی و ادامه</button><button type="button" className="btn btn--quiet" onClick={() => { try { const next = suggestPassword(); setPassword(next); setConfirm(next); setSuggested(true); setError(null); } catch { setError("پیشنهاد رمز در این مرورگر در دسترس نیست؛ رمز دلخواه وارد کنید."); } }}>پیشنهاد رمز امن</button><button type="button" className="btn btn--quiet" onClick={onCancel}>انصراف</button></div>
      </>}
    </form>
  </dialog>;
}
